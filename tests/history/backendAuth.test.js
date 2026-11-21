'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../src/backend.js'), 'utf8');
const staging = { url: 'https://history-test-only.supabase.co', publishableKey: 'sb_publishable_test_only' };

function harness({ configured = true, active = false, verifyThroughFetch = false, sessionFailures = 0 } = {}) {
  let session = { user: { id: 'guest-a', is_anonymous: true }, access_token: 'test-token-a' };
  let authListener;
  let fetchImpl = async url => ({
    ok: true, json: async () => url.endsWith('/auth/v1/user') ? { id: session.user.id } : { records: [] },
  });
  const calls = { clients: [], requests: [], otp: [], updates: [], verified: [], cleared: 0, left: 0 };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, AbortSignal, AbortController, DOMException, setTimeout, clearTimeout,
    localStorage: { getItem: () => null },
    window: {
      location: { hostname: '127.0.0.1', search: '?staging=1' },
      ...(configured ? { SHAPE_STRIKERS_STAGING_CONFIG: staging } : {}),
    },
    RunHistory: { getStatus: () => ({ active }) },
    Room: { clearSavedSession() { calls.cleared++; } },
    SupabaseClient: { leaveAll() { calls.left++; } },
    fetch: async (url, options) => {
      assert.ok(url.startsWith(`${staging.url}/rest/v1/`) || [ `${staging.url}/auth/v1/user`, `${staging.url}/auth/v1/verify` ].includes(url),
        'Tests must never request production');
      calls.requests.push({ url, options });
      return fetchImpl(url, options);
    },
    supabase: {
      createClient(url, key, options) {
        assert.equal(url, staging.url);
        calls.clients.push({ url, key });
        return { auth: {
          onAuthStateChange(listener) { authListener = listener; },
          async getSession() {
            if (sessionFailures > 0) { sessionFailures--; throw new Error('Offline'); }
            return { data: { session } };
          },
          async updateUser(options) { calls.updates.push(options); return { error: null }; },
          async signInWithOtp(options) { calls.otp.push(options); return { error: null }; },
          async verifyOtp(parameters) {
            calls.verified.push(parameters);
            if (!verifyThroughFetch) return { data: { user: session.user }, error: null };
            const response = await options.global.fetch(`${staging.url}/auth/v1/verify`, {
              method: 'POST', body: JSON.stringify(parameters),
            });
            const body = await response.json();
            if (!response.ok) return { data: {}, error: { message: 'Invalid verification code' } };
            session = { user: body.user, access_token: 'test-verified-token' };
            authListener('SIGNED_IN', session);
            return { data: { user: session.user }, error: null };
          },
        } };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'backend.js' });
  return {
    backend: vm.runInContext('Backend', context), calls,
    respond(implementation) { fetchImpl = implementation; },
    change(user) {
      session = user ? { user, access_token: `test-token-${user.id}` } : null;
      authListener('SIGNED_IN', session);
    },
  };
}

const drainNotifications = () => new Promise(resolve => setTimeout(resolve, 10));

test('Backend loads, initializes once, and only notifies a newly added ready subscriber', async () => {
  const { backend, calls } = harness();
  assert.equal(await backend.init(), true);
  assert.equal(await backend.init(), true);
  assert.equal(calls.clients.length, 1);
  await drainNotifications();
  let first = 0;
  let second = 0;
  backend.subscribeAuth(() => { first++; });
  await drainNotifications();
  backend.subscribeAuth(() => { second++; });
  await drainNotifications();
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal((await backend.fetchHistory()).ok, true);
});

test('Explicit staging without settings fails closed before creating a client', async () => {
  const { backend, calls } = harness({ configured: false });
  assert.equal(await backend.init(), false);
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.requests.length, 0);
});

test('Failed startup can retry without creating a second auth client', async () => {
  const { backend, calls } = harness({ sessionFailures: 1 });
  assert.equal(await backend.init(), false);
  const [first, second] = await Promise.all([backend.init(), backend.init()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls.clients.length, 1);
});

test('History pins the source token and discards a response after account switching', async () => {
  const { backend, calls, respond, change } = harness();
  await backend.init();
  respond(async () => {
    change({ id: 'guest-b', is_anonymous: true });
    return { ok: true, json: async () => ({ records: ['old-account-data'] }) };
  });
  const result = await backend.fetchHistory();
  assert.equal(calls.requests[0].options.headers.Authorization, 'Bearer test-token-a');
  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(backend.isReady(), false);
  assert.equal(backend.getClient(), null);
  assert.equal(calls.cleared, 1);
  assert.equal(calls.left, 1);
  assert.equal((await backend.saveHistory({ id: 'run-a' }, 'guest-a')).ok, false);
  assert.equal(calls.requests.length, 1);
});

test('Guest linking keeps its UID and existing-account sign-in requires confirmation', async () => {
  const { backend, calls } = harness();
  await backend.init();
  assert.equal((await backend.requestLinkEmail('player@example.test')).ok, true);
  assert.equal(calls.requests[0].options.headers.Authorization, 'Bearer test-token-a');
  assert.equal((await backend.verifyAccountCode({
    email: 'player@example.test', token: '123456', kind: 'link', sourceId: 'guest-a',
  })).ok, true);
  assert.equal(calls.verified[0].type, 'email_change');
  assert.equal((await backend.requestExistingAccount('player@example.test', false)).ok, false);
  assert.equal(calls.otp.length, 0);
  assert.equal((await backend.requestExistingAccount('player@example.test', true)).ok, true);
  assert.equal(calls.otp[0].options.shouldCreateUser, false);
});

test('Account actions cannot start during an active run', async () => {
  const { backend, calls } = harness({ active: true });
  await backend.init();
  assert.equal((await backend.requestLinkEmail('player@example.test')).ok, false);
  assert.equal((await backend.requestExistingAccount('player@example.test', true)).ok, false);
  assert.equal((await backend.deleteHistory()).ok, false);
  assert.equal(calls.updates.length + calls.otp.length + calls.requests.length, 0);
});

test('History export pages every owned record with the pinned source token', async () => {
  const { backend, calls, respond } = harness();
  await backend.init();
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: `run-${i}` }));
  respond(async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, json: async () => rows.slice(offset, offset + 100) };
  });
  const result = await backend.exportHistory();
  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, 'guest-a');
  assert.deepEqual([...result.data.records.map(row => row.id)], rows.map(row => row.id));
  assert.equal(calls.requests.length, 2);
  assert.ok(calls.requests.every(request => request.options.headers.Authorization === 'Bearer test-token-a'));
});

test('History deletion requires a matching acknowledgment and reports erased-upload rejections', async () => {
  const { backend, calls, respond } = harness();
  await backend.init();
  assert.equal((await backend.deleteHistory('guest-b')).ok, false);
  assert.equal(calls.requests.length, 0);
  respond(async () => ({ ok: true, json: async () => ({ ownerId: 'guest-b', deleted: 3 }) }));
  assert.equal((await backend.deleteHistory()).ok, false);
  respond(async () => ({ ok: true, json: async () => ({ ownerId: 'guest-a', deleted: 3, generation: 1 }) }));
  assert.equal((await backend.deleteHistory()).data.deleted, 3);
  respond(async () => ({
    ok: false, status: 403, json: async () => ({ code: '42501', message: 'Erased', hint: 'history_erased' }),
  }));
  const rejected = await backend.saveHistory({ id: 'run-a' }, 'guest-a');
  assert.equal(rejected.erased, true);
  assert.equal(rejected.retryable, false);
});

test('History generation is source-bound and sent with a snapshot', async () => {
  const { backend, calls, respond } = harness();
  await backend.init();
  respond(async () => ({ ok: true, json: async () => ({ ownerId: 'guest-b', generation: 1 }) }));
  assert.equal((await backend.fetchHistoryGeneration('guest-a')).ok, false);
  respond(async () => ({ ok: true, json: async () => ({ ownerId: 'guest-a', generation: 1 }) }));
  assert.equal((await backend.fetchHistoryGeneration('guest-a')).data.generation, 1);
  respond(async () => ({ ok: true, json: async () => ({ id: 'run-a', ownerId: 'guest-a' }) }));
  assert.equal((await backend.saveHistory({ id: 'run-a' }, 'guest-a', 1)).ok, true);
  assert.equal(JSON.parse(calls.requests.at(-1).options.body).expected_generation, 1);
});

test('Cancelling code verification aborts the SDK transport without selecting an account', async () => {
  const { backend, calls, respond } = harness({ verifyThroughFetch: true });
  await backend.init();
  respond(async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }));
  const verification = backend.verifyAccountCode({
    email: 'player@example.test', token: '123456', kind: 'existing', sourceId: 'guest-a',
  });
  backend.cancelCodeVerification();
  assert.equal((await verification).ok, false);
  assert.equal(calls.verified.length, 1);
  assert.equal(backend.getUserId(), 'guest-a');
});

test('A link code for another guest is rejected before the SDK can change the session', async () => {
  const { backend, respond } = harness({ verifyThroughFetch: true });
  await backend.init();
  const body = { user: { id: 'guest-b', is_anonymous: false } };
  respond(async () => ({
    ok: true, clone: () => ({ json: async () => body }), json: async () => body,
  }));
  assert.equal((await backend.verifyAccountCode({
    email: 'player@example.test', token: '123456', kind: 'link', sourceId: 'guest-a',
  })).ok, false);
  assert.equal(backend.getUserId(), 'guest-a');
});

test('An intended existing-account verification selects its target and suspends outgoing traffic', async () => {
  const { backend, respond } = harness({ verifyThroughFetch: true });
  await backend.init();
  const body = { user: { id: 'linked-account', is_anonymous: false } };
  respond(async () => ({
    ok: true, clone: () => ({ json: async () => body }), json: async () => body,
  }));
  const result = await backend.verifyAccountCode({
    email: 'player@example.test', token: '123456', kind: 'existing', sourceId: 'guest-a',
  });
  assert.equal(result.ok, true);
  assert.equal(backend.getUserId(), 'linked-account');
  assert.equal(backend.isReady(), false);
});

test('Sign-out without pending verification safely suspends the client', async () => {
  const { backend, change } = harness();
  await backend.init();
  change(null);
  assert.equal(backend.getUserId(), null);
  assert.equal(backend.getClient(), null);
  assert.equal(backend.isReady(), false);
});

test('Sign-out during a held match pauses REST but defers realtime teardown until release', async () => {
  const { backend, calls, change } = harness();
  await backend.init();
  backend.holdRealtime();
  let released = false;
  backend.whenRealtimeReleased().then(() => { released = true; });
  change(null);
  await drainNotifications();
  assert.equal(backend.isReady(), false);
  assert.equal(backend.isRealtimeSuspendDeferred(), true);
  assert.equal(calls.left + calls.cleared, 0);
  assert.equal(released, false);
  backend.releaseRealtime();
  await drainNotifications();
  assert.equal(calls.left, 1);
  assert.equal(calls.cleared, 1);
  assert.equal(backend.isRealtimeSuspendDeferred(), false);
  assert.equal(released, true);
});
