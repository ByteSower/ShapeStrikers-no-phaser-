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
    const { wave, waveCount, gold, score, units, maxUnits, phase } = state;
    document.getElementById('hud-wave').textContent   = `Wave ${wave} / ${waveCount}`;
    document.getElementById('gold-val').textContent   = gold;
    document.getElementById('score-val').textContent  = score;
    document.getElementById('units-val').textContent  = units;
    document.getElementById('max-units-val').textContent = maxUnits;

    const badge = document.getElementById('hud-phase');
    badge.textContent = phase.toUpperCase();
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
      pill.innerHTML = `<span>${emoji} ${count}</span><span style="flex:1;font-size:11px;color:${best ? '#44ff88' : '#556677'}">${label}</span>`;
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
      const canAfford = gold >= upg.cost;

      const row = document.createElement('div');
      row.className = 'upgrade-row';
      row.innerHTML = `
        <span class="upgrade-name" title="${upg.description}">${upg.name}</span>
        <span class="upgrade-level">${level}/${upg.maxLevel}</span>
        <button class="upgrade-buy" ${maxed || !canAfford ? 'disabled' : ''} data-id="${upg.id}">
          ${maxed ? '✓' : upg.cost + 'g'}
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
        const tier = '★'.repeat(def.tier);
        const elem = ELEMENT_EMOJI[def.element] || '';
        card.innerHTML = `
          <div class="card-stripe"></div>
          <div class="card-body">
            <div class="card-header">
              <span class="card-name" title="${def.name}">${def.name}</span>
              <span class="card-element">${elem} ${def.element}</span>
            </div>
            <div class="card-tier">${tier}</div>
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

  function showUnitDetail(unit) {
    // unit = live unit object or just a definition
    const def = unit.definition || unit;
    const liveHp   = unit.hp    !== undefined ? unit.hp    : def.stats.hp;
    const liveMaxHp = unit.maxHp !== undefined ? unit.maxHp : def.stats.maxHp;

    document.getElementById('unit-detail-empty').style.display = 'none';
    const detail = document.getElementById('unit-detail');
    detail.style.display = 'block';

    const elem = ELEMENT_EMOJI[def.element] || '';
    const elemColor = ELEMENT_COLORS[def.element] || '#aaaaaa';
    const tier = '★'.repeat(def.tier);
    const hpPct = Math.max(0, (liveHp / liveMaxHp) * 100);
    const hpColor = hpPct < 25 ? '#ff4422' : hpPct < 60 ? '#ffaa22' : '#44ff88';

    const statRows = [
      { label: 'HP',  val: `${liveHp} / ${liveMaxHp}`, color: '#44ff88' },
      { label: 'ATK', val: unit.stats?.attack  ?? def.stats.attack,  color: '#ff6644' },
      { label: 'DEF', val: unit.stats?.defense ?? def.stats.defense, color: '#66bbff' },
      { label: 'SPD', val: unit.stats?.speed   ?? def.stats.speed,   color: '#ffff66' },
      { label: 'RNG', val: def.stats.range, color: '#cccccc' },
      { label: 'Cost', val: def.cost + 'g',  color: '#ffd700' },
    ];

    const statGrid = statRows.map(s =>
      `<div class="unit-stat-cell"><div class="s-label">${s.label}</div><div class="s-val" style="color:${s.color}">${s.val}</div></div>`
    ).join('');

    const statusHtml = (unit.statusEffects?.length > 0)
      ? `<div class="status-effect-list">${unit.statusEffects.map(e => `<span class="status-pill">${e.type} (${e.duration}t)</span>`).join('')}</div>`
      : '';

    detail.innerHTML = `
      <div class="unit-name" style="color:${elemColor}">${elem} ${def.name}</div>
      <div class="unit-tier">${tier}</div>
      <div class="unit-tab-hp">
        <div class="unit-tab-hp-label"><span style="color:#667788">HP</span><span style="color:${hpColor}">${liveHp} / ${liveMaxHp}</span></div>
        <div class="unit-tab-hp-bar"><div class="unit-tab-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div></div>
      </div>
      <div class="unit-stat-grid">${statGrid}</div>
      <div class="ability-box">
        <div class="ability-name">⚡ ${def.ability.name}</div>
        <div class="ability-desc">${def.ability.description}</div>
        <div class="ability-cd">Cooldown: ${def.ability.cooldown} turns</div>
      </div>
      ${statusHtml}`;

    const sellBtn = document.getElementById('btn-sell-unit');
    if (sellBtn) sellBtn.style.display = '';

    switchTab('unit');
  }

  function clearUnitDetail() {
    document.getElementById('unit-detail-empty').style.display = '';
    document.getElementById('unit-detail').style.display = 'none';
    const sellBtn = document.getElementById('btn-sell-unit');
    if (sellBtn) sellBtn.style.display = 'none';
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
    const encounteredBosses = JSON.parse(localStorage.getItem('shape_strikers_encountered_bosses') || '[]');

    const units = UNIT_DEFINITIONS.filter(d => {
      if (d.isBoss && !encounteredBosses.includes(d.id)) return false;
      if (_glossaryFilter === 'all') return d.element !== 'void';
      return d.element === _glossaryFilter;
    });

    for (const def of units) {
      const isLocked = (def.element === 'arcane' && !arcaneUnlocked);
      const card = document.createElement('div');
      card.className = 'glossary-card' + (isLocked ? ' locked-card' : '');
      const elemColor = isLocked ? '#888' : (ELEMENT_COLORS[def.element] || '#aaaaaa');
      const tier = '★'.repeat(def.tier);
      const elemEmoji = ELEMENT_EMOJI[def.element] || '';

      if (isLocked) {
        card.innerHTML = `
          <div class="g-name" style="color:#888">🔒 ${elemEmoji} ???</div>
          <div class="g-tier" style="color:#999">${tier} · ${def.cost}g</div>
          <div class="g-stats" style="color:#aaa">Complete the game to unlock Arcane faction</div>`;
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

  function showResult(won, wave, goldEarned) {
    const overlay = document.getElementById('overlay-result');
    overlay.classList.remove('hidden');
    document.getElementById('result-title').innerHTML = won
      ? `<h2 style="color:#44ff88">✅ Wave ${wave} Cleared!</h2>`
      : `<h2 style="color:#ff4422">💀 Defeated on Wave ${wave}</h2>`;
    document.getElementById('result-body').innerHTML = won
      ? `<p>Gold earned: <span style="color:#ffd700">${goldEarned}g</span></p>`
      : `<p>Your army was overwhelmed.</p>`;
  }

  function hideResult() {
    document.getElementById('overlay-result').classList.add('hidden');
  }

  function showGameOver(wave, score) {
    document.getElementById('overlay-gameover').classList.remove('hidden');
    document.getElementById('gameover-wave').textContent = `Reached Wave ${wave}`;
    document.getElementById('gameover-score').textContent = `Score: ${score}`;
  }

  function showWin(score) {
    document.getElementById('overlay-win').classList.remove('hidden');
    document.getElementById('win-score').textContent = `Final Score: ${score}`;
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
