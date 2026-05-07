'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');

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
  const listeners = new Map();

  const addListener = (type, handler, options = {}) => {
    if (typeof handler !== 'function') return;
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push({ handler, once: options?.once === true });
  };

  const removeListener = (type, handler) => {
    if (!listeners.has(type)) return;
    listeners.set(type, listeners.get(type).filter((entry) => entry.handler !== handler));
  };

  const dispatch = (type, event = {}) => {
    const entries = [...(listeners.get(type) || [])];
    event.target = event.target || stub;
    event.currentTarget = stub;
    for (const entry of entries) {
      entry.handler(event);
      if (entry.once) removeListener(type, entry.handler);
    }
  };

  const stub = {
    removed: false,
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
    addEventListener(type, handler, options) {
      addListener(type, handler, options);
    },
    removeEventListener(type, handler) {
      removeListener(type, handler);
    },
    dispatchEvent(event) {
      if (!event?.type) return false;
      dispatch(event.type, event);
      return true;
    },
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
    remove() {
      this.removed = true;
    },
    click() {
      if (typeof this.onclick === 'function') this.onclick({ target: this, currentTarget: this });
      dispatch('click', { type: 'click', target: this, currentTarget: this });
    },
  };

  return stub;
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
  battleEndOverride = null,
  autoResolveBattle = false,
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
  const resultCalls = [];
  const screenCalls = [];
  const shopRenderCalls = [];
  const stopMusicCalls = [];
  const gameplayMusicCalls = [];
  const musicCalls = [];
  const windowEvents = new Map();
  const supabaseEvents = { leaveAllCalls: 0 };
  const updateUpgradeCalls = [];
  const replayControls = {
    plays: [],
    stopCalls: 0,
    current: null,
  };
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
    discardSavedSessionCalls: [],
    syncCalls: [],
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
  let currentRound = 0;
  let currentSavedSession = savedSession ? plain(savedSession) : null;
  const document = createDocumentStub(domElementIds);

  const addWindowListener = (type, handler) => {
    if (!windowEvents.has(type)) windowEvents.set(type, []);
    windowEvents.get(type).push(handler);
  };

  const removeWindowListener = (type, handler) => {
    if (!windowEvents.has(type)) return;
    windowEvents.set(type, windowEvents.get(type).filter((entry) => entry !== handler));
  };

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
    addEventListener(type, handler) {
      addWindowListener(type, handler);
    },
    removeEventListener(type, handler) {
      removeWindowListener(type, handler);
    },
    preloadSprites() {},
    preloadSlashSprites() {},
    GAME_CONFIG: {
      startingGold: 10,
      maxRefreshesPerRound: 1,
    },
    ELEMENT_EMOJI: {
      fire: 'F',
      earth: 'E',
      lightning: 'L',
      arcane: 'A',
      void: 'V',
    },
    Element: {
      FIRE: 'fire',
      EARTH: 'earth',
      LIGHTNING: 'lightning',
      ARCANE: 'arcane',
      VOID: 'void',
    },
    GRID_CONFIG: {
      rows: 6,
      cols: 5,
      battleLineRow: 2,
    },
    WaveGenerator: {
      setVoidCampaign() {},
      setSeed() {},
      generate() {
        return {
          bonusGold: 3,
          enemies: [{ unitId: 'test_unit', count: 1 }],
        };
      },
    },
    Room: {
      DISCONNECT_GRACE_MS: roomGraceMs,
      join(roomId, isHost, opponentId) {
        roomStatus.roomId = roomId;
        roomStatus.isHost = !!isHost;
        roomStatus.opponentId = opponentId;
        currentSavedSession = {
          roomId,
          isHost: !!isHost,
          opponentId,
          resumeContext: currentSavedSession?.resumeContext || null,
        };
        roomEvents.joinCalls.push({ roomId, isHost: !!isHost, opponentId });
        return true;
      },
      getSavedSession() {
        return currentSavedSession;
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
      syncState(key, value) {
        roomStatus.state[key] = plain(value);
        roomEvents.syncCalls.push({ key, value: plain(value) });
        return { ok: true };
      },
      onStateChange(handler) {
        roomEvents.stateChangeHandlers.push(handler);
      },
      offStateChange(handler) {
        roomEvents.stateChangeHandlers = roomEvents.stateChangeHandlers.filter((entry) => entry !== handler);
      },
      onOpponentDisconnect(handler) {
        roomEvents.opponentDisconnectHandlers.push(handler);
      },
      offOpponentDisconnect(handler) {
        roomEvents.opponentDisconnectHandlers = roomEvents.opponentDisconnectHandlers.filter((entry) => entry !== handler);
      },
      onReconnect(handler) {
        roomEvents.reconnectHandlers.push(handler);
      },
      offReconnect(handler) {
        roomEvents.reconnectHandlers = roomEvents.reconnectHandlers.filter((entry) => entry !== handler);
      },
      discardSavedSession(reason) {
        roomEvents.discardSavedSessionCalls.push(reason);
        currentSavedSession = null;
        return true;
      },
      destroy() {
        roomEvents.destroyCalls += 1;
        currentSavedSession = null;
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
      leaveAll() {
        supabaseEvents.leaveAllCalls += 1;
      },
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
    MultiplayerAuthorityState: {
      getRequestModeForReason(reason = 'unknown') {
        return reason === 'reload_resume' ? 'auto' : 'full';
      },
      resolveRoundNumber(roomState = {}) {
        const candidates = [
          roomState.authoritative_state,
          roomState.round_result,
          roomState.phase_event,
          roomState.playback_checkpoint,
          roomState.battle_replay,
          roomState.prep_state,
        ];
        for (const candidate of candidates) {
          const roundNumber = Number(candidate?.roundNumber || candidate?.round || 0);
          if (roundNumber > 0) return roundNumber;
        }
        return 0;
      },
      resolveResumeTarget({
        savedResumeContext = null,
        roomState = {},
        snapshotRound = 0,
        localWave = 0,
        trackedRound = 0,
        liveRound = 0,
      } = {}) {
        const savedRound = Number(savedResumeContext?.roundNumber || 0);
        const roomRound = this.resolveRoundNumber(roomState);
        const roundNumber = Math.max(savedRound, Number(snapshotRound) || 0, roomRound, Number(localWave) || 0, Number(trackedRound) || 0, Number(liveRound) || 0, 0);
        return {
          roundNumber,
          checkpointSeq: savedRound === roundNumber ? Number(savedResumeContext?.checkpointSeq || 0) : 0,
          requestedMode: savedResumeContext?.phase === 'prep' ? 'prep' : 'auto',
        };
      },
      buildRequest({ roundNumber, reason = 'unknown', mode = 'auto', checkpointSeq = 0, seq = 0 }) {
        const payload = {
          roundNumber: Number(roundNumber) || 0,
          reason,
          mode,
          checkpointSeq: Number(checkpointSeq) || 0,
          at: Date.now(),
        };
        if (Number(seq) > 0) payload.seq = Number(seq);
        return payload;
      },
      buildPayload({ roundNumber, roomState = {}, meta = {}, mode = 'full' }) {
        const keyGroups = {
          battle: ['battle_replay', 'playback_checkpoint', 'phase_event', 'round_result'],
          prep: ['prep_state', 'shop_seed', 'mp_reroll', 'prep_p1', 'prep_p2', 'ready_p1', 'ready_p2'],
        };
        const keys = mode === 'battle'
          ? keyGroups.battle
          : mode === 'prep'
            ? keyGroups.prep
            : [...keyGroups.prep, ...keyGroups.battle];
        const state = {};
        for (const key of keys) {
          const value = roomState[key];
          if (value === undefined || value === null) continue;
          if (!this.matchesRound(value, roundNumber)) continue;
          state[key] = plain(value);
        }
        return {
          roundNumber: Number(roundNumber) || 0,
          state,
          meta: {
            ...plain(meta),
            responseMode: mode,
          },
        };
      },
      matchesRound(payload, roundNumber) {
        if (!payload) return false;
        if (payload.roundNumber === undefined) return true;
        return Number(payload.roundNumber) === Number(roundNumber);
      },
      getEntries(payload) {
        return Object.entries(payload?.state || {})
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => ({ key, value: plain(value) }));
      },
      shouldRequestResync() {
        return true;
      },
      resolveResponseMode({ requestedMode = 'auto' } = {}) {
        return requestedMode;
      },
    },
    UI: {
      showScreen(screenId) {
        screenCalls.push(screenId);
      },
      hideAllOverlays() {},
      showMessage(message) {
        uiMessages.push(message);
      },
      clearLog() {},
      addLogEntry() {},
      showPhaseBanner() {},
      updateHUD() {},
      hideResult() {},
      showResult(playerWon, wave, earnedGold, breakdown = {}) {
        resultCalls.push({ playerWon, wave, earnedGold, breakdown: plain(breakdown) });
      },
      clearUnitDetail() {},
      showUnitDetail() {},
      switchTab() {},
      renderShop(units, gold, onBuy) {
        shopRenderCalls.push({ units: plain(units), gold, onBuy });
      },
      updateUpgrades(upgradeLevels, gold, _onBuy, visibleUpgrades) {
        updateUpgradeCalls.push({
          upgradeLevels: plain(upgradeLevels || {}),
          gold,
          visibleUpgradeIds: Array.isArray(visibleUpgrades) ? visibleUpgrades.map((upg) => upg.id) : null,
        });
      },
      updateSynergies() {},
    },
    Grid: {
      build() {},
      onClick: null,
      onRightClick: null,
      clearSelection() {},
      clearHighlights() {},
      highlightTiles() {},
      selectTile() {},
      getTileEl() {
        return null;
      },
      removeUnitFromTile() {},
      placeUnit() {},
      resetAnimations() {},
      updateUnitHp() {},
      updateStatusIcons() {},
      updateStatusAuras() {},
      waitForAnimations() {},
      animateSynergyPulse() {},
      animateAttack() {},
      animateHit() {},
      animateDeath() {},
      animateDamageNumber() {},
      updateUpgradeIcons() {},
      updateSynergyIcons() {},
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
        return currentRound;
      },
      setRound(round) {
        currentRound = Number(round || 0);
      },
      getOppUnits() {
        return [];
      },
      getBattleSeed() {
        return 123456;
      },
      generateShopUnits(pool, count = 5) {
        return pool.slice(0, count);
      },
      getRoundGoldBonus(playerWon, survivingCount) {
        return (playerWon ? 5 : 0) + Math.max(0, Number(survivingCount) || 0) * 2;
      },
      getTotalRounds() {
        return 5;
      },
      endRound() {},
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
    UNIT_DEFINITIONS: [
      {
        id: 'test_unit',
        name: 'Test Unit',
        element: 'fire',
        cost: 1,
        stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      },
    ],
    UNIT_MAP: {
      test_unit: {
        id: 'test_unit',
        name: 'Test Unit',
        element: 'fire',
        cost: 1,
        stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      },
    },
    ACHIEVEMENTS: [],
    UPGRADES: [
      { id: 'field_medic', name: 'Field Medic', cost: 5, maxLevel: 3, effect: { type: 'healingRate', value: 0.15 } },
      { id: 'bargain_hunter', name: 'Hovs Handouts', cost: 4, maxLevel: 2, effect: { type: 'shopRefresh', value: -1 } },
      { id: 'war_chest', name: 'War Chest', cost: 6, maxLevel: 3, effect: { type: 'interestRate', value: 0.1 } },
      { id: 'victory_bonus', name: 'Victory Bonus', cost: 5, maxLevel: 3, effect: { type: 'goldPerWave', value: 2 } },
      { id: 'scouts_intel', name: 'Scout\'s Intel', cost: 25, maxLevel: 1, effect: { type: 'scoutLevel', value: 1 } },
      { id: 'elite_training', name: 'Elite Training', cost: 7, maxLevel: 3, effect: { type: 'eliteTraining', value: 1 } },
      { id: 'double_edge', name: 'Double Edge', cost: 5, maxLevel: 1, effect: { type: 'doubleEdge', value: 1 } },
    ],
    ELEMENT_SYNERGIES: [],
    ELEMENT_COLORS: {
      fire: '#f00',
      earth: '#0f0',
      lightning: '#ff0',
      arcane: '#0ff',
    },
    UnitKeys: {
      stampUnit(unit, ownerId) {
        unit.id = `${ownerId}::${unit.definition.id}::${unit.row}::${unit.col}`;
      },
      makeUnitKey(ownerId, defId, row, col) {
        return `${ownerId}::${defId}::${row}::${col}`;
      },
    },
    HashUtils: {
      hashState() {
        return { toString() { return 'hash-123'; } };
      },
    },
    VFX: {
      setSpeed() {},
      shockwave() {},
      screenFlash() {},
      healSingle() {},
      screenShake() {},
      meleeSlash() {},
      elementProjectile() {},
      burnSpread() {},
      freezeBurst() {},
      healAoE() {},
      shieldDome() {},
      voidRupture() {},
      poisonCloud() {},
    },
    BattleSystem: function BattleSystem() {
      this._playerUnits = [];
      this._enemyUnits = [];
      this._replayLog = { events: [] };
      this.setSeed = () => {};
      this.enableReplayRecording = () => {};
      this.setScheduler = () => {};
      this.start = (players, enemies) => {
        this._playerUnits = players.map((unit) => plain(unit));
        this._enemyUnits = enemies.map((unit) => plain(unit));
        const defaultBattleEnd = {
          type: 'battle_end',
          playerWon: true,
          playerUnits: this._playerUnits.map((unit) => plain(unit)),
          enemyUnits: this._enemyUnits.map((unit) => plain(unit)),
        };
        const overriddenBattleEnd = typeof battleEndOverride === 'function'
          ? battleEndOverride({ players: this._playerUnits, enemies: this._enemyUnits })
          : battleEndOverride;
        const battleEnd = Object.assign({}, defaultBattleEnd, plain(overriddenBattleEnd || {}));
        if (!Array.isArray(battleEnd.playerUnits)) battleEnd.playerUnits = defaultBattleEnd.playerUnits;
        if (!Array.isArray(battleEnd.enemyUnits)) battleEnd.enemyUnits = defaultBattleEnd.enemyUnits;
        this._replayLog = {
          events: [
            {
              type: 'battle_start',
              playerUnits: this._playerUnits.map((unit) => plain(unit)),
              enemyUnits: this._enemyUnits.map((unit) => plain(unit)),
            },
            { type: 'turn_start', seq: 1, turn: 1 },
            battleEnd,
          ],
        };
        if (autoResolveBattle) {
          this.onBattleEnd?.(Boolean(battleEnd.playerWon));
        }
      };
      this.getReplayLog = () => this._replayLog;
    },
    BattleReplay: {
      createPlayer() {
        let playing = false;
        let settled = false;
        let resolvePlay = null;
        return {
          play(replayLog, handlers = {}) {
            playing = true;
            settled = false;
            const battleStart = replayLog.events.find((evt) => evt.type === 'battle_start');
            const turnStart = replayLog.events.find((evt) => evt.type === 'turn_start');
            const battleEnd = replayLog.events.find((evt) => evt.type === 'battle_end');
            handlers.onBattleStart?.(battleStart);
            handlers.onTurnStart?.(turnStart);
            const playRecord = { replayLog: plain(replayLog), battleEnd: plain(battleEnd) };
            replayControls.plays.push(playRecord);
            return new Promise((resolve) => {
              resolvePlay = (result) => {
                if (settled) return;
                settled = true;
                playing = false;
                resolve(result);
              };
              replayControls.current = {
                handlers,
                resolve(result = { stopped: false }) {
                  handlers.onBattleEnd?.(battleEnd);
                  resolvePlay(result);
                  replayControls.current = null;
                },
              };
            });
          },
          stop() {
            replayControls.stopCalls += 1;
            if (resolvePlay) resolvePlay({ stopped: true });
            replayControls.current = null;
          },
          isPlaying() {
            return playing;
          },
        };
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
    clickShop(index) {
      const last = shopRenderCalls.at(-1);
      last?.onBuy?.(index);
    },
    clickTile(row, col) {
      context.Grid.onClick?.(row, col);
    },
    dispatchWindowEvent(type, event = {}) {
      for (const handler of windowEvents.get(type) || []) {
        handler(event);
      }
    },
    emitRoomStateChange(key, value, fromId = 'remote-player') {
      roomStatus.state[key] = plain(value);
      for (const handler of [...roomEvents.stateChangeHandlers]) {
        handler(key, plain(value), fromId);
      }
    },
    uiMessages,
    resultCalls,
    timeouts,
    intervals,
    screenCalls,
    stopMusicCalls,
    gameplayMusicCalls,
    musicCalls,
    roomStatus,
    roomEvents,
    multiplayerEvents,
    supabaseEvents,
    updateUpgradeCalls,
    replayControls,
    getSavedSession() {
      return currentSavedSession;
    },
    setRound(round) {
      currentRound = Number(round || 0);
    },
    fireMultiplayerCallback(name, ...args) {
      return multiplayerCallbacks?.[name]?.(...args);
    },
  };
}

console.log('\nGame multiplayer lifecycle tests\n');

(async () => {
await test('Game.init resumes a saved guest session through the public boot path', () => {
  const { Game, document, uiMessages, timeouts, intervals, roomEvents, multiplayerEvents, stopMusicCalls, gameplayMusicCalls } = loadGameContext({
    domElementIds: ['splash-overlay', 'btn-splash-dismiss'],
  });

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
  assert.equal(document.getElementById('splash-overlay').removed, true);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, policy.guestResumeBootstrapTimeoutMs);
  assert.equal(intervals.length, 1);
  assert.equal(uiMessages.includes('🔄 Rejoining live match…'), true);
});

await test('Game.init does not arm guest resume bootstrap when reconnect refuses the saved session', () => {
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

await test('Guest host-disconnect callback ends the resumed match through the public room lifecycle path', () => {
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

await test('Host room-watch transition ends the match when the local host channel leaves SUBSCRIBED', () => {
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

await test('Host opponent-disconnect callback keeps the match reconnectable through the public room lifecycle path', () => {
  const {
    Game,
    screenCalls,
    roomEvents,
    multiplayerEvents,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: ['mp-lobby-overlay', 'mp-disconnect-notice', 'mp-disconnect-msg', 'mp-disconnect-timer'],
  });

  Game.init();
  assert.equal(typeof roomEvents.matchFoundHandler, 'function');

  roomEvents.matchFoundHandler({
    roomId: 'room-host-guest-drop',
    opponentId: 'guest-drop-1',
    isHost: true,
  });

  assert.equal(roomEvents.opponentDisconnectHandlers.length, 1);
  const screenCallCountBeforeDisconnect = screenCalls.length;

  roomEvents.opponentDisconnectHandlers[0]();

  assert.equal(multiplayerEvents.forceMatchEndCalls.length, 0);
  assert.equal(multiplayerEvents.destroyCalls, 0);
  assert.equal(roomEvents.destroyCalls, 0);
  assert.equal(screenCalls.length, screenCallCountBeforeDisconnect);
});

await test('Host prep disconnect confirmation does not auto-award the round while waiting for reconnect', () => {
  const {
    Game,
    intervals,
    roomEvents,
    multiplayerEvents,
    fireMultiplayerCallback,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-refresh',
      'btn-mp-ready',
      'mp-ready-opp-status',
      'mp-ready-timer',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
      'mp-conn-indicator',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-prep-disconnect',
    opponentId: 'guest-prep-drop',
    isHost: true,
  });
  fireMultiplayerCallback('onRoundReady', 1, 25);

  assert.equal(Game.state.gold, 25);
  const intervalCountBeforeDisconnect = intervals.length;
  roomEvents.opponentDisconnectHandlers[0]();

  const disconnectGraceInterval = intervals[intervalCountBeforeDisconnect];
  assert.ok(disconnectGraceInterval, 'disconnect grace interval should be registered');

  for (let tick = 0; tick < 5; tick += 1) {
    disconnectGraceInterval.fn();
  }

  assert.equal(multiplayerEvents.forceMatchEndCalls.length, 0);
  assert.equal(Game.state.gold, 25, 'prep disconnect wait should not fabricate a round win');
});

await test('Quit button ends the active match and clears the saved room session through the public flow', async () => {
  const {
    Game,
    document,
    screenCalls,
    musicCalls,
    roomEvents,
    multiplayerEvents,
    getSavedSession,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: ['mp-lobby-overlay', 'screen-game', 'btn-mp-quit'],
  });

  global.window = global.window || {};
  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-quit-123',
    opponentId: 'opp-quit-9',
    isHost: false,
  });

  assert.equal(typeof document.getElementById('btn-mp-quit').click, 'function');
  assert.equal(getSavedSession()?.roomId, 'room-quit-123');

  document.getElementById('btn-mp-quit').click();
  await Promise.resolve();

  assert.equal(multiplayerEvents.forceMatchEndCalls.length, 1);
  assert.deepEqual(plain(multiplayerEvents.forceMatchEndCalls[0]), {
    winner: 'opponent',
    meta: {
      reason: 'quit',
      source: 'local',
      quitter: 'me',
      roundNumber: 0,
    },
  });
  assert.equal(roomEvents.destroyCalls, 1);
  assert.equal(getSavedSession(), null);
  assert.equal(screenCalls.at(-1), 'screen-title');
  assert.deepEqual(musicCalls, ['ss_title_music_full.wav']);
});

await test('Game.init binds pagehide realtime release once and ignores persisted exits', () => {
  const { Game, dispatchWindowEvent, supabaseEvents } = loadGameContext();

  Game.init();

  dispatchWindowEvent('pagehide', { persisted: true });
  assert.equal(supabaseEvents.leaveAllCalls, 0);

  dispatchWindowEvent('pagehide', { persisted: false });
  assert.equal(supabaseEvents.leaveAllCalls, 1);

  dispatchWindowEvent('pagehide', { persisted: false });
  assert.equal(supabaseEvents.leaveAllCalls, 1);
});

await test('Guest resume requests authoritative_state when result_show is cached without round_result', () => {
  const {
    Game,
    roomEvents,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    roomState: {
      phase_event: {
        type: 'result_show',
        roundNumber: 4,
        boardHash: 'hash-result-only',
      },
    },
    domElementIds: [
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
    ],
  });

  Game.init();

  const requestSync = roomEvents.syncCalls.find((entry) => entry.key === 'request_authoritative_state');
  assert.ok(requestSync, 'Guest should request authoritative_state when only result_show is cached');
  assert.equal(requestSync.value.reason, 'reload_resume');
  assert.equal(requestSync.value.roundNumber, 4);
});

await test('Guest resume prefers the saved battle round over newer prep metadata without own prep payload', () => {
  const {
    Game,
    roomEvents,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-abcdef12',
      isHost: false,
      resumeContext: {
        roundNumber: 4,
        checkpointSeq: 9,
        phase: 'battle',
      },
    },
    roomState: {
      prep_state: {
        roundNumber: 5,
        shopSeed: 77,
      },
    },
    domElementIds: [
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
    ],
  });

  Game.init();

  const requestSync = roomEvents.syncCalls.find((entry) => entry.key === 'request_authoritative_state');
  assert.ok(requestSync, 'Guest should request authoritative_state for the unresolved battle round');
  assert.equal(requestSync.value.reason, 'reload_resume');
  assert.equal(requestSync.value.roundNumber, 4);
  assert.equal(requestSync.value.mode, 'battle');
  assert.equal(requestSync.value.checkpointSeq, 9);
});

await test('Guest replay bootstrap requests missing battle_replay for the resumed older round', () => {
  const {
    Game,
    roomEvents,
    setRound,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-replay-bootstrap-older-round',
      isHost: false,
      resumeContext: {
        roundNumber: 4,
        checkpointSeq: 9,
        phase: 'battle',
      },
    },
    roomState: {
      prep_state: {
        roundNumber: 5,
        shopSeed: 77,
      },
    },
    domElementIds: [
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
    ],
  });

  setRound(5);
  Game.init();

  const syncCountBeforeReplayBootstrap = roomEvents.syncCalls.length;
  emitRoomStateChange('phase_event', {
    type: 'playback_start',
    roundNumber: 4,
    checkpointSeq: 9,
    boardHash: 'older-round-hash',
  });
  emitRoomStateChange('playback_checkpoint', {
    roundNumber: 4,
    seq: 9,
    turn: 2,
    boardHash: 'older-round-hash',
  });

  const replayBootstrapSyncs = roomEvents.syncCalls.slice(syncCountBeforeReplayBootstrap);
  const requestSync = replayBootstrapSyncs.find((entry) => (
    entry.key === 'request_authoritative_state' &&
    entry.value.reason === 'missing_battle_replay'
  ));
  assert.ok(requestSync, 'Guest should request missing battle_replay for the resumed retained round');
  assert.equal(requestSync.value.roundNumber, 4);
  assert.equal(requestSync.value.checkpointSeq, 9);
});

await test('Multiplayer round end preserves roster instead of pruning dead or damaged units from replay outcome', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    fireMultiplayerCallback,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    battleEndOverride: ({ players }) => ({
      playerWon: false,
      playerUnits: [
        {
          ...plain(players[0]),
          hp: 0,
          row: 3,
          col: 2,
          statusEffects: [{ type: 'burn' }],
          abilityCooldown: 2,
        },
        {
          ...plain(players[1]),
          hp: 3,
          row: 3,
          col: 3,
          statusEffects: [{ type: 'poison' }],
          abilityCooldown: 1,
        },
      ],
    }),
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
      'mp-reconnect-banner',
      'btn-mp-quit',
      'mp-round-result',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-round-reset',
    opponentId: 'guest-round-reset',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [
    {
      id: 'p1',
      name: 'Test Unit A',
      definition: {
        id: 'test_unit',
        name: 'Test Unit',
        element: 'fire',
        stats: { hp: 12, attack: 4, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 4, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 4,
      col: 0,
    },
    {
      id: 'p2',
      name: 'Test Unit B',
      definition: {
        id: 'test_unit',
        name: 'Test Unit',
        element: 'fire',
        stats: { hp: 12, attack: 4, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 4, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 4,
      col: 1,
    },
  ];

  fireMultiplayerCallback('onBothReady');
  assert.ok(replayControls.current, 'Host battle replay should be active');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'round_result'), true, 'Host round-end flow should broadcast round_result before assertions');

  assert.equal(Game.state.playerUnits.length, 2, 'Round end should keep the owned roster intact');
  assert.deepEqual(plain(Game.state.playerUnits.map((unit) => [unit.row, unit.col])), [[4, 0], [4, 1]], 'Round end should restore the owned roster to its starting positions');
  assert.deepEqual(Game.state.playerUnits.map((unit) => unit.hp), [12, 12], 'Round end should not carry battle damage into the next prep state');
  assert.deepEqual(plain(Game.state.playerUnits.map((unit) => unit.statusEffects)), [[], []], 'Round end should clear battle status effects from the owned roster');
  assert.deepEqual(Game.state.playerUnits.map((unit) => unit.abilityCooldown), [0, 0], 'Round end should clear battle cooldown state from the owned roster');
});

await test('Multiplayer prep hides disabled upgrades and blocks buying them', () => {
  const {
    Game,
    roomEvents,
    updateUpgradeCalls,
    fireMultiplayerCallback,
    uiMessages,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-refresh',
      'btn-mp-ready',
      'mp-ready-opp-status',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-upgrades',
    opponentId: 'guest-upgrades',
    isHost: true,
  });

  fireMultiplayerCallback('onRoundReady', 1, 25);

  const visibleUpgradeIds = updateUpgradeCalls.at(-1)?.visibleUpgradeIds || [];
  assert.equal(visibleUpgradeIds.includes('field_medic'), false, 'Field Medic should be hidden in multiplayer prep');
  assert.equal(visibleUpgradeIds.includes('bargain_hunter'), false, 'Hovs Handouts should be hidden in multiplayer prep');
  assert.equal(visibleUpgradeIds.includes('war_chest'), false, 'War Chest should be hidden in multiplayer prep');
  assert.equal(visibleUpgradeIds.includes('victory_bonus'), false, 'Victory Bonus should be hidden in multiplayer prep');
  assert.equal(visibleUpgradeIds.includes('scouts_intel'), false, 'Scout\'s Intel should be hidden in multiplayer prep');
  assert.equal(visibleUpgradeIds.includes('elite_training'), true, 'Round-sensitive upgrades should remain available in multiplayer prep');

  const goldBefore = Game.state.gold;
  Game.buyUpgrade('field_medic');

  assert.equal(Game.state.gold, goldBefore, 'Disabled multiplayer upgrades should not spend gold');
  assert.equal(Game.state.upgradeLevels.field_medic, undefined, 'Disabled multiplayer upgrades should not be applied');
  assert.equal(uiMessages.includes('This upgrade is disabled in multiplayer.'), true);
});

await test('Pending shop purchases recheck affordability before placement after later gold spend', () => {
  const {
    Game,
    clickShop,
    clickTile,
    uiMessages,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
    ],
  });

  Game.init();
  Game.startGame('normal');

  Game.state.shopUnits[0] = {
    ...plain(Game.state.shopUnits[0]),
    cost: 8,
    stats: { ...Game.state.shopUnits[0].stats },
  };

  const goldBeforeUpgrade = Game.state.gold;
  clickShop(0);

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending after the first click');
  assert.equal(Game.state.gold, goldBeforeUpgrade, 'Selecting a shop card should not spend gold before placement');

  Game.buyUpgrade('field_medic');
  assert.equal(Game.state.gold, goldBeforeUpgrade - 5, 'Upgrade purchase should spend gold while the shop card is still pending');

  clickTile(3, 0);

  assert.equal(Game.state.gold, goldBeforeUpgrade - 5, 'Placement should recheck affordability and avoid overspending');
  assert.equal(Game.state.playerUnits.length, 0, 'Unaffordable pending purchase should not place a unit');
  assert.equal(Game.state.shopUnits[0].cost, 8, 'Failed placement should leave the shop card available');
  assert.equal(uiMessages.at(-1), 'Not enough gold!', 'Placement should surface the affordability failure to the player');
});

await test('War Chest interest applies to current gold before victory rewards are added', () => {
  const {
    Game,
    resultCalls,
  } = loadGameContext({
    savedSession: null,
    autoResolveBattle: true,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const def = Game.state.shopUnits[0];
  Game.state.gold = 10;
  Game.state.upgradeLevels = { war_chest: 1 };
  Game.state.playerUnits = [{
    id: 'p-interest',
    name: def.name,
    definition: def,
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    stats: { ...def.stats },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 3,
    col: 0,
  }];

  Game.startBattle();

  assert.equal(Game.state.phase, 'result', 'Auto-resolved battle should advance the game into the result phase');
  assert.equal(Game.state.gold, 21, 'Interest should be based on pre-reward gold, not the gold total after victory rewards are added');
  assert.equal(resultCalls.at(-1)?.earnedGold, 11, 'Result payload should report the documented gold reward total');
  assert.equal(resultCalls.at(-1)?.breakdown?.interest, 1, 'War Chest should contribute 10 percent of the current pre-reward gold');
});

await test('Upgrades cannot be bought after prep phase has ended', () => {
  const {
    Game,
    uiMessages,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const goldBefore = Game.state.gold;
  Game.state.phase = 'battle';
  Game.buyUpgrade('field_medic');

  assert.equal(Game.state.gold, goldBefore, 'Upgrade purchases should not spend gold outside the prep phase');
  assert.equal(Game.state.upgradeLevels.field_medic, undefined, 'Upgrade levels should not change outside the prep phase');
  assert.equal(uiMessages.at(-1), 'Can only buy during the shop phase.', 'Players should be told why the upgrade purchase was blocked');
});

await test('Units cannot be repositioned after the prep phase has ended', () => {
  const {
    Game,
    clickTile,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const def = Game.state.shopUnits[0];
  Game.state.playerUnits = [{
    id: 'p-grid',
    name: def.name,
    definition: def,
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    stats: { ...def.stats },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 3,
    col: 0,
  }];
  Game.state.phase = 'result';

  clickTile(3, 0);
  clickTile(4, 1);

  assert.equal(Game.state.playerUnits[0].row, 3, 'Units should stay in place once prep has ended');
  assert.equal(Game.state.playerUnits[0].col, 0, 'Units should not be repositioned outside prep');
  assert.equal(Game.state.selectedUnit, null, 'Result-phase clicks should not leave a movable unit selected');
});

await test('Multiplayer new prep round clears round-sensitive upgrades and restores base stats', () => {
  const {
    Game,
    roomEvents,
    updateUpgradeCalls,
    fireMultiplayerCallback,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-refresh',
      'btn-mp-ready',
      'mp-ready-opp-status',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-round-upgrades',
    opponentId: 'guest-round-upgrades',
    isHost: true,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'p-upg',
    name: 'Upgrade Test Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    attack: 4,
    defense: 2,
    speed: 1,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  Game.buyUpgrade('elite_training');
  Game.buyUpgrade('double_edge');

  assert.deepEqual(plain(Game.state.upgradeLevels), { elite_training: 1, double_edge: 1 });
  assert.equal(Game.state.playerUnits[0].stats.attack, 5, 'Round-sensitive upgrades should buff stats during the current prep round');
  assert.equal(Game.state.playerUnits[0].stats.defense, 1, 'Double Edge should reduce defense during the current prep round');

  fireMultiplayerCallback('onRoundReady', 2, 20);

  assert.deepEqual(plain(Game.state.upgradeLevels), {}, 'Round-sensitive upgrades should clear at the start of the next multiplayer prep round');
  assert.equal(Game.state.playerUnits[0].stats.attack, 4, 'New prep round should restore base attack after clearing round-sensitive upgrades');
  assert.equal(Game.state.playerUnits[0].stats.defense, 2, 'New prep round should restore base defense after clearing round-sensitive upgrades');
  assert.equal(Game.state.playerUnits[0].stats.speed, 1, 'New prep round should restore base speed after clearing round-sensitive upgrades');

  const visibleUpgradeIds = updateUpgradeCalls.at(-1)?.visibleUpgradeIds || [];
  assert.equal(visibleUpgradeIds.includes('elite_training'), true, 'Round-sensitive upgrades should be available again in the next prep round');
  assert.equal(visibleUpgradeIds.includes('double_edge'), true, 'Round-sensitive upgrades should be available again in the next prep round');
});

await test('Host reconnect during battle re-broadcasts paused replay state and schedules resume', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    timeouts,
    setRound,
    fireMultiplayerCallback,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
      'mp-reconnect-banner',
      'btn-mp-quit',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-123',
    opponentId: 'guest-456',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [{
    id: 'p1',
    name: 'Test Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');
  assert.equal(replayControls.plays.length, 1);
  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_start'), true);

  roomEvents.opponentDisconnectHandlers[0]();
  assert.equal(replayControls.stopCalls, 1);
  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_paused'), true);

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'battle_replay'), true, 'Host should re-broadcast battle_replay on reconnect');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_resume_pending'), true, 'Host should schedule a resume_pending phase_event');

  const resumeTimeout = [...timeouts].reverse().find((entry) => entry.delay === 3000);
  assert.ok(resumeTimeout, 'Reconnect should arm a replay resume timer');

  const syncCountBeforeResume = roomEvents.syncCalls.length;
  resumeTimeout.fn();

  const resumeSyncs = roomEvents.syncCalls.slice(syncCountBeforeResume);
  assert.equal(resumeSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_start' && entry.value.resumed === true), true, 'Resume timer should re-emit playback_start with resumed=true');
  assert.equal(replayControls.plays.length, 2, 'Host should restart replay playback from the paused checkpoint');
});

await test('Host serves retained authoritative_state for an older unresolved battle round after advancing', () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    fireMultiplayerCallback,
    emitRoomStateChange,
  } = loadGameContext({
    savedSession: null,
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    domElementIds: [
      'mp-lobby-overlay',
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
      'mp-reconnect-banner',
      'btn-mp-quit',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-older-123',
    opponentId: 'guest-older-456',
    isHost: true,
  });

  setRound(4);
  Game.state.playerUnits = [{
    id: 'p1',
    name: 'Test Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');
  assert.ok(replayControls.current, 'Host battle replay should be active');

  setRound(5);

  const syncCountBeforeRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
  });

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequest);
  const authoritativeSync = requestSyncs.find((entry) => entry.key === 'authoritative_state');
  assert.ok(authoritativeSync, 'Host should answer an older unresolved round with retained authoritative_state');
  assert.equal(authoritativeSync.value.roundNumber, 4);
  assert.deepEqual(Object.keys(authoritativeSync.value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
  ]);
});
})();