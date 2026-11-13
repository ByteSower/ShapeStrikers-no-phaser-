'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/utils/secureIds.js'), 'utf8');

function load(crypto) {
  const context = vm.createContext({
    crypto,
    Math: { random() { throw new Error('Insecure randomness must not be used'); } },
  });
  vm.runInContext(source, context);
  return vm.runInContext('SecureIds', context);
}

test('secure identifiers prefer native randomUUID', () => {
  const ids = load({
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
    getRandomValues() { throw new Error('Native UUID should be preferred'); },
  });
  assert.equal(ids.create(), '11111111-2222-4333-8444-555555555555');
});

test('getRandomValues fallback produces UUID v4 identifiers with correct version and variant bits', () => {
  let draws = 0;
  const ids = load({
    getRandomValues(bytes) {
      assert.equal(bytes.length, 16);
      return bytes.fill(draws++ ? 255 : 0);
    },
  });
  assert.equal(ids.create(), '00000000-0000-4000-8000-000000000000');
  assert.equal(ids.create(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(draws, 2);
});

test('missing cryptography fails explicitly instead of falling back to predictable identifiers', () => {
  for (const crypto of [undefined, {}]) {
    assert.throws(() => load(crypto).create(), /Secure identifiers require Web Crypto/);
  }
});

test('crypto generation errors are not hidden by a weak fallback', () => {
  const ids = load({ getRandomValues() { throw new Error('Random source failed'); } });
  assert.throws(() => ids.create(), /Random source failed/);
});
