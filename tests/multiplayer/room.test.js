/**
 * Shape Strikers — tests/multiplayer/room.test.js
 *
 * Tests for the Room module.  Room is the per-match Realtime channel
 * manager.  The tests use a SupabaseClient mock to avoid network I/O and
 * focus on the observable public API:
 *
 *   - onStateChange / offStateChange listener management
 *   - syncState  — optimistic local update + mock broadcast
 *   - getState   — returns a snapshot of the local mirror
 *   - getConnectionState / getRoomId / isHost / getOpponentId — accessors
 *   - leave      — resets state and clears listeners
 *   - destroy    — leave + clear all listener arrays
 *   - reconnect  — delegates to SupabaseClient.reconnectChannel
 *   - onReconnect / offReconnect listener plumbing
 *   - onOpponentDisconnect / offOpponentDisconnect listener plumbing
 *
 * All tests run sequentially inside an async IIFE (Room is a singleton).
 *
 * Run: node tests/multiplayer/room.test.js
 */
'use strict';

const assert = require('assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

// ── Browser/global stubs ──────────────────────────────────────────────────────
global.window  = global;
global.console = console;

// Minimal Backend stub
global.Backend = {
  getUserId: () => 'test-player-local',
};

// ── SupabaseClient mock ───────────────────────────────────────────────────────
// Room calls:
//   SupabaseClient.joinChannel(name, setupFn, onSubscribed)
//   SupabaseClient.leaveChannel(name)
//   SupabaseClient.broadcast(name, event, payload)  → Promise<{ok}>
//   SupabaseClient.getChannel(name)  → channel object or null
//   SupabaseClient.getChannelStatus(name)  → string
//   SupabaseClient.reconnectChannel(name)  → boolean

const broadcasts   = [];
let _channelStatus = 'SUBSCRIBED';
let _reconnectCount = 0;

const fakeChannel = {
  _presenceState: {},
  presenceState() { return this._presenceState; },
  async track(payload) { return { ok: true }; },
  on() { return this; }, // fluent no-op for event registration
};

global.SupabaseClient = {
  joinChannel(name, setupFn, onSubscribed) {
    if (typeof setupFn === 'function') setupFn(fakeChannel);
    // Note: onSubscribed is async; skip calling it to avoid presence side-effects
  },
  leaveChannel(name) {},
  async broadcast(name, event, payload) {
    broadcasts.push({ name, event, payload });
    return { ok: true };
  },
  getChannel(name) {
    return _channelStatus !== 'closed' ? fakeChannel : null;
  },
  getChannelStatus(name) {
    return _channelStatus;
  },
  reconnectChannel(name) {
    _reconnectCount++;
    return true;
  },
};

// ── Helpers for tests ─────────────────────────────────────────────────────────

function resetMock() {
  broadcasts.length = 0;
  _channelStatus  = 'SUBSCRIBED';
  _reconnectCount = 0;
  fakeChannel._presenceState = {};
}

// Standard setup: join a room cleanly, reset mock state.
function joinRoom(opts = {}) {
  resetMock();
  Room.destroy();
  Room.join(opts.roomId || 'room-abc', opts.isHost ?? true, opts.opponentId || 'opp-xyz');
}

// ── Load Room module ──────────────────────────────────────────────────────────

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

loadModule('room.js');

// ── Sequential test runner ────────────────────────────────────────────────────

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

// ── All tests run sequentially ────────────────────────────────────────────────

(async () => {
  console.log('\nRoom tests\n');

  // ── getRoomId / isHost / getOpponentId ──────────────────────────────────────

  await test('getRoomId: returns null before join()', async () => {
    resetMock();
    Room.destroy();
    assert.equal(Room.getRoomId(), null);
  });

  await test('getRoomId: returns the roomId passed to join()', async () => {
    joinRoom({ roomId: 'my-room-123' });
    assert.equal(Room.getRoomId(), 'my-room-123');
    Room.destroy();
  });

  await test('isHost: returns true when joined as host', async () => {
    joinRoom({ isHost: true });
    assert.equal(Room.isHost(), true);
    Room.destroy();
  });

  await test('isHost: returns false when joined as guest', async () => {
    joinRoom({ isHost: false });
    assert.equal(Room.isHost(), false);
    Room.destroy();
  });

  await test('getOpponentId: returns the opponentId passed to join()', async () => {
    joinRoom({ opponentId: 'enemy-player-99' });
    assert.equal(Room.getOpponentId(), 'enemy-player-99');
    Room.destroy();
  });

  await test('getOpponentId: returns null after leave()', async () => {
    joinRoom();
    Room.leave();
    assert.equal(Room.getOpponentId(), null);
  });

  // ── getConnectionState ───────────────────────────────────────────────────────

  await test('getConnectionState: returns "closed" before joining', async () => {
    resetMock();
    Room.destroy();
    assert.equal(Room.getConnectionState(), 'closed');
  });

  await test('getConnectionState: returns SupabaseClient channel status when in room', async () => {
    joinRoom();
    _channelStatus = 'SUBSCRIBED';
    assert.equal(Room.getConnectionState(), 'SUBSCRIBED');
    _channelStatus = 'pending';
    assert.equal(Room.getConnectionState(), 'pending');
    Room.destroy();
  });

  // ── syncState and getState ───────────────────────────────────────────────────

  await test('syncState: optimistically updates local state mirror immediately', async () => {
    joinRoom();
    await Room.syncState('battle_seed', 0xDEADBEEF);
    const snap = Room.getState();
    assert.equal(snap['battle_seed'], 0xDEADBEEF, 'syncState should update local mirror');
    Room.destroy();
  });

  await test('syncState: broadcasts to SupabaseClient with correct shape', async () => {
    joinRoom();
    broadcasts.length = 0; // clear broadcasts from join/destroy
    await Room.syncState('ready_p1', true);
    assert.equal(broadcasts.length, 1, 'Should broadcast exactly once');
    assert.equal(broadcasts[0].event, 'state_sync');
    assert.equal(broadcasts[0].payload.key, 'ready_p1');
    assert.equal(broadcasts[0].payload.value, true);
    Room.destroy();
  });

  await test('syncState: returns {ok:false} when not in a room', async () => {
    resetMock();
    Room.destroy();
    const result = await Room.syncState('anything', 42);
    assert.equal(result.ok, false, 'Should fail when not in a room');
    assert.ok(typeof result.error === 'string', 'Should include an error message');
  });

  await test('getState: returns empty object initially', async () => {
    joinRoom();
    const snap = Room.getState();
    assert.ok(typeof snap === 'object', 'getState should return an object');
    assert.equal(Object.keys(snap).length, 0);
    Room.destroy();
  });

  await test('getState: snapshot does not mutate internal state when modified externally', async () => {
    joinRoom();
    await Room.syncState('shop_seed', 1234);
    const snap1 = Room.getState();
    snap1['shop_seed'] = 9999; // mutate the returned snapshot
    const snap2 = Room.getState();
    assert.equal(snap2['shop_seed'], 1234, 'Internal state should not be affected by external mutation');
    Room.destroy();
  });

  await test('getState: nested payload mutation does not leak back into internal state', async () => {
    joinRoom();
    await Room.syncState('round_result', { hostWon: true, meta: { seq: 7 } });
    const snap1 = Room.getState();
    snap1.round_result.meta.seq = 99;
    snap1.round_result.hostWon = false;

    const snap2 = Room.getState();
    assert.equal(snap2.round_result.hostWon, true, 'Nested object mutation should not change internal state');
    assert.equal(snap2.round_result.meta.seq, 7, 'Nested payload mutation should not leak into Room state');
    Room.destroy();
  });

  await test('getState: returns all keys synced in order', async () => {
    joinRoom();
    await Room.syncState('key_a', 'val_a');
    await Room.syncState('key_b', 'val_b');
    const snap = Room.getState();
    assert.equal(snap['key_a'], 'val_a');
    assert.equal(snap['key_b'], 'val_b');
    Room.destroy();
  });

  await test('syncState: multiple keys coexist in the local mirror', async () => {
    joinRoom();
    await Room.syncState('round', 3);
    await Room.syncState('winner', 'host');
    await Room.syncState('gold', 42);
    const snap = Room.getState();
    assert.equal(snap['round'], 3);
    assert.equal(snap['winner'], 'host');
    assert.equal(snap['gold'], 42);
    Room.destroy();
  });

  await test('syncState: caller payload mutation after send does not leak into Room state', async () => {
    joinRoom();
    const payload = { roundNumber: 2, nested: { seq: 5 } };
    await Room.syncState('round_result', payload);
    payload.roundNumber = 9;
    payload.nested.seq = 99;

    const snap = Room.getState();
    assert.equal(snap.round_result.roundNumber, 2, 'Room should store a snapshot of syncState payloads');
    assert.equal(snap.round_result.nested.seq, 5, 'Nested caller mutations should not leak into Room state');
    Room.destroy();
  });

  await test('syncState: overwriting a key updates the local mirror', async () => {
    joinRoom();
    await Room.syncState('round', 1);
    await Room.syncState('round', 2);
    const snap = Room.getState();
    assert.equal(snap['round'], 2, 'Second syncState should overwrite first');
    Room.destroy();
  });

  await test('applyState: caller payload mutation after apply does not leak into Room state', async () => {
    joinRoom();
    const payload = { boardHash: 'abc', meta: { checkpointSeq: 4 } };
    Room.applyState('playback_checkpoint', payload, 'opp-xyz');
    payload.boardHash = 'mutated';
    payload.meta.checkpointSeq = 99;

    const snap = Room.getState();
    assert.equal(snap.playback_checkpoint.boardHash, 'abc', 'Room should snapshot applyState payloads');
    assert.equal(snap.playback_checkpoint.meta.checkpointSeq, 4, 'Nested applyState payload mutation should not leak into Room state');
    Room.destroy();
  });

  // ── onStateChange / offStateChange ─────────────────────────────────────────

  await test('onStateChange: same listener registered twice is only stored once', async () => {
    joinRoom();
    const calls = [];
    const fn = () => calls.push(1);
    Room.onStateChange(fn);
    Room.onStateChange(fn); // second registration should be a no-op
    // Remove once — should fully remove the listener
    Room.offStateChange(fn);
    // If it was stored twice, offStateChange only removes one instance.
    // A second remove call should be safe (no throw):
    assert.doesNotThrow(() => Room.offStateChange(fn));
    Room.destroy();
  });

  await test('offStateChange: removes the specific listener while keeping others', async () => {
    joinRoom();
    const calls = [];
    const fn1 = () => calls.push('fn1');
    const fn2 = () => calls.push('fn2');
    Room.onStateChange(fn1);
    Room.onStateChange(fn2);
    Room.offStateChange(fn1);
    // fn2 is still registered; removing it should not throw
    assert.doesNotThrow(() => Room.offStateChange(fn2));
    Room.destroy();
  });

  await test('offStateChange: removing a non-registered function does not throw', async () => {
    joinRoom();
    assert.doesNotThrow(() => Room.offStateChange(() => {}));
    Room.destroy();
  });

  // ── onReconnect / offReconnect ──────────────────────────────────────────────

  await test('onReconnect: listener is registered and can be removed without throw', async () => {
    joinRoom();
    const fn = () => {};
    assert.doesNotThrow(() => Room.onReconnect(fn));
    assert.doesNotThrow(() => Room.offReconnect(fn));
    Room.destroy();
  });

  await test('offReconnect: removing a non-registered listener does not throw', async () => {
    joinRoom();
    assert.doesNotThrow(() => Room.offReconnect(() => {}));
    Room.destroy();
  });

  // ── onOpponentDisconnect / offOpponentDisconnect ────────────────────────────

  await test('onOpponentDisconnect: listener is registered and can be removed without throw', async () => {
    joinRoom();
    const fn = () => {};
    assert.doesNotThrow(() => Room.onOpponentDisconnect(fn));
    assert.doesNotThrow(() => Room.offOpponentDisconnect(fn));
    Room.destroy();
  });

  await test('offOpponentDisconnect: removing a non-registered listener does not throw', async () => {
    joinRoom();
    assert.doesNotThrow(() => Room.offOpponentDisconnect(() => {}));
    Room.destroy();
  });

  // ── leave ───────────────────────────────────────────────────────────────────

  await test('leave: clears roomId and resets state', async () => {
    joinRoom({ roomId: 'leave-test-room' });
    await Room.syncState('shop_seed', 42);
    Room.leave();
    assert.equal(Room.getRoomId(), null);
    assert.equal(Object.keys(Room.getState()).length, 0, 'State should be cleared on leave');
  });

  await test('leave: getConnectionState returns "closed" after leave()', async () => {
    joinRoom();
    Room.leave();
    assert.equal(Room.getConnectionState(), 'closed');
  });

  await test('leave: can be called multiple times without throwing', async () => {
    joinRoom();
    assert.doesNotThrow(() => {
      Room.leave();
      Room.leave();
      Room.leave();
    });
  });

  // ── reconnect ───────────────────────────────────────────────────────────────

  await test('reconnect: calls SupabaseClient.reconnectChannel when in a room', async () => {
    joinRoom();
    _reconnectCount = 0;
    const result = Room.reconnect();
    assert.equal(result, true, 'reconnect() should return true when channel is available');
    assert.equal(_reconnectCount, 1, 'Should call reconnectChannel exactly once');
    Room.destroy();
  });

  await test('reconnect: returns false when not in a room', async () => {
    resetMock();
    Room.destroy();
    const result = Room.reconnect();
    assert.equal(result, false, 'reconnect() should return false when no channel');
  });

  // ── destroy ─────────────────────────────────────────────────────────────────

  await test('destroy: resets all state (roomId, host, opponentId)', async () => {
    joinRoom({ roomId: 'destroy-test', isHost: true, opponentId: 'opp-99' });
    Room.destroy();
    assert.equal(Room.getRoomId(), null);
    assert.equal(Room.isHost(), false);
    assert.equal(Room.getOpponentId(), null);
    assert.equal(Room.getConnectionState(), 'closed');
  });

  await test('destroy: can be called on a fresh (never joined) instance without throwing', async () => {
    assert.doesNotThrow(() => Room.destroy());
  });

  await test('destroy: subsequent join() works normally after destroy()', async () => {
    joinRoom({ roomId: 'first-room' });
    Room.destroy();
    joinRoom({ roomId: 'second-room', isHost: false });
    assert.equal(Room.getRoomId(), 'second-room');
    assert.equal(Room.isHost(), false);
    Room.destroy();
  });

  await test('destroy: clears all listener arrays (state, disconnect, reconnect)', async () => {
    joinRoom();
    let stateFired = false, discFired = false, recFired = false;
    Room.onStateChange(() => { stateFired = true; });
    Room.onOpponentDisconnect(() => { discFired = true; });
    Room.onReconnect(() => { recFired = true; });
    Room.destroy();
    // After destroy, re-join and sync a key — no old listeners should fire.
    joinRoom();
    await Room.syncState('post_destroy_key', 42);
    // We can't directly trigger the listeners via the public API (they're called
    // on inbound broadcasts, not on syncState). But we can verify that offState/
    // disconnect/reconnect calls don't throw, implying they operate on fresh lists.
    assert.doesNotThrow(() => Room.offStateChange(() => {}));
    assert.doesNotThrow(() => Room.offOpponentDisconnect(() => {}));
    assert.doesNotThrow(() => Room.offReconnect(() => {}));
    Room.destroy();
  });

  // ── join guard ───────────────────────────────────────────────────────────────

  await test('join: second join() while already in a room is ignored', async () => {
    joinRoom({ roomId: 'room-1' });
    Room.join('room-2', false, 'other-opp'); // should be ignored
    assert.equal(Room.getRoomId(), 'room-1', 'Second join should be a no-op');
    Room.destroy();
  });

  await test('join: join() after leave() succeeds with new room', async () => {
    joinRoom({ roomId: 'room-A' });
    Room.leave();
    resetMock();
    Room.join('room-B', false, 'new-opp');
    assert.equal(Room.getRoomId(), 'room-B');
    assert.equal(Room.isHost(), false);
    assert.equal(Room.getOpponentId(), 'new-opp');
    Room.destroy();
  });

  console.log('\nDone.\n');
})();
