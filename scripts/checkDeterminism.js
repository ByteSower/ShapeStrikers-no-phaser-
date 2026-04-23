#!/usr/bin/env node
/**
 * Shape Strikers — scripts/checkDeterminism.js
 *
 * Stress-tests BattleSystem determinism across many seeds and unit
 * combinations.  Runs two identical battles for each (seed, army) pair
 * and asserts the board hashes match.
 *
 * Usage:
 *   node scripts/checkDeterminism.js            # default: 100 seeds
 *   node scripts/checkDeterminism.js --seeds 500
 *   node scripts/checkDeterminism.js --seeds 50 --verbose
 *
 * Exit code 0 = all passed.  Non-zero = divergence detected.
 */
'use strict';

const path    = require('path');
const assert  = require('assert/strict');
const process = require('process');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const seedsIdx   = args.indexOf('--seeds');
const NUM_SEEDS  = seedsIdx >= 0 ? parseInt(args[seedsIdx + 1], 10) || 100 : 100;
const VERBOSE    = args.includes('--verbose');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document     = { getElementById: () => null, querySelector: () => null };
global.window       = global;

const fs  = require('fs');
const vm  = require('vm');
const SRC = path.resolve(__dirname, '../src');
function loadModule(rel) {
  const code = fs.readFileSync(path.join(SRC, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

loadModule('config.js');
loadModule('utils/prng.js');
loadModule('battle/hashUtils.js');
loadModule('multiplayer/keys.js');
loadModule('battle.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const UNIT_MAP = {};
for (const d of UNIT_DEFINITIONS) {
  if (!d.isBoss) UNIT_MAP[d.id] = d;
}
const ALL_DEF_IDS = Object.keys(UNIT_MAP);

/** Seeded unit-selection RNG so armies are reproducible per seed. */
function pickArmy(rng, size) {
  const selected = [];
  const pool = [...ALL_DEF_IDS];
  for (let i = 0; i < size && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    selected.push(UNIT_MAP[pool.splice(idx, 1)[0]]);
  }
  return selected;
}

let _uid = 0;
function mkUnit(def, row, col, isEnemy) {
  return {
    id:              `${isEnemy ? 'e' : 'p'}::${def.id}::${row}::${col}`,
    name:            def.name,
    definition:      def,
    hp:              def.stats.hp,
    maxHp:           def.stats.hp,
    stats:           { ...def.stats },
    statusEffects:   [],
    abilityCooldown: 0,
    isEnemy,
    row,
    col,
  };
}

/**
 * Run a battle synchronously to completion.
 * Returns the final board hash.
 */
function runBattleSync(seed, playerDefs, enemyDefs) {
  const bs = new BattleSystem();
  bs.setSeed(seed);
  bs.onActionDone = () => Promise.resolve();

  let turns = 0;
  const MAX = 10000;
  const orig = global.setTimeout;
  global.setTimeout = (fn) => { if (turns++ < MAX) fn(); return 0; };

  const playerUnits = playerDefs.map((d, i) => mkUnit(d, 3 + (i % 2), i % 6, false));
  const enemyUnits  = enemyDefs.map((d, i) =>  mkUnit(d, i % 2,       i % 6, true));

  bs.start(playerUnits, enemyUnits);
  global.setTimeout = orig;

  return bs.getLastBoardHash();
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log(`\n⚔  Shape Strikers — Determinism Check (${NUM_SEEDS} seeds)\n`);

let passed  = 0;
let failed  = 0;
let elapsed = 0;

for (let i = 0; i < NUM_SEEDS; i++) {
  // Use a simple counter-based seed derivation so tests are reproducible
  const seed     = (0xDEADC0DE + i * 0x1337) >>> 0;
  const armyRng  = PRNG.mulberry32(seed ^ 0xABCDEF);
  const armySize = 3 + PRNG.seededInt(armyRng, 3); // 3–5 units per side

  const playerDefs = pickArmy(armyRng, armySize);
  const enemyDefs  = pickArmy(armyRng, armySize);

  const t0   = Date.now();
  const hash1 = runBattleSync(seed, playerDefs, enemyDefs);
  const hash2 = runBattleSync(seed, playerDefs, enemyDefs);
  elapsed   += Date.now() - t0;

  if (hash1 === hash2) {
    passed++;
    if (VERBOSE) {
      const pa = playerDefs.map(d => d.id).join(',');
      const ea = enemyDefs.map(d => d.id).join(',');
      console.log(`  ✅ seed=${seed.toString(16).padStart(8,'0')} | p=[${pa}] e=[${ea}] hash=${hash1}`);
    } else {
      process.stdout.write('.');
    }
  } else {
    failed++;
    const pa = playerDefs.map(d => d.id).join(',');
    const ea = enemyDefs.map(d => d.id).join(',');
    console.error(`\n  ❌ DIVERGENCE  seed=${seed.toString(16)} p=[${pa}] e=[${ea}]`);
    console.error(`     hash1=${hash1}  hash2=${hash2}`);
  }
}

if (!VERBOSE) process.stdout.write('\n');

console.log(`\n──────────────────────────────────────────────`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`  Total time: ${elapsed} ms  (avg ${(elapsed / NUM_SEEDS).toFixed(1)} ms/battle-pair)`);
console.log(`──────────────────────────────────────────────\n`);

if (failed > 0) process.exit(1);
