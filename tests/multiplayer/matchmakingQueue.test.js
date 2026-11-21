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
  const broadcastHandlers = new Map();
  let reconnectCalls = 0;

  return {
    joinChannel(name, setupFn, onSubscribed) {
      subscribedHandler = onSubscribed || null;
      if (typeof setupFn === 'function') {
        setupFn({
          on(type, filter, handler) {
            if (type === 'broadcast' && filter?.event && typeof handler === 'function') {
              broadcastHandlers.set(filter.event, handler);
            }
            return this;
          },
        });
      }
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
    fireBroadcast(event, payload) {
      const handler = broadcastHandlers.get(event);
      if (handler) handler({ payload });
    },
    getReconnectCalls() {
      return reconnectCalls;
    },
    getBroadcasts() {
      return broadcasts.slice();
    },
    reset() {
      broadcasts.length = 0;
      broadcastHandlers.clear();
      reconnectCalls = 0;
      subscribedHandler = null;
      status = initialStatus;
    },
  };
}

function createMissingRoomRecordClient() {
  return {
    from(tableName) {
      assert.equal(tableName, 'mp_rooms');
      return {
        insert() {
          return {
            select() {
              return {
                async single() {
                  return {
                    data: null,
                    error: {
                      code: 'PGRST205',
                      message: "Could not find the table 'public.mp_rooms' in the schema cache",
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function createMissingRoomRecordMessageOnlyClient() {
  return {
    from(tableName) {
      assert.equal(tableName, 'mp_rooms');
      return {
        insert() {
          return {
            select() {
              return {
                async single() {
                  return {
                    data: null,
                    error: {
                      message: "Could not find the table 'public.mp_rooms' in the schema cache",
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

global.window = global;
global.console = console;
let backendClient = null;
global.Backend = {
  getUserId: () => 'player-local',
  getClient: () => backendClient,
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

  await test('host pairing falls back cleanly when mp_rooms is unavailable', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    backendClient = createMissingRoomRecordClient();
    Matchmaking.init();
    supabaseMock.setStatus('SUBSCRIBED');

    const matches = [];
    const onMatch = detail => matches.push(detail);
    Matchmaking.onMatchFound(onMatch);

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);

    try {
      Matchmaking.joinQueue();
      await new Promise(resolve => setImmediate(resolve));

      supabaseMock.fireBroadcast('join', { playerId: 'zzzz-remote' });
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(matches.length, 1, 'Fallback pairing should still emit a match');
      assert.equal(matches[0].isHost, true, 'Local player should still host when its id sorts first');
      assert.equal(matches[0].opponentId, 'zzzz-remote');
      assert.equal(typeof matches[0].roomId, 'string');
      assert.notEqual(matches[0].roomId.length, 0, 'Fallback pairing should provide a room id');

      const matchFoundBroadcasts = supabaseMock.getBroadcasts().filter(entry => entry.event === 'match_found');
      assert.equal(matchFoundBroadcasts.length, 1, 'Fallback pairing should still broadcast match_found');
      assert.equal(warnings.length, 0, 'Missing optional mp_rooms table should not emit a warning');
    } finally {
      console.warn = originalWarn;
      Matchmaking.offMatchFound(onMatch);
      backendClient = null;
    }
  });

  await test('host pairing also treats message-only missing mp_rooms errors as fallback-only', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    backendClient = createMissingRoomRecordMessageOnlyClient();
    Matchmaking.init();
    supabaseMock.setStatus('SUBSCRIBED');

    const matches = [];
    const onMatch = detail => matches.push(detail);
    Matchmaking.onMatchFound(onMatch);

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);

    try {
      Matchmaking.joinQueue();
      await new Promise(resolve => setImmediate(resolve));

      supabaseMock.fireBroadcast('join', { playerId: 'zzzz-remote' });
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(matches.length, 1, 'Message-only missing-table errors should still emit a match');
      assert.equal(warnings.length, 0, 'Message-only missing-table errors should not emit a warning');
    } finally {
      console.warn = originalWarn;
      Matchmaking.offMatchFound(onMatch);
      backendClient = null;
    }
  });

  await test('v2 host waits for match_accept, and re-queues when an offer goes unanswered', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    Matchmaking.init();
    supabaseMock.setStatus('SUBSCRIBED');
    const matches = [];
    const onMatch = detail => matches.push(detail);
    Matchmaking.onMatchFound(onMatch);
    const timers = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    try {
      Matchmaking.joinQueue();
      await flush();
      supabaseMock.fireBroadcast('join', { playerId: 'zzzz-stale', v: 2 });
      await flush();
      let offers = supabaseMock.getBroadcasts().filter(b => b.event === 'match_found');
      assert.equal(offers.length, 1);
      assert.equal(offers[0].payload.confirm, true);
      assert.equal(matches.length, 0, 'Host must not enter the room before the guest confirms');

      while (timers.length) timers.shift()();
      await flush();
      offers = supabaseMock.getBroadcasts().filter(b => b.event === 'match_found');
      assert.equal(offers.length, 3, 'Offer is resent before giving up');
      assert.equal(Matchmaking.isSearching(), true, 'Unanswered offer puts the host back in the queue');
      assert.equal(supabaseMock.getBroadcasts().filter(b => b.event === 'join').length, 2);

      supabaseMock.fireBroadcast('join_ack', { playerId: 'zzzz-stale', v: 2 });
      await flush();
      assert.equal(supabaseMock.getBroadcasts().filter(b => b.event === 'match_found').length, 3, 'Stale peer is skipped for a while');

      supabaseMock.fireBroadcast('join', { playerId: 'zzzz-live', v: 2 });
      await flush();
      const liveOffer = supabaseMock.getBroadcasts().filter(b => b.event === 'match_found').pop();
      assert.equal(liveOffer.payload.player2Id, 'zzzz-live');
      supabaseMock.fireBroadcast('match_accept', { roomId: liveOffer.payload.roomId, playerId: 'zzzz-live' });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].isHost, true);
      assert.equal(matches[0].opponentId, 'zzzz-live');
    } finally {
      global.setTimeout = realSetTimeout;
      Matchmaking.offMatchFound(onMatch);
    }
  });

  await test('v2 guest accepts an offer while searching and declines one when not', async () => {
    Matchmaking.destroy();
    supabaseMock.reset();
    Matchmaking.init();
    supabaseMock.setStatus('SUBSCRIBED');
    const matches = [];
    const onMatch = detail => matches.push(detail);
    Matchmaking.onMatchFound(onMatch);
    try {
      const offer = { roomId: 'room-1', player1Id: 'aaaa-host', player2Id: 'player-local', confirm: true, v: 2 };
      supabaseMock.fireBroadcast('match_found', offer);
      assert.equal(supabaseMock.getBroadcasts().pop().event, 'match_decline', 'Not searching → decline');
      assert.equal(matches.length, 0);

      Matchmaking.joinQueue();
      supabaseMock.fireBroadcast('match_found', offer);
      assert.equal(supabaseMock.getBroadcasts().pop().event, 'match_accept');
      assert.deepEqual(matches, [{ roomId: 'room-1', opponentId: 'aaaa-host', isHost: false }]);

      supabaseMock.fireBroadcast('match_found', offer);
      assert.equal(supabaseMock.getBroadcasts().pop().event, 'match_accept', 'Duplicate offer is re-acked');
      assert.equal(matches.length, 1);
    } finally {
      Matchmaking.offMatchFound(onMatch);
    }
  });
})();
