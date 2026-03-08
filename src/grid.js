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

    tile.appendChild(wrapper);
    tile.classList.add('occupied');
  }

  function removeUnitFromTile(row, col) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const existing = tile.querySelector('.unit-on-tile');
    if (existing) existing.remove();
    tile.classList.remove('occupied', 'selected', 'enemy-unit');
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

  function animateAttack(row, col) { _flashClass(row, col, 'anim-attack'); }
  function animateHit(row, col)    { _flashClass(row, col, 'anim-hit'); }

  function animateDamageNumber(row, col, dmg) {
    const tile = getTileEl(row, col);
    if (!tile) return;
    const num = document.createElement('div');
    num.className = 'dmg-float';
    if (dmg < 0) {
      // Healing
      num.textContent = '+' + Math.abs(dmg);
      num.style.color = '#44ff88';
    } else {
      num.textContent = '-' + dmg;
      num.style.color = '#ff4422';
    }
    tile.appendChild(num);
    num.addEventListener('animationend', () => num.remove(), { once: true });
  }

  function animateDeath(row, col, cb) {
    const tile = getTileEl(row, col);
    const unit = tile?.querySelector('.unit-on-tile');
    if (unit) {
      unit.classList.add('anim-death');
      unit.addEventListener('animationend', () => { removeUnitFromTile(row, col); if (cb) cb(); }, { once: true });
    } else if (cb) cb();
  }

  function _flashClass(row, col, cls) {
    const tile = getTileEl(row, col);
    const unit = tile?.querySelector('.unit-on-tile');
    if (!unit) return;
    unit.classList.remove(cls);
    void unit.offsetWidth; // reflow
    unit.classList.add(cls);
    unit.addEventListener('animationend', () => unit.classList.remove(cls), { once: true });
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
    set onClick(fn)      { _onClick = fn; },
    set onRightClick(fn) { _onRightClick = fn; },
  };
})();
