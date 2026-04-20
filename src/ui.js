/**
 * Shape Strikers Web — UI Controller
 * All DOM rendering: tabs, shop, stats panel, unit detail, glossary, overlays.
 */

const UI = (() => {

  let _activeTab = 'stats';

  // ── Tab Switching ─────────────────────────────────────────────────────────

  function switchTab(name) {
    _activeTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
  }

  // ── Top Bar / HUD ─────────────────────────────────────────────────────────

  function updateHUD(state) {
    const { wave, waveCount, gold, score, units, maxUnits, phase, challengeLabel } = state;
    const waveEl = document.getElementById('hud-wave');
    waveEl.textContent = challengeLabel
      ? `${challengeLabel} · Wave ${wave} / ${waveCount}`
      : `Wave ${wave} / ${waveCount}`;
    document.getElementById('gold-val').textContent   = gold;
    document.getElementById('score-val').textContent  = score;
    document.getElementById('units-val').textContent  = units;
    document.getElementById('max-units-val').textContent = maxUnits;

    const badge = document.getElementById('hud-phase');
    const phaseLabel = phase === 'prep' ? 'SHOP' : phase.toUpperCase();
    badge.textContent = phaseLabel;
    badge.className = 'phase-badge ' + phase;

    // Stats tab
    document.getElementById('tp-wave').textContent  = `${wave} / ${waveCount}`;
    document.getElementById('tp-gold').textContent  = gold + 'g';
    document.getElementById('tp-units').textContent = `${units} / ${maxUnits}`;
    document.getElementById('tp-score').textContent = score;
  }

  // ── Message Bar ───────────────────────────────────────────────────────────

  let _msgTimer = null;
  function showMessage(msg, duration = 3000) {
    const bar = document.getElementById('message-bar');
    bar.textContent = msg;
    clearTimeout(_msgTimer);
    if (duration > 0) _msgTimer = setTimeout(() => { bar.textContent = ''; }, duration);
  }

  // ── Synergies ─────────────────────────────────────────────────────────────

  function updateSynergies(playerUnits) {
    const counts = {};
    for (const u of playerUnits) counts[u.definition.element] = (counts[u.definition.element] || 0) + 1;

    const container = document.getElementById('synergy-list');
    container.innerHTML = '';

    for (const elem of Object.values(Element)) {
      if (elem === 'void') continue;
      const count = counts[elem] || 0;
      const syns = ELEMENT_SYNERGIES.filter(s => s.element === elem && s.requiredCount <= (count > 0 ? count + 1 : 99));
      if (syns.length === 0 && count === 0) continue;

      const best = ELEMENT_SYNERGIES.filter(s => s.element === elem && s.requiredCount <= count).pop();
      const next = ELEMENT_SYNERGIES.filter(s => s.element === elem && s.requiredCount > count)[0];

      const pill = document.createElement('div');
      pill.className = 'synergy-pill ' + (best ? 'active' : 'inactive');
      const emoji = ELEMENT_EMOJI[elem];
      const label = best ? best.description : (next ? `${next.requiredCount}${emoji}: need ${next.requiredCount - count} more` : '');
      pill.innerHTML = `<span>${emoji} ${count}</span><span style="flex:1;font-size:11px;color:${best ? '#2eaa5e' : '#556677'}">${label}</span>`;
      container.appendChild(pill);
    }

    if (container.children.length === 0) {
      container.innerHTML = '<div style="color:#445566;font-size:12px;padding:4px">Place units to see synergies</div>';
    }
  }

  // ── Upgrades ─────────────────────────────────────────────────────────────

  function updateUpgrades(upgradeLevels, gold, onBuy) {
    const container = document.getElementById('upgrade-list');
    container.innerHTML = '';

    for (const upg of UPGRADES) {
      const level = upgradeLevels[upg.id] || 0;
      const maxed = level >= upg.maxLevel;
      const cost  = upg.cost + level * 5;
      const canAfford = gold >= cost;

      const row = document.createElement('div');
      row.className = 'upgrade-row';
      row.innerHTML = `
        <span class="upgrade-name" title="${upg.description}">${upg.name}</span>
        <span class="upgrade-level">${level}/${upg.maxLevel}</span>
        <button class="upgrade-buy" ${maxed || !canAfford ? 'disabled' : ''} data-id="${upg.id}">
          ${maxed ? '✓' : cost + 'g'}
        </button>`;
      row.querySelector('.upgrade-buy').addEventListener('click', () => onBuy(upg.id));
      container.appendChild(row);
    }
  }

  // ── Shop ─────────────────────────────────────────────────────────────────

  function renderShop(shopUnits, gold, onBuy) {
    const container = document.getElementById('shop-units');
    container.innerHTML = '';

    for (let i = 0; i < shopUnits.length; i++) {
      const def = shopUnits[i];
      const sold = def === null;

      const card = document.createElement('div');
      card.className = 'shop-card anim-cardin' + (sold ? ' sold' : '');
      card.dataset.element = sold ? '' : def.element;

      if (sold) {
        card.innerHTML = `<div class="card-stripe"></div><div class="card-body" style="align-items:center;justify-content:center"><span style="color:#c0c8d0;font-size:22px">—</span></div>`;
      } else {
        const canAfford = gold >= def.cost;
        const elem = ELEMENT_EMOJI[def.element] || '';
        card.innerHTML = `
          <div class="card-stripe"></div>
          <div class="card-body">
            <div class="card-header">
              <span class="card-name" title="${def.name}">${elem} ${def.name}</span>
            </div>
            <div class="card-footer">
              <span class="card-cost-badge${canAfford ? '' : ' cant-afford'}">${def.cost}g</span>
            </div>
          </div>`;
        card.addEventListener('click', () => onBuy(i));

        // Mini canvas preview in card
        const preview = createUnitCanvas(def, false, 36);
        preview.className = 'card-preview';
        card.appendChild(preview);
      }

      container.appendChild(card);
    }

    // Update refresh cost display
    const refreshCost = document.getElementById('refresh-cost');
    if (refreshCost) refreshCost.textContent = Game?.getRefreshCost?.() ?? 2;
  }

  function setShopSlotSold(index) {
    const cards = document.querySelectorAll('.shop-card');
    if (cards[index]) cards[index].classList.add('sold');
  }

  // ── Unit Detail Tab ───────────────────────────────────────────────────────

  function showUnitDetail(unit, upgradeLevels, activeSynergies) {
    // unit = live unit object or just a definition
    const def = unit.definition || unit;
    const liveHp   = unit.hp    !== undefined ? unit.hp    : def.stats.hp;
    const liveMaxHp = unit.maxHp !== undefined ? unit.maxHp : def.stats.hp;

    document.getElementById('unit-detail-empty').style.display = 'none';
    const detail = document.getElementById('unit-detail');
    detail.classList.remove('js-hidden');
    detail.style.display = 'block';

    const elem = ELEMENT_EMOJI[def.element] || '';
    const elemColor = ELEMENT_COLORS[def.element] || '#aaaaaa';
    const tier = '★'.repeat(def.tier);
    const hpPct = Math.max(0, (liveHp / liveMaxHp) * 100);
    const hpColor = hpPct < 25 ? '#ff4422' : hpPct < 60 ? '#ffaa22' : '#44ff88';

    // Compute synergy-projected stat values (only during prep — during battle, stats are already boosted)
    const synergyBoosts = {};
    const alreadyBoosted = !!unit._baseStats; // _baseStats exists during battle = synergies already in stats
    if (activeSynergies && activeSynergies.length > 0 && !alreadyBoosted) {
      // Multiply multipliers together so multiple synergies boosting the same stat stack correctly
      for (const syn of activeSynergies) {
        const s = syn.bonus.stat;
        synergyBoosts[s] = (synergyBoosts[s] || 1) * syn.bonus.multiplier;
      }
    }

    const baseAtk = unit.stats?.attack  ?? def.stats.attack;
    const baseDef = unit.stats?.defense ?? def.stats.defense;
    const baseSpd = unit.stats?.speed   ?? def.stats.speed;

    const projAtk = synergyBoosts.attack  ? Math.floor(baseAtk * synergyBoosts.attack)  : baseAtk;
    const projDef = synergyBoosts.defense ? Math.floor(baseDef * synergyBoosts.defense) : baseDef;
    const projSpd = synergyBoosts.speed   ? Math.floor(baseSpd * synergyBoosts.speed)   : baseSpd;
    const projMaxHp = synergyBoosts.hp    ? Math.floor(liveMaxHp * synergyBoosts.hp)    : liveMaxHp;
    const projHp = synergyBoosts.hp       ? Math.min(liveHp + (projMaxHp - liveMaxHp), projMaxHp) : liveHp;

    const _buffVal = (base, proj, color) => {
      if (proj !== base) return `<span style="color:#667788;font-size:10px;text-decoration:line-through">${base}</span> <span style="color:${color}">${proj}</span>`;
      return `<span style="color:${color}">${base}</span>`;
    };

    const hpVal = synergyBoosts.hp
      ? `<span style="color:#667788;font-size:10px;text-decoration:line-through">${liveHp}/${liveMaxHp}</span> <span style="color:#44ff88">${projHp}/${projMaxHp}</span>`
      : `${liveHp} / ${liveMaxHp}`;

    const statRows = [
      { label: 'HP',  val: hpVal, color: '#44ff88' },
      { label: 'ATK', val: _buffVal(baseAtk, projAtk, '#ff6644'), color: '#ff6644' },
      { label: 'DEF', val: _buffVal(baseDef, projDef, '#66bbff'), color: '#66bbff' },
      { label: 'SPD', val: _buffVal(baseSpd, projSpd, '#ffff66'), color: '#ffff66' },
      { label: 'RNG', val: `<span style="color:#cccccc">${def.stats.range}</span>`, color: '#cccccc' },
      { label: 'Cost', val: `<span style="color:#ffd700">${def.cost}g</span>`,  color: '#ffd700' },
    ];

    const statGrid = statRows.map(s =>
      `<div class="unit-stat-cell"><div class="s-label">${s.label}</div><div class="s-val">${s.val}</div></div>`
    ).join('');

    // HP bar should reflect projected maxHp
    const dispHpPct = Math.max(0, (projHp / projMaxHp) * 100);
    const dispHpColor = dispHpPct < 25 ? '#ff4422' : dispHpPct < 60 ? '#ffaa22' : '#44ff88';
    const hpBarLabel = synergyBoosts.hp
      ? `<span style="color:#667788">HP</span><span style="color:${dispHpColor}">${projHp} / ${projMaxHp}</span>`
      : `<span style="color:#667788">HP</span><span style="color:${hpColor}">${liveHp} / ${liveMaxHp}</span>`;

    const DEBUFFS = ['burn','poison','freeze','slow','weaken','wound','blind'];
    const STATUS_EMOJI = { burn:'🔥', poison:'☠️', freeze:'🧊', slow:'🐌', weaken:'⬇️', wound:'🩸', blind:'😵', shield:'🛡️', barrier:'✨', untargetable:'👻' };
    const statusHtml = (unit.statusEffects?.length > 0)
      ? `<div class="status-effect-list">${unit.statusEffects.map(e => {
          const isDebuff = DEBUFFS.includes(e.type);
          const cls = isDebuff ? 'status-pill debuff' : 'status-pill buff';
          const icon = STATUS_EMOJI[e.type] || '';
          const name = e.type.charAt(0).toUpperCase() + e.type.slice(1);
          const stackStr = e.stacks > 1 ? ` ×${e.stacks}` : '';
          return `<span class="${cls}">${icon} ${name}${stackStr} (${e.duration}t)</span>`;
        }).join('')}</div>`
      : '';

    // Upgrade indicators (only for player units with active upgrades)
    let upgradeHtml = '';
    if (upgradeLevels && !unit.isEnemy) {
      const pills = [];
      const el = upgradeLevels['elite_training'] || 0;
      const de = upgradeLevels['double_edge'] || 0;
      if (el > 0) pills.push(`<span class="upgrade-pill elite">⬆ Elite L${el}</span>`);
      if (de > 0) pills.push(`<span class="upgrade-pill dedge">⚔ Double Edge</span>`);
      if (pills.length) upgradeHtml = `<div class="upgrade-pill-list">${pills.join('')}</div>`;
    }

    // Synergy indicators (for player units with active element synergies)
    let synergyHtml = '';
    if (activeSynergies && activeSynergies.length > 0 && !unit.isEnemy) {
      const synergyPills = activeSynergies.map(syn => {
        return `<span class="synergy-detail-pill">${syn.description}</span>`;
      });
      synergyHtml = `<div class="synergy-pill-list">${synergyPills.join('')}</div>`;
    }

    detail.innerHTML = `
      <div class="unit-name" style="color:${elemColor}">${elem} ${def.name}</div>
      <div class="unit-tier">${tier}</div>
      <div class="unit-tab-hp">
        <div class="unit-tab-hp-label">${hpBarLabel}</div>
        <div class="unit-tab-hp-bar"><div class="unit-tab-hp-fill" style="width:${dispHpPct}%;background:${dispHpColor}"></div></div>
      </div>
      <div class="unit-stat-grid">${statGrid}</div>
      ${upgradeHtml}
      ${synergyHtml}
      <div class="ability-box">
        <div class="ability-name">⚡ ${def.ability.name}</div>
        <div class="ability-desc">${def.ability.description}</div>
        <div class="ability-cd">Cooldown: ${def.ability.cooldown} turns</div>
      </div>
      ${statusHtml}`;

    const sellBtn = document.getElementById('btn-sell-unit');
    const canSell = !unit.isEnemy && Number.isInteger(unit.row) && Number.isInteger(unit.col);
    if (sellBtn) {
      if (canSell) {
        sellBtn.classList.remove('js-hidden');
        sellBtn.style.display = '';
      } else {
        sellBtn.style.display = 'none';
        sellBtn.classList.add('js-hidden');
      }
    }

    switchTab('unit');
  }

  function clearUnitDetail() {
    document.getElementById('unit-detail-empty').style.display = '';
    const detail = document.getElementById('unit-detail');
    detail.style.display = 'none';
    detail.classList.add('js-hidden');
    const sellBtn = document.getElementById('btn-sell-unit');
    if (sellBtn) {
      sellBtn.style.display = 'none';
      sellBtn.classList.add('js-hidden');
    }
  }

  // ── Battle Log ────────────────────────────────────────────────────────────

  const MAX_LOG = 80;
  let _logEntries = [];

  function addLogEntry(msg, type = 'system', side = null) {
    _logEntries.push({ msg, type, side });
    if (_logEntries.length > MAX_LOG) _logEntries.shift();
    _renderLog();
    document.getElementById('log-empty').style.display = 'none';
  }

  function clearLog() {
    _logEntries = [];
    document.getElementById('battle-log').innerHTML = '';
    document.getElementById('log-empty').style.display = '';
  }

  function _renderLog() {
    const container = document.getElementById('battle-log');
    container.innerHTML = '';
    for (const { msg, type, side } of [..._logEntries].reverse()) {
      const el = document.createElement('div');
      let classes = `log-entry ${type}`;
      if (side === 'player') classes += ' player-action';
      else if (side === 'enemy') classes += ' enemy-action';
      el.className = classes;
      el.textContent = msg;
      container.appendChild(el);
    }
    container.scrollTop = 0;
  }

  // ── Glossary ──────────────────────────────────────────────────────────────

  let _glossaryFilter = 'all';

  function showGlossary() {
    document.getElementById('overlay-glossary').classList.remove('hidden');
    _renderGlossary();
  }

  function hideGlossary() {
    document.getElementById('overlay-glossary').classList.add('hidden');
  }

  function filterGlossary(filter) {
    _glossaryFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    _renderGlossary();
  }

  function _renderGlossary() {
    const grid = document.getElementById('glossary-grid');
    grid.innerHTML = '';

    const arcaneUnlocked = localStorage.getItem('shape_strikers_arcane_unlocked') === '1';
    const voidUnlocked = localStorage.getItem('shape_strikers_void_unlocked') === '1';
    const encounteredBosses = JSON.parse(localStorage.getItem('shape_strikers_encountered_bosses') || '[]');

    const units = UNIT_DEFINITIONS.filter(d => {
      if (d.isBoss && !encounteredBosses.includes(d.id)) return false;
      if (_glossaryFilter === 'all') return d.element !== 'void' || voidUnlocked;
      return d.element === _glossaryFilter;
    });

    for (const def of units) {
      const isLocked = (def.element === 'arcane' && !arcaneUnlocked) || (def.element === 'void' && !voidUnlocked);
      const card = document.createElement('div');
      card.className = 'glossary-card' + (isLocked ? ' locked-card' : '');
      const elemColor = isLocked ? '#888' : (ELEMENT_COLORS[def.element] || '#aaaaaa');
      const tier = '★'.repeat(def.tier);
      const elemEmoji = ELEMENT_EMOJI[def.element] || '';

      if (isLocked) {
        const lockMsg = def.element === 'void'
          ? 'Complete the game to unlock Void faction'
          : 'Complete the game to unlock Arcane faction';
        card.innerHTML = `
          <div class="g-name" style="color:#888">🔒 ${elemEmoji} ???</div>
          <div class="g-tier" style="color:#999">${tier} · ${def.cost}g</div>
          <div class="g-stats" style="color:#aaa">${lockMsg}</div>`;
      } else {
        const canvas = createUnitCanvas(def, false, 44);

        card.innerHTML = `
          <div class="g-name" style="color:${elemColor}">${elemEmoji} ${def.name}</div>
          <div class="g-tier">${tier} · ${def.cost}g</div>
          <div class="g-stats">
            <span style="color:#ff6644">ATK ${def.stats.attack}</span> ·
            <span style="color:#66bbff">DEF ${def.stats.defense}</span> ·
            <span style="color:#44ff88">HP ${def.stats.hp}</span><br>
            <span style="color:#c8a000">SPD ${def.stats.speed}</span> ·
            <span>RNG ${def.stats.range}</span>
          </div>
          <div class="g-ability" title="${def.ability.description}">⚡ ${def.ability.name}</div>
          <div class="g-ability-desc">${def.ability.description} (CD: ${def.ability.cooldown})</div>`;

        // Prepend canvas
        card.insertBefore(canvas, card.firstChild);
      }
      grid.appendChild(card);
    }
  }

  // ── Battle Result Overlay ─────────────────────────────────────────────────

  function showResult(won, wave, goldEarned, goldBreakdown) {
    const overlay = document.getElementById('overlay-result');
    overlay.classList.remove('hidden');
    document.getElementById('result-title').innerHTML = won
      ? `<h2 style="color:#44ff88">✅ Wave ${wave} Cleared!</h2>`
      : `<h2 style="color:#ff4422">💀 Defeated on Wave ${wave}</h2>`;
    if (!won) {
      document.getElementById('result-body').innerHTML = `<p>Your army was overwhelmed.</p>`;
      return;
    }
    let goldHTML = `<p style="font-size:1.1em">Gold earned: <span style="color:#ffd700;font-weight:bold">${goldEarned}g</span></p>`;
    if (goldBreakdown) {
      goldHTML += `<div style="font-size:0.85em;color:#aaa;margin-top:4px;line-height:1.6">`;
      goldHTML += `<span style="color:#ddd">💰 Base: ${goldBreakdown.base}g</span>`;
      if (goldBreakdown.bonus > 0) goldHTML += ` &nbsp;•&nbsp; <span style="color:#ffaa44">⭐ Wave Bonus: ${goldBreakdown.bonus}g</span>`;
      if (goldBreakdown.victory > 0) goldHTML += ` &nbsp;•&nbsp; <span style="color:#88ddff">🏆 Victory: ${goldBreakdown.victory}g</span>`;
      if (goldBreakdown.interest > 0) goldHTML += ` &nbsp;•&nbsp; <span style="color:#44ff88">📈 Interest: ${goldBreakdown.interest}g</span>`;
      goldHTML += `</div>`;
    }
    document.getElementById('result-body').innerHTML = goldHTML;
  }

  function hideResult() {
    document.getElementById('overlay-result').classList.add('hidden');
  }

  function showGameOver(wave, score) {
    document.getElementById('overlay-gameover').classList.remove('hidden');
    document.getElementById('gameover-wave').textContent = `Reached Wave ${wave}`;
    document.getElementById('gameover-score').textContent = `Score: ${score}`;
  }

  function showWin(score, title, campaignMode) {
    const overlay = document.getElementById('overlay-win');
    overlay.classList.remove('hidden');
    document.getElementById('win-score').textContent = `Final Score: ${score}`;
    const titleEl = document.getElementById('win-title');
    if (titleEl) titleEl.textContent = title || '🏆 VICTORY!';
    const subtitleEl = document.getElementById('win-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = campaignMode === 'void'
        ? 'You have conquered the Void Abyss!'
        : 'You defeated the Void Supreme!';
    }
    if (campaignMode === 'void') {
      overlay.classList.add('void-win');
    } else {
      overlay.classList.remove('void-win');
    }
  }

  function hideAllOverlays() {
    document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
  }

  // ── Boss Phase Banner ─────────────────────────────────────────────────────

  function showPhaseBanner(phaseName, desc) {
    const banner = document.createElement('div');
    banner.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) scale(0.7);
      background:#fff5f0; border:2px solid #ff6644; border-radius:16px;
      padding:24px 40px; text-align:center; z-index:200;
      animation: bossIn 0.4s ease forwards;
      box-shadow: 0 8px 32px rgba(255,68,34,0.2);`;
    banner.innerHTML = `
      <div style="font-size:22px;font-weight:900;color:#ff8844">⚡ ${phaseName}</div>
      <div style="font-size:14px;color:#cc6633;margin-top:8px">${desc}</div>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 2500);
  }

  // ── Upgrade Panel Toggle ──────────────────────────────────────────────────

  function toggleUpgradePanel() {
    switchTab('stats');
    // Scroll upgrade-list into view
    setTimeout(() => {
      document.getElementById('upgrade-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  // ── Screen Switching ──────────────────────────────────────────────────────

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  // ── Public ────────────────────────────────────────────────────────────────
  return {
    switchTab,
    updateHUD,
    showMessage,
    updateSynergies,
    updateUpgrades,
    renderShop,
    setShopSlotSold,
    showUnitDetail,
    clearUnitDetail,
    addLogEntry,
    clearLog,
    showGlossary,
    hideGlossary,
    filterGlossary,
    showResult,
    hideResult,
    showGameOver,
    showWin,
    hideAllOverlays,
    showPhaseBanner,
    toggleUpgradePanel,
    showScreen,
  };
})();
