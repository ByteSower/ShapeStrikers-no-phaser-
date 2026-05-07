'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TELEMETRY_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/multiplayerTelemetry.js'), 'utf8');

const pendingTests = [];

function test(name, fn) {
  pendingTests.push(Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✅ ${name}`);
    })
    .catch((err) => {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.message}`);
      process.exitCode = 1;
    }));
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

function loadTelemetryContext(options = {}) {
  const inserts = [];
  const context = {
    console,
    JSON,
    Math,
    Date,
    PATCH_NOTES: [{ version: '1.0.5' }],
    setTimeout(fn) {
      if (typeof options.onSetTimeout === 'function') options.onSetTimeout(fn);
      return 1;
    },
    clearTimeout() {},
    localStorage: createLocalStorage(),
    navigator: {
      userAgent: 'test-agent',
      platform: 'test-platform',
    },
    location: {
      pathname: '/telemetry-test',
    },
    window: {
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
    },
    Backend: {
      isReady() {
        return options.backendReady !== false;
      },
      getUserId() {
        return options.userId || 'player-123';
      },
      getClient() {
        return {
          from(table) {
            return {
              async insert(row) {
                if (typeof options.onInsert === 'function') {
                  return options.onInsert(table, row, inserts);
                }
                inserts.push({ table, row });
                return { error: null };
              },
            };
          },
        };
      },
    },
  };

  context.window.window = context.window;
  context.window.document = context.document;
  context.window.navigator = context.navigator;
  context.window.location = context.location;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(TELEMETRY_SOURCE, context, { filename: 'multiplayerTelemetry.js' });

  return {
    Telemetry: vm.runInContext('MultiplayerTelemetry', context),
    inserts,
  };
}

console.log('\nMultiplayer telemetry tests\n');

test('record persists structured entries and clones details', () => {
  const { Telemetry } = loadTelemetryContext();
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
  const { Telemetry } = loadTelemetryContext();

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

test('flush uploads pending entries and marks them as uploaded', async () => {
  const { Telemetry, inserts } = loadTelemetryContext();

  Telemetry.record('room.lifecycle', { roomId: '11111111-1111-4111-8111-111111111111', phase: 'active' }, { level: 'warn' });
  const result = await Telemetry.flush();

  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].table, Telemetry.TELEMETRY_TABLE);
  assert.equal(inserts[0].row.room_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(inserts[0].row.event_type, 'room.lifecycle');
  assert.equal(inserts[0].row.level, 'warn');
  assert.equal(inserts[0].row.client_version, '1.0.5');
  assert.ok(Telemetry.list()[0].uploadedAt > 0);
  assert.equal(Telemetry.list()[0].lastUploadError, null);
});

test('flush stores null room_id when telemetry details carry a non-uuid fallback room id', async () => {
  const { Telemetry, inserts } = loadTelemetryContext();

  Telemetry.record('room.lifecycle', { roomId: 'live-verification-room', phase: 'active' });
  const result = await Telemetry.flush();

  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].row.room_id, null);
  assert.equal(inserts[0].row.details.roomId, 'live-verification-room');
});

test('notifyBackendReady schedules a flush for pending entries', () => {
  let scheduled = 0;
  const { Telemetry } = loadTelemetryContext({
    onSetTimeout() {
      scheduled += 1;
    },
  });

  Telemetry.record('room.resync_begin', { roomId: 'room-xyz' });
  Telemetry.notifyBackendReady();
  assert.ok(scheduled >= 2);
});

test('flush treats duplicate insert responses as already uploaded success', async () => {
  const { Telemetry } = loadTelemetryContext({
    onInsert(_table, _row, inserts) {
      inserts.push(true);
      return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    },
  });

  Telemetry.record('desync.hash_mismatch', { roomId: 'room-dup' }, { level: 'error' });
  const result = await Telemetry.flush();

  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 1);
  assert.ok(Telemetry.list()[0].uploadedAt > 0);
  assert.equal(Telemetry.list()[0].lastUploadError, null);
});

Promise.all(pendingTests).then(() => {
  if (process.exitCode) process.exit(process.exitCode);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});