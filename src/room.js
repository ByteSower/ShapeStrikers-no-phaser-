/**
 * Shape Strikers Web — Room
 *
 * Manages the per-match Realtime channel for a 1v1 room.
 * Handles state synchronisation, heartbeat-based liveness detection,
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
 *   Room.applyState(key, value, from)   → void
 *   Room.onStateChange(fn)              → fn(key, value, fromPlayerId)
 *   Room.offStateChange(fn)             → void
 *   Room.onOpponentDisconnect(fn)       → fn()
 *   Room.offOpponentDisconnect(fn)      → void
 *   Room.onReconnect(fn)               → fn()  — opponent came back
 *   Room.offReconnect(fn)              → void
 *   Room.getState()                    → { [key]: value } snapshot
 *   Room.getConnectionState()          → string  (raw channel status)
 *   Room.getLifecycleState()           → string  (CONNECTING, ACTIVE, ...)
 *   Room.onLifecycleChange(fn)         → fn(nextState, prevState, meta)
 *   Room.offLifecycleChange(fn)        → void
 *   Room.beginResync(reason?, meta?)   → boolean
 *   Room.endResync(reason?, meta?)     → boolean
 *   Room.getRoomId()                   → string | null
 *   Room.isHost()                      → boolean
 *   Room.getOpponentId()               → string | null
 *   Room.getSavedSession()             → { roomId, isHost, opponentId, playerId, seatId, sessionId, reconnectToken, resumeContext, savedAt } | null
 *   Room.discardSavedSession(reason?)  → boolean
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
  let _seatId      = null;
  let _sessionId   = null;
  let _reconnectToken = null;
  let _resumeContext = null;
  let _opponentId  = null;
  let _channelName = null;

  // Local mirror of synced state. Updated on every incoming broadcast.
  const _state = {};

  // Callback lists.
  let _stateListeners      = [];
  let _disconnectListeners = [];
  let _reconnectListeners  = [];
  let _lifecycleListeners  = [];

  // Liveness detection.
  // Presence loss can mark the opponent stale immediately, but a heartbeat /
  // last-heard timeout also drives STALE / DISCONNECTED when presence events
  // fail to arrive. Game-level recovery still expects Room to wait roughly
  // 10 seconds before firing onOpponentDisconnect.
  const HEARTBEAT_INTERVAL_MS = 3_000;
  const HEARTBEAT_STALE_MS    = 7_000;
  const DISCONNECT_GRACE_MS = 10_000;
  const ROOM_SESSION_KEY   = 'shape_strikers_mp_room_session';
  const CONNECTION_LIFECYCLE = Object.freeze({
    CLOSED: 'CLOSED',
    CONNECTING: 'CONNECTING',
    ACTIVE: 'ACTIVE',
    STALE: 'STALE',
    DISCONNECTED: 'DISCONNECTED',
    RECONNECTING: 'RECONNECTING',
    RESYNCING: 'RESYNCING',
  });
  let _opponentPresent    = false;
  let _hasSeenOpponentActivity = false;
  let _disconnectTimer    = null;
  let _staleTimer         = null;
  let _heartbeatTimer     = null;
  let _channelStatus      = 'closed';
  let _lifecycleState     = CONNECTION_LIFECYCLE.CLOSED;
  let _hasEverSubscribed  = false;
  let _lastRemoteActivityAt = 0;

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

  function _createOpaqueId(prefix = 'mp-room') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function _buildSeatId(roomId = _roomId, host = _host, playerId = _getPlayerId()) {
    if (!roomId || !playerId) return null;
    return `${roomId}:${playerId}:${host ? 'host' : 'guest'}`;
  }

  function _getExpectedOpponentSeatId() {
    if (!_roomId || !_opponentId) return null;
    return _buildSeatId(_roomId, !_host, _opponentId);
  }

  function _getCurrentBackendPlayerId() {
    try {
      return (typeof Backend !== 'undefined' && typeof Backend.getUserId === 'function')
        ? Backend.getUserId()
        : null;
    } catch (_) {
      return null;
    }
  }

  function _asPositiveInt(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
  }

  function _asNonNegativeInt(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
  }

  function _normalizeResumeContext(context) {
    if (!context || typeof context !== 'object') return null;

    const next = {};
    const roundNumber = _asPositiveInt(context.roundNumber);
    const checkpointSeq = _asNonNegativeInt(context.checkpointSeq);
    const updatedAt = _asPositiveInt(context.updatedAt);
    if (roundNumber !== null) next.roundNumber = roundNumber;
    if (checkpointSeq !== null) next.checkpointSeq = checkpointSeq;
    if (typeof context.phase === 'string' && context.phase) next.phase = context.phase;
    if (typeof context.sourceKey === 'string' && context.sourceKey) next.sourceKey = context.sourceKey;
    if (typeof context.phaseEventType === 'string' && context.phaseEventType) next.phaseEventType = context.phaseEventType;
    if (typeof context.boardHash === 'string' && context.boardHash) next.boardHash = context.boardHash;
    if (updatedAt !== null) next.updatedAt = updatedAt;

    return Object.keys(next).length ? next : null;
  }

  function _resolvePayloadRoundNumber(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
      payload.roundNumber,
      payload.round,
      payload.meta?.matchState?.roundNumber,
      payload.meta?.matchState?.round,
      payload.state?.round_result?.roundNumber,
      payload.state?.round_result?.round,
      payload.state?.phase_event?.roundNumber,
      payload.state?.phase_event?.round,
      payload.state?.prep_state?.roundNumber,
      payload.state?.prep_state?.round,
      payload.state?.playback_checkpoint?.roundNumber,
      payload.state?.playback_checkpoint?.round,
      payload.state?.battle_replay?.roundNumber,
      payload.state?.battle_replay?.round,
    ];

    for (const candidate of candidates) {
      const resolved = _asPositiveInt(candidate);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  function _resolvePayloadCheckpointSeq(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
      payload.checkpointSeq,
      payload.seq,
      payload.meta?.matchState?.checkpointSeq,
      payload.state?.playback_checkpoint?.seq,
      payload.state?.phase_event?.checkpointSeq,
      payload.state?.round_result?.seq,
    ];

    for (const candidate of candidates) {
      const resolved = _asNonNegativeInt(candidate);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  function _buildResumeContextForKey(key, value) {
    const next = { sourceKey: key, updatedAt: Date.now() };
    if (typeof value === 'string' && key === 'round_number') {
      const roundNumber = _asPositiveInt(value);
      if (roundNumber === null) return null;
      next.roundNumber = roundNumber;
      next.phase = 'prep';
      return _normalizeResumeContext(next);
    }

    if (key === 'round_number') {
      const roundNumber = _asPositiveInt(value);
      if (roundNumber === null) return null;
      next.roundNumber = roundNumber;
      next.phase = 'prep';
      return _normalizeResumeContext(next);
    }

    if (!value || typeof value !== 'object') return null;

    const roundNumber = _resolvePayloadRoundNumber(value);
    const checkpointSeq = _resolvePayloadCheckpointSeq(value);
    if (roundNumber !== null) next.roundNumber = roundNumber;
    if (checkpointSeq !== null) next.checkpointSeq = checkpointSeq;
    if (typeof value.boardHash === 'string' && value.boardHash) next.boardHash = value.boardHash;

    if (key === 'prep_state') {
      next.phase = 'prep';
    } else if (key === 'battle_replay' || key === 'playback_checkpoint') {
      next.phase = 'battle';
    } else if (key === 'phase_event') {
      next.phaseEventType = typeof value.type === 'string' && value.type ? value.type : undefined;
      next.phase = value.type === 'result_show' ? 'result' : 'battle';
    } else if (key === 'round_result') {
      next.phase = 'result';
    } else if (key === 'authoritative_state') {
      if (value.state?.round_result) {
        next.phase = 'result';
      } else if (value.state?.playback_checkpoint || value.state?.battle_replay || value.state?.phase_event) {
        next.phase = 'battle';
      } else {
        next.phase = 'prep';
      }
      const authoritativeBoardHash = value.state?.round_result?.boardHash || value.state?.phase_event?.boardHash || value.state?.playback_checkpoint?.boardHash;
      if (typeof authoritativeBoardHash === 'string' && authoritativeBoardHash) next.boardHash = authoritativeBoardHash;
    } else {
      return null;
    }

    return _normalizeResumeContext(next);
  }

  function _updateResumeContext(key, value) {
    const next = _buildResumeContextForKey(key, value);
    if (!next) return false;

    const merged = _normalizeResumeContext(Object.assign({}, _resumeContext || {}, next));
    if (!merged) return false;

    const changed = JSON.stringify(_resumeContext || null) !== JSON.stringify(merged);
    _resumeContext = merged;
    if (changed) _saveSession();
    return changed;
  }

  function _isExpectedOpponentPayload(payload = {}) {
    const expectedSeatId = _getExpectedOpponentSeatId();
    if (payload.from && payload.from === _getPlayerId()) return false;
    if (payload.from && _opponentId && payload.from !== _opponentId) return false;
    if (payload.seatId && expectedSeatId && payload.seatId !== expectedSeatId) return false;
    return true;
  }

  function _getSessionStorage() {
    try {
      return (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
    } catch (_) {
      return null;
    }
  }

  function _recordTelemetry(type, details = {}, level = 'info') {
    if (typeof MultiplayerTelemetry === 'undefined' || typeof MultiplayerTelemetry.record !== 'function') return null;
    return MultiplayerTelemetry.record(type, details, { level });
  }

  function _clearSavedSession() {
    const storage = _getSessionStorage();
    if (!storage) return;
    try { storage.removeItem(ROOM_SESSION_KEY); } catch (_) {}
  }

  function _getSavedSession() {
    const storage = _getSessionStorage();
    if (!storage) return null;

    try {
      const raw = storage.getItem(ROOM_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.roomId !== 'string' || !parsed.roomId) return null;
      return {
        roomId: parsed.roomId,
        isHost: parsed.isHost === true,
        opponentId: typeof parsed.opponentId === 'string' && parsed.opponentId ? parsed.opponentId : null,
        playerId: typeof parsed.playerId === 'string' && parsed.playerId ? parsed.playerId : null,
        seatId: typeof parsed.seatId === 'string' && parsed.seatId ? parsed.seatId : null,
        sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null,
        reconnectToken: typeof parsed.reconnectToken === 'string' && parsed.reconnectToken ? parsed.reconnectToken : null,
        resumeContext: _normalizeResumeContext(parsed.resumeContext),
        savedAt: Number(parsed.savedAt || 0) || 0,
      };
    } catch (err) {
      console.warn('[Room] Failed to parse saved room session:', err);
      _clearSavedSession();
      return null;
    }
  }

  function _discardSavedSession(reason = 'manual_clear') {
    const saved = _getSavedSession();
    if (!saved) return false;
    _recordTelemetry('room.saved_session_cleared', {
      roomId: saved.roomId,
      isHost: saved.isHost === true,
      reason,
    });
    _clearSavedSession();
    return true;
  }

  function _saveSession() {
    const storage = _getSessionStorage();
    if (!storage || !_roomId) return false;

    try {
      storage.setItem(ROOM_SESSION_KEY, JSON.stringify({
        roomId: _roomId,
        isHost: _host === true,
        opponentId: _opponentId || null,
        playerId: _getPlayerId(),
        seatId: _seatId || _buildSeatId(),
        sessionId: _sessionId,
        reconnectToken: _reconnectToken,
        resumeContext: _resumeContext,
        savedAt: Date.now(),
      }));
      return true;
    } catch (err) {
      console.warn('[Room] Failed to persist room session:', err);
      return false;
    }
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

  function _clearDisconnectTimer() {
    clearTimeout(_disconnectTimer);
    _disconnectTimer = null;
  }

  function _clearStaleTimer() {
    clearTimeout(_staleTimer);
    _staleTimer = null;
  }

  function _clearHeartbeatTimer() {
    clearTimeout(_heartbeatTimer);
    _heartbeatTimer = null;
  }

  function _clearLivenessTimers() {
    _clearStaleTimer();
    _clearDisconnectTimer();
  }

  function _emitLifecycle(nextState, prevState, meta) {
    _lifecycleListeners.forEach(fn => {
      try { fn(nextState, prevState, meta); } catch (e) { console.error('[Room] lifecycle listener error:', e); }
    });
  }

  function _setLifecycleState(nextState, meta = {}) {
    if (!Object.prototype.hasOwnProperty.call(CONNECTION_LIFECYCLE, nextState)) return false;
    if (_lifecycleState === CONNECTION_LIFECYCLE[nextState]) return false;
    const prevState = _lifecycleState;
    _lifecycleState = CONNECTION_LIFECYCLE[nextState];
    _recordTelemetry('room.lifecycle', {
      nextState: _lifecycleState,
      prevState,
      roomId: _roomId,
      opponentId: _opponentId,
      channelStatus: _channelStatus,
      meta,
    }, nextState === 'DISCONNECTED' ? 'warn' : 'info');
    _emitLifecycle(_lifecycleState, prevState, Object.assign({
      roomId: _roomId,
      opponentId: _opponentId,
      channelStatus: _channelStatus,
      at: Date.now(),
    }, meta));
    return true;
  }

  function _scheduleHeartbeatLoop() {
    _clearHeartbeatTimer();
    if (!_roomId || !_channelName || _channelStatus !== 'SUBSCRIBED' || typeof SupabaseClient === 'undefined') return;

    _heartbeatTimer = setTimeout(() => {
      _heartbeatTimer = null;
      _syncChannelStatus();
      if (!_roomId || _channelStatus !== 'SUBSCRIBED' || typeof SupabaseClient === 'undefined') return;

      const sendResult = SupabaseClient.broadcast(_channelName, 'room_heartbeat', {
        from: _getPlayerId(),
        seatId: _seatId,
        sessionId: _sessionId,
        at: Date.now(),
      });

      if (sendResult && typeof sendResult.then === 'function') {
        sendResult.then((result) => {
          if (!result?.ok) _syncChannelStatus();
          _scheduleHeartbeatLoop();
        }).catch(() => {
          _syncChannelStatus();
          _scheduleHeartbeatLoop();
        });
        return;
      }

      _scheduleHeartbeatLoop();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function _armLivenessTimeouts() {
    _clearLivenessTimers();
    if (
      !_roomId ||
      _channelStatus !== 'SUBSCRIBED' ||
      !_hasSeenOpponentActivity ||
      !Number.isFinite(_lastRemoteActivityAt) ||
      _lastRemoteActivityAt < 0
    ) return;

    const silentMs = Math.max(0, Date.now() - _lastRemoteActivityAt);
    const staleDelay = Math.max(0, HEARTBEAT_STALE_MS - silentMs);
    const disconnectDelay = Math.max(0, DISCONNECT_GRACE_MS - silentMs);

    _staleTimer = setTimeout(() => {
      _syncChannelStatus();
      if (!_roomId || _channelStatus !== 'SUBSCRIBED') return;
      if (_lifecycleState !== CONNECTION_LIFECYCLE.RESYNCING) {
        _setLifecycleState('STALE', {
          reason: 'heartbeat_timeout',
          lastHeardAt: _lastRemoteActivityAt,
          silentMs: Math.max(0, Date.now() - _lastRemoteActivityAt),
        });
      }
    }, staleDelay);

    _disconnectTimer = setTimeout(() => {
      _syncChannelStatus();
      if (!_roomId || _channelStatus !== 'SUBSCRIBED') return;
      _setLifecycleState('DISCONNECTED', {
        reason: 'heartbeat_timeout_disconnect',
        lastHeardAt: _lastRemoteActivityAt,
        silentMs: Math.max(0, Date.now() - _lastRemoteActivityAt),
      });
      console.warn('[Room] Opponent heartbeat timed out.');
      _emitDisconnect();
    }, disconnectDelay);
  }

  function _markOpponentStale(reason, meta = {}) {
    _clearStaleTimer();
    _clearDisconnectTimer();
    _setLifecycleState('STALE', Object.assign({
      reason,
      lastHeardAt: _lastRemoteActivityAt,
    }, meta));
    _disconnectTimer = setTimeout(() => {
      _setLifecycleState('DISCONNECTED', Object.assign({
        reason: `${reason}_disconnect_confirmed`,
        lastHeardAt: _lastRemoteActivityAt,
      }, meta));
      console.warn('[Room] Opponent disconnect confirmed after grace period.');
      _emitDisconnect();
    }, DISCONNECT_GRACE_MS);
  }

  function _noteRemoteActivity(source, meta = {}) {
    const previousLifecycle = _lifecycleState;
    const recovered = previousLifecycle === CONNECTION_LIFECYCLE.STALE || previousLifecycle === CONNECTION_LIFECYCLE.DISCONNECTED;

    _lastRemoteActivityAt = Date.now();
    _hasSeenOpponentActivity = true;
    _opponentPresent = true;
    _clearLivenessTimers();

    if (_channelStatus === 'SUBSCRIBED') {
      if (recovered && previousLifecycle !== CONNECTION_LIFECYCLE.RESYNCING) {
        _setLifecycleState('ACTIVE', Object.assign({
          reason: `${source}_activity_recovered`,
          lastHeardAt: _lastRemoteActivityAt,
        }, meta));
        console.info('[Room] Opponent activity restored.');
        _emitReconnect();
      } else if (
        previousLifecycle !== CONNECTION_LIFECYCLE.RESYNCING &&
        (previousLifecycle === CONNECTION_LIFECYCLE.CONNECTING || previousLifecycle === CONNECTION_LIFECYCLE.RECONNECTING)
      ) {
        _setLifecycleState('ACTIVE', Object.assign({
          reason: `${source}_activity`,
          lastHeardAt: _lastRemoteActivityAt,
        }, meta));
      }
    }

    _armLivenessTimeouts();
  }

  function _syncChannelStatus() {
    if (!_channelName || typeof SupabaseClient === 'undefined') {
      _clearHeartbeatTimer();
      _clearLivenessTimers();
      _channelStatus = 'closed';
      if (!_roomId) _setLifecycleState('CLOSED', { reason: 'room_idle' });
      return _channelStatus;
    }

    const nextStatus = SupabaseClient.getChannelStatus(_channelName) || 'pending';
    if (nextStatus === _channelStatus) return _channelStatus;

    _channelStatus = nextStatus;
    if (nextStatus === 'SUBSCRIBED') {
      _hasEverSubscribed = true;
      _scheduleHeartbeatLoop();
      _armLivenessTimeouts();
      if (_lifecycleState === CONNECTION_LIFECYCLE.CONNECTING || _lifecycleState === CONNECTION_LIFECYCLE.RECONNECTING) {
        _setLifecycleState('ACTIVE', { reason: 'channel_subscribed' });
      }
      return _channelStatus;
    }

    _clearHeartbeatTimer();
    _clearLivenessTimers();

    if (_roomId) {
      _setLifecycleState(_hasEverSubscribed ? 'RECONNECTING' : 'CONNECTING', {
        reason: `channel_${String(nextStatus).toLowerCase()}`,
      });
    } else {
      _setLifecycleState('CLOSED', { reason: 'channel_closed' });
    }
    return _channelStatus;
  }

  // ── Presence / heartbeat handling ─────────────────────────────────────────

  function _syncPresence() {
    const ch = _channelName && (typeof SupabaseClient !== 'undefined') &&
               SupabaseClient.getChannel(_channelName);
    if (!ch) return;

    const presenceState = ch.presenceState();
    // Each entry in presenceState is an array of presence objects keyed by
    // Supabase's internal presence key. We check if our opponent's playerId
    // appears in any slot.
    const opponentOnline = Object.values(presenceState).some(slots =>
      slots.some(slot => {
        if (slot.playerId !== _opponentId) return false;
        const expectedSeatId = _getExpectedOpponentSeatId();
        return !expectedSeatId || !slot.seatId || slot.seatId === expectedSeatId;
      })
    );

    if (opponentOnline) {
      _noteRemoteActivity('presence_sync', { via: 'presence' });
    } else if (!opponentOnline && _opponentPresent) {
      _opponentPresent = false;
      _markOpponentStale('opponent_presence_lost', {
        graceMs: DISCONNECT_GRACE_MS,
      });
      console.info(`[Room] Opponent presence lost — grace period ${DISCONNECT_GRACE_MS}ms started.`);
    }
  }

  // ── Channel setup ─────────────────────────────────────────────────────────

  function _setupChannel(ch) {
    // Broadcast: state sync messages from opponent.
    ch.on('broadcast', { event: 'state_sync' }, ({ payload }) => {
      if (!payload || typeof payload.key !== 'string') return;
      const { key, value, from } = payload;
      if (!_isExpectedOpponentPayload(payload)) return;
      _noteRemoteActivity('state_sync', {
        key,
        from: from || null,
        seatId: payload.seatId || null,
        sessionId: payload.sessionId || null,
      });
      _state[key] = value;
      _updateResumeContext(key, value);
      _emitState(key, value, from || null);
    });

    ch.on('broadcast', { event: 'room_heartbeat' }, ({ payload }) => {
      if (!payload || !_isExpectedOpponentPayload(payload)) return;
      _noteRemoteActivity('heartbeat', {
        from: payload.from || null,
        seatId: payload.seatId || null,
        sessionId: payload.sessionId || null,
        heartbeatAt: Number(payload.at || 0) || 0,
      });
    });

    // Presence: track opponent connection status.
    ch.on('presence', { event: 'sync' },  () => _syncPresence())
      .on('presence', { event: 'join' },  () => _syncPresence())
      .on('presence', { event: 'leave' }, () => _syncPresence());
  }

  async function _onSubscribed(ch) {
    _channelStatus = 'SUBSCRIBED';
    _hasEverSubscribed = true;
    // Track this client in the room presence channel.
    await ch.track({
      playerId:  _getPlayerId(),
      seatId:    _seatId,
      sessionId: _sessionId,
      roomId:    _roomId,
      resumed:   !!_resumeContext,
      joinedAt:  Date.now(),
    });
    _syncPresence();
    _scheduleHeartbeatLoop();
    _armLivenessTimeouts();
    if (_lifecycleState !== CONNECTION_LIFECYCLE.STALE &&
        _lifecycleState !== CONNECTION_LIFECYCLE.DISCONNECTED &&
        _lifecycleState !== CONNECTION_LIFECYCLE.RESYNCING) {
      _setLifecycleState('ACTIVE', { reason: 'subscribed' });
    }
    console.info(`[Room] Joined room channel: ${_channelName}`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Join the room channel for a given roomId.
   * @param {string} roomId   The UUID of the room (from Matchmaking.onMatchFound).
   * @param {boolean} host    True if this client is the host.
   * @param {string} opponentId  The opponent's playerId.
   */
  function join(roomId, host, opponentId, options = null) {
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
    if (options && typeof options.playerId === 'string' && options.playerId) {
      _playerId = options.playerId;
    }
    _opponentId  = opponentId || null;
    _channelName = `room:${roomId}`;
    _sessionId = (options && typeof options.sessionId === 'string' && options.sessionId)
      ? options.sessionId
      : _createOpaqueId('shape-strikers-room-session');
    _reconnectToken = (options && typeof options.reconnectToken === 'string' && options.reconnectToken)
      ? options.reconnectToken
      : _createOpaqueId('shape-strikers-room-reconnect');
    _seatId = (options && typeof options.seatId === 'string' && options.seatId)
      ? options.seatId
      : _buildSeatId(roomId, host, _getPlayerId());
    _resumeContext = _normalizeResumeContext(options?.resumeContext) || null;
    _channelStatus = 'pending';
    _hasEverSubscribed = false;
    _saveSession();

    // Clear state from any previous session.
    Object.keys(_state).forEach(k => delete _state[k]);
    _opponentPresent = false;
    _hasSeenOpponentActivity = false;
    _lastRemoteActivityAt = 0;
    _clearHeartbeatTimer();
    _clearLivenessTimers();
    _setLifecycleState('CONNECTING', { reason: 'join' });

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
    _clearHeartbeatTimer();
    _clearLivenessTimers();
    _roomId      = null;
    _host        = false;
    _opponentId  = null;
    _seatId      = null;
    _sessionId   = null;
    _reconnectToken = null;
    _resumeContext = null;
    _channelName = null;
    _channelStatus = 'closed';
    _hasEverSubscribed = false;
    _opponentPresent = false;
    _hasSeenOpponentActivity = false;
    _lastRemoteActivityAt = 0;
    _clearSavedSession();
    Object.keys(_state).forEach(k => delete _state[k]);
    _setLifecycleState('CLOSED', { reason: 'leave' });
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
    _updateResumeContext(key, value);

    return SupabaseClient.broadcast(_channelName, 'state_sync', {
      key,
      value,
      from: _getPlayerId(),
      seatId: _seatId,
      sessionId: _sessionId,
    });
  }

  /** Apply a state value locally and emit state listeners without broadcasting. */
  function applyState(key, value, from) {
    if (typeof key !== 'string' || key.length === 0) return;
    _state[key] = value;
    _updateResumeContext(key, value);
    _emitState(key, value, from || null);
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

  /** Subscribe to lifecycle changes. fn(nextState, prevState, meta) */
  function onLifecycleChange(fn) {
    if (typeof fn === 'function' && !_lifecycleListeners.includes(fn)) _lifecycleListeners.push(fn);
  }

  /** Unsubscribe from lifecycle changes. */
  function offLifecycleChange(fn) {
    _lifecycleListeners = _lifecycleListeners.filter(l => l !== fn);
  }

  /** Returns a shallow copy of the current local state snapshot. */
  function getState() { return Object.assign({}, _state); }

  /** Returns the tracked Realtime status for the active room channel. */
  function getConnectionState() {
    return _syncChannelStatus();
  }

  /** Returns the higher-level room lifecycle state. */
  function getLifecycleState() {
    _syncChannelStatus();
    return _lifecycleState;
  }

  /** Marks the room as resyncing while an authoritative_state bundle is in flight. */
  function beginResync(reason = 'authoritative_state_requested', meta = {}) {
    if (!_roomId) return false;
    _syncChannelStatus();
    if (_channelStatus !== 'SUBSCRIBED') return false;
    _recordTelemetry('room.resync_begin', Object.assign({ roomId: _roomId, reason }, meta));
    return _setLifecycleState('RESYNCING', Object.assign({ reason }, meta));
  }

  /** Leaves resync mode and returns to the most appropriate connected state. */
  function endResync(reason = 'authoritative_state_applied', meta = {}) {
    if (!_roomId) return false;
    _syncChannelStatus();
    _recordTelemetry('room.resync_end', Object.assign({ roomId: _roomId, reason }, meta));
    if (_channelStatus === 'SUBSCRIBED' && !_opponentPresent) {
      return _setLifecycleState('STALE', Object.assign({ reason }, meta));
    }
    if (_channelStatus === 'SUBSCRIBED') {
      return _setLifecycleState('ACTIVE', Object.assign({ reason }, meta));
    }
    return _setLifecycleState(_hasEverSubscribed ? 'RECONNECTING' : 'CONNECTING', Object.assign({ reason }, meta));
  }

  /** Returns the current roomId, or null if not in a room. */
  function getRoomId() { return _roomId; }

  /** Returns true if this client is the host. */
  function isHost() { return _host; }

  /** Returns the opponent's playerId, or null if not set. */
  function getOpponentId() { return _opponentId; }

  /** Returns the persisted room session for same-tab reload resume, or null. */
  function getSavedSession() { return _getSavedSession(); }

  /** Clears any persisted room session without touching the active channel state. */
  function discardSavedSession(reason) { return _discardSavedSession(reason); }

  /** Force an immediate reconnect attempt for the current room channel. */
  function reconnect() {
    if (typeof SupabaseClient === 'undefined') return false;
    if (!_channelName) {
      const saved = _getSavedSession();
      if (!saved) return false;
      if (saved.isHost) {
        _recordTelemetry('room.saved_session_rejected', {
          roomId: saved.roomId,
          reason: 'host_resume_unsupported',
        }, 'info');
        console.info('[Room] Saved host room session cannot be resumed on cold boot yet — clearing it.');
        _clearSavedSession();
        return false;
      }
      const currentPlayerId = _getCurrentBackendPlayerId();
      if (saved.playerId && currentPlayerId && currentPlayerId !== saved.playerId) {
        _recordTelemetry('room.saved_session_rejected', {
          roomId: saved.roomId,
          reason: 'player_mismatch',
          savedPlayerId: saved.playerId,
          currentPlayerId,
        }, 'warn');
        console.warn('[Room] Saved room session belongs to a different player — clearing it.');
        _clearSavedSession();
        return false;
      }
      const expectedSeatId = _buildSeatId(saved.roomId, saved.isHost, saved.playerId || currentPlayerId || _playerId);
      if (saved.seatId && expectedSeatId && saved.seatId !== expectedSeatId) {
        _recordTelemetry('room.saved_session_rejected', {
          roomId: saved.roomId,
          reason: 'seat_mismatch',
          savedSeatId: saved.seatId,
          expectedSeatId,
        }, 'warn');
        console.warn('[Room] Saved room session seat mismatch — clearing it.');
        _clearSavedSession();
        return false;
      }
      console.info(`[Room] Restoring saved room session: ${saved.roomId.slice(0, 8)}…`);
      join(saved.roomId, saved.isHost, saved.opponentId, {
        playerId: saved.playerId || currentPlayerId || undefined,
        seatId: saved.seatId || expectedSeatId,
        sessionId: saved.sessionId || undefined,
        reconnectToken: saved.reconnectToken || undefined,
        resumeContext: saved.resumeContext || undefined,
      });
      return true;
    }
    console.info(`[Room] Manual reconnect requested for ${_channelName}.`);
    _syncChannelStatus();
    _setLifecycleState(_hasEverSubscribed ? 'RECONNECTING' : 'CONNECTING', {
      reason: 'manual_reconnect',
    });
    return SupabaseClient.reconnectChannel(_channelName);
  }

  /** Alias for leave() — clean up all room state and listeners. */
  function destroy() {
    leave();
    _stateListeners      = [];
    _disconnectListeners = [];
    _reconnectListeners  = [];
    _lifecycleListeners  = [];
    console.info('[Room] Destroyed.');
  }

  return {
    CONNECTION_LIFECYCLE,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_STALE_MS,
    DISCONNECT_GRACE_MS,
    join,
    leave,
    syncState,
    applyState,
    onStateChange,
    offStateChange,
    onOpponentDisconnect,
    offOpponentDisconnect,
    onReconnect,
    offReconnect,
    onLifecycleChange,
    offLifecycleChange,
    getState,
    getConnectionState,
    getLifecycleState,
    beginResync,
    endResync,
    getRoomId,
    isHost,
    getOpponentId,
    getSavedSession,
    discardSavedSession,
    reconnect,
    destroy,
  };

})();
