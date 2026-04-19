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
  let _battleStats = null;    // per-battle performance tracking
  let _gameStats = null;      // cumulative game-wide stats
  let _currentSpeedMult = 1;  // persisted speed multiplier across waves
  let _preBattlePositions = null; // saved player unit positions {id, row, col}
  let _battleParticipants = null; // snapshot of player units at battle start (for stats)
  let _inspectedUnit = null; // unit currently shown in detail panel during battle
  let _campaignMode = 'normal'; // 'normal' | 'void'
  let _challengeMode = null;     // null | 'daily' | 'weekly'
  let _challengeModifier = null; // current CHALLENGE_MODIFIERS entry (weekly only)
  let _challengeSeed = 0;        // deterministic seed for challenge runs
  let _challengeElement = null;  // for 'purity' modifier — the single allowed element

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
    const waveCount = _campaignMode === 'void' ? 25 : (GAME_CONFIG.waveCount || 15);
    let challengeLabel = '';
    if (_challengeMode === 'daily') challengeLabel = '📅 Daily';
    else if (_challengeMode === 'weekly') challengeLabel = `📆 ${_challengeModifier?.icon || ''} Weekly`;
    UI.updateHUD({
      wave:     state.wave,
      waveCount: waveCount,
      gold:     state.gold,
      score:    state.score,
      units:    state.playerUnits.length,
      maxUnits: _maxUnits(),
      phase:    state.phase,
      challengeLabel,
    });
  }

  // ── Wave Preview ──────────────────────────────────────────────────────────

  function _updateWavePreview() {
    const el = document.getElementById('wave-preview');
    if (!el || !_currentWaveDef) { if (el) el.classList.add('hidden'); return; }
    const scoutLevel = state?.upgradeLevels?.['scouts_intel'] || 0;

    // Always show current wave basic info
    const enemies = _currentWaveDef.enemies || [];
    let html = `<div class="wave-preview-title">🔍 Wave ${state.wave} Scout</div>`;
    let total = 0;
    for (const e of enemies) {
      const def = UNIT_MAP[e.unitId];
      if (!def) continue;
      const emoji = ELEMENT_EMOJI[def.element] || '❓';
      const bossTag = def.isBoss ? ' <b style="color:#ff4422">BOSS</b>' : '';
      html += `<div class="wave-preview-row"><span class="wp-icon">${emoji}</span><span class="wp-name">${def.name}${bossTag}</span><span class="wp-count">×${e.count}</span></div>`;
      total += e.count;
    }
    html += `<div style="margin-top:4px;font-weight:700;color:#8899aa;font-size:11px">Total: ${total} enemies</div>`;

    // Scout's Intel: preview NEXT wave with full details
    if (scoutLevel >= 1) {
      const totalWaves = _campaignMode === 'void' ? 25 : (GAME_CONFIG.waveCount || 15);
      const nextW = state.wave + 1;
      if (nextW <= totalWaves) {
        const nextDef = WaveGenerator.generate(nextW);
        const nextEnemies = nextDef.enemies || [];
        html += `<hr style="border-color:#334;margin:6px 0">`;
        html += `<div class="wave-preview-title" style="color:#ffaa44">🔭 Next Wave ${nextW}</div>`;
        let nextTotal = 0;
        for (const e of nextEnemies) {
          const def = UNIT_MAP[e.unitId];
          if (!def) continue;
          const emoji = ELEMENT_EMOJI[def.element] || '❓';
          const bossTag = def.isBoss ? ' <b style="color:#ff4422">BOSS</b>' : '';
          html += `<div class="wave-preview-row"><span class="wp-icon">${emoji}</span><span class="wp-name">${def.name}${bossTag}</span><span class="wp-count">×${e.count}</span></div>`;
          if (def.stats) {
            html += `<div style="font-size:10px;color:#8899aa;padding-left:24px">HP:${def.stats.hp} ATK:${def.stats.attack} DEF:${def.stats.defense}</div>`;
          }
          if (def.ability) {
            html += `<div style="font-size:10px;color:#aa88cc;padding-left:24px">⚡ ${def.ability.name}: ${def.ability.description}</div>`;
          }
          nextTotal += e.count;
        }
        html += `<div style="margin-top:4px;font-weight:700;color:#8899aa;font-size:11px">Total: ${nextTotal} enemies</div>`;
      } else {
        html += `<hr style="border-color:#334;margin:6px 0">`;
        html += `<div class="wave-preview-title" style="color:#ffaa44">🔭 Final wave — no next wave!</div>`;
      }
    }

    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  // ── Battle Stats Tracking ─────────────────────────────────────────────────

  function _initBattleStats() {
    _battleStats = { damageDealt: {}, damageTaken: {}, kills: {}, healed: {} };
  }

  function _initGameStats() {
    _gameStats = { totalDamage: 0, totalKills: 0, totalHealed: 0, wavesCleared: 0, bossesKilled: 0, unitStats: {} };
  }

  function _trackDamage(unitId, dmg, isHealing) {
    if (!_battleStats || !unitId) return;
    if (isHealing) {
      _battleStats.healed[unitId] = (_battleStats.healed[unitId] || 0) + Math.abs(dmg);
    } else if (dmg > 0) {
      _battleStats.damageDealt[unitId] = (_battleStats.damageDealt[unitId] || 0) + dmg;
    }
  }

  function _trackKill(killedUnit) {
    if (!_battleStats) return;
    // Attribute to last attacker — we'll just track total enemy kills per unit
  }

  function _accumulateGameStats() {
    if (!_gameStats || !_battleStats) return;
    const totalDmg = Object.values(_battleStats.damageDealt).reduce((s, v) => s + v, 0);
    const totalHeal = Object.values(_battleStats.healed).reduce((s, v) => s + v, 0);
    _gameStats.totalDamage += totalDmg;
    _gameStats.totalHealed += totalHeal;
    _gameStats.totalKills += _battleStats.totalEnemyKills || 0;
    _gameStats.bossesKilled += _battleStats.bossKills || 0;
    _gameStats.wavesCleared++;
  }

  function _buildStatsHTML(battleStats, units, isFinalScreen) {
    if (!battleStats) return '';
    // Use _battleParticipants if available (includes dead units), otherwise fall back to alive units
    const allUnits = _battleParticipants || units;
    const aliveIds = new Set(units.map(u => u.id));

    // Merge all player units info
    const rows = [];
    for (const u of allUnits) {
      const name = u.definition?.name || u.id;
      const dealt = battleStats.damageDealt[u.id] || 0;
      const healed = battleStats.healed[u.id] || 0;
      const kills = battleStats.kills[u.id] || 0;
      const alive = aliveIds.has(u.id);
      if (dealt > 0 || healed > 0 || kills > 0) {
        rows.push({ name, dealt, healed, kills, elem: u.definition?.element, alive });
      }
    }
    if (rows.length === 0) return '';
    rows.sort((a, b) => b.dealt - a.dealt);

    // Determine accolades
    const mvpRow = rows.reduce((best, r) => r.dealt > best.dealt ? r : best, rows[0]);
    const topKiller = rows.reduce((best, r) => r.kills > best.kills ? r : best, rows[0]);
    const topHealer = rows.reduce((best, r) => r.healed > best.healed ? r : best, rows[0]);

    let html = `<div class="stat-label">⚔️ Battle Performance</div>`;
    html += `<table><tr><th>Unit</th><th>Dmg</th><th>Kills</th><th>Heal</th></tr>`;
    for (const r of rows) {
      const badges = [];
      if (r === mvpRow && r.dealt > 0) badges.push('🌟');
      if (r === topKiller && r.kills > 0) badges.push('💀');
      if (r === topHealer && r.healed > 0) badges.push('💚');
      const badgeStr = badges.length ? ' ' + badges.join('') : '';
      const deadClass = !r.alive ? ' stat-dead' : '';
      const isMvp = r === mvpRow && r.dealt > 0;
      html += `<tr class="${isMvp ? 'stat-mvp' : ''}${deadClass}">`;
      html += `<td>${ELEMENT_EMOJI[r.elem] || ''} ${r.name}${badgeStr}${!r.alive ? ' ☠️' : ''}</td>`;
      html += `<td>${r.dealt}</td><td>${r.kills || '-'}</td><td>${r.healed || '-'}</td></tr>`;
    }
    html += `</table>`;

    // Accolade summary for final screens
    if (isFinalScreen) {
      const accolades = [];
      if (mvpRow && mvpRow.dealt > 0) accolades.push(`🌟 <b>MVP:</b> ${mvpRow.name} (${mvpRow.dealt} dmg)`);
      if (topKiller && topKiller.kills > 0) accolades.push(`💀 <b>Executioner:</b> ${topKiller.name} (${topKiller.kills} kills)`);
      if (topHealer && topHealer.healed > 0) accolades.push(`💚 <b>Lifeline:</b> ${topHealer.name} (${topHealer.healed} healed)`);
      if (accolades.length) {
        html += `<div class="stat-label" style="margin-top:8px">🏅 Accolades</div>`;
        html += `<div class="accolade-list">${accolades.join('<br>')}</div>`;
      }
    }

    if (isFinalScreen && _gameStats) {
      html += `<div class="stat-label" style="margin-top:8px">📊 Campaign Summary</div>`;
      html += `<div>Waves cleared: ${_gameStats.wavesCleared} | Total damage: ${_gameStats.totalDamage} | Bosses defeated: ${_gameStats.bossesKilled}</div>`;
    }
    return html;
  }

  // ── Achievement System ────────────────────────────────────────────────────

  let _totalUpgradesBought = 0;  // per-run counter for big_spender
  let _unitsLostThisRun = 0;     // per-run counter for flawless_run

  function _getAchievements() {
    try { return JSON.parse(localStorage.getItem('shape_strikers_achievements') || '{}'); }
    catch { return {}; }
  }

  function _unlockAchievement(id) {
    const achievements = _getAchievements();
    if (achievements[id]) return false; // already unlocked
    achievements[id] = Date.now();
    localStorage.setItem('shape_strikers_achievements', JSON.stringify(achievements));
    // Show toast notification
    const def = ACHIEVEMENTS.find(a => a.id === id);
    if (def) UI.showMessage(`🏅 Achievement Unlocked: ${def.icon} ${def.name}!`, 3000);
    return true;
  }

  function _checkAchievementsOnWaveEnd(playerWon) {
    if (!playerWon) return;
    // Untouchable: won a wave with no player losses
    if ((_battleStats?.playerLosses || 0) === 0) _unlockAchievement('untouchable');
    // Speed Demon: won at 4× speed
    if (_currentSpeedMult >= 4) _unlockAchievement('speed_demon');
  }

  function _checkAchievementsOnGameWin() {
    if (_campaignMode === 'normal') _unlockAchievement('first_victory');
    if (_campaignMode === 'void') _unlockAchievement('void_conqueror');
    // Extinction: 100+ total kills
    if (_gameStats && _gameStats.totalKills >= 100) _unlockAchievement('extinction');
    // Flawless Run: no units lost the entire game
    if (_unitsLostThisRun === 0) _unlockAchievement('flawless_run');
    // Boss Slayer: check all 5 unique bosses encountered
    _checkBossSlayer();
  }

  function _checkBossSlayer() {
    const encountered = JSON.parse(localStorage.getItem('shape_strikers_encountered_bosses') || '[]');
    const allBossIds = UNIT_DEFINITIONS.filter(d => d.isBoss).map(d => d.id);
    if (allBossIds.length > 0 && allBossIds.every(id => encountered.includes(id))) {
      _unlockAchievement('boss_slayer');
    }
  }

  function _checkAchievementsOnPrep() {
    // Full Army: all slots filled
    if (state.playerUnits.length >= _maxUnits()) _unlockAchievement('full_army');
    // Synergy Master: 3+ active synergies
    const elemCounts = {};
    for (const u of state.playerUnits) {
      const e = u.definition?.element;
      if (e) elemCounts[e] = (elemCounts[e] || 0) + 1;
    }
    const activeSynergies = ELEMENT_SYNERGIES.filter(s => (elemCounts[s.element] || 0) >= s.requiredCount).length;
    if (activeSynergies >= 3) _unlockAchievement('synergy_master');
    // Big Spender: 10+ upgrades bought
    if (_totalUpgradesBought >= 10) _unlockAchievement('big_spender');
  }

  // ── Upgrade Stat Buffs (permanent for the run) ────────────────────────

  /** Apply elite_training + double_edge to a single unit (uses base stats) */
  function _applyUpgradeBuffsToUnit(u) {
    const eliteLevel = state.upgradeLevels['elite_training'] || 0;
    const deLevel = state.upgradeLevels['double_edge'] || 0;
    if (eliteLevel === 0 && deLevel === 0) return;

    const eliteAtk = [0, 0.05, 0.15, 0.25][eliteLevel];
    const eliteDef = [0, 0, 0, 0.10][eliteLevel];
    const eliteSpd = [0, 0.05, 0.10, 0.15][eliteLevel];
    const deAtkBonus = 0.20 * deLevel;
    const deDefPenalty = 0.20 * deLevel;

    // Always compute from base definition stats
    const base = u.definition.stats;
    u.attack  = Math.floor(base.attack  * (1 + eliteAtk + deAtkBonus));
    u.defense = Math.max(0, Math.floor(base.defense * (1 + eliteDef - deDefPenalty)));
    u.speed   = Math.floor(base.speed   * (1 + eliteSpd));
    u.stats.attack  = u.attack;
    u.stats.defense = u.defense;
    u.stats.speed   = u.speed;
  }

  /** Re-apply upgrade buffs to ALL player units (called on upgrade purchase) */
  function _applyUpgradeBuffsToAll() {
    for (const u of state.playerUnits) _applyUpgradeBuffsToUnit(u);
  }

  // ── Synergy Display Helpers ───────────────────────────────────────────────

  /** Get active synergies for a specific unit based on current team composition */
  function _getActiveSynergiesForUnit(unit) {
    const counts = {};
    for (const u of state.playerUnits) counts[u.definition.element] = (counts[u.definition.element] || 0) + 1;
    const elem = unit.definition.element;
    const byKey = {};
    for (const syn of ELEMENT_SYNERGIES) {
      if (syn.element === elem && (counts[elem] || 0) >= syn.requiredCount) {
        byKey[syn.bonus.stat] = syn; // highest tier wins
      }
    }
    return Object.values(byKey);
  }

  /** Refresh synergy icons on all player unit tiles */
  function _refreshSynergyIcons() {
    const counts = {};
    for (const u of state.playerUnits) counts[u.definition.element] = (counts[u.definition.element] || 0) + 1;
    const activeSynsByElement = {};
    for (const syn of ELEMENT_SYNERGIES) {
      if ((counts[syn.element] || 0) >= syn.requiredCount) {
        if (!activeSynsByElement[syn.element]) activeSynsByElement[syn.element] = {};
        activeSynsByElement[syn.element][syn.bonus.stat] = syn;
      }
    }
    for (const u of state.playerUnits) {
      const elem = u.definition.element;
      const syns = activeSynsByElement[elem] ? Object.values(activeSynsByElement[elem]) : [];
      Grid.updateSynergyIcons(u.row, u.col, syns, elem);
    }
  }

  // ── Challenge System ──────────────────────────────────────────────────────

  function _getDailyKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function _getWeeklyKey() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function _getDailySeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function _getWeeklySeed() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return d.getFullYear() * 100 + week;
  }

  function _getWeeklyModifier() {
    // Deterministic modifier based on week seed
    const seed = _getWeeklySeed();
    return CHALLENGE_MODIFIERS[seed % CHALLENGE_MODIFIERS.length];
  }

  function _getChallengeData(type) {
    const key = type === 'daily' ? 'shape_strikers_daily_challenge' : 'shape_strikers_weekly_challenge';
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }

  function _saveChallengeResult(type, score, won) {
    const dateKey = type === 'daily' ? _getDailyKey() : _getWeeklyKey();
    const data = _getChallengeData(type);
    const existing = data[dateKey] || { bestScore: 0, attempts: 0, completed: false };
    existing.attempts++;
    if (score > existing.bestScore) existing.bestScore = score;
    if (won) existing.completed = true;
    data[dateKey] = existing;
    const key = type === 'daily' ? 'shape_strikers_daily_challenge' : 'shape_strikers_weekly_challenge';
    localStorage.setItem(key, JSON.stringify(data));
  }

  function _applyChallengeMod_onSpawn(unit) {
    if (!_challengeMode || !_challengeModifier) return;
    const mod = _challengeModifier;
    if (mod.buff === 'glass_cannon') {
      unit.attack = Math.floor(unit.attack * 1.5);
      unit.maxHp = Math.floor(unit.maxHp * 0.5);
      unit.hp = Math.min(unit.hp, unit.maxHp);
    }
    if (mod.debuff === 'fragile') {
      unit.maxHp = Math.floor(unit.maxHp * 0.7);
      unit.hp = Math.min(unit.hp, unit.maxHp);
    }
  }

  function _challengeGoldModifier() {
    if (!_challengeMode || !_challengeModifier) return 1;
    if (_challengeModifier.economy === 'budget') return 0.7;
    return 1;
  }

  function _getEnemyHpMultiplier() {
    if (_challengeMode === 'weekly' && _challengeModifier?.enemyBuff === 'titan') return 1.4;
    return 1;
  }

  // ── Generate shop based on current wave ───────────────────────────────────

  function _rollableUnits() {
    const maxTier = Math.min(3, Math.ceil(state.wave / 3));
    const arcaneUnlocked = localStorage.getItem('shape_strikers_arcane_unlocked') === '1';
    const voidUnlocked = localStorage.getItem('shape_strikers_void_unlocked') === '1';
    const voidForPlayer = _campaignMode === 'void' && voidUnlocked;
    let pool = UNIT_DEFINITIONS.filter(d => {
      if (d.isBoss) return false;
      if (d.element === Element.VOID && !voidForPlayer) return false;
      if (d.element === Element.ARCANE && !arcaneUnlocked) return false;
      if (d.tier > maxTier) return false;
      return true;
    });
    // Apply challenge modifier shop filters
    if (_challengeMode === 'weekly' && _challengeModifier) {
      const mod = _challengeModifier;
      if (mod.filter === 'fire') pool = pool.filter(d => d.element === Element.FIRE);
      else if (mod.filter === 'ice') pool = pool.filter(d => d.element === Element.ICE);
      else if (mod.filter === 'single_element' && _challengeElement) pool = pool.filter(d => d.element === _challengeElement);
      if (mod.banRole === 'healer') pool = pool.filter(d => d.role !== 'healer');
    }
    return pool;
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
    const mercLevel = state.upgradeLevels['mercenary'] || 0;
    const shopSize = 5 + mercLevel;
    state.shopUnits = Array.from({ length: shopSize }, () => {
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

    if (state.phase !== 'prep') { UI.showMessage('Can only buy during the shop phase.'); return; }
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
    if (state.phase !== 'prep') { UI.showMessage('Can only sell during the shop phase.'); return; }
    const sellValue = Math.max(GAME_CONFIG.minSellValue || 1, Math.floor(unit.definition.cost * (GAME_CONFIG.sellRefundPercent || 0.5)));
    state.gold += sellValue;
    state.playerUnits = state.playerUnits.filter(u => u !== unit);
    Grid.removeUnitFromTile(unit.row, unit.col);
    Audio.play('sell');
    UI.showMessage(`Sold ${unit.definition.name} for ${sellValue}g`);
    UI.clearUnitDetail();
    state.selectedUnit = null;
    UI.updateSynergies(state.playerUnits);
    _refreshSynergyIcons();
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
    const unit = {
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
    // Apply challenge modifier stat changes for player units
    if (!isEnemy) _applyChallengeMod_onSpawn(unit);
    // Apply enemy HP buff for titan_wave challenge
    if (isEnemy && _getEnemyHpMultiplier() !== 1) {
      const mult = _getEnemyHpMultiplier();
      unit.maxHp = Math.floor(unit.maxHp * mult);
      unit.hp = unit.maxHp;
    }
    return unit;
  }

  // ── Tile click handler ────────────────────────────────────────────────────

  function _handleTileClick(row, col) {
    const clickedUnit = _unitAt(row, col);
    const clickedEnemy = state.enemyUnits.find(u => u.row === row && u.col === col && u.hp > 0);

    // During battle — allow inspecting any unit (read-only)
    if (state.phase === 'battle') {
      const unit = clickedUnit || clickedEnemy;
      if (unit) {
        _inspectedUnit = unit;
        Grid.clearSelection();
        Grid.selectTile(row, col);
        UI.showUnitDetail(unit, state.upgradeLevels, !unit.isEnemy ? _getActiveSynergiesForUnit(unit) : null);
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
      _applyUpgradeBuffsToUnit(unit);
      state.playerUnits.push(unit);
      state.shopUnits[state.selectedShopIdx] = null;
      state.selectedShopIdx = null;
      Grid.placeUnit(unit, targetRow, col);
      Grid.updateUpgradeIcons(targetRow, col, state.upgradeLevels);
      Grid.clearHighlights();
      Grid.clearSelection();
      Audio.play('place');
      UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
      UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
      UI.updateSynergies(state.playerUnits);
      UI.showUnitDetail(unit, state.upgradeLevels, _getActiveSynergiesForUnit(unit));
      UI.showMessage('');
      _refreshSynergyIcons();
      _refreshHUD();

      // Contextual tips
      _showContextualTip('first_unit_placed');
      const syns = _getActiveSynergiesForUnit(unit);
      if (syns.length > 0) _showContextualTip('first_synergy');
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
      Grid.updateUpgradeIcons(row, col, state.upgradeLevels);
      Grid.clearSelection();
      Grid.clearHighlights();
      _refreshSynergyIcons();
      state.selectedUnit = null;
      UI.showMessage('');
      return;
    }

    // (C) Select a unit (or deselect if already selected)
    if (clickedUnit) {
      if (state.selectedUnit === clickedUnit) {
        state.selectedUnit = null;
        Grid.clearSelection();
        Grid.clearHighlights();
        UI.showMessage('');
        UI.clearUnitDetail();
        return;
      }
      state.selectedUnit = clickedUnit;
      Grid.clearSelection();
      Grid.selectTile(row, col);
      UI.showUnitDetail(clickedUnit, state.upgradeLevels, _getActiveSynergiesForUnit(clickedUnit));
      UI.showMessage(`${clickedUnit.definition.name} — Click again to deselect | Right-click to sell | Click empty tile to move`);
      _showContextualTip('stat_card_explain');

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
    if (unit && state.phase === 'prep') {
      const sellValue = Math.max(GAME_CONFIG.minSellValue || 1, Math.floor(unit.definition.cost * (GAME_CONFIG.sellRefundPercent || 0.5)));
      _showSellConfirm(unit, sellValue, row, col);
    }
  }

  function _showSellConfirm(unit, sellValue, row, col) {
    // Remove any existing confirm
    document.querySelector('.sell-confirm')?.remove();
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;

    const popup = document.createElement('div');
    popup.className = 'sell-confirm';
    popup.innerHTML = `<span>Sell for ${sellValue}g?</span><button class="sell-yes">✓</button><button class="sell-no">✕</button>`;
    tile.appendChild(popup);

    popup.querySelector('.sell-yes').addEventListener('click', (e) => {
      e.stopPropagation();
      popup.remove();
      _sellUnit(unit);
    });
    popup.querySelector('.sell-no').addEventListener('click', (e) => {
      e.stopPropagation();
      popup.remove();
    });
    // Auto-dismiss after 3 seconds
    setTimeout(() => popup.remove(), 3000);
  }

  // ── Spawn wave enemies ────────────────────────────────────────────────────

  function _spawnWave(waveDef) {
    const enemies = [];
    // Hard mode scaling for void campaign waves 16+
    const scaling = (_campaignMode === 'void' && HARD_MODE_SCALING[state.wave]) || null;

    for (const spawn of waveDef.enemies) {
      const def = UNIT_MAP[spawn.unitId];
      if (!def) continue;
      for (let i = 0; i < spawn.count; i++) {
        // Place enemies in the top rows (rows 0..battleLineRow-1)
        const col = Math.floor(Math.random() * GRID_CONFIG.cols);
        const row = Math.floor(Math.random() * GRID_CONFIG.battleLineRow); // rows 0..1
        const enemy = _mkUnit(def, row, col, true);

        // Apply hard mode stat scaling
        if (scaling) {
          enemy.stats.hp      = Math.round(enemy.stats.hp * (scaling.hp || 1));
          enemy.stats.maxHp   = Math.round(enemy.stats.maxHp * (scaling.hp || 1));
          enemy.stats.attack  = Math.round(enemy.stats.attack * (scaling.attack || 1));
          enemy.stats.defense = Math.round(enemy.stats.defense * (scaling.defense || 1));
          enemy.stats.speed   = Math.round(enemy.stats.speed * (scaling.speed || 1));
          // Also scale boss phase HP pools so they match the inflated stats
          if (def.bossPhases) {
            enemy.definition = Object.assign({}, def, {
              bossPhases: def.bossPhases.map(p => ({
                ...p,
                phaseHp: p.phaseHp ? Math.round(p.phaseHp * (scaling.hp || 1)) : p.phaseHp,
              })),
            });
          }
        }

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

    const totalWaves = _campaignMode === 'void' ? 25 : (GAME_CONFIG.waveCount || 15);
    if (state.wave > totalWaves) { _handleGameWin(); return; }
    if (!_currentWaveDef) _currentWaveDef = WaveGenerator.generate(state.wave);
    const waveDef = _currentWaveDef;

    state.phase = 'battle';
    state.selectedUnit = null;
    state.selectedShopIdx = null;
    // Check prep-phase achievements before battle
    _checkAchievementsOnPrep();
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
    if (_currentSpeedMult !== 1) battle.setSpeed(_currentSpeedMult);
    _initBattleStats();
    // Snapshot all player units for stats (includes units that may die during battle)
    _battleParticipants = state.playerUnits.map(u => ({ id: u.id, definition: u.definition, maxHp: u.maxHp }));
    battle.onUnitDeath   = _onUnitDeath;
    battle.onBattleEnd   = _onBattleEnd;
    battle.onLogMessage  = _onLogMsg;
    battle.onPhaseChange = _onPhaseChange;
    battle.onUnitAttack  = _onUnitAttack;
    battle.onUnitHit     = _onUnitHit;
    battle.onAbilityUsed = _onAbilityUsed;
    battle.onScreenShake = _onScreenShake;
    battle.onCriticalHit = _onCriticalHit;
    battle.onUnitMove    = _onUnitMove;
    battle.onStatusChange = _onStatusChange;
    battle.onActionDone  = () => Grid.waitForAnimations();
    battle.onSynergyActivated = (element) => {
      Grid.animateSynergyPulse(state.playerUnits, element);
    };

    Audio.play('waveStart');

    // Contextual tips
    _showContextualTip('first_battle');
    const hasBoss = enemies.some(e => e.definition.isBoss);
    if (hasBoss) _showContextualTip('first_boss');

    // Save player unit positions to restore after battle
    _preBattlePositions = state.playerUnits.map(u => ({ id: u.id, row: u.row, col: u.col }));

    // Upgrade stat buffs are already permanent — no per-battle apply needed

    // Boss intro cinematic
    const boss = enemies.find(e => e.definition.isBoss);
    if (boss) {
      _showBossIntro(boss, () => {
        battle.start([...state.playerUnits], [...state.enemyUnits]);
      });
    } else {
      battle.start([...state.playerUnits], [...state.enemyUnits]);
    }

    document.getElementById('btn-battle').disabled = true;
    document.getElementById('btn-refresh').disabled = true;
    document.getElementById('btn-slots').disabled = true;
  }

  // ── Battle Callbacks ──────────────────────────────────────────────────────

  function _onCriticalHit(attacker, target) {
    if (target) {
      VFX.screenFlash('#ffee00', 250, 0.3);
      VFX.shockwave(target.row, target.col, '#ffee00', 'large');
      VFX.screenShake('heavy');
    }
  }

  function _onUnitAttack(attacker, target) {
    Grid.animateAttack(attacker.row, attacker.col);
    Audio.play('attack');
    if ((attacker.stats.range || 1) > 1) {
      // Ranged projectile with element-specific VFX trails
      VFX.elementProjectile(attacker.row, attacker.col, target.row, target.col, attacker.definition.element);
    } else {
      // Melee slash animation on target
      VFX.meleeSlash(target.row, target.col);
    }
  }

  function _onUnitMove(unit, fromRow, fromCol, toRow, toCol) {
    Grid.moveUnit(fromRow, fromCol, toRow, toCol);
    Audio.play('move');
  }

  function _onStatusChange(unit) {
    Grid.updateStatusIcons(unit.row, unit.col, unit.statusEffects);
    Grid.updateStatusAuras(unit.row, unit.col, unit.statusEffects);
    if (_inspectedUnit && _inspectedUnit.id === unit.id) {
      UI.showUnitDetail(unit, state.upgradeLevels, !unit.isEnemy ? _getActiveSynergiesForUnit(unit) : null);
    }
    // Contextual tips for first buff/debuff on player units
    if (!unit.isEnemy && unit.statusEffects?.length > 0) {
      const NEGATIVES = ['burn','poison','freeze','slow','weaken','wound','blind'];
      const hasDebuff = unit.statusEffects.some(s => NEGATIVES.includes(s.type));
      const hasBuff = unit.statusEffects.some(s => !NEGATIVES.includes(s.type));
      if (hasDebuff) _showContextualTip('first_debuff');
      if (hasBuff) _showContextualTip('first_buff');
    }
  }

  function _onUnitHit(target, dmg, element, sourceId) {
    if (dmg > 0) {
      Grid.animateHit(target.row, target.col);
      Audio.play('hit');
      // Shockwave + screen flash scaled by damage
      const color = element ? ELEMENT_COLORS[element] : '#ffffff';
      if (dmg >= 30) {
        VFX.shockwave(target.row, target.col, color, 'large');
        VFX.screenFlash(color, 250, 0.2);
      } else if (dmg >= 15) {
        VFX.shockwave(target.row, target.col, color, 'medium');
        VFX.screenFlash(color, 200, 0.12);
      } else {
        VFX.shockwave(target.row, target.col, color, 'small');
      }
    } else if (dmg < 0) {
      // Healing: use VFX single-target heal
      VFX.healSingle(target.row, target.col);
    }
    Grid.updateUnitHp(target.row, target.col, target.hp, target.maxHp);
    const elemColor = element ? ELEMENT_COLORS[element] : null;
    Grid.animateDamageNumber(target.row, target.col, dmg, elemColor);
    // Live-refresh detail panel if this unit is being inspected
    if (_inspectedUnit && _inspectedUnit.id === target.id) {
      UI.showUnitDetail(target, state.upgradeLevels, !target.isEnemy ? _getActiveSynergiesForUnit(target) : null);
    }
    // Track stats
    if (sourceId && _battleStats) {
      if (dmg < 0) {
        _battleStats.healed[sourceId] = (_battleStats.healed[sourceId] || 0) + Math.abs(dmg);
      } else if (dmg > 0) {
        _battleStats.damageDealt[sourceId] = (_battleStats.damageDealt[sourceId] || 0) + dmg;
      }
    }
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
    // Ability-specific VFX per element / type
    _triggerAbilityVFX(unit, abilityName);
  }

  /** Dispatch ability-specific VFX based on unit id/element */
  function _triggerAbilityVFX(unit, abilityName) {
    const uid = unit.definition.id;
    const elem = unit.definition.element;
    switch (uid) {
      // Fire abilities → burn spread
      case 'fire_imp': case 'fire_scout': case 'fire_warrior':
      case 'fire_demon': case 'fire_ravager':
      case 'boss_flame_tyrant':
        VFX.burnSpread(unit.row, unit.col);
        break;
      // Ice abilities → freeze burst
      case 'ice_slime': case 'ice_archer': case 'ice_guardian':
      case 'ice_empress':
      case 'boss_frost_colossus':
        VFX.freezeBurst(unit.row, unit.col);
        break;
      // Lightning → chain bolt VFX
      case 'lightning_sprite': case 'lightning_knight':
      case 'lightning_lord': case 'lightning_hunter':
        VFX.shockwave(unit.row, unit.col, ELEMENT_COLORS.lightning, 'small');
        break;
      // Earth → shockwave
      case 'earth_golem': case 'earth_archer': case 'earth_enforcer':
        VFX.shockwave(unit.row, unit.col, ELEMENT_COLORS.earth, 'medium');
        break;
      // Healer abilities → AoE heal VFX
      case 'frost_fairy': case 'arcane_priest': case 'nature_spirit':
      case 'life_guardian':
        VFX.healAoE(unit.row, unit.col);
        break;
      // Shield/barrier abilities
      case 'arcane_pupil':
        VFX.shieldDome(unit.row, unit.col);
        break;
      // Arcane abilities
      case 'arcane_mage': case 'arcane_assassin': case 'arcane_illusionist':
        VFX.shockwave(unit.row, unit.col, ELEMENT_COLORS.arcane, 'medium');
        break;
      // Void abilities
      case 'void_shade': case 'void_knight': case 'void_blighter':
      case 'void_horror':
      case 'boss_void_leviathan': case 'boss_void_architect':
      case 'boss_chaos_overlord':
        VFX.voidRupture(unit.row, unit.col);
        break;
      // Poison cloud
      case 'konji_scout': case 'konji_shaman':
        VFX.poisonCloud(unit.row, unit.col);
        break;
      // Blood/vampire lifesteal
      case 'blood_sprite': case 'blood_knight':
        VFX.shockwave(unit.row, unit.col, '#cc2244', 'small');
        break;
      // Martial master → rapid shockwave
      case 'martial_master':
        VFX.shockwave(unit.row, unit.col, ELEMENT_COLORS.earth, 'large');
        break;
    }
  }

  function _onScreenShake(intensity) {
    // Map numeric intensity to shake type
    const type = intensity >= 10 ? 'heavy' : intensity >= 5 ? 'medium' : 'light';
    VFX.screenShake(type);
  }

  // ── Boss Intro Cinematic (enhanced via VFX module) ────────────────────────

  function _showBossIntro(boss, onDone) {
    Audio.play('ability');
    VFX.bossEntrance(boss.definition, onDone);
  }

  function _onUnitDeath(unit, killer) {
    Audio.play(unit.isEnemy ? 'enemyDeath' : 'death');
    // Track kills for stats (enemy deaths = player kills)
    if (_battleStats && unit.isEnemy) {
      _battleStats.totalEnemyKills = (_battleStats.totalEnemyKills || 0) + 1;
      if (unit.definition.isBoss) _battleStats.bossKills = (_battleStats.bossKills || 0) + 1;
      // Per-unit kill attribution
      if (killer && killer.id) {
        _battleStats.kills[killer.id] = (_battleStats.kills[killer.id] || 0) + 1;
      }
    }
    // Track player unit losses
    if (_battleStats && !unit.isEnemy) {
      _battleStats.playerLosses = (_battleStats.playerLosses || 0) + 1;
      _unitsLostThisRun++;
    }
    // Remove from state immediately (don't wait for animation) to prevent ghost units
    if (unit.isEnemy) {
      state.enemyUnits = state.enemyUnits.filter(u => u !== unit);
      state.score += unit.definition.cost * 10;
    } else {
      state.playerUnits = state.playerUnits.filter(u => u !== unit);
    }
    _refreshHUD();
    Grid.animateDeath(unit.row, unit.col);
  }

  function _onBattleEnd(playerWon) {
    state.phase = 'result';
    battle = null;
    _inspectedUnit = null;
    // Upgrade stat buffs are permanent — no post-battle removal

    if (playerWon) {
      Audio.play('waveClear');
      const goldBase = Math.floor(((GAME_CONFIG.goldPerWave ?? 7) + (_currentWaveDef?.bonusGold ?? 0)) * _challengeGoldModifier());
      const victoryBonusUpg = UPGRADES.find(u => u.id === 'victory_bonus');
      const victoryBonus = (victoryBonusUpg?.effect?.value || 2) * (state.upgradeLevels['victory_bonus'] || 0);
      // Add base gold first, then calculate interest on new total (matches Phaser)
      state.gold += goldBase + victoryBonus;
      const interest = _calcInterest(state.gold);
      state.gold += interest;
      const earnedGold = goldBase + interest + victoryBonus;
      state.score += state.wave * 100;
      _restorePlayerPositions();
      _cleanupBattleArtifacts();
      _healPlayerUnits();

      UI.showMessage('');
      UI.showResult(true, state.wave, earnedGold, { base: GAME_CONFIG.goldPerWave ?? 7, bonus: _currentWaveDef?.bonusGold ?? 0, victory: victoryBonus, interest });
      // Populate post-battle stats
      const rsEl = document.getElementById('result-stats');
      if (rsEl && _battleStats) rsEl.innerHTML = _buildStatsHTML(_battleStats, state.playerUnits, false);
      // Accumulate game-wide stats
      _accumulateGameStats();
      // Check wave-end achievements
      _checkAchievementsOnWaveEnd(true);
      UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
      _refreshUpgradeIcons();
      _refreshSynergyIcons();
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

  function _restorePlayerPositions() {
    if (!_preBattlePositions) return;
    // Pass 1: clear ALL player zone tiles to avoid cross-contamination
    for (let r = GRID_CONFIG.battleLineRow + 1; r < GRID_CONFIG.rows; r++) {
      for (let c = 0; c < GRID_CONFIG.cols; c++) {
        Grid.removeUnitFromTile(r, c);
      }
    }
    // Pass 2: restore each surviving unit to its pre-battle position
    for (const u of state.playerUnits) {
      const saved = _preBattlePositions.find(p => p.id === u.id);
      if (saved) { u.row = saved.row; u.col = saved.col; }
      Grid.placeUnit(u, u.row, u.col);
      Grid.updateUpgradeIcons(u.row, u.col, state.upgradeLevels);
    }
    _preBattlePositions = null;
  }

  function _cleanupBattleArtifacts() {
    // Remove any lingering damage numbers, ability floats, death animations, and enemy remnants
    document.querySelectorAll('.dmg-float, .ability-float, .anim-death, .heal-particle').forEach(el => el.remove());
    // Clear ALL tiles of status effects, auras, icons
    document.querySelectorAll('.status-aura, .status-icons').forEach(el => el.remove());
    for (let r = 0; r < GRID_CONFIG.rows; r++) {
      for (let c = 0; c < GRID_CONFIG.cols; c++) {
        const tile = Grid.getTileEl(r, c);
        if (!tile) continue;
        // Remove aura type classes
        for (const t of ['burn','poison','freeze','slow','weaken','wound','shield','barrier','untargetable']) tile.classList.remove('has-' + t);
        // Clear enemy zone tiles completely (remove unit DOM)
        if (r <= GRID_CONFIG.battleLineRow) {
          Grid.removeUnitFromTile(r, c);
          continue;
        }
        // Player zone: remove any tile that has no surviving unit in state
        const hasUnit = state.playerUnits.some(u => u.row === r && u.col === c);
        if (!hasUnit) {
          Grid.removeUnitFromTile(r, c);
        }
      }
    }
    // Reset status effects on surviving player units
    for (const u of state.playerUnits) {
      u.statusEffects = [];
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
    const totalWaves = _campaignMode === 'void' ? 25 : (GAME_CONFIG.waveCount || 15);
    if (state.wave >= totalWaves) { _handleGameWin(); return; }
    state.wave++;
    state.phase = 'prep';
    // Pre-generate upcoming wave for preview tooltip
    _currentWaveDef = WaveGenerator.generate(state.wave);
    _updateWavePreview();
    const refreshMasterLevel = state.upgradeLevels['refresh_master'] || 0;
    const refreshMasterUpg = UPGRADES.find(u => u.id === 'refresh_master');
    state.refreshesLeft = (GAME_CONFIG.maxRefreshesPerRound || 1) + Math.floor((refreshMasterUpg?.effect?.value || 1) * refreshMasterLevel);
    UI.hideResult();
    refreshShop(true);
    _refreshHUD();
    const voidLabel = (_campaignMode === 'void' && state.wave >= 16) ? ' 🕳️' : '';
    UI.showMessage(`Wave ${state.wave}${voidLabel} — Prepare your army!`);
    document.getElementById('btn-battle').disabled  = false;
    document.getElementById('btn-refresh').disabled = false;
    document.getElementById('btn-slots').disabled   = false;
  }

  // ── Game Over / Win ───────────────────────────────────────────────────────

  function _handleGameOver() {
    state.phase = 'gameover';
    Audio.play('gameOver');
    _accumulateGameStats();
    // Save challenge result
    if (_challengeMode) _saveChallengeResult(_challengeMode, state.score, false);
    UI.showGameOver(state.wave, state.score);
    const goEl = document.getElementById('gameover-stats');
    if (goEl && _battleStats) goEl.innerHTML = _buildStatsHTML(_battleStats, state.playerUnits, true);

    // Clear enemy units from grid
    for (const e of state.enemyUnits) Grid.removeUnitFromTile(e.row, e.col);
    state.enemyUnits = [];
    _refreshHUD();
    _showScoreSubmit('gameover');
  }

  function _handleGameWin() {
    state.phase = 'win';
    if (!_challengeMode) {
      localStorage.setItem('shape_strikers_void_unlocked', '1');
      localStorage.setItem('shape_strikers_arcane_unlocked', '1');
      if (_campaignMode === 'void') {
        localStorage.setItem('shape_strikers_void_campaign_cleared', '1');
      }
    }
    _accumulateGameStats();
    // Save challenge result
    if (_challengeMode) _saveChallengeResult(_challengeMode, state.score, true);
    // Check end-of-game achievements (not in challenge mode)
    if (!_challengeMode) _checkAchievementsOnGameWin();
    UI.hideResult();

    const winTitle = _campaignMode === 'void'
      ? '🕳️ VOID CONQUERED!'
      : '🏆 VICTORY!';
    UI.showWin(state.score, winTitle, _campaignMode);

    const wEl = document.getElementById('win-stats');
    if (wEl && _battleStats) wEl.innerHTML = _buildStatsHTML(_battleStats, state.playerUnits, true);

    // Clear all units from grid
    for (const e of state.enemyUnits) Grid.removeUnitFromTile(e.row, e.col);
    state.enemyUnits = [];
    _refreshHUD();
    _showScoreSubmit('win');
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
    _totalUpgradesBought++;

    // Immediate effects (match Phaser original)
    if (id === 'refresh_master') state.refreshesLeft += (upg.effect.value || 1);

    UI.showMessage(`${upg.name} upgraded to level ${level + 1}!`);
    UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);
    _updateRefreshBtn();
    _refreshHUD();
    UI.updateSynergies(state.playerUnits);

    // Update upgrade badges on all player units
    if (id === 'elite_training' || id === 'double_edge') {
      _applyUpgradeBuffsToAll();
      _refreshUpgradeIcons();
      VFX.screenFlash(id === 'elite_training' ? '#44dd44' : '#ff5544', 200);
    }

    _showContextualTip('first_upgrade');
  }

  function _refreshUpgradeIcons() {
    const eliteLevel = state.upgradeLevels['elite_training'] || 0;
    const deLevel = state.upgradeLevels['double_edge'] || 0;
    if (eliteLevel === 0 && deLevel === 0) return;
    for (const u of state.playerUnits) {
      Grid.updateUpgradeIcons(u.row, u.col, state.upgradeLevels);
    }
  }

  // ── Speed Control ─────────────────────────────────────────────────────────

  function setSpeed(mult) {
    _currentSpeedMult = mult;
    battle?.setSpeed(mult);
    VFX.setSpeed(mult);
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

  function startChallenge(type) {
    _challengeMode = type; // 'daily' | 'weekly'
    if (type === 'daily') {
      _challengeSeed = _getDailySeed();
      _challengeModifier = null;
      _challengeElement = null;
    } else {
      _challengeSeed = _getWeeklySeed();
      _challengeModifier = _getWeeklyModifier();
      // For 'purity' (single_element), pick a deterministic element from the seed
      if (_challengeModifier.filter === 'single_element') {
        const elements = [Element.FIRE, Element.ICE, Element.LIGHTNING, Element.EARTH];
        _challengeElement = elements[_challengeSeed % elements.length];
      } else {
        _challengeElement = null;
      }
    }
    startGame('normal');
  }

  function startGame(campaignMode) {
    // Remove splash if still visible
    const splashEl = document.getElementById('splash-overlay');
    if (splashEl) splashEl.remove();
    Audio.stopMusic();

    // Set campaign mode (default to normal)
    _campaignMode = (campaignMode === 'void') ? 'void' : 'normal';
    // Reset challenge state if this is a direct startGame call (not from startChallenge)
    if (!_challengeMode) {
      _challengeModifier = null;
      _challengeElement = null;
      _challengeSeed = 0;
    }

    state = _freshState();
    _initGameStats();
    _totalUpgradesBought = 0;
    _unitsLostThisRun = 0;
    _seenTips = {};          // reset contextual tips each run
    battle = null;
    nextUnitId = 1;
    _currentWaveDef = null;

    // Seed wave generator — deterministic for challenges, unique otherwise
    if (_challengeMode) {
      WaveGenerator.setSeed(_challengeSeed);
      // Apply budget modifier starting gold
      if (_challengeModifier?.economy === 'budget') state.gold = 5;
    } else {
      WaveGenerator.setSeed(Date.now());
    }

    // Apply void campaign visual theme
    const gridArea = document.getElementById('grid-area');
    if (gridArea) {
      gridArea.classList.toggle('void-campaign', _campaignMode === 'void');
    }

    UI.showScreen('screen-game');
    UI.hideAllOverlays();

    // Escape key cancels shop selection or unit selection
    document.addEventListener('keydown', (e) => {
      // Don't trigger shortcuts when typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        if (state?.phase === 'prep') {
          if (state.selectedShopIdx !== null || state.selectedUnit) {
            state.selectedShopIdx = null;
            state.selectedUnit = null;
            Grid.clearSelection();
            Grid.clearHighlights();
            UI.showMessage('');
            UI.clearUnitDetail();
          }
        }
        return;
      }
      if (key === 'b' && state?.phase === 'prep') {
        document.getElementById('btn-battle')?.click();
      } else if (key === 'r' && state?.phase === 'prep') {
        document.getElementById('btn-refresh')?.click();
      } else if (key === 'n' && state?.phase === 'result') {
        document.getElementById('btn-next-wave')?.click();
      } else if (key >= '1' && key <= '4') {
        const speeds = { '1': 0.5, '2': 1, '3': 2, '4': 4 };
        const speedBtn = document.querySelector(`[data-speed="${speeds[key]}"]`);
        if (speedBtn) speedBtn.click();
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
    if (_challengeMode === 'daily') {
      UI.showMessage(`📅 Daily Challenge — ${_getDailyKey()} — Same waves for everyone today!`);
    } else if (_challengeMode === 'weekly') {
      UI.showMessage(`📆 Weekly Challenge: ${_challengeModifier.icon} ${_challengeModifier.name} — ${_challengeModifier.description}`);
    } else {
      UI.showMessage('Welcome to Shape Strikers! Buy units from the shop, place them, then press Fight!');
    }

    document.getElementById('btn-battle').disabled = false;
    document.getElementById('btn-refresh').disabled = false;
    document.getElementById('btn-slots').disabled = false;
    _updateRefreshBtn();

    // Pre-generate wave 1 for preview
    _currentWaveDef = WaveGenerator.generate(state.wave);
    _updateWavePreview();

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
    if (_challengeMode) {
      // Re-run the same challenge type (re-seeds deterministically)
      const type = _challengeMode;
      _challengeMode = null; // reset so startChallenge can set it fresh
      startChallenge(type);
    } else {
      startGame(_campaignMode);
    }
  }

  function _returnToTitle() {
    if (battle) battle.stop();
    battle = null;
    _challengeMode = null;
    _challengeModifier = null;
    _challengeElement = null;
    // Hide end-game overlays so they don't stay on top
    document.getElementById('overlay-gameover')?.classList.add('hidden');
    document.getElementById('overlay-win')?.classList.add('hidden');
    UI.showScreen('screen-title');
    Audio.playMusic('ss_title_music_full.mp3');
    _updateTitleUnlocks();
  }

  // ── Achievements Overlay ────────────────────────────────────────────────

  function _showAchievements() {
    const overlay = document.getElementById('overlay-achievements');
    const grid = document.getElementById('achievements-grid');
    const progress = document.getElementById('achievements-progress');
    if (!overlay || !grid) return;

    const unlocked = _getAchievements();
    let unlockedCount = 0;

    grid.innerHTML = ACHIEVEMENTS.map(a => {
      const isUnlocked = !!unlocked[a.id];
      if (isUnlocked) unlockedCount++;
      const dateStr = isUnlocked
        ? `<div class="achievement-date">Unlocked ${new Date(unlocked[a.id]).toLocaleDateString()}</div>`
        : '';
      const iconHtml = (a.badge && isUnlocked)
        ? `<img class="achievement-badge" src="${a.badge}" alt="${a.name}">`
        : `<div class="achievement-icon">${a.icon}</div>`;
      return `
        <div class="achievement-card ${isUnlocked ? 'unlocked' : 'locked'}">
          ${iconHtml}
          <div class="achievement-info">
            <div class="achievement-name">${a.name}</div>
            <div class="achievement-desc">${a.description}</div>
            ${dateStr}
          </div>
        </div>`;
    }).join('');

    if (progress) {
      progress.textContent = `${unlockedCount} / ${ACHIEVEMENTS.length} achievements unlocked`;
    }
    overlay.classList.remove('hidden');
  }

  // ── Challenges Overlay ────────────────────────────────────────────────────

  function _showChallenges() {
    const overlay = document.getElementById('overlay-challenges');
    if (!overlay) return;

    const dailyKey = _getDailyKey();
    const weeklyKey = _getWeeklyKey();
    const dailyData = _getChallengeData('daily')[dailyKey] || null;
    const weeklyData = _getChallengeData('weekly')[weeklyKey] || null;
    const weeklyMod = _getWeeklyModifier();

    // Determine the element name for purity modifier
    let purityElement = '';
    if (weeklyMod.filter === 'single_element') {
      const elements = [Element.FIRE, Element.ICE, Element.LIGHTNING, Element.EARTH];
      const elem = elements[_getWeeklySeed() % elements.length];
      const ELEM_NAMES = { fire: 'Fire 🔥', ice: 'Ice ❄️', lightning: 'Lightning ⚡', earth: 'Earth 🌿' };
      purityElement = ` (${ELEM_NAMES[elem] || elem})`;
    }

    const grid = overlay.querySelector('#challenges-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="challenge-card daily">
          <div class="challenge-header">
            <span class="challenge-icon">📅</span>
            <span class="challenge-title">Daily Challenge</span>
          </div>
          <div class="challenge-desc">Same 15 waves for every player today.<br>Seed: ${dailyKey}</div>
          <div class="challenge-stats">
            ${dailyData ? `Best: ${dailyData.bestScore} pts · ${dailyData.attempts} attempt${dailyData.attempts !== 1 ? 's' : ''}${dailyData.completed ? ' · ✅ Completed' : ''}` : 'Not attempted yet today'}
          </div>
          <button class="btn btn-fire btn-sm" id="btn-play-daily">▶ Play Daily</button>
        </div>
        <div class="challenge-card weekly">
          <div class="challenge-header">
            <span class="challenge-icon">📆</span>
            <span class="challenge-title">Weekly Challenge</span>
          </div>
          <div class="challenge-desc">
            Modifier: <b>${weeklyMod.icon} ${weeklyMod.name}</b>${purityElement}<br>
            ${weeklyMod.description}<br>Week: ${weeklyKey}
          </div>
          <div class="challenge-stats">
            ${weeklyData ? `Best: ${weeklyData.bestScore} pts · ${weeklyData.attempts} attempt${weeklyData.attempts !== 1 ? 's' : ''}${weeklyData.completed ? ' · ✅ Completed' : ''}` : 'Not attempted yet this week'}
          </div>
          <button class="btn btn-fire btn-sm" id="btn-play-weekly">▶ Play Weekly</button>
        </div>
      `;

      // Wire play buttons
      grid.querySelector('#btn-play-daily')?.addEventListener('click', () => {
        overlay.classList.add('hidden');
        startChallenge('daily');
      });
      grid.querySelector('#btn-play-weekly')?.addEventListener('click', () => {
        overlay.classList.add('hidden');
        startChallenge('weekly');
      });
    }

    overlay.classList.remove('hidden');
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────

  function _showLeaderboard() {
    const overlay = document.getElementById('overlay-leaderboard');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    // Reset to global tab
    document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.lb-tab[data-tab="global"]')?.classList.add('active');
    _loadLeaderboardTab('global');
  }

  async function _loadLeaderboardTab(tab) {
    const el = document.getElementById('leaderboard-content');
    if (!el) return;
    el.innerHTML = '<p class="leaderboard-loading">Loading…</p>';

    if (!Backend.isReady()) {
      el.innerHTML = '<p class="leaderboard-empty">Leaderboards not available — backend not configured.</p>';
      return;
    }

    let result;
    if (tab === 'global') {
      result = await Backend.fetchGlobal();
    } else if (tab === 'daily') {
      result = await Backend.fetchChallenge('daily', _getDailyKey());
    } else if (tab === 'weekly') {
      result = await Backend.fetchChallenge('weekly', _getWeeklyKey());
    } else if (tab === 'personal') {
      result = await Backend.fetchPersonal();
    }

    if (!result?.ok || !result.rows) {
      el.innerHTML = `<p class="leaderboard-empty">${result?.error || 'Failed to load.'}</p>`;
      return;
    }
    if (result.rows.length === 0) {
      el.innerHTML = '<p class="leaderboard-empty">No scores yet. Be the first!</p>';
      return;
    }
    el.innerHTML = _buildLeaderboardTable(result.rows, tab === 'personal');
  }

  function _buildLeaderboardTable(rows, isPersonal) {
    const header = isPersonal
      ? '<tr><th>#</th><th>Score</th><th>Wave</th><th>Mode</th><th>Won</th></tr>'
      : '<tr><th>#</th><th>Name</th><th>Score</th><th>Wave</th><th>Won</th></tr>';
    const body = rows.map((r, i) => {
      const rank = i + 1;
      const cls = rank <= 3 ? ` lb-rank-${rank}` : '';
      if (isPersonal) {
        const mode = r.challenge_type || r.campaign_mode || 'normal';
        return `<tr><td class="lb-rank${cls}">${rank}</td><td class="lb-score">${r.score}</td><td class="lb-wave">W${r.wave_reached}</td><td>${mode}</td><td class="lb-won">${r.won ? '✅' : '❌'}</td></tr>`;
      }
      return `<tr><td class="lb-rank${cls}">${rank}</td><td class="lb-name">${_escapeHTML(r.player_name)}</td><td class="lb-score">${r.score}</td><td class="lb-wave">W${r.wave_reached}</td><td class="lb-won">${r.won ? '✅' : '❌'}</td></tr>`;
    }).join('');
    return `<table class="leaderboard-table"><thead>${header}</thead><tbody>${body}</tbody></table>`;
  }

  function _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Score Submission (from game-over/win overlays) ─────────────────────────

  function _showScoreSubmit(prefix) {
    if (!Backend.isReady()) return;
    const area = document.getElementById(`${prefix}-submit`);
    if (!area) return;
    area.classList.remove('hidden');
    const nameInput = document.getElementById(`${prefix}-name`);
    const savedName = Backend.getPlayerName();
    if (nameInput && savedName) nameInput.value = savedName;
    // Reset status
    const status = document.getElementById(`${prefix}-submit-status`);
    if (status) { status.textContent = ''; status.className = 'submit-status'; }
  }

  async function _submitScoreFromOverlay(prefix) {
    const nameInput = document.getElementById(`${prefix}-name`);
    const status = document.getElementById(`${prefix}-submit-status`);
    const btn = document.getElementById(`btn-${prefix}-submit`);
    if (!nameInput || !status) return;

    const name = nameInput.value.trim();
    if (!name) { status.textContent = 'Enter a name!'; status.className = 'submit-status error'; return; }
    if (!Backend.setPlayerName(name)) { status.textContent = 'Invalid name'; status.className = 'submit-status error'; return; }

    if (btn) btn.disabled = true;
    status.textContent = 'Submitting…'; status.className = 'submit-status';

    const result = await Backend.submitScore({
      score: state.score,
      waveReached: state.wave,
      campaignMode: _campaignMode,
      challengeType: _challengeMode || null,
      challengeKey: _challengeMode === 'daily' ? _getDailyKey() : _challengeMode === 'weekly' ? _getWeeklyKey() : null,
      unitsUsed: state.playerUnits.length,
      won: state.phase === 'win',
    });

    if (result.ok) {
      status.textContent = '✅ Score submitted!'; status.className = 'submit-status success';
      if (btn) btn.disabled = true; // keep disabled after success
    } else {
      status.textContent = result.error || 'Failed'; status.className = 'submit-status error';
      if (btn) btn.disabled = false;
    }
  }

  // ── Patch Notes ───────────────────────────────────────────────────────────

  function _showPatchNotes() {
    const overlay = document.getElementById('overlay-patch-notes');
    const el = document.getElementById('patch-notes-content');
    if (!overlay || !el) return;

    el.innerHTML = (typeof PATCH_NOTES !== 'undefined' ? PATCH_NOTES : []).map(p => `
      <div class="patch-entry">
        <div class="patch-header">
          <span class="patch-version">v${_escapeHTML(p.version)}</span>
          <span class="patch-title">${_escapeHTML(p.title)}</span>
          <span class="patch-date">${_escapeHTML(p.date)}</span>
        </div>
        <ul class="patch-notes-list">
          ${p.notes.map(n => `<li>${_escapeHTML(n)}</li>`).join('')}
        </ul>
      </div>`).join('');

    overlay.classList.remove('hidden');
  }

  // ── Wire up static DOM buttons after DOM load ─────────────────────────────

  function _wireDOMButtons() {
    // Title screen
    document.getElementById('btn-start')?.addEventListener('click', () => { _challengeMode = null; startGame('normal'); });
    document.getElementById('btn-start-void')?.addEventListener('click', () => { _challengeMode = null; startGame('void'); });
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

    // Tutorial toggle (persist to localStorage)
    const tutToggle = document.getElementById('opt-tutorial');
    if (tutToggle) {
      const savedTut = localStorage.getItem('shape_strikers_tutorial');
      if (savedTut !== null) tutToggle.checked = savedTut === '1';
      tutToggle.addEventListener('change', () => {
        localStorage.setItem('shape_strikers_tutorial', tutToggle.checked ? '1' : '0');
      });
    }

    // In-Game Tips toggle (persist to localStorage)
    const tipsToggle = document.getElementById('opt-tips');
    if (tipsToggle) {
      const savedTips = localStorage.getItem('shape_strikers_tips_enabled');
      if (savedTips !== null) tipsToggle.checked = savedTips === '1';
      tipsToggle.addEventListener('change', () => {
        localStorage.setItem('shape_strikers_tips_enabled', tipsToggle.checked ? '1' : '0');
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

    // Achievements overlay
    document.getElementById('btn-achievements')?.addEventListener('click', () => _showAchievements());
    document.getElementById('btn-achievements-hud')?.addEventListener('click', () => _showAchievements());
    document.getElementById('btn-achievements-close')?.addEventListener('click', () => {
      document.getElementById('overlay-achievements')?.classList.add('hidden');
    });

    // Challenges overlay
    document.getElementById('btn-challenges')?.addEventListener('click', () => _showChallenges());
    document.getElementById('btn-challenges-close')?.addEventListener('click', () => {
      document.getElementById('overlay-challenges')?.classList.add('hidden');
    });

    // Leaderboard overlay
    document.getElementById('btn-leaderboard')?.addEventListener('click', () => _showLeaderboard());
    document.getElementById('btn-leaderboard-close')?.addEventListener('click', () => {
      document.getElementById('overlay-leaderboard')?.classList.add('hidden');
    });
    document.querySelectorAll('.lb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _loadLeaderboardTab(btn.dataset.tab);
      });
    });

    // Score submit buttons (game over + win)
    document.getElementById('btn-gameover-submit')?.addEventListener('click', () => _submitScoreFromOverlay('gameover'));
    document.getElementById('btn-win-submit')?.addEventListener('click', () => _submitScoreFromOverlay('win'));

    // Patch notes overlay
    document.getElementById('btn-patch-notes')?.addEventListener('click', () => _showPatchNotes());
    document.getElementById('btn-patch-notes-close')?.addEventListener('click', () => {
      document.getElementById('overlay-patch-notes')?.classList.add('hidden');
    });

    // In-game controls
    document.getElementById('btn-battle')?.addEventListener('click', startBattle);
    document.getElementById('btn-refresh')?.addEventListener('click', () => refreshShop(false));
    document.getElementById('btn-glossary')?.addEventListener('click', () => UI.showGlossary());
    document.getElementById('btn-slots')?.addEventListener('click', _openSlots);
    document.getElementById('btn-quit')?.addEventListener('click', _returnToTitle);

    // Speed buttons
    document.querySelectorAll('.btn-speed').forEach(b => {
      b.addEventListener('click', () => setSpeed(parseFloat(b.dataset.speed)));
    });

    // Result overlay buttons
    document.getElementById('btn-next-wave')?.addEventListener('click', nextWave);
    document.getElementById('btn-gameover-restart')?.addEventListener('click', restart);
    document.getElementById('btn-win-restart')?.addEventListener('click', restart);
    document.getElementById('btn-gameover-menu')?.addEventListener('click', _returnToTitle);
    document.getElementById('btn-win-menu')?.addEventListener('click', _returnToTitle);

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

    // Faction unlock badges
    const factionBadges = [];
    if (localStorage.getItem('shape_strikers_void_unlocked') === '1') {
      factionBadges.push('<span class="unlock-badge void">🌑 Void Unlocked</span>');
    }
    if (localStorage.getItem('shape_strikers_arcane_unlocked') === '1') {
      factionBadges.push('<span class="unlock-badge">✨ Arcane Unlocked</span>');
    }
    if (localStorage.getItem('shape_strikers_void_campaign_cleared') === '1') {
      factionBadges.push('<span class="unlock-badge void">🕳️ Void Conqueror</span>');
    }
    let html = factionBadges.length
      ? factionBadges.join('')
      : '<span style="font-size:11px;color:var(--text-dim)">Complete the game to unlock factions!</span>';

    // Achievement badge row — visual icons for each achievement
    const achievements = _getAchievements();
    const unlockedCount = Object.keys(achievements).length;
    html += '<div class="achievement-badge-row">';
    for (const a of ACHIEVEMENTS) {
      const unlocked = !!achievements[a.id];
      const cls = unlocked ? 'badge-icon unlocked' : 'badge-icon locked';
      const title = unlocked ? `${a.icon} ${a.name}` : '🔒 ???';
      if (a.badge) {
        html += `<div class="${cls}" title="${title}"><img src="${a.badge}" alt="${a.name}"></div>`;
      } else {
        html += `<div class="${cls}" title="${title}"><span>${unlocked ? a.icon : '🔒'}</span></div>`;
      }
    }
    html += '</div>';
    if (unlockedCount > 0) {
      html += `<span class="unlock-badge" style="margin-top:2px">🏅 ${unlockedCount}/${ACHIEVEMENTS.length}</span>`;
    }

    // Challenge status on title screen
    const dailyKey = _getDailyKey();
    const dailyData = _getChallengeData('daily')[dailyKey];
    const weeklyKey = _getWeeklyKey();
    const weeklyData = _getChallengeData('weekly')[weeklyKey];
    if (dailyData?.completed || weeklyData?.completed) {
      let cBadges = '';
      if (dailyData?.completed) cBadges += '<span class="unlock-badge">📅 Daily ✅</span> ';
      if (weeklyData?.completed) cBadges += '<span class="unlock-badge">📆 Weekly ✅</span>';
      html += `<br>${cBadges}`;
    }
    el.innerHTML = html;

    // Show/hide Void Campaign button
    const voidBtn = document.getElementById('btn-start-void');
    if (voidBtn) {
      const unlocked = localStorage.getItem('shape_strikers_void_unlocked') === '1';
      voidBtn.classList.toggle('hidden', !unlocked);
    }
  }

  // ── Tutorial System ───────────────────────────────────────────────────────

  const TUTORIAL_STEPS = [
    { text: '👋 <b>Welcome to Shape Strikers!</b> Your <b>bottom 2 rows</b> are where you place units. Enemies will spawn in the top rows.', highlight: '#grid-area', position: 'right' },
    { text: '🛒 Click a <b>shop card</b> to buy a unit, then click an <b>empty tile</b> in your zone to place it. <b>Right-click</b> a placed unit to sell it back.', highlight: '#shop-units', position: 'top' },
    { text: '⚔️ When ready, press <b>Fight!</b> — your units will auto-battle. Buy more units and upgrades between waves. Good luck!', highlight: '#btn-battle', position: 'top' },
  ];

  let tutorialStep = -1;

  function _startTutorial() {
    if (_challengeMode) return; // skip tutorial for challenges
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
      if (tutorialStep >= TUTORIAL_STEPS.length) {
        // Tutorial completed — default OFF for future games
        const tutToggle = document.getElementById('opt-tutorial');
        if (tutToggle) tutToggle.checked = false;
        localStorage.setItem('shape_strikers_tutorial', '0');
        _unlockAchievement('tutorial_complete');
      }
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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const boxW = Math.min(400, vw - 16); // clamp to viewport
    box.style.position = 'fixed';
    box.style.bottom = 'auto';
    box.style.left = 'auto';
    box.style.transform = 'none';
    box.style.maxWidth = boxW + 'px';

    // On small screens, always center horizontally and place below or above target
    if (vw <= 640) {
      const centerLeft = Math.max(8, (vw - boxW) / 2);
      box.style.left = centerLeft + 'px';
      // Try below target; if no room, go above
      if (rect.bottom + gap + 120 < vh) {
        box.style.top = (rect.bottom + gap) + 'px';
      } else {
        box.style.top = Math.max(8, rect.top - 140 - gap) + 'px';
      }
      return;
    }

    switch (pos) {
      case 'right':
        box.style.top = Math.max(8, rect.top) + 'px';
        box.style.left = Math.min(rect.right + gap, vw - boxW - 8) + 'px';
        break;
      case 'left':
        box.style.top = Math.max(8, rect.top) + 'px';
        box.style.left = Math.max(8, rect.left - boxW - gap) + 'px';
        break;
      case 'top':
        box.style.top = Math.max(8, rect.top - box.offsetHeight - gap) + 'px';
        box.style.left = Math.min(Math.max(8, rect.left + rect.width / 2 - 200), vw - boxW - 8) + 'px';
        break;
      case 'bottom':
      default:
        box.style.top = (rect.bottom + gap) + 'px';
        box.style.left = Math.min(Math.max(8, rect.left + rect.width / 2 - 200), vw - boxW - 8) + 'px';
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

  // ── Contextual Tips ─────────────────────────────────────────────────────

  let _seenTips = {};      // session-only — resets each new game
  let _tipTimer = null;
  let _pendingTipId = null;

  const CONTEXTUAL_TIPS = {
    first_unit_placed: {
      text: '📋 <b>Unit Card!</b> Click any placed unit to see its stats, abilities, and active buffs in the <b>Unit tab</b> on the right.',
      highlight: '#tab-unit',
      position: 'left',
    },
    first_synergy: {
      text: '🔥 <b>Synergy activated!</b> You placed 2+ units of the same element. Matching units get <b>bonus stats</b> — look for the <b>synergy pill</b> and <b>strikethrough → boosted</b> numbers on this unit card!',
      highlight: '#unit-detail',
      position: 'left',
    },
    first_battle: {
      text: '⚔️ <b>Battle started!</b> Units attack automatically. Click any unit during combat to see its <b>live HP, status effects, and damage</b> in real-time.',
      highlight: '#tab-unit',
      position: 'left',
    },
    first_debuff: {
      text: '🔴 <b>Debuff applied!</b> Your unit got a negative status effect. Look for <b>red pills</b> on the unit card — they show what\'s affecting your unit and how long it lasts.',
      highlight: '#tab-unit',
      position: 'left',
    },
    first_buff: {
      text: '🟢 <b>Buff active!</b> Your unit gained a positive effect. <b>Green pills</b> on the unit card show active buffs like shields and barriers.',
      highlight: '#tab-unit',
      position: 'left',
    },
    first_upgrade: {
      text: '⬆️ <b>Upgrade purchased!</b> Upgrade bonuses apply to <b>all your units</b>. Elite Training and Double Edge show as badges on unit cards.',
      highlight: '#upgrade-list',
      position: 'left',
    },
    first_boss: {
      text: '👑 <b>Boss wave incoming!</b> Bosses have <b>multiple phases</b> — when their HP drops to a threshold, they power up. Focus your strongest units!',
      highlight: '#grid-area',
      position: 'right',
    },
    stat_card_explain: {
      text: '📊 <b>Reading the Unit Card</b> — <b>ATK</b> is raw power (reduced by target\'s DEF). <b>Strikethrough</b> numbers show base stats, colored numbers show synergy-boosted values. <b>SPD</b> determines turn order.',
      highlight: '#tab-unit',
      position: 'left',
    },
  };

  function _showContextualTip(tipId) {
    if (_seenTips[tipId]) return;
    if (tutorialStep >= 0) return; // don't overlap with onboarding tutorial
    if (_challengeMode) return;    // skip tips during challenges
    // Respect the In-Game Tips toggle
    const tipsToggle = document.getElementById('opt-tips');
    if (tipsToggle && !tipsToggle.checked) return;

    const tip = CONTEXTUAL_TIPS[tipId];
    if (!tip) return;

    // If another tip is pending, don't cancel it — skip this one instead
    if (_pendingTipId && _pendingTipId !== tipId) return;

    // Pause battle if one is running so the player isn't rushed
    // Note: we check & pause both now AND inside the timeout, because
    // some tips fire before battle.start() and the battle begins during the delay.
    if (battle && battle._running) battle.pause();

    _pendingTipId = tipId;
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(() => {
      _seenTips[tipId] = true;
      _pendingTipId = null;

      // Ensure battle is paused when the overlay actually appears
      const battleActive = battle && battle._running;
      if (battleActive) battle.pause();

      const overlay = document.getElementById('overlay-tutorial');
      const content = document.getElementById('tutorial-content');
      const progress = document.getElementById('tutorial-progress');
      const tutorialBox = document.getElementById('tutorial-box');
      const nextBtn = document.getElementById('btn-tutorial-next');
      const skipBtn = document.getElementById('btn-tutorial-skip');

      if (!overlay || !content) return;

      content.innerHTML = tip.text;
      progress.textContent = '💡 Tip';
      if (nextBtn) nextBtn.textContent = 'Got it! ✓';
      if (skipBtn) skipBtn.textContent = 'Don\'t show tips';

      overlay.classList.remove('hidden');

      _clearTutorialHighlight();
      if (tip.highlight) {
        const target = document.querySelector(tip.highlight);
        if (target && tutorialBox) {
          target.classList.add('tutorial-spotlight');
          tutorialBox.removeAttribute('style');
          const rect = target.getBoundingClientRect();
          const pos = tip.position || 'bottom';
          tutorialBox.dataset.position = pos;
          _positionTutorialBox(tutorialBox, rect, pos);
        }
      }

      // Override buttons for contextual tips
      const _dismiss = () => {
        overlay.classList.add('hidden');
        _clearTutorialHighlight();
        nextBtn?.removeEventListener('click', nextHandler);
        skipBtn?.removeEventListener('click', disableHandler);
        nextBtn?.addEventListener('click', _nextTutorialStep);
        skipBtn?.addEventListener('click', _skipTutorial);
        if (nextBtn) nextBtn.textContent = 'Next →';
        if (skipBtn) skipBtn.textContent = 'Skip Tutorial';
        // Resume battle if we paused it
        if (battle && battle._paused) battle.resume();
      };
      const nextHandler = () => _dismiss();
      const disableHandler = () => {
        // Uncheck the In-Game Tips toggle so tips stay off
        const toggle = document.getElementById('opt-tips');
        if (toggle) { toggle.checked = false; localStorage.setItem('shape_strikers_tips_enabled', '0'); }
        _dismiss();
      };

      // Temporarily replace button handlers
      nextBtn?.removeEventListener('click', _nextTutorialStep);
      skipBtn?.removeEventListener('click', _skipTutorial);
      nextBtn?.addEventListener('click', nextHandler);
      skipBtn?.addEventListener('click', disableHandler);
    }, 600);
  }

  // ── Fortune Spinner (Slot Machine) — Under Construction ────────────────────

  function _openSlots() {
    UI.showMessage('🚧 Fortune Spinner is under construction — coming soon!');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    preloadSprites(); // fire-and-forget — sprites ready before user enters game
    preloadSlashSprites(); // melee slash animation frames
    Audio.init();
    Backend.init(); // fire-and-forget — leaderboards degrade gracefully
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
    startChallenge,
    restart,
    refreshShop,
    startBattle,
    nextWave,
    buyUpgrade,
    setSpeed,
    getRefreshCost,
    showAchievements: _showAchievements,
    showChallenges: _showChallenges,
    showLeaderboard: _showLeaderboard,
    showPatchNotes: _showPatchNotes,
    get state() { return state; },
  };
})();

// Boot when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', Game.init);
} else {
  Game.init();
}
