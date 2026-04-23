/**
 * Shape Strikers Web — Matchmaking
 *
 * Pairs two players for a 1v1 match using Supabase Realtime broadcast on
 * "matchmaking:queue". No server-side logic required — the client with the
 * lexicographically-smaller playerId acts as host and creates the room record.
 *
 * Pairing protocol:
 *   1. joinQueue() broadcasts { event:'join', playerId, joinedAt }
 *   2. Any queued player who receives a 'join' replies with 'join_ack' so the
 *      new arrival knows who is already waiting (Realtime has no history).
 *   3. When a player sees another player in the queue:
 *        localId < remoteId → local is host → create room → broadcast match_found
 *        localId > remoteId → wait for match_found from them
 *   4. match_found { roomId, player1Id, player2Id } → matched players fire
 *      onMatchFound callbacks; all others ignore it.
 *
 * Public API:
 *   Matchmaking.init()                  → void, fire-and-forget safe
 *   Matchmaking.joinQueue()             → void
 *   Matchmaking.leaveQueue()            → void
 *   Matchmaking.onMatchFound(fn)        → fn({ roomId, opponentId, isHost })
 *   Matchmaking.offMatchFound(fn)       → void
 *   Matchmaking.isSearching()           → boolean
 *   Matchmaking.destroy()              → void
 *
 * Depends on: backend.js, supabaseClient.js
 * Load order: after supabaseClient.js, before game.js
 */

const Matchmaking = (() => {

  const CHANNEL_NAME = 'matchmaking:queue';

  // ── State ─────────────────────────────────────────────────────────────────

  let _playerId  = null;
  let _searching = false;
  let _matched   = false;
  let _listeners = [];

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Returns a stable player ID for this session.
   * Prefers the authenticated Supabase user ID from Backend so it's consistent
   * with leaderboard and room records. Falls back to a crypto UUID.
   */
  function _getPlayerId() {
    if (_playerId) return _playerId;
    _playerId =
      (typeof Backend !== 'undefined' && Backend.getUserId()) ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return _playerId;
  }

  function _emit(detail) {
    _listeners.forEach(fn => {
      try { fn(detail); } catch (e) { console.error('[Matchmaking] listener error:', e); }
    });
  }

  function _getChannelStatus() {
    if (typeof SupabaseClient === 'undefined') return 'closed';
    if (typeof SupabaseClient.getChannelStatus === 'function') {
      return SupabaseClient.getChannelStatus(CHANNEL_NAME);
    }
    return SupabaseClient.getChannel(CHANNEL_NAME) ? 'SUBSCRIBED' : 'pending';
  }

  async function _broadcastJoin(reason) {
    if (!_searching || _matched || typeof SupabaseClient === 'undefined') return false;

    const localId = _getPlayerId();
    const result = await SupabaseClient.broadcast(CHANNEL_NAME, 'join', {
      playerId: localId,
      joinedAt: Date.now(),
    });

    if (!result?.ok) {
      console.warn(`[Matchmaking] join broadcast deferred (${reason}) — ${result?.error || 'unknown error'}`);
      if (typeof SupabaseClient.reconnectChannel === 'function') {
        SupabaseClient.reconnectChannel(CHANNEL_NAME);
      }
      return false;
    }

    console.info(`[Matchmaking] Joined queue (${reason}) — playerId: ${localId.slice(0, 8)}…`);
    return true;
  }

  // ── Pairing logic ─────────────────────────────────────────────────────────

  /**
   * Called when we detect another player in the queue.
   * The player with the lexicographically-smaller ID is the host and creates
   * the room, preventing both clients from racing to create duplicate rooms.
   */
  async function _tryPair(remoteId) {
    if (!_searching || _matched) return;
    const localId = _getPlayerId();
    if (!remoteId || localId === remoteId) return;
    if (localId > remoteId) return;  // not host — wait for their match_found

    // Mark matched immediately to prevent double-pairing.
    _matched   = true;
    _searching = false;

    let roomId = null;

    // Persist the room record in Supabase (best-effort — falls back to local UUID).
    const client = (typeof Backend !== 'undefined') && Backend.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from('mp_rooms')
          .insert({ player1_id: localId, player2_id: remoteId, status: 'waiting' })
          .select('room_id')
          .single();
        if (!error && data) roomId = data.room_id;
        else if (error) console.warn('[Matchmaking] DB room insert failed:', error.message);
      } catch (e) {
        console.warn('[Matchmaking] DB room insert threw:', e);
      }
    }

    // Fallback UUID if DB unavailable.
    if (!roomId) {
      roomId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `room-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      console.info('[Matchmaking] Using local fallback roomId (no DB).');
    }

    // Broadcast to both players.
    await SupabaseClient.broadcast(CHANNEL_NAME, 'match_found', {
      roomId,
      player1Id: localId,
      player2Id: remoteId,
    });

    console.info(`[Matchmaking] Paired as HOST — roomId: ${roomId.slice(0, 8)}…`);
    _emit({ roomId, opponentId: remoteId, isHost: true });
  }

  // ── Broadcast event handlers ──────────────────────────────────────────────

  function _onJoin(payload) {
    if (!payload || typeof payload.playerId !== 'string') return;

    // Reply so the new arrival learns we are in the queue.
    // (Supabase broadcast has no history — they won't see our original join.)
    if (_searching && !_matched) {
      SupabaseClient.broadcast(CHANNEL_NAME, 'join_ack', {
        playerId: _getPlayerId(),
      }).catch(() => {});
    }

    _tryPair(payload.playerId);
  }

  function _onJoinAck(payload) {
    if (!payload || typeof payload.playerId !== 'string') return;
    _tryPair(payload.playerId);
  }

  function _onMatchFound(payload) {
    if (!payload) return;
    const { roomId, player1Id, player2Id } = payload;
    if (typeof roomId !== 'string' || !roomId) return;

    const localId = _getPlayerId();
    // Ignore if this match doesn't involve us.
    if (player1Id !== localId && player2Id !== localId) return;
    if (_matched) return;  // already handled (host fires this too)

    _matched   = true;
    _searching = false;

    const isHost     = (player1Id === localId);
    const opponentId = isHost ? player2Id : player1Id;

    console.info(`[Matchmaking] Match found — roomId: ${roomId.slice(0, 8)}… isHost: ${isHost}`);
    _emit({ roomId, opponentId, isHost });
  }

  function _onLeave(payload) {
    if (payload?.playerId) {
      console.info(`[Matchmaking] Player left queue: ${String(payload.playerId).slice(0, 8)}…`);
    }
  }

  // ── Channel setup (passed to SupabaseClient) ──────────────────────────────

  function _setupChannel(ch) {
    ch.on('broadcast', { event: 'join' },        ({ payload }) => _onJoin(payload))
      .on('broadcast', { event: 'join_ack' },    ({ payload }) => _onJoinAck(payload))
      .on('broadcast', { event: 'match_found' }, ({ payload }) => _onMatchFound(payload))
      .on('broadcast', { event: 'leave' },       ({ payload }) => _onLeave(payload));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register the matchmaking channel. Idempotent — safe to call at startup.
   * The channel connects lazily once SupabaseClient.init() completes.
   */
  function init() {
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[Matchmaking] SupabaseClient not loaded — matchmaking disabled.');
      return;
    }
    SupabaseClient.joinChannel(CHANNEL_NAME, _setupChannel, () => {
      console.info('[Matchmaking] Channel subscribed:', CHANNEL_NAME);
      if (_searching && !_matched) {
        _broadcastJoin('subscribed').catch((e) => {
          console.warn('[Matchmaking] Deferred join broadcast failed:', e);
        });
      }
    });
    console.info('[Matchmaking] Channel registered:', CHANNEL_NAME);
  }

  /**
   * Enter the matchmaking queue. Broadcasts presence to any waiting players.
   * Safe to call multiple times — re-broadcasts if already searching.
   */
  function joinQueue() {
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[Matchmaking] SupabaseClient not loaded.');
      return;
    }
    _searching = true;
    _matched   = false;

    const status = _getChannelStatus();
    if (status !== 'SUBSCRIBED') {
      console.info(`[Matchmaking] Queue join waiting for channel subscription (status=${status}).`);
      if (typeof SupabaseClient.reconnectChannel === 'function') {
        SupabaseClient.reconnectChannel(CHANNEL_NAME);
      }
      return;
    }

    _broadcastJoin('manual').catch(e => console.warn('[Matchmaking] joinQueue broadcast failed:', e));
  }

  /**
   * Leave the matchmaking queue. Broadcasts departure and clears local state.
   */
  function leaveQueue() {
    if (!_searching) return;
    _searching = false;
    _matched   = false;
    SupabaseClient.broadcast(CHANNEL_NAME, 'leave', {
      playerId: _getPlayerId(),
    }).catch(() => {});
    console.info('[Matchmaking] Left queue.');
  }

  /** Subscribe to match-found events. fn({ roomId, opponentId, isHost }) */
  function onMatchFound(fn) {
    if (typeof fn === 'function' && !_listeners.includes(fn)) _listeners.push(fn);
  }

  /** Unsubscribe from match-found events. */
  function offMatchFound(fn) {
    _listeners = _listeners.filter(l => l !== fn);
  }

  /** True while the player is actively searching. */
  function isSearching() { return _searching; }

  /** Leave the channel and reset all state. */
  function destroy() {
    leaveQueue();
    if (typeof SupabaseClient !== 'undefined') SupabaseClient.leaveChannel(CHANNEL_NAME);
    _listeners = [];
    _playerId  = null;
    _matched   = false;
    console.info('[Matchmaking] Destroyed.');
  }

  return { init, joinQueue, leaveQueue, onMatchFound, offMatchFound, isSearching, destroy };

})();
