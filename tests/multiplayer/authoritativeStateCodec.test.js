'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

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

global.window = global;
global.console = console;

loadModule('multiplayerAuthorityState.js');

console.log('\nMultiplayer authoritative state helper tests\n');

test('buildPayload clones only multiplayer authority keys in stable order', () => {
  const roomState = {
    random_key: { ignored: true },
    ready_p2: { ready: true },
    phase_event: { type: 'result_show', roundNumber: 1 },
    battle_replay: { roundNumber: 2, boardHash: 'abc' },
    prep_state: { roundNumber: 2, shopSeed: 77 },
    round_result: { roundNumber: 2, seq: 4, hostWon: true },
    prep_p1: { revision: 3 },
  };

  const payload = MultiplayerAuthorityState.buildPayload({
    roundNumber: 2,
    roomState,
    meta: { reason: 'guest-request' },
  });

  assert.equal(payload.roundNumber, 2);
  assert.deepEqual(Object.keys(payload.state), ['prep_state', 'prep_p1', 'ready_p2', 'battle_replay', 'round_result']);
  assert.equal(payload.state.random_key, undefined);
  assert.equal(payload.state.phase_event, undefined, 'Mismatched round payloads should be excluded from the authoritative bundle');

  roomState.battle_replay.boardHash = 'mutated';
  assert.equal(payload.state.battle_replay.boardHash, 'abc', 'Payload should be cloned from source room state');
  assert.equal(payload.meta.responseMode, 'full');
});

test('resolveResponseMode picks prep or battle bundles for auto recovery requests', () => {
  assert.equal(MultiplayerAuthorityState.resolveResponseMode({
    requestedMode: 'auto',
    reason: 'reload_resume',
    roundNumber: 3,
    roomState: {
      prep_state: { roundNumber: 3, shopSeed: 99 },
      prep_p1: { roundNumber: 3, gold: 10 },
    },
  }), 'prep');

  assert.equal(MultiplayerAuthorityState.resolveResponseMode({
    requestedMode: 'auto',
    reason: 'reload_resume',
    roundNumber: 4,
    roomState: {
      battle_replay: { roundNumber: 4, boardHash: 'battle' },
      playback_checkpoint: { roundNumber: 4, seq: 8 },
    },
  }), 'battle');

  assert.equal(MultiplayerAuthorityState.resolveResponseMode({
    requestedMode: 'battle',
    reason: 'reload_resume',
    roundNumber: 4,
    roomState: {
      prep_state: { roundNumber: 4, shopSeed: 12 },
      battle_replay: { roundNumber: 4, boardHash: 'battle' },
    },
  }), 'battle');
});

test('resolveResumeTarget uses saved resume context when room cache is still empty', () => {
  const target = MultiplayerAuthorityState.resolveResumeTarget({
    savedResumeContext: {
      roundNumber: 6,
      checkpointSeq: 14,
      phase: 'battle',
    },
    roomState: {},
    snapshotRound: 0,
    localWave: 1,
    trackedRound: 1,
    liveRound: 1,
  });

  assert.equal(target.roundNumber, 6);
  assert.equal(target.checkpointSeq, 14);
  assert.equal(target.requestedMode, 'battle');
});

test('resolveResumeTarget prefers fresher room state and room checkpoints over stale saved context', () => {
  const target = MultiplayerAuthorityState.resolveResumeTarget({
    savedResumeContext: {
      roundNumber: 4,
      checkpointSeq: 3,
      phase: 'prep',
    },
    roomState: {
      battle_replay: { roundNumber: 5, boardHash: 'hash-5' },
      playback_checkpoint: { roundNumber: 5, seq: 11 },
    },
    snapshotRound: 2,
    localWave: 2,
    trackedRound: 3,
    liveRound: 3,
  });

  assert.equal(target.roundNumber, 5);
  assert.equal(target.checkpointSeq, 11);
  assert.equal(target.requestedMode, 'battle');
});

test('buildPayload can emit battle-only bundles for replay/bootstrap recovery', () => {
  const payload = MultiplayerAuthorityState.buildPayload({
    roundNumber: 5,
    mode: 'battle',
    roomState: {
      prep_state: { roundNumber: 5, shopSeed: 33 },
      prep_p1: { roundNumber: 5, gold: 7 },
      battle_replay: { roundNumber: 5, boardHash: 'hash-5' },
      playback_checkpoint: { roundNumber: 5, seq: 13 },
      phase_event: { roundNumber: 5, type: 'playback_start' },
      round_result: { roundNumber: 5, seq: 14, hostWon: true },
    },
    meta: { reason: 'missing_battle_replay' },
  });

  assert.deepEqual(Object.keys(payload.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ]);
  assert.equal(payload.meta.responseMode, 'battle');
});

test('getEntries returns keys in apply order for guest cache hydration', () => {
  const entries = MultiplayerAuthorityState.getEntries({
    roundNumber: 3,
    state: {
      round_result: { seq: 8 },
      phase_event: { type: 'playback_start' },
      playback_checkpoint: { seq: 5 },
      battle_replay: { boardHash: 'xyz' },
      prep_p2: { revision: 1 },
    },
  });

  assert.deepEqual(entries.map(entry => entry.key), [
    'prep_p2',
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ]);
});

test('shouldRequestResync only allows unresolved mismatches', () => {
  assert.equal(MultiplayerAuthorityState.shouldRequestResync({
    guestBoardHash: 'guest-1',
    hostBoardHash: 'host-1',
  }), true, 'Plain mismatch should request resync');

  assert.equal(MultiplayerAuthorityState.shouldRequestResync({
    guestBoardHash: 'same',
    hostBoardHash: 'same',
  }), false, 'Matching hashes should not request resync');

  assert.equal(MultiplayerAuthorityState.shouldRequestResync({
    guestBoardHash: 'guest-2',
    hostBoardHash: 'host-2',
    seq: 9,
    lastRequestedSeq: 9,
  }), false, 'The same seq should not spam repeated requests');

  assert.equal(MultiplayerAuthorityState.shouldRequestResync({
    guestBoardHash: 'guest-3',
    hostBoardHash: 'host-3',
    seq: 11,
    authoritativeSeq: 11,
  }), false, 'An already-authoritative seq should not request again');
});

test('buildRequest normalizes hashes and optional seq', () => {
  const withSeq = MultiplayerAuthorityState.buildRequest({
    roundNumber: 4,
    seq: 12,
    reason: 'round_result_hash_mismatch',
    mode: 'battle',
    guestBoardHash: 123,
    hostBoardHash: 456,
    checkpointSeq: 7,
  });
  assert.equal(withSeq.roundNumber, 4);
  assert.equal(withSeq.seq, 12);
  assert.equal(withSeq.mode, 'battle');
  assert.equal(withSeq.guestBoardHash, '123');
  assert.equal(withSeq.hostBoardHash, '456');
  assert.equal(withSeq.checkpointSeq, 7);

  const withoutSeq = MultiplayerAuthorityState.buildRequest({
    roundNumber: 4,
    reason: 'replay_hash_mismatch',
  });
  assert.equal('seq' in withoutSeq, false, 'Zero/empty seq should be omitted');
  assert.equal(withoutSeq.mode, 'auto');
});

test('getRequestModeForReason classifies replay/bootstrap reasons without guessing prep state', () => {
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('missing_battle_replay'), 'battle');
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('replay_hash_mismatch'), 'battle');
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('round_result_hash_mismatch'), 'battle');
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('waiting_for_round_result'), 'battle');
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('reload_resume'), 'auto');
  assert.equal(MultiplayerAuthorityState.getRequestModeForReason('manual-browser-test'), 'full');
});