/**
 * Shape Strikers Web — Grid Controller
 * Manages the 6×5 CSS grid, tile state, and unit canvas rendering on tiles.
 */

const Grid = (() => {
  /** @type {HTMLElement[][]} tileEls[row][col] */
  let tileEls = [];

  // Callbacks
  let _onClick        = null;  // (row, col)
  let _onRightClick   = null;  // (row, col)

  let _selectedTile   = null;  // {row, col} | null
  let _highlightedTiles = [];  // [{row,col}]

  const AURA_TYPES = ['burn','poison','freeze','slow','weaken','wound','shield','barrier','untargetable'];

  const STATUS_DESCRIPTIONS = {
    burn:          'Burn — takes fire damage each turn (stacks increase damage)',
    poison:        'Poison — takes damage each turn (stacks increase damage)',
    freeze:        'Freeze — skips next action (consumed on skip)',
    slow:          'Slow — speed halved for duration',
    weaken:        'Weaken — attack reduced by 30% for duration',
    wound:         'Wound — healing received halved for duration',
    shield:        'Shield — absorbs next incoming hit, then expires',
    barrier:       'Barrier — blocks all damage for duration',
    untargetable:  'Untargetable — cannot be targeted by attacks or abilities',
  };

  // ── Build ─────────────────────────────────────────────────────────────────

  function build() {
    const container = document.getElementById('grid-container');
    container.innerHTML = '';
    tileEls = [];

    const { cols, rows, tileSize, battleLineRow, playerZoneRows, enemyZoneRows } = GRID_CONFIG;

    // Set CSS variable for tile size
    container.style.setProperty('--tile-size', tileSize + 'px');
    document.documentElement.style.setProperty('--tile-size', tileSize + 'px');

    for (let row = 0; row < rows; row++) {
      tileEls[row] = [];
      for (let col = 0; col < cols; col++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.row = row;
        tile.dataset.col = col;

        // Zone class
        if (row === battleLineRow)            tile.classList.add('zone-battle');
        else if (row < battleLineRow)         tile.classList.add('zone-enemy');
        else                                  tile.classList.add('zone-player');

        // Events
        tile.addEventListener('click', () => _handleClick(row, col));
        tile.addEventListener('contextmenu', e => { e.preventDefault(); _handleRightClick(row, col); });

        container.appendChild(tile);
        tileEls[row][col] = tile;
      }
    }
  }

  // ── Tile queries ──────────────────────────────────────────────────────────

  function getTileEl(row, col) { return tileEls[row]?.[col] || null; }

  function isPlayerZone(row) { return row > GRID_CONFIG.battleLineRow; }
  function isEnemyZone(row)  { return row < GRID_CONFIG.battleLineRow; }

  function getEmptyPlayerTiles() {
    const tiles = [];
    for (let row = GRID_CONFIG.battleLineRow + 1; row < GRID_CONFIG.rows; row++)
      for (let col = 0; col < GRID_CONFIG.cols; col++)
        if (!tileEls[row][col].classList.contains('occupied')) tiles.push({ row, col });
    return tiles;
  }

  function getEmptyEnemyTiles() {
    const tiles = [];
    for (let row = 0; row < GRID_CONFIG.battleLineRow; row++)
      for (let col = 0; col < GRID_CONFIG.cols; col++)
        if (!tileEls[row][col].classList.contains('occupied')) tiles.push({ row, col });
    return tiles;
  }

  // ── Unit visuals ──────────────────────────────────────────────────────────

  /**
   * Place a unit canvas onto a tile.
   * unitData = { id, definition, hp, maxHp, isEnemy }
   */
  function placeUnit(unitData, row, col) {
    const tile = getTileEl(row, col);
    if (!tile) return;

    removeUnitFromTile(row, col);

    const wrapper = document.createElement('div');
    wrapper.className = 'unit-on-tile';
    wrapper.dataset.unitId = unitData.id;
    wrapper.style.setProperty('--breathe-delay', (Math.random() * 2).toFixed(2) + 's');

    const canvas = createUnitCanvas(unitData.definition, unitData.isEnemy, 62);
    wrapper.appendChild(canvas);

    // HP bar
    const barWrap = document.createElement('div');
    barWrap.className = 'unit-hp-bar';
    const fill = document.createElement('div');
    fill.className = 'unit-hp-fill';
    fill.style.width = ((unitData.hp / unitData.maxHp) * 100) + '%';
    barWrap.appendChild(fill);
    wrapper.appendChild(barWrap);

    // Enemy indicator badge
    if (unitData.isEnemy) {
      tile.classList.add('enemy-unit');
      const badge = document.createElement('div');
      badge.className = 'enemy-badge';
      badge.textContent = '💀';
      wrapper.appendChild(badge);
    }

    // Boss indicator — crown badge + pulsing tile border
    if (unitData.definition?.isBoss) {
      tile.classList.add('boss-tile');
      const crown = document.createElement('div');
      crown.className = 'boss-crown';
      crown.textContent = '👑';
      wrapper.appendChild(crown);
    }

    tile.appendChild(wrapper);
    tile.classList.add('occupied');
  }

  function removeUnitFromTile(row, col) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const existing = tile.querySelector('.unit-on-tile');
    if (existing) existing.remove();
    tile.classList.remove('occupied', 'selected', 'enemy-unit', 'boss-tile');
    // Clean up status auras, icons, and floating elements
    tile.querySelectorAll('.status-aura, .status-icons, .dmg-float, .ability-float, .boss-crown').forEach(el => el.remove());
    for (const t of AURA_TYPES) tile.classList.remove('has-' + t);
  }

  function updateUnitHp(row, col, hp, maxHp) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const fill = tile.querySelector('.unit-hp-fill');
    if (!fill) return;
    const pct = Math.max(0, (hp / maxHp) * 100);
    fill.style.width = pct + '%';
    fill.className = 'unit-hp-fill' + (pct < 25 ? ' critical' : pct < 60 ? ' wounded' : '');
  }

  // ── Status Effect Icons on Tiles ──────────────────────────────────────────

  const STATUS_ICONS = {
    burn:         '🔥',
    poison:       '☠️',
    freeze:       '🧊',
    slow:         '🐌',
    weaken:       '⬇️',
    wound:        '🩸',
    shield:       '🛡️',
    barrier:      '✨',
    untargetable: '👻',
  };

  function updateStatusIcons(row, col, statusEffects) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    let container = tile.querySelector('.status-icons');
    if (!container) {
      container = document.createElement('div');
      container.className = 'status-icons';
      tile.appendChild(container);
    }
    container.innerHTML = '';
    if (!statusEffects || statusEffects.length === 0) return;
    for (const eff of statusEffects) {
      const icon = STATUS_ICONS[eff.type];
      if (!icon) continue;
      const el = document.createElement('span');
      el.className = 'status-icon';
      el.textContent = icon;
      if (eff.stacks > 0) {
        const stack = document.createElement('span');
        stack.className = 'status-stack';
        stack.textContent = eff.stacks;
        el.appendChild(stack);
      }
      el.title = STATUS_DESCRIPTIONS[eff.type] || `${eff.type} (${eff.duration}t)`;
      container.appendChild(el);
    }
  }

  // ── Status Aura Overlays (persistent glow while status is active) ─────────

  function updateStatusAuras(row, col, statusEffects) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    // Remove old aura overlays
    tile.querySelectorAll('.status-aura').forEach(el => el.remove());
    // Remove helper classes
    for (const t of AURA_TYPES) tile.classList.remove('has-' + t);

    if (!statusEffects || statusEffects.length === 0) return;
    for (const eff of statusEffects) {
      if (!AURA_TYPES.includes(eff.type)) continue;
      const aura = document.createElement('div');
      aura.className = `status-aura status-aura-${eff.type}`;
      tile.appendChild(aura);
      tile.classList.add('has-' + eff.type);
    }
  }

  // ── Heal Burst Particles ──────────────────────────────────────────────────

  function animateHealBurst(row, col) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const symbols = ['✦', '✧', '+', '♥'];
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('div');
      p.className = 'heal-particle';
      p.textContent = symbols[i % symbols.length];
      p.style.color = '#44ff88';
      p.style.left = (15 + Math.random() * 60) + '%';
      p.style.top = (30 + Math.random() * 40) + '%';
      p.style.animationDelay = (i * 0.1) + 's';
      tile.appendChild(p);
      p.addEventListener('animationend', () => p.remove(), { once: true });
    }
  }

  // ── Selection & Highlights ────────────────────────────────────────────────

  function selectTile(row, col) {
    clearSelection();
    _selectedTile = { row, col };
    const tile = getTileEl(row, col);
    if (tile) tile.classList.add('selected');
  }

  function clearSelection() {
    if (_selectedTile) {
      const tile = getTileEl(_selectedTile.row, _selectedTile.col);
      if (tile) tile.classList.remove('selected');
    }
    _selectedTile = null;
  }

  function highlightTiles(positions, cls = 'highlighted') {
    clearHighlights();
    _highlightedTiles = positions.map(p => ({ ...p, cls }));
    for (const { row, col } of positions) {
      const tile = getTileEl(row, col);
      if (tile) tile.classList.add(cls);
    }
  }

  function clearHighlights() {
    for (const { row, col, cls } of _highlightedTiles) {
      const tile = getTileEl(row, col);
      if (tile) tile.classList.remove(cls || 'highlighted');
    }
    _highlightedTiles = [];
  }

  function clearAll() {
    for (let row = 0; row < GRID_CONFIG.rows; row++)
      for (let col = 0; col < GRID_CONFIG.cols; col++)
        removeUnitFromTile(row, col);
    clearSelection();
    clearHighlights();
  }

  // ── Animations ────────────────────────────────────────────────────────────

  /** Active animation tracking for await support */
  let _pendingAnimations = 0;
  let _animResolve = null;

  function _trackAnim() { _pendingAnimations++; }
  function _releaseAnim() {
    _pendingAnimations--;
    if (_pendingAnimations <= 0 && _animResolve) {
      _pendingAnimations = 0;
      const r = _animResolve; _animResolve = null; r();
    }
  }

  /**
   * Returns a Promise that resolves once all currently-running attack/hit
   * animations have finished (or immediately if none are in progress).
   */
  function waitForAnimations() {
    if (_pendingAnimations <= 0) return Promise.resolve();
    return new Promise(resolve => {
      _animResolve = resolve;
      // Safety timeout: resolve even if animationend events get lost
      setTimeout(() => {
        if (_pendingAnimations > 0) {
          _pendingAnimations = 0;
          const r = _animResolve; _animResolve = null;
          if (r) r();
        }
      }, 1200);
    });
  }

  function animateAttack(row, col) { _flashClass(row, col, 'anim-attack', true); }
  function animateHit(row, col)    { _flashClass(row, col, 'anim-hit', true); }

  function animateDamageNumber(row, col, dmg, elemColor) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const num = document.createElement('div');
    num.className = 'dmg-float';
    const rounded = Math.round(Math.abs(dmg));
    if (dmg < 0) {
      // Healing
      num.textContent = '+' + rounded;
      num.style.color = '#44ff88';
      num.style.setProperty('--dmg-glow', 'rgba(68,255,136,0.5)');
    } else {
      num.textContent = '-' + rounded;
      const color = elemColor || '#ff4422';
      num.style.color = color;
      num.style.setProperty('--dmg-glow', color + '88');
    }
    tile.appendChild(num);
    num.addEventListener('animationend', () => num.remove(), { once: true });
  }

  function animateDeath(row, col, cb) {
    const tile = getTileEl(row, col);
    const unit = tile?.querySelector('.unit-on-tile');
    if (unit) {
      // Release any tracked animations on this element before death anim
      if (unit.classList.contains('anim-hit'))  { unit.classList.remove('anim-hit');  _releaseAnim(); }
      if (unit.classList.contains('anim-attack')) { unit.classList.remove('anim-attack'); _releaseAnim(); }
      unit.classList.add('anim-death');
      const cleanup = () => { removeUnitFromTile(row, col); if (cb) cb(); };
      unit.addEventListener('animationend', cleanup, { once: true });
      // Safety: force removal if animationend never fires
      setTimeout(() => { if (tile.contains(unit)) cleanup(); }, 800);
    } else if (cb) cb();
  }

  function _flashClass(row, col, cls, tracked = false) {
    const tile = getTileEl(row, col);
    const unit = tile?.querySelector('.unit-on-tile');
    if (!unit) return;
    unit.classList.remove(cls);
    void unit.offsetWidth; // reflow
    unit.classList.add(cls);
    if (tracked) _trackAnim();
    unit.addEventListener('animationend', () => {
      unit.classList.remove(cls);
      if (tracked) _releaseAnim();
    }, { once: true });
  }

  /**
   * Moves a unit from one tile to another with a visual slide transition.
   */
  function moveUnit(fromRow, fromCol, toRow, toCol) {
    const fromTile = getTileEl(fromRow, fromCol);
    const toTile = getTileEl(toRow, toCol);
    if (!fromTile || !toTile) return;

    const unitEl = fromTile.querySelector('.unit-on-tile');
    if (!unitEl) return;

    // Transfer DOM node
    const wasEnemy = fromTile.classList.contains('enemy-unit');
    fromTile.classList.remove('occupied', 'enemy-unit');
    toTile.appendChild(unitEl);
    toTile.classList.add('occupied');
    if (wasEnemy) toTile.classList.add('enemy-unit');

    // Transfer status auras and icons from old tile to new tile
    fromTile.querySelectorAll('.status-aura').forEach(el => toTile.appendChild(el));
    const icons = fromTile.querySelector('.status-icons');
    if (icons) toTile.appendChild(icons);
    for (const t of AURA_TYPES) {
      if (fromTile.classList.contains('has-' + t)) {
        fromTile.classList.remove('has-' + t);
        toTile.classList.add('has-' + t);
      }
    }

    // Animate slide
    const tileSize = GRID_CONFIG.tileSize + 4; // tile + gap
    const dx = (fromCol - toCol) * tileSize;
    const dy = (fromRow - toRow) * tileSize;
    unitEl.style.transition = 'none';
    unitEl.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      unitEl.style.transition = 'transform 0.25s ease';
      unitEl.style.transform = 'translate(0, 0)';
    });
    unitEl.addEventListener('transitionend', () => {
      unitEl.style.transition = '';
      unitEl.style.transform = '';
    }, { once: true });
  }

  /**
   * Show a floating ability name text and element particles on a tile.
   */
  function animateAbilityName(row, col, abilityName, element) {
    const tile = getTileEl(row, col);
    if (!tile) return;

    const elemColor = ELEMENT_COLORS[element] || '#ffffff';

    // Floating ability name
    const label = document.createElement('div');
    label.className = 'ability-float';
    label.textContent = `⚡ ${abilityName}`;
    label.style.color = elemColor;
    tile.appendChild(label);
    label.addEventListener('animationend', () => label.remove(), { once: true });

    // Element particles
    const ELEM_PARTICLES = { fire: '🔥', ice: '❄️', lightning: '⚡', earth: '🌿', arcane: '✨', void: '🕳️' };
    const particle = ELEM_PARTICLES[element] || '✦';
    for (let i = 0; i < 3; i++) {
      const p = document.createElement('div');
      p.className = 'elem-particle';
      p.textContent = particle;
      p.style.left = (20 + Math.random() * 50) + '%';
      p.style.animationDelay = (i * 0.1) + 's';
      tile.appendChild(p);
      p.addEventListener('animationend', () => p.remove(), { once: true });
    }
  }

  // ── Projectile animation (ranged attacks) ──────────────────────────────────

  const ELEM_PROJECTILE = { fire: '🔥', ice: '❄️', lightning: '⚡', earth: '🪨', arcane: '✨', void: '🕳️' };

  function animateProjectile(fromRow, fromCol, toRow, toCol, element) {
    const container = document.getElementById('grid-container');
    const fromTile = getTileEl(fromRow, fromCol);
    const toTile   = getTileEl(toRow, toCol);
    if (!container || !fromTile || !toTile) return;

    const cRect = container.getBoundingClientRect();
    const fRect = fromTile.getBoundingClientRect();
    const tRect = toTile.getBoundingClientRect();

    const startX = fRect.left + fRect.width / 2 - cRect.left;
    const startY = fRect.top + fRect.height / 2 - cRect.top;
    const endX   = tRect.left + tRect.width / 2 - cRect.left;
    const endY   = tRect.top + tRect.height / 2 - cRect.top;

    const color = ELEMENT_COLORS[element] || '#ffffff';
    const emoji = ELEM_PROJECTILE[element] || '•';

    const proj = document.createElement('div');
    proj.className = 'projectile';
    proj.textContent = emoji;
    proj.style.left = startX + 'px';
    proj.style.top  = startY + 'px';
    proj.style.setProperty('--proj-color', color);
    container.appendChild(proj);

    // Animate to target
    requestAnimationFrame(() => {
      proj.style.left = endX + 'px';
      proj.style.top  = endY + 'px';
      proj.style.opacity = '0.3';
    });

    proj.addEventListener('transitionend', () => proj.remove(), { once: true });
    // Safety cleanup
    setTimeout(() => { if (proj.parentNode) proj.remove(); }, 600);
  }

  // ── Synergy pulse VFX ─────────────────────────────────────────────────────

  function animateSynergyPulse(units, element) {
    const color = ELEMENT_COLORS[element] || '#ffffff';
    for (const u of units) {
      if (u.definition.element !== element) continue;
      const tile = getTileEl(u.row, u.col);
      if (!tile) continue;
      const pulse = document.createElement('div');
      pulse.className = 'synergy-pulse';
      pulse.style.setProperty('--syn-color', color);
      tile.appendChild(pulse);
      pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  function _handleClick(row, col)      { if (_onClick)      _onClick(row, col); }
  function _handleRightClick(row, col) { if (_onRightClick) _onRightClick(row, col); }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    build,
    getTileEl,
    isPlayerZone,
    isEnemyZone,
    getEmptyPlayerTiles,
    getEmptyEnemyTiles,
    placeUnit,
    removeUnitFromTile,
    updateUnitHp,
    updateStatusIcons,
    updateStatusAuras,
    selectTile,
    clearSelection,
    highlightTiles,
    clearHighlights,
    clearAll,
    animateAttack,
    animateHit,
    animateDamageNumber,
    animateDeath,
    moveUnit,
    animateAbilityName,
    animateProjectile,
    animateSynergyPulse,
    animateHealBurst,
    waitForAnimations,
    set onClick(fn)      { _onClick = fn; },
    set onRightClick(fn) { _onRightClick = fn; },
  };
})();
