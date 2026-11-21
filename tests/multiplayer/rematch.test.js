/**
 * Shape Strikers — tests/multiplayer/rematch.test.js
 *
 * Tests for the MultiplayerRematch handshake used on the match-end screen.
 *
 * Run: node tests/multiplayer/rematch.test.js
 */
'use strict';

const assert = require('assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.window = global;

vm.runInThisContext(
  fs.readFileSync(path.resolve(__dirname, '../../src/multiplayer/rematch.js'), 'utf8'),
  { filename: 'multiplayer/rematch.js' },
);

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

// Two sessions wired back-to-back; `deliver` controls when messages arrive.
function createPair(roomId = 'room-1') {
  const inbox = { a: [], b: [] };
  const starts = { a: [], b: [] };
  const make = (self, other) => MultiplayerRematch.createSession({
    roomId,
    send: (key, value) => { inbox[other].push([key, value]); return Promise.resolve({ ok: true }); },
    onStart: (next) => starts[self].push(next),
  });
  const sessions = { a: make('a', 'b'), b: make('b', 'a') };
  const deliver = (to) => {
    const msgs = inbox[to].splice(0);
    msgs.forEach(([key, value]) => sessions[to].handleState(key, value));
  };
  return { sessions, starts, deliver };
}

console.log('\nRematch tests\n');

test('nextRoomId: appends then increments a rematch suffix', () => {
  assert.equal(MultiplayerRematch.nextRoomId('abc'), 'abc~rematch-1');
  assert.equal(MultiplayerRematch.nextRoomId('abc~rematch-1'), 'abc~rematch-2');
  assert.equal(MultiplayerRematch.nextRoomId('abc~rematch-9'), 'abc~rematch-10');
});

test('both players requesting starts exactly once on each side with the same room', () => {
  const { sessions, starts, deliver } = createPair();
  sessions.a.requestLocal();
  deliver('b');
  assert.equal(starts.b.length, 0, 'One request alone must not start');
  sessions.b.requestLocal();
  deliver('a');
  deliver('b');
  sessions.a.requestLocal();
  assert.deepEqual(starts.a, ['room-1~rematch-1']);
  assert.deepEqual(starts.b, ['room-1~rematch-1']);
});

test('simultaneous clicks (messages crossing) still start both sides', () => {
  const { sessions, starts, deliver } = createPair();
  sessions.a.requestLocal();
  sessions.b.requestLocal();
  deliver('a');
  deliver('b');
  assert.equal(starts.a.length, 1);
  assert.equal(starts.b.length, 1);
});

test('an opponent request received before clicking is honored on click', () => {
  const session = MultiplayerRematch.createSession({ roomId: 'r', send: () => {}, onStart: (n) => started.push(n) });
  const started = [];
  session.handleState(MultiplayerRematch.REQUEST_KEY, { roomId: 'r', at: 1 });
  assert.equal(session.getStatus().remoteWants, true);
  session.requestLocal();
  assert.deepEqual(started, ['r~rematch-1']);
});

test('a decline blocks the rematch for both sides', () => {
  const { sessions, starts, deliver } = createPair();
  sessions.a.requestLocal();
  sessions.b.declineLocal();
  deliver('a');
  deliver('b');
  assert.equal(sessions.a.getStatus().declined, true);
  assert.equal(sessions.b.requestLocal(), false, 'Decliner cannot request afterwards');
  assert.equal(starts.a.length + starts.b.length, 0);
});

test('messages for a different room are ignored', () => {
  const started = [];
  const session = MultiplayerRematch.createSession({ roomId: 'room-2', send: () => {}, onStart: (n) => started.push(n) });
  session.handleState(MultiplayerRematch.REQUEST_KEY, { roomId: 'room-1', at: 1 });
  session.handleState(MultiplayerRematch.DECLINE_KEY, { roomId: 'room-1', at: 1 });
  session.requestLocal();
  assert.deepEqual(session.getStatus(), { localWants: true, remoteWants: false, declined: false, started: false });
  assert.equal(started.length, 0);
});

test('onStart receives the pending send so the caller can flush before leaving', () => {
  const pending = Promise.resolve({ ok: true });
  let received = null;
  const session = MultiplayerRematch.createSession({ roomId: 'r', send: () => pending, onStart: (_, p) => { received = p; } });
  session.handleState(MultiplayerRematch.REQUEST_KEY, { roomId: 'r' });
  session.requestLocal();
  assert.equal(received, pending);
});

console.log('\nDone.\n');
