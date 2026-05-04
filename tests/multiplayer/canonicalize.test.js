/**
 * Shape Strikers — tests/multiplayer/canonicalize.test.js
 *
 * Tests for the Canonicalize module (army1Owner, toArmy1Row, toArmy2Row,
 * canonicalizeArmies).  The most important test verifies that both clients
 * produce the same canonical army1/army2 arrays for the same match — this
 * is the core multiplayer determinism guarantee.
 *
 * Run: node tests/multiplayer/canonicalize.test.js
 */
'use strict';

const assert = require('assert/strict');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.window  = global;
global.console = console;

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

loadModule('multiplayer/keys.js');
loadModule('multiplayer/canonicalize.js');

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

console.log('\nCanonicalize tests\n');

// ── army1Owner ────────────────────────────────────────────────────────────────

test('army1Owner: returns "A" when playerIdA < playerIdB lexicographically', () => {
  assert.equal(Canonicalize.army1Owner('alice', 'bob'), 'A');
  assert.equal(Canonicalize.army1Owner('aaa', 'bbb'), 'A');
});

test('army1Owner: returns "B" when playerIdA > playerIdB lexicographically', () => {
  assert.equal(Canonicalize.army1Owner('bob', 'alice'), 'B');
  assert.equal(Canonicalize.army1Owner('zzz', 'aaa'), 'B');
});

test('army1Owner: returns "A" when playerIdA === playerIdB (equal ids)', () => {
  assert.equal(Canonicalize.army1Owner('same', 'same'), 'A');
});

test('army1Owner: is consistent (same inputs always give same output)', () => {
  assert.equal(Canonicalize.army1Owner('player1', 'player2'), Canonicalize.army1Owner('player1', 'player2'));
});

test('army1Owner: result is always "A" or "B"', () => {
  const result = Canonicalize.army1Owner('x', 'y');
  assert.ok(result === 'A' || result === 'B');
});

// ── toArmy1Row ────────────────────────────────────────────────────────────────

test('toArmy1Row: row 3 maps to 3 (front of player zone)', () => {
  assert.equal(Canonicalize.toArmy1Row(3), 3);
});

test('toArmy1Row: row 4 maps to 4 (back of player zone)', () => {
  assert.equal(Canonicalize.toArmy1Row(4), 4);
});

// ── toArmy2Row ────────────────────────────────────────────────────────────────

test('toArmy2Row: row 3 (front) maps to 1 (front of enemy zone)', () => {
  assert.equal(Canonicalize.toArmy2Row(3), 1);
});

test('toArmy2Row: row 4 (back) maps to 0 (back of enemy zone)', () => {
  assert.equal(Canonicalize.toArmy2Row(4), 0);
});

test('toArmy2Row: formula is 4 - visualRow', () => {
  assert.equal(Canonicalize.toArmy2Row(3), 4 - 3);
  assert.equal(Canonicalize.toArmy2Row(4), 4 - 4);
});

test('toArmy1Row and toArmy2Row are inverses for player zone rows', () => {
  // toArmy2Row(toArmy1Row(r)) should equal toArmy2Row(r) for r in {3, 4}
  for (const r of [3, 4]) {
    assert.equal(Canonicalize.toArmy1Row(r), r);
    // toArmy2Row gives the mirrored row
    const mirrored = Canonicalize.toArmy2Row(r);
    assert.ok(mirrored === 0 || mirrored === 1, `Mirrored row ${mirrored} should be 0 or 1`);
  }
});

// ── canonicalizeArmies ────────────────────────────────────────────────────────

// Minimal mkUnit factory (mirrors the one in game.js / test helpers)
function mkUnit(def, row, col, isEnemy) {
  return {
    id:         `${isEnemy ? 'e' : 'p'}::${def.id}::${row}::${col}`,
    definition: def,
    row,
    col,
    hp:       def.stats.hp,
    maxHp:    def.stats.hp,
    stats:    { ...def.stats },
    statusEffects:   [],
    abilityCooldown: 0,
    isEnemy,
  };
}

const UNIT_MAP = {
  fire_scout:  { id: 'fire_scout',  stats: { hp: 80, attack: 12, defense: 5, speed: 8 } },
  ice_slime:   { id: 'ice_slime',   stats: { hp: 60, attack: 8,  defense: 4, speed: 6 } },
  earth_golem: { id: 'earth_golem', stats: { hp: 120, attack: 10, defense: 10, speed: 3 } },
};

// Build unit objects as if each player placed their units in the shop/prep phase
function buildPlayerUnits(defs, owner) {
  // Player zone: rows 3 (front) and 4 (back)
  return defs.map((def, i) => mkUnit(def, 3 + (i % 2), i % 6, false));
}

// Serialise units to the compact payload format transmitted via signalReady
function toPayload(units) {
  return units.map(u => ({
    defId: u.definition.id,
    row:   u.row,
    col:   u.col,
    stats: { ...u.stats },
  }));
}

test('canonicalizeArmies: army1 occupies rows 3-4 (bottom zone)', () => {
  const myId  = 'alice';
  const oppId = 'bob';
  // alice < bob → alice is army1
  const myUnits  = buildPlayerUnits([UNIT_MAP.fire_scout, UNIT_MAP.ice_slime], myId);
  const oppData  = toPayload(buildPlayerUnits([UNIT_MAP.earth_golem], oppId));

  const { army1 } = Canonicalize.canonicalizeArmies(myId, oppId, myUnits, oppData, mkUnit, UNIT_MAP);
  for (const u of army1) {
    assert.ok(u.row >= 3, `army1 unit row ${u.row} should be >= 3`);
  }
});

test('canonicalizeArmies: army2 occupies rows 0-1 (top zone)', () => {
  const myId  = 'alice';
  const oppId = 'bob';
  const myUnits = buildPlayerUnits([UNIT_MAP.fire_scout], myId);
  const oppData = toPayload(buildPlayerUnits([UNIT_MAP.earth_golem, UNIT_MAP.ice_slime], oppId));

  const { army2 } = Canonicalize.canonicalizeArmies(myId, oppId, myUnits, oppData, mkUnit, UNIT_MAP);
  for (const u of army2) {
    assert.ok(u.row <= 1, `army2 unit row ${u.row} should be <= 1`);
  }
});

test('canonicalizeArmies: iAmArmy1 is true for the lexicographically smaller playerId', () => {
  const myUnits  = buildPlayerUnits([UNIT_MAP.fire_scout], 'alice');
  const oppData  = toPayload(buildPlayerUnits([UNIT_MAP.ice_slime], 'bob'));

  const { iAmArmy1 } = Canonicalize.canonicalizeArmies('alice', 'bob', myUnits, oppData, mkUnit, UNIT_MAP);
  assert.ok(iAmArmy1);
});

test('canonicalizeArmies: iAmArmy1 is false for the lexicographically larger playerId', () => {
  const myUnits  = buildPlayerUnits([UNIT_MAP.fire_scout], 'bob');
  const oppData  = toPayload(buildPlayerUnits([UNIT_MAP.ice_slime], 'alice'));

  const { iAmArmy1 } = Canonicalize.canonicalizeArmies('bob', 'alice', myUnits, oppData, mkUnit, UNIT_MAP);
  assert.ok(!iAmArmy1);
});

test('canonicalizeArmies: both clients produce the same canonical unit rows (symmetry)', () => {
  // This is the core determinism guarantee.
  // Alice and Bob both have the same units; they call canonicalizeArmies with
  // their own perspective. The resulting army1 and army2 row assignments must
  // be identical on both sides.

  const aliceId = 'alice';
  const bobId   = 'charlie'; // 'charlie' > 'alice' → alice is army1

  const aliceDefs = [UNIT_MAP.fire_scout, UNIT_MAP.ice_slime];
  const bobDefs   = [UNIT_MAP.earth_golem];

  const aliceUnits = buildPlayerUnits(aliceDefs, aliceId);
  const bobUnits   = buildPlayerUnits(bobDefs, bobId);

  // Alice's perspective
  const fromAlice = Canonicalize.canonicalizeArmies(
    aliceId, bobId,
    aliceUnits, toPayload(bobUnits),
    mkUnit, UNIT_MAP
  );

  // Bob's perspective
  const fromBob = Canonicalize.canonicalizeArmies(
    bobId, aliceId,
    bobUnits, toPayload(aliceUnits),
    mkUnit, UNIT_MAP
  );

  // Both should agree on how many units are in army1 and army2
  assert.equal(fromAlice.army1.length, fromBob.army1.length,
    `army1 length differs: alice sees ${fromAlice.army1.length}, bob sees ${fromBob.army1.length}`);
  assert.equal(fromAlice.army2.length, fromBob.army2.length,
    `army2 length differs: alice sees ${fromAlice.army2.length}, bob sees ${fromBob.army2.length}`);

  // Both army1 arrays should contain units at the same rows
  const aliceArmy1Rows = fromAlice.army1.map(u => u.row).sort((a, b) => a - b);
  const bobArmy1Rows   = fromBob.army1.map(u => u.row).sort((a, b) => a - b);
  assert.deepEqual(aliceArmy1Rows, bobArmy1Rows,
    `army1 rows differ: alice=${aliceArmy1Rows}, bob=${bobArmy1Rows}`);

  const aliceArmy2Rows = fromAlice.army2.map(u => u.row).sort((a, b) => a - b);
  const bobArmy2Rows   = fromBob.army2.map(u => u.row).sort((a, b) => a - b);
  assert.deepEqual(aliceArmy2Rows, bobArmy2Rows,
    `army2 rows differ: alice=${aliceArmy2Rows}, bob=${bobArmy2Rows}`);
});

test('canonicalizeArmies: stableKeys are stamped on all units when UnitKeys is available', () => {
  const myId  = 'alice';
  const oppId = 'bob';
  const myUnits = buildPlayerUnits([UNIT_MAP.fire_scout], myId);
  const oppData = toPayload(buildPlayerUnits([UNIT_MAP.ice_slime], oppId));

  const { army1, army2 } = Canonicalize.canonicalizeArmies(myId, oppId, myUnits, oppData, mkUnit, UNIT_MAP);
  for (const u of [...army1, ...army2]) {
    assert.ok(u.stableKey, `Unit missing stableKey: ${JSON.stringify(u)}`);
    assert.equal(u.id, u.stableKey, 'id should equal stableKey after canonicalization');
  }
});

test('canonicalizeArmies: both clients produce matching stableKeys (army1 uses "army1" prefix)', () => {
  const aliceId = 'aaa';
  const bobId   = 'zzz'; // alice < bob → alice is army1

  const aliceUnits = buildPlayerUnits([UNIT_MAP.fire_scout], aliceId);
  const bobUnits   = buildPlayerUnits([UNIT_MAP.ice_slime], bobId);

  const fromAlice = Canonicalize.canonicalizeArmies(aliceId, bobId, aliceUnits, toPayload(bobUnits), mkUnit, UNIT_MAP);
  const fromBob   = Canonicalize.canonicalizeArmies(bobId, aliceId, bobUnits, toPayload(aliceUnits), mkUnit, UNIT_MAP);

  // Alice is army1; both clients should give alice's units the "army1::" prefix
  for (const u of fromAlice.army1) {
    assert.ok(u.stableKey.startsWith('army1::'), `Alice army1 unit key should start with "army1::": ${u.stableKey}`);
  }
  for (const u of fromBob.army1) {
    assert.ok(u.stableKey.startsWith('army1::'), `Bob army1 unit key should start with "army1::": ${u.stableKey}`);
  }

  // The stableKey of the fire_scout (alice's unit) should be the same from both clients
  const aliceScoutKey = fromAlice.army1.find(u => u.definition.id === 'fire_scout')?.stableKey;
  const bobScoutKey   = fromBob.army1.find(u => u.definition.id === 'fire_scout')?.stableKey;
  assert.ok(aliceScoutKey, 'Expected to find fire_scout in fromAlice.army1');
  assert.ok(bobScoutKey,   'Expected to find fire_scout in fromBob.army1');
  assert.equal(aliceScoutKey, bobScoutKey,
    `StableKey mismatch: alice=${aliceScoutKey}, bob=${bobScoutKey}`);
});

test('canonicalizeArmies: handles empty oppUnitData gracefully', () => {
  const myUnits = buildPlayerUnits([UNIT_MAP.fire_scout], 'alice');
  const { army1, army2 } = Canonicalize.canonicalizeArmies('alice', 'bob', myUnits, [], mkUnit, UNIT_MAP);
  assert.equal(army1.length + army2.length, myUnits.length, 'Total units should equal my units when opp has none');
});

test('canonicalizeArmies: handles null oppUnitData gracefully', () => {
  const myUnits = buildPlayerUnits([UNIT_MAP.fire_scout], 'alice');
  assert.doesNotThrow(() => {
    Canonicalize.canonicalizeArmies('alice', 'bob', myUnits, null, mkUnit, UNIT_MAP);
  });
});

test('canonicalizeArmies: does not mutate original myUnits row values', () => {
  const myUnits  = buildPlayerUnits([UNIT_MAP.fire_scout], 'alice');
  const origRows = myUnits.map(u => u.row);
  const oppData  = toPayload(buildPlayerUnits([UNIT_MAP.ice_slime], 'bob'));

  Canonicalize.canonicalizeArmies('alice', 'bob', myUnits, oppData, mkUnit, UNIT_MAP);
  const afterRows = myUnits.map(u => u.row);
  assert.deepEqual(origRows, afterRows, 'canonicalizeArmies should not mutate original unit rows');
});

console.log('\nDone.\n');
