'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createElementStub() {
  const classes = new Set();
  return {
    textContent: '',
    className: '',
    dataset: {},
    style: {},
    disabled: false,
    onclick: null,
    children: [],
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force === true) {
          classes.add(name);
          return true;
        }
        if (force === false) {
          classes.delete(name);
          return false;
        }
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      return child;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    remove() {},
  };
}

function createDocumentStub(elementIds = []) {
  const elements = new Map(elementIds.map((id) => [id, createElementStub()]));

  return {
    readyState: 'loading',
    documentElement: {
      setAttribute() {},
      removeAttribute() {},
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createElementStub();
    },
    elements,
  };
}

function loadGameContext({
  roomGraceMs = 10_000,
  reconnectResult = true,
  savedSession = {
    roomId: 'room-abcdef12',
    isHost: false,
    resumeContext: {
      roundNumber: 4,
      checkpointSeq: 12,
    },
  },
  roomState = {},
  roomConnectionState = 'pending',
  roomLifecycleState = 'reconnecting',
  domElementIds = [],
} = {}) {
  const timeouts = [];
  const intervals = [];
  const uiMessages = [];
  const screenCalls = [];
  const stopMusicCalls = [];
  const gameplayMusicCalls = [];
  const musicCalls = [];
  const roomStatus = {
    connectionState: roomConnectionState,
    lifecycleState: roomLifecycleState,
    isHost: false,
    roomId: savedSession?.roomId || 'room-abcdef12',
    opponentId: 'opponent-xyz789',
    state: roomState,
  };
  const roomEvents = {
    reconnectCalls: 0,
    joinCalls: [],
    destroyCalls: 0,
    matchFoundHandler: null,
    stateChangeHandlers: [],
    opponentDisconnectHandlers: [],
    reconnectHandlers: [],
  };
  const multiplayerEvents = {
    startCalls: [],
    destroyCalls: 0,
    forceMatchEndCalls: [],
  };

  let multiplayerActive = false;
  let multiplayerCallbacks = {};
  const document = createDocumentStub(domElementIds);

  const context = {
    console,
    JSON,
    Math,
    Date,
    location: {
      hostname: 'example.com',
    },
    performance: { now: () => 0 },
    Image: function Image() {},
    document,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout(fn, delay) {
      timeouts.push({ fn, delay });
      return timeouts.length;
    },
    clearTimeout() {},
    setInterval(fn, delay) {
      intervals.push({ fn, delay });
      return intervals.length;
    },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    preloadSprites() {},
    preloadSlashSprites() {},
    GAME_CONFIG: {
      startingGold: 10,
      maxRefreshesPerRound: 1,
    },
    GRID_CONFIG: {
      rows: 6,
      cols: 5,
      battleLineRow: 2,
    },
    Room: {
      DISCONNECT_GRACE_MS: roomGraceMs,
      join(roomId, isHost, opponentId) {
        roomStatus.roomId = roomId;
        roomStatus.isHost = !!isHost;
        roomStatus.opponentId = opponentId;
        roomEvents.joinCalls.push({ roomId, isHost: !!isHost, opponentId });
        return true;
      },
      getSavedSession() {
        return savedSession;
      },
      reconnect() {
        roomEvents.reconnectCalls += 1;
        return reconnectResult;
      },
      isHost() {
        return roomStatus.isHost;
      },
      getState() {
        return roomStatus.state;
      },
      getLifecycleState() {
        return roomStatus.lifecycleState;
      },
      getConnectionState() {
        return roomStatus.connectionState;
      },
      getRoomId() {
        return roomStatus.roomId;
      },
      getOpponentId() {
        return roomStatus.opponentId;
      },
      onStateChange(handler) {
        roomEvents.stateChangeHandlers.push(handler);
      },
      offStateChange() {},
      onOpponentDisconnect(handler) {
        roomEvents.opponentDisconnectHandlers.push(handler);
      },
      offOpponentDisconnect() {},
      onReconnect(handler) {
        roomEvents.reconnectHandlers.push(handler);
      },
      offReconnect() {},
      destroy() {
        roomEvents.destroyCalls += 1;
      },
    },
    Audio: {
      init() {},
      play() {},
      playMusic(track) {
        musicCalls.push(track);
      },
      stopMusic() {
        stopMusicCalls.push('stop');
      },
      playGameplayMusic() {
        gameplayMusicCalls.push('gameplay');
      },
      isMuted() { return false; },
      toggleMute() {},
    },
    Backend: {
      init() {},
      getPlayerName() { return 'Test Player'; },
      getUserId() { return 'player-123'; },
      setPlayerName() { return true; },
    },
    SupabaseClient: {
      init() {},
      leaveAll() {},
      getChannelStatus() {
        return 'pending';
      },
    },
    Presence: {
      onCountChange() {},
      init() {},
    },
    GlobalChat: {
      init() {},
    },
    Matchmaking: {
      init() {},
      isSearching() { return false; },
      leaveQueue() {},
      onMatchFound(handler) {
        roomEvents.matchFoundHandler = handler;
      },
    },
    UI: {
      showScreen(screenId) {
        screenCalls.push(screenId);
      },
      showMessage(message) {
        uiMessages.push(message);
      },
      clearUnitDetail() {},
      renderShop() {},
      updateUpgrades() {},
      updateSynergies() {},
    },
    Grid: {
      build() {},
      onClick: null,
      onRightClick: null,
      getTileEl() {
        return null;
      },
      removeUnitFromTile() {},
      placeUnit() {},
      updateUpgradeIcons() {},
    },
    MultiplayerGame: {
      start(roomId, isHost, opponentId, callbacks = {}) {
        multiplayerActive = true;
        multiplayerCallbacks = callbacks;
        multiplayerEvents.startCalls.push({ roomId, isHost, opponentId });
      },
      isActive() {
        return multiplayerActive;
      },
      isHost() {
        return roomStatus.isHost;
      },
      shouldForceMatchEndOnOpponentDisconnect() {
        return !roomStatus.isHost;
      },
      shouldForceMatchEndOnLocalDisconnect() {
        return roomStatus.isHost;
      },
      hydrateMatchState() {},
      getScores() {
        return { my: 0, opp: 0 };
      },
      getRound() {
        return 0;
      },
      forceMatchEnd(winner, meta) {
        multiplayerEvents.forceMatchEndCalls.push({ winner, meta });
        multiplayerCallbacks.onMatchEnd?.(winner, meta);
        return true;
      },
      destroy() {
        multiplayerEvents.destroyCalls += 1;
        multiplayerActive = false;
      },
    },
  };

  context.window = context;
  context.global = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(GAME_SOURCE, context, { filename: 'game.js' });

  return {
    Game: vm.runInContext('Game', context),
    document,
    uiMessages,
    timeouts,
    intervals,
    screenCalls,
    stopMusicCalls,
    gameplayMusicCalls,
    musicCalls,
    roomStatus,
    roomEvents,
    multiplayerEvents,
  };
}

console.log('\nGame multiplayer lifecycle tests\n');

test('Game.init resumes a saved guest session through the public boot path', () => {
  const { Game, uiMessages, timeouts, intervals, roomEvents, multiplayerEvents, stopMusicCalls, gameplayMusicCalls } = loadGameContext();

  Game.init();

  const policy = Game.getMultiplayerPolicy();
  assert.equal(roomEvents.reconnectCalls, 1);
  assert.equal(multiplayerEvents.startCalls.length, 1);
  assert.equal(stopMusicCalls.length, 1);
  assert.equal(gameplayMusicCalls.length, 1);
  assert.equal(multiplayerEvents.startCalls[0].roomId, 'room-abcdef12');
  assert.equal(multiplayerEvents.startCalls[0].isHost, false);
  assert.equal(Game.state.wave, 4);
  assert.equal(Game.state.phase, 'prep');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, policy.guestResumeBootstrapTimeoutMs);
  assert.equal(intervals.length, 1);
  assert.equal(uiMessages.includes('🔄 Rejoining live match…'), true);
});

test('Game.init does not arm guest resume bootstrap when reconnect refuses the saved session', () => {
  const { Game, uiMessages, timeouts, intervals, roomEvents, multiplayerEvents } = loadGameContext({
    reconnectResult: false,
  });

  Game.init();

  assert.equal(roomEvents.reconnectCalls, 1);
  assert.equal(multiplayerEvents.startCalls.length, 0);
  assert.equal(Game.state, null);
  assert.equal(timeouts.length, 0);
  assert.equal(intervals.length, 0);
  assert.equal(uiMessages.includes('🔄 Rejoining live match…'), false);
});

test('Guest host-disconnect callback ends the resumed match through the public room lifecycle path', () => {
  const { Game, screenCalls, musicCalls, roomEvents, multiplayerEvents } = loadGameContext();

  Game.init();
  assert.equal(roomEvents.opponentDisconnectHandlers.length, 1);

  roomEvents.opponentDisconnectHandlers[0]();

  assert.equal(multiplayerEvents.forceMatchEndCalls.length, 1);
  assert.equal(multiplayerEvents.forceMatchEndCalls[0].winner, 'me');
  assert.deepEqual(plain(multiplayerEvents.forceMatchEndCalls[0].meta), {
    reason: 'host_disconnect',
    source: 'opponent-disconnect',
    disconnected: 'opponent',
    roundNumber: 0,
  });
  assert.equal(multiplayerEvents.destroyCalls, 1);
  assert.equal(roomEvents.destroyCalls, 1);
  assert.equal(screenCalls.at(-1), 'screen-title');
  assert.deepEqual(musicCalls, ['ss_title_music_full.wav']);
});

test('Host room-watch transition ends the match when the local host channel leaves SUBSCRIBED', () => {
  const {
    Game,
    intervals,
    screenCalls,
    stopMusicCalls,
    gameplayMusicCalls,
    musicCalls,
    roomStatus,
    roomEvents,
    multiplayerEvents,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: ['mp-lobby-overlay'],
  });

  Game.init();
  assert.equal(typeof roomEvents.matchFoundHandler, 'function');

  roomEvents.matchFoundHandler({
    roomId: 'room-host-123',
    opponentId: 'guest-456',
    isHost: true,
  });

  assert.equal(multiplayerEvents.startCalls.length, 1);
  assert.equal(multiplayerEvents.startCalls[0].isHost, true);
  assert.equal(stopMusicCalls.length, 1);
  assert.equal(gameplayMusicCalls.length, 1);
  assert.equal(intervals.length, 1);

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  assert.equal(multiplayerEvents.forceMatchEndCalls.length, 1);
  assert.equal(multiplayerEvents.forceMatchEndCalls[0].winner, 'opponent');
  assert.deepEqual(plain(multiplayerEvents.forceMatchEndCalls[0].meta), {
    reason: 'host_disconnect',
    source: 'local-host-disconnect',
    disconnected: 'me',
    roundNumber: 0,
  });
  assert.equal(multiplayerEvents.destroyCalls, 1);
  assert.equal(roomEvents.destroyCalls, 1);
  assert.equal(screenCalls.at(-1), 'screen-title');
  assert.deepEqual(musicCalls, ['ss_title_music_full.wav']);
});