'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONFIG_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/config.js'), 'utf8');
const GAME_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');
const UI_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/ui.js'), 'utf8');

function createElementStub() {
  const classes = new Set();
  const listeners = new Map();
  const stub = {
    children: [],
    className: '',
    style: {},
    dataset: {},
    disabled: false,
    textContent: '',
    _innerHTML: '',
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
        stub.className = Array.from(classes).join(' ');
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
        stub.className = Array.from(classes).join(' ');
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force === true) {
          classes.add(name);
          stub.className = Array.from(classes).join(' ');
          return true;
        }
        if (force === false) {
          classes.delete(name);
          stub.className = Array.from(classes).join(' ');
          return false;
        }
        if (classes.has(name)) {
          classes.delete(name);
          stub.className = Array.from(classes).join(' ');
          return false;
        }
        classes.add(name);
        stub.className = Array.from(classes).join(' ');
        return true;
      },
    },
    addEventListener(type, handler) {
      if (typeof handler !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      if (!event?.type) return false;
      for (const handler of listeners.get(event.type) || []) {
        handler({ ...event, target: stub, currentTarget: stub, preventDefault() {} });
      }
      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click' });
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    set innerHTML(value) {
      this._innerHTML = String(value);
      if (value === '') this.children = [];
    },
    get innerHTML() {
      return this._innerHTML;
    },
  };
  return stub;
}

function loadGameContext() {
  const documentStub = {
    readyState: 'loading',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
  };

  const context = {
    console,
    JSON,
    Math,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    document: documentStub,
    window: null,
    global: null,
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    Audio: {},
    UI: {},
    Grid: {},
    Backend: {},
    SupabaseClient: {},
    Presence: {},
    GlobalChat: {},
    Matchmaking: {},
    Room: {},
  };

  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(CONFIG_SOURCE, context, { filename: 'config.js' });
  vm.runInContext(GAME_SOURCE, context, { filename: 'game.js' });

  return {
    Game: vm.runInContext('Game', context),
    UNIT_MAP: vm.runInContext('Object.fromEntries(UNIT_DEFINITIONS.map(def => [def.id, def]))', context),
  };
}

function loadWavePreviewGameContext() {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, createElementStub());
    return nodes.get(id);
  };

  const documentStub = {
    readyState: 'loading',
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      return getNode(id);
    },
    querySelector() { return null; },
    createElement() {
      return createElementStub();
    },
  };

  const context = {
    console,
    JSON,
    Math,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    document: documentStub,
    window: null,
    global: null,
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    Audio: {
      init() {},
      play() {},
      playGameplayMusic() {},
      playMusic() {},
      stopMusic() {},
      playAfter() {},
      isMuted() { return false; },
    },
    UI: {
      showScreen() {},
      hideAllOverlays() {},
      hideResult() {},
      clearLog() {},
      clearUnitDetail() {},
      switchTab() {},
      renderShop() {},
      updateSynergies() {},
      updateUpgrades() {},
      updateHUD() {},
      showMessage() {},
    },
    Grid: {
      build() {},
      clearAll() {},
      clearSelection() {},
      clearHighlights() {},
      onClick: null,
      onRightClick: null,
    },
    VFX: {
      setSpeed() {},
      screenFlash() {},
    },
    Backend: { init() {} },
    SupabaseClient: {},
    Presence: {},
    GlobalChat: {},
    Matchmaking: {},
    Room: {},
  };

  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(CONFIG_SOURCE, context, { filename: 'config.js' });
  vm.runInContext(GAME_SOURCE, context, { filename: 'game.js' });

  return {
    Game: vm.runInContext('Game', context),
    document: documentStub,
  };
}

function loadUIContext({ voidUnlocked = false, arcaneUnlocked = false } = {}) {
  const nodes = new Map();
  const storage = new Map();
  if (voidUnlocked) storage.set('shape_strikers_void_unlocked', '1');
  if (arcaneUnlocked) storage.set('shape_strikers_arcane_unlocked', '1');

  const documentStub = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElementStub());
      return nodes.get(id);
    },
    createElement() {
      return createElementStub();
    },
    querySelectorAll() { return []; },
  };

  const context = {
    console,
    JSON,
    Math,
    Date,
    document: documentStub,
    window: null,
    global: null,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };

  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(CONFIG_SOURCE, context, { filename: 'config.js' });
  vm.runInContext(UI_SOURCE, context, { filename: 'ui.js' });

  return {
    UI: vm.runInContext('UI', context),
    UNIT_MAP: vm.runInContext('Object.fromEntries(UNIT_DEFINITIONS.map(def => [def.id, def]))', context),
    document: documentStub,
    synergyList: documentStub.getElementById('synergy-list'),
    unitDetail: documentStub.getElementById('unit-detail'),
    unitDetailEmpty: documentStub.getElementById('unit-detail-empty'),
  };
}

function mkUnit(def, row, col) {
  return {
    id: `p::${def.id}::${row}::${col}`,
    definition: def,
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    stats: { ...def.stats },
    statusEffects: [],
    abilityCooldown: 0,
    isEnemy: false,
    row,
    col,
  };
}

function plainDescriptions(activeSynergies) {
  return Array.from(activeSynergies, (syn) => String(syn.description));
}

test('prep synergy counting dedupes same-stat tier upgrades for synergy groups', () => {
  const { Game, UNIT_MAP } = loadGameContext();
  const units = [
    mkUnit(UNIT_MAP.fire_imp, 4, 0),
    mkUnit(UNIT_MAP.fire_scout, 4, 1),
    mkUnit(UNIT_MAP.fire_warrior, 4, 2),
    mkUnit(UNIT_MAP.blood_imp, 4, 3),
    mkUnit(UNIT_MAP.blood_knight, 4, 4),
  ];

  const activeSynergies = Game.getActiveSynergiesForUnits(units);

  assert.equal(activeSynergies.length, 2, '3-fire plus 2-blood should count as two active synergy groups, not three raw tiers');
  assert.deepEqual(
    plainDescriptions(activeSynergies),
    ['3🔥: +30% ATK', '2🩸: +15% ATK'],
    'prep synergy counting should keep only the highest same-stat tier per element'
  );
});

test('prep synergy counting keeps mixed-stat 3-unit tiers as separate active synergies', () => {
  const { Game, UNIT_MAP } = loadGameContext();
  const units = [
    mkUnit(UNIT_MAP.void_shade, 4, 0),
    mkUnit(UNIT_MAP.void_knight, 4, 1),
    mkUnit(UNIT_MAP.void_horror, 4, 2),
    mkUnit(UNIT_MAP.blood_imp, 4, 3),
    mkUnit(UNIT_MAP.blood_knight, 4, 4),
  ];

  const activeSynergies = Game.getActiveSynergiesForUnits(units);

  assert.equal(activeSynergies.length, 3, '3-void plus 2-blood should count three active synergy groups because void contributes both attack and HP');
  assert.deepEqual(
    plainDescriptions(activeSynergies),
    ['2🕳️: +25% ATK', '3🕳️: +20% HP', '2🩸: +15% ATK'],
    'mixed-stat 3-unit tiers should stay active alongside lower-tier bonuses that affect different stats'
  );
});

test('synergy sidebar shows both active mixed-stat void tiers together', () => {
  const { UI, UNIT_MAP, synergyList } = loadUIContext({ voidUnlocked: true });
  const units = [
    mkUnit(UNIT_MAP.void_shade, 4, 0),
    mkUnit(UNIT_MAP.void_knight, 4, 1),
    mkUnit(UNIT_MAP.void_horror, 4, 2),
  ];

  UI.updateSynergies(units);

  const voidPill = synergyList.children.find((child) => child.innerHTML.includes('🕳️ 3'));
  assert.ok(voidPill, 'void sidebar pill should be rendered when void units are unlocked and present');
  assert.match(voidPill.innerHTML, /2🕳️: \+25% ATK/, 'void sidebar should keep the tier-2 attack bonus visible at 3 units');
  assert.match(voidPill.innerHTML, /3🕳️: \+20% HP/, 'void sidebar should also show the tier-3 HP bonus at 3 units');
});

test('synergy sidebar keeps only the highest same-stat tier label', () => {
  const { UI, UNIT_MAP, synergyList } = loadUIContext();
  const units = [
    mkUnit(UNIT_MAP.fire_imp, 4, 0),
    mkUnit(UNIT_MAP.fire_scout, 4, 1),
    mkUnit(UNIT_MAP.fire_warrior, 4, 2),
  ];

  UI.updateSynergies(units);

  const firePill = synergyList.children.find((child) => child.innerHTML.includes('🔥 3'));
  assert.ok(firePill, 'fire sidebar pill should be rendered when fire units are present');
  assert.match(firePill.innerHTML, /3🔥: \+30% ATK/, 'fire sidebar should show the highest active attack tier at 3 units');
  assert.doesNotMatch(firePill.innerHTML, /2🔥: \+15% ATK/, 'fire sidebar should not show the lower same-stat tier once the higher tier is active');
});

test('unit detail renders stacked attack and HP synergy projections for preview units', () => {
  const { UI, unitDetail, unitDetailEmpty } = loadUIContext({ voidUnlocked: true });
  const previewUnit = {
    definition: {
      id: 'preview-target',
      name: 'Preview Target',
      element: 'ice',
      tier: 1,
      cost: 1,
      stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
      ability: { name: 'Preview', description: 'Test ability', cooldown: 1 },
    },
    hp: 20,
    maxHp: 20,
    stats: { hp: 20, attack: 21, defense: 10, speed: 10, range: 1 },
    statusEffects: [],
    isEnemy: false,
  };
  const activeSynergies = [
    { element: 'void', bonus: { stat: 'attack', multiplier: 1.25 }, description: '2🕳️: +25% ATK' },
    { element: 'void', bonus: { stat: 'hp', multiplier: 1.20 }, description: '3🕳️: +20% HP' },
    { element: 'blood', bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🩸: +15% ATK' },
  ];

  UI.showUnitDetail(previewUnit, { elite_training: 1 }, activeSynergies);

  assert.equal(unitDetailEmpty.style.display, 'none', 'showUnitDetail should hide the empty-state placeholder');
  assert.equal(unitDetail.style.display, 'block', 'showUnitDetail should reveal the detail panel');
  assert.match(unitDetail.innerHTML, /Elite L1/, 'unit detail should render active upgrade pills for preview units');
  assert.match(unitDetail.innerHTML, /2🕳️: \+25% ATK/, 'unit detail should list the active attack synergy pill');
  assert.match(unitDetail.innerHTML, /3🕳️: \+20% HP/, 'unit detail should list the active HP synergy pill');
  assert.match(unitDetail.innerHTML, /2🩸: \+15% ATK/, 'unit detail should list stacked attack synergy pills');
  assert.match(unitDetail.innerHTML, /text-decoration:line-through">21<\/span> <span style="color:#ff6644">30<\/span>/, 'unit detail should project stacked attack synergies from the preview unit stats');
  assert.match(unitDetail.innerHTML, /text-decoration:line-through">20\/20<\/span> <span style="color:#44ff88">24\/24<\/span>/, 'unit detail should project HP synergies into the displayed HP pool');
});

test('unit detail does not double-project synergies for already-boosted battle snapshots', () => {
  const { UI, unitDetail } = loadUIContext();
  const battleUnit = {
    definition: {
      id: 'battle-target',
      name: 'Battle Target',
      element: 'fire',
      tier: 1,
      cost: 1,
      stats: { hp: 20, attack: 20, defense: 10, speed: 10, range: 1 },
      ability: { name: 'Battle Preview', description: 'Test ability', cooldown: 1 },
    },
    hp: 20,
    maxHp: 20,
    stats: { hp: 20, attack: 23, defense: 10, speed: 10, range: 1 },
    statusEffects: [],
    isEnemy: false,
    _alreadyBoosted: true,
  };
  const activeSynergies = [
    { element: 'fire', bonus: { stat: 'attack', multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  ];

  UI.showUnitDetail(battleUnit, {}, activeSynergies);

  assert.match(unitDetail.innerHTML, /2🔥: \+15% ATK/, 'battle detail should still list the active synergy pill');
  assert.doesNotMatch(unitDetail.innerHTML, /text-decoration:line-through">23<\/span> <span style="color:#ff6644">26<\/span>/, 'battle detail should not double-project attack that is already boosted in the live snapshot');
  assert.match(unitDetail.innerHTML, /<span style="color:#ff6644">23<\/span>/, 'battle detail should render the already-boosted attack as the live value');
});

test('HUD updates keep the wave preview node mounted while the wave label changes', () => {
  const { UI, document } = loadUIContext();
  const hudWave = document.getElementById('hud-wave');
  const hudWaveLabel = document.getElementById('hud-wave-label');
  const wavePreview = document.getElementById('wave-preview');

  wavePreview.innerHTML = '<div>next wave preview</div>';
  hudWave.appendChild(hudWaveLabel);
  hudWave.appendChild(wavePreview);

  UI.updateHUD({
    wave: 4,
    waveCount: 15,
    gold: 23,
    score: 90,
    units: 3,
    maxUnits: 7,
    phase: 'prep',
    challengeLabel: '',
  });

  assert.equal(hudWaveLabel.textContent, 'Wave 4 / 15', 'HUD updates should write the wave text into the dedicated label node');
  assert.equal(wavePreview.innerHTML, '<div>next wave preview</div>', 'HUD updates should not wipe the mounted wave preview content');
  assert.equal(hudWave.children.includes(wavePreview), true, 'HUD updates should keep the wave preview attached under the wave wrapper');
});

test('Scout\'s Intel shows next-wave ability text from the live wave config', () => {
  const { Game, document } = loadWavePreviewGameContext();

  Game.startGame('normal');
  Game.nextWave();
  Game.nextWave();
  Game.nextWave();
  Game.state.gold = 99;
  Game.buyUpgrade('scouts_intel');

  const wavePreview = document.getElementById('wave-preview');
  assert.match(wavePreview.innerHTML, /Tyrant's Wrath/, 'Scout\'s Intel should surface live next-wave ability names from the generated wave config');
});