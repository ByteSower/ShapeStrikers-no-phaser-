'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function harness({ rows, owner, ready, online }) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        textContent: '', checked: false, value: 'all',
        classList: {
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        },
        addEventListener() {}, replaceChildren() {}, setAttribute() {},
      });
    }
    return elements.get(id);
  }
  let notify;
  const context = vm.createContext({
    console, navigator: { onLine: online },
    document: { getElementById: element },
    Backend: {
      getUserId: () => owner, getUser: () => owner ? { id: owner, is_anonymous: true } : null,
      isReady: () => ready, subscribeAuth() {},
    },
    RunHistory: {
      getStatus: () => ({ active: false, guestFlowId: 'flow', message: 'Pending', canBindUnassigned: false }),
      pending: async () => rows.filter(row => row.pending),
      subscribe(listener) { notify = listener; },
    },
  });
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/runHistoryUI.js'), 'utf8'), context);
  vm.runInContext('RunHistoryUI.init()', context);
  return { element, notify: () => notify() };
}

test('A failed upload remains visible outside History until it is resolved', async () => {
  const row = { ownerId: 'owner-a', pending: true, error: 'Rejected', permanentError: true };
  const { element, notify } = harness({ rows: [row], owner: 'owner-a', ready: true, online: true });
  await new Promise(resolve => setImmediate(resolve));
  const status = element('history-title-status');
  assert.equal(status.classList.contains('hidden'), false);
  assert.match(status.textContent, /could not sync/);
  row.pending = false;
  notify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.classList.contains('hidden'), true);
});

test('Offline unassigned history remains visible after a run ends', async () => {
  const row = { ownerId: null, guestFlowId: 'flow', pending: true };
  const { element, notify } = harness({ rows: [row], owner: null, ready: false, online: false });
  await new Promise(resolve => setImmediate(resolve));
  const status = element('history-title-status');
  assert.equal(status.classList.contains('hidden'), false);
  assert.match(status.textContent, /pending.*reconnect/i);
  row.pending = false;
  notify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.classList.contains('hidden'), true);
});
