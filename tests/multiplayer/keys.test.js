/**
 * Shape Strikers — tests/multiplayer/keys.test.js
 *
 * Tests for the UnitKeys module (makeUnitKey, parseUnitKey, stampUnit).
 *
 * Run: node tests/multiplayer/keys.test.js
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

console.log('\nUnitKeys tests\n');

// ── makeUnitKey ───────────────────────────────────────────────────────────────

test('makeUnitKey: returns a string', () => {
  assert.equal(typeof UnitKeys.makeUnitKey('player1', 'fire_scout', 3, 0), 'string');
});

test('makeUnitKey: contains all four components separated by "::"', () => {
  const key = UnitKeys.makeUnitKey('owner', 'fire_scout', 3, 2);
  const parts = key.split('::');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'owner');
  assert.equal(parts[1], 'fire_scout');
  assert.equal(parts[2], '3');
  assert.equal(parts[3], '2');
});

test('makeUnitKey: format is {ownerId}::{defId}::{row}::{col}', () => {
  const key = UnitKeys.makeUnitKey('army1', 'ice_slime', 4, 5);
  assert.equal(key, 'army1::ice_slime::4::5');
});

test('makeUnitKey: different owners produce different keys', () => {
  const k1 = UnitKeys.makeUnitKey('army1', 'fire_scout', 3, 0);
  const k2 = UnitKeys.makeUnitKey('army2', 'fire_scout', 3, 0);
  assert.notEqual(k1, k2);
});

test('makeUnitKey: different positions produce different keys', () => {
  const k1 = UnitKeys.makeUnitKey('army1', 'fire_scout', 3, 0);
  const k2 = UnitKeys.makeUnitKey('army1', 'fire_scout', 4, 0);
  const k3 = UnitKeys.makeUnitKey('army1', 'fire_scout', 3, 1);
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});

test('makeUnitKey: same arguments always produce the same key', () => {
  assert.equal(
    UnitKeys.makeUnitKey('p', 'unit', 2, 3),
    UnitKeys.makeUnitKey('p', 'unit', 2, 3)
  );
});

// ── parseUnitKey ──────────────────────────────────────────────────────────────

test('parseUnitKey: returns an object with ownerId, defId, row, col', () => {
  const parsed = UnitKeys.parseUnitKey('army1::fire_scout::3::2');
  assert.equal(parsed.ownerId, 'army1');
  assert.equal(parsed.defId,   'fire_scout');
  assert.equal(parsed.row,     3);
  assert.equal(parsed.col,     2);
});

test('parseUnitKey: row and col are numbers, not strings', () => {
  const parsed = UnitKeys.parseUnitKey('army2::ice_slime::0::5');
  assert.equal(typeof parsed.row, 'number');
  assert.equal(typeof parsed.col, 'number');
});

test('parseUnitKey: round-trips with makeUnitKey', () => {
  const ownerId = 'army1';
  const defId   = 'earth_golem';
  const row     = 4;
  const col     = 3;
  const key    = UnitKeys.makeUnitKey(ownerId, defId, row, col);
  const parsed = UnitKeys.parseUnitKey(key);
  assert.equal(parsed.ownerId, ownerId);
  assert.equal(parsed.defId,   defId);
  assert.equal(parsed.row,     row);
  assert.equal(parsed.col,     col);
});

test('parseUnitKey: round-trips for all grid positions (rows 0-4, cols 0-5)', () => {
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      const key    = UnitKeys.makeUnitKey('owner', 'unit', r, c);
      const parsed = UnitKeys.parseUnitKey(key);
      assert.equal(parsed.row, r, `Row mismatch at r=${r}, c=${c}`);
      assert.equal(parsed.col, c, `Col mismatch at r=${r}, c=${c}`);
    }
  }
});

// ── stampUnit ─────────────────────────────────────────────────────────────────

function mkUnit(defId, row, col) {
  return {
    definition: { id: defId },
    row,
    col,
    hp: 100,
    stats: {},
  };
}

test('stampUnit: sets stableKey on the unit', () => {
  const unit = mkUnit('fire_scout', 3, 0);
  UnitKeys.stampUnit(unit, 'army1');
  assert.ok('stableKey' in unit, 'stableKey should be set');
  assert.equal(typeof unit.stableKey, 'string');
});

test('stampUnit: sets id equal to stableKey', () => {
  const unit = mkUnit('ice_slime', 4, 2);
  UnitKeys.stampUnit(unit, 'army2');
  assert.equal(unit.id, unit.stableKey);
});

test('stampUnit: stableKey matches makeUnitKey output', () => {
  const unit = mkUnit('earth_golem', 3, 5);
  UnitKeys.stampUnit(unit, 'army1');
  const expected = UnitKeys.makeUnitKey('army1', 'earth_golem', 3, 5);
  assert.equal(unit.stableKey, expected);
});

test('stampUnit: two units with different positions get different stableKeys', () => {
  const u1 = mkUnit('fire_scout', 3, 0);
  const u2 = mkUnit('fire_scout', 4, 0);
  UnitKeys.stampUnit(u1, 'army1');
  UnitKeys.stampUnit(u2, 'army1');
  assert.notEqual(u1.stableKey, u2.stableKey);
});

test('stampUnit: two units with different ownerIds get different stableKeys', () => {
  const u1 = mkUnit('fire_scout', 3, 0);
  const u2 = mkUnit('fire_scout', 3, 0);
  UnitKeys.stampUnit(u1, 'army1');
  UnitKeys.stampUnit(u2, 'army2');
  assert.notEqual(u1.stableKey, u2.stableKey);
});

test('stampUnit: mutates unit in place and returns nothing meaningful', () => {
  const unit = mkUnit('fire_scout', 3, 0);
  // stampUnit should mutate unit in place; return value is not used
  UnitKeys.stampUnit(unit, 'army1');
  assert.ok(unit.stableKey, 'Unit should have stableKey after stampUnit');
});

console.log('\nDone.\n');
