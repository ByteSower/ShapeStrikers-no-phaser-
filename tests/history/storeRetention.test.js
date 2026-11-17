'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('Acknowledgement prunes synced results without deleting held records', async () => {
  const entries = new Map();
  const entry = (id, observedAt, pending, erasureHold = false) => ({
    id, ownerId: 'owner', pending, erasureHold,
    payload: { id, revision: 1, status: 'won', observedAt },
  });
  entries.set('held', entry('held', 0, false, true));
  for (let i = 1; i <= 50; i++) entries.set(`synced-${i}`, entry(`synced-${i}`, i, false));
  entries.set('new', entry('new', 51, true));

  const db = {
    createObjectStore() {},
    transaction() {
      let outstanding = 0;
      const tx = {};
      function request(result) {
        const operation = {};
        outstanding++;
        queueMicrotask(() => {
          operation.onsuccess?.({ target: { result: result() } });
          outstanding--;
          queueMicrotask(() => { if (!outstanding) tx.oncomplete(); });
        });
        return operation;
      }
      tx.objectStore = () => ({
        get: id => request(() => entries.get(id)),
        getAll: () => request(() => [...entries.values()]),
        put: row => entries.set(row.id, row),
        delete: id => entries.delete(id),
      });
      return tx;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
      return request;
    },
  };
  const context = vm.createContext({ indexedDB, TextEncoder, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/runHistoryStore.js'), 'utf8'), context);
  const store = vm.runInContext('RunHistoryStore', context);
  assert.equal(await store.acknowledge('new', 'owner', 1, 'won'), true);
  assert.equal(entries.has('held'), true);
  assert.equal(entries.has('synced-1'), false);
  assert.equal(entries.size, 51);
});
