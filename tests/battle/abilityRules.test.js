'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { getElementById: () => null, querySelector: () => null };
global.window = global;

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

loadModule('config.js');
loadModule('battle.js');

const UNIT_MAP = Object.fromEntries(UNIT_DEFINITIONS.map(def => [def.id, def]));

function mkUnit(def, row, col, isEnemy = false) {
  return {
    id: `${isEnemy ? 'e' : 'p'}::${def.id}::${row}::${col}`,
    name: def.name,
    definition: def,
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    stats: { ...def.stats },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy,
    row,
    col,
  };
}

function makeIdleBattleSystem() {
  const battleSystem = new BattleSystem();
  battleSystem._running = true;
  battleSystem._scheduleFn = () => 0;
  battleSystem.onActionDone = () => ({ then: (resolve) => resolve() });
  return battleSystem;
}

test('support healers cast even when no enemy is in range', () => {
  const battleSystem = makeIdleBattleSystem();
  const healer = mkUnit(UNIT_MAP.frost_fairy, 4, 0, false);
  const ally = mkUnit(UNIT_MAP.earth_golem, 4, 1, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);

  ally.hp = 50;
  battleSystem._playerUnits = [healer, ally];
  battleSystem._enemyUnits = [enemy];
  battleSystem._actionQueue = [healer];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  assert.equal(ally.hp, 75, 'healer should restore HP instead of moving when no enemy is in range');
  assert.equal(healer.row, 4, 'healer should not move while casting a support ability');
  assert.equal(healer.abilityCooldown, UNIT_MAP.frost_fairy.ability.cooldown, 'support cast should consume ability cooldown');
});

test('blood knight ability honors its documented 30 percent lifesteal', () => {
  const battleSystem = makeIdleBattleSystem();
  const knight = mkUnit(UNIT_MAP.blood_knight, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  knight.hp = 100;
  battleSystem._playerUnits = [knight];
  battleSystem._enemyUnits = [target];

  const expectedDamage = battleSystem._calcDamage(knight, target, 1.2);
  const expectedHeal = Math.floor(Math.floor(expectedDamage * 0.3) * battleSystem._healMod(knight));

  battleSystem._useAbility(knight, [target], [knight]);

  assert.equal(knight.hp, 100 + expectedHeal, 'blood knight ability should heal for 30 percent of dealt damage');
});