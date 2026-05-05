'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOM_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/room.js'), 'utf8');
const ROOM_SESSION_KEY = 'shape_strikers_mp_room_session';

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

function createSessionStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store.entries());
    },
  };
}

function loadRoomContext(storageSeed = {}, options = {}) {
  const calls = {
    joined: [],
    reconnected: [],
    broadcasts: [],
  };
  const sessionStorage = createSessionStorage(storageSeed);
  const backendPlayerId = options.backendPlayerId || 'player-self';

  const context = {
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Date,
    Backend: {
      getUserId() {
        return backendPlayerId;
      },
    },
    SupabaseClient: {
      joinChannel(name, setupFn, onSubscribed) {
        calls.joined.push({ name, setupFn: typeof setupFn, onSubscribed: typeof onSubscribed });
      },
      leaveChannel(name) {
        calls.left = name;
      },
      reconnectChannel(name) {
        calls.reconnected.push(name);
        return true;
      },
      broadcast(name, event, payload) {
        calls.broadcasts.push({ name, event, payload });
        return { ok: true };
      },
      getChannelStatus() {
        return 'SUBSCRIBED';
      },
      getChannel() {
        return {
          presenceState() {
            return {};
          },
        };
      },
    },
    sessionStorage,
  };

  context.global = context;
  context.window = context;

  vm.createContext(context);
  vm.runInContext(ROOM_SOURCE, context, { filename: 'room.js' });

  return {
    Room: vm.runInContext('Room', context),
    sessionStorage,
    calls,
  };
}

console.log('\nRoom saved-session tests\n');

test('join persists room session metadata for reload resume', () => {
  const { Room, sessionStorage, calls } = loadRoomContext();

  Room.join('room-alpha', false, 'opp-123');

  const saved = JSON.parse(sessionStorage.getItem(ROOM_SESSION_KEY));
  assert.equal(saved.roomId, 'room-alpha');
  assert.equal(saved.isHost, false);
  assert.equal(saved.opponentId, 'opp-123');
  assert.equal(saved.playerId, 'player-self');
  assert.equal(saved.seatId, 'room-alpha:player-self:guest');
  assert.equal(typeof saved.sessionId, 'string');
  assert.equal(saved.sessionId.length > 0, true);
  assert.equal(typeof saved.reconnectToken, 'string');
  assert.equal(saved.reconnectToken.length > 0, true);
  assert.equal(saved.resumeContext ?? null, null);
  assert.equal(calls.joined[0].name, 'room:room-alpha');
});

test('leave clears the saved room session', () => {
  const { Room, sessionStorage } = loadRoomContext();

  Room.join('room-beta', true, 'opp-999');
  Room.leave();

  assert.equal(sessionStorage.getItem(ROOM_SESSION_KEY), null);
});

test('reconnect restores a legacy saved room session after reload and upgrades identity metadata', () => {
  const { Room, calls, sessionStorage } = loadRoomContext({
    [ROOM_SESSION_KEY]: JSON.stringify({
      roomId: 'room-gamma',
      isHost: false,
      opponentId: 'opp-42',
      playerId: 'player-self',
      savedAt: 123,
    }),
  });

  const started = Room.reconnect();
  assert.equal(started, true);
  assert.equal(Room.getRoomId(), 'room-gamma');
  assert.equal(Room.isHost(), false);
  assert.equal(Room.getOpponentId(), 'opp-42');
  assert.equal(calls.joined[0].name, 'room:room-gamma');

  const saved = JSON.parse(sessionStorage.getItem(ROOM_SESSION_KEY));
  assert.equal(saved.playerId, 'player-self');
  assert.equal(saved.seatId, 'room-gamma:player-self:guest');
  assert.equal(typeof saved.sessionId, 'string');
  assert.equal(saved.sessionId.length > 0, true);
  assert.equal(typeof saved.reconnectToken, 'string');
  assert.equal(saved.reconnectToken.length > 0, true);
});

test('reconnect rejects a saved room session that belongs to a different backend player', () => {
  const { Room, sessionStorage, calls } = loadRoomContext({
    [ROOM_SESSION_KEY]: JSON.stringify({
      roomId: 'room-delta',
      isHost: false,
      opponentId: 'opp-77',
      playerId: 'player-old',
      seatId: 'room-delta:player-old:guest',
      sessionId: 'session-old',
      reconnectToken: 'token-old',
      savedAt: 999,
    }),
  }, {
    backendPlayerId: 'player-new',
  });

  const started = Room.reconnect();
  assert.equal(started, false);
  assert.equal(sessionStorage.getItem(ROOM_SESSION_KEY), null);
  assert.equal(calls.joined.length, 0);
});

test('reconnect rejects a saved host room session while cold host resume is disabled', () => {
  const { Room, sessionStorage, calls } = loadRoomContext({
    [ROOM_SESSION_KEY]: JSON.stringify({
      roomId: 'room-host-cold',
      isHost: true,
      opponentId: 'opp-host',
      playerId: 'player-self',
      seatId: 'room-host-cold:player-self:host',
      sessionId: 'session-host',
      reconnectToken: 'token-host',
      savedAt: 777,
    }),
  });

  const started = Room.reconnect();
  assert.equal(started, false);
  assert.equal(sessionStorage.getItem(ROOM_SESSION_KEY), null);
  assert.equal(calls.joined.length, 0);
});

test('discardSavedSession clears a saved room session without joining a room', () => {
  const { Room, sessionStorage, calls } = loadRoomContext({
    [ROOM_SESSION_KEY]: JSON.stringify({
      roomId: 'room-zeta',
      isHost: true,
      opponentId: 'opp-zeta',
      playerId: 'player-self',
      savedAt: 555,
    }),
  });

  const cleared = Room.discardSavedSession('test_cleanup');
  assert.equal(cleared, true);
  assert.equal(sessionStorage.getItem(ROOM_SESSION_KEY), null);
  assert.equal(calls.joined.length, 0);
});

test('resume context persists latest round and checkpoint metadata for reload recovery', () => {
  const { Room, sessionStorage } = loadRoomContext();

  Room.join('room-epsilon', false, 'opp-11');
  Room.applyState('playback_checkpoint', {
    roundNumber: 3,
    seq: 12,
    turn: 4,
    boardHash: 'hash-123',
  }, 'opp-11');

  const saved = JSON.parse(sessionStorage.getItem(ROOM_SESSION_KEY));
  assert.equal(saved.resumeContext.roundNumber, 3);
  assert.equal(saved.resumeContext.checkpointSeq, 12);
  assert.equal(saved.resumeContext.phase, 'battle');
  assert.equal(saved.resumeContext.sourceKey, 'playback_checkpoint');
  assert.equal(saved.resumeContext.boardHash, 'hash-123');
  assert.equal(Number.isFinite(saved.resumeContext.updatedAt), true);
});