/**
 * Campaign-unlocked grid cosmetics.
 */
const GRID_STYLE_DEFINITIONS = [
  {
    id: 'classic',
    name: 'Classic Grid',
    icon: '⚔️',
    description: 'The original battlefield.',
    className: null,
    unlockKey: null,
    unlockCondition: null,
  },
  {
    id: 'glowing',
    name: 'Glowing Grid',
    icon: '🌈',
    description: 'Neon gradients illuminate each battle zone.',
    className: 'grid-style-glowing',
    unlockKey: 'shape_strikers_grid_glowing_unlocked',
    unlockCondition: 'campaign',
    unlockText: 'Complete a campaign to unlock.',
  },
  {
    id: 'flames',
    name: 'Flamebound Grid',
    icon: '🔥',
    description: 'A living ring of fire dances around the battlefield.',
    className: 'grid-style-flames',
    effect: 'flames',
    unlockKey: 'shape_strikers_grid_flames_unlocked',
    unlockCondition: 'fire-purchases',
    unlockText: 'Win a campaign after purchasing at least 10 Fire units in that run.',
  },
  {
    id: 'ice',
    name: 'Frostbound Grid',
    icon: '❄️',
    description: 'Snow falls and icy winds sweep across a frozen battlefield.',
    className: 'grid-style-ice',
    effect: 'ice',
    unlockKey: 'shape_strikers_grid_ice_unlocked',
    unlockCondition: 'ice-streak',
    unlockText: 'Win Normal and Void consecutively, in either order, with at least three living 3-star Ice units at each victory. Losses, abandoned runs, challenges, and multiplayer break the streak.',
  },
];

const GridStyles = (() => {
  const SELECTED_STYLE_KEY = 'shape_strikers_selected_grid_style';
  const DEFAULT_STYLE_ID = 'classic';
  const RULES_KEY = 'shape_strikers_grid_unlock_rules';
  const ICE_STREAK_KEY = 'shape_strikers_grid_ice_streak';

  function _migrateUnlockRules() {
    if (localStorage.getItem(RULES_KEY) === '2') return;
    for (const id of ['flames', 'ice']) localStorage.removeItem(getStyle(id).unlockKey);
    localStorage.removeItem(ICE_STREAK_KEY);
    const selected = localStorage.getItem(SELECTED_STYLE_KEY);
    if (selected === 'flames' || selected === 'ice') localStorage.removeItem(SELECTED_STYLE_KEY);
    localStorage.setItem(RULES_KEY, '2');
  }

  function getStyle(styleId) {
    return GRID_STYLE_DEFINITIONS.find(style => style.id === styleId) || null;
  }

  function isUnlocked(styleId) {
    _migrateUnlockRules();
    const style = getStyle(styleId);
    return Boolean(style && (!style.unlockKey || localStorage.getItem(style.unlockKey) === '1'));
  }

  function unlock(styleId) {
    const style = getStyle(styleId);
    if (!style || !style.unlockKey || isUnlocked(styleId)) return false;
    localStorage.setItem(style.unlockKey, '1');
    return true;
  }

  // Consume the prior victory immediately: quitting or reloading this run breaks the streak.
  function beginRun() {
    _migrateUnlockRules();
    const previous = localStorage.getItem(ICE_STREAK_KEY);
    localStorage.removeItem(ICE_STREAK_KEY);
    return previous === 'normal' || previous === 'void' ? previous : null;
  }

  function unlockForCampaignWin({ campaignMode, fireUnitsPurchased, playerUnits, previousIceCampaign }) {
    _migrateUnlockRules();
    const rewards = [];
    if (unlock('glowing')) rewards.push('glowing');
    if (fireUnitsPurchased >= 10 && unlock('flames')) rewards.push('flames');
    const iceSurvivors = playerUnits.filter(unit =>
      !unit.isEnemy && unit.hp > 0 && unit.definition.element === Element.ICE && unit.definition.tier === 3
    ).length;
    if (iceSurvivors >= 3) {
      if (previousIceCampaign && previousIceCampaign !== campaignMode && unlock('ice')) rewards.push('ice');
      localStorage.setItem(ICE_STREAK_KEY, campaignMode);
    } else {
      localStorage.removeItem(ICE_STREAK_KEY);
    }
    return rewards;
  }

  function syncCampaignProgress() {
    _migrateUnlockRules();
    const hasCampaignWin =
      localStorage.getItem('shape_strikers_void_unlocked') === '1' ||
      localStorage.getItem('shape_strikers_void_campaign_cleared') === '1';
    if (hasCampaignWin) unlock('glowing');
  }

  function getSelectedId() {
    const selectedId = localStorage.getItem(SELECTED_STYLE_KEY);
    return isUnlocked(selectedId) ? selectedId : DEFAULT_STYLE_ID;
  }

  function applyToGrid() {
    const gridArea = document.getElementById('grid-area');
    if (!gridArea) return;

    const selectedId = getSelectedId();
    for (const style of GRID_STYLE_DEFINITIONS) {
      if (style.className) gridArea.classList.toggle(style.className, style.id === selectedId);
    }
    if (typeof GridFx !== 'undefined') GridFx.setEffect(getStyle(selectedId).effect || null);
  }

  function select(styleId) {
    if (!isUnlocked(styleId)) return false;
    localStorage.setItem(SELECTED_STYLE_KEY, styleId);
    applyToGrid();
    return true;
  }

  function getOptions() {
    const selectedId = getSelectedId();
    return GRID_STYLE_DEFINITIONS.map(style => ({
      ...style,
      unlocked: isUnlocked(style.id),
      selected: style.id === selectedId,
    }));
  }

  return {
    getOptions,
    getSelectedId,
    isUnlocked,
    unlock,
    beginRun,
    unlockForCampaignWin,
    syncCampaignProgress,
    select,
    applyToGrid,
  };
})();
