'use strict';

const MultiplayerAuthorityState = (() => {
  const REQUEST_MODES = Object.freeze({
    AUTO: 'auto',
    FULL: 'full',
    PREP: 'prep',
    BATTLE: 'battle',
  });

  const KEY_ORDER = Object.freeze([
    'prep_state',
    'shop_seed',
    'mp_reroll',
    'prep_p1',
    'prep_p2',
    'ready_p1',
    'ready_p2',
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ]);

  const KEY_GROUPS = Object.freeze({
    [REQUEST_MODES.FULL]: KEY_ORDER,
    [REQUEST_MODES.PREP]: Object.freeze([
      'prep_state',
      'shop_seed',
      'mp_reroll',
      'prep_p1',
      'prep_p2',
      'ready_p1',
      'ready_p2',
    ]),
    [REQUEST_MODES.BATTLE]: Object.freeze([
      'battle_replay',
      'playback_checkpoint',
      'phase_event',
      'round_result',
    ]),
  });

  function _cloneSerializable(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function _asPositiveInt(value) {
    const normalized = Number(value || 0);
    return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : 0;
  }

  function _asNonNegativeInt(value) {
    const normalized = Number(value || 0);
    return Number.isFinite(normalized) && normalized >= 0 ? Math.floor(normalized) : 0;
  }

  function matchesRound(payload, roundNumber) {
    if (!payload) return false;
    if (payload.roundNumber === undefined) return true;
    return Number(payload.roundNumber) === Number(roundNumber);
  }

  function normalizeRequestMode(mode, fallback = REQUEST_MODES.AUTO) {
    const normalized = String(mode || '').trim().toLowerCase();
    return Object.values(REQUEST_MODES).includes(normalized) ? normalized : fallback;
  }

  function getRequestModeForReason(reason = 'unknown') {
    const normalizedReason = String(reason || '').trim().toLowerCase();
    if (normalizedReason === 'missing_battle_replay' || normalizedReason === 'replay_hash_mismatch') {
      return REQUEST_MODES.BATTLE;
    }
    if (normalizedReason === 'reload_resume') {
      return REQUEST_MODES.AUTO;
    }
    return REQUEST_MODES.FULL;
  }

  function _hasKeysForMode(roomState, roundNumber, mode) {
    const keys = KEY_GROUPS[mode] || [];
    return keys.some((key) => {
      const value = roomState?.[key];
      if (value === undefined || value === null) return false;
      return matchesRound(value, roundNumber);
    });
  }

  function resolveRoundNumber(roomState = {}) {
    const candidates = [
      roomState.authoritative_state,
      roomState.round_result,
      roomState.phase_event,
      roomState.playback_checkpoint,
      roomState.battle_replay,
      roomState.prep_state,
      roomState.prep_p1,
      roomState.prep_p2,
    ];

    for (const candidate of candidates) {
      const roundNumber = _asPositiveInt(candidate?.roundNumber || candidate?.round || 0);
      if (roundNumber > 0) return roundNumber;
    }

    return 0;
  }

  function resolveCheckpointSeq(roomState = {}, roundNumber = 0) {
    const targetRound = _asPositiveInt(roundNumber);
    const directCheckpoint = roomState?.playback_checkpoint;
    if (directCheckpoint && (targetRound <= 0 || matchesRound(directCheckpoint, targetRound))) {
      return _asNonNegativeInt(directCheckpoint.seq);
    }

    const authoritativeCheckpoint = roomState?.authoritative_state?.state?.playback_checkpoint;
    if (authoritativeCheckpoint && (targetRound <= 0 || matchesRound(authoritativeCheckpoint, targetRound))) {
      return _asNonNegativeInt(authoritativeCheckpoint.seq);
    }

    return 0;
  }

  function resolveResumeTarget({
    savedResumeContext = null,
    roomState = {},
    snapshotRound = 0,
    localWave = 0,
    trackedRound = 0,
    liveRound = 0,
  } = {}) {
    const savedRound = _asPositiveInt(savedResumeContext?.roundNumber);
    const roomRound = resolveRoundNumber(roomState);
    const roundNumber = Math.max(
      savedRound,
      _asPositiveInt(snapshotRound),
      roomRound,
      _asPositiveInt(localWave),
      _asPositiveInt(trackedRound),
      _asPositiveInt(liveRound),
      0
    );

    const roomCheckpointSeq = resolveCheckpointSeq(roomState, roundNumber);
    const savedCheckpointSeq = (savedRound > 0 && savedRound === roundNumber)
      ? _asNonNegativeInt(savedResumeContext?.checkpointSeq)
      : 0;

    let requestedMode = REQUEST_MODES.AUTO;
    if (savedRound > 0 && savedRound === roundNumber) {
      if (savedResumeContext?.phase === 'prep') requestedMode = REQUEST_MODES.PREP;
      else if (savedResumeContext?.phase === 'battle' || savedResumeContext?.phase === 'result') requestedMode = REQUEST_MODES.BATTLE;
    }

    if (requestedMode === REQUEST_MODES.AUTO) {
      if (_hasKeysForMode(roomState, roundNumber, REQUEST_MODES.BATTLE)) requestedMode = REQUEST_MODES.BATTLE;
      else if (_hasKeysForMode(roomState, roundNumber, REQUEST_MODES.PREP)) requestedMode = REQUEST_MODES.PREP;
    }

    return {
      roundNumber,
      checkpointSeq: Math.max(roomCheckpointSeq, savedCheckpointSeq, 0),
      requestedMode,
    };
  }

  function resolveResponseMode({ requestedMode = REQUEST_MODES.AUTO, reason = 'unknown', roomState = {}, roundNumber = 0 } = {}) {
    const normalizedRequestedMode = normalizeRequestMode(requestedMode);
    if (normalizedRequestedMode === REQUEST_MODES.PREP || normalizedRequestedMode === REQUEST_MODES.BATTLE || normalizedRequestedMode === REQUEST_MODES.FULL) {
      return normalizedRequestedMode;
    }

    const fallbackMode = getRequestModeForReason(reason);
    if (fallbackMode !== REQUEST_MODES.AUTO) return fallbackMode;

    if (_hasKeysForMode(roomState, roundNumber, REQUEST_MODES.BATTLE)) {
      return REQUEST_MODES.BATTLE;
    }
    if (_hasKeysForMode(roomState, roundNumber, REQUEST_MODES.PREP)) {
      return REQUEST_MODES.PREP;
    }
    return REQUEST_MODES.FULL;
  }

  function shouldRequestResync({ guestBoardHash, hostBoardHash, seq = 0, lastRequestedSeq = -1, authoritativeSeq = -1 }) {
    if (!guestBoardHash || !hostBoardHash) return false;
    if (String(guestBoardHash) === String(hostBoardHash)) return false;

    const normalizedSeq = Number(seq || 0);
    if (normalizedSeq > 0) {
      if (normalizedSeq === Number(lastRequestedSeq || 0)) return false;
      if (normalizedSeq === Number(authoritativeSeq || 0)) return false;
    }

    return true;
  }

  function buildRequest({ roundNumber, seq = 0, reason = 'unknown', mode = REQUEST_MODES.AUTO, guestBoardHash = null, hostBoardHash = null, checkpointSeq = 0 }) {
    const payload = {
      roundNumber: Number(roundNumber) || 0,
      reason,
      mode: normalizeRequestMode(mode),
      at: Date.now(),
      guestBoardHash: guestBoardHash == null ? null : String(guestBoardHash),
      hostBoardHash: hostBoardHash == null ? null : String(hostBoardHash),
      checkpointSeq: Math.max(0, Number(checkpointSeq) || 0),
    };
    const normalizedSeq = Number(seq || 0);
    if (normalizedSeq > 0) payload.seq = normalizedSeq;
    return payload;
  }

  function buildPayload({ roundNumber, roomState, meta = {}, mode = REQUEST_MODES.FULL }) {
    const state = {};
    const source = roomState || {};
    const targetRound = Number(roundNumber) || 0;
    const responseMode = resolveResponseMode({
      requestedMode: mode,
      reason: meta?.reason,
      roomState: source,
      roundNumber: targetRound,
    });
    const keys = KEY_GROUPS[responseMode] || KEY_GROUPS[REQUEST_MODES.FULL];
    for (const key of keys) {
      if (source[key] === undefined || source[key] === null) continue;
      if (targetRound > 0 && source[key] && typeof source[key] === 'object' && source[key].roundNumber !== undefined) {
        if (Number(source[key].roundNumber) !== targetRound) continue;
      }
      state[key] = _cloneSerializable(source[key]);
    }

    return {
      roundNumber: Number(roundNumber) || 0,
      at: Date.now(),
      meta: Object.assign(_cloneSerializable(meta) || {}, { responseMode }),
      state,
    };
  }

  function getEntries(payload) {
    const state = payload?.state || {};
    return KEY_ORDER
      .filter(key => state[key] !== undefined && state[key] !== null)
      .map(key => ({ key, value: _cloneSerializable(state[key]) }));
  }

  return {
    REQUEST_MODES,
    KEY_ORDER,
    KEY_GROUPS,
    normalizeRequestMode,
    getRequestModeForReason,
    resolveResponseMode,
    resolveRoundNumber,
    resolveCheckpointSeq,
    resolveResumeTarget,
    matchesRound,
    shouldRequestResync,
    buildRequest,
    buildPayload,
    getEntries,
  };
})();