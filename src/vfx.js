/**
 * Shape Strikers Web — VFX System (Phase 5)
 * Particle pool, screen flash, shockwaves, element projectiles, ability VFX.
 * Depends on: ELEMENT_COLORS, ELEMENT_EMOJI (from config.js), Grid
 */

const VFX = (() => {

  // Speed multiplier for projectile timing (synced with game speed)
  let _speedMult = 1;
  const BASE_PROJ_DURATION = 0.28;  // seconds
  const BASE_TRAIL_DURATION = 0.32;
  const BASE_CLEANUP_MS = 600;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PARTICLE POOL — reuse DOM nodes instead of create/destroy
  // ═══════════════════════════════════════════════════════════════════════════

  const _pool = {};       // { className: [freeNode, ...] }
  const POOL_MAX = 40;    // max idle nodes per class

  function _acquire(className) {
    const bucket = _pool[className];
    if (bucket && bucket.length > 0) {
      const el = bucket.pop();
      el.style.display = '';
      return el;
    }
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  function _release(el) {
    if (!el || !el.className) return;
    const cls = el.className.split(' ')[0]; // base class
    el.style.display = 'none';
    el.style.cssText = '';                   // reset inline styles
    el.textContent = '';
    el.className = cls;                      // reset to base class
    if (el.parentNode) el.parentNode.removeChild(el);

    if (!_pool[cls]) _pool[cls] = [];
    if (_pool[cls].length < POOL_MAX) {
      _pool[cls].push(el);
    }
    // else: let GC collect
  }

  /** Attach a pooled particle to a parent, auto-release on animationend */
  function _spawnPooled(parent, className, setup) {
    const el = _acquire(className);
    setup(el);
    parent.appendChild(el);
    el.addEventListener('animationend', () => _release(el), { once: true });
    // Safety: release after max animation time
    setTimeout(() => { if (el.parentNode) _release(el); }, 2000);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 2. SCREEN FLASH — full-screen color pulse for crits / big abilities
  // ═══════════════════════════════════════════════════════════════════════════

  let _flashEl = null;

  function screenFlash(color = '#ffffff', duration = 300, opacity = 0.25) {
    if (!_flashEl) {
      _flashEl = document.createElement('div');
      _flashEl.className = 'vfx-screen-flash';
      document.body.appendChild(_flashEl);
    }
    _flashEl.style.background = color;
    _flashEl.style.display = 'block';
    _flashEl.style.setProperty('--flash-opacity', String(opacity));
    _flashEl.style.setProperty('--flash-dur', duration + 'ms');
    _flashEl.classList.remove('vfx-flash-play');
    void _flashEl.offsetWidth;
    _flashEl.classList.add('vfx-flash-play');
    _flashEl.addEventListener('animationend', () => {
      _flashEl.style.display = 'none';
      _flashEl.classList.remove('vfx-flash-play');
    }, { once: true });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 3. IMPACT SHOCKWAVE RING — expanding circle on heavy hits / AoE
  // ═══════════════════════════════════════════════════════════════════════════

  function shockwave(row, col, color = '#ffffff', size = 'medium') {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    const sizeClass = `vfx-shockwave-${size}`; // small, medium, large
    _spawnPooled(tile, 'vfx-shockwave', el => {
      el.className = `vfx-shockwave ${sizeClass}`;
      el.style.setProperty('--sw-color', color);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 4. ELEMENT-SPECIFIC PROJECTILES — shaped trails per element
  // ═══════════════════════════════════════════════════════════════════════════

  const ELEM_SHAPES = {
    fire:      { char: '🔥', trail: '•', trailCount: 3 },
    ice:       { char: '❄️', trail: '✦', trailCount: 2 },
    lightning: { char: '⚡', trail: '⚬', trailCount: 4 },
    earth:     { char: '🪨', trail: '▪', trailCount: 2 },
    arcane:    { char: '✨', trail: '✧', trailCount: 3 },
    void:      { char: '🕳️', trail: '◦', trailCount: 3 },
    blood:     { char: '🩸', trail: '•', trailCount: 3 },
    plague:    { char: '☠️', trail: '▪', trailCount: 2 },
  };

  function elementProjectile(fromRow, fromCol, toRow, toCol, element) {
    const container = document.getElementById('grid-container');
    const fromTile = Grid.getTileEl(fromRow, fromCol);
    const toTile   = Grid.getTileEl(toRow, toCol);
    if (!container || !fromTile || !toTile) return;

    const cRect = container.getBoundingClientRect();
    const fRect = fromTile.getBoundingClientRect();
    const tRect = toTile.getBoundingClientRect();

    const startX = fRect.left + fRect.width / 2 - cRect.left;
    const startY = fRect.top + fRect.height / 2 - cRect.top;
    const endX   = tRect.left + tRect.width / 2 - cRect.left;
    const endY   = tRect.top + tRect.height / 2 - cRect.top;

    const color = ELEMENT_COLORS[element] || '#ffffff';
    const shape = ELEM_SHAPES[element] || ELEM_SHAPES.fire;

    // Scale durations with speed multiplier
    const projDur  = BASE_PROJ_DURATION / _speedMult;
    const trailDur = BASE_TRAIL_DURATION / _speedMult;
    const cleanupMs = Math.max(200, BASE_CLEANUP_MS / _speedMult);

    // Main projectile
    const proj = _acquire('vfx-projectile');
    proj.className = `vfx-projectile vfx-proj-${element}`;
    proj.textContent = shape.char;
    proj.style.left = startX + 'px';
    proj.style.top  = startY + 'px';
    proj.style.opacity = '1';
    proj.style.setProperty('--proj-color', color);
    proj.style.transition = `left ${projDur}s ease-in, top ${projDur}s ease-in, opacity ${projDur}s ease-in`;
    container.appendChild(proj);

    // Trail particles
    const trails = [];
    for (let i = 0; i < shape.trailCount; i++) {
      const trail = _acquire('vfx-trail');
      trail.className = `vfx-trail vfx-trail-${element}`;
      trail.textContent = shape.trail;
      trail.style.left = startX + 'px';
      trail.style.top  = startY + 'px';
      trail.style.opacity = String(0.7 - i * 0.15);
      trail.style.setProperty('--trail-color', color);
      trail.style.transition = `left ${trailDur}s ease-in, top ${trailDur}s ease-in, opacity ${trailDur * 0.9}s ease-in`;
      trail.style.transitionDelay = (i * 0.04 / _speedMult) + 's';
      container.appendChild(trail);
      trails.push(trail);
    }

    // Force layout so browser commits initial positions before transition
    void proj.offsetWidth;

    // Now trigger transitions to end position
    proj.style.left = endX + 'px';
    proj.style.top  = endY + 'px';
    proj.style.opacity = '0.3';

    for (const trail of trails) {
      trail.style.left = endX + 'px';
      trail.style.top  = endY + 'px';
      trail.style.opacity = '0';
    }

    proj.addEventListener('transitionend', () => _release(proj), { once: true });
    setTimeout(() => { if (proj.parentNode) _release(proj); }, cleanupMs);

    for (const trail of trails) {
      trail.addEventListener('transitionend', () => _release(trail), { once: true });
      setTimeout(() => { if (trail.parentNode) _release(trail); }, cleanupMs);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 5. ABILITY-UNIQUE VFX — different patterns per ability type
  // ═══════════════════════════════════════════════════════════════════════════

  /** Fire spread: multiple flame particles burst outward */
  function burnSpread(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    for (let i = 0; i < 5; i++) {
      _spawnPooled(tile, 'vfx-burn-particle', el => {
        el.textContent = '🔥';
        el.style.left = (10 + Math.random() * 70) + '%';
        el.style.top  = (10 + Math.random() * 60) + '%';
        el.style.animationDelay = (i * 0.06) + 's';
      });
    }
  }

  /** Freeze burst: ice crystals radiate outward */
  function freezeBurst(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    const symbols = ['❄️', '✦', '❄️', '✧'];
    for (let i = 0; i < 4; i++) {
      _spawnPooled(tile, 'vfx-freeze-particle', el => {
        el.textContent = symbols[i];
        const angle = (i / 4) * Math.PI * 2;
        el.style.left = (50 + Math.cos(angle) * 25) + '%';
        el.style.top  = (50 + Math.sin(angle) * 25) + '%';
        el.style.animationDelay = (i * 0.08) + 's';
      });
    }
  }

  /** Chain lightning: arcs between tiles */
  function chainLightning(positions) {
    const container = document.getElementById('grid-container');
    if (!container) return;
    const cRect = container.getBoundingClientRect();

    for (let i = 0; i < positions.length - 1; i++) {
      const from = Grid.getTileEl(positions[i].row, positions[i].col);
      const to   = Grid.getTileEl(positions[i + 1].row, positions[i + 1].col);
      if (!from || !to) continue;

      const fR = from.getBoundingClientRect();
      const tR = to.getBoundingClientRect();
      const x1 = fR.left + fR.width / 2 - cRect.left;
      const y1 = fR.top + fR.height / 2 - cRect.top;
      const x2 = tR.left + tR.width / 2 - cRect.left;
      const y2 = tR.top + tR.height / 2 - cRect.top;

      const bolt = _acquire('vfx-lightning-bolt');
      bolt.className = 'vfx-lightning-bolt';
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      bolt.style.left = x1 + 'px';
      bolt.style.top  = y1 + 'px';
      bolt.style.width = len + 'px';
      bolt.style.transform = `rotate(${angle}deg)`;
      bolt.style.animationDelay = (i * 0.1) + 's';
      container.appendChild(bolt);

      bolt.addEventListener('animationend', () => _release(bolt), { once: true });
      setTimeout(() => { if (bolt.parentNode) _release(bolt); }, 800);
    }
  }

  /** Shield dome: expanding protective circle */
  function shieldDome(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    _spawnPooled(tile, 'vfx-shield-dome', el => {
      el.style.setProperty('--shield-color', '#ffd700');
    });
  }

  /** Barrier pulse: purple protective ring */
  function barrierPulse(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    _spawnPooled(tile, 'vfx-barrier-pulse', el => {
      el.style.setProperty('--barrier-color', '#aa44ff');
    });
  }

  /** Poison cloud: green toxic mist */
  function poisonCloud(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    for (let i = 0; i < 4; i++) {
      _spawnPooled(tile, 'vfx-poison-particle', el => {
        el.textContent = '☁';
        el.style.left = (15 + Math.random() * 55) + '%';
        el.style.top  = (15 + Math.random() * 50) + '%';
        el.style.animationDelay = (i * 0.08) + 's';
      });
    }
  }

  /** Weaken debuff: downward spiral */
  function weakenSpiral(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    _spawnPooled(tile, 'vfx-weaken-spiral', el => {
      el.textContent = '⬇️';
    });
  }

  /** Void rupture: dark expanding rift */
  function voidRupture(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    _spawnPooled(tile, 'vfx-void-rift', el => {});
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 6. ENHANCED BOSS ENTRANCE — multi-step cinematic
  // ═══════════════════════════════════════════════════════════════════════════

  function bossEntrance(bossDefinition, onDone) {
    const container = document.getElementById('grid-container');
    if (!container) { if (onDone) onDone(); return; }

    const color = ELEMENT_COLORS[bossDefinition.element] || '#ff4422';
    const emoji = ELEMENT_EMOJI[bossDefinition.element] || '💀';

    // Step 1: Screen dim overlay
    const overlay = document.createElement('div');
    overlay.className = 'vfx-boss-overlay';
    overlay.style.setProperty('--boss-color', color);
    container.appendChild(overlay);

    // Step 2: Ground shake (200ms delay)
    setTimeout(() => {
      screenShake('heavy');
    }, 200);

    // Step 3: Boss slam-in icon (400ms)
    const icon = document.createElement('div');
    icon.className = 'vfx-boss-icon';
    icon.textContent = emoji;
    icon.style.setProperty('--boss-color', color);

    const name = document.createElement('div');
    name.className = 'vfx-boss-name';
    name.textContent = bossDefinition.name;
    name.style.color = color;

    const sub = document.createElement('div');
    sub.className = 'vfx-boss-sub';
    sub.textContent = 'BOSS BATTLE';

    const content = document.createElement('div');
    content.className = 'vfx-boss-content';
    content.appendChild(icon);
    content.appendChild(name);
    content.appendChild(sub);
    overlay.appendChild(content);

    setTimeout(() => {
      content.classList.add('vfx-boss-slam');
    }, 400);

    // Step 4: Shockwave ring from center (800ms)
    setTimeout(() => {
      const ring = document.createElement('div');
      ring.className = 'vfx-boss-ring';
      ring.style.setProperty('--boss-color', color);
      overlay.appendChild(ring);
      ring.addEventListener('animationend', () => ring.remove(), { once: true });
    }, 800);

    // Step 5: Flash + exit (1600ms)
    setTimeout(() => {
      screenFlash(color, 200, 0.3);
    }, 1500);

    setTimeout(() => {
      overlay.classList.add('vfx-boss-exit');
      overlay.addEventListener('animationend', () => {
        overlay.remove();
        if (onDone) onDone();
      }, { once: true });
      // Safety
      setTimeout(() => { if (overlay.parentNode) { overlay.remove(); if (onDone) onDone(); } }, 600);
    }, 1800);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 7. HEALING VFX VARIETY
  // ═══════════════════════════════════════════════════════════════════════════

  /** Single-target heal: upward spiral of hearts/sparkles */
  function healSingle(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    const symbols = ['💚', '✦', '♥', '✧', '+'];
    for (let i = 0; i < 5; i++) {
      _spawnPooled(tile, 'vfx-heal-single', el => {
        el.textContent = symbols[i % symbols.length];
        const angle = (i / 5) * Math.PI * 2;
        el.style.left = (50 + Math.cos(angle) * 20) + '%';
        el.style.top  = (50 + Math.sin(angle) * 15) + '%';
        el.style.animationDelay = (i * 0.08) + 's';
      });
    }
  }

  /** AoE heal: expanding green pulse ring */
  function healAoE(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;
    _spawnPooled(tile, 'vfx-heal-aoe', el => {
      el.style.setProperty('--heal-color', '#44ff88');
    });
    // Plus sparkle particles
    for (let i = 0; i < 3; i++) {
      _spawnPooled(tile, 'vfx-heal-sparkle', el => {
        el.textContent = '✦';
        el.style.left = (20 + Math.random() * 50) + '%';
        el.style.top  = (20 + Math.random() * 40) + '%';
        el.style.animationDelay = (i * 0.1) + 's';
      });
    }
  }

  /** Lifesteal drain: red tendrils toward caster */
  function drainLife(fromRow, fromCol, toRow, toCol) {
    const container = document.getElementById('grid-container');
    const fromTile = Grid.getTileEl(fromRow, fromCol);
    const toTile   = Grid.getTileEl(toRow, toCol);
    if (!container || !fromTile || !toTile) return;

    const cRect = container.getBoundingClientRect();
    const fR = fromTile.getBoundingClientRect();
    const tR = toTile.getBoundingClientRect();

    const tendrils = [];
    for (let i = 0; i < 3; i++) {
      const tendril = _acquire('vfx-drain-tendril');
      tendril.className = 'vfx-drain-tendril';
      tendril.textContent = '🩸';
      const startX = fR.left + fR.width / 2 - cRect.left + (Math.random() - 0.5) * 20;
      const startY = fR.top + fR.height / 2 - cRect.top + (Math.random() - 0.5) * 20;
      const endX   = tR.left + tR.width / 2 - cRect.left;
      const endY   = tR.top + tR.height / 2 - cRect.top;

      tendril.style.left = startX + 'px';
      tendril.style.top  = startY + 'px';
      tendril.style.opacity = '1';
      tendril.style.transitionDelay = (i * 0.06) + 's';
      container.appendChild(tendril);
      tendrils.push(tendril);
    }

    // Force layout so transitions fire from correct start positions
    if (tendrils.length) void tendrils[0].offsetWidth;

    for (const tendril of tendrils) {
      tendril.style.left = tR.left + tR.width / 2 - cRect.left + 'px';
      tendril.style.top  = tR.top + tR.height / 2 - cRect.top + 'px';
      tendril.style.opacity = '0';

      tendril.addEventListener('transitionend', () => _release(tendril), { once: true });
      setTimeout(() => { if (tendril.parentNode) _release(tendril); }, 600);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 8. SHAKE VARIETY — different patterns per hit type
  // ═══════════════════════════════════════════════════════════════════════════

  let _shaking = false;

  function screenShake(type = 'medium') {
    const grid = document.getElementById('grid-container');
    if (!grid || _shaking) return;
    _shaking = true;

    const shakeClass = `anim-shake-${type}`; // light, medium, heavy, rumble
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      grid.classList.remove(shakeClass);
      _shaking = false;
    };

    grid.classList.remove('anim-shake-light', 'anim-shake-medium', 'anim-shake-heavy', 'anim-shake-rumble', 'anim-shake');
    void grid.offsetWidth;
    grid.classList.add(shakeClass);
    grid.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 800);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // 8. MELEE SLASH — frame-by-frame sprite animation on target tile
  // ═══════════════════════════════════════════════════════════════════════════

  function meleeSlash(row, col) {
    const tile = Grid.getTileEl(row, col);
    if (!tile) return;

    // Pick a random slash animation
    const anim = SLASH_ANIMS[Math.floor(Math.random() * SLASH_ANIMS.length)];
    const totalDuration = 400 / _speedMult; // ms for full animation
    const frameTime = totalDuration / anim.count;

    // Create overlay element
    const el = document.createElement('div');
    el.className = 'vfx-melee-slash';
    tile.appendChild(el);

    let frame = 1;
    const img = SPRITE_CACHE[`${anim.key}_${frame}`];
    if (img) el.style.backgroundImage = `url('${img.src}')`;

    const interval = setInterval(() => {
      frame++;
      if (frame > anim.count) {
        clearInterval(interval);
        if (el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      const frameImg = SPRITE_CACHE[`${anim.key}_${frame}`];
      if (frameImg) el.style.backgroundImage = `url('${frameImg.src}')`;
    }, frameTime);

    // Safety cleanup
    setTimeout(() => {
      clearInterval(interval);
      if (el.parentNode) el.parentNode.removeChild(el);
    }, totalDuration + 100);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  return {
    // Particle pool
    _acquire,
    _release,

    // Screen effects
    screenFlash,
    screenShake,
    shockwave,

    // Projectiles
    elementProjectile,

    // Speed sync
    setSpeed(mult) { _speedMult = mult; },

    // Ability VFX
    burnSpread,
    freezeBurst,
    chainLightning,
    shieldDome,
    barrierPulse,
    poisonCloud,
    weakenSpiral,
    voidRupture,

    // Boss entrance
    bossEntrance,

    // Healing VFX
    healSingle,
    healAoE,
    drainLife,

    // Melee VFX
    meleeSlash,
  };
})();
