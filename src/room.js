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
 *   - Values whose JSON exceeds STATE_CHUNK_THRESHOLD_CHARS (e.g. battle
 *     replays, authoritative_state bundles) are gzip+base64 encoded when the
 *     browser supports CompressionStream and split into `state_chunk`
 *     broadcasts that stay well below the Realtime message-size limit.
 *     Outbound and inbound messages are processed in order, so a small
 *     message sent after a large one is never delivered before it.
 *   - Each client advertises `caps` in room presence ({ gzip, replayPack }).
 *     Senders skip gzip for a peer that can't decompress it (Safari < 16.4)
 *     and pack replay snapshots (ReplayCodec) only for peers that can unpack
 *     them. Peers without `caps` (older clients) get gzip and no packing.
 *   - The room channel uses broadcast ack; state sends that time out are
 *     retried, and receivers drop duplicates by seq / transferId.
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
 *   Room.join(roomId, isHost)           → boolean
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
 *   Room.retireSavedSession(reason?)   → boolean  (clear + stop persisting until the next join)
 *   Room.reconnect()                   → boolean
 *   Room.destroy()                     → void
 *
 * Depends on: utils/secureIds.js, backend.js, supabaseClient.js
 * Load order: after matchmaking.js, before game.js
 */

const Room = (() => {
  let _accountSuspended = false;
  // False once the match is over, so late state messages cannot re-save a resumable session.
  let _sessionPersistEnabled = true;

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
  let _opponentCaps       = null;  // { gzip, replayPack } from opponent presence; null = unknown/legacy
  let _hasSeenOpponentActivity = false;
  let _disconnectTimer    = null;
  let _staleTimer         = null;
  let _heartbeatTimer     = null;
  let _channelStatus      = 'closed';
  let _lifecycleState     = CONNECTION_LIFECYCLE.CLOSED;
  let _hasEverSubscribed  = false;
  let _lastRemoteActivityAt = 0;

  // Large-payload transport. Supabase Realtime rejects oversized broadcasts
  // (256 KB on the free tier) and multiplayer replays can exceed 1 MB raw.
  const STATE_CHUNK_THRESHOLD_CHARS = 48 * 1024;
  const STATE_CHUNK_SIZE_CHARS      = 32 * 1024;
  const STATE_CHUNK_MAX_PARTS       = 256;
  const STATE_CHUNK_TRANSFER_TTL_MS = 30_000;
  const STATE_CHUNK_SEND_GAP_MS     = 10;
  // Realtime can deliver a large frame after smaller frames sent just after it,
  // so state messages carry a per-sender seq and are released in order. A gap
  // that doesn't fill within this window is treated as lost.
  const STATE_SEQ_GAP_TIMEOUT_MS    = 2500;
  let _transport = _createTransportState();
  let _transferCounter = 0;
  const STATE_SEND_TIMEOUT_MS = 4000;
  const STATE_SEND_MAX_ATTEMPTS = 3;
  const COMPLETED_TRANSFER_MEMORY = 32;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _getPlayerId() {
    if (_playerId) return _playerId;
    _playerId =
      (typeof Backend !== 'undefined' && Backend.getUserId()) ||
      SecureIds.create();
    return _playerId;
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

    const mergedSource = Object.assign({}, _resumeContext || {}, next);
    if (next.phase === 'prep') {
      mergedSource.checkpointSeq = 0;
      delete mergedSource.boardHash;
      delete mergedSource.phaseEventType;
    } else if (next.phase !== 'battle') {
      delete mergedSource.phaseEventType;
    }

    const merged = _normalizeResumeContext(mergedSource);
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
    if (_accountSuspended) return null;
    if (typeof MultiplayerTelemetry === 'undefined' || typeof MultiplayerTelemetry.record !== 'function') return null;
    return MultiplayerTelemetry.record(type, details, { level });
  }

  function _cloneSerializable(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return Object.assign({}, value);
    }
  }

  function _clearSavedSession() {
    const storage = _getSessionStorage();
    if (!storage) return;
    try { storage.removeItem(ROOM_SESSION_KEY); } catch (error) {
      console.warn('[Room] Failed to clear saved room session:', error);
    }
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
    if (!_sessionPersistEnabled) return false;
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

  function _storeStateValue(key, value) {
    const snapshot = _cloneSerializable(value);
    _state[key] = snapshot;
    return snapshot;
  }

  // ── Large-payload transport ───────────────────────────────────────────────

  function _createTransportState() {
    return {
      outboundTail: null,
      outboundPending: 0,
      inboundQueue: [],
      inboundBusy: false,
      transfers: new Map(),
      completedTransfers: [],
      outSeq: 0,
      outEpoch: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      inSeq: { stream: null, expected: 0, held: new Map(), lastKeySeq: new Map(), gapTimer: null },
    };
  }

  function _resetTransport() {
    clearTimeout(_transport.inSeq.gapTimer);
    // Replacing the object (rather than mutating it) lets in-flight async work
    // from a previous room detect that it is stale and bail out.
    _transport = _createTransportState();
  }

  function _canCompress() {
    return typeof CompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function';
  }

  function _canDecompress() {
    return typeof DecompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function';
  }

  function _hasReplayCodec() {
    return typeof ReplayCodec !== 'undefined' && typeof ReplayCodec.pack === 'function';
  }

  function _localCaps() {
    return { gzip: _canDecompress(), replayPack: _hasReplayCodec() ? 1 : 0 };
  }

  function _peerAcceptsGzip() {
    return !_opponentCaps || _opponentCaps.gzip !== false;
  }

  function _peerAcceptsReplayPack() {
    return !!(_opponentCaps && Number(_opponentCaps.replayPack) >= 1 && _hasReplayCodec());
  }

  // Broadcasts acked by the server; retries on timeout. Receivers dedupe by seq/transferId.
  async function _sendStateMessage(transport, channelName, event, payload) {
    let result = null;
    for (let attempt = 1; attempt <= STATE_SEND_MAX_ATTEMPTS; attempt++) {
      if (transport !== _transport) return { ok: false, error: 'Room changed during send' };
      result = await SupabaseClient.broadcast(channelName, event, payload, { timeout: STATE_SEND_TIMEOUT_MS });
      if (result?.ok) return result;
      if (result?.error !== 'timed out' && result?.error !== 'error') return result || { ok: false, error: 'Broadcast failed' };
      if (attempt < STATE_SEND_MAX_ATTEMPTS) {
        _recordTelemetry('room.state_send_retry', { event, key: payload?.key || null, attempt, error: result?.error || null }, 'warn');
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
    return result || { ok: false, error: 'Broadcast failed' };
  }

  function _bytesToBase64(bytes) {
    let binary = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(binary);
  }

  function _base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function _encodeStatePayload(json) {
    if (_canCompress() && _peerAcceptsGzip()) {
      try {
        const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        return { encoding: 'gzip-base64', data: _bytesToBase64(bytes) };
      } catch (err) {
        console.warn('[Room] State compression failed — sending uncompressed chunks:', err);
      }
    }
    return { encoding: 'json', data: json };
  }

  async function _decodeStatePayload(encoding, data) {
    if (encoding === 'json') return JSON.parse(data);
    if (encoding === 'gzip-base64') {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('DecompressionStream unavailable in this browser');
      }
      const stream = new Blob([_base64ToBytes(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
    }
    throw new Error(`Unknown state chunk encoding: ${encoding}`);
  }

  function _enqueueOutbound(task) {
    const transport = _transport;
    transport.outboundPending++;
    const run = async () => {
      if (transport !== _transport) return { ok: false, error: 'Room changed before send' };
      try {
        return await task();
      } catch (err) {
        return { ok: false, error: err?.message || 'Send failed' };
      }
    };
    const next = (transport.outboundTail || Promise.resolve()).then(run, run);
    transport.outboundTail = next;
    next.then(() => {
      transport.outboundPending--;
      if (transport.outboundTail === next) transport.outboundTail = null;
    });
    return next;
  }

  function _broadcastStateSync(channelName, key, value, seq) {
    return _sendStateMessage(_transport, channelName, 'state_sync', {
      key,
      value,
      seq,
      seqEpoch: _transport.outEpoch,
      from: _getPlayerId(),
      seatId: _seatId,
      sessionId: _sessionId,
    });
  }

  async function _broadcastStateChunks(channelName, key, value, json, seq) {
    const transport = _transport;
    let packed = null;
    if (_peerAcceptsReplayPack()) {
      try {
        const packedJson = JSON.stringify(ReplayCodec.pack(value));
        if (packedJson.length < json.length) { json = packedJson; packed = 'rp1'; }
      } catch (err) {
        console.warn('[Room] Replay packing failed — sending unpacked:', err);
      }
    }
    const { encoding, data } = await _encodeStatePayload(json);
    const total = Math.max(1, Math.ceil(data.length / STATE_CHUNK_SIZE_CHARS));
    if (total > STATE_CHUNK_MAX_PARTS) {
      _recordTelemetry('room.state_chunk_rejected', { key, chars: json.length, total }, 'error');
      return { ok: false, error: `State "${key}" is too large to sync (${total} chunks)` };
    }
    _transferCounter = (_transferCounter + 1) % Number.MAX_SAFE_INTEGER;
    const transferId = `${_sessionId || 'room'}:${Date.now().toString(36)}:${_transferCounter}`;
    for (let index = 0; index < total; index++) {
      if (transport !== _transport) return { ok: false, error: 'Room changed during send' };
      if (index > 0) await new Promise(resolve => setTimeout(resolve, STATE_CHUNK_SEND_GAP_MS));
      const chunk = {
        transferId,
        key,
        seq,
        seqEpoch: transport.outEpoch,
        index,
        total,
        encoding,
        data: data.slice(index * STATE_CHUNK_SIZE_CHARS, (index + 1) * STATE_CHUNK_SIZE_CHARS),
        from: _getPlayerId(),
        seatId: _seatId,
        sessionId: _sessionId,
      };
      if (packed) chunk.packed = packed;
      const result = await _sendStateMessage(transport, channelName, 'state_chunk', chunk);
      if (!result?.ok) {
        _recordTelemetry('room.state_chunk_send_failed', { key, index, total, error: result?.error || null }, 'warn');
        return result || { ok: false, error: 'Chunk send failed' };
      }
    }
    return { ok: true, chunks: total, encoding, packed };
  }

  function _drainInbound(transport = _transport) {
    while (transport === _transport && !transport.inboundBusy && transport.inboundQueue.length) {
      const task = transport.inboundQueue.shift();
      let result;
      try {
        result = task();
      } catch (err) {
        console.error('[Room] Inbound state handler failed:', err);
        continue;
      }
      if (result && typeof result.then === 'function') {
        transport.inboundBusy = true;
        result
          .catch(err => console.error('[Room] Inbound state handler failed:', err))
          .then(() => {
            transport.inboundBusy = false;
            _drainInbound(transport);
          });
        return;
      }
    }
  }

  function _enqueueInbound(task) {
    _transport.inboundQueue.push(task);
    _drainInbound();
  }

  function _armSeqGapTimer(restart = false) {
    const transport = _transport;
    const seqState = transport.inSeq;
    if (restart) { clearTimeout(seqState.gapTimer); seqState.gapTimer = null; }
    if (seqState.gapTimer || !seqState.held.size) return;
    seqState.gapTimer = setTimeout(() => {
      seqState.gapTimer = null;
      if (transport !== _transport || !seqState.held.size) return;
      const skipTo = Math.min(...seqState.held.keys());
      _recordTelemetry('room.state_seq_gap_skipped', { from: seqState.expected, to: skipTo }, 'warn');
      seqState.expected = skipTo;
      _flushSequenced();
    }, STATE_SEQ_GAP_TIMEOUT_MS);
  }

  function _deliverSequenced(key, seq, task) {
    const lastKeySeq = _transport.inSeq.lastKeySeq;
    lastKeySeq.set(key, Math.max(lastKeySeq.get(key) || 0, seq));
    _enqueueInbound(task);
  }

  function _flushSequenced() {
    const seqState = _transport.inSeq;
    while (seqState.held.has(seqState.expected)) {
      const { key, task } = seqState.held.get(seqState.expected);
      seqState.held.delete(seqState.expected);
      _deliverSequenced(key, seqState.expected, task);
      seqState.expected++;
    }
    if (seqState.held.size) _armSeqGapTimer();
    else { clearTimeout(seqState.gapTimer); seqState.gapTimer = null; }
  }

  // Releases opponent state messages in the order they were sent. Payloads
  // without a seq (older clients) are applied immediately, as before.
  function _receiveSequenced(payload, key, task) {
    const seq = Number(payload?.seq);
    if (!Number.isInteger(seq) || seq < 1) { _enqueueInbound(task); return; }
    const seqState = _transport.inSeq;
    const stream = `${payload.sessionId || payload.from || 'remote'}:${payload.seqEpoch || ''}`;
    if (seqState.stream !== stream) {
      // First message from this sender session (join, or the opponent reloaded).
      clearTimeout(seqState.gapTimer);
      seqState.stream = stream;
      seqState.expected = seq;
      seqState.held.clear();
      seqState.lastKeySeq.clear();
      seqState.gapTimer = null;
    }
    if (seq < seqState.expected) {
      // Arrived after its gap was skipped; apply unless a newer value for the key already landed.
      if ((seqState.lastKeySeq.get(key) || 0) < seq) _deliverSequenced(key, seq, task);
      return;
    }
    if (!seqState.held.has(seq)) seqState.held.set(seq, { key, task });
    _flushSequenced();
  }

  function _applyIncomingState(key, value, from) {
    const snapshot = _storeStateValue(key, value);
    _updateResumeContext(key, snapshot);
    _emitState(key, snapshot, from || null);
  }

  function _pruneStaleTransfers(now = Date.now()) {
    for (const [id, transfer] of _transport.transfers) {
      if (now - transfer.startedAt > STATE_CHUNK_TRANSFER_TTL_MS) {
        _transport.transfers.delete(id);
        _recordTelemetry('room.state_chunk_expired', {
          key: transfer.key,
          received: transfer.received,
          total: transfer.total,
        }, 'warn');
      }
    }
  }

  function _onStateChunk(payload) {
    if (!payload || typeof payload.transferId !== 'string' || typeof payload.key !== 'string') return;
    if (typeof payload.data !== 'string') return;
    const total = Number(payload.total);
    const index = Number(payload.index);
    if (!Number.isInteger(total) || total < 1 || total > STATE_CHUNK_MAX_PARTS) return;
    if (!Number.isInteger(index) || index < 0 || index >= total) return;
    if (payload.data.length > STATE_CHUNK_SIZE_CHARS) return;
    if (!_isExpectedOpponentPayload(payload)) return;

    _noteRemoteActivity('state_chunk', {
      key: payload.key,
      from: payload.from || null,
      seatId: payload.seatId || null,
      sessionId: payload.sessionId || null,
    });

    const now = Date.now();
    _pruneStaleTransfers(now);
    if (_transport.completedTransfers.includes(payload.transferId)) return;  // retried chunk of a finished transfer

    let transfer = _transport.transfers.get(payload.transferId);
    if (!transfer) {
      transfer = {
        key: payload.key,
        total,
        encoding: payload.encoding,
        packed: payload.packed || null,
        parts: new Array(total),
        received: 0,
        startedAt: now,
      };
      _transport.transfers.set(payload.transferId, transfer);
    }
    if (transfer.total !== total || transfer.key !== payload.key || transfer.encoding !== payload.encoding) return;
    if (transfer.packed !== (payload.packed || null)) return;
    if (transfer.parts[index] === undefined) {
      transfer.parts[index] = payload.data;
      transfer.received++;
    }
    if (transfer.received < transfer.total) {
      // A transfer still arriving is progress, not a lost message.
      if (Number(payload.seq) === _transport.inSeq.expected) _armSeqGapTimer(true);
      return;
    }

    _transport.transfers.delete(payload.transferId);
    _transport.completedTransfers.push(payload.transferId);
    if (_transport.completedTransfers.length > COMPLETED_TRANSFER_MEMORY) _transport.completedTransfers.shift();
    const transport = _transport;
    const { key, encoding, packed } = transfer;
    const data = transfer.parts.join('');
    const from = payload.from || null;
    _receiveSequenced(payload, key, () => _decodeStatePayload(encoding, data).then((decoded) => {
      if (transport !== _transport) return;
      let value = decoded;
      if (packed) {
        if (packed !== 'rp1' || !_hasReplayCodec()) throw new Error(`Unsupported packing: ${packed}`);
        value = ReplayCodec.unpack(decoded);
      }
      _applyIncomingState(key, value, from);
    }).catch((err) => {
      console.error(`[Room] Failed to decode chunked state "${key}":`, err);
      _recordTelemetry('room.state_chunk_decode_failed', { key, encoding, error: err?.message || null }, 'error');
    }));
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

  function _readOpponentCaps(presenceState) {
    for (const slots of Object.values(presenceState)) {
      for (const slot of slots) {
        if (slot.playerId === _opponentId && slot.caps && typeof slot.caps === 'object') {
          return { gzip: slot.caps.gzip !== false, replayPack: Number(slot.caps.replayPack) || 0 };
        }
      }
    }
    return null;
  }

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
      _opponentCaps = _readOpponentCaps(presenceState) || _opponentCaps;
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
      _receiveSequenced(payload, key, () => _applyIncomingState(key, value, from));
    });

    ch.on('broadcast', { event: 'state_chunk' }, ({ payload }) => _onStateChunk(payload));

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
      caps:      _localCaps(),
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
    if (_accountSuspended) return false;
    if (typeof SupabaseClient === 'undefined') {
      console.warn('[Room] SupabaseClient not loaded — room unavailable.');
      return false;
    }
    if (_roomId) {
      console.warn('[Room] Already in a room — call leave() first.');
      return false;
    }

    let playerId, sessionId, reconnectToken;
    try {
      playerId = (typeof options?.playerId === 'string' && options.playerId) || _getPlayerId();
      sessionId = (typeof options?.sessionId === 'string' && options.sessionId) || SecureIds.create();
      reconnectToken = (typeof options?.reconnectToken === 'string' && options.reconnectToken) || SecureIds.create();
    } catch (error) {
      console.error('[Room] Cannot join without secure identifiers:', error);
      return false;
    }

    _roomId      = roomId;
    _host        = host;
    _playerId    = playerId;
    _opponentId  = opponentId || null;
    _channelName = `room:${roomId}`;
    _sessionId = sessionId;
    _reconnectToken = reconnectToken;
    _seatId = (options && typeof options.seatId === 'string' && options.seatId)
      ? options.seatId
      : _buildSeatId(roomId, host, _getPlayerId());
    _resumeContext = _normalizeResumeContext(options?.resumeContext) || null;
    _channelStatus = 'pending';
    _hasEverSubscribed = false;
    _sessionPersistEnabled = true;
    _saveSession();

    // Clear state from any previous session.
    Object.keys(_state).forEach(k => delete _state[k]);
    _resetTransport();
    _opponentPresent = false;
    _opponentCaps = null;
    _hasSeenOpponentActivity = false;
    _lastRemoteActivityAt = 0;
    _clearHeartbeatTimer();
    _clearLivenessTimers();
    _setLifecycleState('CONNECTING', { reason: 'join' });

    SupabaseClient.joinChannel(_channelName, _setupChannel, _onSubscribed, { ack: true });
    console.info(`[Room] Joining room: ${roomId.slice(0, 8)}… (isHost: ${host})`);
    return true;
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
    _opponentCaps = null;
    _hasSeenOpponentActivity = false;
    _lastRemoteActivityAt = 0;
    _clearSavedSession();
    Object.keys(_state).forEach(k => delete _state[k]);
    _resetTransport();
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
    const snapshot = _storeStateValue(key, value);
    _updateResumeContext(key, snapshot);

    const channelName = _channelName;
    let json;
    try {
      json = JSON.stringify(value === undefined ? null : value);
    } catch (err) {
      return { ok: false, error: err?.message || 'State is not serialisable' };
    }
    const isLarge = typeof json === 'string' && json.length > STATE_CHUNK_THRESHOLD_CHARS;
    const seq = ++_transport.outSeq;

    // Fast path keeps small messages synchronous when nothing is queued ahead of them.
    if (!isLarge && _transport.outboundPending === 0) {
      return _broadcastStateSync(channelName, key, value, seq);
    }
    return _enqueueOutbound(() => (isLarge
      ? _broadcastStateChunks(channelName, key, value, json, seq)
      : _broadcastStateSync(channelName, key, value, seq)));
  }

  /** Apply a state value locally and emit state listeners without broadcasting. */
  function applyState(key, value, from) {
    if (typeof key !== 'string' || key.length === 0) return;
    const snapshot = _storeStateValue(key, value);
    _updateResumeContext(key, snapshot);
    _emitState(key, snapshot, from || null);
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

  /** Returns a detached snapshot of the current local state. */
  function getState() { return _cloneSerializable(_state) || {}; }

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

  /** Clears the persisted session and keeps it cleared until the next join() (e.g. once the match is over). */
  function retireSavedSession(reason = 'match_over') {
    _sessionPersistEnabled = false;
    return _discardSavedSession(reason);
  }

  /** Force an immediate reconnect attempt for the current room channel. */
  function reconnect() {
    if (_accountSuspended) return false;
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
      return join(saved.roomId, saved.isHost, saved.opponentId, {
        playerId: saved.playerId || currentPlayerId || undefined,
        seatId: saved.seatId || expectedSeatId,
        sessionId: saved.sessionId || undefined,
        reconnectToken: saved.reconnectToken || undefined,
        resumeContext: saved.resumeContext || undefined,
      });
    }
    console.info(`[Room] Manual reconnect requested for ${_channelName}.`);
    _syncChannelStatus();
    _setLifecycleState(_hasEverSubscribed ? 'RECONNECTING' : 'CONNECTING', {
      reason: 'manual_reconnect',
    });
    return SupabaseClient.reconnectChannel(_channelName);
  }

  function _clearListeners() {
    _stateListeners      = [];
    _disconnectListeners = [];
    _reconnectListeners  = [];
    _lifecycleListeners  = [];
  }

  function suspendOutgoing() {
    if (_accountSuspended) return;
    _accountSuspended = true;
    _clearListeners();
    leave();
    console.warn('[Room] Account changed; room recovery is paused until reload.');
  }

  /** Alias for leave() — clean up all room state and listeners. */
  function destroy() {
    leave();
    _clearListeners();
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
    retireSavedSession,
    clearSavedSession: _clearSavedSession,
    suspendOutgoing,
    discardSavedSession,
    reconnect,
    destroy,
  };

})();
