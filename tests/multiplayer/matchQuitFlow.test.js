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

function createMockRoom() {
  let listeners = [];
  return {
    onStateChange(fn) { listeners.push(fn); },
    offStateChange(fn) { listeners = listeners.filter(listener => listener !== fn); },
    getState() { return {}; },
    syncState() { return { ok: true }; },
  };
}

global.window = global;
global.console = console;
global.ELEMENT_SYNERGIES = [];

loadModule('multiplayerGame.js');

console.log('\nMultiplayer quit flow tests\n');

test('forceMatchEnd awards the full match to the opponent when the local player quits', () => {
  global.Room = createMockRoom();
  MultiplayerGame.destroy();

  let received = null;
  MultiplayerGame.start('room-quit-1', true, 'guest-1', {
    onMatchEnd: (winner, meta) => { received = { winner, meta }; },
  });

  const ok = MultiplayerGame.forceMatchEnd('opponent', { reason: 'quit', quitter: 'me' });
  assert.equal(ok, true);
  assert.deepEqual(MultiplayerGame.getScores(), { my: 0, opp: 3 });
  assert.deepEqual(received, {
    winner: 'opponent',
    meta: { reason: 'quit', quitter: 'me' },
  });

  MultiplayerGame.destroy();
});

test('forceMatchEnd awards the full match locally when the opponent quits', () => {
  global.Room = createMockRoom();
  MultiplayerGame.destroy();

  let received = null;
  MultiplayerGame.start('room-quit-2', false, 'host-2', {
    onMatchEnd: (winner, meta) => { received = { winner, meta }; },
  });

  const ok = MultiplayerGame.forceMatchEnd('me', { reason: 'quit', quitter: 'opponent' });
  assert.equal(ok, true);
  assert.deepEqual(MultiplayerGame.getScores(), { my: 3, opp: 0 });
  assert.deepEqual(received, {
    winner: 'me',
    meta: { reason: 'quit', quitter: 'opponent' },
  });

  MultiplayerGame.destroy();
});

test('forceMatchEnd is ignored when no multiplayer match is active', () => {
  MultiplayerGame.destroy();
  assert.equal(MultiplayerGame.forceMatchEnd('me', { reason: 'quit' }), false);
});

test('guest treats host disconnect as a terminal match end policy', () => {
  global.Room = createMockRoom();
  MultiplayerGame.destroy();

  MultiplayerGame.start('room-disconnect-1', false, 'host-1', {});

  assert.equal(MultiplayerGame.shouldForceMatchEndOnOpponentDisconnect(), true);
  assert.equal(MultiplayerGame.shouldForceMatchEndOnLocalDisconnect(), false);

  MultiplayerGame.destroy();
});

test('host keeps guest disconnect reconnectable but ends on local host disconnect', () => {
  global.Room = createMockRoom();
  MultiplayerGame.destroy();

  MultiplayerGame.start('room-disconnect-2', true, 'guest-2', {});

  assert.equal(MultiplayerGame.shouldForceMatchEndOnOpponentDisconnect(), false);
  assert.equal(MultiplayerGame.shouldForceMatchEndOnLocalDisconnect(), true);

  MultiplayerGame.destroy();
});