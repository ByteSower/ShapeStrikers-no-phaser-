/**
 * Shape Strikers Web — Game Controller
 * State management, wave flow, shop economy, unit placement, battle wiring.
 */

const Game = (() => {

  // ── State Object ──────────────────────────────────────────────────────────

  let state = null;
  let battle = null;
  let nextUnitId = 1;
  let _currentWaveDef = null; // cached generated wave for bonusGold lookup

  function _freshState() {
    return {
      phase:          'prep',   // 'prep' | 'battle' | 'result' | 'gameover' | 'win'
      wave:           1,
      gold:           GAME_CONFIG.startingGold,
      score:          0,
      playerUnits:    [],       // live unit objects on the board
      enemyUnits:     [],       // live enemy objects during battle
      shopUnits:      [null, null, null, null, null], // 5 slots of defs or null=sold
      selectedShopIdx: null,    // index into shopUnits (pending placement)
      selectedUnit:   null,     // live unit on the board selected for move/sell
      upgradeLevels:  {},       // { upgradeId: level }
      refreshesLeft:  GAME_CONFIG.maxRefreshesPerRound || 1,
    };
  }

  function getRefreshCost() {
    const base = GAME_CONFIG.shopRefreshCost || 2;
    const bargainLevel = state?.upgradeLevels?.['bargain_hunter'] || 0;
    return Math.max(0, base - bargainLevel);
  }

  // ── Helper: effective max units (accounting for Army Expansion upgrade) ────

  function _maxUnits() {
    const baseSlots   = GAME_CONFIG.maxUnits || 7;
    const armyLevel   = state.upgradeLevels['army_expansion'] || 0;
    return baseSlots + armyLevel;  // army_expansion adds 1 slot per level
  }

  // ── HUD refresh helper ─────────────────────────────────────────────────────

  function _refreshHUD() {
    UI.updateHUD({
      wave:     state.wave,
      waveCount: GAME_CONFIG.waveCount || 15,
      gold:     state.gold,
      score:    state.score,
      units:    state.playerUnits.length,
      maxUnits: _maxUnits(),
      phase:    state.phase,
    });
  }

  // ── Generate shop based on current wave ───────────────────────────────────

  function _rollableUnits() {
    // Match Phaser original + wave generator: Math.min(3, Math.ceil(wave/3))
    // T1 at W1-3, T2 at W4-6, T3 at W7+
    const maxTier = Math.min(3, Math.ceil(state.wave / 3));
    const arcaneUnlocked = localStorage.getItem('shape_strikers_arcane_unlocked') === '1';
    return UNIT_DEFINITIONS.filter(d => {
      if (d.isBoss) return false;
      if (d.element === Element.VOID) return false;
      if (d.element === Element.ARCANE && !arcaneUnlocked) return false;
      if (d.tier > maxTier) return false;
      return true;
    });
  }

  function refreshShop(free = false) {
    if (!free) {
      if (state.refreshesLeft <= 0) { UI.showMessage('No refreshes left this round!'); return; }
      const cost = getRefreshCost();
      if (state.gold < cost) { UI.showMessage('Not enough gold to refresh!'); return; }
      state.gold -= cost;
      state.refreshesLeft--;
    }
    const pool = _rollableUnits();
    const maxTier = Math.min(3, Math.ceil(state.wave / 3));
    state.shopUnits = Array.from({ length: 5 }, () => {
      // Tier weighting matching Phaser original: T1=60%, T2=30%, T3=10%
      const weights = { 1: 60, 2: 30, 3: 10 };
      const roll = Math.random() * 100;
      let tier = 1;
      if (roll > weights[1]) tier = 2;
      if (roll > weights[1] + weights[2]) tier = 3;
      tier = Math.min(tier, maxTier);
      const tierPool = pool.filter(d => d.tier === tier);
      const pick = tierPool.length > 0 ? tierPool : pool;
      return pick[Math.floor(Math.random() * pick.length)];
    });
    state.selectedShopIdx = null;
    Grid.clearSelection();
    UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
    _refreshHUD();
    _updateRefreshBtn();
    _checkSoftLock();
  }

  // ── Soft Lock Detection ───────────────────────────────────────────────────

  function _checkSoftLock() {
    if (state.phase !== 'prep') return;
    if (state.playerUnits.length > 0) return; // Has units, can fight

    // Check if any shop unit is affordable
    const canBuySomething = state.shopUnits.some(d => d !== null && state.gold >= d.cost);
    if (canBuySomething) return;

    // Check if can refresh to find something affordable
    const refreshCost = getRefreshCost();
    if (state.refreshesLeft > 0 && state.gold >= refreshCost) return;

    // No units, can't buy, can't refresh — soft locked
    setTimeout(() => {
      _handleGameOver();
      UI.showMessage('No units and no gold — defeated!');
    }, 500);
  }

  // ── Buy from shop ─────────────────────────────────────────────────────────

  function _buyShopUnit(index) {
    const def = state.shopUnits[index];
    if (!def) return;

    // Always show unit detail when clicking a shop card (even if can't buy)
    UI.showUnitDetail({ definition: def, hp: def.stats.hp, maxHp: def.stats.hp, stats: { ...def.stats }, statusEffects: [] });

    if (state.phase !== 'prep') { UI.showMessage('Can only buy during prep phase.'); return; }
    if (state.playerUnits.length >= _maxUnits()) { UI.showMessage('Army is full! Upgrade Army Expansion.'); return; }
    if (state.gold < def.cost) { UI.showMessage('Not enough gold!'); return; }

    // Clicking the same shop card again cancels the pending purchase
    if (state.selectedShopIdx === index) {
      state.selectedShopIdx = null;
      Grid.clearHighlights();
      UI.showMessage('');
      return;
    }

    // Cancel any previous pending purchase
    if (state.selectedShopIdx !== null) {
      Grid.clearHighlights();
    }

    // Mark slot as selected (gold deducted only on placement)
    state.selectedShopIdx = index;
    Audio.play('buy');

    // Highlight empty player-side tiles
    const empties = [];
    for (let r = GRID_CONFIG.battleLineRow + 1; r < GRID_CONFIG.rows; r++) {
      for (let c = 0; c < GRID_CONFIG.cols; c++) {
        if (!_unitAt(r, c)) empties.push({ row: r, col: c });
      }
    }
    Grid.highlightTiles(empties, 'highlight-place');
    UI.showMessage(`Select a tile to place ${def.name}`);
  }

  // ── Sell unit ─────────────────────────────────────────────────────────────

  function _sellUnit(unit) {
    if (state.phase !== 'prep') { UI.showMessage('Can only sell during prep phase.'); return; }
    const sellValue = Math.max(GAME_CONFIG.minSellValue || 1, Math.floor(unit.definition.cost * (GAME_CONFIG.sellRefundPercent || 0.5)));
    state.gold += sellValue;
    state.playerUnits = state.playerUnits.filter(u => u !== unit);
    Grid.removeUnitFromTile(unit.row, unit.col);
    Audio.play('sell');
    UI.showMessage(`Sold ${unit.definition.name} for ${sellValue}g`);
    UI.clearUnitDetail();
    state.selectedUnit = null;
    UI.updateSynergies(state.playerUnits);
    UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
    _refreshHUD();
    _checkSoftLock();
  }

  // ── Unit lookup helpers ───────────────────────────────────────────────────

  function _unitAt(row, col) {
    return state.playerUnits.find(u => u.row === row && u.col === col) || null;
  }

  function _mkUnit(def, row, col, isEnemy = false) {
    return {
      id:             nextUnitId++,
      name:           def.name,
      definition:     def,
      hp:             def.stats.hp,
      maxHp:          def.stats.hp,
      stats:          { ...def.stats },
      statusEffects:  [],
      abilityCooldown: 0,
      isEnemy,
      row,
      col,
    };
  }

  // ── Tile click handler ────────────────────────────────────────────────────

  function _handleTileClick(row, col) {
    const clickedUnit = _unitAt(row, col);
    const clickedEnemy = state.enemyUnits.find(u => u.row === row && u.col === col && u.hp > 0);

    // During battle — allow inspecting any unit (read-only)
    if (state.phase === 'battle') {
      const unit = clickedUnit || clickedEnemy;
      if (unit) {
        Grid.clearSelection();
        Grid.selectTile(row, col);
        UI.showUnitDetail(unit);
        UI.switchTab('unit');
      }
      return;
    }

    // (A) Pending shop purchase — place unit
    if (state.selectedShopIdx !== null) {
      const def = state.shopUnits[state.selectedShopIdx];
      const targetRow = row;
      if (targetRow <= GRID_CONFIG.battleLineRow || clickedUnit) {
        // Cancel shop selection and fall through to select/deselect logic
        state.selectedShopIdx = null;
        Grid.clearHighlights();
        UI.showMessage('');
        // If they clicked an existing unit, select it (fall through to C)
        if (!clickedUnit) return;
      } else {

      // Deduct gold NOW on actual placement
      state.gold -= def.cost;
      const unit = _mkUnit(def, targetRow, col);
      state.playerUnits.push(unit);
      state.shopUnits[state.selectedShopIdx] = null;
      state.selectedShopIdx = null;
      Grid.placeUnit(unit, targetRow, col);
      Grid.clearHighlights();
      Grid.clearSelection();
      Audio.play('place');
      UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
      UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
      UI.updateSynergies(state.playerUnits);
      UI.showUnitDetail(unit);
      UI.showMessage('');
      _refreshHUD();
      return;
      }
    }

    // (B) Moving a selected unit
    if (state.selectedUnit && !clickedUnit) {
      if (row <= GRID_CONFIG.battleLineRow) { UI.showMessage('Keep units in the bottom rows!'); return; }
      const u = state.selectedUnit;
      Grid.removeUnitFromTile(u.row, u.col);
      u.row = row; u.col = col;
      Grid.placeUnit(u, row, col);
      Grid.clearSelection();
      Grid.clearHighlights();
      state.selectedUnit = null;
      UI.showMessage('');
      return;
    }

    // (C) Select a unit
    if (clickedUnit) {
      state.selectedUnit = clickedUnit;
      Grid.clearSelection();
      Grid.selectTile(row, col);
      UI.showUnitDetail(clickedUnit);
      UI.showMessage(`${clickedUnit.definition.name} — Right-click to sell | Click empty tile to move`);

      // Highlight moveable tiles
      const empties = [];
      for (let r = GRID_CONFIG.battleLineRow + 1; r < GRID_CONFIG.rows; r++) {
        for (let c = 0; c < GRID_CONFIG.cols; c++) {
          if (!_unitAt(r, c)) empties.push({ row: r, col: c });
        }
      }
      Grid.highlightTiles(empties, 'highlight-move');
      return;
    }

    // (D) Deselect
    state.selectedUnit = null;
    state.selectedShopIdx = null;
    Grid.clearSelection();
    Grid.clearHighlights();
    UI.showMessage('');
    UI.clearUnitDetail();
  }

  function _handleTileRightClick(row, col) {
    const unit = _unitAt(row, col);
    if (unit) _sellUnit(unit);
  }

  // ── Spawn wave enemies ────────────────────────────────────────────────────

  function _spawnWave(waveDef) {
    const enemies = [];
    for (const spawn of waveDef.enemies) {
      const def = UNIT_MAP[spawn.unitId];
      if (!def) continue;
      for (let i = 0; i < spawn.count; i++) {
        // Place enemies in the top rows (rows 0..battleLineRow-1)
        const col = Math.floor(Math.random() * GRID_CONFIG.cols);
        const row = Math.floor(Math.random() * GRID_CONFIG.battleLineRow); // rows 0..1
        const enemy = _mkUnit(def, row, col, true);

        // Avoid stacking: nudge to next available col in same row
        let placed = false;
        for (let dc = 0; dc < GRID_CONFIG.cols; dc++) {
          const tryCol = (col + dc) % GRID_CONFIG.cols;
          const occupied = enemies.find(e => e.row === row && e.col === tryCol);
          if (!occupied) {
            enemy.col = tryCol;
            placed = true;
            break;
          }
        }
        if (!placed) {
          // Fall into next row — also nudge within that row
          const r2 = (row + 1) % GRID_CONFIG.battleLineRow;
          enemy.row = r2;
          for (let dc2 = 0; dc2 < GRID_CONFIG.cols; dc2++) {
            const tryCol2 = (enemy.col + dc2) % GRID_CONFIG.cols;
            if (!enemies.find(e => e.row === r2 && e.col === tryCol2)) {
              enemy.col = tryCol2;
              break;
            }
          }
        }

        enemies.push(enemy);
      }
    }

    state.enemyUnits = enemies;
    for (const e of enemies) Grid.placeUnit(e, e.row, e.col);
    return enemies;
  }

  // ── Start Battle ──────────────────────────────────────────────────────────

  function startBattle() {
    if (state.phase !== 'prep') return;
    if (state.playerUnits.length === 0) { UI.showMessage('Place at least one unit before battling!'); return; }

    if (state.wave > (GAME_CONFIG.waveCount || 15)) { _handleGameWin(); return; }
    const waveDef = WaveGenerator.generate(state.wave);
    _currentWaveDef = waveDef;

    state.phase = 'battle';
    state.selectedUnit = null;
    state.selectedShopIdx = null;
    Grid.clearSelection();
    Grid.clearHighlights();
    UI.clearLog();
    UI.showMessage('⚔️ Battle started!', 0);
    _refreshHUD();

    const enemies = _spawnWave(waveDef);

    // Track boss encounters for glossary unlock
    for (const e of enemies) {
      if (e.definition.isBoss) {
        const encountered = JSON.parse(localStorage.getItem('shape_strikers_encountered_bosses') || '[]');
        if (!encountered.includes(e.definition.id)) {
          encountered.push(e.definition.id);
          localStorage.setItem('shape_strikers_encountered_bosses', JSON.stringify(encountered));
        }
      }
    }

    battle = new BattleSystem();
    battle.onUnitDeath   = _onUnitDeath;
    battle.onBattleEnd   = _onBattleEnd;
    battle.onLogMessage  = _onLogMsg;
    battle.onPhaseChange = _onPhaseChange;
    battle.onUnitAttack  = _onUnitAttack;
    battle.onUnitHit     = _onUnitHit;
    battle.onAbilityUsed = _onAbilityUsed;
    battle.onScreenShake = _onScreenShake;
    battle.onUnitMove    = _onUnitMove;
    battle.onStatusChange = _onStatusChange;
    battle.onActionDone  = () => Grid.waitForAnimations();

    Audio.play('waveStart');

    battle.start([...state.playerUnits], [...state.enemyUnits]);

    document.getElementById('btn-battle').disabled = true;
    document.getElementById('btn-refresh').disabled = true;
  }

  // ── Battle Callbacks ──────────────────────────────────────────────────────

  function _onUnitAttack(attacker, target) {
    Grid.animateAttack(attacker.row, attacker.col);
    Audio.play('attack');
  }

  function _onUnitMove(unit, fromRow, fromCol, toRow, toCol) {
    Grid.moveUnit(fromRow, fromCol, toRow, toCol);
    Audio.play('move');
  }

  function _onStatusChange(unit) {
    Grid.updateStatusIcons(unit.row, unit.col, unit.statusEffects);
    Grid.updateStatusAuras(unit.row, unit.col, unit.statusEffects);
  }

  function _onUnitHit(target, dmg) {
    if (dmg > 0) {
      Grid.animateHit(target.row, target.col);
      Audio.play('hit');
    } else if (dmg < 0) {
      Grid.animateHealBurst(target.row, target.col);
    }
    Grid.updateUnitHp(target.row, target.col, target.hp, target.maxHp);
    Grid.animateDamageNumber(target.row, target.col, dmg);
  }

  function _onAbilityUsed(unit, abilityName) {
    Grid.animateAttack(unit.row, unit.col);
    Audio.play('ability');
    // Elemental flash on the unit's tile
    const tile = Grid.getTileEl(unit.row, unit.col);
    if (tile) {
      const elemColor = ELEMENT_COLORS[unit.definition.element] || '#ffffff';
      tile.style.boxShadow = `0 0 18px 6px ${elemColor}`;
      setTimeout(() => { tile.style.boxShadow = ''; }, 400);
    }
    // Floating ability name
    Grid.animateAbilityName(unit.row, unit.col, abilityName, unit.definition.element);
  }

  function _onScreenShake(intensity) {
    const grid = document.getElementById('grid-container');
    if (!grid) return;
    grid.classList.remove('anim-shake');
    void grid.offsetWidth;
    grid.style.setProperty('--shake-x', intensity + 'px');
    grid.classList.add('anim-shake');
    grid.addEventListener('animationend', () => {
      grid.classList.remove('anim-shake');
      grid.style.removeProperty('--shake-x');
    }, { once: true });
  }

  function _onUnitDeath(unit) {
    Audio.play(unit.isEnemy ? 'enemyDeath' : 'death');
    Grid.animateDeath(unit.row, unit.col, () => {
      if (unit.isEnemy) {
        state.enemyUnits = state.enemyUnits.filter(u => u !== unit);
        state.score += unit.definition.cost * 10;
      } else {
        state.playerUnits = state.playerUnits.filter(u => u !== unit);
      }
      _refreshHUD();
    });
  }

  function _onBattleEnd(playerWon) {
    state.phase = 'result';
    battle = null;

    if (playerWon) {
      Audio.play('waveClear');
      const goldBase = (GAME_CONFIG.goldPerWave ?? 7) + (_currentWaveDef?.bonusGold ?? 0);
      const victoryBonusUpg = UPGRADES.find(u => u.id === 'victory_bonus');
      const victoryBonus = (victoryBonusUpg?.effect?.value || 2) * (state.upgradeLevels['victory_bonus'] || 0);
      // Add base gold first, then calculate interest on new total (matches Phaser)
      state.gold += goldBase + victoryBonus;
      const interest = _calcInterest(state.gold);
      state.gold += interest;
      const earnedGold = goldBase + interest + victoryBonus;
      state.score += state.wave * 100;
      _healPlayerUnits();

      UI.showMessage('');
      UI.showResult(true, state.wave, earnedGold);
      UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
      _refreshHUD();
    } else {
      _handleGameOver();
    }
  }

  function _onLogMsg(msg, type, side) {
    UI.addLogEntry(msg, type, side);
  }

  function _onPhaseChange(boss, phaseName, desc) {
    UI.showPhaseBanner(phaseName, desc);
    UI.addLogEntry(`⚡ ${boss.name} — ${phaseName}!`, 'boss');
  }

  // ── Post-Battle Healing ───────────────────────────────────────────────────

  function _healPlayerUnits() {
    const fieldMedicUpg = UPGRADES.find(u => u.id === 'field_medic');
    const medicLevel    = state.upgradeLevels['field_medic'] || 0;
    // Base heal 25%; each field_medic level adds +15% (effect.value = 0.15)
    const healPct = (GAME_CONFIG.healingRate || 0.25) + (fieldMedicUpg?.effect?.value || 0.15) * medicLevel;

    for (const u of state.playerUnits) {
      const healAmt = Math.floor(u.maxHp * healPct);
      u.hp = Math.min(u.maxHp, u.hp + healAmt);
      Grid.updateUnitHp(u.row, u.col, u.hp, u.maxHp);
    }
  }

  function _calcInterest(gold) {
    const warChestUpg = UPGRADES.find(u => u.id === 'war_chest');
    const chestLevel  = state.upgradeLevels['war_chest'] || 0;
    // Each level adds 10% interest (effect.value = 0.1 per level)
    const interestPct = (warChestUpg?.effect?.value || 0.1) * chestLevel;
    const interest    = Math.floor(gold * interestPct);
    return Math.min(interest, GAME_CONFIG.maxInterest || 5);
  }

  // ── Next Wave ─────────────────────────────────────────────────────────────

  function nextWave() {
    if (state.wave >= (GAME_CONFIG.waveCount || 15)) { _handleGameWin(); return; }
    state.wave++;
    state.phase = 'prep';
    const refreshMasterLevel = state.upgradeLevels['refresh_master'] || 0;
    const refreshMasterUpg = UPGRADES.find(u => u.id === 'refresh_master');
    state.refreshesLeft = (GAME_CONFIG.maxRefreshesPerRound || 1) + Math.floor((refreshMasterUpg?.effect?.value || 1) * refreshMasterLevel);
    UI.hideResult();
    refreshShop(true);
    _refreshHUD();
    UI.showMessage(`Wave ${state.wave} — Prepare your army!`);
    document.getElementById('btn-battle').disabled  = false;
    document.getElementById('btn-refresh').disabled = false;
  }

  // ── Game Over / Win ───────────────────────────────────────────────────────

  function _handleGameOver() {
    state.phase = 'gameover';
    Audio.play('gameOver');
    UI.showGameOver(state.wave, state.score);

    // Clear enemy units from grid
    for (const e of state.enemyUnits) Grid.removeUnitFromTile(e.row, e.col);
    state.enemyUnits = [];
    _refreshHUD();
  }

  function _handleGameWin() {
    state.phase = 'win';
    localStorage.setItem('shape_strikers_void_unlocked', '1');
    localStorage.setItem('shape_strikers_arcane_unlocked', '1');
    UI.hideResult();
    UI.showWin(state.score);

    // Clear all units from grid
    for (const e of state.enemyUnits) Grid.removeUnitFromTile(e.row, e.col);
    state.enemyUnits = [];
    _refreshHUD();
  }

  // ── Upgrades ─────────────────────────────────────────────────────────────

  function buyUpgrade(id) {
    const upg   = UPGRADES.find(u => u.id === id);
    if (!upg) return;
    const level = state.upgradeLevels[id] || 0;
    if (level >= upg.maxLevel) { UI.showMessage('Already maxed!'); return; }
    const cost = upg.cost + level * 5;
    if (state.gold < cost)  { UI.showMessage('Not enough gold!'); return; }
    state.gold -= cost;
    state.upgradeLevels[id] = level + 1;

    // Immediate effects (match Phaser original)
    if (id === 'refresh_master') state.refreshesLeft += (upg.effect.value || 1);

    UI.showMessage(`${upg.name} upgraded to level ${level + 1}!`);
    UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
    _updateRefreshBtn();
    _refreshHUD();
    UI.updateSynergies(state.playerUnits);
  }

  // ── Speed Control ─────────────────────────────────────────────────────────

  function setSpeed(mult) {
    battle?.setSpeed(mult);
    document.querySelectorAll('.btn-speed').forEach(b => {
      b.classList.toggle('active', parseFloat(b.dataset.speed) === mult);
    });
  }

  // ── Refresh Button State ──────────────────────────────────────────────────

  function _updateMuteBtn() {
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = Audio.isMuted() ? '🔇' : '🔊';
  }

  function _updateRefreshBtn() {
    const costEl = document.getElementById('refresh-cost');
    if (costEl) costEl.textContent = getRefreshCost();
    const btn = document.getElementById('btn-refresh');
    if (btn && state?.phase === 'prep') {
      btn.disabled = state.refreshesLeft <= 0;
      btn.title = `${state.refreshesLeft} refresh${state.refreshesLeft !== 1 ? 'es' : ''} remaining this round`;
    }
  }

  // ── Public startGame ──────────────────────────────────────────────────────

  function startGame() {
    // Remove splash if still visible
    const splashEl = document.getElementById('splash-overlay');
    if (splashEl) splashEl.remove();
    Audio.stopMusic();
    state = _freshState();
    battle = null;
    nextUnitId = 1;
    _currentWaveDef = null;

    // Seed wave generator for this run (unique per game)
    WaveGenerator.setSeed(Date.now());

    UI.showScreen('screen-game');
    UI.hideAllOverlays();

    // Escape key cancels shop selection or unit selection
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state?.phase === 'prep') {
        if (state.selectedShopIdx !== null || state.selectedUnit) {
          state.selectedShopIdx = null;
          state.selectedUnit = null;
          Grid.clearSelection();
          Grid.clearHighlights();
          UI.showMessage('');
          UI.clearUnitDetail();
        }
      }
    });
    UI.clearLog();
    UI.clearUnitDetail();
    UI.switchTab('stats');

    Grid.build();
    Grid.onClick    = _handleTileClick;
    Grid.onRightClick = _handleTileRightClick;

    refreshShop(true);
    UI.updateSynergies([]);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
    _refreshHUD();
    UI.showMessage('Welcome to Shape Strikers! Buy units from the shop, place them, then press Fight!');

    document.getElementById('btn-battle').disabled = false;
    document.getElementById('btn-refresh').disabled = false;
    _updateRefreshBtn();

    // Handle speed controls visibility from title option
    const speedCtrl = document.getElementById('speed-controls');
    if (speedCtrl) {
      speedCtrl.style.display = document.getElementById('opt-speed')?.checked ? 'flex' : 'none';
    }

    // Start tutorial if checked on title screen
    _startTutorial();
  }

  function restart() {
    if (battle) battle.stop();
    battle = null;
    Grid.clearAll();
    startGame();
  }

  // ── Wire up static DOM buttons after DOM load ─────────────────────────────

  function _wireDOMButtons() {
    // Title screen
    document.getElementById('btn-start')?.addEventListener('click', startGame);
    document.getElementById('btn-tutorial')?.addEventListener('click', () => {
      UI.showMessage('Place units in the bottom rows, then press Fight! Same-element units grant bonuses.', 0);
    });

    // Dark mode toggle
    const darkToggle = document.getElementById('opt-dark-mode');
    if (darkToggle) {
      const savedDark = localStorage.getItem('shape_strikers_dark_mode') === '1';
      darkToggle.checked = savedDark;
      if (savedDark) document.documentElement.setAttribute('data-theme', 'dark');
      darkToggle.addEventListener('change', () => {
        const on = darkToggle.checked;
        document.documentElement.setAttribute('data-theme', on ? 'dark' : '');
        localStorage.setItem('shape_strikers_dark_mode', on ? '1' : '0');
      });
    }

    // Mute toggle (title screen checkbox)
    const muteToggle = document.getElementById('opt-mute');
    if (muteToggle) {
      muteToggle.checked = Audio.isMuted();
      muteToggle.addEventListener('change', () => {
        Audio.toggleMute();
        _updateMuteBtn();
      });
    }

    // Mute button (in-game top bar)
    const muteBtn = document.getElementById('btn-mute');
    if (muteBtn) {
      _updateMuteBtn();
      muteBtn.addEventListener('click', () => {
        Audio.toggleMute();
        _updateMuteBtn();
        if (muteToggle) muteToggle.checked = Audio.isMuted();
      });
    }

    // How to Play overlay (on title screen)
    document.getElementById('btn-how-to-play')?.addEventListener('click', () => {
      document.getElementById('overlay-help')?.classList.remove('hidden');
    });

    // Help button (in-game top bar)
    document.getElementById('btn-help')?.addEventListener('click', () => {
      document.getElementById('overlay-help')?.classList.remove('hidden');
    });
    document.getElementById('btn-help-close')?.addEventListener('click', () => {
      document.getElementById('overlay-help')?.classList.add('hidden');
    });

    // In-game controls
    document.getElementById('btn-battle')?.addEventListener('click', startBattle);
    document.getElementById('btn-refresh')?.addEventListener('click', () => refreshShop(false));
    document.getElementById('btn-glossary')?.addEventListener('click', () => UI.showGlossary());
    document.getElementById('btn-quit')?.addEventListener('click', () => {
      if (battle) battle.stop();
      UI.showScreen('screen-title');
      Audio.playMusic('ss_title_music_full.mp3');
      _updateTitleUnlocks();
    });

    // Speed buttons
    document.querySelectorAll('.btn-speed').forEach(b => {
      b.addEventListener('click', () => setSpeed(parseFloat(b.dataset.speed)));
    });

    // Result overlay buttons
    document.getElementById('btn-next-wave')?.addEventListener('click', nextWave);
    document.getElementById('btn-gameover-restart')?.addEventListener('click', restart);
    document.getElementById('btn-win-restart')?.addEventListener('click', restart);

    // Glossary close + filter
    document.getElementById('btn-glossary-close')?.addEventListener('click', () => UI.hideGlossary());
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.addEventListener('click', () => UI.filterGlossary(b.dataset.filter));
    });

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.addEventListener('click', () => UI.switchTab(b.dataset.tab));
    });

    // Sell button in unit detail
    document.getElementById('btn-sell-unit')?.addEventListener('click', () => {
      if (state?.selectedUnit) _sellUnit(state.selectedUnit);
    });
  }

  // ── Title Screen Unlocks Display ──────────────────────────────────────────

  function _updateTitleUnlocks() {
    const el = document.getElementById('title-unlocks');
    if (!el) return;
    const badges = [];
    if (localStorage.getItem('shape_strikers_void_unlocked') === '1') {
      badges.push('<span class="unlock-badge void">🌑 Void Unlocked</span>');
    }
    if (localStorage.getItem('shape_strikers_arcane_unlocked') === '1') {
      badges.push('<span class="unlock-badge">✨ Arcane Unlocked</span>');
    }
    el.innerHTML = badges.length ? badges.join('') : '<span style="font-size:11px;color:var(--text-dim)">Complete the game to unlock factions!</span>';
  }

  // ── Tutorial System ───────────────────────────────────────────────────────

  const TUTORIAL_STEPS = [
    { text: '👋 <b>Welcome!</b> This is the <b>grid</b> — your bottom 2 rows are where you place units. Enemies spawn in the top rows.', highlight: '#grid-area', position: 'right' },
    { text: '🛒 <b>Shop cards</b> appear here. Click a card to buy a unit, then click an empty tile in your zone to place it.', highlight: '#shop-units', position: 'top' },
    { text: '🔄 Use <b>Refresh</b> to get new shop units (costs gold). <b>Right-click</b> a placed unit to sell it back.', highlight: '#btn-refresh', position: 'top' },
    { text: '🔥 <b>Element synergies!</b> Place 2+ units of the same element (Fire, Ice, etc.) to activate bonus stats for those units.', highlight: '#synergy-list', position: 'left' },
    { text: '⬆️ Check the <b>Stats tab</b> for upgrades — Army Expansion adds slots, Field Medic heals between waves, and more.', highlight: '#upgrade-list', position: 'left' },
    { text: '⚔️ When ready, press <b>Fight!</b> — units auto-battle, moving toward enemies and using abilities. Faster units act first.', highlight: '#btn-battle', position: 'top' },
    { text: '🏆 Defeat 15 waves to win! <b>Enemy units</b> have a red skull badge 💀 — look for it on the grid. Good luck!', highlight: '#top-bar', position: 'bottom' },
  ];

  let tutorialStep = -1;

  function _startTutorial() {
    if (!document.getElementById('opt-tutorial')?.checked) return;
    tutorialStep = 0;
    _showTutorialStep();
  }

  function _showTutorialStep() {
    const overlay = document.getElementById('overlay-tutorial');
    const content = document.getElementById('tutorial-content');
    const progress = document.getElementById('tutorial-progress');
    const tutorialBox = document.getElementById('tutorial-box');
    if (!overlay || tutorialStep < 0 || tutorialStep >= TUTORIAL_STEPS.length) {
      overlay?.classList.add('hidden');
      _clearTutorialHighlight();
      tutorialStep = -1;
      return;
    }

    const step = TUTORIAL_STEPS[tutorialStep];
    overlay.classList.remove('hidden');
    content.innerHTML = step.text;
    progress.textContent = `Step ${tutorialStep + 1} / ${TUTORIAL_STEPS.length}`;

    const nextBtn = document.getElementById('btn-tutorial-next');
    if (nextBtn) nextBtn.textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Got it! ✓' : 'Next →';

    // Spotlight: highlight the target element
    _clearTutorialHighlight();
    if (step.highlight) {
      const target = document.querySelector(step.highlight);
      if (target) {
        target.classList.add('tutorial-spotlight');
        // Position the tutorial box near the target
        if (tutorialBox) {
          tutorialBox.removeAttribute('style');
          const rect = target.getBoundingClientRect();
          const pos = step.position || 'bottom';
          tutorialBox.dataset.position = pos;
          _positionTutorialBox(tutorialBox, rect, pos);
        }
      }
    }
  }

  function _clearTutorialHighlight() {
    const prev = document.querySelector('.tutorial-spotlight');
    if (prev) prev.classList.remove('tutorial-spotlight');
    const box = document.getElementById('tutorial-box');
    if (box) { box.removeAttribute('style'); delete box.dataset.position; }
  }

  function _positionTutorialBox(box, rect, pos) {
    const gap = 12;
    box.style.position = 'fixed';
    box.style.bottom = 'auto';
    box.style.left = 'auto';
    box.style.transform = 'none';

    switch (pos) {
      case 'right':
        box.style.top = Math.max(8, rect.top) + 'px';
        box.style.left = Math.min(rect.right + gap, window.innerWidth - 400) + 'px';
        break;
      case 'left':
        box.style.top = Math.max(8, rect.top) + 'px';
        box.style.left = Math.max(8, rect.left - 400 - gap) + 'px';
        break;
      case 'top':
        box.style.top = Math.max(8, rect.top - box.offsetHeight - gap) + 'px';
        box.style.left = Math.max(8, rect.left + rect.width / 2 - 200) + 'px';
        break;
      case 'bottom':
      default:
        box.style.top = (rect.bottom + gap) + 'px';
        box.style.left = Math.max(8, rect.left + rect.width / 2 - 200) + 'px';
        break;
    }
  }

  function _nextTutorialStep() {
    tutorialStep++;
    _showTutorialStep();
  }

  function _skipTutorial() {
    tutorialStep = -1;
    _clearTutorialHighlight();
    document.getElementById('overlay-tutorial')?.classList.add('hidden');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    preloadSprites(); // fire-and-forget — sprites ready before user enters game
    Audio.init();
    _wireDOMButtons();
    _updateTitleUnlocks();

    // Tutorial overlay buttons
    document.getElementById('btn-tutorial-next')?.addEventListener('click', _nextTutorialStep);
    document.getElementById('btn-tutorial-skip')?.addEventListener('click', _skipTutorial);

    // Close help overlay on backdrop click
    document.getElementById('overlay-help')?.addEventListener('click', (e) => {
      if (e.target.id === 'overlay-help') e.target.classList.add('hidden');
    });

    UI.showScreen('screen-title');

    // Show splash overlay — dismissing it is the user interaction that unlocks audio
    const splashEl = document.getElementById('splash-overlay');
    if (splashEl) {
      splashEl.classList.remove('hidden');
      document.getElementById('btn-splash-dismiss')?.addEventListener('click', () => {
        splashEl.classList.add('hidden');
        Audio.playMusic('ss_title_music_full.mp3');
        // Clean up after fade
        setTimeout(() => splashEl.remove(), 600);
      }, { once: true });
    }
  }

  return {
    init,
    startGame,
    restart,
    refreshShop,
    startBattle,
    nextWave,
    buyUpgrade,
    setSpeed,
    getRefreshCost,
    get state() { return state; },
  };
})();

// Boot when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', Game.init);
} else {
  Game.init();
}
