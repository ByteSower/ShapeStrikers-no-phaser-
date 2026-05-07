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

test('blood knight cleave heals from total dealt damage across all targets', () => {
  const battleSystem = makeIdleBattleSystem();
  const knight = mkUnit(UNIT_MAP.blood_knight, 2, 0, false);
  const targets = [
    mkUnit(UNIT_MAP.earth_golem, 2, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 1, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 2, true),
  ];

  knight.hp = 100;
  battleSystem._playerUnits = [knight];
  battleSystem._enemyUnits = targets;

  const totalDamage = targets.reduce(
    (sum, target) => sum + battleSystem._calcDamage(knight, target, 1.2),
    0
  );
  const expectedHeal = Math.floor(Math.floor(totalDamage * 0.3) * battleSystem._healMod(knight));

  battleSystem._useAbility(knight, targets, [knight]);

  assert.equal(
    knight.hp,
    100 + expectedHeal,
    'blood knight cleave should heal from 30 percent of total dealt damage after combining all hits'
  );
});

test('fire imp ember applies the documented 5 damage burn', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.fire_imp, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(caster, [target], [caster]);

  const burn = target.statusEffects.find(effect => effect.type === 'burn');
  assert.ok(burn, 'ember should apply burn');
  assert.equal(burn.duration, 3, 'ember burn should last 3 turns');
  assert.equal(burn.value, 5, 'ember burn should tick for 5 damage');

  const hpAfterAbility = target.hp;
  battleSystem._tickStatus(target);
  assert.equal(target.hp, hpAfterAbility - 5, 'ember burn tick should deal 5 damage');
});

test('fire scout fire blast applies the documented 3 damage minor burn', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.fire_scout, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(caster, [target], [caster]);

  const burn = target.statusEffects.find(effect => effect.type === 'burn');
  assert.ok(burn, 'fire blast should apply burn');
  assert.equal(burn.duration, 2, 'fire blast minor burn should last 2 turns');
  assert.equal(burn.value, 3, 'fire blast minor burn should tick for 3 damage');

  const hpAfterAbility = target.hp;
  battleSystem._tickStatus(target);
  assert.equal(target.hp, hpAfterAbility - 3, 'fire blast burn tick should deal 3 damage');
});