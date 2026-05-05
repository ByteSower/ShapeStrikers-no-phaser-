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
    onStateChange(fn) {
      listeners.push(fn);
    },
    offStateChange(fn) {
      listeners = listeners.filter(listener => listener !== fn);
    },
    syncState(key, value) {
      state[key] = value;
      syncs.push({ key, value });
      return { ok: true };
    },
    getState() {
      return state;
    },
    emit(key, value, fromId = 'remote-player') {
      state[key] = value;
      for (const listener of listeners.slice()) listener(key, value, fromId);
    },
    getSyncs() {
      return syncs.slice();
    },
    clearSyncs() {
      syncs.length = 0;
    },
  };
}

global.window = global;
global.console = console;
global.ELEMENT_SYNERGIES = [];

loadModule('multiplayerGame.js');

console.log('\nMultiplayer prep recovery tests\n');

test('Host broadcasts prep_state alongside shop_seed at round start', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  const roundReadyCalls = [];
  MultiplayerGame.start('room-1', true, 'guest-1', {
    onRoundReady: (round, gold) => roundReadyCalls.push({ round, gold }),
  });

  const syncs = room.getSyncs();
  const seedSync = syncs.find(sync => sync.key === 'shop_seed');
  const prepSync = syncs.find(sync => sync.key === 'prep_state');
  assert.ok(seedSync, 'Host should broadcast shop_seed');
  assert.ok(prepSync, 'Host should broadcast prep_state');
  assert.equal(prepSync.value.roundNumber, 1);
  assert.equal(prepSync.value.shopSeed, seedSync.value);
  assert.equal(prepSync.value.rerollIndex, 0);
  assert.equal(roundReadyCalls.length, 1, 'Host should still enter prep immediately');

  MultiplayerGame.destroy();
});

test('Guest can recover a missed prep start from prep_state alone', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  const roundReadyCalls = [];
  MultiplayerGame.start('room-2', false, 'host-1', {
    onRoundReady: (round, gold) => roundReadyCalls.push({ round, gold }),
  });

  room.emit('prep_state', {
    roundNumber: 2,
    shopSeed: 123456789,
    rerollIndex: 0,
  });

  assert.equal(MultiplayerGame.getRound(), 2, 'Guest round should advance from prep_state');
  assert.equal(roundReadyCalls.length, 1, 'prep_state should trigger prep recovery when shop_seed was missed');
  assert.equal(roundReadyCalls[0].round, 2);

  MultiplayerGame.destroy();
});

test('Guest prep_state reroll recovery updates future rerolls without rebuilding prep', () => {
  const room = createMockRoom();
  global.Room = room;
  MultiplayerGame.destroy();

  const roundReadyCalls = [];
  const pool = [
    { id: 'unit_a', tier: 1 },
    { id: 'unit_b', tier: 1 },
  ];

  MultiplayerGame.start('room-3', false, 'host-2', {
    onRoundReady: (round, gold) => roundReadyCalls.push({ round, gold }),
    onOpponentReroll: () => {},
  });

  room.emit('shop_seed', 77);
  assert.equal(roundReadyCalls.length, 1, 'Initial shop_seed should enter prep once');

  room.emit('prep_state', {
    roundNumber: 1,
    shopSeed: 77,
    rerollIndex: 3,
  });
  assert.equal(roundReadyCalls.length, 1, 'Same-round prep_state should not rebuild the local shop');

  room.clearSyncs();
  const units = MultiplayerGame.doReroll(pool, 1);
  const syncs = room.getSyncs();
  const rerollSync = syncs.find(sync => sync.key === 'mp_reroll');
  const prepSync = syncs.find(sync => sync.key === 'prep_state');

  assert.ok(Array.isArray(units) && units.length === 1, 'Reroll should still generate a shop');
  assert.equal(rerollSync?.value, 4, 'Recovered reroll index should carry into the next reroll');
  assert.equal(prepSync?.value?.rerollIndex, 4, 'Shared prep_state should publish the new reroll index');

  MultiplayerGame.destroy();
});