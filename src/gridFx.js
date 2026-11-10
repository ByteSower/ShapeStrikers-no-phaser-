/**
 * Animated layer for grid styles. Presentation only: never reads or writes battle state.
 * Effects run on Canvas 2D by default; GridFxGl supplies an optional WebGL version.
 */
const GridFx = (() => {
  const RENDERER_KEY = 'shape_strikers_grid_renderer';
  const MARGIN = 96;          // px a border effect extends beyond the grid
  const CORNER_RADIUS = 18;   // matches #grid-container border-radius
  const MAX_PARTICLES = 1600;
  const SPRITE_SIZE = 64;

  // Effects are data. 'border' emitters spawn along the grid outline and rise;
  // 'fall' emitters cover the whole grid area and drift with the wind.
  const EFFECTS = {
    flames: {
      emitter: 'border',
      rate: 0.55,              // particles per second per px of border
      life: [0.35, 0.85],      // seconds
      size: [6, 14],           // px radius
      spread: [4, 22],         // px/s along the outward normal
      rise: 170,               // px/s² upward
      wobble: 18,              // px/s sideways flicker
      stretch: 1.7,            // sprite height relative to width
      shrink: 0.55,
      fade: age => Math.min(1, age * 8) * (1 - age),
      ramp: ['#fff6c8', '#ffd24a', '#ff8a1c', '#f0420c', '#8f1602', '#3a0a02'],
      secondaryChance: 0.03,   // sparks
      secondaryColor: '#ffd98a',
    },
    ice: {
      emitter: 'fall',
      rate: 0.08,              // particles per second per px of width
      fall: [45, 120],         // px/s, far flakes to near flakes
      size: [1.2, 3.8],
      rise: 0,
      wobble: 10,
      shrink: 0,
      fade: age => Math.min(1, age * 10, (1 - age) * 10),
      wind: t => 40 + 50 * Math.sin(t * 0.45),
      ramp: ['#ffffff'],
      secondaryChance: 0.12,   // wind streaks
      secondaryColor: '#cfefff',
    },
  };

  let canvas = null;
  let ctx = null;
  let stopGl = null;
  let area = null;
  let container = null;
  let effectName = null;
  let effect = null;
  let sprites = [];
  let secondarySprite = null;
  let frameId = 0;
  let lastTime = 0;
  let clock = 0;
  let spawnDebt = 0;
  let originX = 0;
  let originY = 0;
  let viewW = 0;
  let viewH = 0;
  let observer = null;

  const px = new Float32Array(MAX_PARTICLES);
  const py = new Float32Array(MAX_PARTICLES);
  const vx = new Float32Array(MAX_PARTICLES);
  const vy = new Float32Array(MAX_PARTICLES);
  const life = new Float32Array(MAX_PARTICLES);
  const maxLife = new Float32Array(MAX_PARTICLES);
  const halfW = new Float32Array(MAX_PARTICLES);
  const halfH = new Float32Array(MAX_PARTICLES);
  const opacity = new Float32Array(MAX_PARTICLES);
  const phase = new Float32Array(MAX_PARTICLES);
  const secondary = new Uint8Array(MAX_PARTICLES);
  const FIELDS = [px, py, vx, vy, life, maxLife, halfW, halfH, opacity, phase, secondary];
  let count = 0;

  const point = { x: 0, y: 0, nx: 0, ny: 0, s: 0 };

  function _makeSprite(color) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = SPRITE_SIZE;
    const g = sprite.getContext('2d');
    const half = SPRITE_SIZE / 2;
    const gradient = g.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.35, color + 'b0');
    gradient.addColorStop(1, color + '00');
    g.fillStyle = gradient;
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    return sprite;
  }

  function _range(pair) {
    return pair[0] + Math.random() * (pair[1] - pair[0]);
  }

  /** Random point on a rounded rectangle's outline, with its outward normal. */
  function _samplePerimeter(w, h, r) {
    const sw = w - 2 * r;
    const sh = h - 2 * r;
    const arc = Math.PI * r / 2;
    let t = Math.random() * (2 * sw + 2 * sh + 4 * arc);
    point.s = t;
    const corner = (cx, cy, startAngle) => {
      const a = startAngle + t / r;
      point.nx = Math.cos(a);
      point.ny = Math.sin(a);
      point.x = cx + r * point.nx;
      point.y = cy + r * point.ny;
    };
    if (t < sw) { point.x = r + t; point.y = 0; point.nx = 0; point.ny = -1; return; }
    t -= sw;
    if (t < arc) { corner(w - r, r, -Math.PI / 2); return; }
    t -= arc;
    if (t < sh) { point.x = w; point.y = r + t; point.nx = 1; point.ny = 0; return; }
    t -= sh;
    if (t < arc) { corner(w - r, h - r, 0); return; }
    t -= arc;
    if (t < sw) { point.x = w - r - t; point.y = h; point.nx = 0; point.ny = 1; return; }
    t -= sw;
    if (t < arc) { corner(r, h - r, Math.PI / 2); return; }
    t -= arc;
    if (t < sh) { point.x = 0; point.y = h - r - t; point.nx = -1; point.ny = 0; return; }
    t -= sh;
    corner(r, r, Math.PI);
  }

  function _spawnBorder(w, h) {
    _samplePerimeter(w, h, CORNER_RADIUS);
    // Flames under the grid would rise across the player's tiles, so keep them short.
    const downward = Math.max(0, point.ny);
    // Drifting waves along the border gather particles into licking tongues.
    const tongue = 0.55 + 0.45 * Math.sin(point.s * 0.045 + clock * 3.1) * Math.sin(point.s * 0.013 - clock * 1.7);
    const scale = (1 - 0.6 * downward) * (0.5 + tongue);
    const i = count++;
    const speed = _range(effect.spread);
    secondary[i] = Math.random() < effect.secondaryChance ? 1 : 0;
    px[i] = point.x;
    py[i] = point.y;
    vx[i] = point.nx * speed;
    vy[i] = point.ny * speed - (secondary[i] ? 60 : 0);
    maxLife[i] = life[i] = _range(effect.life) * (secondary[i] ? 2.2 : scale);
    if (secondary[i]) {
      halfW[i] = halfH[i] = 2.2;
      opacity[i] = 2.5;
    } else {
      halfW[i] = _range(effect.size) * (0.6 + 0.4 * scale);
      halfH[i] = halfW[i] * effect.stretch;
      opacity[i] = 0.85;
    }
  }

  function _spawnFall() {
    const i = count++;
    const gust = effect.wind(clock) / 90;
    secondary[i] = Math.random() < effect.secondaryChance * gust ? 1 : 0;
    if (secondary[i]) {
      px[i] = -120;
      py[i] = Math.random() * viewH;
      vx[i] = 520 + Math.random() * 420;
      vy[i] = -10 + Math.random() * 35;
      maxLife[i] = life[i] = (viewW + 240) / vx[i];
      halfW[i] = 40 + Math.random() * 70;
      halfH[i] = 1 + Math.random() * 1.2;
      opacity[i] = 0.14 + Math.random() * 0.2;
      return;
    }
    const depth = Math.random();
    px[i] = Math.random() * viewW * 1.3 - viewW * 0.3; // wind carries flakes rightward
    py[i] = -8;
    vx[i] = -8 + Math.random() * 16;
    vy[i] = effect.fall[0] + depth * (effect.fall[1] - effect.fall[0]);
    maxLife[i] = life[i] = (viewH + 16) / vy[i];
    halfW[i] = halfH[i] = effect.size[0] + depth * (effect.size[1] - effect.size[0]);
    opacity[i] = 0.45 + depth * 0.5;
  }

  function _layout() {
    if (!canvas || !container.offsetWidth) return;
    let left = 0;
    let top = 0;
    viewW = area.clientWidth;
    viewH = area.clientHeight;
    originX = originY = 0;
    if (effect.emitter === 'border') {
      left = Math.max(0, container.offsetLeft - MARGIN);
      top = Math.max(0, container.offsetTop - MARGIN);
      const right = Math.min(
        Math.max(area.clientWidth, container.offsetLeft + container.offsetWidth),
        container.offsetLeft + container.offsetWidth + MARGIN
      );
      const bottom = Math.min(
        Math.max(area.clientHeight, container.offsetTop + container.offsetHeight),
        container.offsetTop + container.offsetHeight + MARGIN
      );
      viewW = right - left;
      viewH = bottom - top;
      originX = container.offsetLeft - left;
      originY = container.offsetTop - top;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.left = left + 'px';
    canvas.style.top = top + 'px';
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(viewH * dpr)) {
      canvas.width = Math.round(viewW * dpr);
      canvas.height = Math.round(viewH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function _frame(now) {
    frameId = window.requestAnimationFrame(_frame);
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    if (!container.offsetWidth) return; // game screen hidden
    clock += dt;

    const w = container.offsetWidth;
    const h = container.offsetHeight;
    const border = effect.emitter === 'border';
    spawnDebt += effect.rate * (border ? 2 * (w + h) : viewW) * dt;
    while (spawnDebt >= 1) {
      if (count < MAX_PARTICLES) { if (border) _spawnBorder(w, h); else _spawnFall(); }
      spawnDebt--;
    }
    const wind = effect.wind ? effect.wind(clock) : 0;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = count - 1; i >= 0; i--) {
      life[i] -= dt;
      if (life[i] <= 0) {
        const last = --count;
        for (const field of FIELDS) field[i] = field[last];
        continue;
      }
      vy[i] -= effect.rise * dt;
      px[i] += (secondary[i] ? vx[i] : vx[i] + wind + Math.sin(clock * 9 + phase[i]) * effect.wobble) * dt;
      py[i] += vy[i] * dt;

      const age = 1 - life[i] / maxLife[i];
      const scale = secondary[i] ? 1 : 1 - age * effect.shrink;
      const sprite = secondary[i]
        ? secondarySprite
        : sprites[Math.min(sprites.length - 1, Math.floor(age * sprites.length))];
      ctx.globalAlpha = Math.min(1, effect.fade(age) * opacity[i]);
      ctx.drawImage(
        sprite,
        originX + px[i] - halfW[i] * scale, originY + py[i] - halfH[i] * scale,
        halfW[i] * scale * 2, halfH[i] * scale * 2
      );
    }
    ctx.globalAlpha = 1;
  }

  function _startCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'grid-fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d');
    area.appendChild(canvas);
    sprites = effect.ramp.map(_makeSprite);
    secondarySprite = _makeSprite(effect.secondaryColor);

    if (typeof ResizeObserver !== 'undefined') {
      observer = observer || new ResizeObserver(_layout);
      observer.observe(area);
      observer.observe(container);
    } else {
      window.addEventListener('resize', _layout);
    }
    _layout();
    for (let i = 0; i < MAX_PARTICLES; i++) phase[i] = Math.random() * Math.PI * 2;
    lastTime = window.performance.now();
    frameId = window.requestAnimationFrame(_frame);
  }

  function _stop() {
    if (frameId) window.cancelAnimationFrame(frameId);
    frameId = 0;
    count = 0;
    spawnDebt = 0;
    if (observer) observer.disconnect();
    if (canvas) canvas.remove();
    canvas = ctx = null;
    if (stopGl) stopGl();
    stopGl = null;
  }

  function _start(name) {
    _stop();
    effectName = EFFECTS[name] ? name : null;
    effect = EFFECTS[name] || null;
    if (!effect) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    area = document.getElementById('grid-area');
    container = document.getElementById('grid-container');
    if (!area || !container) return;

    if (getPreferredRenderer() === 'webgl' && typeof GridFxGl !== 'undefined') {
      // Falls back to Canvas 2D if the effect has no shader or the GPU context is lost.
      stopGl = GridFxGl.start(effectName, area, container, () => { stopGl = null; _startCanvas(); });
      if (stopGl) return;
    }
    _startCanvas();
  }

  /** Start the named effect around the grid, or stop effects when the name is falsy. */
  function setEffect(name) {
    const next = EFFECTS[name] ? name : null;
    if (next === effectName && (canvas || stopGl || !next)) return;
    _start(next);
  }

  function getPreferredRenderer() {
    return localStorage.getItem(RENDERER_KEY) === 'webgl' ? 'webgl' : 'canvas';
  }

  /** Renderer currently drawing the effect: 'webgl', 'canvas', or null when idle. */
  function getActiveRenderer() {
    return stopGl ? 'webgl' : canvas ? 'canvas' : null;
  }

  function setRenderer(renderer) {
    localStorage.setItem(RENDERER_KEY, renderer === 'webgl' ? 'webgl' : 'canvas');
    _start(effectName);
    return getActiveRenderer();
  }

  return { setEffect, setRenderer, getPreferredRenderer, getActiveRenderer };
})();
