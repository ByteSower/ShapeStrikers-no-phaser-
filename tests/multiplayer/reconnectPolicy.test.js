'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOM_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/room.js'), 'utf8');
const GAME_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');

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

function createBaseContext() {
  const documentStub = {
    readyState: 'loading',
    addEventListener() {},
    removeEventListener() {},
  };

  const context = {
    console,
    JSON,
    Math,
    Date,
    setTimeout,
    clearTimeout,
    document: documentStub,
    window: null,
  };

  context.window = context;
  context.global = context;
  return context;
}

function loadRoomContext() {
  const context = createBaseContext();
  vm.createContext(context);
  vm.runInContext(ROOM_SOURCE, context, { filename: 'room.js' });
  return {
    Room: vm.runInContext('Room', context),
  };
}

function loadGameContext(roomGraceMs = 10_000) {
  const context = createBaseContext();

  context.requestAnimationFrame = () => 0;
  context.cancelAnimationFrame = () => {};
  context.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  context.sessionStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  context.Room = { DISCONNECT_GRACE_MS: roomGraceMs };
  context.Audio = { init() {}, play() {}, playMusic() {} };
  context.Backend = { init() {}, getPlayerName() { return 'Test'; }, getUserId() { return 'player'; } };
  context.SupabaseClient = { init() {}, leaveAll() {} };
  context.Presence = { onCountChange() {}, init() {} };
  context.GlobalChat = { init() {} };
  context.Matchmaking = { init() {}, isSearching() { return false; }, leaveQueue() {}, onMatchFound() {} };
  context.UI = {
    showScreen() {},
    showMessage() {},
  };

  vm.createContext(context);
  vm.runInContext(GAME_SOURCE, context, { filename: 'game.js' });

  return {
    Game: vm.runInContext('Game', context),
  };
}

console.log('\nMultiplayer reconnect policy tests\n');

test('Room exposes the shared disconnect grace policy', () => {
  const { Room } = loadRoomContext();

  assert.equal(Room.DISCONNECT_GRACE_MS, 10_000);
  assert.equal(Room.HEARTBEAT_STALE_MS, 7_000);
  assert.equal(Room.HEARTBEAT_INTERVAL_MS, 3_000);
});

test('Game guest resume bootstrap timeout stays longer than the room disconnect grace', () => {
  const { Room } = loadRoomContext();
  const { Game } = loadGameContext(Room.DISCONNECT_GRACE_MS);
  const policy = Game.getMultiplayerPolicy();

  assert.equal(policy.roomDisconnectGraceMs, Room.DISCONNECT_GRACE_MS);
  assert.equal(policy.guestResumeBootstrapTimeoutMs, Room.DISCONNECT_GRACE_MS + policy.guestResumeBootstrapBufferMs);
  assert.equal(policy.guestResumeBootstrapTimeoutMs > policy.roomDisconnectGraceMs, true);
});

test('Game derives guest resume bootstrap timeout from the room disconnect grace', () => {
  const { Game } = loadGameContext(15_000);
  const policy = Game.getMultiplayerPolicy();

  assert.equal(policy.roomDisconnectGraceMs, 15_000);
  assert.equal(policy.guestResumeBootstrapTimeoutMs, 17_000);
});