'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ TextEncoder });
vm.runInContext(readFileSync(resolve(__dirname, '../../src/runHistoryStore.js'), 'utf8'), context);
const store = vm.runInContext('RunHistoryStore', context);

test('Payload size matches PostgreSQL expanded scientific numbers, not minified JSON', () => {
  assert.equal(store.canonicalBytes({ damage: 1e-7 }), Buffer.byteLength('{"damage": 0.0000001}'));
  assert.equal(store.canonicalBytes({ hp: -1e-7, maxHp: 1e21 }),
    Buffer.byteLength('{"hp": -0.0000001, "maxHp": 1000000000000000000000}'));
});

test('Payload size counts structural spaces but not punctuation or exponent text inside strings', () => {
  const payload = { name: 'a,:1e-7"\\', participants: [{ hp: 1, survived: true }] };
  const canonical = '{"name": "a,:1e-7\\"\\\\", "participants": [{"hp": 1, "survived": true}]}';
  assert.equal(store.canonicalBytes(payload), Buffer.byteLength(canonical));
});
