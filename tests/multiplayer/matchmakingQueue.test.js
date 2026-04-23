'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule(rel) {
  const code = fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

function createSupabaseMock(initialStatus = 'pending') {
  let status = initialStatus;
  let subscribedHandler = null;
  const broadcasts = [];
  let reconnectCalls = 0;

  return {
    joinChannel(name, setupFn, onSubscribed) {
      subscribedHandler = onSubscribed || null;
      if (typeof setupFn === 'function') setupFn({ on() { return this; } });
    },
    leaveChannel() {},
    getChannel() {
      return status === 'closed' ? null : {};
    },
    getChannelStatus() {
      return status;
    },
    reconnectChannel() {
      reconnectCalls++;
      return true;
    },
    async broadcast(channelName, event, payload) {
      broadcasts.push({ channelName, event, payload, status });
      if (status !== 'SUBSCRIBED') return { ok: false, error: 'Channel not ready' };
      return { ok: true };
    },
    setStatus(nextStatus) {
      status = nextStatus;
    },
    fireSubscribed() {
      status = 'SUBSCRIBED';
      if (subscribedHandler) subscribedHandler({});
    },
    getReconnectCalls() {
      return reconnectCalls;
    },
    getBroadcasts() {
      return broadcasts.slice();
    },
    reset() {
      broadcasts.length = 0;
      reconnectCalls = 0;
      subscribedHandler = null;
      status = initialStatus;
    },
  };
}

global.window = global;
global.console = console;
global.Backend = {
  getUserId: () => 'player-local',
};

const supabaseMock = createSupabaseMock('pending');
global.SupabaseClient = supabaseMock;

loadModule('matchmaking.js');

console.log('\nMatchmaking queue tests\n');

(async () => {
  await test('joinQueue waits for subscription before sending join broadcast', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    Matchmaking.init();

    Matchmaking.joinQueue();
    assert.equal(Matchmaking.isSearching(), true, 'Search should stay active while channel is pending');
    assert.equal(supabaseMock.getBroadcasts().length, 0, 'No join broadcast should be sent before subscription');
    assert.equal(supabaseMock.getReconnectCalls(), 1, 'Pending join should trigger an immediate reconnect attempt');

    supabaseMock.fireSubscribed();
    await new Promise(resolve => setImmediate(resolve));

    const broadcasts = supabaseMock.getBroadcasts();
    assert.equal(broadcasts.length, 1, 'Deferred join should broadcast once channel subscribes');
    assert.equal(broadcasts[0].event, 'join');
    assert.equal(broadcasts[0].payload.playerId, 'player-local');
  });

  await test('joinQueue broadcasts immediately when the channel is already subscribed', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    Matchmaking.init();
    supabaseMock.setStatus('SUBSCRIBED');

    Matchmaking.joinQueue();
    await new Promise(resolve => setImmediate(resolve));

    const broadcasts = supabaseMock.getBroadcasts();
    assert.equal(broadcasts.length, 1, 'Subscribed queue join should broadcast immediately');
    assert.equal(broadcasts[0].event, 'join');
    assert.equal(supabaseMock.getReconnectCalls(), 0, 'Ready channels should not force reconnects');
  });
})();
