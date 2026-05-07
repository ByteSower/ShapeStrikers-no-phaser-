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

function poisonTickFromMaxHp(unit) {
  return Math.max(1, Math.floor(unit.maxHp * 0.05));
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

test('ice slime uses frost coat on enemies at the documented 2-row ability range', () => {
  const battleSystem = makeIdleBattleSystem();
  const slime = mkUnit(UNIT_MAP.ice_slime, 3, 0, false);
  const distantEnemy = mkUnit(UNIT_MAP.earth_golem, 1, 0, true);

  battleSystem._playerUnits = [slime];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [slime];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const slow = distantEnemy.statusEffects.find(effect => effect.type === 'slow');
  assert.ok(slow, 'frost coat should slow enemies within 2 rows');
  assert.equal(slow.duration, 2, 'frost coat slow should last 2 turns');
  assert.equal(slime.row, 3, 'ice slime should cast frost coat instead of moving when an enemy is in ability range');
  assert.equal(slime.abilityCooldown, UNIT_MAP.ice_slime.ability.cooldown, 'frost coat should consume the ability cooldown when cast');
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

test('earth archer boulder shot applies the implemented freeze skip status', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.earth_archer, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(caster, [target], [caster]);

  const freeze = target.statusEffects.find(effect => effect.type === 'freeze');
  assert.ok(freeze, 'boulder shot should apply freeze');
  assert.equal(freeze.duration, 1, 'boulder shot freeze should last 1 turn');
});

test('lightning knight thunder strike applies the implemented freeze skip status', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.lightning_knight, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(caster, [target], [caster]);

  const freeze = target.statusEffects.find(effect => effect.type === 'freeze');
  assert.ok(freeze, 'thunder strike should apply freeze');
  assert.equal(freeze.duration, 1, 'thunder strike freeze should last 1 turn');
});

test('fire warrior blazing charge does not hit off-column enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.fire_warrior, 3, 0, false);
  const offColumnTarget = mkUnit(UNIT_MAP.earth_golem, 2, 1, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [offColumnTarget];

  battleSystem._useAbility(caster, [offColumnTarget], [caster]);

  assert.equal(
    offColumnTarget.hp,
    offColumnTarget.maxHp,
    'blazing charge should not damage an enemy that is only in range but not in the same column'
  );
  assert.equal(
    offColumnTarget.statusEffects.some(effect => effect.type === 'burn'),
    false,
    'blazing charge should not burn an off-column enemy'
  );
});

test('konji shaman plague cloud reaches enemies outside base range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const shaman = mkUnit(UNIT_MAP.konji_shaman, 3, 0, false);
  const distantEnemy = mkUnit(UNIT_MAP.earth_golem, 0, 0, true);

  battleSystem._playerUnits = [shaman];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [shaman];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const poison = distantEnemy.statusEffects.find(effect => effect.type === 'poison');
  assert.ok(poison, 'plague cloud should poison enemies even when they are outside the caster\'s base attack range');
  assert.equal(poison.duration, 2, 'plague cloud poison should last 2 turns');
  assert.equal(poison.value, 8, 'plague cloud poison should tick for 8 damage');
  assert.equal(shaman.row, 3, 'konji shaman should cast plague cloud instead of moving when only a distant enemy is alive');
  assert.equal(shaman.abilityCooldown, UNIT_MAP.konji_shaman.ability.cooldown, 'plague cloud should consume the ability cooldown when cast');
});

test('void horror void rupture still respects weaken even while ignoring defense', () => {
  const battleSystem = makeIdleBattleSystem();
  const horror = mkUnit(UNIT_MAP.void_horror, 2, 0, false);
  const target = mkUnit(UNIT_MAP.fire_imp, 2, 0, true);

  horror.statusEffects.push({ type: 'weaken', duration: 2, stacks: 1, value: 0 });
  target.stats.defense = 0;

  battleSystem._playerUnits = [horror];
  battleSystem._enemyUnits = [target];

  const expectedDamage = battleSystem._calcDamage(horror, target, 1.2);

  battleSystem._useAbility(horror, [target], [horror]);

  assert.equal(
    target.hp,
    target.maxHp - expectedDamage,
    'void rupture should still apply weaken-based attack reduction while ignoring defense'
  );
});

test('units stay put when forward and both diagonal advance tiles are blocked', () => {
  const battleSystem = makeIdleBattleSystem();
  const mover = mkUnit(UNIT_MAP.earth_golem, 4, 2, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 0, 4, true);
  const forwardBlocker = mkUnit(UNIT_MAP.earth_golem, 3, 2, false);
  const rightDiagonalBlocker = mkUnit(UNIT_MAP.earth_golem, 3, 3, false);
  const leftDiagonalBlocker = mkUnit(UNIT_MAP.earth_golem, 3, 1, false);

  battleSystem._playerUnits = [mover, forwardBlocker, rightDiagonalBlocker, leftDiagonalBlocker];
  battleSystem._enemyUnits = [enemy];

  battleSystem._moveTowardEnemy(mover, [enemy]);

  assert.equal(mover.row, 4, 'the mover should stay on its current row when no documented advance tile is open');
  assert.equal(mover.col, 2, 'the mover should stay in place instead of sidestepping laterally on the current row');
});

test('battle-line movement does not sidestep away from the nearest enemy when that lane is blocked', () => {
  const battleSystem = makeIdleBattleSystem();
  const mover = mkUnit(UNIT_MAP.earth_golem, 2, 2, false);
  const nearerRightEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 3, true);
  const fartherLeftEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);
  const rightBlocker = mkUnit(UNIT_MAP.earth_golem, 2, 3, false);

  battleSystem._playerUnits = [mover, rightBlocker];
  battleSystem._enemyUnits = [nearerRightEnemy, fartherLeftEnemy];

  battleSystem._moveTowardEnemy(mover, [nearerRightEnemy, fartherLeftEnemy]);

  assert.equal(mover.row, 2, 'a unit already on the battle line should remain on the battle line');
  assert.equal(mover.col, 2, 'a blocked nearest lane should not make the unit sidestep toward a different enemy column');
});

test('void leviathan abyssal devour heals the boss itself instead of a lower-health ally', () => {
  const battleSystem = makeIdleBattleSystem();
  const leviathan = mkUnit(UNIT_MAP.boss_void_leviathan, 0, 2, true);
  const alliedMinion = mkUnit(UNIT_MAP.fire_imp, 0, 1, true);
  const target = mkUnit(UNIT_MAP.earth_golem, 4, 2, false);

  leviathan.hp = 500;
  alliedMinion.hp = 10;

  battleSystem._playerUnits = [target];
  battleSystem._enemyUnits = [leviathan, alliedMinion];

  battleSystem._useAbility(leviathan, [target], [leviathan, alliedMinion]);

  assert.equal(leviathan.hp, 560, 'abyssal devour should heal the boss itself for the documented 60 HP');
  assert.equal(alliedMinion.hp, 10, 'abyssal devour should not redirect its self-heal to a lower-health ally');
});

test('ice guardian frozen wall slows enemies outside base attack range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const guardian = mkUnit(UNIT_MAP.ice_guardian, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 2, true);

  battleSystem._playerUnits = [guardian];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [guardian];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const slow = distantEnemy.statusEffects.find(effect => effect.type === 'slow');
  const shield = guardian.statusEffects.find(effect => effect.type === 'shield');

  assert.ok(slow, 'frozen wall should slow enemies even when they are outside the guardian\'s base attack range');
  assert.equal(slow.duration, 2, 'frozen wall slow should last 2 turns');
  assert.ok(shield, 'frozen wall should still shield the caster');
  assert.equal(shield.duration, 3, 'frozen wall shield should last 3 turns');
  assert.equal(shield.value, 15, 'frozen wall shield should grant the documented defense bonus');
  assert.equal(guardian.row, 4, 'ice guardian should cast frozen wall instead of moving when only a distant enemy is alive');
  assert.equal(guardian.abilityCooldown, UNIT_MAP.ice_guardian.ability.cooldown, 'frozen wall should consume the ability cooldown when cast');
});

test('arcane illusionist mirage hits and blinds enemies outside base attack range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const illusionist = mkUnit(UNIT_MAP.arcane_illusionist, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 2, true);

  battleSystem._playerUnits = [illusionist];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [illusionist];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const blind = distantEnemy.statusEffects.find(effect => effect.type === 'blind');

  assert.ok(blind, 'mirage should blind enemies even when they are outside the caster\'s base attack range');
  assert.equal(blind.duration, 2, 'mirage blind should last 2 turns');
  assert.ok(distantEnemy.hp < distantEnemy.maxHp, 'mirage should damage enemies outside base range because it targets all enemies');
  assert.equal(illusionist.row, 4, 'arcane illusionist should cast mirage instead of moving when only a distant enemy is alive');
  assert.equal(illusionist.abilityCooldown, UNIT_MAP.arcane_illusionist.ability.cooldown, 'mirage should consume the ability cooldown when cast');
});

test('lightning lord thunder storm hits enemies outside base attack range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const lord = mkUnit(UNIT_MAP.lightning_lord, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 2, true);

  battleSystem._playerUnits = [lord];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [lord];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  assert.ok(distantEnemy.hp < distantEnemy.maxHp, 'thunder storm should damage enemies even when they are outside the caster\'s base attack range');
  assert.equal(lord.row, 4, 'lightning lord should cast thunder storm instead of moving when only a distant enemy is alive');
  assert.equal(lord.abilityCooldown, UNIT_MAP.lightning_lord.ability.cooldown, 'thunder storm should consume the ability cooldown when cast');
});

test('ice empress blizzard hits and freezes enemies outside base attack range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const empress = mkUnit(UNIT_MAP.ice_empress, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 2, true);

  battleSystem._playerUnits = [empress];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [empress];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const freeze = distantEnemy.statusEffects.find(effect => effect.type === 'freeze');

  assert.ok(freeze, 'blizzard should freeze enemies even when they are outside the caster\'s base attack range');
  assert.ok(distantEnemy.hp < distantEnemy.maxHp, 'blizzard should damage enemies outside base range because it targets all enemies');
  assert.equal(empress.row, 4, 'ice empress should cast blizzard instead of moving when only a distant enemy is alive');
  assert.equal(empress.abilityCooldown, UNIT_MAP.ice_empress.ability.cooldown, 'blizzard should consume the ability cooldown when cast');
});

test('void blighter cursed wound hits and wounds enemies outside base attack range because it targets all enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const blighter = mkUnit(UNIT_MAP.void_blighter, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 2, true);

  battleSystem._playerUnits = [blighter];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [blighter];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const wound = distantEnemy.statusEffects.find(effect => effect.type === 'wound');

  assert.ok(wound, 'cursed wound should apply wound even when the enemy is outside the caster\'s base attack range');
  assert.equal(wound.duration, 3, 'cursed wound should apply the documented 3-turn wound');
  assert.ok(distantEnemy.hp < distantEnemy.maxHp, 'cursed wound should damage enemies outside base range because it targets all enemies');
  assert.equal(blighter.row, 4, 'void blighter should cast cursed wound instead of moving when only a distant enemy is alive');
  assert.equal(blighter.abilityCooldown, UNIT_MAP.void_blighter.ability.cooldown, 'cursed wound should consume the ability cooldown when cast');
});

test('blood imp frenzy bite hits twice and heals from total damage once at the end', () => {
  const battleSystem = makeIdleBattleSystem();
  const imp = mkUnit(UNIT_MAP.blood_imp, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);
  const hitDamages = [];

  imp.hp = 30;
  battleSystem._playerUnits = [imp];
  battleSystem._enemyUnits = [target];
  battleSystem.onUnitHit = (unit, dmg) => {
    if (unit === target && dmg > 0) hitDamages.push(dmg);
  };

  const perHitDamage = battleSystem._calcDamage(imp, target, 0.6);
  const totalDamage = perHitDamage * 2;
  const expectedHeal = Math.floor(Math.floor(totalDamage * 0.2) * battleSystem._healMod(imp));

  battleSystem._useAbility(imp, [target], [imp]);

  assert.deepEqual(hitDamages, [perHitDamage, perHitDamage], 'frenzy bite should deal two separate hits for logging and hit events');
  assert.equal(target.hp, target.maxHp - totalDamage, 'frenzy bite should deal two 0.6x hits to the same target');
  assert.equal(imp.hp, 30 + expectedHeal, 'frenzy bite should heal for 20 percent of total dealt damage after both hits');
});

test('crimson mage sanguine bolt heals self for 30 percent of dealt damage', () => {
  const battleSystem = makeIdleBattleSystem();
  const mage = mkUnit(UNIT_MAP.crimson_mage, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  mage.hp = 70;
  battleSystem._playerUnits = [mage];
  battleSystem._enemyUnits = [target];

  const expectedDamage = battleSystem._calcDamage(mage, target, 1.4);
  const expectedHeal = Math.floor(Math.floor(expectedDamage * 0.3) * battleSystem._healMod(mage));

  battleSystem._useAbility(mage, [target], [mage]);

  assert.equal(target.hp, target.maxHp - expectedDamage, 'sanguine bolt should use the documented 1.4x single-target damage');
  assert.equal(mage.hp, 70 + expectedHeal, 'sanguine bolt should heal self for 30 percent of dealt damage');
});

test('blood lord crimson tide cleaves up to 3 enemies and heals from total damage', () => {
  const battleSystem = makeIdleBattleSystem();
  const lord = mkUnit(UNIT_MAP.blood_lord, 2, 0, false);
  const targets = [
    mkUnit(UNIT_MAP.earth_golem, 2, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 1, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 2, true),
  ];

  lord.hp = 100;
  battleSystem._playerUnits = [lord];
  battleSystem._enemyUnits = targets;

  const totalDamage = targets.reduce((sum, target) => sum + battleSystem._calcDamage(lord, target, 0.9), 0);
  const expectedHeal = Math.floor(Math.floor(totalDamage * 0.25) * battleSystem._healMod(lord));

  battleSystem._useAbility(lord, targets, [lord]);

  for (const target of targets) {
    assert.ok(target.hp < target.maxHp, 'crimson tide should hit up to 3 targets in its cleave');
  }
  assert.equal(lord.hp, 100 + expectedHeal, 'crimson tide should heal for 25 percent of total damage across all struck targets');
});

test('plague rat infect applies the plague baseline poison after its immediate hit', () => {
  const battleSystem = makeIdleBattleSystem();
  const rat = mkUnit(UNIT_MAP.plague_rat, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [rat];
  battleSystem._enemyUnits = [target];

  const expectedDamage = battleSystem._calcDamage(rat, target, 0.8);
  const expectedPoisonTick = poisonTickFromMaxHp(target);

  battleSystem._useAbility(rat, [target], [rat]);

  const poison = target.statusEffects.find(effect => effect.type === 'poison');
  assert.equal(target.hp, target.maxHp - expectedDamage, 'infect should deal the documented 0.8x immediate hit');
  assert.ok(poison, 'infect should apply poison');
  assert.equal(poison.duration, 3, 'infect poison should last 3 turns');
  assert.equal(poison.value, expectedPoisonTick, 'infect poison should tick for 5 percent of target max HP');

  const hpAfterAbility = target.hp;
  battleSystem._tickStatus(target);
  assert.equal(target.hp, hpAfterAbility - expectedPoisonTick, 'infect poison should tick for the configured plague baseline damage');
});

test('blight weaver miasma hits the 2 closest enemies in range and applies custom poison plus weaken', () => {
  const battleSystem = makeIdleBattleSystem();
  const weaver = mkUnit(UNIT_MAP.blight_weaver, 4, 2, false);
  const farEnemy = mkUnit(UNIT_MAP.fire_imp, 1, 5, true);
  const midEnemy = mkUnit(UNIT_MAP.earth_golem, 1, 2, true);
  const nearEnemy = mkUnit(UNIT_MAP.fire_imp, 2, 2, true);

  battleSystem._playerUnits = [weaver];
  battleSystem._enemyUnits = [farEnemy, midEnemy, nearEnemy];

  battleSystem._useAbility(weaver, [farEnemy, midEnemy, nearEnemy], [weaver]);

  const nearPoison = nearEnemy.statusEffects.find(effect => effect.type === 'poison');
  const nearWeaken = nearEnemy.statusEffects.find(effect => effect.type === 'weaken');
  const midPoison = midEnemy.statusEffects.find(effect => effect.type === 'poison');
  const midWeaken = midEnemy.statusEffects.find(effect => effect.type === 'weaken');

  assert.ok(nearPoison && nearWeaken, 'miasma should affect the nearest in-range target');
  assert.ok(midPoison && midWeaken, 'miasma should affect the second-closest in-range target');
  assert.equal(farEnemy.statusEffects.length, 0, 'miasma should not waste one of its two targets on a farther enemy when two closer ones exist');
  assert.equal(nearPoison.value, poisonTickFromMaxHp(nearEnemy), 'miasma poison should use the plague baseline damage');
  assert.equal(midPoison.value, poisonTickFromMaxHp(midEnemy), 'miasma poison should use the plague baseline damage on each target');
  assert.equal(nearWeaken.duration, 2, 'miasma weaken should last 2 turns');
  assert.equal(battleSystem._calcAttackPower(nearEnemy), nearEnemy.stats.attack * 0.8, 'miasma weaken should reduce damage output by 20 percent');
});

test('plague sovereign pandemic hits the full enemy roster and applies plague baseline poison', () => {
  const battleSystem = makeIdleBattleSystem();
  const sovereign = mkUnit(UNIT_MAP.plague_sovereign, 4, 2, false);
  const distantEnemy = mkUnit(UNIT_MAP.earth_golem, 0, 2, true);
  const nearEnemy = mkUnit(UNIT_MAP.fire_imp, 2, 2, true);

  battleSystem._playerUnits = [sovereign];
  battleSystem._enemyUnits = [distantEnemy, nearEnemy];
  battleSystem._actionQueue = [sovereign];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const distantPoison = distantEnemy.statusEffects.find(effect => effect.type === 'poison');
  const nearPoison = nearEnemy.statusEffects.find(effect => effect.type === 'poison');

  assert.ok(distantPoison, 'pandemic should reach enemies outside base range because it targets the full enemy roster');
  assert.ok(nearPoison, 'pandemic should still hit enemies already in range');
  assert.equal(distantPoison.value, poisonTickFromMaxHp(distantEnemy), 'pandemic poison should use the plague baseline damage on distant enemies');
  assert.equal(nearPoison.value, poisonTickFromMaxHp(nearEnemy), 'pandemic poison should use the plague baseline damage on nearby enemies');
  assert.ok(distantEnemy.hp < distantEnemy.maxHp && nearEnemy.hp < nearEnemy.maxHp, 'pandemic should also deal its documented 0.6x immediate damage to all enemies');
});

test('void leviathan abyssal devour deals true percent-max-hp damage and applies custom wound plus weaken', () => {
  const battleSystem = makeIdleBattleSystem();
  const leviathan = mkUnit(UNIT_MAP.boss_void_leviathan, 0, 2, true);
  const target = mkUnit(UNIT_MAP.earth_golem, 4, 2, false);

  leviathan.hp = 500;
  battleSystem._playerUnits = [target];
  battleSystem._enemyUnits = [leviathan];

  const expectedDamage = Math.max(1, Math.floor(target.maxHp * 0.15));

  battleSystem._useAbility(leviathan, [target], [leviathan]);

  const wound = target.statusEffects.find(effect => effect.type === 'wound');
  const weaken = target.statusEffects.find(effect => effect.type === 'weaken');

  assert.equal(target.hp, target.maxHp - expectedDamage, 'abyssal devour should deal 15 percent of target max HP as true damage');
  assert.ok(wound, 'abyssal devour should apply wound');
  assert.ok(weaken, 'abyssal devour should apply weaken');
  assert.equal(wound.duration, 2, 'abyssal devour wound should last 2 turns');
  assert.equal(weaken.duration, 2, 'abyssal devour weaken should last 2 turns');
  assert.equal(battleSystem._healMod(target), 0.8, 'abyssal devour wound should reduce healing received by 20 percent');
  assert.equal(battleSystem._calcAttackPower(target), target.stats.attack * 0.8, 'abyssal devour weaken should reduce damage output by 20 percent');
  assert.equal(leviathan.hp, 560, 'abyssal devour should still heal the boss for 60 HP on a successful hit');
});

test('void architect reality tear damages all enemies and applies blind plus plague baseline poison', () => {
  const battleSystem = makeIdleBattleSystem();
  const architect = mkUnit(UNIT_MAP.boss_void_architect, 0, 2, false);
  const targetA = mkUnit(UNIT_MAP.earth_golem, 4, 2, true);
  const targetB = mkUnit(UNIT_MAP.fire_imp, 3, 1, true);

  battleSystem._playerUnits = [architect];
  battleSystem._enemyUnits = [targetA, targetB];

  const expectedDamageA = battleSystem._calcDamage(architect, targetA, 1.0);
  const expectedDamageB = battleSystem._calcDamage(architect, targetB, 1.0);

  battleSystem._useAbility(architect, [targetA, targetB], [architect]);

  const blindA = targetA.statusEffects.find(effect => effect.type === 'blind');
  const blindB = targetB.statusEffects.find(effect => effect.type === 'blind');
  const poisonA = targetA.statusEffects.find(effect => effect.type === 'poison');
  const poisonB = targetB.statusEffects.find(effect => effect.type === 'poison');

  assert.equal(targetA.hp, targetA.maxHp - expectedDamageA, 'reality tear should use the clarified 1.0x damage on all enemies');
  assert.equal(targetB.hp, targetB.maxHp - expectedDamageB, 'reality tear should damage every enemy on the board');
  assert.ok(blindA && blindB, 'reality tear should blind all enemies for 2 turns');
  assert.equal(blindA.duration, 2, 'reality tear blind should last 2 turns');
  assert.ok(poisonA && poisonB, 'reality tear should poison all enemies');
  assert.equal(poisonA.value, poisonTickFromMaxHp(targetA), 'reality tear poison should use the plague baseline damage');
  assert.equal(poisonB.value, poisonTickFromMaxHp(targetB), 'reality tear poison should use the plague baseline damage on each target');
});