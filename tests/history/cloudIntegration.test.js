'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const configPath = process.env.SHAPE_STRIKERS_STAGING_CONFIG;
const allowWrites = process.env.SHAPE_STRIKERS_ALLOW_STAGING_WRITES === '1';
const adminKey = process.env.SHAPE_STRIKERS_STAGING_SERVICE_ROLE_KEY;

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const url = new URL(config.url);
  assert.equal(url.protocol, 'https:', 'Staging requires HTTPS');
  assert.match(url.hostname, /^[a-z0-9-]+\.supabase\.co$/, 'Use the isolated Supabase project');
  assert.equal(url.pathname, '/', 'Use a project URL, not an API path');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'Invalid project URL');
  const backend = fs.readFileSync(path.resolve(__dirname, '../../src/backend.js'), 'utf8');
  const productionUrl = backend.match(/const SUPABASE_URL\s*=\s*'([^']+)'/)[1];
  assert.notEqual(url.origin, productionUrl, 'Never run these checks against production');
  assert.ok(typeof adminKey === 'string' && adminKey, 'Set a staging-only service-role key for fixture cleanup');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(adminKey.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Fixture cleanup requires the staging project service-role JWT');
  }
  assert.equal(claims.role, 'service_role', 'Fixture cleanup key must have service_role access');
  assert.equal(claims.ref, url.hostname.split('.')[0], 'Fixture cleanup key must belong to the staging project');
  assert.ok(typeof config.publishableKey === 'string', 'Missing browser-safe key');
  if (!config.publishableKey.startsWith('sb_publishable_')) {
    let role;
    try {
      role = JSON.parse(Buffer.from(config.publishableKey.split('.')[1], 'base64url').toString('utf8')).role;
    } catch {
      throw new Error('Use a browser-safe publishable or legacy anon key');
    }
    assert.equal(role, 'anon', 'Never supply privileged keys');
  }
  assert.deepEqual(Object.keys(config).sort(), ['publishableKey', 'url'], 'Unexpected configuration fields');
  return { url: url.origin, key: config.publishableKey, adminKey };
}

function snapshot(overrides = {}) {
  const now = Date.now();
  return {
    id: randomUUID(), version: 1, revision: 1, status: 'started',
    gameVersion: 'staging-integration-test', campaignMode: 'normal',
    challengeType: null, challengeKey: null, modifierId: null,
    startedAt: now, observedAt: now, finishedAt: null, completeness: 'checkpoint',
    waveReached: 1, wavesCleared: 0, battlesResolved: 0, score: 0,
    recruits: 0, firePurchases: 0, upgradesBought: 0, damage: 0, healed: 0,
    kills: 0, bossesDefeated: 0, playerLosses: 0, iceSurvivors: 0,
    isTest: true, unitStats: [], participants: [], ...overrides,
  };
}

function terminal(draft, overrides = {}) {
  const now = Date.now();
  return {
    ...draft, revision: draft.revision + 1, status: 'won', completeness: 'complete',
    observedAt: now, finishedAt: now, wavesCleared: 1, battlesResolved: 1,
    score: 100, ...overrides,
  };
}

function canonicalBytes(value) {
  const json = JSON.stringify(value);
  let quoted = false;
  let escaped = false;
  let separators = 0;
  for (const char of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ':' || char === ',') separators++;
  }
  return Buffer.byteLength(json, 'utf8') + separators;
}

function boundarySnapshot(targetBytes) {
  const value = snapshot();
  value.participants = Array.from({ length: 64 }, (_, i) => ({
    unitId: `u${i}`, definitionId: `d${i}`, name: 'A', tier: 1, element: 'fire',
    hp: 1, maxHp: 1, survived: true,
  }));
  value.unitStats = Array.from({ length: 128 }, (_, i) => ({
    definitionId: `d${i}`, name: 'A', tier: 1, element: 'fire',
    recruits: 0, damage: 0, healed: 0, kills: 0,
  }));
  let remaining = targetBytes - canonicalBytes(value);
  for (const item of [...value.participants, ...value.unitStats]) {
    for (const key of ['unitId', 'definitionId', 'name']) {
      if (!(key in item)) continue;
      const added = Math.min(remaining, 80 - item[key].length);
      assert.ok(added >= 0, 'Boundary fixture starts above its target');
      item[key] += 'x'.repeat(added);
      remaining -= added;
    }
  }
  assert.equal(remaining, 0, 'Boundary fixture has insufficient padding capacity');
  assert.equal(canonicalBytes(value), targetBytes);
  return value;
}

test('private history integration against an explicitly authorized isolated staging project', {
  skip: !configPath || !allowWrites,
  timeout: 180000,
}, async t => {
  const config = loadConfig();
  const fixtureAccounts = new Set();
  t.after(async () => {
    const cleanupFailures = [];
    for (const id of fixtureAccounts) {
      try {
        const response = await fetch(`${config.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { apikey: config.adminKey, Authorization: `Bearer ${config.adminKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (![200, 204].includes(response.status)) cleanupFailures.push(`Fixture deletion returned HTTP ${response.status}`);
      } catch {
        cleanupFailures.push('Fixture deletion request failed');
      }
    }
    assert.deepEqual(cleanupFailures, [], 'Could not remove every disposable staging Auth fixture');
  });
  async function request(route, { token, method = 'GET', body } = {}) {
    const headers = { apikey: config.key };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${config.url}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function guest() {
    const result = await request('/auth/v1/signup', {
      method: 'POST', body: { data: { history_integration_test: true } },
    });
    if (typeof result.body?.user?.id === 'string') fixtureAccounts.add(result.body.user.id);
    assert.equal(result.status, 200, 'Anonymous staging signup must succeed');
    assert.ok(result.body.access_token, 'Anonymous signup did not return a session');
    assert.equal(result.body.user.is_anonymous, true);
    return { token: result.body.access_token, id: result.body.user.id };
  }
  async function rpc(name, body, account) {
    return request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token: account?.token });
  }
  async function save(value, account, generation = 0) {
    const result = await rpc('save_run_history', { snapshot: value, expected_generation: generation }, account);
    assert.equal(result.status, 200, 'Authorized valid snapshot must save');
    assert.equal(result.body.id, value.id);
    assert.equal(result.body.ownerId, account.id);
    return result.body;
  }
  async function detail(id, account) {
    const result = await request(`/rest/v1/run_history?id=eq.${id}&select=id,payload`, { token: account.token });
    assert.equal(result.status, 200);
    return result.body;
  }
  const a = await guest();
  const b = await guest();
  const draft = snapshot();

  await t.test('server-derived ownership, private reads and RPC-only writes', async () => {
    await save(draft, a);
    assert.equal((await detail(draft.id, a)).length, 1);
    assert.deepEqual(await detail(draft.id, b), []);
    const stolen = await rpc('save_run_history', { snapshot: draft, expected_generation: 0 }, b);
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.code, '42501');
    for (const name of ['save_run_history', 'list_run_history', 'run_history_totals']) {
      const result = await rpc(name, name === 'save_run_history' ? { snapshot: draft, expected_generation: 0 } : {});
      assert.ok([401, 403].includes(result.status), 'Unauthenticated history access must fail');
    }
    const publicRead = await request('/rest/v1/run_history?select=id');
    assert.ok([401, 403].includes(publicRead.status));
    const directWrite = await request('/rest/v1/run_history', {
      method: 'POST', token: a.token,
      body: { id: randomUUID(), owner_id: a.id, payload: draft },
    });
    assert.equal(directWrite.status, 403);
  });

  await t.test('newer drafts, terminal immutability and concurrent retries', async () => {
    const checkpoint = { ...draft, revision: 2, status: 'checkpointed', wavesCleared: 1, battlesResolved: 1 };
    await save(checkpoint, a);
    const staleAck = await save(draft, a);
    assert.equal(staleAck.revision, 2);
    assert.deepEqual((await detail(draft.id, a))[0].payload, checkpoint);
    const final = terminal(checkpoint);
    const acknowledgments = await Promise.all([save(final, a), save(final, a)]);
    assert.ok(acknowledgments.every(ack => ack.status === 'won' && ack.revision === 3));
    for (const changed of [
      { ...final, status: 'lost', revision: 4 },
      { ...checkpoint, revision: 4 },
      { ...final, score: 200 },
    ]) {
      const result = await rpc('save_run_history', { snapshot: changed, expected_generation: 0 }, a);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, '23505');
    }
    assert.deepEqual((await detail(draft.id, a))[0].payload, final);
  });

  await t.test('real payload boundary, invalid counters and mode combinations', async () => {
    const exactlyAtLimit = boundarySnapshot(32768);
    await save(exactlyAtLimit, a);
    const tooLarge = boundarySnapshot(32769);
    const oversized = await rpc('save_run_history', { snapshot: tooLarge, expected_generation: 0 }, a);
    assert.equal(oversized.status, 400);
    assert.match(oversized.body.message, /32 KiB/);
    for (const invalid of [
      snapshot({ ownerId: b.id }),
      snapshot({ recruits: -1 }),
      snapshot({ kills: '1' }),
      snapshot({ recruits: 0, firePurchases: 1 }),
      snapshot({ campaignMode: 'void', challengeType: 'daily', challengeKey: '2026-01-01' }),
      snapshot({ challengeType: 'weekly', challengeKey: '2026-W01', modifierId: null }),
      snapshot({ participants: [{ name: 'Incomplete' }] }),
    ]) {
      const result = await rpc('save_run_history', { snapshot: invalid, expected_generation: 0 }, a);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, '22023');
    }
  });

  await t.test('stable pagination, mode filters and complete-account totals', async () => {
    const records = Array.from({ length: 23 }, (_, i) => terminal(snapshot({ isTest: false }), {
      status: i % 3 === 0 ? 'lost' : 'won', damage: 10, healed: 2,
      kills: 1, recruits: 1, bossesDefeated: 1,
    }));
    records.push(terminal(snapshot({
      isTest: false, challengeType: 'daily', challengeKey: '2026-01-01',
    })));
    records.push(terminal(snapshot({
      isTest: false, challengeType: 'weekly', challengeKey: '2026-W01', modifierId: 'budget',
    })));
    records.push(terminal(snapshot({ isTest: false, campaignMode: 'void' })));
    records.push(terminal(snapshot({ isTest: false }), { status: 'abandoned', completeness: 'checkpoint' }));
    records.push(terminal(snapshot({ isTest: false }), { status: 'interrupted', completeness: 'checkpoint' }));
    for (let i = 0; i < records.length; i += 4) {
      await Promise.all(records.slice(i, i + 4).map(value => save(value, a)));
    }
    const ids = [];
    let cursor = null;
    do {
      const result = await rpc('list_run_history', {
        page_size: 20, mode_filter: 'all', include_tests: false,
        before_created_at: cursor?.createdAt || null, before_id: cursor?.id || null,
      }, a);
      assert.equal(result.status, 200);
      assert.ok(result.body.records.length <= 20);
      for (const row of result.body.records) {
        ids.push(row.id);
        assert.ok(!('participants' in row.summary) && !('unitStats' in row.summary));
      }
      cursor = result.body.hasMore ? result.body.cursor : null;
    } while (cursor);
    assert.equal(ids.length, records.length);
    assert.equal(new Set(ids).size, records.length);
    for (const mode of ['normal', 'void', 'daily', 'weekly']) {
      const page = await rpc('list_run_history', { mode_filter: mode, page_size: 20 }, a);
      assert.equal(page.status, 200);
      assert.ok(page.body.records.length > 0);
      for (const row of page.body.records) {
        if (mode === 'normal' || mode === 'void') {
          assert.equal(row.summary.campaignMode, mode);
          assert.equal(row.summary.challengeType, null);
        } else assert.equal(row.summary.challengeType, mode);
      }
    }
    const totals = await rpc('run_history_totals', {}, a);
    assert.equal(totals.status, 200);
    const completed = records.filter(value => value.status === 'won' || value.status === 'lost');
    assert.equal(totals.body.completed, completed.length);
    assert.equal(totals.body.wins, completed.filter(value => value.status === 'won').length);
    assert.equal(totals.body.losses, completed.filter(value => value.status === 'lost').length);
    assert.equal(totals.body.damage, 230);
    assert.equal(totals.body.healed, 46);
    assert.equal(totals.body.recruits, 23);
    assert.ok(totals.body.categories.some(group => group.status === 'abandoned'));
    assert.ok(totals.body.categories.some(group => group.status === 'interrupted'));
    const otherTotals = await rpc('run_history_totals', {}, b);
    assert.equal(otherTotals.status, 200);
    assert.equal(otherTotals.body.completed, 0);
    const invalidPage = await rpc('list_run_history', { page_size: 21 }, a);
    assert.equal(invalidPage.status, 400);
  });

  // Requires supabase_run_history_v1_privacy.sql.
  await t.test('owner erasure removes only own history and rejects older pending uploads', async () => {
    const owner = await guest();
    const other = await guest();
    const erasedRun = snapshot();
    const otherRun = snapshot();
    await save(erasedRun, owner);
    await save(otherRun, other);
    const anonymous = await rpc('delete_my_run_history', {});
    assert.ok([401, 403].includes(anonymous.status), 'Unauthenticated erasure must fail');
    const erased = await rpc('delete_my_run_history', {}, owner);
    assert.equal(erased.status, 200);
    assert.equal(erased.body.ownerId, owner.id);
    assert.equal(erased.body.deleted, 1);
    assert.equal(erased.body.generation, 1);
    assert.deepEqual(await detail(erasedRun.id, owner), []);
    assert.equal((await detail(otherRun.id, other)).length, 1);
    for (const skew of [-86400000, 86400000]) {
      const time = Date.now() + skew;
      const stale = await rpc('save_run_history', {
        snapshot: snapshot({ startedAt: time, observedAt: time }), expected_generation: 0,
      }, owner);
      assert.equal(stale.status, 403);
      assert.equal(stale.body.hint, 'history_erased');
      await save(snapshot({ startedAt: time, observedAt: time }), owner, 1);
    }
    const secondErasure = await rpc('delete_my_run_history', {}, owner);
    assert.equal(secondErasure.status, 200);
    assert.equal(secondErasure.body.generation, 2);
    const staleRestore = await rpc('save_run_history', {
      snapshot: snapshot(), expected_generation: 1,
    }, owner);
    assert.equal(staleRestore.status, 403);
    assert.equal(staleRestore.body.hint, 'history_erased');
    await save(snapshot(), owner, 2);
    const racingRun = snapshot();
    const [racingSave, racingErasure] = await Promise.all([
      rpc('save_run_history', { snapshot: racingRun, expected_generation: 2 }, owner),
      rpc('delete_my_run_history', {}, owner),
    ]);
    assert.ok([200, 403].includes(racingSave.status));
    if (racingSave.status === 403) assert.equal(racingSave.body.hint, 'history_erased');
    assert.equal(racingErasure.status, 200);
    assert.equal(racingErasure.body.generation, 3);
    assert.deepEqual(await detail(racingRun.id, owner), []);
    const unchecked = await rpc('save_run_history_unchecked', { snapshot: snapshot() }, owner);
    assert.ok([401, 403, 404].includes(unchecked.status), 'Unchecked save must not be callable by players');
    const admin = await rpc('admin_erase_account', { target: owner.id }, owner);
    assert.ok([401, 403, 404].includes(admin.status), 'Account erasure must not be callable by players');
  });
});
