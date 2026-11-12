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
};
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

test('campaign wins unlock campaign grid styles once and return the new rewards', () => {
  assert.deepEqual(GridStyles.unlockForCampaignWin(), ['glowing', 'flames', 'ice']);
  assert.deepEqual(GridStyles.unlockForCampaignWin(), []);
  assert.equal(GridStyles.isUnlocked('glowing'), true);
  assert.equal(GridStyles.isUnlocked('flames'), true);
  assert.equal(GridStyles.isUnlocked('ice'), true);
});

test('previous campaign progress unlocks campaign grid styles for returning players', () => {
  storage.set('shape_strikers_void_unlocked', '1');

  GridStyles.syncCampaignProgress();

  assert.equal(GridStyles.isUnlocked('glowing'), true);
  assert.equal(GridStyles.isUnlocked('flames'), true);
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
