'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');
const GRID_STYLES_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/gridStyles.js'), 'utf8');

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

function createElementStub(registry = null) {
  const classes = new Set();
  const listeners = new Map();
  let rawClassName = '';
  let rawInnerHTML = '';

  const syncClassNameFromSet = () => {
    rawClassName = Array.from(classes).join(' ');
  };

  const hasClass = (node, className) => String(node?.className || '')
    .split(/\s+/)
    .filter(Boolean)
    .includes(className);

  const findByClass = (nodes, className) => {
    for (const node of nodes || []) {
      if (!node || node.removed) continue;
      if (hasClass(node, className)) return node;
      const nested = findByClass(node.children, className);
      if (nested) return nested;
    }
    return null;
  };

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
    event.stopPropagation = event.stopPropagation || (() => {});
    event.preventDefault = event.preventDefault || (() => {});
    for (const entry of entries) {
      entry.handler(event);
      if (entry.once) removeListener(type, entry.handler);
    }
  };

  const stub = {
    removed: false,
    textContent: '',
    dataset: {},
    style: {},
    disabled: false,
    onclick: null,
    children: [],
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
        syncClassNameFromSet();
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
        syncClassNameFromSet();
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force === true) {
          classes.add(name);
          syncClassNameFromSet();
          return true;
        }
        if (force === false) {
          classes.delete(name);
          syncClassNameFromSet();
          return false;
        }
        if (classes.has(name)) {
          classes.delete(name);
          syncClassNameFromSet();
          return false;
        }
        classes.add(name);
        syncClassNameFromSet();
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
    querySelector(selector) {
      if (!selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const existing = findByClass(this.children, className);
      if (existing) return existing;
      if (!rawInnerHTML.includes(`class="${className}"`) && !rawInnerHTML.includes(`class='${className}'`)) return null;
      const syntheticChild = createElementStub(registry);
      syntheticChild.className = className;
      this.children.push(syntheticChild);
      return syntheticChild;
    },
    querySelectorAll(selector) {
      if (!selector.startsWith('.')) return [];
      const className = selector.slice(1);
      this.querySelector(selector);
      const matches = [];
      const collect = (nodes) => {
        for (const node of nodes || []) {
          if (!node || node.removed) continue;
          if (hasClass(node, className)) matches.push(node);
          collect(node.children);
        }
      };
      collect(this.children);
      return matches;
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

  Object.defineProperty(stub, 'className', {
    get() {
      return rawClassName;
    },
    set(value) {
      rawClassName = String(value || '');
      classes.clear();
      rawClassName.split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
  });

  Object.defineProperty(stub, 'innerHTML', {
    get() {
      return rawInnerHTML;
    },
    set(value) {
      rawInnerHTML = String(value || '');
    },
  });

  registry?.push(stub);

  return stub;
}

function createDocumentStub(elementIds = []) {
  const registry = [];
  const elements = new Map(elementIds.map((id) => [id, createElementStub(registry)]));

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
      if (selector.startsWith('.')) {
        const className = selector.slice(1);
        return registry.find((element) => !element.removed && String(element.className || '').split(/\s+/).includes(className)) || null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createElementStub(registry);
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
  const gridCalls = {
    clearSelection: 0,
    clearHighlights: 0,
    highlightTiles: [],
  };
  const unitDetailCalls = {
    clear: 0,
    show: [],
  };
  let currentUnitDetail = null;
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
    resyncCalls: [],
    matchFoundHandler: null,
    stateChangeHandlers: [],
    opponentDisconnectHandlers: [],
    reconnectHandlers: [],
  };
  const multiplayerEvents = {
    startCalls: [],
    destroyCalls: 0,
    endRoundCalls: [],
    forceMatchEndCalls: [],
  };
  const tileElements = new Map();
  const gridUnits = new Map();

  let multiplayerActive = false;
  let multiplayerCallbacks = {};
  let currentRound = 0;
  let multiplayerScores = { my: 0, opp: 0 };
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
      beginResync(reason = 'authoritative_state_requested', meta = {}) {
        roomStatus.lifecycleState = 'RESYNCING';
        roomEvents.resyncCalls.push({ type: 'begin', reason, meta: plain(meta) });
        return true;
      },
      endResync(reason = 'authoritative_state_applied', meta = {}) {
        roomStatus.lifecycleState = roomStatus.connectionState === 'SUBSCRIBED' ? 'ACTIVE' : 'RECONNECTING';
        roomEvents.resyncCalls.push({ type: 'end', reason, meta: plain(meta) });
        return true;
      },
      applyState(key, value, source = 'applyState') {
        roomStatus.state[key] = plain(value);
        for (const handler of [...roomEvents.stateChangeHandlers]) {
          handler(key, plain(value), source);
        }
        return true;
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
        return candidates.reduce((highestRound, candidate) => {
          const roundNumber = Number(candidate?.roundNumber || candidate?.round || 0);
          return Math.max(highestRound, roundNumber > 0 ? roundNumber : 0);
        }, 0);
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
      clearUnitDetail() {
        currentUnitDetail = null;
        unitDetailCalls.clear += 1;
      },
      showUnitDetail(unit, upgradeLevels, synergies) {
        currentUnitDetail = {
          unit: plain(unit),
          upgradeLevels: plain(upgradeLevels || {}),
          synergies: plain(synergies || null),
        };
        unitDetailCalls.show.push(currentUnitDetail);
      },
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
      clearSelection() {
        gridCalls.clearSelection += 1;
      },
      clearHighlights() {
        gridCalls.clearHighlights += 1;
      },
      highlightTiles(tiles, cssClass) {
        gridCalls.highlightTiles.push({ tiles: plain(tiles), cssClass });
      },
      selectTile() {},
      getTileEl(row, col) {
        const key = `${row},${col}`;
        if (!tileElements.has(key)) tileElements.set(key, document.createElement('div'));
        return tileElements.get(key);
      },
      removeUnitFromTile(row, col) {
        gridUnits.delete(`${row},${col}`);
      },
      placeUnit(unit, row, col) {
        gridUnits.set(`${row},${col}`, plain(unit));
      },
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
        return plain(multiplayerScores);
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
      doReroll(pool, count = 5) {
        return pool.slice(0, count);
      },
      getRoundGoldBonus(playerWon, survivingCount) {
        return (playerWon ? 5 : 0) + Math.max(0, Number(survivingCount) || 0) * 2;
      },
      getTotalRounds() {
        return 5;
      },
      endRound(...args) {
        multiplayerEvents.endRoundCalls.push(args.map((entry) => plain(entry)));
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
  vm.runInContext(GRID_STYLES_SOURCE, context, { filename: 'gridStyles.js' });
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
    clickTileRight(row, col) {
      context.Grid.onRightClick?.(row, col);
    },
    clickSellConfirmYes() {
      document.querySelector('.sell-confirm')?.querySelector('.sell-yes')?.click();
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
    gridCalls,
    unitDetailCalls,
    getGridUnits() {
      return [...gridUnits.entries()].map(([key, unit]) => ({ key, unit: plain(unit) }));
    },
    getCurrentUnitDetail() {
      return plain(currentUnitDetail);
    },
    setElementSynergies(nextSynergies) {
      context.ELEMENT_SYNERGIES = plain(nextSynergies || []);
    },
    getSavedSession() {
      return currentSavedSession;
    },
    setRound(round) {
      currentRound = Number(round || 0);
    },
    setScores(scores = {}) {
      multiplayerScores = {
        my: Math.max(0, Number(scores.my) || 0),
        opp: Math.max(0, Number(scores.opp) || 0),
      };
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

await test('Guest reload resume exits RESYNCING when matching prep_state arrives after an authoritative request', () => {
  const {
    Game,
    roomStatus,
    roomEvents,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-resume-resync-clear',
      isHost: false,
      resumeContext: {
        roundNumber: 4,
        checkpointSeq: 9,
        phase: 'battle',
      },
    },
    roomState: {},
    domElementIds: [
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
    ],
  });

  Game.init();

  assert.equal(roomStatus.lifecycleState, 'RESYNCING', 'Reload resume should enter RESYNCING when it requests authoritative_state for an empty room cache');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'begin' && entry.reason === 'reload_resume_authoritative_request'), true, 'Reload resume should begin a resync before live state arrives');

  emitRoomStateChange('prep_state', {
    roundNumber: 4,
    shopSeed: 12345,
    rerollIndex: 0,
    at: Date.now(),
  });

  assert.equal(Game.state.wave, 4, 'Reload resume should still hydrate the recovered prep round from live room state');
  assert.equal(roomStatus.lifecycleState, 'ACTIVE', 'Matching prep_state should clear RESYNCING once reload resume has recovered without an authoritative bundle');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'end'), true, 'Reload resume recovery should end the resync lifecycle once live state arrives');
});

await test('Guest reload resume exits RESYNCING when a stale wrong-round authoritative_state arrives', () => {
  const {
    Game,
    roomStatus,
    roomEvents,
    intervals,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-resume-resync-mismatch',
      isHost: false,
      resumeContext: {
        roundNumber: 4,
        checkpointSeq: 9,
        phase: 'battle',
      },
    },
    roomState: {},
    domElementIds: [
      'btn-refresh',
      'mp-disconnect-notice',
      'mp-disconnect-msg',
      'mp-disconnect-timer',
    ],
  });

  Game.init();

  assert.equal(roomStatus.lifecycleState, 'RESYNCING', 'Reload resume should enter RESYNCING before an authoritative response arrives');

  emitRoomStateChange('authoritative_state', {
    roundNumber: 3,
    at: 1234,
    state: {
      battle_replay: {
        roundNumber: 3,
        boardHash: 'stale-hash',
        replayLog: { events: [] },
      },
    },
  });

  assert.equal(roomStatus.lifecycleState, 'ACTIVE', 'Wrong-round authoritative_state should end the in-flight resync instead of leaving reload resume stranded in RESYNCING');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'end'), true, 'Wrong-round authoritative_state should still close the resync lifecycle as a rejected response');

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeResubscribe = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  intervals[0].fn();

  const resubscribeSyncs = roomEvents.syncCalls.slice(syncCountBeforeResubscribe);
  const retryRequest = resubscribeSyncs.find((entry) => entry.key === 'request_authoritative_state');
  assert.ok(retryRequest, 'Reconnect plus room-watch resubscribe should re-request authoritative_state after a wrong-round reload response left the room unresolved');
  assert.equal(retryRequest.value.roundNumber, 4);
});

await test('Guest resume ignores stale older authoritative_state when newer prep metadata exists', () => {
  const {
    Game,
    roomEvents,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-stale-authoritative-older-round',
      isHost: false,
      resumeContext: null,
    },
    roomState: {
      prep_state: {
        roundNumber: 5,
        shopSeed: 77,
      },
      authoritative_state: {
        roundNumber: 4,
        at: 1234,
        state: {
          battle_replay: {
            roundNumber: 4,
            hostWon: true,
            replayLog: {
              events: [],
            },
          },
        },
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

  assert.equal(Game.state.wave, 5, 'Guest resume should stay anchored to the newer live prep round instead of stale older authoritative_state');
  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'request_authoritative_state'), false, 'Guest should not request authoritative_state when newer prep state already exists for the live round');
});

await test('Guest prep resume ignores a late older authoritative_state once newer prep state is already live', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    intervals,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-late-stale-authoritative',
      isHost: false,
      resumeContext: null,
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

  assert.equal(Game.state.wave, 5, 'Guest should already be anchored to the newer live prep round before a stale authoritative response arrives');

  const syncCountBeforeLateAuthoritative = roomEvents.syncCalls.length;
  emitRoomStateChange('authoritative_state', {
    roundNumber: 4,
    at: 4321,
    state: {
      battle_replay: {
        roundNumber: 4,
        hostWon: true,
        replayLog: {
          events: [],
        },
      },
    },
  });

  assert.equal(Game.state.wave, 5, 'Late stale authoritative_state should not pull the guest off the current prep round');
  assert.equal(roomEvents.syncCalls.slice(syncCountBeforeLateAuthoritative).some((entry) => entry.key === 'request_authoritative_state'), false, 'Late stale authoritative_state should not immediately trigger a fresh authoritative request once newer prep state is already live');

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeResubscribe = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  intervals[0].fn();

  const resubscribeSyncs = roomEvents.syncCalls.slice(syncCountBeforeResubscribe);
  assert.equal(resubscribeSyncs.some((entry) => entry.key === 'request_authoritative_state'), false, 'Reconnect plus room-watch resubscribe should not request authoritative_state again when the live prep round is already resolved by newer prep_state');
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

await test('Guest replay bootstrap exits RESYNCING once a matching battle_replay arrives', () => {
  const {
    Game,
    roomStatus,
    roomEvents,
    setRound,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-replay-bootstrap-resync-clear',
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

  assert.equal(roomStatus.lifecycleState, 'RESYNCING', 'Missing battle_replay recovery should mark the room as RESYNCING while the authoritative request is in flight');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'begin' && entry.reason === 'authoritative_request:missing_battle_replay'), true, 'Guest replay bootstrap should begin a resync when it requests missing battle_replay');

  emitRoomStateChange('battle_replay', {
    roundNumber: 4,
    boardHash: 'older-round-hash',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          playerUnits: [],
          enemyUnits: [],
        },
        {
          type: 'turn_start',
          seq: 9,
          turn: 2,
        },
        {
          type: 'battle_end',
          playerWon: false,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  });

  assert.equal(roomStatus.lifecycleState, 'ACTIVE', 'Matching live battle_replay should clear RESYNCING once replay bootstrap recovers without an authoritative bundle');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'end'), true, 'Replay bootstrap recovery should end the resync lifecycle once matching live state arrives');
});

await test('Guest result recovery exits RESYNCING once a matching round_result arrives', () => {
  const {
    Game,
    roomStatus,
    roomEvents,
    setRound,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-result-resync-clear',
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

  assert.equal(roomStatus.lifecycleState, 'RESYNCING', 'Result recovery should start from RESYNCING once the guest requests authoritative sync');

  emitRoomStateChange('round_result', {
    hostWon: true,
    roundNumber: 4,
    seq: 7,
    boardHash: 'older-round-hash',
  });

  assert.equal(roomStatus.lifecycleState, 'ACTIVE', 'Matching round_result should clear RESYNCING once the host resolves the round without an authoritative bundle');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'end'), true, 'Result recovery should end the resync lifecycle once matching round_result arrives');
});

await test('Guest battle recovery exits RESYNCING when a stale wrong-round authoritative_state arrives', () => {
  const {
    Game,
    roomStatus,
    roomEvents,
    intervals,
    setRound,
    emitRoomStateChange,
  } = loadGameContext({
    roomConnectionState: 'SUBSCRIBED',
    roomLifecycleState: 'ACTIVE',
    savedSession: {
      roomId: 'room-battle-resync-mismatch',
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

  assert.equal(roomStatus.lifecycleState, 'RESYNCING', 'Battle recovery should enter RESYNCING before the authoritative response arrives');

  emitRoomStateChange('authoritative_state', {
    roundNumber: 3,
    at: 1234,
    state: {
      round_result: {
        hostWon: true,
        roundNumber: 3,
        seq: 7,
        boardHash: 'stale-hash',
      },
    },
  });

  assert.equal(roomStatus.lifecycleState, 'ACTIVE', 'Wrong-round authoritative_state should end the in-flight battle resync instead of leaving the guest stranded in RESYNCING');
  assert.equal(roomEvents.resyncCalls.some((entry) => entry.type === 'end'), true, 'Wrong-round battle authoritative_state should still close the resync lifecycle as a rejected response');

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeResubscribe = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]?.();
  intervals[0].fn();

  const resubscribeSyncs = roomEvents.syncCalls.slice(syncCountBeforeResubscribe);
  const retryRequest = resubscribeSyncs.find((entry) => entry.key === 'request_authoritative_state');
  assert.ok(retryRequest, 'Reconnect plus room-watch resubscribe should re-request authoritative_state after a wrong-round battle response left replay recovery unresolved');
  assert.equal(retryRequest.value.reason, 'missing_battle_replay');
  assert.equal(retryRequest.value.roundNumber, 4);
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

await test('Scout\'s Intel stays locked until bought and resets on a fresh run', () => {
  const {
    Game,
    document,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'hud-wave',
      'wave-preview',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const hudWave = document.getElementById('hud-wave');
  const wavePreview = document.getElementById('wave-preview');

  assert.equal(wavePreview.classList.contains('hidden'), true, 'Prep should keep the wave preview hidden before Scout\'s Intel is purchased');
  assert.equal(wavePreview.innerHTML, '', 'Prep should clear any stale scout markup before Scout\'s Intel is purchased');
  hudWave.click();
  assert.equal(hudWave.classList.contains('wave-preview-open'), false, 'Clicking the wave badge should do nothing before Scout\'s Intel is purchased');
  assert.equal(wavePreview.innerHTML.includes('Next Wave 2'), false, 'Prep should not reveal the next wave before Scout\'s Intel is bought');

  Game.nextWave();
  Game.nextWave();
  Game.nextWave();

  assert.equal(wavePreview.classList.contains('hidden'), true, 'Later prep phases should also keep the preview hidden until Scout\'s Intel is purchased');
  assert.equal(wavePreview.innerHTML.includes('Next Wave 5'), false, 'The later prep phase should still hide the next wave before Scout\'s Intel is bought');

  Game.state.gold = 99;
  Game.buyUpgrade('scouts_intel');

  assert.equal(wavePreview.classList.contains('hidden'), false, 'Buying Scout\'s Intel should reveal the wave preview immediately');
  assert.ok(wavePreview.innerHTML.includes('Wave 4 Scout'), 'Buying Scout\'s Intel should reveal the current wave scout info immediately');
  assert.ok(wavePreview.innerHTML.includes('Next Wave 5'), 'Buying Scout\'s Intel should immediately refresh the prep wave preview with the next wave');
  assert.ok(wavePreview.innerHTML.includes('HP:'), 'Scout\'s Intel should show the next wave stats in the prep preview');
  assert.equal(hudWave.classList.contains('wave-preview-open'), false, 'The wave preview should start collapsed until the player opens it');

  hudWave.click();
  assert.equal(hudWave.classList.contains('wave-preview-open'), true, 'Clicking the wave badge during prep should open the Scout\'s Intel preview for tap/mobile access');

  hudWave.click();
  assert.equal(hudWave.classList.contains('wave-preview-open'), false, 'Clicking the wave badge again should close the Scout\'s Intel preview');

  Game.nextWave();

  assert.ok(wavePreview.innerHTML.includes('Wave 5 Scout'), 'Advancing to the next prep phase should refresh the current wave scout info');
  assert.ok(wavePreview.innerHTML.includes('Next Wave 6'), 'Scout\'s Intel should keep revealing the next wave on later prep phases after purchase');

  Game.startGame('normal');

  assert.equal(Game.state.upgradeLevels.scouts_intel, undefined, 'A fresh run should not keep Scout\'s Intel from the previous run');
  assert.equal(wavePreview.classList.contains('hidden'), true, 'Starting a fresh run should hide the Scout\'s Intel preview again');
  assert.equal(wavePreview.innerHTML, '', 'Starting a fresh run should clear the previous run\'s scout preview markup');
  assert.equal(hudWave.classList.contains('wave-preview-open'), false, 'Starting a fresh run should collapse the wave badge preview state');
});

await test('Pending shop purchases recheck affordability before placement after later gold spend', () => {
  const {
    Game,
    clickShop,
    clickTile,
    gridCalls,
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
  const clearHighlightsBeforeUpgrade = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending after the first click');
  assert.equal(Game.state.gold, goldBeforeUpgrade, 'Selecting a shop card should not spend gold before placement');

  Game.buyUpgrade('field_medic');
  assert.equal(Game.state.gold, goldBeforeUpgrade - 5, 'Upgrade purchase should spend gold while the shop card is still pending');
  assert.equal(Game.state.selectedShopIdx, null, 'Upgrade purchases should cancel any pending shop placement that was armed before the gold changed');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeUpgrade + 1, 'Upgrade purchases should clear the stale placement highlights when they cancel the pending shop card');

  clickTile(3, 0);

  assert.equal(Game.state.gold, goldBeforeUpgrade - 5, 'Placement should recheck affordability and avoid overspending');
  assert.equal(Game.state.playerUnits.length, 0, 'Unaffordable pending purchase should not place a unit');
  assert.equal(Game.state.shopUnits[0].cost, 8, 'Failed placement should leave the shop card available');
});

await test('Upgrade purchases clear any stale pending shop detail panel state', () => {
  const {
    Game,
    clickShop,
    getCurrentUnitDetail,
    unitDetailCalls,
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

  clickShop(0);

  const clearDetailBeforeUpgrade = unitDetailCalls.clear;

  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a shop card should populate the detail panel before the upgrade purchase');
  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending before the upgrade purchase cancels it');

  Game.buyUpgrade('field_medic');

  assert.equal(Game.state.selectedShopIdx, null, 'Upgrade purchases should cancel the pending shop card state');
  assert.equal(getCurrentUnitDetail(), null, 'Upgrade purchases should clear stale detail from the canceled shop card');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeUpgrade + 1, 'Upgrade purchases should explicitly clear the canceled shop-card detail panel');
});

await test('Clicking an unaffordable different shop card cancels the previously armed purchase', () => {
  const {
    Game,
    clickShop,
    clickTile,
    gridCalls,
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
    cost: 1,
    stats: { ...Game.state.shopUnits[0].stats },
  };
  Game.state.shopUnits[1] = {
    ...plain(Game.state.shopUnits[0]),
    cost: 99,
    stats: { ...Game.state.shopUnits[0].stats },
  };

  clickShop(0);
  const clearHighlightsBeforeBlockedShopClick = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedShopIdx, 0, 'Affordable shop card should be pending before the blocked shop click');

  clickShop(1);

  assert.equal(Game.state.selectedShopIdx, null, 'Clicking a different unaffordable shop card should cancel the previously armed purchase instead of leaving it hidden');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeBlockedShopClick + 1, 'Blocked shop clicks should clear stale placement highlights from the canceled purchase');

  clickTile(4, 1);

  assert.equal(Game.state.playerUnits.length, 0, 'Clicking a tile after the blocked shop click should not place the previously armed unit');
  assert.equal(Game.state.shopUnits[0].cost, 1, 'Canceling the hidden pending purchase should leave the original shop card available');
});

await test('Selecting a shop card previews current upgrade buffs and active team synergies', () => {
  const {
    Game,
    clickShop,
    getCurrentUnitDetail,
    setElementSynergies,
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

  setElementSynergies([
    { element: 'fire', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  ]);

  Game.state.upgradeLevels = { elite_training: 1 };
  Game.state.playerUnits = [
    {
      id: 'p-fire-a',
      name: 'Fire Ally A',
      definition: {
        id: 'fire-a',
        name: 'Fire Ally A',
        element: 'fire',
        cost: 1,
        tier: 1,
        stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
        ability: { name: 'Spark', description: 'Test ability', cooldown: 1 },
      },
      hp: 10,
      maxHp: 10,
      stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 0,
    },
    {
      id: 'p-fire-b',
      name: 'Fire Ally B',
      definition: {
        id: 'fire-b',
        name: 'Fire Ally B',
        element: 'fire',
        cost: 1,
        tier: 1,
        stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
        ability: { name: 'Blaze', description: 'Test ability', cooldown: 1 },
      },
      hp: 11,
      maxHp: 11,
      stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 1,
    },
  ];

  Game.state.shopUnits[0] = {
    id: 'shop-preview-target',
    name: 'Shop Preview Target',
    element: 'ice',
    cost: 1,
    tier: 1,
    stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
    ability: { name: 'Preview', description: 'Test ability', cooldown: 1 },
  };

  clickShop(0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Selecting a shop card should populate the detail payload');
  assert.equal(detail.upgradeLevels.elite_training, 1, 'Shop preview should receive the current upgrade levels');
  assert.equal(detail.unit.stats.attack, 21, 'Shop preview should include active upgrade buffs in the previewed unit stats');
  assert.deepEqual(
    (detail.synergies || []).map((syn) => syn.description),
    ['2🔥: +15% ATK'],
    'Shop preview should receive the active team synergies for unit-card projection'
  );
});

await test('Selecting a shop card previews the synergy that the purchase would newly activate', () => {
  const {
    Game,
    clickShop,
    getCurrentUnitDetail,
    setElementSynergies,
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

  setElementSynergies([
    { element: 'fire', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  ]);

  Game.state.playerUnits = [
    {
      id: 'p-fire-preview-base',
      name: 'Fire Preview Base',
      definition: {
        id: 'fire-preview-base',
        name: 'Fire Preview Base',
        element: 'fire',
        cost: 1,
        tier: 1,
        stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
        ability: { name: 'Spark', description: 'Test ability', cooldown: 1 },
      },
      hp: 10,
      maxHp: 10,
      stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 0,
    },
  ];

  Game.state.shopUnits[0] = {
    id: 'shop-preview-fire-finisher',
    name: 'Shop Preview Fire Finisher',
    element: 'fire',
    cost: 1,
    tier: 1,
    stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
    ability: { name: 'Preview', description: 'Test ability', cooldown: 1 },
  };

  clickShop(0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Selecting a shop card should populate the detail payload');
  assert.deepEqual(
    (detail.synergies || []).map((syn) => syn.description),
    ['2🔥: +15% ATK'],
    'Shop preview should include synergies that would activate after buying the clicked shop card'
  );
});

await test('Selecting a third fire shop card previews the higher fire tier instead of both attack tiers', () => {
  const {
    Game,
    clickShop,
    getCurrentUnitDetail,
    setElementSynergies,
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

  setElementSynergies([
    { element: 'fire', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
    { element: 'fire', requiredCount: 3, bonus: { stat: 'attack', multiplier: 1.30 }, description: '3🔥: +30% ATK' },
  ]);

  Game.state.playerUnits = [
    {
      id: 'p-fire-a',
      name: 'Fire A',
      definition: {
        id: 'fire-a',
        name: 'Fire A',
        element: 'fire',
        cost: 1,
        tier: 1,
        stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
        ability: { name: 'Spark', description: 'Test ability', cooldown: 1 },
      },
      hp: 10,
      maxHp: 10,
      stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 0,
    },
    {
      id: 'p-fire-b',
      name: 'Fire B',
      definition: {
        id: 'fire-b',
        name: 'Fire B',
        element: 'fire',
        cost: 1,
        tier: 1,
        stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
        ability: { name: 'Blaze', description: 'Test ability', cooldown: 1 },
      },
      hp: 11,
      maxHp: 11,
      stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 1,
    },
  ];

  Game.state.shopUnits[0] = {
    id: 'shop-preview-fire-tier-3',
    name: 'Shop Preview Fire Tier 3',
    element: 'fire',
    cost: 1,
    tier: 1,
    stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
    ability: { name: 'Preview', description: 'Test ability', cooldown: 1 },
  };

  clickShop(0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Selecting a shop card should populate the detail payload');
  assert.deepEqual(
    (detail.synergies || []).map((syn) => syn.description),
    ['3🔥: +30% ATK'],
    'Shop preview should collapse same-stat tiers to the highest fire attack bonus after the purchase would complete 3 fire'
  );
});

await test('Selecting a third void shop card previews both active void tiers after the purchase', () => {
  const {
    Game,
    clickShop,
    getCurrentUnitDetail,
    setElementSynergies,
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

  setElementSynergies([
    { element: 'void', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.25 }, description: '2🕳️: +25% ATK' },
    { element: 'void', requiredCount: 3, bonus: { stat: 'hp', multiplier: 1.20 }, description: '3🕳️: +20% HP' },
  ]);

  Game.state.playerUnits = [
    {
      id: 'p-void-a',
      name: 'Void A',
      definition: {
        id: 'void-a',
        name: 'Void A',
        element: 'void',
        cost: 1,
        tier: 1,
        stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
        ability: { name: 'Spark', description: 'Test ability', cooldown: 1 },
      },
      hp: 10,
      maxHp: 10,
      stats: { hp: 10, attack: 6, defense: 2, speed: 3, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 0,
    },
    {
      id: 'p-void-b',
      name: 'Void B',
      definition: {
        id: 'void-b',
        name: 'Void B',
        element: 'void',
        cost: 1,
        tier: 1,
        stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
        ability: { name: 'Blaze', description: 'Test ability', cooldown: 1 },
      },
      hp: 11,
      maxHp: 11,
      stats: { hp: 11, attack: 7, defense: 2, speed: 2, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 1,
    },
  ];

  Game.state.shopUnits[0] = {
    id: 'shop-preview-void-tier-3',
    name: 'Shop Preview Void Tier 3',
    element: 'void',
    cost: 1,
    tier: 1,
    stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
    ability: { name: 'Preview', description: 'Test ability', cooldown: 1 },
  };

  clickShop(0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Selecting a shop card should populate the detail payload');
  assert.deepEqual(
    (detail.synergies || []).map((syn) => syn.description),
    ['2🕳️: +25% ATK', '3🕳️: +20% HP'],
    'Shop preview should keep both active void tiers when the purchase would add a new HP tier instead of replacing the attack tier'
  );
});

await test('Refreshing the shop clears any armed pending placement highlights', () => {
  const {
    Game,
    clickShop,
    clickTile,
    gridCalls,
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

  clickShop(0);
  const clearHighlightsBeforeRefresh = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending before the refresh');

  Game.refreshShop(false);

  assert.equal(Game.state.selectedShopIdx, null, 'Refreshing the shop should cancel the pending placement selection');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeRefresh + 1, 'Refreshing the shop should clear stale placement highlights');
  assert.equal(uiMessages.at(-1), '', 'Refreshing the shop should clear the stale placement prompt');

  clickTile(3, 0);

  assert.equal(Game.state.playerUnits.length, 0, 'Clicking a tile after the refresh should not place the previously selected shop unit');
});

await test('Clicking an invalid placement tile clears the canceled shop detail panel state', () => {
  const {
    Game,
    clickShop,
    clickTile,
    unitDetailCalls,
    getCurrentUnitDetail,
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

  clickShop(0);

  const clearDetailBeforeInvalidClick = unitDetailCalls.clear;

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending before the invalid tile click');
  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a shop card should populate detail before the invalid tile click');

  clickTile(1, 0);

  assert.equal(Game.state.selectedShopIdx, null, 'Invalid placement click should still cancel the pending shop purchase');
  assert.equal(getCurrentUnitDetail(), null, 'Invalid placement click should clear stale detail from the canceled shop card');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeInvalidClick + 1, 'Invalid placement cancel should explicitly clear the shop-card detail panel');
});

await test('Refreshing the shop clears any stale pending shop detail panel state', () => {
  const {
    Game,
    clickShop,
    unitDetailCalls,
    getCurrentUnitDetail,
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

  clickShop(0);

  const clearDetailBeforeRefresh = unitDetailCalls.clear;

  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a shop card should populate the shop detail panel before the refresh');

  Game.refreshShop(false);

  assert.equal(getCurrentUnitDetail(), null, 'Refreshing the shop should clear stale detail from the canceled pending shop card');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeRefresh + 1, 'Refreshing the shop should explicitly clear the canceled shop-card detail panel');
});

await test('Buying an upgrade clears any selected unit move state', () => {
  const {
    Game,
    clickTile,
    gridCalls,
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
    id: 'p-upgrade-move',
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

  clickTile(3, 0);

  const goldBeforeUpgrade = Game.state.gold;
  const clearSelectionBeforeUpgrade = gridCalls.clearSelection;
  const clearHighlightsBeforeUpgrade = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedUnit?.id, 'p-upgrade-move', 'Clicking the unit should select it before the upgrade purchase');

  Game.buyUpgrade('field_medic');

  assert.equal(Game.state.gold, goldBeforeUpgrade - 5, 'Upgrade purchase should still spend gold normally');
  assert.equal(Game.state.upgradeLevels.field_medic, 1, 'Upgrade purchase should still apply the upgrade effect');
  assert.equal(Game.state.selectedUnit, null, 'Upgrade purchases should cancel any hidden selected-unit move state');
  assert.equal(gridCalls.clearSelection, clearSelectionBeforeUpgrade + 1, 'Upgrade purchases should clear the stale tile selection for a selected unit');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeUpgrade + 1, 'Upgrade purchases should clear the stale move highlights for a selected unit');

  clickTile(4, 1);

  assert.equal(Game.state.playerUnits[0].row, 3, 'Clicking after the upgrade purchase should not move the previously selected unit');
  assert.equal(Game.state.playerUnits[0].col, 0, 'Upgrade purchases should leave the unit in place instead of keeping a hidden move selection');
});

await test('Upgrade purchases clear any stale selected unit detail panel state', () => {
  const {
    Game,
    clickTile,
    getCurrentUnitDetail,
    unitDetailCalls,
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
    id: 'p-upgrade-detail',
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

  clickTile(3, 0);

  const clearDetailBeforeUpgrade = unitDetailCalls.clear;

  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a unit should populate the detail panel before the upgrade purchase');
  assert.equal(Game.state.selectedUnit?.id, 'p-upgrade-detail', 'Unit should be selected before the upgrade purchase cancels it');

  Game.buyUpgrade('field_medic');

  assert.equal(Game.state.selectedUnit, null, 'Upgrade purchases should cancel the selected unit state');
  assert.equal(getCurrentUnitDetail(), null, 'Upgrade purchases should clear stale detail from the canceled selected unit');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeUpgrade + 1, 'Upgrade purchases should explicitly clear the canceled selected-unit detail panel');
});

await test('Multiplayer reroll clears any selected unit move state', () => {
  const {
    Game,
    clickTile,
    document,
    roomEvents,
    fireMultiplayerCallback,
    gridCalls,
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
    roomId: 'room-host-reroll-clear',
    opponentId: 'guest-reroll-clear',
    isHost: true,
  });

  fireMultiplayerCallback('onRoundReady', 1, 25);

  const def = Game.state.shopUnits[0];
  Game.state.playerUnits = [{
    id: 'p-mp-reroll-move',
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

  clickTile(3, 0);

  const clearSelectionBeforeReroll = gridCalls.clearSelection;
  const clearHighlightsBeforeReroll = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedUnit?.id, 'p-mp-reroll-move', 'Clicking the unit should select it before the multiplayer reroll');

  document.getElementById('btn-refresh')?.click();

  assert.equal(Game.state.selectedUnit, null, 'Multiplayer rerolls should cancel any hidden selected-unit move state');
  assert.equal(gridCalls.clearSelection, clearSelectionBeforeReroll + 1, 'Multiplayer rerolls should clear the stale tile selection for a selected unit');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeReroll + 1, 'Multiplayer rerolls should clear the stale move highlights for a selected unit');

  clickTile(4, 1);

  assert.equal(Game.state.playerUnits[0].row, 3, 'Clicking after the multiplayer reroll should not move the previously selected unit');
  assert.equal(Game.state.playerUnits[0].col, 0, 'Multiplayer rerolls should leave the unit in place instead of keeping a hidden move selection');
});

await test('Multiplayer reroll rerenders the upgrade list after spending gold', () => {
  const {
    Game,
    document,
    roomEvents,
    fireMultiplayerCallback,
    updateUpgradeCalls,
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
    roomId: 'room-host-reroll-upgrades',
    opponentId: 'guest-reroll-upgrades',
    isHost: true,
  });

  fireMultiplayerCallback('onRoundReady', 1, 25);

  const goldBeforeReroll = Game.state.gold;
  const upgradeRenderCountBeforeReroll = updateUpgradeCalls.length;

  document.getElementById('btn-refresh')?.click();

  assert.equal(Game.state.gold, goldBeforeReroll - 2, 'Multiplayer reroll should still deduct the reroll gold cost');
  assert.equal(updateUpgradeCalls.length, upgradeRenderCountBeforeReroll + 1, 'Multiplayer rerolls should rerender the upgrade list after the gold total changes');
  assert.equal(updateUpgradeCalls.at(-1)?.gold, Game.state.gold, 'Upgrade rerender after multiplayer reroll should use the updated gold total');
});

await test('Refreshing the shop clears any selected unit move state', () => {
  const {
    Game,
    clickTile,
    gridCalls,
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
    id: 'p-refresh-move',
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

  clickTile(3, 0);

  const clearSelectionBeforeRefresh = gridCalls.clearSelection;
  const clearHighlightsBeforeRefresh = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedUnit?.id, 'p-refresh-move', 'Clicking the unit should select it before the refresh');

  Game.refreshShop(false);

  assert.equal(Game.state.selectedUnit, null, 'Refreshing the shop should cancel any hidden selected-unit move state');
  assert.equal(gridCalls.clearSelection, clearSelectionBeforeRefresh + 1, 'Refreshing the shop should clear the stale tile selection for a selected unit');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeRefresh + 1, 'Refreshing the shop should clear the stale move highlights for a selected unit');

  clickTile(4, 1);

  assert.equal(Game.state.playerUnits[0].row, 3, 'Clicking after the refresh should not move the previously selected unit');
  assert.equal(Game.state.playerUnits[0].col, 0, 'Refreshing the shop should leave the unit in place instead of keeping a hidden move selection');
});

await test('Selecting a shop card clears any previously selected board unit state', () => {
  const {
    Game,
    clickTile,
    clickShop,
    document,
    gridCalls,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'btn-sell-unit',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const def = Game.state.shopUnits[0];
  Game.state.playerUnits = [{
    id: 'p-shop-clear',
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

  clickTile(3, 0);

  const clearSelectionBeforeShopClick = gridCalls.clearSelection;
  const clearHighlightsBeforeShopClick = gridCalls.clearHighlights;

  assert.equal(Game.state.selectedUnit?.id, 'p-shop-clear', 'Clicking the board unit should select it before choosing a shop card');

  clickShop(0);

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should still become the pending purchase');
  assert.equal(Game.state.selectedUnit, null, 'Choosing a shop card should clear the previously selected board unit state');
  assert.equal(gridCalls.clearSelection, clearSelectionBeforeShopClick + 1, 'Choosing a shop card should clear the stale tile selection from the board unit');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeShopClick + 1, 'Choosing a shop card should clear the board-unit move highlights before showing placement tiles');

  document.getElementById('btn-sell-unit')?.click();

  assert.equal(Game.state.playerUnits.length, 1, 'Shop-card selection should not leave a hidden selected unit that can still be sold from the detail panel');
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

await test('Starting battle clears any stale prep unit detail panel state', () => {
  const {
    Game,
    clickTile,
    unitDetailCalls,
    getCurrentUnitDetail,
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
    id: 'p-battle-detail',
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

  clickTile(3, 0);

  const clearDetailBeforeBattle = unitDetailCalls.clear;

  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a unit in prep should populate the detail panel before battle starts');

  Game.startBattle();

  assert.equal(Game.state.phase, 'battle', 'Starting battle should still advance into the battle phase');
  assert.equal(getCurrentUnitDetail(), null, 'Starting battle should clear stale prep unit detail instead of leaving a non-selected unit card visible');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeBattle + 1, 'Starting battle should explicitly clear the prep detail panel');
});

await test('Moving a selected unit clears the stale prep unit detail panel state', () => {
  const {
    Game,
    clickTile,
    unitDetailCalls,
    getCurrentUnitDetail,
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
    id: 'p-move-detail',
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

  clickTile(3, 0);

  const clearDetailBeforeMove = unitDetailCalls.clear;

  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting a unit should populate the detail panel before moving it');

  clickTile(4, 1);

  assert.equal(Game.state.selectedUnit, null, 'Moving a unit should still end the move-selection state');
  assert.equal(getCurrentUnitDetail(), null, 'Moving a unit should clear the detail panel once the selection is consumed');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeMove + 1, 'Moving a unit should explicitly clear the stale prep detail panel');
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

await test('Selling a selected unit clears move selection highlights and selection state', () => {
  const {
    Game,
    clickTile,
    document,
    getCurrentUnitDetail,
    gridCalls,
    unitDetailCalls,
  } = loadGameContext({
    savedSession: null,
    domElementIds: [
      'screen-game',
      'btn-battle',
      'btn-refresh',
      'btn-sell-unit',
    ],
  });

  Game.init();
  Game.startGame('normal');

  const def = Game.state.shopUnits[0];
  Game.state.playerUnits = [{
    id: 'p-sell',
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

  clickTile(3, 0);

  const clearSelectionBeforeSell = gridCalls.clearSelection;
  const clearHighlightsBeforeSell = gridCalls.clearHighlights;
  const clearDetailBeforeSell = unitDetailCalls.clear;

  assert.equal(Game.state.selectedUnit?.id, 'p-sell', 'Clicking the unit should select it before selling');
  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting the unit should populate the detail panel before selling');

  document.getElementById('btn-sell-unit')?.click();

  assert.equal(Game.state.playerUnits.length, 0, 'Selling the selected unit should remove it from the board');
  assert.equal(Game.state.selectedUnit, null, 'Selling the selected unit should clear the selection state');
  assert.equal(getCurrentUnitDetail(), null, 'Selling the selected unit should clear stale detail from the sold unit');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeSell + 1, 'Selling the selected unit should explicitly clear the sold-unit detail panel');
  assert.equal(gridCalls.clearSelection, clearSelectionBeforeSell + 1, 'Selling the selected unit should clear the stale tile selection');
  assert.equal(gridCalls.clearHighlights, clearHighlightsBeforeSell + 1, 'Selling the selected unit should clear the stale move highlights');
});

await test('Right-click sell cancels any armed pending shop purchase', () => {
  const {
    Game,
    clickShop,
    clickTile,
    clickTileRight,
    clickSellConfirmYes,
    getCurrentUnitDetail,
    unitDetailCalls,
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
    id: 'p-right-click-sell',
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

  clickShop(0);

  const clearDetailBeforeSell = unitDetailCalls.clear;

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should be pending before the right-click sell flow');
  assert.notEqual(getCurrentUnitDetail(), null, 'Selecting the shop card should populate the detail panel before the right-click sell flow');

  clickTileRight(3, 0);
  clickSellConfirmYes();

  assert.equal(Game.state.playerUnits.length, 0, 'Right-click sell confirm should still sell the unit');
  assert.equal(Game.state.selectedShopIdx, null, 'Selling through the confirm popup should cancel any pending shop placement');
  assert.equal(getCurrentUnitDetail(), null, 'Right-click sell confirm should clear stale detail from the canceled shop card');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeSell + 2, 'Right-click sell confirm should clear both the canceled shop detail and the sold-unit detail state');

  clickTile(4, 1);

  assert.equal(Game.state.playerUnits.length, 0, 'Clicking after the sell confirm should not place the previously armed shop unit');
  assert.notEqual(Game.state.shopUnits[0], null, 'Canceling the pending purchase during sell should leave the shop card available');
});

await test('Canceling a selected-unit sell confirm keeps the selection and detail panel intact', () => {
  const {
    Game,
    clickTile,
    clickTileRight,
    document,
    getCurrentUnitDetail,
    unitDetailCalls,
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
    id: 'p-sell-cancel',
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

  clickTile(3, 0);

  const clearDetailBeforeCancel = unitDetailCalls.clear;
  const detailBeforeCancel = getCurrentUnitDetail();

  assert.equal(Game.state.selectedUnit?.id, 'p-sell-cancel', 'Clicking the unit should select it before opening the sell confirm');
  assert.ok(detailBeforeCancel, 'Selecting the unit should populate the detail panel before canceling the sell confirm');

  clickTileRight(3, 0);
  document.querySelector('.sell-confirm')?.querySelector('.sell-no')?.click();

  assert.equal(Game.state.playerUnits.length, 1, 'Canceling the sell confirm should keep the selected unit on the board');
  assert.equal(Game.state.selectedUnit?.id, 'p-sell-cancel', 'Canceling the sell confirm should keep the selected unit state intact');
  assert.deepEqual(getCurrentUnitDetail(), detailBeforeCancel, 'Canceling the sell confirm should preserve the selected-unit detail panel');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeCancel, 'Canceling the sell confirm should not clear the selected-unit detail panel');
});

await test('Canceling a right-click sell confirm keeps the armed shop preview intact', () => {
  const {
    Game,
    clickShop,
    clickTileRight,
    document,
    getCurrentUnitDetail,
    unitDetailCalls,
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
    id: 'p-right-click-sell-cancel',
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

  clickShop(0);

  const clearDetailBeforeCancel = unitDetailCalls.clear;
  const detailBeforeCancel = getCurrentUnitDetail();

  assert.equal(Game.state.selectedShopIdx, 0, 'Shop card should still be armed before canceling the sell confirm');
  assert.ok(detailBeforeCancel, 'Selecting the shop card should populate the preview detail before canceling the sell confirm');

  clickTileRight(3, 0);
  document.querySelector('.sell-confirm')?.querySelector('.sell-no')?.click();

  assert.equal(Game.state.playerUnits.length, 1, 'Canceling the sell confirm should keep the unit on the board');
  assert.equal(Game.state.selectedShopIdx, 0, 'Canceling the sell confirm should keep the pending shop purchase armed');
  assert.deepEqual(getCurrentUnitDetail(), detailBeforeCancel, 'Canceling the sell confirm should preserve the armed shop preview detail');
  assert.equal(unitDetailCalls.clear, clearDetailBeforeCancel, 'Canceling the sell confirm should not clear the detail panel');
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

await test('Host battle_start snapshot keeps the upgraded prep stats shown in selected unit detail', () => {
  const {
    Game,
    roomEvents,
    replayControls,
    fireMultiplayerCallback,
    clickTile,
    getCurrentUnitDetail,
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
      'btn-sell-unit',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-battle-start-stats',
    opponentId: 'guest-battle-start-stats',
    isHost: true,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'p-battle-start-stats',
    name: 'Battle Start Stat Unit',
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
  clickTile(4, 0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Selecting the upgraded unit should populate the prep detail panel before battle starts');
  assert.equal(detail.unit.stats.attack, 5, 'Selected unit detail should show the upgraded prep attack');
  assert.equal(detail.unit.stats.defense, 1, 'Selected unit detail should show the upgraded prep defense');

  fireMultiplayerCallback('onBothReady');

  assert.equal(replayControls.plays.length, 1, 'Host battle start should create a replay payload');
  const battleStart = replayControls.plays[0].replayLog.events.find((evt) => evt.type === 'battle_start');
  assert.ok(battleStart, 'Host replay payload should include a battle_start snapshot');
  assert.equal(battleStart.playerUnits[0].stats.attack, detail.unit.stats.attack, 'battle_start should keep the upgraded attack shown in prep detail');
  assert.equal(battleStart.playerUnits[0].stats.defense, detail.unit.stats.defense, 'battle_start should keep the upgraded defense shown in prep detail');
  assert.equal(battleStart.playerUnits[0].stats.speed, detail.unit.stats.speed, 'battle_start should keep the upgraded speed shown in prep detail');
  assert.equal(battleStart.playerUnits[0].row, detail.unit.row, 'battle_start should keep the prep row shown in selected unit detail');
  assert.equal(battleStart.playerUnits[0].col, detail.unit.col, 'battle_start should keep the prep column shown in selected unit detail');
});

await test('Inspecting a multiplayer replay unit marks battle stats as already boosted for detail rendering', () => {
  const {
    Game,
    roomEvents,
    replayControls,
    fireMultiplayerCallback,
    clickTile,
    getCurrentUnitDetail,
    setElementSynergies,
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
      'btn-sell-unit',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-replay-detail',
    opponentId: 'guest-replay-detail',
    isHost: true,
  });

  setElementSynergies([
    { element: 'fire', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  ]);

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [
    {
      id: 'p-replay-a',
      name: 'Replay Fire A',
      definition: {
        id: 'test_unit',
        name: 'Test Unit',
        element: 'fire',
        stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 4,
      col: 0,
    },
    {
      id: 'p-replay-b',
      name: 'Replay Fire B',
      definition: {
        id: 'test_unit_b',
        name: 'Test Unit B',
        element: 'fire',
        stats: { hp: 12, attack: 5, defense: 2, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 5, defense: 2, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 4,
      col: 1,
    },
  ];

  fireMultiplayerCallback('onBothReady');

  assert.equal(replayControls.plays.length, 1, 'Host replay playback should start once the round begins');

  clickTile(4, 0);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Clicking a replay unit during battle should populate the detail panel');
  assert.equal(detail.unit.stats.attack, 4, 'Replay detail should receive the battle snapshot attack from the clicked unit');
  assert.equal(detail.unit._alreadyBoosted, true, 'Replay detail should mark battle snapshot stats as already boosted so UI does not project synergies a second time');
  assert.deepEqual((detail.synergies || []).map((syn) => syn.description), ['2🔥: +15% ATK'], 'Replay detail should still receive the active player synergies for pill display');
});

await test('Guest replay inspection after resume uses the mirrored live replay unit instead of stale prep state', () => {
  const {
    Game,
    roomEvents,
    replayControls,
    fireMultiplayerCallback,
    setRound,
    clickTile,
    emitRoomStateChange,
    getGridUnits,
    getCurrentUnitDetail,
    setElementSynergies,
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
      'btn-sell-unit',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-guest-replay-resume-detail',
    opponentId: 'host-replay-resume-detail',
    isHost: false,
  });

  setRound(1);
  setElementSynergies([
    { element: 'fire', requiredCount: 2, bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  ]);

  Game.state.playerUnits = [
    {
      id: 'guest-prep-a',
      name: 'Guest Prep Fire A',
      definition: {
        id: 'guest-fire-a',
        name: 'Guest Fire A',
        element: 'fire',
        stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 4,
      col: 2,
    },
    {
      id: 'guest-prep-b',
      name: 'Guest Prep Fire B',
      definition: {
        id: 'guest-fire-b',
        name: 'Guest Fire B',
        element: 'fire',
        stats: { hp: 12, attack: 5, defense: 2, speed: 1, range: 1 },
      },
      hp: 12,
      maxHp: 12,
      stats: { hp: 12, attack: 5, defense: 2, speed: 1, range: 1 },
      statusEffects: [],
      abilityCooldown: 0,
      isEnemy: false,
      row: 3,
      col: 2,
    },
  ];

  fireMultiplayerCallback('onBothReady');

  const replayPayload = {
    roundNumber: 1,
    boardHash: 'guest-resume-replay-hash',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          seq: 1,
          turn: 0,
          playerUnits: [
            {
              id: 'host-replay-a',
              defId: 'host-fire-a',
              name: 'Host Replay Fire A',
              isEnemy: false,
              hp: 12,
              maxHp: 12,
              row: 4,
              col: 0,
              stats: { hp: 12, attack: 7, defense: 2, speed: 1, range: 1 },
              abilityCooldown: 0,
              statusEffects: [],
            },
          ],
          enemyUnits: [
            {
              id: 'guest-replay-a',
              defId: 'guest-fire-a',
              name: 'Guest Replay Fire A',
              isEnemy: true,
              hp: 12,
              maxHp: 12,
              row: 0,
              col: 0,
              stats: { hp: 12, attack: 6, defense: 2, speed: 1, range: 1 },
              abilityCooldown: 0,
              statusEffects: [],
            },
          ],
        },
        {
          type: 'turn_start',
          seq: 2,
          turn: 1,
        },
        {
          type: 'battle_end',
          seq: 3,
          turn: 1,
          playerWon: true,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  };

  emitRoomStateChange('battle_replay', replayPayload);
  emitRoomStateChange('phase_event', {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 1,
    boardHash: 'guest-resume-replay-hash',
  });
  emitRoomStateChange('playback_checkpoint', {
    roundNumber: 1,
    seq: 2,
    turn: 1,
    boardHash: 'guest-resume-replay-hash',
  });
  emitRoomStateChange('phase_event', {
    type: 'playback_paused',
    roundNumber: 1,
    checkpointSeq: 2,
    checkpointTurn: 1,
    boardHash: 'guest-resume-replay-hash',
  });
  emitRoomStateChange('phase_event', {
    type: 'playback_resume_pending',
    roundNumber: 1,
    checkpointSeq: 2,
    checkpointTurn: 1,
    boardHash: 'guest-resume-replay-hash',
    resumeAt: 12345,
  });
  emitRoomStateChange('phase_event', {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 2,
    checkpointTurn: 1,
    boardHash: 'guest-resume-replay-hash',
    resumed: true,
  });

  assert.equal(replayControls.plays.length, 2, 'Guest replay should restart once playback resumes');

  const gridUnits = getGridUnits();
  assert.equal(gridUnits.length, 2, `Guest replay resume should render two replay units, got ${JSON.stringify(gridUnits)}`);

  const resumedGuestReplayUnit = gridUnits.find((entry) => entry?.unit?.stats?.attack === 6);
  assert.ok(resumedGuestReplayUnit, `Guest replay resume should render the mirrored guest replay unit, got ${JSON.stringify(gridUnits)}`);

  const [renderedRow, renderedCol] = resumedGuestReplayUnit.key.split(',').map((value) => Number(value));

  clickTile(renderedRow, renderedCol);

  const detail = getCurrentUnitDetail();
  assert.ok(detail, 'Clicking the rendered guest replay unit after resume should populate the detail panel');
  assert.equal(detail.unit.stats.attack, 6, 'Guest replay detail should come from the mirrored replay snapshot instead of the stale prep attack');
  assert.equal(detail.unit._alreadyBoosted, true, 'Guest replay detail after resume should still mark battle stats as already boosted');
  assert.deepEqual((detail.synergies || []).map((syn) => syn.description), ['2🔥: +15% ATK'], 'Guest replay detail should still use the local player synergy pills after mirroring');
});

await test('Guest room-watch resubscribe does not restart replay again after reconnect already resumed it', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    intervals,
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
    roomId: 'room-guest-room-watch-replay',
    opponentId: 'host-room-watch-replay',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-room-watch-unit',
    name: 'Guest Room Watch Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  roomStatus.state.battle_replay = {
    roundNumber: 1,
    boardHash: 'room-watch-replay-hash',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          seq: 1,
          turn: 0,
          playerUnits: [],
          enemyUnits: [],
        },
        { type: 'turn_start', seq: 1, turn: 1 },
        {
          type: 'battle_end',
          playerWon: false,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  };
  roomStatus.state.phase_event = {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 0,
    checkpointTurn: 0,
    boardHash: 'room-watch-replay-hash',
  };

  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]?.();

  assert.equal(replayControls.plays.length, 1, 'Guest reconnect should resume replay once from cached room state');

  intervals[0].fn();

  assert.equal(replayControls.plays.length, 1, 'The later SUBSCRIBED room-watch tick should not restart the same replay a second time');
});

await test('Guest reconnect cycle resends cached round_result sync only once when reconnect and room-watch both fire', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    intervals,
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
    roomId: 'room-guest-reconnect-result',
    opponentId: 'host-reconnect-result',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-reconnect-result-unit',
    name: 'Guest Reconnect Result Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');
  emitRoomStateChange('round_result', { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' });

  assert.equal(roomEvents.syncCalls.filter((entry) => entry.key === 'round_result_ack' && entry.value.seq === 7).length, 1, 'Guest should emit the initial round_result_ack when the host result arrives');
  assert.equal(roomEvents.syncCalls.filter((entry) => entry.key === 'ready_to_continue' && entry.value.seq === 7).length, 1, 'Guest should emit the initial ready_to_continue when the host result arrives');

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]?.();
  intervals[0].fn();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'round_result_ack' && entry.value.seq === 7).length, 1, 'Guest reconnect should resend round_result_ack only once across reconnect plus room-watch resubscribe');
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'ready_to_continue' && entry.value.seq === 7).length, 1, 'Guest reconnect should resend ready_to_continue only once across reconnect plus room-watch resubscribe');
});

await test('Guest reconnect cycle does not stack cache-check resend on top of a duplicate round_result rebroadcast', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    intervals,
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
    roomId: 'room-guest-reconnect-result-broadcast',
    opponentId: 'host-reconnect-result-broadcast',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-reconnect-result-broadcast-unit',
    name: 'Guest Reconnect Result Broadcast Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');
  emitRoomStateChange('round_result', { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' });

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]?.();
  emitRoomStateChange('round_result', { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' });
  intervals[0].fn();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'round_result_ack' && entry.value.seq === 7).length, 1, 'Guest reconnect should emit only one round_result_ack when a duplicate round_result rebroadcast arrives before the room-watch cache-check');
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'ready_to_continue' && entry.value.seq === 7).length, 1, 'Guest reconnect should emit only one ready_to_continue when a duplicate round_result rebroadcast arrives before the room-watch cache-check');
});

await test('Guest reconnect prefers cached round_result over retained replay payloads', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    intervals,
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
    roomId: 'room-guest-reconnect-result-priority',
    opponentId: 'host-reconnect-result-priority',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-reconnect-result-priority-unit',
    name: 'Guest Reconnect Result Priority Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');
  emitRoomStateChange('round_result', { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' });

  roomStatus.state.battle_replay = {
    roundNumber: 1,
    boardHash: 'hash-123',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          seq: 1,
          turn: 0,
          playerUnits: [],
          enemyUnits: [],
        },
        { type: 'turn_start', seq: 1, turn: 1 },
        {
          type: 'battle_end',
          playerWon: false,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  };
  roomStatus.state.phase_event = {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 0,
    checkpointTurn: 0,
    boardHash: 'hash-123',
  };

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]?.();
  intervals[0].fn();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(replayControls.plays.length, 0, 'Guest reconnect should not restart replay when a matching cached round_result already resolves the round');
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'round_result_ack' && entry.value.seq === 7).length, 1, 'Guest reconnect should still resend round_result_ack once when result cache is retained');
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'ready_to_continue' && entry.value.seq === 7).length, 1, 'Guest reconnect should still resend ready_to_continue once when result cache is retained');
});

await test('Guest ignores replay rebroadcasts when room cache already has a matching round_result', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    intervals,
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
    roomId: 'room-guest-reconnect-rebroadcast-priority',
    opponentId: 'host-reconnect-rebroadcast-priority',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-reconnect-rebroadcast-priority-unit',
    name: 'Guest Reconnect Rebroadcast Priority Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');

  roomStatus.state.round_result = { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' };
  roomStatus.state.battle_replay = {
    roundNumber: 1,
    boardHash: 'hash-123',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          seq: 1,
          turn: 0,
          playerUnits: [],
          enemyUnits: [],
        },
        { type: 'turn_start', seq: 1, turn: 1 },
        {
          type: 'battle_end',
          playerWon: false,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  };
  roomStatus.state.phase_event = {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 0,
    checkpointTurn: 0,
    boardHash: 'hash-123',
  };

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  emitRoomStateChange('battle_replay', roomStatus.state.battle_replay);
  emitRoomStateChange('phase_event', roomStatus.state.phase_event);
  roomEvents.reconnectHandlers[0]?.();
  intervals[0].fn();

  assert.equal(replayControls.plays.length, 0, 'Guest should not restart replay from a reconnect rebroadcast when room cache already contains a matching round_result');
});

await test('Guest does not request missing battle_replay when room cache already has a matching round_result', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    intervals,
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
    roomId: 'room-guest-reconnect-no-replay-request',
    opponentId: 'host-reconnect-no-replay-request',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-reconnect-no-replay-request-unit',
    name: 'Guest Reconnect No Replay Request Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');

  roomStatus.state.round_result = { hostWon: true, roundNumber: 1, seq: 7, boardHash: 'hash-123' };
  roomStatus.state.phase_event = {
    type: 'playback_start',
    roundNumber: 1,
    checkpointSeq: 0,
    checkpointTurn: 0,
    boardHash: 'hash-123',
  };

  roomStatus.connectionState = 'CHANNEL_ERROR';
  roomStatus.lifecycleState = 'DISCONNECTED';
  intervals[0].fn();

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  emitRoomStateChange('phase_event', roomStatus.state.phase_event);
  roomEvents.reconnectHandlers[0]?.();
  intervals[0].fn();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'request_authoritative_state' && entry.value.reason === 'missing_battle_replay'), false, 'Guest should not request missing battle_replay when a matching cached round_result already resolves the round');
});

await test('Next prep round clears stale guest reconnect replay hooks from the prior battle session', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
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
    roomId: 'room-guest-stale-replay-hooks',
    opponentId: 'host-stale-replay-hooks',
    isHost: false,
  });

  fireMultiplayerCallback('onRoundReady', 1, 30);
  Game.state.playerUnits = [{
    id: 'guest-session-unit',
    name: 'Guest Session Unit',
    definition: {
      id: 'test_unit',
      name: 'Test Unit',
      element: 'fire',
      stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    },
    hp: 12,
    maxHp: 12,
    stats: { hp: 12, attack: 4, defense: 2, speed: 1, range: 1 },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row: 4,
    col: 0,
  }];

  fireMultiplayerCallback('onBothReady');

  assert.equal(replayControls.plays.length, 0, 'Guest battle startup should still be waiting on the host replay payload');

  fireMultiplayerCallback('onRoundReady', 2, 20);

  assert.equal(Game.state.phase, 'prep', 'Starting the next round should return the guest to prep before reconnect checks run');

  roomStatus.state.battle_replay = {
    boardHash: 'stale-replay-hash',
    hostWon: true,
    replayLog: {
      events: [
        {
          type: 'battle_start',
          playerUnits: [],
          enemyUnits: [],
        },
        { type: 'turn_start', seq: 1, turn: 1 },
        {
          type: 'battle_end',
          playerWon: false,
          playerUnits: [],
          enemyUnits: [],
        },
      ],
    },
  };
  roomStatus.state.phase_event = {
    type: 'playback_start',
    checkpointSeq: 0,
    checkpointTurn: 0,
    boardHash: 'stale-replay-hash',
  };

  roomEvents.reconnectHandlers[0]?.();

  assert.equal(replayControls.plays.length, 0, 'Prep-round cleanup should disable stale reconnect replay hooks from the previous battle session');
  assert.equal(Game.state.phase, 'prep', 'Stale reconnect hooks should not pull the guest back into battle after the next prep round begins');
});

await test('Host reconnect during battle re-broadcasts paused replay state and schedules resume', () => {
  const {
    Game,
    clickTile,
    getCurrentUnitDetail,
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
  assert.equal(reconnectSyncs.filter((entry) => entry.key === 'battle_replay').length, 1, 'Host should re-broadcast battle_replay only once on reconnect while paused');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_resume_pending'), true, 'Host should schedule a resume_pending phase_event');

  const resumeTimeout = [...timeouts].reverse().find((entry) => entry.delay === 3000);
  assert.ok(resumeTimeout, 'Reconnect should arm a replay resume timer');

  const syncCountBeforeResume = roomEvents.syncCalls.length;
  resumeTimeout.fn();

  const resumeSyncs = roomEvents.syncCalls.slice(syncCountBeforeResume);
  assert.equal(resumeSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'playback_start' && entry.value.resumed === true), true, 'Resume timer should re-emit playback_start with resumed=true');
  assert.equal(replayControls.plays.length, 2, 'Host should restart replay playback from the paused checkpoint');

  clickTile(4, 0);

  const resumedDetail = getCurrentUnitDetail();
  assert.ok(resumedDetail, 'Clicking a unit after replay resume should still populate the detail panel');
  assert.equal(resumedDetail.unit._alreadyBoosted, true, 'Replay inspection after resume should still use the live replay snapshot instead of stale prep-state units');
});

await test('Host reconnect after round_result re-broadcasts result state without stale battle_replay', async () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
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
    roomId: 'room-host-result-reconnect',
    opponentId: 'guest-result-reconnect',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [{
    id: 'host-result-reconnect-unit',
    name: 'Host Result Reconnect Unit',
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
  assert.ok(replayControls.current, 'Host battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'round_result'), true, 'Host round-end flow should broadcast round_result before reconnect assertions');
  assert.equal(roomEvents.syncCalls.some((entry) => entry.key === 'phase_event' && entry.value.type === 'result_show'), true, 'Host round-end flow should publish result_show before reconnect assertions');

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'battle_replay'), false, 'Host reconnect should not rebroadcast stale battle_replay once round_result already exists');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'result_show'), true, 'Host reconnect should still rebroadcast result_show for the resolved round');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'round_result'), true, 'Host reconnect should still rebroadcast round_result for the resolved round');
});

await test('Host reconnect releases held round advance when cached guest continue signals already match the current result', async () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    multiplayerEvents,
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
    roomId: 'room-host-result-reconnect-cached-continue',
    opponentId: 'guest-result-reconnect-cached-continue',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [{
    id: 'host-result-reconnect-cached-continue-unit',
    name: 'Host Result Reconnect Cached Continue Unit',
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
  assert.ok(replayControls.current, 'Host battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const roundResultSync = roomEvents.syncCalls.find((entry) => entry.key === 'round_result');
  assert.ok(roundResultSync, 'Host round-end flow should broadcast round_result before reconnect assertions');
  assert.equal(multiplayerEvents.endRoundCalls.length, 0, 'Held round advance should not release before guest continue signals are observed');

  roomStatus.state.round_result_ack = {
    roundNumber: roundResultSync.value.roundNumber,
    seq: roundResultSync.value.seq,
    at: 1000,
  };
  roomStatus.state.ready_to_continue = {
    roundNumber: roundResultSync.value.roundNumber,
    seq: roundResultSync.value.seq,
    at: 1001,
  };

  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]();

  assert.equal(multiplayerEvents.endRoundCalls.length, 1, 'Host reconnect should consume matching cached guest continue signals and release the held round advance');
});

await test('Host reconnect skips resolved-round rebroadcast churn when cached guest continue signals already match', async () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    multiplayerEvents,
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
    roomId: 'room-host-result-reconnect-no-churn',
    opponentId: 'guest-result-reconnect-no-churn',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [{
    id: 'host-result-reconnect-no-churn-unit',
    name: 'Host Result Reconnect No Churn Unit',
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
  assert.ok(replayControls.current, 'Host battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const roundResultSync = roomEvents.syncCalls.find((entry) => entry.key === 'round_result');
  assert.ok(roundResultSync, 'Host round-end flow should broadcast round_result before reconnect assertions');
  assert.equal(multiplayerEvents.endRoundCalls.length, 0, 'Held round advance should still be waiting before reconnect');

  roomStatus.state.round_result_ack = {
    roundNumber: roundResultSync.value.roundNumber,
    seq: roundResultSync.value.seq,
    at: 1100,
  };
  roomStatus.state.ready_to_continue = {
    roundNumber: roundResultSync.value.roundNumber,
    seq: roundResultSync.value.seq,
    at: 1101,
  };

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(multiplayerEvents.endRoundCalls.length, 1, 'Host reconnect should still release the held round advance when cached guest continue signals match');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'result_show'), false, 'Host reconnect should skip result_show rebroadcast churn when guest catch-up is already confirmed from cached room state');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'round_result'), false, 'Host reconnect should skip round_result rebroadcast churn when guest catch-up is already confirmed from cached room state');
});

await test('Host reconnect during next prep round does not rebroadcast stale prior-round result payloads', async () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
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
      'btn-mp-ready',
      'mp-ready-opp-status',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-prep-reconnect',
    opponentId: 'guest-prep-reconnect',
    isHost: true,
  });

  setRound(2);
  Game.state.playerUnits = [{
    id: 'host-prep-reconnect-unit',
    name: 'Host Prep Reconnect Unit',
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
  assert.ok(replayControls.current, 'Host battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  fireMultiplayerCallback('onRoundReady', 3, 20);
  roomStatus.state.prep_state = {
    roundNumber: 3,
    revision: 1,
    units: [],
  };

  const syncCountBeforeReconnect = roomEvents.syncCalls.length;
  roomStatus.connectionState = 'SUBSCRIBED';
  roomStatus.lifecycleState = 'ACTIVE';
  roomEvents.reconnectHandlers[0]();

  const reconnectSyncs = roomEvents.syncCalls.slice(syncCountBeforeReconnect);
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'prep_state'), true, 'Host reconnect during prep should still rebroadcast current prep_state');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'round_result'), false, 'Host reconnect during the next prep round should not rebroadcast the previous round_result');
  assert.equal(reconnectSyncs.some((entry) => entry.key === 'phase_event' && entry.value.type === 'result_show'), false, 'Host reconnect during the next prep round should not rebroadcast the previous result_show phase event');
});

await test('Host serves retained authoritative_state for an older unresolved battle round after advancing', () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    setRound,
    setScores,
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

  setScores({ my: 1, opp: 1 });
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
  setScores({ my: 2, opp: 1 });
  roomStatus.state.prep_p1 = { roundNumber: 5, gold: 23 };
  roomStatus.state.prep_p2 = { roundNumber: 5, gold: 19 };

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
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.goldBySlot || {}, {
    p1: null,
    p2: null,
  }, 'Older retained authoritative_state should not leak newer prep gold into matchState metadata');
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scores || {}, {
    my: 1,
    opp: 1,
  }, 'Older retained authoritative_state should not leak newer live scores into matchState metadata');
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scoresBeforeResult || {}, {
    my: 1,
    opp: 1,
  }, 'Older unresolved authoritative_state should keep the response-round pre-result scores instead of the current live scoreboard');
});

await test('Host serves older resolved authoritative_state with response-round scores instead of current live scores', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    setScores,
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
    roomId: 'room-host-older-resolved-123',
    opponentId: 'guest-older-resolved-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host round 4 battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  setRound(5);
  setScores({ my: 3, opp: 1 });

  const syncCountBeforeRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
  });

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequest);
  const authoritativeSync = requestSyncs.find((entry) => entry.key === 'authoritative_state');
  assert.ok(authoritativeSync, 'Host should answer the older resolved round with retained authoritative_state');
  assert.equal(authoritativeSync.value.roundNumber, 4);
  assert.deepEqual(Object.keys(authoritativeSync.value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ]);
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scoresBeforeResult || {}, {
    my: 1,
    opp: 1,
  }, 'Older resolved authoritative_state should keep the response-round pre-result scores instead of the current live scoreboard');
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scores || {}, {
    my: 2,
    opp: 1,
  }, 'Older resolved authoritative_state should derive resolved scores from the retained response-round snapshot plus the retained round_result');
});

await test('Host serves current resolved authoritative_state with response-round scores before round advance releases', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    setScores,
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
    roomId: 'room-host-current-resolved-123',
    opponentId: 'guest-current-resolved-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host current-round battle replay should be active before resolving the round');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const syncCountBeforeRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
  });

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequest);
  const authoritativeSync = requestSyncs.find((entry) => entry.key === 'authoritative_state');
  assert.ok(authoritativeSync, 'Host should answer the current resolved round with authoritative_state before held round advance is released');
  assert.equal(authoritativeSync.value.roundNumber, 4);
  assert.deepEqual(Object.keys(authoritativeSync.value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ]);
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scoresBeforeResult || {}, {
    my: 1,
    opp: 1,
  }, 'Current resolved authoritative_state should preserve the response-round pre-result scores while round advance is still held');
  assert.deepEqual(authoritativeSync.value.meta?.matchState?.scores || {}, {
    my: 2,
    opp: 1,
  }, 'Current resolved authoritative_state should expose the resolved response-round scores even before MultiplayerGame advances its live scoreboard');
});

await test('Host ignores duplicate identical authoritative_state requests when the round state is unchanged', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    setScores,
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
    roomId: 'room-host-dedupe-request-123',
    opponentId: 'guest-dedupe-request-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host battle replay should be active before testing duplicate authoritative requests');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const duplicateRequest = {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
    checkpointSeq: 0,
  };

  const syncCountBeforeRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', duplicateRequest);
  emitRoomStateChange('request_authoritative_state', duplicateRequest);

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequest);
  assert.equal(requestSyncs.filter((entry) => entry.key === 'authoritative_state').length, 1, 'Host should emit only one authoritative_state bundle when an identical request is repeated without any round-state change');
});

await test('Host re-sends authoritative_state when a same-round request changes checkpointSeq', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    setScores,
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
    roomId: 'room-host-dedupe-checkpoint-123',
    opponentId: 'guest-dedupe-checkpoint-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host battle replay should be active before testing changed authoritative requests');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const syncCountBeforeRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
    checkpointSeq: 0,
  });
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
    checkpointSeq: 4,
  });

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequest).filter((entry) => entry.key === 'authoritative_state');
  assert.equal(requestSyncs.length, 2, 'Host should emit a fresh authoritative_state bundle when a same-round request changes checkpointSeq');
  assert.equal(requestSyncs.at(-1)?.value?.meta?.request?.checkpointSeq, 4, 'The latest authoritative response should reflect the changed checkpointSeq request metadata');
});

await test('Host re-sends authoritative_state when the response state changes for the same request', async () => {
  const {
    Game,
    roomEvents,
    replayControls,
    setRound,
    setScores,
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
    roomId: 'room-host-dedupe-response-change-123',
    opponentId: 'guest-dedupe-response-change-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host battle replay should be active before testing response-state changes');

  const repeatedRequest = {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
    checkpointSeq: 0,
  };

  const syncCountBeforeRequests = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', repeatedRequest);

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  emitRoomStateChange('request_authoritative_state', repeatedRequest);

  const requestSyncs = roomEvents.syncCalls.slice(syncCountBeforeRequests).filter((entry) => entry.key === 'authoritative_state');
  assert.equal(requestSyncs.length, 2, 'Host should emit a fresh authoritative_state bundle when the repeated request sees new response state');
  assert.deepEqual(Object.keys(requestSyncs[0].value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
  ], 'The first authoritative response should reflect the unresolved battle state');
  assert.deepEqual(Object.keys(requestSyncs[1].value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
    'round_result',
  ], 'The second authoritative response should reflect the newly resolved round state');
});

await test('Host serves an older retained authoritative_state again after prep resets the dedupe cache', async () => {
  const {
    Game,
    roomEvents,
    roomStatus,
    replayControls,
    setRound,
    setScores,
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
      'btn-mp-ready',
      'mp-ready-opp-status',
    ],
  });

  Game.init();
  roomEvents.matchFoundHandler({
    roomId: 'room-host-dedupe-reset-123',
    opponentId: 'guest-dedupe-reset-456',
    isHost: true,
  });

  setScores({ my: 1, opp: 1 });
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
  assert.ok(replayControls.current, 'Host battle replay should be active before testing dedupe reset across prep');

  replayControls.current.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const repeatedRequest = {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
    checkpointSeq: 0,
  };

  const syncCountBeforeCurrentRoundRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', repeatedRequest);
  const currentRoundRequestSyncs = roomEvents.syncCalls.slice(syncCountBeforeCurrentRoundRequest);
  assert.equal(currentRoundRequestSyncs.filter((entry) => entry.key === 'authoritative_state').length, 1, 'Host should answer the initial current-round authoritative request before prep starts');

  setRound(5);
  setScores({ my: 2, opp: 1 });
  fireMultiplayerCallback('onRoundReady', 5, 20);
  roomStatus.state.prep_state = { roundNumber: 5, revision: 1, units: [] };

  const syncCountBeforeOlderRoundRetry = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', repeatedRequest);
  const olderRoundRetrySyncs = roomEvents.syncCalls.slice(syncCountBeforeOlderRoundRetry);
  assert.equal(olderRoundRetrySyncs.filter((entry) => entry.key === 'authoritative_state').length, 1, 'Host should answer the same older-round request again after prep resets the dedupe cache and the durable authoritative_state key has been cleared');
});

await test('Host drops older retained authoritative_state once a newer battle session starts', () => {
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
    roomId: 'room-host-retained-drop-123',
    opponentId: 'guest-retained-drop-456',
    isHost: true,
  });

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

  setRound(4);
  fireMultiplayerCallback('onBothReady');
  assert.ok(replayControls.current, 'Host round 4 battle replay should be active');

  setRound(5);
  fireMultiplayerCallback('onBothReady');
  assert.ok(replayControls.current, 'Host round 5 battle replay should replace the retained round 4 replay');

  const syncCountBeforeOldRoundRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 4,
    reason: 'reload_resume',
    mode: 'battle',
  });

  const oldRoundRequestSyncs = roomEvents.syncCalls.slice(syncCountBeforeOldRoundRequest);
  assert.equal(oldRoundRequestSyncs.some((entry) => entry.key === 'authoritative_state'), false, 'Host should not keep serving round 4 authoritative_state after round 5 battle has started');

  const syncCountBeforeCurrentRoundRequest = roomEvents.syncCalls.length;
  emitRoomStateChange('request_authoritative_state', {
    roundNumber: 5,
    reason: 'reload_resume',
    mode: 'battle',
  });

  const currentRoundRequestSyncs = roomEvents.syncCalls.slice(syncCountBeforeCurrentRoundRequest);
  const authoritativeSync = currentRoundRequestSyncs.find((entry) => entry.key === 'authoritative_state');
  assert.ok(authoritativeSync, 'Host should still answer the current round authoritative_state request');
  assert.equal(authoritativeSync.value.roundNumber, 5);
  assert.deepEqual(Object.keys(authoritativeSync.value.state), [
    'battle_replay',
    'playback_checkpoint',
    'phase_event',
  ]);
});
})();