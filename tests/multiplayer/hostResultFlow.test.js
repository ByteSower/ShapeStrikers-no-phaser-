/**
 * Shape Strikers — tests/multiplayer/hostResultFlow.test.js
 *
 * Validates the host-authoritative result flow:
 *   1. Guest does NOT commit a round result before the host broadcasts.
 *   2. When the host broadcasts `round_result`, the guest applies it.
 *   3. If the host result doesn't arrive within HOST_RESULT_TIMEOUT_MS,
 *      the guest falls back to the replay-derived result.
 *   4. If playback is still live, the guest defers that fallback until a hard ceiling.
 *   4. If replay outcome data is incomplete, timeout fallback must not invent a guest win.
 *   5. roundNumber guard: stale results from previous rounds are ignored.
 *   6. Cached Room state fast-path: result already in snapshot is applied immediately.
 *   7. Host broadcast retry: mock syncState returning ok:false is retried up to 3×.
 *
 * Run: node tests/multiplayer/hostResultFlow.test.js
 */
'use strict';

const assert = require('assert/strict');

// ── Mock Room event bus ───────────────────────────────────────────────────────

function createMockRoom(initialState = {}) {
  let _listeners = [];
  const _state = { ...initialState };
  const _syncs = [];
  return {
    _emit(key, value) {
      _state[key] = value;
      for (const fn of _listeners.slice()) fn(key, value);
    },
    onStateChange(fn)  { _listeners.push(fn); },
    offStateChange(fn) { _listeners = _listeners.filter(l => l !== fn); },
    syncState(key, value) {
      _state[key] = value;
      _syncs.push({ key, value });
      return Promise.resolve({ ok: true });
    },
    getState()         { return _state; },
    getSyncs()         { return _syncs.slice(); },
    _listenerCount()   { return _listeners.length; },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

// ── Simulate the guest's onBattleEnd + round_result listener logic ────────────
// Mirrors game.js _mpStartMPBattle guest block exactly, so tests stay in sync.

function createGuestRoundHandler({
  room,
  onRoundEnd,
  timeoutMs = 9000,
  expectedRound = 1,
  deferTimeoutMs = timeoutMs,
  maxWaitMs = 60000,
  replayHostWon = null,
}) {
  let _roundResultHandled = false;
  let _hostResultTimer    = null;
  let _lastHandledResultPayload = null;
  let _lastAckSeq = -1;
  let _lastReadySeq = -1;
  let _hostResultWaitStartedAt = 0;

  const _buildResultSyncPayload = (resultPayload) => {
    if (!resultPayload) return null;
    const seq = Number(resultPayload.seq || 0);
    if (!(seq > 0)) return null;
    return {
      roundNumber: resultPayload.roundNumber === undefined ? expectedRound : resultPayload.roundNumber,
      seq,
      at: Date.now(),
    }; 
  };

  const _sendGuestResultSync = (key, resultPayload, force = false) => {
    const payload = _buildResultSyncPayload(resultPayload);
    if (!payload) return false;

    if (key === 'round_result_ack') {
      if (!force && _lastAckSeq === payload.seq) return false;
      _lastAckSeq = payload.seq;
    } else if (key === 'ready_to_continue') {
      if (!force && _lastReadySeq === payload.seq) return false;
      _lastReadySeq = payload.seq;
    }

    room.syncState(key, payload);
    return true;
  };

  const _applyResult = (guestWon, source, resultPayload = null) => {
    if (_roundResultHandled) return;
    if (resultPayload) _lastHandledResultPayload = resultPayload;
    _roundResultHandled = true;
    _hostResultWaitStartedAt = 0;
    if (_hostResultTimer) { clearTimeout(_hostResultTimer); _hostResultTimer = null; }
    room.offStateChange(_roundResultFn);
    if (resultPayload) _sendGuestResultSync('round_result_ack', resultPayload);
    onRoundEnd({ guestWon, source });
    if (resultPayload) _sendGuestResultSync('ready_to_continue', resultPayload);
  };

  const _shouldDeferHostResultFallback = () => {
    const phaseEvent = room.getState().phase_event;
    const roundResult = room.getState().round_result;
    return !roundResult && phaseEvent?.type === 'playback_start' &&
      (phaseEvent.roundNumber === undefined || phaseEvent.roundNumber === expectedRound);
  };

  const _resolveTimeoutGuestWon = () => {
    if (typeof replayHostWon === 'boolean') return !replayHostWon;
    return false;
  };

  const _armHostResultTimer = (reason = 'timeout', delayMs = timeoutMs) => {
    if (_roundResultHandled) return;
    if (_hostResultTimer) {
      clearTimeout(_hostResultTimer);
      _hostResultTimer = null;
    }
    if (!_hostResultWaitStartedAt) _hostResultWaitStartedAt = Date.now();
    _hostResultTimer = setTimeout(() => {
      if (_roundResultHandled) return;

      const waitedMs = Date.now() - _hostResultWaitStartedAt;
      if ((reason === 'timeout' || reason === 'timeout-reconnect') && waitedMs < maxWaitMs && _shouldDeferHostResultFallback()) {
        _armHostResultTimer(reason, deferTimeoutMs);
        return;
      }

      _applyResult(_resolveTimeoutGuestWon(), reason);
    }, delayMs);
  };

  // Mirrors _roundResultFn from game.js (attached BEFORE battle.start)
  const _roundResultFn = (key, value) => {
    if (key !== 'round_result') return;
    if (_roundResultHandled) {
      if (_lastHandledResultPayload &&
          (value.roundNumber === undefined || value.roundNumber === expectedRound) &&
          Number(value.seq || 0) === Number(_lastHandledResultPayload.seq || 0)) {
        _sendGuestResultSync('round_result_ack', value, true);
        _sendGuestResultSync('ready_to_continue', value, true);
      }
      return;
    }
    // Sequence guard — mirrors game.js
    if (value.roundNumber !== undefined && value.roundNumber !== expectedRound) return;
    _applyResult(!value.hostWon, 'host', value);
  };
  room.onStateChange(_roundResultFn);

  // Mirrors the guest replay-complete path arming the authoritative result timeout.
  const onBattleEnd = (_ignoredLocalWon) => {
    if (_roundResultHandled) return;

    // Fast-path: check Room state snapshot (mirrors game.js)
    const cached = room.getState()['round_result'];
    if (cached && cached.hostWon !== undefined &&
        (cached.roundNumber === undefined || cached.roundNumber === expectedRound)) {
      _applyResult(!cached.hostWon, 'cached', cached);
      return;
    }

    _armHostResultTimer('timeout', timeoutMs);
  };

  return { onBattleEnd, isHandled: () => _roundResultHandled };
}

function createHostContinueGate({ room, roundNumber = 1, seq = 1, onAdvance }) {
  let awaitingAck = true;
  let awaitingReady = true;
  let localResolved = false;
  let advances = 0;
  let released = false;

  const maybeAdvance = () => {
    if (released) return false;
    if (!localResolved || awaitingAck || awaitingReady) return false;
    released = true;
    advances++;
    onAdvance?.();
    return true;
  };

  room.onStateChange((key, value) => {
    if (!value) return;
    if (Number(value.roundNumber) !== roundNumber || Number(value.seq) !== seq) return;
    if (key === 'round_result_ack') {
      awaitingAck = false;
      maybeAdvance();
      return;
    }
    if (key === 'ready_to_continue') {
      awaitingReady = false;
      maybeAdvance();
    }
  });

  return {
    markLocalResolved() {
      localResolved = true;
      maybeAdvance();
    },
    getAdvances() {
      return advances;
    },
  };
}

// ── Host broadcast helper (mirrors game.js _mpHandleRoundEnd retry loop) ──────

function createHostBroadcaster({ room, playerWon, roundNumber, maxAttempts = 3, retryMs = 50 }) {
  let _attempts = 0;
  const _results = [];

  // syncState returns a controllable result; default ok:true after first failure
  let _failRemaining = 0;
  const setShouldFail = (n) => { _failRemaining = n; };

  const _broadcast = async () => {
    _attempts++;
    const mockResult = _failRemaining > 0
      ? (_failRemaining--, { ok: false, error: 'Channel not ready' })
      : { ok: true };

    if (mockResult.ok) {
      room._emit('round_result', { hostWon: playerWon, roundNumber, boardHash: null });
      _results.push({ attempt: _attempts, ok: true });
    } else {
      _results.push({ attempt: _attempts, ok: false });
      if (_attempts < maxAttempts) setTimeout(_broadcast, retryMs);
    }
  };

  return { broadcast: _broadcast, getResults: () => _results, getAttempts: () => _attempts, setShouldFail };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nHost-authoritative result flow tests\n');

// 1. Host result before local sim ends
test('Host result applied before local battle ends', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 5000 });

  room._emit('round_result', { hostWon: true, roundNumber: 1, boardHash: null });

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, false);
  assert.equal(results[0].source, 'host');
});

test('Guest sends round_result_ack and ready_to_continue for authoritative results', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 5000 });

  room._emit('round_result', { hostWon: true, roundNumber: 1, seq: 7, boardHash: null });

  const syncs = room.getSyncs();
  assert.equal(results.length, 1);
  assert.equal(syncs.length, 2, 'Guest should emit ack and ready-to-continue');
  assert.equal(syncs[0].key, 'round_result_ack');
  assert.equal(syncs[0].value.seq, 7);
  assert.equal(syncs[1].key, 'ready_to_continue');
  assert.equal(syncs[1].value.seq, 7);
});

test('Host waits for guest ack and ready_to_continue before advancing', () => {
  const room = createMockRoom();
  const gate = createHostContinueGate({ room, roundNumber: 1, seq: 7 });

  gate.markLocalResolved();
  assert.equal(gate.getAdvances(), 0);

  room._emit('round_result_ack', { roundNumber: 1, seq: 7 });
  assert.equal(gate.getAdvances(), 0, 'Ack alone should not advance');

  room._emit('ready_to_continue', { roundNumber: 1, seq: 7 });
  assert.equal(gate.getAdvances(), 1, 'Advance should release after both guest signals');
});

test('Host can release after guest signals arrive before local round settle', () => {
  const room = createMockRoom();
  const gate = createHostContinueGate({ room, roundNumber: 1, seq: 7 });

  room._emit('round_result_ack', { roundNumber: 1, seq: 7 });
  room._emit('ready_to_continue', { roundNumber: 1, seq: 7 });
  assert.equal(gate.getAdvances(), 0, 'Guest signals should not release before local settle');

  gate.markLocalResolved();
  assert.equal(gate.getAdvances(), 1, 'Release should happen once local settle completes');
});

test('Duplicate guest continue signals do not double-advance host', () => {
  const room = createMockRoom();
  const gate = createHostContinueGate({ room, roundNumber: 1, seq: 7 });

  gate.markLocalResolved();
  room._emit('round_result_ack', { roundNumber: 1, seq: 7 });
  room._emit('ready_to_continue', { roundNumber: 1, seq: 7 });
  room._emit('round_result_ack', { roundNumber: 1, seq: 7 });
  room._emit('ready_to_continue', { roundNumber: 1, seq: 7 });

  assert.equal(gate.getAdvances(), 1, 'Host should release only once');
});

// 2. Inversion
test('Host result: hostWon=false → guestWon=true', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r) });
  room._emit('round_result', { hostWon: false, roundNumber: 1, boardHash: null });
  assert.equal(results[0].guestWon, true);
});

// 3. Local ends first → waits for host, host overrides
test('Local battle ends but does not commit score before host result', () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 5000 });

  handler.onBattleEnd(true);
  assert.equal(results.length, 0, 'Score should not be committed yet');
  assert.equal(handler.isHandled(), false);

  room._emit('round_result', { hostWon: true, roundNumber: 1, boardHash: null });
  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, false, 'Host overrides local win');
  assert.equal(results[0].source, 'host');
});

// 4. Idempotent
test('Second round_result broadcast is ignored (idempotent)', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r) });
  room._emit('round_result', { hostWon: true,  roundNumber: 1 });
  room._emit('round_result', { hostWon: false, roundNumber: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, false);
});

// 5. Unrelated keys ignored
test('Non-round_result state changes do not trigger commit', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r) });
  room._emit('shop_seed',    { seed: 12345 });
  room._emit('player_ready', { units: [] });
  room._emit('chat_message', { text: 'hello' });
  assert.equal(results.length, 0);
});

// 6. Listener removed after handling
test('Room listener is removed after host result is applied', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r) });
  assert.equal(room._listenerCount(), 1);
  room._emit('round_result', { hostWon: false, roundNumber: 1 });
  assert.equal(room._listenerCount(), 0);
});

// 7. Timeout fallback
testAsync('Timeout fallback applies replay-derived result after HOST_RESULT_TIMEOUT_MS', async () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 50, replayHostWon: false });

  handler.onBattleEnd();
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, true);
  assert.equal(results[0].source, 'timeout');
});

// 8. Host arrives after timeout → ignored
testAsync('Host result after timeout fallback is ignored', async () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 50, replayHostWon: false });

  handler.onBattleEnd();
  await new Promise(resolve => setTimeout(resolve, 100));
  room._emit('round_result', { hostWon: false, roundNumber: 1 });

  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'timeout', 'Timeout result not overridden');
});

testAsync('Timeout defers while playback_start is still live and host result can still arrive', async () => {
  const room = createMockRoom({ phase_event: { type: 'playback_start', roundNumber: 1 } });
  const results = [];
  const handler = createGuestRoundHandler({
    room,
    onRoundEnd: (r) => results.push(r),
    timeoutMs: 20,
    deferTimeoutMs: 20,
    maxWaitMs: 120,
    replayHostWon: false,
  });

  handler.onBattleEnd();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(results.length, 0, 'Guest should keep waiting while playback_start is still live');

  room._emit('round_result', { hostWon: true, roundNumber: 1, seq: 9, boardHash: null });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, false);
  assert.equal(results[0].source, 'host');
});

testAsync('Timeout still falls back after the hard wait ceiling', async () => {
  const room = createMockRoom({ phase_event: { type: 'playback_start', roundNumber: 1 } });
  const results = [];
  const handler = createGuestRoundHandler({
    room,
    onRoundEnd: (r) => results.push(r),
    timeoutMs: 20,
    deferTimeoutMs: 20,
    maxWaitMs: 55,
    replayHostWon: false,
  });

  handler.onBattleEnd();
  await new Promise(resolve => setTimeout(resolve, 110));

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, true);
  assert.equal(results[0].source, 'timeout');
});

testAsync('Timeout fallback does not invent a guest win when replay outcome is incomplete', async () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({
    room,
    onRoundEnd: (r) => results.push(r),
    timeoutMs: 50,
    replayHostWon: null,
  });

  handler.onBattleEnd();
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, false, 'Incomplete replay data must not resolve as a guest win');
  assert.equal(results[0].source, 'timeout');
});

// 9. roundNumber guard: stale result from a previous round is ignored
test('Stale round_result (wrong roundNumber) is ignored', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), expectedRound: 3 });

  // Deliver a result for round 2 (stale)
  room._emit('round_result', { hostWon: true, roundNumber: 2 });
  assert.equal(results.length, 0, 'Stale result should be ignored');

  // Correct round
  room._emit('round_result', { hostWon: false, roundNumber: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, true);
});

// 10. Missing roundNumber is accepted (backward compat)
test('round_result without roundNumber is accepted (backward compat)', () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), expectedRound: 2 });
  room._emit('round_result', { hostWon: true }); // no roundNumber
  assert.equal(results.length, 1, 'Should be accepted');
});

// 11. Cached Room state fast-path: host finished before onBattleEnd fires
test('Guest applies cached Room state immediately in onBattleEnd (host was faster)', () => {
  // Pre-seed the Room state with a round_result as if host broadcast arrived first
  const room = createMockRoom({ round_result: { hostWon: false, roundNumber: 1 } });
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), expectedRound: 1 });

  handler.onBattleEnd(true /* local says guest wins */);

  assert.equal(results.length, 1, 'Should use cached result immediately');
  assert.equal(results[0].guestWon, true, 'hostWon=false → guestWon=true');
  assert.equal(results[0].source, 'cached');
});

// 12. Cached state stale round is not applied
test('Stale cached round_result (wrong roundNumber) is not applied in onBattleEnd', () => {
  const room = createMockRoom({ round_result: { hostWon: true, roundNumber: 1 } });
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), expectedRound: 2, timeoutMs: 5000 });

  handler.onBattleEnd(true);
  assert.equal(results.length, 0, 'Stale cached result should not be applied');
});

// 13. Host retry: ok:false causes retry up to maxAttempts
testAsync('Host retries broadcast on ok:false up to maxAttempts', async () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), expectedRound: 1 });

  // Host fails 2 times, succeeds on 3rd
  const host = createHostBroadcaster({ room, playerWon: true, roundNumber: 1, maxAttempts: 3, retryMs: 20 });
  host.setShouldFail(2);
  host.broadcast();

  // Wait for retries to finish
  await new Promise(resolve => setTimeout(resolve, 200));

  const attempts = host.getResults();
  assert.equal(attempts.length, 3, 'Should have attempted exactly 3 times');
  assert.equal(attempts[0].ok, false, 'First attempt failed');
  assert.equal(attempts[1].ok, false, 'Second attempt failed');
  assert.equal(attempts[2].ok, true,  'Third attempt succeeded');
  assert.equal(results.length, 1, 'Guest should have received the result');
});

// 14. Host gives up after maxAttempts with no success
testAsync('Host stops retrying after maxAttempts all fail', async () => {
  const room = createMockRoom();
  const results = [];
  createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r) });

  const host = createHostBroadcaster({ room, playerWon: true, roundNumber: 1, maxAttempts: 3, retryMs: 20 });
  host.setShouldFail(10); // always fail
  host.broadcast();

  await new Promise(resolve => setTimeout(resolve, 200));

  const attempts = host.getResults();
  assert.equal(attempts.length, 3, 'Exactly maxAttempts made');
  assert.ok(attempts.every(a => !a.ok), 'All failed');
  assert.equal(results.length, 0, 'Guest never received result (falls back to timeout)');
});

console.log('\nDone.\n');

