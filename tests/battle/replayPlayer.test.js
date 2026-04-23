/**
 * Shape Strikers - tests/battle/replayPlayer.test.js
 *
 * Verifies that BattleReplay dispatches battle log events in sequence and only
 * pauses at turn boundaries.
 */
'use strict';

const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

global.window = global;
global.console = console;

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

loadModule('battleReplay.js');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\nBattleReplay player tests\n');

  await test('Replay events dispatch in order and wait only between turns', async () => {
    const calls = [];
    const player = BattleReplay.createPlayer({
      sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    });

    const replayLog = {
      version: 1,
      seed: 123,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1' },
        { seq: 3, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 4, turn: 1, type: 'unit_hit', targetId: 'e1', damage: 12 },
        { seq: 5, turn: 2, type: 'turn_start', unitId: 'e1' },
        { seq: 6, turn: 2, type: 'unit_move', unitId: 'e1', fromRow: 1, fromCol: 0, toRow: 2, toCol: 0 },
        { seq: 7, turn: 2, type: 'battle_end', playerWon: true },
      ],
    };

    await player.play(replayLog, {
      onBattleStart: () => calls.push('battle_start'),
      onTurnStart: (evt) => calls.push(`turn_start:${evt.unitId}`),
      onUnitAttack: () => calls.push('unit_attack'),
      onUnitHit: () => calls.push('unit_hit'),
      onUnitMove: () => calls.push('unit_move'),
      onBattleEnd: () => calls.push('battle_end'),
      waitForAnimations: async () => calls.push('wait'),
    }, { turnDelay: 25 });

    assert.deepEqual(calls, [
      'battle_start',
      'turn_start:p1',
      'unit_attack',
      'unit_hit',
      'wait',
      'sleep:25',
      'turn_start:e1',
      'unit_move',
      'battle_end',
    ]);
  });

  await test('Replay can resume from a checkpoint seq using the latest turn snapshot', async () => {
    const calls = [];
    const player = BattleReplay.createPlayer({
      sleep: async () => { calls.push('sleep'); },
    });

    const replayLog = {
      version: 1,
      seed: 321,
      events: [
        {
          seq: 1,
          turn: 0,
          type: 'battle_start',
          playerUnits: [{ id: 'p1', row: 4, col: 0, hp: 20, maxHp: 20 }],
          enemyUnits: [{ id: 'e1', row: 0, col: 0, hp: 20, maxHp: 20 }],
        },
        {
          seq: 2,
          turn: 1,
          type: 'turn_start',
          unitId: 'p1',
          playerUnits: [{ id: 'p1', row: 4, col: 0, hp: 20, maxHp: 20 }],
          enemyUnits: [{ id: 'e1', row: 0, col: 0, hp: 20, maxHp: 20 }],
        },
        { seq: 3, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 4, turn: 1, type: 'unit_hit', targetId: 'e1', damage: 12 },
        {
          seq: 5,
          turn: 2,
          type: 'turn_start',
          unitId: 'e1',
          playerUnits: [{ id: 'p1', row: 4, col: 0, hp: 20, maxHp: 20 }],
          enemyUnits: [{ id: 'e1', row: 1, col: 0, hp: 8, maxHp: 20 }],
        },
        { seq: 6, turn: 2, type: 'unit_move', unitId: 'e1', fromRow: 1, fromCol: 0, toRow: 2, toCol: 0 },
        { seq: 7, turn: 2, type: 'battle_end', playerWon: true },
      ],
    };

    await player.play(replayLog, {
      onBattleStart: (evt) => calls.push(`battle_start:${evt.resumed ? evt.checkpointSeq : 0}`),
      onTurnStart: (evt) => calls.push(`turn_start:${evt.unitId}`),
      onUnitMove: () => calls.push('unit_move'),
      onBattleEnd: () => calls.push('battle_end'),
      waitForAnimations: async () => calls.push('wait'),
    }, { startSeq: 5, turnDelay: 25 });

    assert.deepEqual(calls, [
      'battle_start:5',
      'unit_move',
      'battle_end',
    ]);
  });

  console.log('\nDone.\n');
})();