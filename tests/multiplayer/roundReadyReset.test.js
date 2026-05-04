'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

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

function createMockRoom(initialState = {}) {
  let listeners = [];
  const state = { ...initialState };
  const syncs = [];

  return {
    onStateChange(fn) { listeners.push(fn); },
    offStateChange(fn) { listeners = listeners.filter(listener => listener !== fn); },
    syncState(key, value) {
      state[key] = value;
      syncs.push({ key, value });
      return { ok: true };
    },
    emit(key, value, fromId = 'remote-player') {
      state[key] = value;
      for (const listener of listeners.slice()) listener(key, value, fromId);
    },
    getState() { return { ...state }; },
    getSyncs() { return syncs.slice(); },
    clearSyncs() { syncs.length = 0; },
  };
}

global.window = global;
global.console = console;
global.ELEMENT_SYNERGIES = [];

loadModule('multiplayerGame.js');

console.log('\nMultiplayer round ready reset tests\n');

test('Host clears stale round-scoped room keys when a new round starts', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  MultiplayerGame.start('room-reset-1', true, 'guest-1', {
    onRoundReady: () => {},
  });

  room.clearSyncs();
  MultiplayerGame.endRound(true, 0);

  const syncs = room.getSyncs();
  assert.deepEqual(syncs.find(sync => sync.key === 'ready_p1')?.value, {
    ready: false,
    roundNumber: 2,
    at: syncs.find(sync => sync.key === 'ready_p1')?.value?.at,
  });
  assert.deepEqual(syncs.find(sync => sync.key === 'ready_p2')?.value, {
    ready: false,
    roundNumber: 2,
    at: syncs.find(sync => sync.key === 'ready_p2')?.value?.at,
  });
  assert.equal(syncs.find(sync => sync.key === 'round_result')?.value, null);
  assert.equal(syncs.find(sync => sync.key === 'phase_event')?.value, null);
  assert.equal(syncs.find(sync => sync.key === 'battle_replay')?.value, null);
  assert.ok(syncs.find(sync => sync.key === 'shop_seed'), 'New round should still broadcast a fresh shop_seed');

  MultiplayerGame.destroy();
});

test('Stale ready payloads from the previous round do not trigger onBothReady', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  let bothReadyCount = 0;
  MultiplayerGame.start('room-reset-2', true, 'guest-2', {
    onRoundReady: () => {},
    onBothReady: () => { bothReadyCount++; },
  });

  MultiplayerGame.endRound(true, 0);
  room.clearSyncs();

  room.emit('ready_p2', { ready: true, roundNumber: 1, units: [] });
  MultiplayerGame.signalReady([]);
  assert.equal(bothReadyCount, 0, 'Previous-round ready payload must be ignored');

  room.emit('ready_p2', { ready: true, roundNumber: 2, units: [] });
  assert.equal(bothReadyCount, 1, 'Current-round ready payload should start the battle once');

  const ownReady = room.getSyncs().find(sync => sync.key === 'ready_p1');
  assert.equal(ownReady?.value?.roundNumber, 2, 'Local ready broadcast should be scoped to the current round');

  MultiplayerGame.destroy();
});

test('Guest ignores cleared battle_start state until the host sends a real round payload', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  let bothReadyCount = 0;
  MultiplayerGame.start('room-reset-3', false, 'host-3', {
    onRoundReady: () => {},
    onBothReady: () => { bothReadyCount++; },
  });

  room.emit('battle_start', null);
  assert.equal(bothReadyCount, 0, 'Cleared battle_start state must not trigger battle start');

  room.emit('battle_start', { round: 1 });
  assert.equal(bothReadyCount, 1, 'A real battle_start payload should trigger onBothReady exactly once');

  MultiplayerGame.destroy();
});

test('Duplicate ready snapshots do not replay the opponent-ready callback', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  let opponentReadyCount = 0;
  MultiplayerGame.start('room-reset-4', true, 'guest-4', {
    onRoundReady: () => {},
    onOppReady: () => { opponentReadyCount++; },
  });

  room.emit('ready_p2', { ready: true, roundNumber: 1, units: [] });
  room.emit('ready_p2', { ready: true, roundNumber: 1, units: [] });
  room.emit('ready_p2', { ready: true, roundNumber: 1, units: [] });
  assert.equal(opponentReadyCount, 1, 'Repeated ready=true snapshots should not replay the cue');

  room.emit('ready_p2', { ready: false, roundNumber: 1, units: [] });
  room.emit('ready_p2', { ready: true, roundNumber: 1, units: [] });
  assert.equal(opponentReadyCount, 2, 'A fresh false->true transition should still notify once');

  MultiplayerGame.destroy();
});