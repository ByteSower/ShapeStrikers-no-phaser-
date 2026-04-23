/**
 * Shape Strikers Web — Room
 *
 * Manages the per-match Realtime channel for a 1v1 room.
 * Handles state synchronisation, presence-based disconnect detection,
 * and graceful reconnection for the active match.
 *
 * State sync model:
 *   - All state is broadcast as key/value pairs: { key, value, from }
 *   - Each client maintains a local state object updated on every broadcast
 *   - The host owns authoritative state (seeds, round number, results)
 *   - The non-host sends purchases and ready flags; host reads them
 *
 * Synced state keys (by convention — Room is key-agnostic):
 *   round_number   (host)  current round 1-5
 *   shop_seed      (host)  seeded RNG for shared shop
 *   battle_seed    (host)  seeded RNG for deterministic battle
 *   ready_p1       (p1)    true when player1 is ready
 *   ready_p2       (p2)    true when player2 is ready
 *   purchases_p1   (p1)    array of unit IDs bought this round
 *   purchases_p2   (p2)    array of unit IDs bought this round
 *   board_p1       (p1)    grid layout [{ unitId, col, row }, ...]
 *   board_p2       (p2)    grid layout
 *   battle_hash_p1 (p1)    djb2 hash of post-battle board state
 *   battle_hash_p2 (p2)    djb2 hash of post-battle board state
 *   battle_result  (host)  { winner, roundScores, goldBonus }
 *
 * Public API:
 *   Room.join(roomId, isHost)           → void
 *   Room.leave()                        → void
 *   Room.syncState(key, value)          → Promise<{ ok, error? }>
 *   Room.onStateChange(fn)              → fn(key, value, fromPlayerId)
 *   Room.offStateChange(fn)             → void
 *   Room.onOpponentDisconnect(fn)       → fn()
 *   Room.offOpponentDisconnect(fn)      → void
 *   Room.onReconnect(fn)               → fn()  — opponent came back
 *   Room.offReconnect(fn)              → void
 *   Room.getState()                    → { [key]: value } snapshot
 *   Room.getConnectionState()          → string
 *   Room.getRoomId()                   → string | null
 *   Room.isHost()                      → boolean
 *   Room.getOpponentId()               → string | null
 *   Room.reconnect()                   → boolean
 *   Room.destroy()                     → void
 *
 * Depends on: backend.js, supabaseClient.js
 * Load order: after matchmaking.js, before game.js
 */

const Room = (() => {

  // ── State ─────────────────────────────────────────────────────────────────

  let _roomId      = null;
  let _host        = false;
  let _playerId    = null;
  let _opponentId  = null;
  let _channelName = null;

  // Local mirror of synced state. Updated on every incoming broadcast.
  const _state = {};

  // Callback lists.
  let _stateListeners      = [];
  let _disconnectListeners = [];
  let _reconnectListeners  = [];

  // Presence-based disconnect detection.
  // We wait DISCONNECT_GRACE_MS before firing onOpponentDisconnect so brief
  // network hiccups don't trigger forfeit logic.
  const DISCONNECT_GRACE_MS = 10_000;
  let _opponentPresent    = false;
  let _disconnectTimer    = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _getPlayerId() {
    if (_playerId) return _playerId;
    _playerId =
      (typeof Backend !== 'undefined' && Backend.getUserId()) ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return _playerId;
  }

  function _emitState(key, value, from) {
    _stateListeners.forEach(fn => {
      try { fn(key, value, from); } catch (e) { console.error('[Room] stateChange listener error:', e); }
    });
  }

  function _emitDisconnect() {
    _disconnectListeners.forEach(fn => {
      try { fn(); } catch (e) { console.error('[Room] disconnect listener error:', e); }
    });
  }

  function _emitReconnect() {
    _reconnectListeners.forEach(fn => {
      try { fn(); } catch (e) { console.error('[Room] reconnect listener error:', e); }
    });
  }

  // ── Presence handling ─────────────────────────────────────────────────────

  function _syncPresence() {
    const ch = _channelName && (typeof SupabaseClient !== 'undefined') &&
               SupabaseClient.getChannel(_channelName);
    if (!ch) return;

    const presenceState = ch.presenceState();
    // Each entry in presenceState is an array of presence objects keyed by
    // Supabase's internal presence key. We check if our opponent's playerId
    // appears in any slot.
    const opponentOnline = Object.values(presenceState).some(slots =>
      slots.some(slot => slot.playerId === _opponentId)
    );

    if (opponentOnline && !_opponentPresent) {
      // Opponent came back (reconnect).
      _opponentPresent = true;
      clearTimeout(_disconnectTimer);
      _disconnectTimer = null;
      console.info('[Room] Opponent reconnected.');
      _emitReconnect();
    } else if (!opponentOnline && _opponentPresent) {
      // Opponent just left — start grace timer.
      _opponentPresent = false;
      clearTimeout(_disconnectTimer);
      _disconnectTimer = setTimeout(() => {
        console.warn('[Room] Opponent disconnect confirmed after grace period.');
        _emitDisconnect();
      }, DISCONNECT_GRACE_MS);
      console.info(`[Room] Opponent presence lost — grace period ${DISCONNECT_GRACE_MS}ms started.`);
    }
  }

  // ── Channel setup ─────────────────────────────────────────────────────────

  function _setupChannel(ch) {
    // Broadcast: state sync messages from opponent.
    ch.on('broadcast', { event: 'state_sync' }, ({ payload }) => {
      if (!payload || typeof payload.key !== 'string') return;
      const { key, value, from } = payload;
      _state[key] = value;
      _emitState(key, value, from || null);
    });

    // Presence: track opponent connection status.
    ch.on('presence', { event: 'sync' },  () => _syncPresence())
      .on('presence', { event: 'join' },  () => _syncPresence())
      .on('presence', { event: 'leave' }, () => _syncPresence());
  }

  async function _onSubscribed(ch) {
    // Track this client in the room presence channel.
    await ch.track({
      playerId:  _getPlayerId(),
      roomId:    _roomId,
      joinedAt:  Date.now(),
    });
    _syncPresence();
    console.info(`[Room] Joined room channel: ${_channelName}`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Join the room channel for a given roomId.
   * @param {string} roomId   The UUID of the room (from Matchmaking.onMatchFound).
   * @param {boolean} host    True if this client is the host.
   * @param {string} opponentId  The opponent's playerId.
   */
  function join(roomId, host, opponentId) {
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[Room] SupabaseClient not loaded — room unavailable.');
      return;
    }
    if (_roomId) {
      console.warn('[Room] Already in a room — call leave() first.');
      return;
    }

    _roomId      = roomId;
    _host        = host;
    _opponentId  = opponentId || null;
    _channelName = `room:${roomId}`;

    // Clear state from any previous session.
    Object.keys(_state).forEach(k => delete _state[k]);
    _opponentPresent = false;
    clearTimeout(_disconnectTimer);
    _disconnectTimer = null;

    SupabaseClient.joinChannel(_channelName, _setupChannel, _onSubscribed);
    console.info(`[Room] Joining room: ${roomId.slice(0, 8)}… (isHost: ${host})`);
  }

  /**
   * Leave the current room channel and reset all room state.
   */
  function leave() {
    if (_channelName && typeof SupabaseClient !== 'undefined') {
      SupabaseClient.leaveChannel(_channelName);
    }
    clearTimeout(_disconnectTimer);
    _disconnectTimer = null;
    _roomId      = null;
    _host        = false;
    _opponentId  = null;
    _channelName = null;
    _opponentPresent = false;
    Object.keys(_state).forEach(k => delete _state[k]);
    console.info('[Room] Left room.');
  }

  /**
   * Broadcast a state update to the opponent.
   * @param {string} key    One of the synced state keys (see module header).
   * @param {*}      value  Any JSON-serialisable value.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function syncState(key, value) {
    if (!_channelName) return { ok: false, error: 'Not in a room' };
    if (typeof SupabaseClient === 'undefined') return { ok: false, error: 'SupabaseClient unavailable' };

    // Update local mirror immediately (optimistic).
    _state[key] = value;

    return SupabaseClient.broadcast(_channelName, 'state_sync', {
      key,
      value,
      from: _getPlayerId(),
    });
  }

  /** Subscribe to state changes from the opponent. fn(key, value, fromPlayerId) */
  function onStateChange(fn) {
    if (typeof fn === 'function' && !_stateListeners.includes(fn)) _stateListeners.push(fn);
  }

  /** Unsubscribe from state changes. */
  function offStateChange(fn) {
    _stateListeners = _stateListeners.filter(l => l !== fn);
  }

  /** Subscribe to opponent disconnect events (fires after 10s grace period). */
  function onOpponentDisconnect(fn) {
    if (typeof fn === 'function' && !_disconnectListeners.includes(fn)) _disconnectListeners.push(fn);
  }

  /** Unsubscribe from disconnect events. */
  function offOpponentDisconnect(fn) {
    _disconnectListeners = _disconnectListeners.filter(l => l !== fn);
  }

  /** Subscribe to opponent reconnect events. */
  function onReconnect(fn) {
    if (typeof fn === 'function' && !_reconnectListeners.includes(fn)) _reconnectListeners.push(fn);
  }

  /** Unsubscribe from reconnect events. */
  function offReconnect(fn) {
    _reconnectListeners = _reconnectListeners.filter(l => l !== fn);
  }

  /** Returns a shallow copy of the current local state snapshot. */
  function getState() { return Object.assign({}, _state); }

  /** Returns the tracked Realtime status for the active room channel. */
  function getConnectionState() {
    if (!_channelName || typeof SupabaseClient === 'undefined') return 'closed';
    return SupabaseClient.getChannelStatus(_channelName);
  }

  /** Returns the current roomId, or null if not in a room. */
  function getRoomId() { return _roomId; }

  /** Returns true if this client is the host. */
  function isHost() { return _host; }

  /** Returns the opponent's playerId, or null if not set. */
  function getOpponentId() { return _opponentId; }

  /** Force an immediate reconnect attempt for the current room channel. */
  function reconnect() {
    if (!_channelName || typeof SupabaseClient === 'undefined') return false;
    console.info(`[Room] Manual reconnect requested for ${_channelName}.`);
    return SupabaseClient.reconnectChannel(_channelName);
  }

  /** Alias for leave() — clean up all room state and listeners. */
  function destroy() {
    leave();
    _stateListeners      = [];
    _disconnectListeners = [];
    _reconnectListeners  = [];
    console.info('[Room] Destroyed.');
  }

  return {
    join,
    leave,
    syncState,
    onStateChange,
    offStateChange,
    onOpponentDisconnect,
    offOpponentDisconnect,
    onReconnect,
    offReconnect,
    getState,
    getConnectionState,
    getRoomId,
    isHost,
    getOpponentId,
    reconnect,
    destroy,
  };

})();
