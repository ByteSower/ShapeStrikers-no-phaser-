/**
 * Shape Strikers — tests/multiplayer/hostResultFlow.test.js
 *
 * Validates the host-authoritative result flow:
 *   1. Guest does NOT commit a round result before the host broadcasts.
 *   2. When the host broadcasts `round_result`, the guest applies it.
 *   3. If the host result doesn't arrive within HOST_RESULT_TIMEOUT_MS,
 *      the guest falls back to its local battle result.
 *   4. If the guest's local result arrives BEFORE the host broadcasts,
 *      the guest waits (visual-only path).
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
  return {
    _emit(key, value) {
      _state[key] = value;
      for (const fn of _listeners.slice()) fn(key, value);
    },
    onStateChange(fn)  { _listeners.push(fn); },
    offStateChange(fn) { _listeners = _listeners.filter(l => l !== fn); },
    syncState(key, value) { _state[key] = value; return Promise.resolve({ ok: true }); },
    getState()         { return _state; },
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

function createGuestRoundHandler({ room, onRoundEnd, timeoutMs = 9000, expectedRound = 1 }) {
  let _roundResultHandled = false;
  let _hostResultTimer    = null;

  const _applyResult = (guestWon, source) => {
    if (_roundResultHandled) return;
    _roundResultHandled = true;
    if (_hostResultTimer) { clearTimeout(_hostResultTimer); _hostResultTimer = null; }
    room.offStateChange(_roundResultFn);
    onRoundEnd({ guestWon, source });
  };

  // Mirrors _roundResultFn from game.js (attached BEFORE battle.start)
  const _roundResultFn = (key, value) => {
    if (key !== 'round_result') return;
    if (_roundResultHandled) return;
    // Sequence guard — mirrors game.js
    if (value.roundNumber !== undefined && value.roundNumber !== expectedRound) return;
    _applyResult(!value.hostWon, 'host');
  };
  room.onStateChange(_roundResultFn);

  // Mirrors battle.onBattleEnd for guest
  const onBattleEnd = (localWon) => {
    if (_roundResultHandled) return;

    // Fast-path: check Room state snapshot (mirrors game.js)
    const cached = room.getState()['round_result'];
    if (cached && cached.hostWon !== undefined &&
        (cached.roundNumber === undefined || cached.roundNumber === expectedRound)) {
      _applyResult(!cached.hostWon, 'cached');
      return;
    }

    _hostResultTimer = setTimeout(() => _applyResult(localWon, 'timeout'), timeoutMs);
  };

  return { onBattleEnd, isHandled: () => _roundResultHandled };
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
testAsync('Timeout fallback applies local result after HOST_RESULT_TIMEOUT_MS', async () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 50 });

  handler.onBattleEnd(true);
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(results.length, 1);
  assert.equal(results[0].guestWon, true);
  assert.equal(results[0].source, 'timeout');
});

// 8. Host arrives after timeout → ignored
testAsync('Host result after timeout fallback is ignored', async () => {
  const room = createMockRoom();
  const results = [];
  const handler = createGuestRoundHandler({ room, onRoundEnd: (r) => results.push(r), timeoutMs: 50 });

  handler.onBattleEnd(true);
  await new Promise(resolve => setTimeout(resolve, 100));
  room._emit('round_result', { hostWon: false, roundNumber: 1 });

  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'timeout', 'Timeout result not overridden');
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

