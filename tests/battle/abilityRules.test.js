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

test('frost fairy heals the ally with the lowest absolute HP, not the lowest HP ratio', () => {
  const battleSystem = makeIdleBattleSystem();
  const healer = mkUnit(UNIT_MAP.frost_fairy, 4, 0, false);
  const lowAbsoluteHpAlly = mkUnit(UNIT_MAP.frost_fairy, 4, 1, false);
  const lowRatioAlly = mkUnit(UNIT_MAP.earth_golem, 4, 2, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);

  lowAbsoluteHpAlly.hp = 60;
  lowRatioAlly.hp = 80;

  battleSystem._playerUnits = [healer, lowAbsoluteHpAlly, lowRatioAlly];
  battleSystem._enemyUnits = [enemy];
  battleSystem._actionQueue = [healer];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  assert.equal(lowAbsoluteHpAlly.hp, 70, 'healing frost should target the ally with the lowest current HP total');
  assert.equal(lowRatioAlly.hp, 80, 'healing frost should not redirect to a bulkier ally just because its HP ratio is lower');
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

test('earth golem casts stone skin without an enemy in attack range because it targets self', () => {
  const battleSystem = makeIdleBattleSystem();
  const golem = mkUnit(UNIT_MAP.earth_golem, 4, 0, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);

  battleSystem._playerUnits = [golem];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [golem];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const shield = golem.statusEffects.find(effect => effect.type === 'shield');

  assert.ok(shield, 'stone skin should cast on self even when no enemy is in attack range');
  assert.equal(shield.duration, 2, 'stone skin shield should last 2 turns');
  assert.equal(shield.value, 15, 'stone skin should grant the documented defense bonus');
  assert.equal(golem.row, 4, 'earth golem should cast stone skin instead of moving when its self-buff is ready');
  assert.equal(golem.abilityCooldown, UNIT_MAP.earth_golem.ability.cooldown, 'stone skin should consume the ability cooldown when cast');
});

test('lightning sprite chain lightning damages up to 3 enemies', () => {
  const battleSystem = makeIdleBattleSystem();
  const sprite = mkUnit(UNIT_MAP.lightning_sprite, 2, 0, false);
  const targets = [
    mkUnit(UNIT_MAP.earth_golem, 2, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 1, true),
    mkUnit(UNIT_MAP.earth_golem, 1, 2, true),
    mkUnit(UNIT_MAP.earth_golem, 3, 3, true),
  ];

  battleSystem._playerUnits = [sprite];
  battleSystem._enemyUnits = targets;

  const expectedDamage = battleSystem._calcDamage(sprite, targets[0], 1.4);

  battleSystem._useAbility(sprite, targets, [sprite]);

  const damagedTargets = targets.filter(target => target.hp < target.maxHp);
  const untouchedTargets = targets.filter(target => target.hp === target.maxHp);

  assert.equal(damagedTargets.length, 3, 'chain lightning should only damage up to 3 targets');
  assert.equal(untouchedTargets.length, 1, 'chain lightning should leave one enemy untouched when more than 3 are available');
  assert.ok(damagedTargets.every(target => target.hp === target.maxHp - expectedDamage), 'each chained target should take the documented 1.4x lightning hit');
});

test('void shade stays untargetable through the enemy targeting step after shadow phase', () => {
  const battleSystem = makeIdleBattleSystem();
  const shade = mkUnit(UNIT_MAP.void_shade, 2, 0, false);
  const ally = mkUnit(UNIT_MAP.earth_golem, 2, 1, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 2, 0, true);

  battleSystem._playerUnits = [shade, ally];
  battleSystem._enemyUnits = [enemy];
  battleSystem._actionQueue = [shade];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const untargetable = shade.statusEffects.find(effect => effect.type === 'untargetable');
  const chosenTarget = battleSystem._pickTarget(enemy, [shade, ally]);

  assert.ok(untargetable, 'shadow phase should make the caster untargetable');
  assert.equal(untargetable.duration, 1, 'shadow phase untargetable should remain active after the cast turn');
  assert.equal(chosenTarget, ally, 'enemy targeting should skip the untargetable shade while the effect is active');
});

test('blood sprite drain touch heals for the documented 40 percent lifesteal', () => {
  const battleSystem = makeIdleBattleSystem();
  const sprite = mkUnit(UNIT_MAP.blood_sprite, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  sprite.hp = 40;
  battleSystem._playerUnits = [sprite];
  battleSystem._enemyUnits = [target];

  const expectedDamage = battleSystem._calcDamage(sprite, target, 1.4);
  const expectedHeal = Math.floor(Math.floor(expectedDamage * 0.4) * battleSystem._healMod(sprite));

  battleSystem._useAbility(sprite, [target], [sprite]);

  assert.equal(sprite.hp, 40 + expectedHeal, 'drain touch should heal for 40 percent of dealt damage');
});

test('arcane pupil evolve buffs base attack and defense every 3 turns up to 3 stacks', () => {
  const battleSystem = makeIdleBattleSystem();
  const pupil = mkUnit(UNIT_MAP.arcane_pupil, 4, 0, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);
  const baseAttack = pupil.stats.attack;
  const baseDefense = pupil.stats.defense;

  battleSystem._playerUnits = [pupil];
  battleSystem._enemyUnits = [enemy];

  for (let turn = 1; turn <= 10; turn++) {
    battleSystem._actionQueue = [pupil];
    battleSystem._actionIndex = 0;
    battleSystem._processNextAction();

    if (turn === 2) {
      assert.equal(pupil._evolveStacks || 0, 0, 'evolve should not trigger before the third survived turn');
      assert.equal(pupil.stats.attack, baseAttack, 'attack should stay at base before evolve triggers');
      assert.equal(pupil.stats.defense, baseDefense, 'defense should stay at base before evolve triggers');
    }
    if (turn === 3) {
      assert.equal(pupil._evolveStacks, 1, 'evolve should gain the first stack on turn 3');
      assert.equal(pupil.stats.attack, Math.floor(baseAttack * 1.1), 'the first evolve stack should grant 10 percent attack');
      assert.equal(pupil.stats.defense, Math.floor(baseDefense * 1.1), 'the first evolve stack should grant 10 percent defense');
    }
    if (turn === 6) {
      assert.equal(pupil._evolveStacks, 2, 'evolve should gain the second stack on turn 6');
      assert.equal(pupil.stats.attack, Math.floor(baseAttack * 1.2), 'the second evolve stack should total 20 percent attack');
      assert.equal(pupil.stats.defense, Math.floor(baseDefense * 1.2), 'the second evolve stack should total 20 percent defense');
    }
    if (turn === 9) {
      assert.equal(pupil._evolveStacks, 3, 'evolve should gain the third stack on turn 9');
      assert.equal(pupil.stats.attack, Math.floor(baseAttack * 1.3), 'the third evolve stack should total 30 percent attack');
      assert.equal(pupil.stats.defense, Math.floor(baseDefense * 1.3), 'the third evolve stack should total 30 percent defense');
    }
  }

  assert.equal(pupil._evolveStacks, 3, 'evolve should stop at the configured 3-stack cap');
  assert.equal(pupil.stats.attack, Math.floor(baseAttack * 1.3), 'attack should stay pinned to the capped evolve bonus');
  assert.equal(pupil.stats.defense, Math.floor(baseDefense * 1.3), 'defense should stay pinned to the capped evolve bonus');
});

test('arcane assassin shadow strike uses the 2.5x crit branch and emits the crit callback when RNG is below 0.5', () => {
  const battleSystem = makeIdleBattleSystem();
  const assassin = mkUnit(UNIT_MAP.arcane_assassin, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);
  const critHits = [];

  battleSystem._playerUnits = [assassin];
  battleSystem._enemyUnits = [target];
  battleSystem._rng = () => 0.1;
  battleSystem.onCriticalHit = (attacker, victim) => critHits.push({ attacker, victim });

  const expectedDamage = battleSystem._calcDamage(assassin, target, 2.5);

  battleSystem._useAbility(assassin, [target], [assassin]);

  assert.equal(target.hp, target.maxHp - expectedDamage, 'shadow strike should use the documented 2.5x crit multiplier when RNG is below 0.5');
  assert.equal(critHits.length, 1, 'shadow strike should emit the crit callback when the crit branch triggers');
  assert.equal(critHits[0].attacker, assassin, 'the crit callback should identify the assassin as the attacker');
  assert.equal(critHits[0].victim, target, 'the crit callback should identify the struck target');
});

test('arcane assassin shadow strike uses the 1.5x non-crit branch and skips the crit callback when RNG is 0.5 or higher', () => {
  const battleSystem = makeIdleBattleSystem();
  const assassin = mkUnit(UNIT_MAP.arcane_assassin, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);
  let critCount = 0;

  battleSystem._playerUnits = [assassin];
  battleSystem._enemyUnits = [target];
  battleSystem._rng = () => 0.9;
  battleSystem.onCriticalHit = () => { critCount++; };

  const expectedDamage = battleSystem._calcDamage(assassin, target, 1.5);

  battleSystem._useAbility(assassin, [target], [assassin]);

  assert.equal(target.hp, target.maxHp - expectedDamage, 'shadow strike should use the documented 1.5x non-crit multiplier when RNG is 0.5 or higher');
  assert.equal(critCount, 0, 'shadow strike should not emit the crit callback on the non-crit branch');
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

test('fire warrior blazing charge reaches distant enemies in the same column', () => {
  const battleSystem = makeIdleBattleSystem();
  const caster = mkUnit(UNIT_MAP.fire_warrior, 4, 0, false);
  const distantColumnTarget = mkUnit(UNIT_MAP.earth_golem, 0, 0, true);

  battleSystem._playerUnits = [caster];
  battleSystem._enemyUnits = [distantColumnTarget];
  battleSystem._actionQueue = [caster];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const burn = distantColumnTarget.statusEffects.find(effect => effect.type === 'burn');

  assert.ok(burn, 'blazing charge should burn same-column enemies even when they start outside base attack range');
  assert.equal(burn.duration, 3, 'blazing charge burn should last 3 turns');
  assert.equal(burn.value, 3, 'blazing charge burn should tick for 3 damage');
  assert.ok(distantColumnTarget.hp < distantColumnTarget.maxHp, 'blazing charge should damage same-column enemies across the lane');
  assert.equal(caster.row, 4, 'fire warrior should cast blazing charge instead of moving when a same-column enemy is alive farther up the lane');
  assert.equal(caster.abilityCooldown, UNIT_MAP.fire_warrior.ability.cooldown, 'blazing charge should consume the ability cooldown when it casts across the lane');
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

test('nature spirit rejuvenate heals all living allies for the documented amount', () => {
  const battleSystem = makeIdleBattleSystem();
  const spirit = mkUnit(UNIT_MAP.nature_spirit, 4, 0, false);
  const allyA = mkUnit(UNIT_MAP.earth_golem, 4, 1, false);
  const allyB = mkUnit(UNIT_MAP.fire_warrior, 3, 0, false);
  const fallenAlly = mkUnit(UNIT_MAP.fire_imp, 3, 1, false);

  spirit.hp = 90;
  allyA.hp = 100;
  allyB.hp = 150;
  fallenAlly.hp = 0;
  battleSystem._playerUnits = [spirit, allyA, allyB, fallenAlly];
  battleSystem._enemyUnits = [mkUnit(UNIT_MAP.fire_imp, 0, 0, true)];

  battleSystem._useAbility(spirit, battleSystem._enemyUnits, battleSystem._playerUnits);

  assert.equal(spirit.hp, 105, 'rejuvenate should also heal the caster when it is injured');
  assert.equal(allyA.hp, 115, 'rejuvenate should heal each living ally for 15 HP');
  assert.equal(allyB.hp, 165, 'rejuvenate should heal every living ally in the team-wide pulse');
  assert.equal(fallenAlly.hp, 0, 'rejuvenate should not revive defeated allies');
});

test('single-target abilities still respect same-column targeting priority even when enemy order is scrambled', () => {
  const battleSystem = makeIdleBattleSystem();
  const mage = mkUnit(UNIT_MAP.arcane_mage, 3, 0, false);
  const offColumnLowHpEnemy = mkUnit(UNIT_MAP.fire_imp, 2, 1, true);
  const sameColumnEnemy = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  offColumnLowHpEnemy.hp = 20;
  sameColumnEnemy.hp = 140;
  battleSystem._playerUnits = [mage];
  battleSystem._enemyUnits = [offColumnLowHpEnemy, sameColumnEnemy];
  battleSystem._actionQueue = [mage];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  assert.ok(sameColumnEnemy.hp < 140, 'single-target abilities should prefer an in-lane enemy over a lower-HP enemy in another column');
  assert.equal(offColumnLowHpEnemy.hp, 20, 'single-target abilities should not just hit the first enemy in array order');
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

test('life guardian still casts guardian\'s blessing at full HP so barrier is applied', () => {
  const battleSystem = makeIdleBattleSystem();
  const guardian = mkUnit(UNIT_MAP.life_guardian, 2, 0, false);
  const ally = mkUnit(UNIT_MAP.earth_golem, 3, 1, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 2, 0, true);

  battleSystem._playerUnits = [guardian, ally];
  battleSystem._enemyUnits = [enemy];
  battleSystem._actionQueue = [guardian];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const guardianBarrier = guardian.statusEffects.find(effect => effect.type === 'barrier');
  const allyBarrier = ally.statusEffects.find(effect => effect.type === 'barrier');

  assert.ok(guardianBarrier && allyBarrier, 'guardian\'s blessing should still apply barrier to all allies even when no heal is needed');
  assert.equal(guardian.abilityCooldown, UNIT_MAP.life_guardian.ability.cooldown, 'guardian\'s blessing should consume the ability cooldown when it casts for barrier');
  assert.equal(enemy.hp, enemy.maxHp, 'life guardian should cast the support ability instead of basic attacking when barrier is the relevant effect');
});

test('arcane priest prefers the ally missing shield coverage when everyone is at full HP', () => {
  const battleSystem = makeIdleBattleSystem();
  const priest = mkUnit(UNIT_MAP.arcane_priest, 4, 0, false);
  const alreadyShieldedAlly = mkUnit(UNIT_MAP.earth_golem, 3, 1, false);
  const unshieldedAlly = mkUnit(UNIT_MAP.fire_imp, 2, 1, false);
  const distantEnemy = mkUnit(UNIT_MAP.earth_golem, 0, 0, true);

  priest.statusEffects.push({ type: 'shield', duration: 2, value: 10 });
  alreadyShieldedAlly.statusEffects.push({ type: 'shield', duration: 2, value: 10 });

  battleSystem._playerUnits = [priest, alreadyShieldedAlly, unshieldedAlly];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [priest];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const shieldEffects = unshieldedAlly.statusEffects.filter(effect => effect.type === 'shield');

  assert.ok(shieldEffects.length > 0, 'arcane priest should shield the ally that is still missing shield coverage');
  assert.equal(priest.abilityCooldown, UNIT_MAP.arcane_priest.ability.cooldown, 'arcane restoration should consume the ability cooldown when it casts for shield coverage');
  assert.equal(distantEnemy.hp, distantEnemy.maxHp, 'arcane priest should use the support ability instead of basic attacking when shield coverage is the relevant effect');
});

test('arcane priest heals and shields the injured ally with the lowest absolute HP', () => {
  const battleSystem = makeIdleBattleSystem();
  const priest = mkUnit(UNIT_MAP.arcane_priest, 4, 0, false);
  const lowAbsoluteHpAlly = mkUnit(UNIT_MAP.arcane_priest, 4, 1, false);
  const lowRatioAlly = mkUnit(UNIT_MAP.earth_golem, 3, 1, false);
  const distantEnemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);

  lowAbsoluteHpAlly.hp = 60;
  lowRatioAlly.hp = 80;

  battleSystem._playerUnits = [priest, lowAbsoluteHpAlly, lowRatioAlly];
  battleSystem._enemyUnits = [distantEnemy];
  battleSystem._actionQueue = [priest];
  battleSystem._actionIndex = 0;

  battleSystem._processNextAction();

  const lowAbsoluteHpShield = lowAbsoluteHpAlly.statusEffects.find(effect => effect.type === 'shield');
  const lowRatioShield = lowRatioAlly.statusEffects.find(effect => effect.type === 'shield');

  assert.equal(lowAbsoluteHpAlly.hp, 85, 'arcane restoration should heal the injured ally with the lowest current HP total');
  assert.equal(lowRatioAlly.hp, 80, 'arcane restoration should not redirect to a bulkier ally just because its HP ratio is lower');
  assert.ok(lowAbsoluteHpShield, 'arcane restoration should shield the ally it healed');
  assert.equal(lowAbsoluteHpShield.duration, 2, 'arcane restoration shield should last 2 turns');
  assert.equal(lowAbsoluteHpShield.value, 10, 'arcane restoration shield should grant the documented defense bonus');
  assert.equal(lowRatioShield, undefined, 'arcane restoration should not shield the non-selected injured ally');
});

test('flame tyrant ability text matches the clarified burn rules', () => {
  const description = UNIT_MAP.boss_flame_tyrant.ability.description.toLowerCase();
  assert.match(description, /0\.6x/, 'tyrant\'s wrath text should mention its clarified damage multiplier');
  assert.match(description, /all enemies/, 'tyrant\'s wrath text should keep its full-team coverage explicit');
  assert.match(description, /3 turns/, 'tyrant\'s wrath text should mention the documented burn duration');
  assert.match(description, /5 dmg/, 'tyrant\'s wrath text should mention the documented burn tick value');
});

test('frost colossus ability text mentions the damage applied by absolute zero', () => {
  const description = UNIT_MAP.boss_frost_colossus.ability.description.toLowerCase();
  assert.match(description, /0\.3x/, 'absolute zero text should mention its clarified damage multiplier');
  assert.match(description, /2 turns/, 'absolute zero text should mention the freeze duration');
  assert.match(description, /80 hp/, 'absolute zero text should mention the self-heal value');
});

test('void supreme ability text mentions the shielded enrage applied by void cataclysm', () => {
  const description = UNIT_MAP.boss_chaos_overlord.ability.description.toLowerCase();
  assert.match(description, /0\.4x/, 'void cataclysm text should mention its clarified damage multiplier');
  assert.match(description, /shield/, 'void cataclysm text should mention the shield granted at low HP');
  assert.match(description, /\+20 def/, 'void cataclysm text should mention the shield value');
  assert.match(description, /1 turn/, 'void cataclysm text should mention the shield duration');
  assert.match(description, /all enemies/, 'void cataclysm text should mention its all-enemies AoE coverage');
});

test('void leviathan ability text mentions wound and weaken from abyssal devour', () => {
  const description = UNIT_MAP.boss_void_leviathan.ability.description.toLowerCase();
  assert.match(description, /15% target max hp/, 'abyssal devour text should mention its clarified true-damage rule');
  assert.match(description, /wound/, 'abyssal devour text should mention the wound effect');
  assert.match(description, /20%/, 'abyssal devour text should mention the wound and weaken strength');
  assert.match(description, /2 turns/, 'abyssal devour text should mention the debuff duration');
  assert.match(description, /weaken/, 'abyssal devour text should mention the weaken effect');
  assert.match(description, /60 hp/, 'abyssal devour text should mention the self-heal value');
});

test('void architect ability text mentions void damage to all enemies', () => {
  const description = UNIT_MAP.boss_void_architect.ability.description.toLowerCase();
  assert.match(description, /void damage/, 'reality tear text should mention the damage type');
  assert.match(description, /all enemies/, 'reality tear text should mention its all-enemies coverage');
  assert.match(description, /2 turns/, 'reality tear text should mention the blind duration');
});

test('tier 3 damage-caster text matches the clarified design summaries', () => {
  assert.match(UNIT_MAP.fire_demon.ability.description.toLowerCase(), /burn/, 'hellfire text should mention its burn effect');
  assert.match(UNIT_MAP.martial_master.ability.description.toLowerCase(), /0\.4x x4/, 'thousand fists text should mention the four rapid hits');
  assert.match(UNIT_MAP.lightning_lord.ability.description.toLowerCase(), /0\.7x/, 'thunder storm text should mention its clarified damage multiplier');
  assert.match(UNIT_MAP.ice_empress.ability.description.toLowerCase(), /freeze/, 'blizzard text should mention its freeze effect');
  assert.match(UNIT_MAP.void_horror.ability.description.toLowerCase(), /ignores defense/, 'void rupture text should mention its defense-ignoring damage');
  assert.match(UNIT_MAP.arcane_illusionist.ability.description.toLowerCase(), /2 turns/, 'mirage text should mention the documented blind duration');
});

test('fire ravager text mentions the clarified rampage targeting and kill-stack rules', () => {
  const description = UNIT_MAP.fire_ravager.ability.description.toLowerCase();
  assert.match(description, /1\.5x/, 'rampage text should mention its clarified damage multiplier');
  assert.match(description, /up to 2 targets/, 'rampage text should mention its two-target cleave limit');
  assert.match(description, /max \+50%/, 'rampage text should mention the kill-stack cap');
});

test('life guardian text makes the full-team barrier explicit', () => {
  const description = UNIT_MAP.life_guardian.ability.description.toLowerCase();
  assert.match(description, /all allies/, 'guardian\'s blessing text should keep the full-team heal wording');
  assert.match(description, /barrier to all allies/, 'guardian\'s blessing text should make the barrier coverage explicit');
});

test('arcane restoration and miasma text match the clarified support and plague rules', () => {
  const priestDescription = UNIT_MAP.arcane_priest.ability.description.toLowerCase();
  assert.match(priestDescription, /25 hp/, 'arcane restoration text should mention its heal value');
  assert.match(priestDescription, /shield/, 'arcane restoration text should mention its shield effect');
  assert.match(priestDescription, /\+10 def/, 'arcane restoration text should mention the shield value');
  assert.match(priestDescription, /2 turns/, 'arcane restoration text should mention the shield duration');

  const miasmaDescription = UNIT_MAP.blight_weaver.ability.description.toLowerCase();
  assert.match(miasmaDescription, /0\.7x/, 'miasma text should mention its clarified damage multiplier');
  assert.match(miasmaDescription, /2 closest/, 'miasma text should keep its target cap explicit');
  assert.match(miasmaDescription, /3 turns/, 'miasma text should mention the documented poison duration');
  assert.match(miasmaDescription, /5% max hp\/tick/, 'miasma text should mention the documented poison tick rule');
  assert.match(miasmaDescription, /20% weaken/, 'miasma text should mention the weaken amount');
  assert.match(miasmaDescription, /2 turns/, 'miasma text should mention the weaken duration');
});

test('arcane pupil and arcane assassin text match the clarified arcane rules', () => {
  const pupilDescription = UNIT_MAP.arcane_pupil.ability.description.toLowerCase();
  assert.match(pupilDescription, /1\.3x/, 'arcane bolt text should mention its clarified damage multiplier');
  assert.match(pupilDescription, /max 3 stacks/, 'arcane bolt text should mention the evolve stack cap');

  const assassinDescription = UNIT_MAP.arcane_assassin.ability.description.toLowerCase();
  assert.match(assassinDescription, /50% chance/, 'shadow strike text should mention the crit chance');
  assert.match(assassinDescription, /2\.5x/, 'shadow strike text should mention the crit damage multiplier');
});

test('toxic dart, frost arrow, and corruption strike text match the clarified combat rules', () => {
  const scoutDescription = UNIT_MAP.konji_scout.ability.description.toLowerCase();
  assert.match(scoutDescription, /1\.4x/, 'toxic dart text should mention its clarified damage multiplier');
  assert.match(scoutDescription, /8 dmg\/tick/, 'toxic dart text should mention its poison tick value');

  const archerDescription = UNIT_MAP.ice_archer.ability.description.toLowerCase();
  assert.match(archerDescription, /1\.2x/, 'frost arrow text should mention its clarified damage multiplier');
  assert.match(archerDescription, /1 turn/, 'frost arrow text should mention the freeze duration');

  const knightDescription = UNIT_MAP.void_knight.ability.description.toLowerCase();
  assert.match(knightDescription, /1\.4x/, 'corruption strike text should mention its clarified damage multiplier');
  assert.match(knightDescription, /2 turns/, 'corruption strike text should mention the weaken duration');
});

test('crimson cleave and plague cloud text match the clarified blood and plague rules', () => {
  const knightDescription = UNIT_MAP.blood_knight.ability.description.toLowerCase();
  assert.match(knightDescription, /1\.2x/, 'crimson cleave text should mention its clarified damage multiplier');
  assert.match(knightDescription, /up to 3 enemies/, 'crimson cleave text should mention its target cap');

  const shamanDescription = UNIT_MAP.konji_shaman.ability.description.toLowerCase();
  assert.match(shamanDescription, /0\.3x/, 'plague cloud text should mention its clarified damage multiplier');
  assert.match(shamanDescription, /8 dmg/, 'plague cloud text should mention its poison tick value');
});

test('chain lightning text matches the clarified lightning sprite rules', () => {
  const description = UNIT_MAP.lightning_sprite.ability.description.toLowerCase();
  assert.match(description, /1\.4x/, 'chain lightning text should mention its clarified damage multiplier');
  assert.match(description, /3 targets/, 'chain lightning text should mention its total bounce coverage');
});

test('stone skin text matches the clarified earth golem shield rules', () => {
  const description = UNIT_MAP.earth_golem.ability.description.toLowerCase();
  assert.match(description, /\+15 def/, 'stone skin text should mention the documented shield value');
  assert.match(description, /2 turns/, 'stone skin text should mention the shield duration');
});

test('economy upgrade text makes the implemented caps and floors explicit', () => {
  const bargainHunterDescription = UPGRADES.find(upgrade => upgrade.id === 'bargain_hunter')?.description.toLowerCase() || '';
  assert.match(bargainHunterDescription, /-1/, 'hovs handouts text should mention the per-level refresh discount');
  assert.match(bargainHunterDescription, /min 0g/, 'hovs handouts text should mention the documented free-refresh floor');

  const warChestDescription = UPGRADES.find(upgrade => upgrade.id === 'war_chest')?.description.toLowerCase() || '';
  assert.match(warChestDescription, /10%/, 'war chest text should mention the per-level interest rate');
  assert.match(warChestDescription, /max 5g/, 'war chest text should mention the documented interest cap');

  const fieldMedicDescription = UPGRADES.find(upgrade => upgrade.id === 'field_medic')?.description.toLowerCase() || '';
  assert.match(fieldMedicDescription, /15%/, 'field medic text should mention the per-level healing increase');
  assert.match(fieldMedicDescription, /base 25%/, 'field medic text should mention the documented base post-battle healing');

  const refreshMasterDescription = UPGRADES.find(upgrade => upgrade.id === 'refresh_master')?.description.toLowerCase() || '';
  assert.match(refreshMasterDescription, /\+1 refresh/, 'refresh master text should mention the per-level refresh gain');
  assert.match(refreshMasterDescription, /base 1/, 'refresh master text should mention the documented base refresh count');
  assert.match(refreshMasterDescription, /max 3/, 'refresh master text should mention the documented total refresh cap');
});

test('remaining status-heavy unit text keeps clarified durations and values explicit', () => {
  const blazingChargeDescription = UNIT_MAP.fire_warrior.ability.description.toLowerCase();
  assert.match(blazingChargeDescription, /same column/, 'blazing charge text should keep its column-only targeting explicit');
  assert.match(blazingChargeDescription, /3 turns/, 'blazing charge text should mention the documented burn duration');
  assert.match(blazingChargeDescription, /3 dmg/, 'blazing charge text should mention the documented burn tick value');

  const frozenWallDescription = UNIT_MAP.ice_guardian.ability.description.toLowerCase();
  assert.match(frozenWallDescription, /\+15 def/, 'frozen wall text should mention its shield value');
  assert.match(frozenWallDescription, /3 turns/, 'frozen wall text should mention the self-shield duration');
  assert.match(frozenWallDescription, /2 turns/, 'frozen wall text should mention the slow duration');

  const hellfireDescription = UNIT_MAP.fire_demon.ability.description.toLowerCase();
  assert.match(hellfireDescription, /up to 3 enemies/, 'hellfire text should keep its target cap explicit');
  assert.match(hellfireDescription, /3 turns/, 'hellfire text should mention the documented burn duration');
  assert.match(hellfireDescription, /3 dmg/, 'hellfire text should mention the documented burn tick value');

  const blizzardDescription = UNIT_MAP.ice_empress.ability.description.toLowerCase();
  assert.match(blizzardDescription, /all enemies/, 'blizzard text should keep its full-team coverage explicit');
  assert.match(blizzardDescription, /1 turn/, 'blizzard text should mention the freeze duration');
});

test('crimson tide text makes the three-target cap explicit', () => {
  const description = UNIT_MAP.blood_lord.ability.description.toLowerCase();
  assert.match(description, /up to 3 enemies/, 'crimson tide text should mention the cleave target cap explicitly');
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

test('blind lasts for two basic attacks as documented', () => {
  const battleSystem = makeIdleBattleSystem();
  const blindedAttacker = mkUnit(UNIT_MAP.fire_imp, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  blindedAttacker.abilityCooldown = 99;
  battleSystem._rng = () => 0;
  battleSystem._playerUnits = [blindedAttacker];
  battleSystem._enemyUnits = [target];

  battleSystem._addStatus(blindedAttacker, 'blind', 2);

  battleSystem._actionQueue = [blindedAttacker];
  battleSystem._actionIndex = 0;
  battleSystem._processNextAction();

  assert.equal(target.hp, target.maxHp, 'the first blinded basic attack should miss');

  battleSystem._actionQueue = [blindedAttacker];
  battleSystem._actionIndex = 0;
  battleSystem._processNextAction();

  assert.equal(target.hp, target.maxHp, 'the second blinded basic attack should also miss');
  assert.equal(blindedAttacker.statusEffects.some(effect => effect.type === 'blind'), false, 'blind should wear off after the second missed attack');
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

test('void blighter cursed wound applies the default 50 percent wound and documents it', () => {
  const battleSystem = makeIdleBattleSystem();
  const blighter = mkUnit(UNIT_MAP.void_blighter, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [blighter];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(blighter, [target], [blighter]);

  const wound = target.statusEffects.find(effect => effect.type === 'wound');
  const description = UNIT_MAP.void_blighter.ability.description.toLowerCase();

  assert.ok(wound, 'cursed wound should apply wound');
  assert.equal(wound.duration, 3, 'cursed wound should last 3 turns');
  assert.equal(battleSystem._healMod(target), 0.5, 'cursed wound should use the default 50 percent healing reduction');
  assert.match(description, /50% wound/, 'cursed wound text should mention the implemented wound strength');
  assert.match(description, /3 turns/, 'cursed wound text should mention the wound duration');
});

test('absolute zero freeze skips two turns as documented', () => {
  const battleSystem = makeIdleBattleSystem();
  const colossus = mkUnit(UNIT_MAP.boss_frost_colossus, 0, 0, true);
  const target = mkUnit(UNIT_MAP.earth_golem, 4, 0, false);

  battleSystem._playerUnits = [target];
  battleSystem._enemyUnits = [colossus];

  battleSystem._useAbility(colossus, [target], [colossus]);

  let freeze = target.statusEffects.find(effect => effect.type === 'freeze');
  assert.ok(freeze, 'absolute zero should apply freeze');
  assert.equal(freeze.duration, 2, 'absolute zero should apply a 2-turn freeze');

  battleSystem._actionQueue = [target];
  battleSystem._actionIndex = 0;
  battleSystem._processNextAction();

  freeze = target.statusEffects.find(effect => effect.type === 'freeze');
  assert.ok(freeze, 'the first skipped turn should not consume the full 2-turn freeze');

  const rowAfterFirstSkip = target.row;
  const colAfterFirstSkip = target.col;

  battleSystem._actionQueue = [target];
  battleSystem._actionIndex = 0;
  battleSystem._processNextAction();

  assert.equal(target.row, rowAfterFirstSkip, 'the second frozen turn should also skip movement');
  assert.equal(target.col, colAfterFirstSkip, 'the second frozen turn should also skip action positioning changes');
  assert.equal(target.statusEffects.some(effect => effect.type === 'freeze'), false, 'freeze should wear off after the second skipped turn');
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

test('fire demon hellfire burns up to 3 enemies and leaves extra targets untouched', () => {
  const battleSystem = makeIdleBattleSystem();
  const demon = mkUnit(UNIT_MAP.fire_demon, 2, 0, false);
  const targets = [
    mkUnit(UNIT_MAP.earth_golem, 2, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 1, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 3, 0, true),
    mkUnit(UNIT_MAP.earth_golem, 2, 1, true),
  ];

  battleSystem._playerUnits = [demon];
  battleSystem._enemyUnits = targets;

  battleSystem._useAbility(demon, targets, [demon]);

  const burnedTargets = targets.filter(target => target.statusEffects.some(effect => effect.type === 'burn'));
  const untouchedTargets = targets.filter(target => target.hp === target.maxHp && target.statusEffects.length === 0);

  assert.equal(burnedTargets.length, 3, 'hellfire should only burn up to 3 enemies');
  assert.equal(untouchedTargets.length, 1, 'hellfire should leave one enemy untouched when more than 3 are in range');
  assert.ok(burnedTargets.every(target => target.hp < target.maxHp), 'hellfire should damage every enemy it burns');
  assert.ok(burnedTargets.every(target => target.statusEffects.find(effect => effect.type === 'burn')?.duration === 3), 'hellfire burn should last 3 turns on each struck target');
  assert.ok(burnedTargets.every(target => target.statusEffects.find(effect => effect.type === 'burn')?.value === 3), 'hellfire burn should tick for 3 damage on each struck target');
});

test('fire ravager kill-stack passive gains attack per kill and caps at 50 percent', () => {
  const battleSystem = makeIdleBattleSystem();
  const ravager = mkUnit(UNIT_MAP.fire_ravager, 2, 0, false);
  const weakSameLaneEnemy = mkUnit(UNIT_MAP.fire_imp, 2, 0, true);
  const weakOffLaneEnemy = mkUnit(UNIT_MAP.fire_imp, 2, 1, true);

  weakSameLaneEnemy.hp = 1;
  weakOffLaneEnemy.hp = 1;
  battleSystem._playerUnits = [ravager];
  battleSystem._enemyUnits = [weakSameLaneEnemy, weakOffLaneEnemy];

  battleSystem._useAbility(ravager, battleSystem._enemyUnits, [ravager]);

  assert.equal(ravager._kills, 2, 'rampage should count kills from both struck targets toward the passive');
  assert.equal(battleSystem._calcAttackPower(ravager), ravager.stats.attack * 1.2, 'two kills should grant the documented 20 percent attack bonus');

  ravager._kills = 10;

  assert.equal(battleSystem._calcAttackPower(ravager), ravager.stats.attack * 1.5, 'kill-stack attack bonus should cap at the documented 50 percent maximum');
});

test('battle start clears prior-battle passive progress on reused unit objects', () => {
  const battleSystem = makeIdleBattleSystem();
  const ravager = mkUnit(UNIT_MAP.fire_ravager, 4, 0, false);
  const pupil = mkUnit(UNIT_MAP.arcane_pupil, 4, 1, false);
  const enemy = mkUnit(UNIT_MAP.fire_imp, 0, 0, true);
  const pupilBaseAttack = pupil.stats.attack;
  const pupilBaseDefense = pupil.stats.defense;

  ravager._kills = 4;
  ravager.abilityCooldown = 2;
  ravager.statusEffects = [{ type: 'burn', duration: 2, stacks: 1, value: 5 }];
  pupil._turnsSurvived = 9;
  pupil._evolveStacks = 3;
  pupil._evolveBase = { attack: pupilBaseAttack, defense: pupilBaseDefense };
  pupil.stats.attack = Math.floor(pupilBaseAttack * 1.3);
  pupil.stats.defense = Math.floor(pupilBaseDefense * 1.3);

  battleSystem.start([ravager, pupil], [enemy]);

  assert.equal(ravager._kills, 0, 'battle start should reset kill-stack counters from the previous battle');
  assert.equal(battleSystem._calcAttackPower(ravager), ravager.stats.attack, 'battle start should remove prior-battle kill-stack attack bonuses');
  assert.equal(ravager.abilityCooldown, 0, 'battle start should reset lingering ability cooldowns from the previous battle');
  assert.equal(ravager.statusEffects.length, 0, 'battle start should clear lingering status effects from the previous battle');
  assert.equal(pupil._turnsSurvived || 0, 0, 'battle start should reset evolve turn progress from the previous battle');
  assert.equal(pupil._evolveStacks || 0, 0, 'battle start should reset evolve stacks from the previous battle');
  assert.equal(pupil.stats.attack, pupilBaseAttack, 'battle start should restore evolved attack back to the unit\'s pre-battle base');
  assert.equal(pupil.stats.defense, pupilBaseDefense, 'battle start should restore evolved defense back to the unit\'s pre-battle base');
});

test('battle start clears reused boss phase state from the previous fight', () => {
  const battleSystem = makeIdleBattleSystem();
  const boss = mkUnit(UNIT_MAP.boss_frost_colossus, 0, 0, true);
  const player = mkUnit(UNIT_MAP.fire_imp, 4, 0, false);
  const baseAttack = boss.stats.attack;
  const baseDefense = boss.stats.defense;
  const baseSpeed = boss.stats.speed;
  const baseHp = boss.hp;
  const baseMaxHp = boss.maxHp;

  boss._currentPhaseIndex = 1;
  boss._bossBaseStats = { attack: baseAttack, defense: baseDefense, speed: baseSpeed, hp: baseHp, maxHp: baseMaxHp };
  boss.stats.attack = Math.floor(baseAttack * 1.5);
  boss.stats.defense = Math.floor(baseDefense * 1.5);
  boss.stats.speed = Math.floor(baseSpeed * 0.8);
  boss.hp = 450;
  boss.maxHp = 450;

  battleSystem.start([player], [boss]);

  assert.equal(boss._currentPhaseIndex, undefined, 'battle start should clear prior boss phase progress from reused boss objects');
  assert.equal(boss._bossBaseStats, undefined, 'battle start should clear cached boss base stats from the previous fight');
  assert.equal(boss.stats.attack, baseAttack, 'battle start should restore boss attack to its base value before phase logic runs again');
  assert.equal(boss.stats.defense, baseDefense, 'battle start should restore boss defense to its base value before phase logic runs again');
  assert.equal(boss.stats.speed, baseSpeed, 'battle start should restore boss speed to its base value before phase logic runs again');
  assert.equal(boss.hp, baseHp, 'battle start should restore boss HP to its pre-phase value before the next fight');
  assert.equal(boss.maxHp, baseMaxHp, 'battle start should restore boss max HP to its pre-phase value before the next fight');
});

test('battle start clears reused synergy state before a no-synergy fight begins', () => {
  const battleSystem = makeIdleBattleSystem();
  const unit = mkUnit(UNIT_MAP.fire_imp, 4, 0, false);
  const enemy = mkUnit(UNIT_MAP.earth_golem, 0, 0, true);
  const baseStats = { ...unit.stats };
  const baseHp = unit.hp;
  const baseMaxHp = unit.maxHp;

  unit._baseStats = { ...baseStats };
  unit._baseHp = baseHp;
  unit._baseMaxHp = baseMaxHp;
  unit.stats.attack = Math.floor(baseStats.attack * 1.3);
  unit.maxHp = Math.floor(baseMaxHp * 1.2);
  unit.hp = unit.maxHp;

  battleSystem.start([unit], [enemy]);

  assert.equal(unit.stats.attack, baseStats.attack, 'battle start should restore stale synergy-buffed attack before applying current synergies');
  assert.equal(unit.maxHp, baseMaxHp, 'battle start should restore stale synergy-buffed max HP before a no-synergy fight');
  assert.equal(unit.hp, baseHp, 'battle start should restore stale synergy-buffed HP before a no-synergy fight');
  assert.equal(unit._baseStats.attack, baseStats.attack, 'the new battle should snapshot from the restored base stats instead of the stale synergy buff');
});

test('fire synergy buffs off-element allies across the whole army', () => {
  const battleSystem = makeIdleBattleSystem();
  const fireA = mkUnit(UNIT_MAP.fire_imp, 4, 0, false);
  const fireB = mkUnit(UNIT_MAP.fire_scout, 4, 1, false);
  const offElementAlly = mkUnit(UNIT_MAP.earth_golem, 4, 2, false);
  const baseAttack = offElementAlly.stats.attack;

  battleSystem._applyElementSynergies([fireA, fireB, offElementAlly]);

  assert.equal(offElementAlly.stats.attack, Math.floor(baseAttack * 1.15), '2-fire synergy should boost attack for non-fire allies too');
  assert.equal(offElementAlly.stats.defense, UNIT_MAP.earth_golem.stats.defense, 'fire synergy should not alter unrelated stats');
});

test('same-stat synergies multiply together for off-element allies', () => {
  const battleSystem = makeIdleBattleSystem();
  const fireA = mkUnit(UNIT_MAP.fire_imp, 4, 0, false);
  const fireB = mkUnit(UNIT_MAP.fire_scout, 4, 1, false);
  const bloodA = mkUnit(UNIT_MAP.blood_imp, 4, 2, false);
  const bloodB = mkUnit(UNIT_MAP.blood_knight, 4, 3, false);
  const offElementAlly = mkUnit(UNIT_MAP.earth_golem, 4, 4, false);
  const baseAttack = offElementAlly.stats.attack;

  battleSystem._applyElementSynergies([fireA, fireB, bloodA, bloodB, offElementAlly]);

  assert.equal(offElementAlly.stats.attack, Math.floor(baseAttack * 1.15 * 1.15), 'whole-army attack synergies should multiply together instead of replacing one another');
});

test('earth synergy buffs off-element HP and resetSynergies restores the base pool', () => {
  const battleSystem = makeIdleBattleSystem();
  const earthA = mkUnit(UNIT_MAP.earth_golem, 4, 0, false);
  const earthB = mkUnit(UNIT_MAP.earth_archer, 4, 1, false);
  const offElementAlly = mkUnit(UNIT_MAP.fire_imp, 4, 2, false);
  const baseHp = offElementAlly.hp;
  const baseMaxHp = offElementAlly.maxHp;

  battleSystem._applyElementSynergies([earthA, earthB, offElementAlly]);

  assert.equal(offElementAlly.maxHp, Math.floor(baseMaxHp * 1.2), '2-earth synergy should raise max HP for non-earth allies too');
  assert.equal(offElementAlly.hp, Math.floor(baseHp * 1.2), '2-earth synergy should raise current HP with the new max HP at battle start');

  battleSystem._resetSynergies([earthA, earthB, offElementAlly]);

  assert.equal(offElementAlly.maxHp, baseMaxHp, 'resetSynergies should restore the pre-synergy max HP pool');
  assert.equal(offElementAlly.hp, baseHp, 'resetSynergies should restore the pre-synergy HP pool for an untouched unit');
});

test('same-stat tier upgrades keep only the highest tier bonus', () => {
  const battleSystem = makeIdleBattleSystem();
  const fireA = mkUnit(UNIT_MAP.fire_imp, 4, 0, false);
  const fireB = mkUnit(UNIT_MAP.fire_scout, 4, 1, false);
  const fireC = mkUnit(UNIT_MAP.fire_warrior, 4, 2, false);
  const offElementAlly = mkUnit(UNIT_MAP.earth_golem, 4, 3, false);
  const baseAttack = offElementAlly.stats.attack;

  battleSystem._applyElementSynergies([fireA, fireB, fireC, offElementAlly]);

  assert.equal(offElementAlly.stats.attack, Math.floor(baseAttack * 1.3), '3-fire synergy should use the higher tier attack bonus instead of stacking the 2-fire and 3-fire tiers together');
});

test('mixed-stat tier upgrades stay active together when a 3-unit synergy adds a new stat', () => {
  const battleSystem = makeIdleBattleSystem();
  const voidA = mkUnit(UNIT_MAP.void_shade, 4, 0, false);
  const voidB = mkUnit(UNIT_MAP.void_knight, 4, 1, false);
  const voidC = mkUnit(UNIT_MAP.void_horror, 4, 2, false);
  const offElementAlly = mkUnit(UNIT_MAP.fire_imp, 4, 3, false);
  const baseAttack = offElementAlly.stats.attack;
  const baseHp = offElementAlly.hp;
  const baseMaxHp = offElementAlly.maxHp;

  battleSystem._applyElementSynergies([voidA, voidB, voidC, offElementAlly]);

  assert.equal(offElementAlly.stats.attack, Math.floor(baseAttack * 1.25), '3-void synergy should keep the 2-void attack bonus because the higher tier adds HP, not attack');
  assert.equal(offElementAlly.maxHp, Math.floor(baseMaxHp * 1.2), '3-void synergy should also apply the HP tier to off-element allies');
  assert.equal(offElementAlly.hp, Math.floor(baseHp * 1.2), '3-void synergy should raise current HP with the new HP tier at battle start');
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

test('void knight corruption strike applies the default 8 percent weaken and documents it', () => {
  const battleSystem = makeIdleBattleSystem();
  const knight = mkUnit(UNIT_MAP.void_knight, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [knight];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(knight, [target], [knight]);

  const weaken = target.statusEffects.find(effect => effect.type === 'weaken');
  const description = UNIT_MAP.void_knight.ability.description.toLowerCase();

  assert.ok(weaken, 'corruption strike should apply weaken');
  assert.equal(weaken.duration, 2, 'corruption strike weaken should last 2 turns');
  assert.equal(battleSystem._calcAttackPower(target), target.stats.attack * 0.92, 'corruption strike should use the default 8 percent weaken strength');
  assert.match(description, /8% weaken/, 'corruption strike text should mention the implemented weaken strength');
  assert.match(description, /2 turns/, 'corruption strike text should mention the weaken duration');
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

test('earth enforcer ground slam knocks the target back one row toward its spawn side', () => {
  const battleSystem = makeIdleBattleSystem();
  const enforcer = mkUnit(UNIT_MAP.earth_enforcer, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 1, 0, true);

  battleSystem._playerUnits = [enforcer];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(enforcer, [target], [enforcer]);

  assert.equal(target.row, 0, 'ground slam should push the enemy one row back toward its spawn side');
});

test('earth enforcer ground slam leaves the target in place when the knockback tile is occupied', () => {
  const battleSystem = makeIdleBattleSystem();
  const enforcer = mkUnit(UNIT_MAP.earth_enforcer, 2, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 1, 0, true);
  const blocker = mkUnit(UNIT_MAP.ice_guardian, 0, 0, true);

  battleSystem._playerUnits = [enforcer];
  battleSystem._enemyUnits = [target, blocker];

  battleSystem._useAbility(enforcer, [target, blocker], [enforcer]);

  assert.equal(target.row, 1, 'ground slam should not move the target into an occupied tile');
});

test('lightning hunter grapple pull drags the target one row toward the battle line', () => {
  const battleSystem = makeIdleBattleSystem();
  const hunter = mkUnit(UNIT_MAP.lightning_hunter, 3, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 1, 0, true);

  battleSystem._playerUnits = [hunter];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(hunter, [target], [hunter]);

  assert.equal(target.row, 2, 'grapple pull should drag an enemy one row closer without crossing the battle line');
});

test('lightning hunter grapple pull does not drag enemies past the battle line', () => {
  const battleSystem = makeIdleBattleSystem();
  const hunter = mkUnit(UNIT_MAP.lightning_hunter, 4, 0, false);
  const target = mkUnit(UNIT_MAP.earth_golem, 2, 0, true);

  battleSystem._playerUnits = [hunter];
  battleSystem._enemyUnits = [target];

  battleSystem._useAbility(hunter, [target], [hunter]);

  assert.equal(target.row, 2, 'grapple pull should clamp at the battle line instead of pulling enemies into player territory');
});