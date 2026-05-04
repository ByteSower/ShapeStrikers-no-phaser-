'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TELEMETRY_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/multiplayerTelemetry.js'), 'utf8');

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

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function loadTelemetryContext() {
  const context = {
    console,
    JSON,
    Math,
    Date,
    localStorage: createLocalStorage(),
  };

  context.global = context;
  context.window = context;

  vm.createContext(context);
  vm.runInContext(TELEMETRY_SOURCE, context, { filename: 'multiplayerTelemetry.js' });

  return vm.runInContext('MultiplayerTelemetry', context);
}

console.log('\nMultiplayer telemetry tests\n');

test('record persists structured entries and clones details', () => {
  const Telemetry = loadTelemetryContext();
  const details = { roundNumber: 3, nested: { seq: 12 } };

  const entry = Telemetry.record('resync.requested', details, { level: 'warn' });
  details.nested.seq = 99;

  const entries = Telemetry.list();
  assert.equal(entries.length, 1);
  assert.equal(entry.type, 'resync.requested');
  assert.equal(entries[0].type, 'resync.requested');
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].details.roundNumber, 3);
  assert.equal(entries[0].details.nested.seq, 12);
});

test('record keeps only the newest bounded entries and clear resets storage', () => {
  const Telemetry = loadTelemetryContext();

  for (let index = 0; index < Telemetry.MAX_ENTRIES + 5; index++) {
    Telemetry.record('room.lifecycle', { index });
  }

  const entries = Telemetry.list();
  assert.equal(entries.length, Telemetry.MAX_ENTRIES);
  assert.equal(entries[0].details.index, 5);
  assert.equal(entries[entries.length - 1].details.index, Telemetry.MAX_ENTRIES + 4);

  Telemetry.clear();
  assert.equal(Telemetry.list().length, 0);
});