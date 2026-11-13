'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storage = new Map([
  ['shape_strikers_dark_mode', '1'],
  ['shape_strikers_mp_room_session', 'active'],
  ['shape_strikers_achievements', '{"first_victory":1}'],
  ['shape_strikers_void_unlocked', '1'],
]);
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
global.window = {
  location: { hostname: 'bytesower.github.io', search: '?dev=1' },
  confirm: () => true,
};
global.ACHIEVEMENTS = [{ id: 'first_victory' }, { id: 'boss_slayer' }];
global.UNIT_DEFINITIONS = [{ id: 'boss_one', isBoss: true }, { id: 'unit_one', isBoss: false }];
global.Game = { refreshProgressionUI() {} };
let campaignSyncCount = 0;
global.GridStyles = {
  syncCampaignProgress() {
    campaignSyncCount++;
    storage.set('shape_strikers_grid_glowing_unlocked', '1');
  },
  getOptions: () => ['glowing', 'flames', 'ice'].map(id => ({ id })),
  unlock: id => storage.set(`shape_strikers_grid_${id}_unlocked`, '1'),
};

const source = fs.readFileSync(path.resolve(__dirname, '../src/devTools.js'), 'utf8');
vm.runInThisContext(source, { filename: 'devTools.js' });

assert.equal(DevTools.isEnabled(), false, 'query flag must not enable tools on a hosted origin');
assert.equal(DevTools.grantCampaignUnlocks(), false, 'hosted origins must not grant unlocks');
assert.equal(DevTools.unlockAllAchievements(), false, 'hosted origins must not unlock achievements');
assert.equal(DevTools.resetProgression(), false, 'hosted origins must not reset progression');
assert.equal(storage.get('shape_strikers_void_unlocked'), '1', 'disabled tools must not change progression');

window.location = { hostname: 'localhost', search: '' };
assert.equal(DevTools.isEnabled(), false, 'local tools require the explicit query flag');
window.location.search = '?dev=1';
assert.equal(DevTools.isEnabled(), true, 'localhost with dev=1 enables tools');

assert.equal(DevTools.grantCampaignUnlocks(), true);
assert.equal(storage.get('shape_strikers_arcane_unlocked'), '1');
assert.equal(storage.get('shape_strikers_void_campaign_cleared'), '1');
assert.equal(campaignSyncCount, 1, 'campaign grants must synchronize grid unlocks');
assert.equal(storage.get('shape_strikers_grid_flames_unlocked'), '1');

assert.equal(DevTools.unlockAllAchievements(), true);
const unlockedAchievements = JSON.parse(storage.get('shape_strikers_achievements'));
assert.deepEqual(Object.keys(unlockedAchievements), ['first_victory', 'boss_slayer']);
assert.ok(Object.values(unlockedAchievements).every(Number.isFinite), 'achievement timestamps must be saved');
assert.deepEqual(JSON.parse(storage.get('shape_strikers_encountered_bosses')), ['boss_one']);

window.confirm = () => false;
assert.equal(DevTools.resetProgression(), false, 'declining confirmation must preserve progression');
assert.equal(storage.get('shape_strikers_void_unlocked'), '1');

window.confirm = () => true;
storage.set('shape_strikers_grid_ice_streak', 'normal');
assert.equal(DevTools.resetProgression(), true);
assert.equal(storage.has('shape_strikers_grid_ice_streak'), false);
assert.equal(storage.has('shape_strikers_void_unlocked'), false);
assert.equal(storage.has('shape_strikers_achievements'), false);
assert.equal(storage.has('shape_strikers_grid_glowing_unlocked'), false);
assert.equal(storage.has('shape_strikers_grid_flames_unlocked'), false);
assert.equal(storage.has('shape_strikers_grid_ice_unlocked'), false);
assert.equal(storage.get('shape_strikers_dark_mode'), '1', 'reset must preserve settings');
assert.equal(storage.get('shape_strikers_mp_room_session'), 'active', 'reset must preserve multiplayer data');

console.log('All dev tools tests passed.');
