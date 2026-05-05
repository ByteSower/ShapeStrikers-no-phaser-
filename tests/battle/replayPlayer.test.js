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

  // ── getResumePoint ──────────────────────────────────────────────────────────

  await test('getResumePoint: startSeq=0 returns startIndex=0 and no checkpoint', async () => {
    const log = {
      version: 1,
      seed: 1,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1' },
      ],
    };
    const result = BattleReplay.getResumePoint(log, 0);
    assert.equal(result.startIndex, 0);
    assert.equal(result.checkpoint, null);
    assert.equal(result.orderedEvents.length, 2);
  });

  await test('getResumePoint: picks the latest snapshot at or before startSeq', async () => {
    const log = {
      version: 1,
      seed: 2,
      events: [
        { seq: 1, turn: 0, type: 'battle_start', playerUnits: [], enemyUnits: [] },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1', playerUnits: [], enemyUnits: [] },
        { seq: 3, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 4, turn: 2, type: 'turn_start', unitId: 'e1', playerUnits: [], enemyUnits: [] },
        { seq: 5, turn: 2, type: 'battle_end', playerWon: true },
      ],
    };
    // Requesting startSeq=3 should checkpoint at seq=2 (last turn_start snapshot before 3)
    const result = BattleReplay.getResumePoint(log, 3);
    assert.equal(result.checkpoint.seq, 2, 'Should use seq=2 turn_start as checkpoint');
    // startIndex should point to the event AFTER the checkpoint
    assert.equal(result.startIndex, 2, 'startIndex should be the index after the checkpoint');
  });

  await test('getResumePoint: falls back to battle_start snapshot when no turn_start precedes startSeq', async () => {
    const log = {
      version: 1,
      seed: 3,
      events: [
        { seq: 1, turn: 0, type: 'battle_start', playerUnits: [], enemyUnits: [] },
        { seq: 2, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
      ],
    };
    // No turn_start exists; should fall back to battle_start
    const result = BattleReplay.getResumePoint(log, 2);
    assert.ok(result.checkpoint, 'Should find a checkpoint');
    assert.equal(result.checkpoint.type, 'battle_start');
  });

  await test('getResumePoint: throws when events array is missing', async () => {
    assert.throws(
      () => BattleReplay.getResumePoint(null, 0),
      /replay log/
    );
    assert.throws(
      () => BattleReplay.getResumePoint({ events: 'not-an-array' }, 0),
      /replay log/
    );
  });

  await test('getResumePoint: checkpoint is null when no snapshot events exist and startSeq > 0', async () => {
    const log = {
      version: 1,
      seed: 4,
      events: [
        { seq: 1, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 2, turn: 1, type: 'unit_hit', targetId: 'e1', damage: 5 },
      ],
    };
    const result = BattleReplay.getResumePoint(log, 2);
    assert.equal(result.checkpoint, null);
    assert.equal(result.startIndex, 0);
  });

  // ── Player.isPlaying() ──────────────────────────────────────────────────────

  await test('isPlaying() is false before play() is called', async () => {
    const player = BattleReplay.createPlayer({ sleep: async () => {} });
    assert.equal(player.isPlaying(), false);
  });

  await test('isPlaying() is false after play() completes', async () => {
    const player = BattleReplay.createPlayer({ sleep: async () => {} });
    const log = {
      version: 1,
      seed: 5,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'battle_end', playerWon: true },
      ],
    };
    await player.play(log, {});
    assert.equal(player.isPlaying(), false);
  });

  // ── Player.stop() ──────────────────────────────────────────────────────────

  await test('stop() halts playback and result.stopped is true', async () => {
    const calls = [];
    const player = BattleReplay.createPlayer({ sleep: async () => {} });

    const log = {
      version: 1,
      seed: 6,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1' },
        { seq: 3, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 4, turn: 2, type: 'battle_end', playerWon: true },
      ],
    };

    const result = await player.play(log, {
      onBattleStart: () => { calls.push('battle_start'); player.stop(); },
      onTurnStart:   () => calls.push('turn_start'),
      onUnitAttack:  () => calls.push('unit_attack'),
      onBattleEnd:   () => calls.push('battle_end'),
    });

    assert.ok(result.stopped, 'result.stopped should be true after stop()');
    // After stop(), no further events should have been dispatched
    assert.equal(calls.length, 1, 'Only battle_start should have been dispatched before stop');
    assert.equal(calls[0], 'battle_start');
  });

  // ── onEvent generic handler ─────────────────────────────────────────────────

  await test('onEvent handler is called for every event', async () => {
    const eventTypes = [];
    const player = BattleReplay.createPlayer({ sleep: async () => {} });

    const log = {
      version: 1,
      seed: 7,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1' },
        { seq: 3, turn: 1, type: 'unit_attack', attackerId: 'p1', targetId: 'e1' },
        { seq: 4, turn: 2, type: 'battle_end', playerWon: false },
      ],
    };

    await player.play(log, {
      onEvent: (evt) => eventTypes.push(evt.type),
    });

    assert.deepEqual(eventTypes, ['battle_start', 'turn_start', 'unit_attack', 'battle_end']);
  });

  await test('onEvent and specific handlers are both called for the same event', async () => {
    const calls = [];
    const player = BattleReplay.createPlayer({ sleep: async () => {} });

    const log = {
      version: 1,
      seed: 8,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'battle_end', playerWon: true },
      ],
    };

    await player.play(log, {
      onEvent:      (evt) => calls.push(`onEvent:${evt.type}`),
      onBattleStart: () => calls.push('onBattleStart'),
      onBattleEnd:   () => calls.push('onBattleEnd'),
    });

    assert.deepEqual(calls, [
      'onEvent:battle_start',
      'onBattleStart',
      'onEvent:battle_end',
      'onBattleEnd',
    ]);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  await test('play() throws when passed null', async () => {
    const player = BattleReplay.createPlayer();
    await assert.rejects(
      async () => player.play(null, {}),
      /replay log/
    );
  });

  await test('play() throws when events is not an array', async () => {
    const player = BattleReplay.createPlayer();
    await assert.rejects(
      async () => player.play({ events: 'bad' }, {}),
      /replay log/
    );
  });

  await test('play() handles empty events array without throwing', async () => {
    const player = BattleReplay.createPlayer({ sleep: async () => {} });
    const result = await player.play({ events: [], seed: 0 }, {});
    assert.equal(result.stopped, false);
  });

  await test('play() handles unknown event types gracefully (no throw)', async () => {
    const player = BattleReplay.createPlayer({ sleep: async () => {} });
    const log = {
      version: 1,
      seed: 9,
      events: [
        { seq: 1, turn: 0, type: 'unknown_event_xyz' },
        { seq: 2, turn: 1, type: 'battle_end', playerWon: true },
      ],
    };
    await assert.doesNotReject(async () => {
      await player.play(log, { onBattleEnd: () => {} });
    });
  });

  // ── turnDelay=0 skips sleep ─────────────────────────────────────────────────

  await test('turnDelay=0 never calls sleep', async () => {
    let sleptCount = 0;
    const player = BattleReplay.createPlayer({ sleep: async () => { sleptCount++; } });

    const log = {
      version: 1,
      seed: 10,
      events: [
        { seq: 1, turn: 0, type: 'battle_start' },
        { seq: 2, turn: 1, type: 'turn_start', unitId: 'p1' },
        { seq: 3, turn: 2, type: 'turn_start', unitId: 'e1' },
        { seq: 4, turn: 3, type: 'battle_end', playerWon: true },
      ],
    };

    await player.play(log, {}, { turnDelay: 0 });
    assert.equal(sleptCount, 0, 'sleep should not be called when turnDelay=0');
  });

  // ── Stop and resume integration test (from main) ───────────────────────────

  await test('Replay stop reports stopped and a later resume can continue from the checkpoint tail', async () => {
    const firstRunCalls = [];
    const replayLog = {
      version: 1,
      seed: 777,
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
        {
          seq: 4,
          turn: 2,
          type: 'turn_start',
          unitId: 'e1',
          playerUnits: [{ id: 'p1', row: 4, col: 0, hp: 20, maxHp: 20 }],
          enemyUnits: [{ id: 'e1', row: 1, col: 0, hp: 8, maxHp: 20 }],
        },
        { seq: 5, turn: 2, type: 'unit_move', unitId: 'e1', fromRow: 1, fromCol: 0, toRow: 2, toCol: 0 },
        { seq: 6, turn: 2, type: 'battle_end', playerWon: true },
      ],
    };

    const firstPlayer = BattleReplay.createPlayer({
      sleep: async () => { firstRunCalls.push('sleep'); },
    });

    const stoppedResult = await firstPlayer.play(replayLog, {
      onBattleStart: () => firstRunCalls.push('battle_start'),
      onTurnStart: (evt) => {
        firstRunCalls.push(`turn_start:${evt.unitId}`);
        if (evt.seq === 4) firstPlayer.stop();
      },
      onUnitAttack: () => firstRunCalls.push('unit_attack'),
      onUnitMove: () => firstRunCalls.push('unit_move'),
      onBattleEnd: () => firstRunCalls.push('battle_end'),
      waitForAnimations: async () => firstRunCalls.push('wait'),
    }, { turnDelay: 25 });

    assert.equal(stoppedResult.stopped, true, 'Stopped replay should report stopped=true');
    assert.deepEqual(firstRunCalls, [
      'battle_start',
      'turn_start:p1',
      'unit_attack',
      'wait',
      'sleep',
      'turn_start:e1',
    ]);

    const resumedCalls = [];
    const resumedPlayer = BattleReplay.createPlayer({
      sleep: async () => { resumedCalls.push('sleep'); },
    });

    const resumedResult = await resumedPlayer.play(replayLog, {
      onBattleStart: (evt) => resumedCalls.push(`battle_start:${evt.resumed ? evt.checkpointSeq : 0}`),
      onUnitMove: () => resumedCalls.push('unit_move'),
      onBattleEnd: () => resumedCalls.push('battle_end'),
      waitForAnimations: async () => resumedCalls.push('wait'),
    }, { startSeq: 4, turnDelay: 25 });

    assert.equal(resumedResult.stopped, false, 'Resumed replay should complete normally');
    assert.deepEqual(resumedCalls, [
      'battle_start:4',
      'unit_move',
      'battle_end',
    ]);
  });

  console.log('\nDone.\n');
})();