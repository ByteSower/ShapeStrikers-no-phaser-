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
  },
  {
    id: 'flames',
    name: 'Flamebound Grid',
    icon: '🔥',
    description: 'A living ring of fire dances around the battlefield.',
    className: 'grid-style-flames',
    effect: 'flames',
    unlockKey: 'shape_strikers_grid_flames_unlocked',
    unlockCondition: 'campaign',
  },
  {
    id: 'ice',
    name: 'Frostbound Grid',
    icon: '❄️',
    description: 'Snow falls and icy winds sweep across a frozen battlefield.',
    className: 'grid-style-ice',
    effect: 'ice',
    unlockKey: 'shape_strikers_grid_ice_unlocked',
    unlockCondition: 'campaign',
  },
];

const GridStyles = (() => {
  const SELECTED_STYLE_KEY = 'shape_strikers_selected_grid_style';
  const DEFAULT_STYLE_ID = 'classic';

  function getStyle(styleId) {
    return GRID_STYLE_DEFINITIONS.find(style => style.id === styleId) || null;
  }

  function isUnlocked(styleId) {
    const style = getStyle(styleId);
    return Boolean(style && (!style.unlockKey || localStorage.getItem(style.unlockKey) === '1'));
  }

  function unlock(styleId) {
    const style = getStyle(styleId);
    if (!style || !style.unlockKey || isUnlocked(styleId)) return false;
    localStorage.setItem(style.unlockKey, '1');
    return true;
  }

  function unlockForCampaignWin() {
    return GRID_STYLE_DEFINITIONS
      .filter(style => style.unlockCondition === 'campaign')
      .filter(style => unlock(style.id))
      .map(style => style.id);
  }

  function syncCampaignProgress() {
    const hasCampaignWin =
      localStorage.getItem('shape_strikers_void_unlocked') === '1' ||
      localStorage.getItem('shape_strikers_void_campaign_cleared') === '1';
    if (hasCampaignWin) unlockForCampaignWin();
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
    unlockForCampaignWin,
    syncCampaignProgress,
    select,
    applyToGrid,
  };
})();
