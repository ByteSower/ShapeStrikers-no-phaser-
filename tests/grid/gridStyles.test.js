'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storage = new Map();
const classes = new Set();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
global.Element = { ICE: 'ice' };
global.document = {
  getElementById: id => id === 'grid-area'
    ? { classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      } }
    : null,
};

const effects = [];
global.GridFx = { setEffect: name => effects.push(name) };

const sourcePath = path.resolve(__dirname, '../../src/gridStyles.js');
vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

test.beforeEach(() => {
  storage.clear();
  classes.clear();
});

test('classic grid is the only style unlocked for a new campaign', () => {
  const options = GridStyles.getOptions();

  assert.deepEqual(options.map(style => [style.id, style.unlocked, style.selected]), [
    ['classic', true, true],
    ['glowing', false, false],
    ['flames', false, false],
    ['ice', false, false],
  ]);
});

const iceArmy = () => Array.from({ length: 3 }, () => ({
  hp: 10, isEnemy: false, definition: { element: Element.ICE, tier: 3 },
}));
function win(campaignMode = 'normal', playerUnits = [], fireUnitsPurchased = 0) {
  const previousIceCampaign = GridStyles.beginRun();
  return GridStyles.unlockForCampaignWin({ campaignMode, playerUnits, fireUnitsPurchased, previousIceCampaign });
}

test('ordinary campaign wins unlock only Glowing, once', () => {
  assert.deepEqual(win(), ['glowing']);
  assert.deepEqual(win(), []);
  assert.equal(GridStyles.isUnlocked('glowing'), true);
  assert.equal(GridStyles.isUnlocked('flames'), false);
  assert.equal(GridStyles.isUnlocked('ice'), false);
});

test('previous campaign progress only unlocks Glowing for returning players', () => {
  storage.set('shape_strikers_void_unlocked', '1');

  GridStyles.syncCampaignProgress();

  assert.equal(GridStyles.isUnlocked('glowing'), true);
  assert.equal(GridStyles.isUnlocked('flames'), false);
  assert.equal(GridStyles.isUnlocked('ice'), false);
});

test('legacy luxury unlocks are relocked once and their selection is cleared', () => {
  for (const id of ['flames', 'ice']) storage.set(`shape_strikers_grid_${id}_unlocked`, '1');
  storage.set('shape_strikers_selected_grid_style', 'ice');
  GridStyles.syncCampaignProgress();
  assert.equal(GridStyles.isUnlocked('ice'), false);
  assert.equal(GridStyles.isUnlocked('flames'), false);
  assert.equal(storage.has('shape_strikers_selected_grid_style'), false);
  win('normal', [], 10);
  GridStyles.syncCampaignProgress();
  assert.equal(GridStyles.isUnlocked('flames'), true, 'newly earned unlocks survive later syncs');
});

test('Flamebound requires ten Fire purchases in a single victorious run', () => {
  win('normal', [], 9);
  assert.equal(GridStyles.isUnlocked('flames'), false);
  win('void', [], 1);
  assert.equal(GridStyles.isUnlocked('flames'), false, 'purchases do not accumulate across runs');
  assert.deepEqual(win('void', [], 10), ['flames']);
  assert.deepEqual(win('normal', [], 12), []);
});

test('Frostbound requires qualifying Normal and Void victories consecutively in either order', () => {
  for (const modes of [['normal', 'void'], ['void', 'normal']]) {
    storage.clear();
    assert.deepEqual(win(modes[0], iceArmy()), ['glowing']);
    assert.equal(GridStyles.isUnlocked('ice'), false);
    assert.deepEqual(win(modes[1], iceArmy()), ['ice']);
    GridStyles.syncCampaignProgress();
    assert.equal(GridStyles.isUnlocked('ice'), true);
  }
});

test('dead, enemy, wrong-tier, and non-Ice units do not satisfy the Ice requirement', () => {
  for (const change of [
    unit => { unit.hp = 0; },
    unit => { unit.isEnemy = true; },
    unit => { unit.definition.tier = 2; },
    unit => { unit.definition.tier = 4; },
    unit => { unit.definition.element = 'fire'; },
  ]) {
    storage.clear();
    win('normal', iceArmy());
    const units = iceArmy();
    change(units[0]);
    win('void', units);
    assert.equal(GridStyles.isUnlocked('ice'), false);
    win('normal', iceArmy());
    assert.equal(GridStyles.isUnlocked('ice'), false, 'nonqualifying victories break the streak');
  }
});

test('same-mode victories do not unlock Frostbound but can begin the next pair', () => {
  win('normal', iceArmy());
  win('normal', iceArmy());
  assert.equal(GridStyles.isUnlocked('ice'), false);
  assert.deepEqual(win('void', iceArmy()), ['ice']);
});

test('starting an intervening run without a qualifying victory consumes the streak across reloads', () => {
  win('normal', iceArmy());
  assert.equal(GridStyles.beginRun(), 'normal');
  assert.equal(storage.has('shape_strikers_grid_ice_streak'), false);
  // Loss, abandonment, and challenges never record a qualifying campaign victory.
  win('void', iceArmy());
  assert.equal(GridStyles.isUnlocked('ice'), false);
});

test('locked styles cannot be selected, while unlocked selection persists and applies', () => {
  assert.equal(GridStyles.select('glowing'), false);
  assert.equal(GridStyles.getSelectedId(), 'classic');
  assert.equal(classes.has('grid-style-glowing'), false);

  GridStyles.unlock('glowing');
  assert.equal(GridStyles.select('glowing'), true);
  assert.equal(GridStyles.getSelectedId(), 'glowing');
  assert.equal(classes.has('grid-style-glowing'), true);
  assert.equal(storage.get('shape_strikers_selected_grid_style'), 'glowing');

  GridStyles.unlock('flames');
  assert.equal(GridStyles.select('flames'), true);
  assert.equal(GridStyles.getSelectedId(), 'flames');
  assert.equal(classes.has('grid-style-glowing'), false);
  assert.equal(classes.has('grid-style-flames'), true);
  assert.equal(effects.at(-1), 'flames', 'animated styles start their canvas effect');

  assert.equal(GridStyles.select('classic'), true);
  assert.equal(classes.has('grid-style-glowing'), false);
  assert.equal(classes.has('grid-style-flames'), false);
  assert.equal(effects.at(-1), null, 'static styles stop the canvas effect');
});

test('invalid saved style ids fall back to the classic grid', () => {
  storage.set('shape_strikers_selected_grid_style', 'unknown');

  assert.equal(GridStyles.getSelectedId(), 'classic');
  assert.equal(GridStyles.select('unknown'), false);
});
