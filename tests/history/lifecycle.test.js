'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../src/runHistory.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function harness({ owner = null, seed = [], storageFails = false, navigation = 'navigate', exitRun = null, saveResult = null, deleteResult = null, generationResult = null, reconnectUser = null, deferReconnectAuth = false } = {}) {
  let user = owner ? { id: owner, is_anonymous: true } : null;
  let ready = Boolean(owner);
  let authListener;
  let serial = 0;
  const rows = new Map(seed.map(row => [row.id, clone(row)]));
  const storage = new Map([['shape_strikers_history_tab', 'tab-a'], ['shape_strikers_history_flow', 'flow-a']]);
  if (owner) storage.set('shape_strikers_history_owner', owner);
  if (exitRun) storage.set('shape_strikers_history_exit_run', exitRun);
  const calls = { sent: [], reloads: 0, suspended: 0, deletions: 0 };
  const events = {};
  const context = {
    console: { warn() {} }, queueMicrotask,
    setTimeout: () => ++serial, clearTimeout() {},
    SecureIds: { create: () => `run-${++serial}` }, PATCH_NOTES: [{ version: 'test' }],
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    performance: { getEntriesByType: () => [{ type: navigation }] },
    document: { addEventListener() {} },
    window: {
      location: { reload() { calls.reloads++; } },
      addEventListener(name, callback) { events[name] = callback; },
    },
    Backend: {
      getUserId: () => user?.id || null, getUser: () => user, isReady: () => ready,
      subscribeAuth(listener) { authListener = listener; },
      suspendOutgoing() { ready = false; calls.suspended++; },
      async saveHistory(payload, ownerId) {
        calls.sent.push({ payload: clone(payload), ownerId });
        if (typeof saveResult === 'function') return saveResult(payload, ownerId);
        if (saveResult) return saveResult;
        return { ok: true, data: { revision: payload.revision, status: payload.status } };
      },
      async deleteHistory() {
        calls.deletions++;
        if (deleteResult) return deleteResult();
        return { ok: true, data: { ownerId: user.id, deleted: 2, generation: 1 } };
      },
      async fetchHistoryGeneration() {
        if (generationResult) return generationResult();
        return { ok: true, data: { ownerId: user.id, generation: 0 } };
      },
      async init() {
        ready = true;
        if (reconnectUser) user = reconnectUser;
        if (!deferReconnectAuth) await authListener({ previousId: null, user });
        return true;
      },
    },
    RunHistoryStore: {
      open: async () => {},
      list: async () => [...rows.values()].map(clone),
      async put(row) {
        if (storageFails) throw new Error('History queue is full');
        const previous = rows.get(row.id);
        if (previous?.erasureHold && previous.generation === row.generation) {
          row = { ...row, erasureHold: true, error: previous.error, permanentError: true };
        }
        rows.set(row.id, clone(row));
      },
      async acknowledge(id, sourceId, revision, status) {
        const row = rows.get(id);
        if (row?.erasureHold || row?.ownerId !== sourceId || row.payload.revision !== revision || row.payload.status !== status) return false;
        row.pending = false;
        return true;
      },
      async markError(id, revision, message, permanent) {
        const row = rows.get(id);
        if (row && !row.erasureHold && row.payload.revision === revision) Object.assign(row, { error: message, permanentError: permanent });
      },
      async holdErasure(id, sourceId, generation) {
        const row = rows.get(id);
        if (row?.ownerId === sourceId && row.generation === generation) {
          row.erasureHold = true;
          row.permanentError = true;
        }
      },
      async resolveErasure(id, sourceId, generation, discard) {
        const row = rows.get(id);
        if (!row?.erasureHold || row.ownerId !== sourceId) throw new Error('Held history unavailable');
        if (discard) rows.delete(id);
        else Object.assign(row, { generation, pending: true, erasureHold: false, permanentError: false });
      },
      async bindGuestFlow(flow, sourceId) {
        for (const row of rows.values()) {
          if (row.ownerId === null && row.guestFlowId === flow) row.ownerId = sourceId;
        }
      },
      async remove(id) { rows.delete(id); },
      async purgeOwner(sourceId, flow, selectedIds, generation) {
        let count = 0;
        for (const row of [...rows.values()]) {
          if (selectedIds.has(row.id) && (row.ownerId === sourceId || (row.ownerId === null && row.guestFlowId === flow))) {
            rows.delete(row.id);
            count++;
          } else if (row.ownerId === sourceId && !selectedIds.has(row.id) && row.generation !== generation) {
            Object.assign(row, { erasureHold: true, permanentError: true });
          }
        }
        return count;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'runHistory.js' });
  const history = vm.runInContext('RunHistory', context);
  history.init();
  return {
    history, rows, calls, events, storage,
    offline() { ready = false; },
    async notifyReconnect() { await authListener({ previousId: null, user }); },
    async change(previousId, next) {
      user = next;
      ready = Boolean(next);
      await authListener({ previousId, user });
    },
  };
}

const data = { campaignMode: 'normal', score: 0 };
const draft = (id, ownerId = null, guestFlowId = 'flow-a') => ({
  id, ownerId, guestFlowId, tabId: 'tab-a', pending: true, generation: 0,
  payload: { ...data, id, status: 'checkpointed', revision: 2, observedAt: 123, finishedAt: null },
});

test('Initial null auth does not interrupt an owned offline run; sign-out does exactly once', async () => {
  const { history, change, calls, rows, storage } = harness({ owner: 'guest-a' });
  history.start(data);
  await history.pending();
  await change(null, null);
  assert.equal(calls.reloads, 0);
  assert.equal(history.getStatus().active, true);
  await change('guest-a', null);
  await change('guest-a', null);
  assert.equal(calls.reloads, 1);
  assert.equal(calls.suspended, 1);
  assert.equal([...rows.values()][0].ownerId, 'guest-a');
  assert.equal([...rows.values()][0].payload.status, 'interrupted');
  assert.equal(storage.has('shape_strikers_history_owner'), false);
});

test('Terminal snapshots freeze once, and a replacement does not overwrite victory', async () => {
  const { history, rows } = harness();
  history.start(data);
  history.checkpoint({ score: 10 });
  history.finish('won', { score: 20 });
  history.finish('lost', { score: 99 });
  history.checkpoint({ score: 200 });
  await history.pending();
  const won = [...rows.values()][0];
  assert.equal(won.payload.status, 'won');
  assert.equal(won.payload.score, 20);
  assert.equal(won.payload.revision, 3);
  history.start(data);
  await history.pending();
  assert.equal(rows.get(won.id).payload.status, 'won');
  assert.equal(rows.size, 2);
});

test('Only explicitly bound current guest-flow records upload; other sources remain untouched', async () => {
  const { history, calls, rows } = harness({
    owner: 'guest-a',
    seed: [draft('unassigned'), draft('other-flow', null, 'flow-b'), draft('other-account', 'guest-b')],
  });
  await history.flush();
  assert.equal(calls.sent.length, 0);
  await history.bindUnassigned();
  assert.deepEqual(calls.sent.map(row => row.payload.id), ['unassigned']);
  assert.equal(rows.get('other-flow').ownerId, null);
  assert.equal(rows.get('other-account').ownerId, 'guest-b');
});

test('Failed writes remain visibly unsaved rather than interrupting gameplay', async () => {
  const { history } = harness({ storageFails: true });
  history.start(data);
  history.finish('lost');
  await history.pending();
  assert.equal(history.getStatus().storageFailed, true);
  assert.match(history.getStatus().message, /unsaved/);
  assert.equal(history.getStatus().active, false);
});

test('Linking the same guest UID still permits explicit assignment of its unassigned flow', async () => {
  const { history, change, calls, rows } = harness({ owner: 'guest-a', seed: [draft('unassigned')] });
  await change(null, { id: 'guest-a', is_anonymous: true });
  await change('guest-a', { id: 'guest-a', is_anonymous: false });
  assert.equal(calls.reloads, 0);
  assert.equal(history.getStatus().canBindUnassigned, true);
  await history.bindUnassigned();
  assert.equal(rows.get('unassigned').ownerId, 'guest-a');
});

test('A UID change discards the old guest-flow checkpoint rather than adopting its unassigned data', async () => {
  const { history, change, storage, rows, calls } = harness({ owner: 'guest-a', seed: [draft('unassigned')] });
  await change(null, { id: 'guest-a', is_anonymous: true });
  await change('guest-a', { id: 'guest-b', is_anonymous: true });
  assert.equal(calls.reloads, 1);
  assert.equal(storage.has('shape_strikers_history_flow'), false);
  assert.equal(storage.has('shape_strikers_history_guest_owner'), false);
  assert.equal(rows.get('unassigned').ownerId, null);
  await assert.rejects(() => history.bindUnassigned(), /same guest flow/);
});

test('Erasing history is blocked during a run and purges only this account and guest flow', async () => {
  const { history, rows, calls } = harness({
    owner: 'guest-a',
    seed: [draft('owned', 'guest-a'), draft('unassigned'), draft('other-flow', null, 'flow-b'), draft('other-account', 'guest-b')],
  });
  history.start(data);
  await assert.rejects(() => history.eraseHistory(), /outside a run/);
  assert.equal(calls.deletions, 0);
  history.finish('lost');
  const result = await history.eraseHistory();
  assert.equal(calls.deletions, 1);
  assert.equal(result.deleted, 2);
  assert.deepEqual([...rows.keys()].sort(), ['other-account', 'other-flow']);
});

test('Runs started while deletion is pending survive and require review', async () => {
  let finishDelete;
  const deletion = new Promise(resolve => { finishDelete = resolve; });
  const { history, rows, calls } = harness({
    owner: 'guest-a', seed: [draft('old', 'guest-a')], deleteResult: () => deletion,
  });
  const erasing = history.eraseHistory();
  history.start(data);
  history.finish('lost');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.deletions, 1);
  history.start(data);
  await history.pending();
  finishDelete({ ok: true, data: { ownerId: 'guest-a', deleted: 1, generation: 1 } });
  await erasing;
  await history.flush();
  assert.equal(rows.has('old'), false);
  const created = [...rows.values()];
  assert.equal(created.length, 2);
  assert.ok(created.every(row => row.generation === null && row.erasureHold));
  assert.equal(history.getStatus().active, true);
});

test('A run started during held-record review is recorded', async () => {
  let finishGeneration;
  const generation = new Promise(resolve => { finishGeneration = resolve; });
  const held = { ...draft('held', 'guest-a'), erasureHold: true };
  const { history, rows } = harness({ owner: 'guest-a', seed: [held], generationResult: () => generation });
  const restoring = history.resolveHeld('held', false);
  history.start(data);
  finishGeneration({ ok: true, data: { ownerId: 'guest-a', generation: 0 } });
  await restoring;
  await history.pending();
  assert.equal([...rows.values()].filter(row => row.id !== 'held').length, 1);
  assert.equal(history.getStatus().active, true);
});

test('Online event retries initialization and flushes pending history', async () => {
  const { history, events, calls, rows, offline } = harness({ owner: 'guest-a' });
  await history.flush();
  rows.set('pending', draft('pending', 'guest-a'));
  offline();
  await events.online();
  await history.flush();
  assert.equal(calls.sent.length, 1);
  assert.equal(rows.get('pending').pending, false);
});

test('Reconnect to a different account reloads before uploading its pending records', async () => {
  const { history, events, calls, rows, offline, notifyReconnect } = harness({
    owner: 'guest-a', reconnectUser: { id: 'guest-b', is_anonymous: true }, deferReconnectAuth: true,
  });
  await history.flush();
  rows.set('other', draft('other', 'guest-b'));
  offline();
  await events.online();
  assert.equal(calls.sent.length, 0);
  await notifyReconnect();
  assert.equal(calls.reloads, 1);
  assert.equal(calls.sent.length, 0);
  assert.equal(rows.get('other').pending, true);
});

test('Uploads rejected after erasure are held, not discarded or automatically retried', async () => {
  const { history, rows, calls } = harness({
    owner: 'guest-a', seed: [draft('stale', 'guest-a')],
    saveResult: { ok: false, error: 'Erased', retryable: false, erased: true },
  });
  await history.flush();
  assert.equal(rows.get('stale').erasureHold, true);
  await history.flush(true);
  assert.equal(rows.get('stale').erasureHold, true);
  assert.equal(calls.sent.length, 1);
  await history.resolveHeld('stale', true);
  assert.equal(rows.has('stale'), false);
});

test('An unknown-generation run is held until explicit restore', async () => {
  const unknown = draft('unknown', 'guest-a');
  unknown.generation = null;
  const { history, rows, calls } = harness({ owner: 'guest-a', seed: [unknown] });
  await history.flush();
  assert.equal(calls.sent.length, 0);
  assert.equal(rows.get('unknown').erasureHold, true);
  await history.resolveHeld('unknown', false);
  assert.equal(calls.sent.length, 1);
  assert.equal(rows.get('unknown').pending, false);
});

test('A checkpoint racing a stale upload remains held through later checkpoints', async () => {
  let rejectUpload;
  const deferred = new Promise(resolve => { rejectUpload = resolve; });
  const { history, rows } = harness({
    owner: 'guest-a',
    seed: [draft('stale', 'guest-a')],
    saveResult: () => deferred,
  });
  await new Promise(resolve => setImmediate(resolve));
  rows.get('stale').payload.revision++;
  rejectUpload({ ok: false, error: 'Erased', retryable: false, erased: true });
  await history.flush();
  assert.equal(rows.get('stale').erasureHold, true);
});

test('Only a witnessed owned-tab reload marks interruption at its last checkpoint', async () => {
  const recovered = harness({ navigation: 'reload', exitRun: 'old', seed: [draft('old')] });
  await recovered.history.pending();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recovered.rows.get('old').payload.status, 'interrupted');
  assert.equal(recovered.rows.get('old').payload.finishedAt, 123);
  const duplicateTab = harness({ navigation: 'navigate', exitRun: 'old', seed: [draft('old')] });
  await duplicateTab.history.pending();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(duplicateTab.rows.get('old').payload.status, 'checkpointed');
  duplicateTab.history.start(data);
  duplicateTab.events.pagehide({ persisted: true });
  assert.equal(duplicateTab.storage.has('shape_strikers_history_exit_run'), false);
});
