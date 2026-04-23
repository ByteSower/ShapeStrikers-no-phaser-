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
  let _keydownHandler = null;    // stored ref to remove on restart (prevent listener leak)
  let _lastBattleHadBoss = false; // track boss waves to restore gameplay BGM after boss fight
  let _mpMode = false;                 // true while inside a multiplayer match
  let _mpDisconnectReconnectFn = null; // saved reconnect handler ref to prevent accumulation
  // Battle pause / sync hold — set when opponent drops during battle phase.
  // Host defers MultiplayerGame.endRound() until opponent reconnects.
  // Guest suspends the 9s fallback timeout so a late re-broadcast can still be applied.
  let _mpOpponentOfflineDuringBattle = false;
  let _mpHeldRoundAdvanceFn  = null;      // host: deferred endRound call, released on reconnect
  let _mpGuestExtendResultTimeout = () => {}; // guest: per-round fn to suspend result timer
  let _mpLastBattleReplay = null;         // host: latest shared battle replay log
  let _mpLastBattleReplayPayload = null;  // host: latest battle_replay room payload
  let _mpLastPhaseEventPayload = null;    // host: latest phase_event room payload
  let _mpLastPlaybackCheckpoint = null;   // host: latest playback_checkpoint room payload
  let _mpReplayPlayer = null;
  let _mpReplayUnitsById = Object.create(null);
  let _mpRoomWatchTimer = null;
  let _mpLastRoomWatchState = 'closed';
  let _mpReconnectAttemptTimer = null;
  let _mpGuestResumeReplay = () => false;

  const MP_PHASE_EVENTS = Object.freeze({
    PREP_END: 'prep_end',
    BATTLE_SCRIPT_READY: 'battle_script_ready',
    PLAYBACK_START: 'playback_start',
    RESULT_SHOW: 'result_show',
  });

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
    if (def) {
      UI.showMessage(`🏅 Achievement Unlocked: ${def.icon} ${def.name}!`, 3000);
      Audio.play('objective');
    }
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
    // Full Army: all 12 player grid slots filled (6 cols × 2 player rows)
    if (state.playerUnits.length >= 12) _unlockAchievement('full_army');
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
    // Synergies now buff ALL player units — return every active synergy regardless of this unit's element.
    // The element filter is only used to pick WHICH synergies are triggered (need 2+ of that element).
    const counts = {};
    for (const u of state.playerUnits) counts[u.definition.element] = (counts[u.definition.element] || 0) + 1;
    const byKey = {};
    for (const syn of ELEMENT_SYNERGIES) {
      if ((counts[syn.element] || 0) >= syn.requiredCount) {
        byKey[syn.element + ':' + syn.bonus.stat] = syn; // highest tier wins per element+stat
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
      // Tier weights scale with wave so T2/T3 feel accessible as soon as they unlock.
      // maxTier already gates availability; these weights just control the distribution
      // within what's allowed: T2 favoured from wave 4, T3 grows from wave 7.
      let w1, w2, w3;
      if (maxTier === 1)      { w1 = 100; w2 = 0;  w3 = 0; }
      else if (maxTier === 2) { w1 = 45;  w2 = 55; w3 = 0; }  // waves 4–6
      else                    { w1 = 25;  w2 = 45; w3 = 30; } // waves 7+
      const weights = { 1: w1, 2: w2, 3: w3 };
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
      state.selectedUnit = unit;
      Grid.placeUnit(unit, targetRow, col);
      Grid.updateUpgradeIcons(targetRow, col, state.upgradeLevels);
      Grid.clearHighlights();
      Grid.clearSelection();
      Grid.selectTile(targetRow, col);
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
      UI.showMessage(`${clickedUnit.definition.name} — Click again to deselect | Right-click or use Sell Unit to sell | Click empty tile to move`);
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

        // Special: Void Campaign W15 boss — buff final phase HP to 1000
        if (_campaignMode === 'void' && def.id === 'boss_chaos_overlord' && !scaling) {
          enemy.definition = Object.assign({}, def, {
            bossPhases: def.bossPhases.map((p, i, arr) =>
              i === arr.length - 1 ? { ...p, phaseHp: 1000 } : p
            ),
          });
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

    const hasBoss = enemies.some(e => e.definition.isBoss);
    _lastBattleHadBoss = hasBoss;
    if (hasBoss) {
      Audio.play('enemySpotted');
      Audio.playBossMusic();
    }

    // Contextual tips
    _showContextualTip('first_battle');
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
    document.getElementById('btn-slots')?.remove(); // btn-slots removed; guard for safety
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
    _inspectedUnit = null;
    // Route to MP handler when in multiplayer mode.
    // NOTE: do NOT null `battle` yet — _mpHandleRoundEnd needs it to compute boardHash.
    if (_mpMode) { _mpHandleRoundEnd(playerWon); battle = null; return; }
    battle = null;
    // Upgrade stat buffs are permanent — no post-battle removal

    if (playerWon) {
      Audio.play('waveClear');
      if (_lastBattleHadBoss) Audio.playGameplayMusic();
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

  // ── Multiplayer Replay Playback ─────────────────────────────────────────

  function _mpResetReplayUnits() {
    _mpReplayUnitsById = Object.create(null);
  }

  function _mpLookupDefinition(defId) {
    if (typeof UNIT_MAP !== 'undefined' && defId && UNIT_MAP[defId]) return UNIT_MAP[defId];
    if (typeof UNIT_DEFINITIONS !== 'undefined' && Array.isArray(UNIT_DEFINITIONS)) {
      return UNIT_DEFINITIONS.find(def => def.id === defId) || null;
    }
    return null;
  }

  function _mpShouldMirrorReplayView() {
    if (!_mpMode || typeof Room === 'undefined' || typeof Room.isHost !== 'function') return false;
    return !Room.isHost();
  }

  function _mpMapReplayRow(row) {
    if (!_mpShouldMirrorReplayView()) return row;
    return (GRID_CONFIG.rows - 1) - row;
  }

  function _mpMapReplaySnapshot(snapshot) {
    if (!snapshot) return snapshot;
    if (!_mpShouldMirrorReplayView()) return snapshot;
    return {
      ...snapshot,
      row: _mpMapReplayRow(snapshot.row),
      isEnemy: !snapshot.isEnemy,
    };
  }

  function _mpSyncReplayUnit(snapshot) {
    if (!snapshot || !snapshot.id) return null;

    const viewSnapshot = _mpMapReplaySnapshot(snapshot);

    const existing = _mpReplayUnitsById[snapshot.id] || {};
    const definition = _mpLookupDefinition(viewSnapshot.defId) || existing.definition || {
      id: viewSnapshot.defId,
      name: viewSnapshot.name || viewSnapshot.defId || 'Unit',
      element: 'fire',
      stats: { ...(viewSnapshot.stats || {}) },
    };

    const unit = Object.assign(existing, {
      id: viewSnapshot.id,
      name: viewSnapshot.name || definition.name,
      definition,
      hp: viewSnapshot.hp,
      maxHp: viewSnapshot.maxHp,
      stats: { ...(viewSnapshot.stats || {}) },
      statusEffects: (viewSnapshot.statusEffects || []).map(eff => ({ ...eff })),
      abilityCooldown: viewSnapshot.abilityCooldown || 0,
      isEnemy: !!viewSnapshot.isEnemy,
      row: viewSnapshot.row,
      col: viewSnapshot.col,
    });

    _mpReplayUnitsById[snapshot.id] = unit;
    return unit;
  }

  function _mpClearBattleGridForReplay() {
    if (typeof Grid === 'undefined') return;
    for (let r = 0; r < GRID_CONFIG.rows; r++) {
      for (let c = 0; c < GRID_CONFIG.cols; c++) {
        Grid.removeUnitFromTile(r, c);
      }
    }
    document.querySelectorAll('.dmg-float, .ability-float, .heal-particle, .elem-particle, .projectile, [class^="vfx-"]').forEach(el => el.remove());
  }

  function _mpPlaceReplayUnit(snapshot) {
    const unit = _mpSyncReplayUnit(snapshot);
    if (!unit) return null;
    Grid.placeUnit(unit, unit.row, unit.col);
    Grid.updateUnitHp(unit.row, unit.col, unit.hp, unit.maxHp);
    Grid.updateStatusIcons(unit.row, unit.col, unit.statusEffects);
    Grid.updateStatusAuras(unit.row, unit.col, unit.statusEffects);
    return unit;
  }

  function _mpRenderReplayStart(evt) {
    _mpResetReplayUnits();
    _mpClearBattleGridForReplay();
    UI.clearLog();
    state.phase = 'battle';
    _refreshHUD();

    for (const unit of (evt.playerUnits || [])) _mpPlaceReplayUnit(unit);
    for (const unit of (evt.enemyUnits || [])) _mpPlaceReplayUnit(unit);
  }

  function _mpRenderReplayStatusChange(unit) {
    Grid.updateStatusIcons(unit.row, unit.col, unit.statusEffects);
    Grid.updateStatusAuras(unit.row, unit.col, unit.statusEffects);
  }

  function _mpRenderReplayHit(target, dmg, element) {
    if (dmg > 0) {
      Grid.animateHit(target.row, target.col);
      Audio.play('hit');
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
      VFX.healSingle(target.row, target.col);
    }

    Grid.updateUnitHp(target.row, target.col, target.hp, target.maxHp);
    const elemColor = element ? ELEMENT_COLORS[element] : null;
    Grid.animateDamageNumber(target.row, target.col, dmg, elemColor);
  }

  function _mpRenderReplayDeath(unit) {
    Audio.play(unit.isEnemy ? 'enemyDeath' : 'death');
    delete _mpReplayUnitsById[unit.id];
    Grid.animateDeath(unit.row, unit.col);
  }

  function _mpExtractReplayLog(replaySource) {
    if (replaySource && Array.isArray(replaySource.events)) return replaySource;
    if (replaySource && replaySource.replayLog && Array.isArray(replaySource.replayLog.events)) return replaySource.replayLog;
    return null;
  }

  function _mpExtractReplayHostWon(replaySource) {
    if (replaySource && typeof replaySource.hostWon === 'boolean') return replaySource.hostWon;
    const replayLog = _mpExtractReplayLog(replaySource);
    const endEvt = replayLog?.events?.find(evt => evt.type === 'battle_end');
    return endEvt ? !!endEvt.playerWon : null;
  }

  function _mpGetCurrentRoundNumber() {
    if (typeof MultiplayerGame !== 'undefined' && typeof MultiplayerGame.getRound === 'function') {
      return MultiplayerGame.getRound();
    }
    return state?.wave || 0;
  }

  function _mpEmitPhaseEvent(type, extra = {}) {
    const payload = {
      type,
      roundNumber: _mpGetCurrentRoundNumber(),
      at: Date.now(),
      ...extra,
    };
    _mpLastPhaseEventPayload = payload;
    if (typeof Room !== 'undefined') Room.syncState('phase_event', payload);
    return payload;
  }

  function _mpEmitPlaybackCheckpoint(seq, turn, extra = {}) {
    const payload = {
      roundNumber: _mpGetCurrentRoundNumber(),
      seq: Math.max(0, Number(seq) || 0),
      turn: Math.max(0, Number(turn) || 0),
      at: Date.now(),
      ...extra,
    };
    _mpLastPlaybackCheckpoint = payload;
    if (typeof Room !== 'undefined') Room.syncState('playback_checkpoint', payload);
    return payload;
  }

  async function _mpPlayReplayLog(replaySource, options = {}) {
    const replayLog = _mpExtractReplayLog(replaySource);
    if (!replayLog || !Array.isArray(replayLog.events) || replayLog.events.length === 0) {
      UI.showMessage('No multiplayer replay captured yet.', 1500);
      return null;
    }
    if (typeof BattleReplay === 'undefined') {
      UI.showMessage('BattleReplay module is unavailable.', 1500);
      return null;
    }

    if (_mpReplayPlayer && _mpReplayPlayer.isPlaying()) {
      _mpReplayPlayer.stop();
    }

    _mpReplayPlayer = BattleReplay.createPlayer();
    if (options.startMessage) UI.showMessage(options.startMessage, 1200);

    let finalEvent = null;
    await _mpReplayPlayer.play(replayLog, {
      onBattleStart: (evt) => {
        _mpRenderReplayStart(evt);
        if (typeof options.onBattleStart === 'function') options.onBattleStart(evt);
      },
      onTurnStart: (evt) => {
        if (typeof options.onTurnStart === 'function') options.onTurnStart(evt);
      },
      onUnitAttack: (evt) => {
        const attacker = _mpSyncReplayUnit(evt.attacker);
        const target = _mpSyncReplayUnit(evt.target);
        _onUnitAttack(attacker, target);
      },
      onAbilityUsed: (evt) => {
        const unit = _mpSyncReplayUnit(evt.unit);
        _onAbilityUsed(unit, evt.abilityName);
      },
      onUnitMove: (evt) => {
        const unit = _mpSyncReplayUnit(evt.unit);
        _onUnitMove(unit, _mpMapReplayRow(evt.fromRow), evt.fromCol, _mpMapReplayRow(evt.toRow), evt.toCol);
      },
      onStatusChange: (evt) => {
        const unit = _mpSyncReplayUnit(evt.unit);
        _mpRenderReplayStatusChange(unit);
      },
      onUnitHit: (evt) => {
        const target = _mpSyncReplayUnit(evt.target);
        _mpRenderReplayHit(target, evt.damage, evt.element);
      },
      onUnitDeath: (evt) => {
        const unit = _mpSyncReplayUnit(evt.unit);
        _mpRenderReplayDeath(unit);
      },
      onPhaseChange: (evt) => {
        const boss = _mpSyncReplayUnit(evt.boss);
        _onPhaseChange(boss, evt.phaseName, evt.description);
      },
      onSynergyActivated: (evt) => {
        Grid.animateSynergyPulse(Object.values(_mpReplayUnitsById), evt.element);
      },
      onBattleEnd: (evt) => {
        finalEvent = evt;
        if (typeof options.onBattleEnd === 'function') options.onBattleEnd(evt);
        else if (options.showCompleteMessage !== false) UI.showMessage(evt.playerWon ? 'Replay complete: victory' : 'Replay complete: defeat', 1500);
      },
      waitForAnimations: () => Grid.waitForAnimations(),
    }, {
      turnDelay: options.turnDelay ?? 120,
      startSeq: options.startSeq ?? 0,
    });

    return finalEvent;
  }

  function _mpCloneBattleUnit(unit) {
    return {
      id: unit.id,
      name: unit.name,
      definition: unit.definition,
      hp: unit.hp,
      maxHp: unit.maxHp,
      stats: { ...unit.stats },
      statusEffects: (unit.statusEffects || []).map(eff => ({ ...eff })),
      abilityCooldown: unit.abilityCooldown || 0,
      isEnemy: !!unit.isEnemy,
      row: unit.row,
      col: unit.col,
    };
  }

  function _mpStampStableUnitKeys(playerUnits, enemies, oppData) {
    if (typeof UnitKeys === 'undefined') return;
    const myId  = (typeof Backend !== 'undefined' && Backend.getUserId()) || 'local';
    const oppId = (typeof Room    !== 'undefined' && Room.getOpponentId()) || 'remote';
    for (const u of playerUnits) {
      UnitKeys.stampUnit(u, myId);
    }
    for (let i = 0; i < enemies.length; i++) {
      const origRow = (oppData[i] && oppData[i].row != null) ? oppData[i].row : enemies[i].row;
      enemies[i].id = UnitKeys.makeUnitKey(oppId, enemies[i].definition.id, origRow, enemies[i].col);
    }
  }

  function _mpGenerateBattleReplayPayload(oppData) {
    const simPlayers = state.playerUnits.map(_mpCloneBattleUnit);
    const simEnemies = _buildPVPEnemies(oppData, { placeOnGrid: false, writeState: false });
    _mpStampStableUnitKeys(simPlayers, simEnemies, oppData);

    const simBattle = new BattleSystem();
    simBattle.setSeed(MultiplayerGame.getBattleSeed());
    simBattle.enableReplayRecording(true);
    simBattle.setScheduler((fn) => { fn(); return 0; }, () => {});
    simBattle.start(simPlayers, simEnemies);

    const replayLog = simBattle.getReplayLog();
    const hostWon = _mpExtractReplayHostWon(replayLog);
    const boardHash = (typeof HashUtils !== 'undefined')
      ? HashUtils.hashState([...(simBattle._playerUnits || []), ...(simBattle._enemyUnits || [])]).toString()
      : null;

    return {
      roundNumber: MultiplayerGame.getRound(),
      hostWon,
      boardHash,
      replayLog,
    };
  }

  function _mpApplyReplayOutcomeToState(replaySource) {
    const replayLog = _mpExtractReplayLog(replaySource);
    const endEvt = replayLog?.events?.find(evt => evt.type === 'battle_end');
    if (!endEvt || typeof MultiplayerGame === 'undefined') return;

    const localSnapshots = MultiplayerGame.isHost()
      ? (endEvt.playerUnits || [])
      : (endEvt.enemyUnits || []);
    const byId = new Map(localSnapshots.map(snapshot => [String(snapshot.id), snapshot]));

    state.playerUnits = state.playerUnits.filter(unit => {
      const snapshot = byId.get(String(unit.id));
      if (!snapshot || snapshot.hp <= 0) return false;
      unit.hp = Math.min(unit.maxHp, snapshot.hp);
      unit.statusEffects = [];
      unit.abilityCooldown = 0;
      return true;
    });

    state.enemyUnits = [];
  }

  async function _playLastMpReplay() {
    const finalEvent = await _mpPlayReplayLog(_mpLastBattleReplay, {
      startMessage: 'Replaying last shared multiplayer battle...',
      showCompleteMessage: true,
      turnDelay: 120,
    });
    return !!finalEvent;
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
    // btn-slots (Gamble) removed — no-op guard below keeps old callers safe
    document.getElementById('btn-slots');
    Audio.play('getReady');
    // Show speed controls tip after the first battle to help new players discover it
    if (state.wave === 2) _showContextualTip('speed_controls');
  }

  // ── Game Over / Win ───────────────────────────────────────────────────────

  function _handleGameOver() {
    state.phase = 'gameover';
    Audio.stopMusic();
    Audio.play('gameOver');
    Audio.playAfter('cry', 1500);
    if (!_challengeMode) {
      const bestKey = `shape_strikers_best_score_${_campaignMode}`;
      const prevBest = parseInt(localStorage.getItem(bestKey) || '0', 10);
      if (state.score > 0 && state.score > prevBest) {
        localStorage.setItem(bestKey, String(state.score));
        Audio.play('newHighScore');
      }
    }
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
    Audio.stopMusic();
    Audio.play('letsGo');
    if (!_challengeMode) {
      const bestKey = `shape_strikers_best_score_${_campaignMode}`;
      const prevBest = parseInt(localStorage.getItem(bestKey) || '0', 10);
      if (state.score > 0 && state.score > prevBest) {
        localStorage.setItem(bestKey, String(state.score));
        Audio.play('newHighScore');
      }
    }
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
    Audio.playGameplayMusic();

    // Set campaign mode (default to normal)
    _campaignMode = (campaignMode === 'void') ? 'void' : 'normal';
    WaveGenerator.setVoidCampaign(_campaignMode === 'void');
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
    _seenTips = {};          // reset contextual tips each run (display only)
    _tutorialStepsDone = localStorage.getItem('shape_strikers_tutorial_done') === '1';
    if (_tutorialStepsDone) _checkTutorialAchievement(); // retroactive unlock for returning players
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

    // Keyboard shortcuts — attach once, remove old listener to prevent leak on restart
    if (_keydownHandler) document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = (e) => {
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
    };
    document.addEventListener('keydown', _keydownHandler);
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
    // btn-slots removed; intentional no-op
    _updateRefreshBtn();

    // Pre-generate wave 1 for preview
    _currentWaveDef = WaveGenerator.generate(state.wave);
    _updateWavePreview();

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
    Audio.playMusic('ss_title_music_full.wav');
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
      result = await Backend.fetchGlobal(10);
    } else if (tab === 'normal') {
      result = await Backend.fetchByMode('normal', 10);
    } else if (tab === 'void') {
      result = await Backend.fetchByMode('void', 10);
    } else if (tab === 'daily') {
      result = await Backend.fetchChallenge('daily', _getDailyKey(), 10);
    } else if (tab === 'weekly') {
      result = await Backend.fetchChallenge('weekly', _getWeeklyKey(), 10);
    } else if (tab === 'personal') {
      result = await Backend.fetchPersonal(10);
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
    const TROPHIES = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const header = isPersonal
      ? '<tr><th>#</th><th>Score</th><th>Wave</th><th>Mode</th><th>Won</th></tr>'
      : '<tr><th>#</th><th>Name</th><th>Score</th><th>Wave</th><th>Won</th></tr>';
    const body = rows.map((r, i) => {
      const rank = i + 1;
      const trophy = TROPHIES[rank] || '';
      const rankDisplay = trophy ? `${trophy}` : `#${rank}`;
      const cls = rank <= 3 ? ` lb-rank-${rank}` : '';
      if (isPersonal) {
        const mode = r.challenge_type || r.campaign_mode || 'normal';
        return `<tr><td class="lb-rank${cls}">${rankDisplay}</td><td class="lb-score">${r.score}</td><td class="lb-wave">W${r.wave_reached}</td><td>${mode}</td><td class="lb-won">${r.won ? '✅' : '❌'}</td></tr>`;
      }
      const nameClass = rank === 1 ? 'lb-name lb-name-gold' : 'lb-name';
      return `<tr><td class="lb-rank${cls}">${rankDisplay}</td><td class="${nameClass}">${_escapeHTML(r.player_name)}</td><td class="lb-score">${r.score}</td><td class="lb-wave">W${r.wave_reached}</td><td class="lb-won">${r.won ? '✅' : '❌'}</td></tr>`;
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
    // Re-enable submit button (may have been disabled from a previous game)
    const btn = document.getElementById(`btn-${prefix}-submit`);
    if (btn) btn.disabled = false;
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
    document.getElementById('btn-mp-reconnect')?.addEventListener('click', () => {
      const statusEl = document.getElementById('mp-reconnect-status');
      const btn = document.getElementById('btn-mp-reconnect');
      if (typeof Room === 'undefined' || typeof Room.reconnect !== 'function') {
        if (statusEl) statusEl.textContent = 'Reconnect unavailable.';
        return;
      }

      const started = Room.reconnect();
      if (!started) {
        if (statusEl) statusEl.textContent = 'No active room to reconnect.';
        return;
      }

      _clearMPReconnectAttemptTimer();
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Reconnecting…';
      }
      if (statusEl) {
        statusEl.dataset.source = 'manual';
        statusEl.textContent = 'Retrying room subscription…';
      }
      _mpUpdateConnIndicator('reconnecting');

      let checks = 0;
      _mpReconnectAttemptTimer = setInterval(() => {
        checks++;
        const roomState = Room.getConnectionState?.() || 'closed';
        if (roomState === 'SUBSCRIBED') {
          _clearMPReconnectAttemptTimer();
          if (btn) {
            btn.disabled = false;
            btn.textContent = '✅ Connected';
          }
          if (statusEl) {
            statusEl.dataset.source = 'manual';
            statusEl.textContent = 'Room connection restored.';
          }
          _mpUpdateConnIndicator('connected');
          setTimeout(() => _syncMPReconnectBanner(), 1200);
          return;
        }
        if (checks >= 20) {
          _clearMPReconnectAttemptTimer();
          if (btn) {
            btn.disabled = false;
            btn.textContent = '🔄 Retry';
          }
          if (statusEl) {
            statusEl.dataset.source = 'poll';
            statusEl.textContent = `Still disconnected (${roomState.toLowerCase().replace(/_/g, ' ')}).`;
          }
        }
      }, 300);
    });
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
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      if (_mpMode && typeof MultiplayerGame !== 'undefined') {
        // MP reroll: deduct gold, use seeded RNG, broadcast to opponent
        const cost = getRefreshCost();
        if (state.gold < cost) { UI.showMessage('Not enough gold to reroll!'); return; }
        state.gold -= cost;
        const pool = _mpBuildPool();
        const units = MultiplayerGame.doReroll(pool, 5);
        if (units) {
          state.shopUnits = units;
          state.selectedShopIdx = null;
          Grid.clearSelection();
          UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
          _refreshHUD();
        }
      } else {
        refreshShop(false);
      }
    });
    document.getElementById('btn-glossary')?.addEventListener('click', () => UI.showGlossary());
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
    { text: '�️ The grid has <b>3 zones</b>:<br>👾 <b>Top 2 rows (red)</b> — enemy territory<br>⚡ <b>Middle row (gold)</b> — the Battle Line where fights happen<br>⚔️ <b>Bottom 2 rows (blue)</b> — your territory<br><br>Units advance to the Battle Line but <b>cannot cross into enemy territory!</b>', highlight: '#grid-labels-left', position: 'right' },
    { text: '�🛒 Click a <b>shop card</b> to buy a unit, then click an <b>empty tile</b> in your zone to place it. <b>Right-click</b> a placed unit to sell it back.', highlight: '#shop-units', position: 'top' },
    { text: '⚔️ When ready, press <b>Fight!</b> — your units will auto-battle. Buy more units and upgrades between waves. Good luck!', highlight: '#btn-battle', position: 'top' },
  ];

  let tutorialStep = -1;
  let _tutorialStepsDone = false;

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
        _tutorialStepsDone = true;
        localStorage.setItem('shape_strikers_tutorial_done', '1');
        _checkTutorialAchievement();
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
      // Scroll the target into view first so the user can see it
      const target = document.querySelector('.tutorial-spotlight');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    speed_controls: {
      text: '⚡ <b>Speed Controls!</b> Use the <b>½× / 1× / 2× / 4×</b> buttons to change battle speed — or press keys <b>1–4</b>. Crank it up once you\'re comfortable!',
      highlight: '#speed-controls',
      position: 'top',
    },
  };

  function _checkTutorialAchievement() {
    if (!_tutorialStepsDone) return;
    _unlockAchievement('tutorial_complete');
  }

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
      _checkTutorialAchievement();
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

  // ── Multiplayer (Presence + Chat) ─────────────────────────────────────────

  function _initMultiplayer() {
    // SupabaseClient polls until Backend is ready, then connects all channels.
    if (typeof SupabaseClient !== 'undefined') SupabaseClient.init();

    // Presence — online player count on title screen
    if (typeof Presence !== 'undefined') {
      const countEl = document.getElementById('online-count');
      Presence.onCountChange((count) => {
        if (countEl) countEl.textContent = `🟢 Players Online: ${count}`;
      });
      Presence.init();
    }

    // Chat — register channel and wire UI
    if (typeof GlobalChat !== 'undefined') {
      GlobalChat.init();
      _initChatUI();
    }

    // Matchmaking — init channel and wire lobby UI
    if (typeof Matchmaking !== 'undefined') Matchmaking.init();
    if (typeof Room !== 'undefined') {} // Room inits on-demand when match found
    _initMPLobbyUI();
    _initMPDebugOverlay();
  }

  function _initMPLobbyUI() {
    const overlay    = document.getElementById('mp-lobby-overlay');
    const statusEl   = document.getElementById('mp-status');
    const badgeEl    = document.getElementById('mp-connection-badge');
    const nameEl     = document.getElementById('mp-player-name-display');
    const findBtn    = document.getElementById('btn-mp-find-match');
    const cancelBtn  = document.getElementById('btn-mp-cancel');
    const closeBtn   = document.getElementById('btn-mp-lobby-close');
    const openBtn    = document.getElementById('btn-find-match');

    if (!overlay) return;

    // ── Open lobby ───────────────────────────────────────────────────────
    openBtn?.addEventListener('click', () => {
      overlay.classList.remove('hidden');
      // Show player name from backend or localStorage
      const pname = (typeof Backend !== 'undefined' && Backend.getPlayerName())
        || localStorage.getItem('shape_strikers_player_name')
        || 'Anonymous';
      if (nameEl) nameEl.textContent = `Playing as: ${pname}`;
      _mpUpdateConnectionBadge();
    });

    // ── Close lobby ──────────────────────────────────────────────────────
    closeBtn?.addEventListener('click', () => {
      if (typeof Matchmaking !== 'undefined' && Matchmaking.isSearching()) Matchmaking.leaveQueue();
      overlay.classList.add('hidden');
      _mpSetStatus('Ready to search', '');
      if (findBtn)   findBtn.style.display  = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
    });

    // ── Find match ────────────────────────────────────────────────────────
    findBtn?.addEventListener('click', () => {
      if (typeof Matchmaking === 'undefined') {
        _mpSetStatus('Matchmaking unavailable', 'error');
        return;
      }
      const channelStatus = (typeof SupabaseClient !== 'undefined' && typeof SupabaseClient.getChannelStatus === 'function')
        ? SupabaseClient.getChannelStatus('matchmaking:queue')
        : 'pending';
      Matchmaking.joinQueue();
      _mpSetStatus(channelStatus === 'SUBSCRIBED' ? 'Searching for opponent…' : 'Connecting to matchmaking…', 'searching');
      if (findBtn)   findBtn.style.display  = 'none';
      if (cancelBtn) cancelBtn.style.display = '';
    });

    // ── Cancel search ─────────────────────────────────────────────────────
    cancelBtn?.addEventListener('click', () => {
      if (typeof Matchmaking !== 'undefined') Matchmaking.leaveQueue();
      _mpSetStatus('Ready to search', '');
      if (findBtn)   findBtn.style.display  = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
    });

    // ── Match found ───────────────────────────────────────────────────────
    if (typeof Matchmaking !== 'undefined') {
      Matchmaking.onMatchFound(({ roomId, opponentId, isHost }) => {
        // Guard: if a match is already active (e.g. mid-cleanup from a previous one), ignore.
        // This prevents double-fire from stale Matchmaking listeners accumulated across sessions.
        if (_mpMode) {
          console.warn('[MP] onMatchFound fired while _mpMode=true — ignoring (stale listener or double-fire).');
          return;
        }

        _mpSetStatus(`✅ Match found!`, 'matched');
        if (findBtn)   findBtn.style.display  = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';

        // Join the room channel
        if (typeof Room !== 'undefined') {
          Room.join(roomId, isHost, opponentId);
          Room.onOpponentDisconnect(() => _mpHandleDisconnect());
          Room.onReconnect(() => {
            _mpUpdateConnIndicator('connected');
            // Clear battle-pause flag so normal flow resumes.
            const wasPaused = _mpOpponentOfflineDuringBattle;
            _mpOpponentOfflineDuringBattle = false;

            if (isHost && _mpLastBattleReplayPayload) {
              console.info(`[MP:R${_mpLastBattleReplayPayload.roundNumber}] Opponent reconnected — re-broadcasting battle_replay.`);
              Room.syncState('battle_replay', _mpLastBattleReplayPayload);
            }
            if (isHost && _mpLastPlaybackCheckpoint && _mpLastPhaseEventPayload?.type === MP_PHASE_EVENTS.PLAYBACK_START) {
              console.info(`[MP:R${_mpLastPlaybackCheckpoint.roundNumber}] Opponent reconnected — re-broadcasting playback_checkpoint seq=${_mpLastPlaybackCheckpoint.seq}.`);
              Room.syncState('playback_checkpoint', _mpLastPlaybackCheckpoint);
            }
            if (isHost && _mpLastPhaseEventPayload) {
              const phasePayload = (_mpLastPhaseEventPayload.type === MP_PHASE_EVENTS.PLAYBACK_START && _mpLastPlaybackCheckpoint)
                ? {
                    ..._mpLastPhaseEventPayload,
                    checkpointSeq: _mpLastPlaybackCheckpoint.seq,
                    checkpointTurn: _mpLastPlaybackCheckpoint.turn,
                    resumed: true,
                  }
                : _mpLastPhaseEventPayload;
              _mpLastPhaseEventPayload = phasePayload;
              console.info(`[MP:R${phasePayload.roundNumber}] Opponent reconnected — re-broadcasting phase_event ${phasePayload.type}.`);
              Room.syncState('phase_event', phasePayload);
            }
            // If we are the HOST and have already broadcast a round_result this round,
            // re-send it immediately — the guest may have missed it during their reconnect.
            if (isHost && _mpLastRoundResultPayload) {
              console.info(`[MP:R${_mpLastRoundResultPayload.roundNumber}] Opponent reconnected — re-broadcasting last round_result.`);
              Room.syncState('round_result', _mpLastRoundResultPayload);
            }
            // If host was holding round advancement (battle finished while guest was offline),
            // release it now that the guest is back.
            if (isHost && _mpHeldRoundAdvanceFn) {
              console.info('[MP] Releasing held round advance now that opponent reconnected.');
              const fn = _mpHeldRoundAdvanceFn;
              _mpHeldRoundAdvanceFn = null;
              fn();
            }
            // If we are the GUEST and still waiting for a round_result, check the
            // Room state cache — the reconnect may have replayed the host's payload.
            if (!isHost) {
              _mpGuestResumeReplay();
              _mpGuestCheckCachedResult();
            }
          });
        }

        // Close lobby and show versus screen, then transition to MP battle prep
        overlay.classList.add('hidden');
        _mpShowVersusScreen(opponentId, () => {
          _mpEnterBattleMode();
        });

        console.info(`[MP] Match found — roomId: ${roomId.slice(0,8)}, isHost: ${isHost}, opponent: ${opponentId.slice(0,8)}`);
      });
    }

    // ── Helpers ──────────────────────────────────────────────────────────
    function _mpSetStatus(text, cls) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className   = 'mp-status' + (cls ? ` ${cls}` : '');
    }

    function _mpUpdateConnectionBadge() {
      if (!badgeEl) return;
      const status = (typeof SupabaseClient !== 'undefined' && typeof SupabaseClient.getChannelStatus === 'function')
        ? SupabaseClient.getChannelStatus('matchmaking:queue')
        : ((typeof SupabaseClient !== 'undefined' && SupabaseClient.getChannel('matchmaking:queue')) ? 'SUBSCRIBED' : 'pending');
      if (status === 'SUBSCRIBED') {
        badgeEl.textContent = '🟢 Connected';
        badgeEl.classList.add('connected');
        if (typeof Matchmaking !== 'undefined' && Matchmaking.isSearching() && statusEl?.textContent === 'Connecting to matchmaking…') {
          _mpSetStatus('Searching for opponent…', 'searching');
        }
      } else {
        badgeEl.textContent = status === 'closed' ? '🔴 Disconnected' : '🟡 Connecting…';
        badgeEl.classList.remove('connected');
        if (typeof Matchmaking !== 'undefined' && Matchmaking.isSearching()) {
          _mpSetStatus('Connecting to matchmaking…', 'searching');
        }
        // Re-check until the channel is actually subscribed.
        setTimeout(_mpUpdateConnectionBadge, 1000);
      }
    }
  }

  // ── MP State: scores, round, timer ────────────────────────────────────
  const _mpState = {
    myScore:    0,
    oppScore:   0,
    round:      1,
    totalRounds: 5,
    readyTimer: null,
    readySeconds: 35,
  };

  // ── Versus screen ──────────────────────────────────────────────────────
  function _mpShowVersusScreen(opponentId, onDone) {
    const vsOverlay = document.getElementById('mp-versus-overlay');
    const myNameEl  = document.getElementById('mp-vs-my-name');
    const oppNameEl = document.getElementById('mp-vs-opp-name');
    if (!vsOverlay) { onDone?.(); return; }

    const myName = (typeof Backend !== 'undefined' && Backend.getPlayerName())
      || localStorage.getItem('shape_strikers_player_name') || 'You';
    const oppShort = opponentId ? opponentId.slice(0, 8) : 'Opponent';

    if (myNameEl)  myNameEl.textContent  = myName;
    if (oppNameEl) oppNameEl.textContent = `#${oppShort}`;

    vsOverlay.classList.remove('hidden');
    _mpRefreshBo5Dots('mp-bo5-tracker');

    setTimeout(() => {
      vsOverlay.classList.add('hidden');
      onDone?.();
    }, 2500);
  }

  // ── Enter multiplayer battle-prep mode ────────────────────────────────
  function _mpEnterBattleMode() {
    _mpMode = true;

    // Switch to game screen
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const gameScreen = document.getElementById('screen-game');
    if (gameScreen) gameScreen.classList.add('active');

    // Hide single-player-only elements
    ['#hud-wave', '#speed-controls'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.classList.add('mp-hidden');
    });
    document.getElementById('btn-battle')?.classList.add('mp-hidden');

    // Show MP-specific elements
    ['#mp-hud-round', '#mp-hud-score', '#mp-conn-indicator', '#mp-ready-bar'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.classList.remove('mp-hidden');
    });

    // Build (or rebuild) the grid so tiles exist for MP
    if (typeof Grid !== 'undefined') {
      Grid.build();
      Grid.onClick      = _handleTileClick;
      Grid.onRightClick = _handleTileRightClick;
    }
    state = _freshState();
    state.gold = 10; // MultiplayerGame will override this via onRoundReady

    // Start MultiplayerGame module if available
    if (typeof MultiplayerGame !== 'undefined') {
      MultiplayerGame.start(
        Room.getRoomId?.() || 'local',
        Room.isHost?.(),
        Room.getOpponentId?.(),
        {
          onRoundReady:     (round, gold) => _mpPrepRound(round, gold),
          onOppReady:       () => {
            const el = document.getElementById('mp-ready-opp-status');
            if (el) { el.textContent = '✅ Opponent ready!'; el.classList.add('ready'); }
            Audio.play('objective'); // audible cue: opponent locked in
          },
          onBothReady:      () => _mpStartMPBattle(),
          onOpponentReroll: () => {
            // Opponent rerolled — silently advance our RNG (handled in MultiplayerGame)
            // Optionally show a message
            UI.showMessage('Opponent rerolled their shop!', 1500);
          },
          onMatchEnd:       (winner) => _mpEndMatch(winner),
        }
      );
    }

    _mpUpdateConnIndicator('connected');
    _startMPRoomWatch();
  }

  // ── Prepare an MP round (called by MultiplayerGame.onRoundReady) ─────
  function _mpPrepRound(round, gold) {
    // Update state
    state.phase = 'prep';
    state.wave  = round; // use round number as wave for enemy generation
    state.gold  = gold;
    state.refreshesLeft = 1; // one free refresh per round (rerolls via MP are separate)

    // Sync scores from MultiplayerGame
    if (typeof MultiplayerGame !== 'undefined') {
      const scores = MultiplayerGame.getScores();
      _mpState.myScore  = scores.my;
      _mpState.oppScore = scores.opp;
    }
    _mpState.round = round;

    // Reset ready button UI
    const readyBtn = document.getElementById('btn-mp-ready');
    const oppStatus = document.getElementById('mp-ready-opp-status');
    if (readyBtn)  { readyBtn.disabled = false; readyBtn.textContent = '✅ Ready'; }
    if (oppStatus) { oppStatus.textContent = 'Waiting for opponent…'; oppStatus.classList.remove('ready'); }

    // Wire ready button (re-wire each round)
    if (readyBtn) {
      readyBtn.onclick = () => {
        readyBtn.disabled = true;
        readyBtn.textContent = '✅ Waiting…';
        if (typeof MultiplayerGame !== 'undefined') MultiplayerGame.signalReady(state.playerUnits);
        if (oppStatus) { oppStatus.textContent = 'Waiting for opponent…'; }
      };
    }

    // Generate seeded shop
    const shopUnits = _mpGenerateShop();
    if (shopUnits) {
      state.shopUnits = shopUnits;
    } else {
      // Fallback: use standard shop generation
      refreshShop(true);
      return;
    }
    state.selectedShopIdx = null;
    Grid.clearSelection();
    UI.renderShop(state.shopUnits, state.gold, _buyShopUnit);
    UI.updateUpgrades(state.upgradeLevels, state.gold, buyUpgrade);

    _mpRefreshRoundHud();
    _mpRefreshBo5Dots('mp-bo5-tracker');
    _refreshHUD();
    _mpStartReadyTimer();

    UI.showMessage(`⚔️ Round ${round} of ${typeof MultiplayerGame !== 'undefined' ? MultiplayerGame.getTotalRounds() : 5} — Build your army!`);
    Audio.play('getReady');
  }

  // ── Build the unit pool for MP (no unlock-flag filtering — both clients must get same pool) ─
  function _mpBuildPool() {
    // Intentionally does NOT read localStorage unlock flags — if one player has unlocked
    // arcane/void and the other hasn't, filtering by those flags would cause pool desync
    // even with a shared RNG seed, giving players different shops.
    return UNIT_DEFINITIONS.filter(d => !d.isBoss);
  }

  // ── Generate MP shop using seeded RNG ────────────────────────────────
  function _mpGenerateShop() {
    if (typeof MultiplayerGame === 'undefined') return null;
    const pool = _mpBuildPool();
    return MultiplayerGame.generateShopUnits(pool, 5);
  }

  // ── Spawn opponent's army as enemies in the enemy zone (PVP) ────────
  // Opponent's player-zone rows (3,4) are mirrored to enemy-zone rows (1,0).
  function _buildPVPEnemies(oppUnitData, options = {}) {
    const { placeOnGrid = true, writeState = true } = options;
    const enemies = [];

    for (const data of (oppUnitData || [])) {
      const def = UNIT_MAP[data.defId];
      if (!def) continue;
      // Mirror vertically: opp frontline (row 3) → our enemy frontline (row 1)
      //                     opp backline  (row 4) → our enemy backline  (row 0)
      // Formula: enemyRow = (rows-1) - data.row  → 4-3=1, 4-4=0  ✓
      const enemyRow = (GRID_CONFIG.rows - 1) - data.row;
      const safeRow  = Math.max(0, Math.min(GRID_CONFIG.battleLineRow - 1, enemyRow));
      const enemy    = _mkUnit(def, safeRow, data.col, true);
      // Use opponent's actual (upgraded) stats
      if (data.stats) {
        enemy.stats  = { ...data.stats };
        enemy.hp     = data.stats.hp;
        enemy.maxHp  = data.stats.hp;
      }
      enemies.push(enemy);
    }

    if (writeState) state.enemyUnits = enemies;
    if (placeOnGrid) {
      for (const e of enemies) Grid.placeUnit(e, e.row, e.col);
    }
    return enemies;
  }

  // ── Start MP battle (both players ready) ─────────────────────────────
  function _mpStartMPBattle() {
    if (_mpState.readyTimer) { clearInterval(_mpState.readyTimer); _mpState.readyTimer = null; }

    // Reset per-round reconnect helpers so stale data from last round cannot interfere.
    _mpLastRoundResultPayload = null;
    _mpLastBattleReplay = null;
    _mpLastBattleReplayPayload = null;
    _mpLastPhaseEventPayload = null;
    _mpLastPlaybackCheckpoint = null;
    _mpGuestCheckCachedResult = () => false; // will be overwritten by guest block below
    _mpGuestResumeReplay = () => false;
    _mpOpponentOfflineDuringBattle = false;
    _mpHeldRoundAdvanceFn = null;
    _mpGuestExtendResultTimeout = () => {}; // will be overwritten by guest block below
    // seq counters: host increments before each broadcast; guest tracks last applied.
    // Both reset per-round so round 2's seq=2 cannot be confused with round 1's seq=1.
    _mpResultSeq = 0;
    _mpLastAppliedSeq = -1;

    state.phase = 'battle';
    UI.clearLog();
    UI.showMessage('⚔️ Syncing battle...', 0);
    _refreshHUD();
    document.getElementById('btn-refresh').disabled = true;

    const oppData = (typeof MultiplayerGame !== 'undefined') ? MultiplayerGame.getOppUnits() : [];
    _mpStampStableUnitKeys(state.playerUnits, [], oppData);

    _preBattlePositions = state.playerUnits.map(u => ({ id: u.id, row: u.row, col: u.col }));

    // MP battles run at minimum 2× speed.
    const _mpBattleSpeed = Math.max(_currentSpeedMult, 2);
    VFX.setSpeed(_mpBattleSpeed);
    if (typeof Grid !== 'undefined') Grid.resetAnimations();
    _initBattleStats();
    _battleParticipants = state.playerUnits.map(u => ({ id: u.id, definition: u.definition, maxHp: u.maxHp }));

    // Host generates the authoritative replay log instantly, then both clients
    // consume that same event stream for battle presentation.
    const HOST_RESULT_TIMEOUT_MS = 9000;
    const _expectedRound = (typeof MultiplayerGame !== 'undefined') ? MultiplayerGame.getRound() : -1;

    if (typeof MultiplayerGame !== 'undefined' && !MultiplayerGame.isHost()) {
      let _roundResultHandled = false;
      let _battleReplayStarted = false;
      let _replayHostWon = null;
      let _hostResultTimer = null;

      const _matchesRound = (payload) => {
        if (!payload) return false;
        return payload.roundNumber === undefined || payload.roundNumber === _expectedRound;
      };

      const _getCachedState = (key) => {
        if (typeof Room === 'undefined') return null;
        const value = Room.getState()[key];
        return _matchesRound(value) ? value : null;
      };

      const _resolveReplayStartSeq = () => {
        const checkpoint = _getCachedState('playback_checkpoint');
        if (checkpoint && Number.isFinite(Number(checkpoint.seq))) {
          return Math.max(0, Number(checkpoint.seq) || 0);
        }
        const phaseEvent = _getCachedState('phase_event');
        if (phaseEvent && Number.isFinite(Number(phaseEvent.checkpointSeq))) {
          return Math.max(0, Number(phaseEvent.checkpointSeq) || 0);
        }
        return 0;
      };

      const _setAwaitingResultState = () => {
        state.phase = 'result';
        _inspectedUnit = null;
        document.getElementById('btn-refresh').disabled = false;
        UI.showMessage('⏳ Awaiting results…', 0);
      };

      const _maybeStartReplay = (source) => {
        if (_battleReplayStarted) return false;

        const phaseEvent = _getCachedState('phase_event');
        if (!phaseEvent || phaseEvent.type !== MP_PHASE_EVENTS.PLAYBACK_START) return false;

        const replayPayload = _getCachedState('battle_replay') || _mpLastBattleReplay;
        if (!replayPayload) return false;

        const startSeq = _resolveReplayStartSeq();
        return _startReplayFromPayload(replayPayload, source, startSeq);
      };

      const _applyPhaseEvent = (payload, source) => {
        if (!_matchesRound(payload)) return false;
        _mpLastPhaseEventPayload = payload;

        switch (payload.type) {
          case MP_PHASE_EVENTS.PREP_END:
            UI.showMessage('⚔️ Boards locked — preparing the battle…', 0);
            return true;
          case MP_PHASE_EVENTS.BATTLE_SCRIPT_READY:
            UI.showMessage('🧾 Battle ready — syncing both players…', 0);
            return true;
          case MP_PHASE_EVENTS.PLAYBACK_START:
            return _maybeStartReplay(`${source}:phase_event`);
          case MP_PHASE_EVENTS.RESULT_SHOW:
            if (!_roundResultHandled) _setAwaitingResultState();
            return true;
          default:
            return false;
        }
      };

      const _applyResult = (guestWon, source) => {
        if (_roundResultHandled) return;
        _roundResultHandled = true;
        if (_hostResultTimer) { clearTimeout(_hostResultTimer); _hostResultTimer = null; }
        if (_mpReplayPlayer && _mpReplayPlayer.isPlaying()) _mpReplayPlayer.stop();
        if (typeof Room !== 'undefined') {
          Room.offStateChange(_roundResultFn);
          Room.offStateChange(_battleReplayFn);
          Room.offStateChange(_phaseEventFn);
          Room.offStateChange(_playbackCheckpointFn);
        }
        if (battle) { battle.stop(); battle = null; }
        if (source === 'timeout') {
          console.warn(`[MP:R${_expectedRound}] Host round_result not received within ${HOST_RESULT_TIMEOUT_MS}ms — applying replay result as fallback.`);
        } else {
          console.info(`[MP:R${_expectedRound}] Applying host round_result (source=${source}), guestWon=${guestWon}`);
        }
        _mpHandleRoundEnd(guestWon);
      };

      const _startReplayFromPayload = (payload, source, startSeq = 0) => {
        if (_battleReplayStarted) return false;
        if (!payload || !_matchesRound(payload)) return false;

        const replayLog = _mpExtractReplayLog(payload);
        if (!replayLog) return false;

        _battleReplayStarted = true;
        _mpLastBattleReplay = payload;
        _replayHostWon = _mpExtractReplayHostWon(payload);
        console.info(`[MP:R${_expectedRound}] Starting authoritative replay (source=${source}, startSeq=${startSeq}).`);

        _mpPlayReplayLog(payload, {
          turnDelay: 120,
          showCompleteMessage: false,
          startSeq,
        }).then(() => {
          if (_roundResultHandled) return;
          _setAwaitingResultState();
          _hostResultTimer = setTimeout(() => _applyResult(!_replayHostWon, 'timeout'), HOST_RESULT_TIMEOUT_MS);
        });

        return true;
      };

      const _battleReplayFn = (key, value) => {
        if (key !== 'battle_replay') return;
        if (!_matchesRound(value)) return;
        _mpLastBattleReplay = value;
        _maybeStartReplay('host-battle_replay');
      };

      const _phaseEventFn = (key, value) => {
        if (key !== 'phase_event') return;
        _applyPhaseEvent(value, 'host');
      };

      const _playbackCheckpointFn = (key, value) => {
        if (key !== 'playback_checkpoint') return;
        if (!_matchesRound(value)) return;
        _mpLastPlaybackCheckpoint = value;
      };

      const _roundResultFn = (key, value) => {
        if (key !== 'round_result') return;
        if (_roundResultHandled) return;

        // Phase guard: only apply results while we are in a battle or result phase.
        // Ignores stale broadcasts that arrive during shop/prep/versus/matchmaking.
        if (state.phase !== 'battle' && state.phase !== 'result') {
          console.warn(`[MP:R${_expectedRound}] Ignoring round_result — wrong phase (${state.phase})`);
          return;
        }

        // Round guard: ignore stale results from a previous round.
        // A missing roundNumber is treated as valid (backward compat with older host).
        if (value.roundNumber !== undefined && value.roundNumber !== _expectedRound) {
          console.warn(`[MP:R${_expectedRound}] Ignoring stale round_result for round ${value.roundNumber}`);
          return;
        }

        // Seq guard: ignore duplicate or out-of-order deliveries.
        if (value.seq !== undefined && value.seq <= _mpLastAppliedSeq) {
          console.warn(`[MP:R${_expectedRound}] Ignoring duplicate round_result seq=${value.seq} (last applied=${_mpLastAppliedSeq})`);
          return;
        }
        if (value.seq !== undefined) _mpLastAppliedSeq = value.seq;

        if (typeof HashUtils !== 'undefined' && _mpLastBattleReplay?.boardHash && value.boardHash) {
          if (_mpLastBattleReplay.boardHash !== value.boardHash) {
            HashUtils.warnMismatch(_mpLastBattleReplay.boardHash, value.boardHash);
          } else {
            console.info(`[MP:R${_expectedRound}] Replay hash matches host ✓`);
          }
        }

        // Guest won = host lost.
        _applyResult(!value.hostWon, 'host');
      };
      if (typeof Room !== 'undefined') {
        Room.onStateChange(_battleReplayFn);
        Room.onStateChange(_phaseEventFn);
        Room.onStateChange(_playbackCheckpointFn);
        Room.onStateChange(_roundResultFn);
      }

      _mpGuestResumeReplay = () => _maybeStartReplay('reconnect-cache');

      _mpGuestCheckCachedResult = () => {
        if (_roundResultHandled) return false;
        if (state.phase !== 'battle' && state.phase !== 'result') return false;
        const cached = (typeof Room !== 'undefined') ? Room.getState()['round_result'] : null;
        if (cached && cached.hostWon !== undefined &&
            (cached.roundNumber === undefined || cached.roundNumber === _expectedRound) &&
            (cached.seq === undefined || cached.seq > _mpLastAppliedSeq)) {
          if (cached.seq !== undefined) _mpLastAppliedSeq = cached.seq;
          console.info(`[MP:R${_expectedRound}] Guest: applying cached round_result (source=cache-check), guestWon=${!cached.hostWon}`);
          _applyResult(!cached.hostWon, 'cached');
          return true;
        }
        return false;
      };

      _mpGuestExtendResultTimeout = () => {
        if (_roundResultHandled) return;
        if (_hostResultTimer) {
          clearTimeout(_hostResultTimer);
          _hostResultTimer = null;
          console.info(`[MP:R${_expectedRound}] Guest: result timer suspended — opponent offline. Will resume on reconnect.`);
          UI.showMessage('⚠️ Opponent connection lost — awaiting reconnect…', 0);
        }
        _hostResultTimer = setTimeout(() => _applyResult(!_replayHostWon, 'timeout-reconnect'), 60_000);
      };

      const handledCachedPhase = _applyPhaseEvent(_getCachedState('phase_event'), 'cache-check');
      const startedFromCache = _maybeStartReplay('cache-check');
      const appliedCachedResult = _mpGuestCheckCachedResult();
      if (!handledCachedPhase && !startedFromCache && !appliedCachedResult) {
        UI.showMessage('⚔️ Waiting for battle sync…', 0);
      }
      return;
    }

    _mpEmitPhaseEvent(MP_PHASE_EVENTS.PREP_END);

    const replayPayload = _mpGenerateBattleReplayPayload(oppData);
    _mpLastBattleReplay = replayPayload;
    _mpLastBattleReplayPayload = replayPayload;
    if (typeof Room !== 'undefined') Room.syncState('battle_replay', replayPayload);
    _mpEmitPhaseEvent(MP_PHASE_EVENTS.BATTLE_SCRIPT_READY, { boardHash: replayPayload.boardHash });
    _mpEmitPlaybackCheckpoint(0, 0, { boardHash: replayPayload.boardHash });
    _mpEmitPhaseEvent(MP_PHASE_EVENTS.PLAYBACK_START, {
      boardHash: replayPayload.boardHash,
      checkpointSeq: 0,
      checkpointTurn: 0,
    });

    _mpPlayReplayLog(replayPayload, {
      turnDelay: 120,
      showCompleteMessage: false,
      onTurnStart: (evt) => {
        _mpEmitPlaybackCheckpoint(evt.seq || 0, evt.turn || 0, { boardHash: replayPayload.boardHash });
      },
    }).then((finalEvent) => {
      const hostWon = finalEvent ? !!finalEvent.playerWon : _mpExtractReplayHostWon(replayPayload);
      _mpHandleRoundEnd(hostWon);
    });
  }

  // ── Last round_result payload (host only) — retained so reconnecting guests can be re-served ──
  let _mpLastRoundResultPayload = null;
  // Monotonic counter incremented each time the host emits a round_result.
  // Guests track the highest seq seen and reject any payload with seq ≤ lastSeen.
  let _mpResultSeq = 0;          // host: next seq to emit
  let _mpLastAppliedSeq = -1;    // guest: highest seq applied this match

  // ── Guest reconnect helper — checks Room state cache for a pending result ──
  // Called (a) in onBattleEnd fast-path, (b) on Room reconnect while waiting.
  // Returns true if the result was applied (so caller can skip further setup).
  let _mpGuestCheckCachedResult = () => {}; // replaced per-round inside _mpStartMPBattle

  // ── Handle MP round result ────────────────────────────────────────────
  function _mpHandleRoundEnd(playerWon) {
    // Host broadcasts authoritative round result so guest scores correctly.
    if (typeof MultiplayerGame !== 'undefined' && MultiplayerGame.isHost() &&
        typeof Room !== 'undefined') {
      const roundNumber = MultiplayerGame.getRound();
      const boardHash = _mpLastBattleReplayPayload?.boardHash ?? null;
      _mpEmitPhaseEvent(MP_PHASE_EVENTS.RESULT_SHOW, {
        boardHash,
        checkpointSeq: _mpLastPlaybackCheckpoint?.seq || 0,
        checkpointTurn: _mpLastPlaybackCheckpoint?.turn || 0,
      });
      // roundNumber + seq together let guests reject stale/duplicate/out-of-order payloads.
      const seq = ++_mpResultSeq;
      const payload = { hostWon: playerWon, roundNumber, seq, boardHash };

      // Store payload so we can re-broadcast to a guest that reconnects mid-result.
      _mpLastRoundResultPayload = payload;

      // Retry up to 3 times at 1s intervals if the channel is momentarily not SUBSCRIBED.
      // Distinguish transient (ok:false with no error) from hard errors.
      const MAX_BROADCAST_ATTEMPTS = 3;
      const BROADCAST_RETRY_MS = 1000;
      let _attempts = 0;
      const _broadcast = async () => {
        _attempts++;
        const result = await Room.syncState('round_result', payload);
        if (result?.ok) {
          console.info(`[MP:R${roundNumber}] round_result broadcast ok (attempt ${_attempts}), hostWon=${playerWon}, hash=${boardHash}`);
        } else {
          // Log channel state to distinguish transient vs permission vs payload errors.
          const chState = (typeof SupabaseClient !== 'undefined')
            ? (SupabaseClient.getChannel(`room:${Room.getRoomId()}`)?.state || 'unknown')
            : 'SupabaseClient unavailable';
          console.warn(`[MP:R${roundNumber}] round_result broadcast failed (attempt ${_attempts}/${MAX_BROADCAST_ATTEMPTS}), channel=${chState}, error=${result?.error ?? 'none'}`);
          if (_attempts < MAX_BROADCAST_ATTEMPTS) {
            setTimeout(_broadcast, BROADCAST_RETRY_MS);
          } else {
            console.error(`[MP:R${roundNumber}] round_result broadcast gave up after ${MAX_BROADCAST_ATTEMPTS} attempts — guest may fall back to local result.`);
          }
        }
      };
      _broadcast();
    }

    if (_mpLastBattleReplay) {
      _mpApplyReplayOutcomeToState(_mpLastBattleReplay);
    }

    _restorePlayerPositions();
    _cleanupBattleArtifacts();
    if (playerWon) _healPlayerUnits();

    const survivingCount = state.playerUnits.length;
    const goldBonus = (typeof MultiplayerGame !== 'undefined')
      ? MultiplayerGame.getRoundGoldBonus(playerWon, survivingCount)
      : (playerWon ? 5 : 0);
    state.gold += goldBonus;

    // Sync scores into _mpState NOW (before MultiplayerGame.endRound) so Bo5 dots are correct
    if (playerWon) _mpState.myScore++;
    else           _mpState.oppScore++;

    const outcome = playerWon ? 'win' : 'loss';
    _mpShowRoundResult(outcome, goldBonus);

    // Re-enable refresh for next round
    document.getElementById('btn-refresh').disabled = false;

    if (typeof MultiplayerGame !== 'undefined') {
      if (_mpOpponentOfflineDuringBattle) {
        // Opponent dropped during this battle — defer the internal round counter increment
        // until they reconnect and receive the authoritative result.  This keeps both
        // clients' round numbers in sync and prevents the match from advancing before
        // the guest has a chance to apply the correct result.
        const _survivingCount = survivingCount;
        const _playerWon      = playerWon;
        _mpHeldRoundAdvanceFn = () => {
          console.info('[MP] Releasing deferred MultiplayerGame.endRound().');
          MultiplayerGame.endRound(_playerWon, _survivingCount);
        };
        console.info(`[MP:R${roundNumber ?? '?'}] Round advance held — opponent offline.`);
      } else {
        // Normal path: both clients online, advance immediately.
        MultiplayerGame.endRound(playerWon, survivingCount);
      }
    }
  }

  // ── Match end — show proper end screen (MP-5) ────────────────────────
  function _mpEndMatch(winner) {
    // Hide round result if still visible
    document.getElementById('mp-round-result')?.classList.add('hidden');

    const overlay  = document.getElementById('mp-match-end-overlay');
    const titleEl  = document.getElementById('mp-match-end-title');
    const scoreEl  = document.getElementById('mp-match-end-score');
    const statusEl = document.getElementById('mp-match-end-rematch-status');
    const rematchBtn = document.getElementById('btn-mp-rematch');
    const returnBtn  = document.getElementById('btn-mp-return-lobby');
    if (!overlay) { _mpCleanupAndReturnToLobby(); return; }

    const scores = (typeof MultiplayerGame !== 'undefined') ? MultiplayerGame.getScores() : { my: 0, opp: 0 };
    const titleMap = { me: '🏆 Victory!', opponent: '💀 Defeat', draw: '🤝 Draw' };
    const clsMap   = { me: 'win', opponent: 'loss', draw: 'draw' };

    if (titleEl) {
      titleEl.textContent = titleMap[winner] || 'Match Over';
      titleEl.className   = `mp-match-end-title ${clsMap[winner] || ''}`;
    }
    if (scoreEl) scoreEl.textContent = `${scores.my} – ${scores.opp}`;
    if (statusEl) statusEl.textContent = '';

    _mpRefreshBo5Dots('mp-match-end-dots');
    overlay.classList.remove('hidden');

    // Rematch flow — hoist handler ref so returnBtn can de-register it
    let _wantRematch = false;
    let _rematchHandler = null;

    if (rematchBtn) {
      rematchBtn.onclick = () => {
        _wantRematch = true;
        rematchBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Waiting for opponent…';
        if (typeof Room !== 'undefined') Room.syncState('mp_rematch_request', true);
      };
    }
    if (returnBtn) {
      returnBtn.onclick = () => {
        overlay.classList.add('hidden');
        if (_rematchHandler && typeof Room !== 'undefined') Room.offStateChange(_rematchHandler);
        _mpCleanupAndReturnToLobby();
      };
    }

    // Listen for opponent's rematch agreement
    _rematchHandler = (key) => {
      if (key !== 'mp_rematch_request') return;
      if (_wantRematch) {
        overlay.classList.add('hidden');
        if (typeof Room !== 'undefined') Room.offStateChange(_rematchHandler);
        _mpCleanupAndReturnToLobby();
      } else {
        if (statusEl) statusEl.textContent = 'Opponent wants a rematch!';
        if (rematchBtn) rematchBtn.textContent = '🔁 Accept Rematch';
      }
    };
    if (typeof Room !== 'undefined') Room.onStateChange(_rematchHandler);
  }

  function _mpHandleDisconnect() {
    _mpUpdateConnIndicator('disconnected');
    const notice   = document.getElementById('mp-disconnect-notice');
    const msgEl    = document.getElementById('mp-disconnect-msg');
    const timerEl  = document.getElementById('mp-disconnect-timer');
    if (notice) notice.classList.remove('hidden');

    // During battle: pause/hold so a reconnecting opponent can still receive the
    // authoritative result.  Use a longer grace period and don't forfeit immediately.
    const duringBattle = (state.phase === 'battle');
    if (duringBattle) {
      _mpOpponentOfflineDuringBattle = true;
      if (msgEl) msgEl.textContent = '⚠️ Opponent disconnected mid-battle — holding result…';
      // Guest: suspend the 9s result timer so a late re-broadcast can still be applied.
      _mpGuestExtendResultTimeout();
      console.info('[MP] Opponent offline during battle — activating sync hold.');
    } else {
      if (msgEl) msgEl.textContent = '⚠️ Opponent disconnected — waiting…';
    }

    // Room already waited 10s before firing this; use a short UI countdown before forfeiting.
    // During battle we give extra time: 30s instead of 5s (host still runs simulation; we
    // just need them to reconnect and receive the authoritative result).
    const GRACE = duringBattle ? 30 : 5;
    let remaining = GRACE;
    if (timerEl) timerEl.textContent = `${remaining}s`;

    const graceTimer = setInterval(() => {
      remaining--;
      if (timerEl) timerEl.textContent = `${remaining}s`;
      if (remaining <= 0) {
        clearInterval(graceTimer);
        if (notice) notice.classList.add('hidden');
        if (!_mpMode) return; // match already ended elsewhere
        // Forfeit for disconnected player — handle both prep and mid-battle phases
        if (state.phase === 'battle' && battle) {
          battle.stop(); // halt mid-battle; onBattleEnd won't fire so call handler directly
          _mpOpponentOfflineDuringBattle = false; // forfeit overrides hold
          _mpHandleRoundEnd(true);
        } else if (state.phase === 'prep') {
          _mpHandleRoundEnd(true);
        }
      }
    }, 1000);

    // Prevent handler accumulation: remove old reconnect listener before adding new one
    if (_mpDisconnectReconnectFn && typeof Room !== 'undefined') {
      Room.offReconnect(_mpDisconnectReconnectFn);
    }
    _mpDisconnectReconnectFn = () => {
      clearInterval(graceTimer);
      if (notice) notice.classList.add('hidden');
      _mpUpdateConnIndicator('connected');
      if (msgEl) msgEl.textContent = '✅ Opponent reconnected!';
      if (notice) {
        notice.classList.remove('hidden');
        setTimeout(() => notice.classList.add('hidden'), 3000);
      }
    };
    if (typeof Room !== 'undefined') Room.onReconnect(_mpDisconnectReconnectFn);
  }

  // ── Clean up MP session and return to title ───────────────────────────
  function _mpCleanupAndReturnToLobby() {
    _mpMode = false;
    _mpDisconnectReconnectFn = null;
    _stopMPRoomWatch();
    if (_mpState.readyTimer) { clearInterval(_mpState.readyTimer); _mpState.readyTimer = null; }

    // Clear ALL per-match reconnect / result state so stale data cannot bleed into the next match.
    _mpLastRoundResultPayload   = null;
    _mpResultSeq                = 0;
    _mpLastAppliedSeq           = -1;
    _mpOpponentOfflineDuringBattle = false;
    _mpHeldRoundAdvanceFn       = null;
    _mpGuestCheckCachedResult   = () => false;
    _mpGuestExtendResultTimeout = () => {};
    _mpLastBattleReplay         = null;
    _mpLastBattleReplayPayload  = null;
    _mpLastPhaseEventPayload    = null;
    _mpLastPlaybackCheckpoint   = null;
    _mpGuestResumeReplay        = () => false;
    if (_mpReplayPlayer && _mpReplayPlayer.isPlaying()) _mpReplayPlayer.stop();
    _mpReplayPlayer             = null;
    _mpResetReplayUnits();

    // Stop any running battle cleanly before tearing down modules.
    if (battle) { battle.stop(); battle = null; }

    document.getElementById('mp-match-end-overlay')?.classList.add('hidden');
    document.getElementById('mp-disconnect-notice')?.classList.add('hidden');
    document.getElementById('mp-reconnect-banner')?.classList.add('hidden');
    if (typeof MultiplayerGame !== 'undefined') MultiplayerGame.destroy();
    if (typeof Room !== 'undefined') Room.destroy(); // destroy clears all listeners

    // Reset lobby UI so it opens fresh next time (no stale "Match found!" status etc.)
    const statusEl  = document.getElementById('mp-status');
    const findBtn   = document.getElementById('btn-mp-find-match');
    const cancelBtn = document.getElementById('btn-mp-cancel');
    if (statusEl)  { statusEl.textContent = 'Ready to search'; statusEl.className = 'mp-status'; }
    if (findBtn)   findBtn.style.display  = '';
    if (cancelBtn) cancelBtn.style.display = 'none';

    _mpExitBattleMode();
    _returnToTitle();
  }

  // ── Ready countdown timer ─────────────────────────────────────────────
  function _mpStartReadyTimer() {
    if (_mpState.readyTimer) clearInterval(_mpState.readyTimer);
    let secs = _mpState.readySeconds;
    const timerEl = document.getElementById('mp-ready-timer');
    if (timerEl) timerEl.textContent = secs;

    _mpState.readyTimer = setInterval(() => {
      secs--;
      if (timerEl) {
        timerEl.textContent = secs;
        timerEl.classList.toggle('urgent', secs <= 10);
      }
      if (secs <= 0) {
        clearInterval(_mpState.readyTimer);
        _mpState.readyTimer = null;
        // Auto-ready on timer expiry
        const readyBtn = document.getElementById('btn-mp-ready');
        if (readyBtn && !readyBtn.disabled) readyBtn.click();
      }
    }, 1000);
  }

  // ── Round HUD refresh ─────────────────────────────────────────────────
  function _mpRefreshRoundHud() {
    const roundNumEl = document.getElementById('mp-round-num');
    const myScoreEl  = document.getElementById('mp-score-you');
    const oppScoreEl = document.getElementById('mp-score-opp');
    const round  = (typeof MultiplayerGame !== 'undefined' && MultiplayerGame.isActive()) ? MultiplayerGame.getRound()  : _mpState.round;
    const scores = (typeof MultiplayerGame !== 'undefined' && MultiplayerGame.isActive()) ? MultiplayerGame.getScores() : { my: _mpState.myScore, opp: _mpState.oppScore };
    if (roundNumEl) roundNumEl.textContent = round;
    if (myScoreEl)  myScoreEl.textContent  = scores.my;
    if (oppScoreEl) oppScoreEl.textContent = scores.opp;
  }

  // ── Best-of-5 dots refresh ────────────────────────────────────────────
  // Dots fill from left for player wins, from right for opponent wins.
  function _mpRefreshBo5Dots(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const dots = container.querySelectorAll('.mp-bo5-dot');
    dots.forEach((dot, i) => {
      dot.className = 'mp-bo5-dot';
      if (i < _mpState.myScore) dot.classList.add('win');
    });
    const oppDots = Array.from(dots).reverse();
    oppDots.forEach((dot, i) => {
      if (i < _mpState.oppScore && !dot.classList.contains('win')) dot.classList.add('loss');
    });
  }

  // ── Show round result banner ──────────────────────────────────────────
  function _mpShowRoundResult(outcome, goldBonus) {
    const banner   = document.getElementById('mp-round-result');
    const titleEl  = document.getElementById('mp-result-title');
    const subEl    = document.getElementById('mp-result-sub');
    if (!banner) return;

    const labels = { win: '🏆 You Win!', loss: '💀 You Lose', draw: '🤝 Draw' };
    if (titleEl) {
      titleEl.textContent = labels[outcome] || 'Round Over';
      titleEl.className   = `mp-round-result-title ${outcome}`;
    }
    if (subEl) {
      subEl.textContent = goldBonus > 0 ? `+${goldBonus}G bonus earned` : '';
    }
    _mpRefreshBo5Dots('mp-bo5-result');

    banner.classList.remove('hidden');
    setTimeout(() => banner.classList.add('hidden'), 3000);
  }

  // ── Connection indicator ──────────────────────────────────────────────
  function _mpUpdateConnIndicator(connStatus) {
    const el = document.getElementById('mp-conn-indicator');
    if (!el) return;
    const icons = { connected: '🟢', reconnecting: '🟡', disconnected: '🔴' };
    el.textContent = icons[connStatus] || '🟡';
    el.title = connStatus.charAt(0).toUpperCase() + connStatus.slice(1);
  }

  function _clearMPReconnectAttemptTimer() {
    if (_mpReconnectAttemptTimer) {
      clearInterval(_mpReconnectAttemptTimer);
      _mpReconnectAttemptTimer = null;
    }
  }

  function _syncMPReconnectBanner() {
    const banner = document.getElementById('mp-reconnect-banner');
    const statusEl = document.getElementById('mp-reconnect-status');
    const btn = document.getElementById('btn-mp-reconnect');
    const disconnectNotice = document.getElementById('mp-disconnect-notice');
    if (!banner || !statusEl || !btn) return;

    const activeBattle = _mpMode && (state?.phase === 'battle' || state?.phase === 'result' || _mpOpponentOfflineDuringBattle);
    const roomState = (typeof Room !== 'undefined' && typeof Room.getConnectionState === 'function')
      ? Room.getConnectionState()
      : 'closed';
    const needsReconnect = activeBattle && roomState !== 'SUBSCRIBED' && roomState !== 'closed';

    if (!needsReconnect) {
      banner.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = '🔄 Reconnect';
      statusEl.textContent = '';
      delete statusEl.dataset.source;
      if (activeBattle && roomState === 'SUBSCRIBED' && disconnectNotice?.classList.contains('hidden')) {
        _mpUpdateConnIndicator('connected');
      }
      return;
    }

    banner.classList.remove('hidden');
    if (!btn.disabled) btn.textContent = '🔄 Reconnect';
    if (!statusEl.textContent || statusEl.dataset.source === 'poll') {
      statusEl.dataset.source = 'poll';
      statusEl.textContent = roomState === 'pending'
        ? 'Realtime channel is retrying…'
        : `Room channel ${roomState.toLowerCase().replace(/_/g, ' ')}.`;
    }
  }

  function _startMPRoomWatch() {
    if (_mpRoomWatchTimer) clearInterval(_mpRoomWatchTimer);
    _mpLastRoomWatchState = (typeof Room !== 'undefined' && typeof Room.getConnectionState === 'function')
      ? Room.getConnectionState()
      : 'closed';
    _mpRoomWatchTimer = setInterval(() => {
      const roomState = (typeof Room !== 'undefined' && typeof Room.getConnectionState === 'function')
        ? Room.getConnectionState()
        : 'closed';
      const prevState = _mpLastRoomWatchState;
      if (_mpMode && roomState !== 'SUBSCRIBED' && roomState !== 'closed') {
        _mpUpdateConnIndicator('reconnecting');
      }
      if (_mpMode && roomState === 'SUBSCRIBED' && prevState !== 'SUBSCRIBED') {
        _mpUpdateConnIndicator('connected');
        if (typeof MultiplayerGame !== 'undefined' && MultiplayerGame.isActive() && !MultiplayerGame.isHost()) {
          _mpGuestResumeReplay();
          _mpGuestCheckCachedResult();
        }
      }
      _mpLastRoomWatchState = roomState;
      _syncMPReconnectBanner();
    }, 1000);
    _syncMPReconnectBanner();
  }

  function _stopMPRoomWatch() {
    if (_mpRoomWatchTimer) {
      clearInterval(_mpRoomWatchTimer);
      _mpRoomWatchTimer = null;
    }
    _mpLastRoomWatchState = 'closed';
    _clearMPReconnectAttemptTimer();

    const banner = document.getElementById('mp-reconnect-banner');
    const statusEl = document.getElementById('mp-reconnect-status');
    const btn = document.getElementById('btn-mp-reconnect');
    if (banner) banner.classList.add('hidden');
    if (statusEl) {
      statusEl.textContent = '';
      delete statusEl.dataset.source;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Reconnect';
    }
  }

  // ── Exit multiplayer mode (restore single-player UI) ─────────────────
  function _mpExitBattleMode() {
    if (_mpState.readyTimer) { clearInterval(_mpState.readyTimer); _mpState.readyTimer = null; }
    _stopMPRoomWatch();

    ['#hud-wave', '#speed-controls', '#btn-battle'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.classList.remove('mp-hidden');
    });
    ['#mp-hud-round', '#mp-hud-score', '#mp-conn-indicator', '#mp-ready-bar'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.classList.add('mp-hidden');
    });

    _mpState.myScore = 0;
    _mpState.oppScore = 0;
    _mpState.round = 1;
  }

  // ── Debug overlay (MP-5, localhost only, Ctrl+Shift+D) ───────────────
  function _initMPDebugOverlay() {
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') return;

    const overlay = document.getElementById('mp-debug-overlay');
    if (!overlay) return;

    let _visible = false;
    const MAX_LINES = 80;

    function _log(msg, type) {
      const line = document.createElement('div');
      line.className = 'mp-debug-line' + (type ? ` ${type}` : '');
      const ts = new Date().toISOString().slice(11, 23);
      line.textContent = `[${ts}] ${msg}`;
      overlay.appendChild(line);
      while (overlay.children.length > MAX_LINES) overlay.removeChild(overlay.firstChild);
      overlay.scrollTop = overlay.scrollHeight;
    }

    function _forceRealtimeDisconnect() {
      const realtime = SupabaseClient?.getClient?.()?.realtime;
      if (!realtime?.disconnect) {
        _log('Realtime disconnect is unavailable in this browser.', 'error');
        return false;
      }
      realtime.disconnect();
      _mpUpdateConnIndicator('reconnecting');
      setTimeout(() => _syncMPReconnectBanner(), 60);
      _log('Forced realtime disconnect (Ctrl+Shift+X).', 'warn');
      return true;
    }

    // Intercept Room state changes
    if (typeof Room !== 'undefined') {
      Room.onStateChange((key, value) => {
        _log(`ROOM key=${key} val=${JSON.stringify(value).slice(0, 60)}`);
      });
      Room.onOpponentDisconnect(() => _log('ROOM opponent_disconnect', 'warn'));
      Room.onReconnect(() => _log('ROOM opponent_reconnect'));
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'D') {
        _visible = !_visible;
        overlay.classList.toggle('active', _visible);
        if (_visible) _log('Debug overlay opened');
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'X') {
        e.preventDefault();
        _forceRealtimeDisconnect();
      }
    });

    // Expose so other helpers can log
    window._mpDebugLog = _log;
    window._mpDebugForceRealtimeDisconnect = _forceRealtimeDisconnect;
    _log('MP debug overlay ready (Ctrl+Shift+D toggle, Ctrl+Shift+X drop realtime)');
  }

  function _initChatUI() {
    const panel    = document.getElementById('chat-panel');
    const toggle   = document.getElementById('chat-toggle');
    const body     = document.getElementById('chat-body');
    const messages = document.getElementById('chat-messages');
    const form     = document.getElementById('chat-form');
    const input    = document.getElementById('chat-input');
    const unread   = document.getElementById('chat-unread');
    const dot      = document.getElementById('chat-status-dot');

    if (!panel || !toggle || !messages || !form || !input) return;

    let _unreadCount = 0;
    let _isOpen      = false;

    // ── Toggle open/close ────────────────────────────────────────────────
    toggle.addEventListener('click', () => {
      _isOpen = !_isOpen;
      panel.classList.toggle('collapsed', !_isOpen);
      toggle.setAttribute('aria-expanded', String(_isOpen));
      if (_isOpen) {
        _unreadCount = 0;
        unread?.classList.add('hidden');
        // Scroll to bottom and focus input
        messages.scrollTop = messages.scrollHeight;
        input.focus();
      }
    });

    // ── Render incoming messages ─────────────────────────────────────────
    // NOTE: playerName and text from GlobalChat are already control-char-stripped.
    // Using textContent here guarantees no XSS regardless of what arrives.
    const myId = () => (typeof Backend !== 'undefined' && Backend.getUserId()) || '';

    GlobalChat.onMessage((msg) => {
      const isMine = msg.playerId === myId();

      const item = document.createElement('div');
      item.className = 'chat-msg' + (isMine ? ' chat-msg-mine' : '');

      const nameEl = document.createElement('span');
      nameEl.className = 'chat-msg-name';
      nameEl.textContent = msg.playerName;

      const textEl = document.createElement('span');
      textEl.className = 'chat-msg-text';
      textEl.textContent = msg.text;

      item.appendChild(nameEl);
      item.appendChild(document.createTextNode(' '));
      item.appendChild(textEl);
      messages.appendChild(item);

      // Cap DOM to MAX_MESSAGES nodes
      while (messages.childElementCount > 50) messages.removeChild(messages.firstChild);

      if (_isOpen) {
        messages.scrollTop = messages.scrollHeight;
      } else if (!isMine) {
        _unreadCount++;
        if (unread) {
          unread.textContent = _unreadCount > 9 ? '9+' : String(_unreadCount);
          unread.classList.remove('hidden');
        }
      }
    });

    // ── Send ─────────────────────────────────────────────────────────────
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const result = GlobalChat.sendMessage(text);
      if (result.ok) {
        input.value = '';
      } else if (result.error === 'Rate limited') {
        if (typeof UI !== 'undefined') UI.showMessage('💬 Slow down!', 1500);
      }
    });

    // ── Enable input once channel is subscribed ──────────────────────────
    // SupabaseClient will log when SUBSCRIBED; we poll briefly to enable input.
    const CHECK_INTERVAL_MS = 500;
    const MAX_CHECKS        = 30;  // give up after 15 s
    let checks = 0;
    const _checkReady = setInterval(() => {
      checks++;
      const ch = (typeof SupabaseClient !== 'undefined') && SupabaseClient.getChannel('chat:global');
      if (ch) {
        input.disabled     = false;
        input.placeholder  = 'Message…';
        if (dot) { dot.title = 'Connected'; dot.classList.add('connected'); }
        clearInterval(_checkReady);
      } else if (checks >= MAX_CHECKS) {
        input.placeholder = 'Chat unavailable';
        if (dot) dot.title = 'Unavailable';
        clearInterval(_checkReady);
      }
    }, CHECK_INTERVAL_MS);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    preloadSprites(); // fire-and-forget — sprites ready before user enters game
    preloadSlashSprites(); // melee slash animation frames
    Audio.init();
    Backend.init();       // fire-and-forget — leaderboards degrade gracefully
    _initMultiplayer();   // fire-and-forget — presence + chat degrade gracefully
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

    // Show splash overlay — allow button, tap, or Enter/Space to dismiss on all devices
    const splashEl = document.getElementById('splash-overlay');
    if (splashEl) {
      splashEl.classList.remove('hidden');
      splashEl.tabIndex = 0;

      const onSplashKeydown = (e) => {
        if (splashEl.classList.contains('hidden')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dismissSplash();
        }
      };

      const dismissSplash = () => {
        if (splashEl.classList.contains('hidden')) return;
        splashEl.classList.add('hidden');
        document.removeEventListener('keydown', onSplashKeydown);
        Audio.playMusic('ss_title_music_full.wav');
        setTimeout(() => splashEl.remove(), 600);
      };

      document.addEventListener('keydown', onSplashKeydown);
      document.getElementById('btn-splash-dismiss')?.addEventListener('click', dismissSplash, { once: true });
      splashEl.addEventListener('click', (e) => {
        if (e.target.id === 'splash-overlay' || e.target.closest('.splash-box')) dismissSplash();
      });

      requestAnimationFrame(() => {
        document.getElementById('btn-splash-dismiss')?.focus({ preventScroll: true });
      });
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
    playLastMpReplay: _playLastMpReplay,
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
