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

global.window = global;
global.console = console;

loadModule('multiplayerPrepState.js');

console.log('\nMultiplayer prep snapshot codec tests\n');

test('build serializes round, revision, shop ids, and unit snapshots', () => {
  const defs = [
    { id: 'fire_knight', name: 'Fire Knight' },
    { id: 'ice_mage', name: 'Ice Mage' },
  ];
  const payload = MultiplayerPrepState.build({
    roundNumber: 3,
    revision: 4,
    gold: 17,
    refreshesLeft: 2,
    upgradeLevels: { bargain_hunter: 1 },
    shopUnits: [defs[0], null, defs[1]],
    playerUnits: [{
      id: 99,
      definition: defs[0],
      row: 4,
      col: 2,
      hp: 21,
      maxHp: 21,
      stats: { hp: 21, atk: 8 },
      killStreak: 3,
      statusEffects: [{ type: 'burn' }],
    }],
  });

  assert.equal(payload.roundNumber, 3);
  assert.equal(payload.revision, 4);
  assert.equal(payload.gold, 17);
  assert.deepEqual(payload.shopUnits, ['fire_knight', null, 'ice_mage']);
  assert.equal(payload.playerUnits.length, 1);
  assert.equal(payload.playerUnits[0].defId, 'fire_knight');
  assert.equal(payload.playerUnits[0].killStreak, 3);
  assert.deepEqual(payload.playerUnits[0].stats, { hp: 21, atk: 8 });
});

test('inflate recreates units with resolved definitions and preserved custom fields', () => {
  const defs = [
    { id: 'fire_knight', name: 'Fire Knight' },
    { id: 'ice_mage', name: 'Ice Mage' },
  ];
  const restored = MultiplayerPrepState.inflate({
    roundNumber: 2,
    revision: 7,
    gold: 12,
    refreshesLeft: 1,
    upgradeLevels: { elite_training: 2 },
    shopUnits: ['ice_mage', null],
    playerUnits: [{
      defId: 'fire_knight',
      id: 41,
      row: 5,
      col: 1,
      hp: 18,
      maxHp: 20,
      stats: { hp: 20, atk: 9 },
      evolved: true,
      abilityCooldown: 2,
    }],
  }, {
    definitions: defs,
    createUnit: (def, row, col) => ({
      id: -1,
      definition: def,
      row,
      col,
      hp: 0,
      maxHp: 0,
      stats: {},
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
    }),
  });

  assert.equal(restored.roundNumber, 2);
  assert.equal(restored.revision, 7);
  assert.equal(restored.gold, 12);
  assert.equal(restored.shopUnits[0].id, 'ice_mage');
  assert.equal(restored.playerUnits.length, 1);
  assert.equal(restored.playerUnits[0].definition.id, 'fire_knight');
  assert.equal(restored.playerUnits[0].id, 41);
  assert.equal(restored.playerUnits[0].evolved, true);
  assert.equal(restored.playerUnits[0].abilityCooldown, 2);
  assert.deepEqual(restored.playerUnits[0].stats, { hp: 20, atk: 9 });
});