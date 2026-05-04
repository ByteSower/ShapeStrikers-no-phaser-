'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOM_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/room.js'), 'utf8');

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

function createSessionStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
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

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  function getNextTimer(limit = Infinity) {
    let nextEntry = null;
    for (const entry of timers.entries()) {
      const [, timer] = entry;
      if (timer.dueAt > limit) continue;
      if (!nextEntry || timer.dueAt < nextEntry[1].dueAt) nextEntry = entry;
    }
    return nextEntry;
  }

  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, {
        fn,
        dueAt: now + Math.max(0, Number(delay) || 0),
      });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runNext() {
      const next = getNextTimer();
      if (!next) return false;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.dueAt;
      timer.fn();
      return true;
    },
    advanceBy(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      while (true) {
        const next = getNextTimer(target);
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.fn();
      }
      now = target;
    },
    now() {
      return now;
    },
  };
}

function createMockChannel() {
  const handlers = new Map();
  let presence = {};

  const channel = {
    on(type, filter, handler) {
      handlers.set(`${type}:${filter.event}`, handler);
      return channel;
    },
    async track() {
      return { ok: true };
    },
    presenceState() {
      return presence;
    },
  };

  return {
    channel,
    setPresence(nextPresence) {
      presence = nextPresence;
    },
    emitPresence(event) {
      const handler = handlers.get(`presence:${event}`);
      if (handler) handler();
    },
    emitBroadcast(event, payload) {
      const handler = handlers.get(`broadcast:${event}`);
      if (handler) handler({ payload });
    },
  };
}

function loadRoomContext() {
  const timers = createFakeTimers();
  const sessionStorage = createSessionStorage();
  const channelControl = createMockChannel();
  let channelStatus = 'pending';
  let onSubscribed = null;

  const context = {
    console,
    JSON,
    Math,
    Date: { now: timers.now },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Backend: {
      getUserId() {
        return 'player-self';
      },
    },
    SupabaseClient: {
      joinChannel(name, setupFn, subscribedFn) {
        context.joinedName = name;
        setupFn(channelControl.channel);
        onSubscribed = subscribedFn;
      },
      leaveChannel() {},
      reconnectChannel() {
        channelStatus = 'pending';
        return true;
      },
      broadcast(name, event, payload) {
        context.broadcasts.push({ name, event, payload, at: timers.now() });
        return { ok: true };
      },
      getChannelStatus() {
        return channelStatus;
      },
      getChannel() {
        return channelControl.channel;
      },
    },
    sessionStorage,
    broadcasts: [],
  };

  context.global = context;
  context.window = context;

  vm.createContext(context);
  vm.runInContext(ROOM_SOURCE, context, { filename: 'room.js' });

  return {
    Room: vm.runInContext('Room', context),
    setChannelStatus(nextStatus) {
      channelStatus = nextStatus;
    },
    async subscribe() {
      channelStatus = 'SUBSCRIBED';
      assert.ok(onSubscribed, 'joinChannel should capture onSubscribed');
      await onSubscribed(channelControl.channel);
    },
    setPresence(nextPresence) {
      channelControl.setPresence(nextPresence);
    },
    emitPresence(event = 'sync') {
      channelControl.emitPresence(event);
    },
    emitBroadcast(event, payload) {
      channelControl.emitBroadcast(event, payload);
    },
    runNextTimer() {
      return timers.runNext();
    },
    advanceBy(ms) {
      timers.advanceBy(ms);
    },
    getBroadcasts() {
      return context.broadcasts.slice();
    },
  };
}

console.log('\nRoom lifecycle tests\n');

(async () => {
  await test('join starts connecting and becomes active after subscribe', async () => {
    const { Room, subscribe, setChannelStatus } = loadRoomContext();

    Room.join('room-life-1', false, 'opp-1');
    assert.equal(Room.getLifecycleState(), 'CONNECTING');
    assert.equal(Room.getConnectionState(), 'pending');

    await subscribe();
    assert.equal(Room.getLifecycleState(), 'ACTIVE');
    assert.equal(Room.getConnectionState(), 'SUBSCRIBED');

    setChannelStatus('TIMED_OUT');
    assert.equal(Room.getLifecycleState(), 'RECONNECTING');
    assert.equal(Room.getConnectionState(), 'TIMED_OUT');
  });

  await test('presence loss moves through stale and disconnected before returning active', async () => {
    const { Room, subscribe, setPresence, emitPresence, advanceBy, getBroadcasts } = loadRoomContext();

    Room.join('room-life-2', true, 'opp-2');
    await subscribe();

    setPresence({ remote: [{ playerId: 'opp-2' }] });
    emitPresence('sync');
    assert.equal(Room.getLifecycleState(), 'ACTIVE');

    setPresence({});
    emitPresence('leave');
    assert.equal(Room.getLifecycleState(), 'STALE');

    advanceBy(10_000);
    assert.equal(Room.getLifecycleState(), 'DISCONNECTED');
    assert.ok(getBroadcasts().some(entry => entry.event === 'room_heartbeat'), 'local heartbeat loop should run while subscribed');

    setPresence({ remote: [{ playerId: 'opp-2' }] });
    emitPresence('join');
    assert.equal(Room.getLifecycleState(), 'ACTIVE');
  });

  await test('heartbeat silence alone can mark stale and disconnected without presence leave', async () => {
    const { Room, subscribe, setPresence, emitPresence, advanceBy } = loadRoomContext();

    Room.join('room-life-4', false, 'opp-4');
    await subscribe();

    setPresence({ remote: [{ playerId: 'opp-4' }] });
    emitPresence('sync');
    assert.equal(Room.getLifecycleState(), 'ACTIVE');

    advanceBy(7_000);
    assert.equal(Room.getLifecycleState(), 'STALE');

    advanceBy(3_000);
    assert.equal(Room.getLifecycleState(), 'DISCONNECTED');
  });

  await test('incoming heartbeat restores active state even without a presence join event', async () => {
    const { Room, subscribe, setPresence, emitPresence, emitBroadcast, advanceBy } = loadRoomContext();

    Room.join('room-life-5', false, 'opp-5');
    await subscribe();

    setPresence({ remote: [{ playerId: 'opp-5' }] });
    emitPresence('sync');
    advanceBy(7_000);
    assert.equal(Room.getLifecycleState(), 'STALE');

    emitBroadcast('room_heartbeat', { from: 'opp-5', at: 7_000 });
    assert.equal(Room.getLifecycleState(), 'ACTIVE');
  });

  await test('resync lifecycle enters and exits explicitly while subscribed', async () => {
    const { Room, subscribe, setPresence, emitPresence } = loadRoomContext();

    Room.join('room-life-3', false, 'opp-3');
    await subscribe();
    setPresence({ remote: [{ playerId: 'opp-3' }] });
    emitPresence('sync');
    assert.equal(Room.getLifecycleState(), 'ACTIVE');

    assert.equal(Room.beginResync('unit-test'), true);
    assert.equal(Room.getLifecycleState(), 'RESYNCING');

    assert.equal(Room.endResync('unit-test-complete'), true);
    assert.equal(Room.getLifecycleState(), 'ACTIVE');
  });
})();