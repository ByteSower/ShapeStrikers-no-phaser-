/**
 * Shape Strikers — tests/battle/hashUtils.test.js
 *
 * Tests for the HashUtils module (djb2, hashState, warnMismatch).
 *
 * Run: node tests/battle/hashUtils.test.js
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

loadModule('battle/hashUtils.js');

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

console.log('\nHashUtils tests\n');

// ── djb2 ──────────────────────────────────────────────────────────────────────

test('djb2: returns an 8-character hex string', () => {
  const h = HashUtils.djb2('hello');
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 8);
  assert.ok(/^[0-9a-f]{8}$/.test(h), `Not 8 lowercase hex chars: ${h}`);
});

test('djb2: same input always produces same output', () => {
  assert.equal(HashUtils.djb2('test'), HashUtils.djb2('test'));
  assert.equal(HashUtils.djb2('ShapeStrikers'), HashUtils.djb2('ShapeStrikers'));
});

test('djb2: different inputs produce different hashes (collision-free for simple cases)', () => {
  assert.notEqual(HashUtils.djb2('abc'), HashUtils.djb2('xyz'));
  assert.notEqual(HashUtils.djb2('a'), HashUtils.djb2('b'));
});

test('djb2: empty string returns a valid 8-char hex hash', () => {
  const h = HashUtils.djb2('');
  assert.equal(h.length, 8);
  assert.ok(/^[0-9a-f]{8}$/.test(h));
  // djb2('') = 5381 = 0x00001505
  assert.equal(h, '00001505');
});

test('djb2: known value — "Hello World"', () => {
  // Compute expected: djb2 starts at 5381, iterates charCodes of "Hello World"
  let h = 5381;
  for (const c of 'Hello World') h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  const expected = h.toString(16).padStart(8, '0');
  assert.equal(HashUtils.djb2('Hello World'), expected);
});

test('djb2: output is padded to 8 chars for small hash values', () => {
  // Empty string produces 5381 = 0x00001505 which needs padding
  const h = HashUtils.djb2('');
  assert.equal(h.length, 8);
  assert.ok(h.startsWith('0'), 'Expected leading zeros for small hash');
});

test('djb2: is case-sensitive', () => {
  assert.notEqual(HashUtils.djb2('abc'), HashUtils.djb2('ABC'));
});

// ── hashState ─────────────────────────────────────────────────────────────────

function mkTestUnit(id, hp, row, col) {
  return { id, hp, row, col };
}

test('hashState: same units produce the same hash', () => {
  const units = [
    mkTestUnit('p1', 100, 3, 0),
    mkTestUnit('e1',  80, 1, 2),
  ];
  assert.equal(HashUtils.hashState(units), HashUtils.hashState(units));
});

test('hashState: order of input array does not affect the hash (insertion-order independent)', () => {
  const units1 = [mkTestUnit('alpha', 50, 3, 0), mkTestUnit('beta', 30, 1, 0)];
  const units2 = [mkTestUnit('beta',  30, 1, 0), mkTestUnit('alpha', 50, 3, 0)];
  assert.equal(HashUtils.hashState(units1), HashUtils.hashState(units2));
});

test('hashState: different HP values produce different hashes', () => {
  const units1 = [mkTestUnit('p1', 100, 3, 0)];
  const units2 = [mkTestUnit('p1',  99, 3, 0)];
  assert.notEqual(HashUtils.hashState(units1), HashUtils.hashState(units2));
});

test('hashState: dead units (hp=0) hash differently from alive units', () => {
  const alive = [mkTestUnit('u1', 1, 3, 0)];
  const dead  = [mkTestUnit('u1', 0, 3, 0)];
  assert.notEqual(HashUtils.hashState(alive), HashUtils.hashState(dead));
});

test('hashState: different row/col produces different hash (position-sensitive)', () => {
  const units1 = [mkTestUnit('u1', 50, 3, 0)];
  const units2 = [mkTestUnit('u1', 50, 4, 0)];
  const units3 = [mkTestUnit('u1', 50, 3, 1)];
  assert.notEqual(HashUtils.hashState(units1), HashUtils.hashState(units2));
  assert.notEqual(HashUtils.hashState(units1), HashUtils.hashState(units3));
});

test('hashState: different unit IDs produce different hashes', () => {
  const units1 = [mkTestUnit('unit_a', 100, 3, 0)];
  const units2 = [mkTestUnit('unit_b', 100, 3, 0)];
  assert.notEqual(HashUtils.hashState(units1), HashUtils.hashState(units2));
});

test('hashState: empty array returns a valid hash', () => {
  const h = HashUtils.hashState([]);
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 8);
});

test('hashState: uses stableKey as fallback when id is missing', () => {
  const u = { stableKey: 'sk::fire_scout::3::0', hp: 100, row: 3, col: 0 };
  const h = HashUtils.hashState([u]);
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 8);
});

test('hashState: fractional HP is rounded consistently', () => {
  // 100.4 and 100.6 round to 100 and 101 respectively — should differ
  const u1 = mkTestUnit('u1', 100.4, 3, 0);
  const u2 = mkTestUnit('u1', 100.6, 3, 0);
  // Both hash to their own consistent values
  assert.equal(HashUtils.hashState([u1]), HashUtils.hashState([mkTestUnit('u1', 100.4, 3, 0)]));
  assert.notEqual(HashUtils.hashState([u1]), HashUtils.hashState([u2]));
});

// ── warnMismatch ──────────────────────────────────────────────────────────────

test('warnMismatch: does not throw', () => {
  assert.doesNotThrow(() => HashUtils.warnMismatch('aabbccdd', '11223344'));
});

test('warnMismatch: does not throw for identical hashes', () => {
  assert.doesNotThrow(() => HashUtils.warnMismatch('aabbccdd', 'aabbccdd'));
});

test('warnMismatch: captures a console.warn call (mismatch is diagnostic only)', () => {
  let warned = false;
  const origWarn = console.warn;
  console.warn = (...args) => { warned = true; };
  HashUtils.warnMismatch('00000001', '00000002');
  console.warn = origWarn;
  assert.ok(warned, 'warnMismatch should call console.warn');
});

console.log('\nDone.\n');
