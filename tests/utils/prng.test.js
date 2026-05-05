/**
 * Shape Strikers — tests/utils/prng.test.js
 *
 * Tests for the PRNG module (mulberry32, seededInt, shuffle).
 *
 * Run: node tests/utils/prng.test.js
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

loadModule('utils/prng.js');

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

console.log('\nPRNG tests\n');

// ── mulberry32 ────────────────────────────────────────────────────────────────

test('mulberry32: returns a function', () => {
  const rng = PRNG.mulberry32(42);
  assert.equal(typeof rng, 'function');
});

test('mulberry32: values are in [0, 1)', () => {
  const rng = PRNG.mulberry32(123);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `Value ${v} not in [0, 1)`);
  }
});

test('mulberry32: same seed produces identical sequence', () => {
  const rng1 = PRNG.mulberry32(0xDEADBEEF);
  const rng2 = PRNG.mulberry32(0xDEADBEEF);
  for (let i = 0; i < 50; i++) {
    assert.equal(rng1(), rng2(), `Values diverged at step ${i}`);
  }
});

test('mulberry32: different seeds produce different sequences', () => {
  const rng1 = PRNG.mulberry32(1);
  const rng2 = PRNG.mulberry32(2);
  const vals1 = Array.from({ length: 20 }, () => rng1());
  const vals2 = Array.from({ length: 20 }, () => rng2());
  // Sequences of 20 floats from different seeds should differ
  assert.notDeepEqual(vals1, vals2);
});

test('mulberry32: zero seed is a valid starting point', () => {
  const rng = PRNG.mulberry32(0);
  const v = rng();
  assert.ok(typeof v === 'number' && v >= 0 && v < 1);
});

test('mulberry32: maximum 32-bit seed is handled without overflow', () => {
  const rng = PRNG.mulberry32(0xFFFFFFFF);
  for (let i = 0; i < 100; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `Overflow produced out-of-range value: ${v}`);
  }
});

test('mulberry32: each RNG instance is independent (no shared state)', () => {
  const rng1 = PRNG.mulberry32(7);
  const rng2 = PRNG.mulberry32(7);
  // Advance rng1 five times, then both should still agree from here if reset, but
  // here we just check rng2's sequence isn't affected by rng1 calls
  rng1(); rng1(); rng1(); rng1(); rng1();
  const rng3 = PRNG.mulberry32(7);
  // rng3 should still match rng2's current position (both at step 0)
  assert.equal(rng2(), rng3(), 'Separate instances should start from the same seed independently');
});

// ── seededInt ─────────────────────────────────────────────────────────────────

test('seededInt: returns integer values', () => {
  const rng = PRNG.mulberry32(99);
  for (let i = 0; i < 100; i++) {
    const v = PRNG.seededInt(rng, 10);
    assert.equal(v, Math.floor(v), `Not an integer: ${v}`);
  }
});

test('seededInt: values are in [0, maxExclusive)', () => {
  const rng = PRNG.mulberry32(55);
  for (let i = 0; i < 500; i++) {
    const v = PRNG.seededInt(rng, 6);
    assert.ok(v >= 0 && v < 6, `Value ${v} out of range [0, 6)`);
  }
});

test('seededInt: maxExclusive=1 always returns 0', () => {
  const rng = PRNG.mulberry32(10);
  for (let i = 0; i < 20; i++) {
    assert.equal(PRNG.seededInt(rng, 1), 0);
  }
});

test('seededInt: maxExclusive=2 returns only 0 or 1', () => {
  const rng = PRNG.mulberry32(321);
  for (let i = 0; i < 200; i++) {
    const v = PRNG.seededInt(rng, 2);
    assert.ok(v === 0 || v === 1, `Unexpected value: ${v}`);
  }
});

test('seededInt: same seed+maxExclusive produces same sequence', () => {
  const rng1 = PRNG.mulberry32(42);
  const rng2 = PRNG.mulberry32(42);
  for (let i = 0; i < 30; i++) {
    assert.equal(PRNG.seededInt(rng1, 100), PRNG.seededInt(rng2, 100));
  }
});

test('seededInt: covers full range (at least 3 distinct values in [0,6) for 500 draws)', () => {
  const rng = PRNG.mulberry32(77);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(PRNG.seededInt(rng, 6));
  assert.ok(seen.size >= 3, `Too few distinct values: ${[...seen].join(',')}`);
});

// ── shuffle ───────────────────────────────────────────────────────────────────

test('shuffle: returns the same array reference', () => {
  const arr = [1, 2, 3, 4, 5];
  const rng = PRNG.mulberry32(1);
  const result = PRNG.shuffle(arr, rng);
  assert.equal(result, arr);
});

test('shuffle: result has same length as input', () => {
  const arr = [10, 20, 30, 40];
  const rng = PRNG.mulberry32(2);
  PRNG.shuffle(arr, rng);
  assert.equal(arr.length, 4);
});

test('shuffle: result contains same elements as input', () => {
  const original = [1, 2, 3, 4, 5, 6];
  const arr = [...original];
  const rng = PRNG.mulberry32(3);
  PRNG.shuffle(arr, rng);
  assert.deepEqual([...arr].sort((a, b) => a - b), original);
});

test('shuffle: same seed produces same permutation', () => {
  const arr1 = [1, 2, 3, 4, 5];
  const arr2 = [1, 2, 3, 4, 5];
  PRNG.shuffle(arr1, PRNG.mulberry32(111));
  PRNG.shuffle(arr2, PRNG.mulberry32(111));
  assert.deepEqual(arr1, arr2);
});

test('shuffle: different seeds produce different permutations (probabilistic)', () => {
  const arr1 = [1, 2, 3, 4, 5, 6, 7, 8];
  const arr2 = [...arr1];
  PRNG.shuffle(arr1, PRNG.mulberry32(222));
  PRNG.shuffle(arr2, PRNG.mulberry32(333));
  // With 8-element arrays two permutations collide with probability 1/40320 ≈ negligible
  assert.notDeepEqual(arr1, arr2);
});

test('shuffle: single-element array is unaffected', () => {
  const arr = [42];
  PRNG.shuffle(arr, PRNG.mulberry32(0));
  assert.deepEqual(arr, [42]);
});

test('shuffle: empty array is unaffected', () => {
  const arr = [];
  PRNG.shuffle(arr, PRNG.mulberry32(0));
  assert.deepEqual(arr, []);
});

console.log('\nDone.\n');
