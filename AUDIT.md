# Shape Strikers — Codebase Audit

**Date:** April 15, 2026  
**Scope:** Full audit of vanilla JS web game (no engine/framework)  
**Status:** Post-Phase 7A (Void Campaign / Hard Mode)

---

## 1. Project Summary

| Metric | Value |
|--------|-------|
| Total source lines | **5,662** (JS) + 1,614 (CSS) + 285 (HTML) = **~6,561** |
| Source files | 7 JS modules, 1 CSS, 1 HTML |
| Dependencies | **Zero** — fully vanilla HTML/CSS/JS |
| Deploy target | GitHub Pages (static) |
| Asset size | 45 MB (`public/`) — 23 MB sprites, 18 MB audio |

### Source File Breakdown

| File | Lines | Role |
|------|------:|------|
| `src/game.js` | 1,362 | State, wave flow, shop, battle wiring, tutorial |
| `src/config.js` | 916 | Unit defs, elements, waves, upgrades, bosses, scaling |
| `src/battle.js` | 786 | Turn-based combat logic (pure, no DOM) |
| `src/grid.js` | 543 | Canvas rendering, placement, animation |
| `src/vfx.js` | 508 | CSS particle VFX engine |
| `src/ui.js` | 439 | DOM overlays, HUD, shop UI |
| `src/audio.js` | 108 | Sound pool management |

---

## 2. Architecture Assessment

### Strengths

- **Clean module separation** — IIFE/class pattern keeps each system isolated. `BattleSystem` is fully pure-logic (zero DOM access), communicating through 12 well-defined callbacks.
- **Zero dependencies** — no build step, no npm, no bundler. `index.html` loads 6 scripts. Serves from any static host.
- **Procedural rendering** — units are Canvas-drawn shapes (only 792 KB of shape sprites), keeping character assets lightweight vs. typical sprite-heavy games.
- **No debug artifacts** — zero `console.log`, `debugger`, or `TODO`/`FIXME` comments found in any source file.
- **Good commit hygiene** — 23 focused commits with descriptive messages. Bug fixes, features, and docs are separate commits.

### Architecture Diagram

```
index.html
  ├── style.css          (1,614 lines — layout, animations, responsive, themes)
  ├── src/config.js      (data: units, elements, synergies, waves, upgrades, scaling)
  ├── src/audio.js       (Audio pool, volume, play/stop)
  ├── src/battle.js      (BattleSystem class — pure logic, callback-driven)
  ├── src/grid.js        (Canvas grid, unit drawing, tile effects)
  ├── src/vfx.js         (CSS particle VFX engine, pooled effects, shockwaves)
  ├── src/ui.js          (DOM overlays: shop, glossary, guidebook, HUD)
  └── src/game.js        (Game IIFE — state machine, wiring, flow control)
```

**Data flow:** `config → game → battle → callbacks → grid/ui/audio`

---

## 3. Code Quality

### Syntax & Errors
- All 6 JS files pass `node --check` with zero errors.
- No TypeScript, no linter configured — relies on clean manual discipline.

### Patterns Used
- **Frozen enums** — `Object.freeze({...})` for Element, Trait, Status
- **Callback wiring** — BattleSystem uses 12 named callbacks instead of events
- **State reset** — `_freshState()` returns a clean object each game
- **Speed tracking** — `_currentSpeedMult` persists across waves

### Potential Concerns

| Area | Observation | Severity | Recommendation |
|------|-------------|----------|----------------|
| `game.js` size | 1,251 lines with shop, battle wiring, UI wiring all mixed | Low | Consider extracting shop logic (~200 lines) into `src/shop.js` |
| `config.js` size | 783 lines of data + logic mixed | Low | Could split into `units.js`, `waves.js`, `upgrades.js` for maintainability |
| Global scope | Each script declares globals (`Element`, `Game`, `Grid`, etc.) | Low | Works via load-order in `index.html`; no conflicts found. ES modules would formalize this but add build step |
| No error boundaries | No try/catch around battle loop or animation scheduling | Low | Battle loop is stable; add guards if adding async features |
| Callback count | 12 callbacks on BattleSystem | Medium | An EventEmitter/bus pattern would simplify wiring and make extension easier |

---

## 4. Game Systems Review

### Battle System (`battle.js`)
- **Quality: Excellent** — pure logic, zero side effects, callback-driven
- Supports 10 status effects with max-stack caps
- 5 boss fights with multi-phase transitions (including HP-reset phases)
- Hard mode stat scaling for waves 16–25
- Action queue with speed-based turn ordering
- Healers skip ability when all allies full HP (smart optimization)

### Grid System (`grid.js`)
- **Quality: Good** — Canvas-based rendering with smooth animations
- 6×5 lane grid, unit placement on player rows (bottom 2)
- Death animations, status auras, freeze/ghost effects
- Unit movement and attack lunge animations

### UI System (`ui.js`)
- **Quality: Good** — handles all overlays and HUD
- Shop rendering, unit detail panel, glossary, guidebook
- Splash screen with contributors
- 88 CSS animations/transitions for polish

### Audio System (`audio.js`)
- **Quality: Good** — lightweight pool-based playback
- Handles browser autoplay restrictions with fallback triggers

### Config (`config.js`)
- 38 unit definitions (33 playable + 5 bosses) across 4 tiers and 6 elements
- Seeded wave generator for variety (25 wave templates for Void Campaign)
- 6 upgrade types (Army Expansion, Field Medic, Bargain Hunter, War Chest, Victory Bonus, Refresh Master)
- Hard mode scaling table (waves 16–25)
- Boss phase definitions with HP resets and stat multipliers

### VFX System (`vfx.js`)
- **Quality: Good** — CSS particle engine with object pooling
- Element-specific effects (burn, freeze, void, poison, heal)
- Shockwaves, projectiles, screen shake, screen flash
- Boss-specific VFX triggers for all 5 bosses

---

## 5. Performance

| Area | Status | Notes |
|------|--------|-------|
| File sizes | ✅ | ~6.6 KB total JS (unminified). Minimal overhead |
| Canvas rendering | ✅ | Only redraws on state changes, not continuous loop |
| Animation | ✅ | CSS transitions + requestAnimationFrame; 88 animation rules |
| Asset loading | ⚠️ | 45 MB total in `public/`. No lazy loading. Acceptable for desktop, may be slow on mobile |
| Memory | ✅ | Unit objects are plain JS. No leaks detected in patterns |
| Battle tick | ✅ | Async round scheduling with `setTimeout`; non-blocking |

### Asset Optimization Opportunities

| Asset | Size | Action |
|-------|-----:|--------|
| `public/sprites/` | 23 MB | Some VFX sprite folders may be unused — verify and prune |
| `public/audio/` (Audio/) | 18 MB | Many dungeon SFX files (chest_open, crate, sack) unlikely used in auto-battler — audit usage |
| Shape sprites | 792 KB | Core gameplay sprites — already optimized |
| Background images | ~4 MB | Consider WebP conversion for 40-60% savings |

---

## 6. Security

| Check | Status |
|-------|--------|
| No `eval()` or `innerHTML` with user input | ✅ Clean |
| No external scripts or CDN loads | ✅ Fully self-contained |
| No API calls or network requests | ✅ Offline-capable |
| localStorage usage | ✅ | 5 keys for unlocks, settings, badges (see PROGRESS.md) |
| No user-generated content | ✅ No injection vectors |

**Verdict:** Minimal attack surface. Static game with no server component.

---

## 7. Mobile & Responsiveness

- Dedicated responsive CSS (`@media` queries present)
- Commit `f334b0a` specifically overhauled mobile layout
- `viewport` meta prevents zoom: `maximum-scale=1.0, user-scalable=no`
- **Area to watch:** 45 MB asset load on mobile networks

---

## 8. Documentation

| Document | Status | Notes |
|----------|--------|-------|
| `README.md` | ✅ Complete | Features, how to play, running locally, tech stack |
| `GAME_DESIGN.md` | ✅ Present | Game design document |
| `PROGRESS.md` | ✅ Present | Development progress, phases, roadmap, bug log |
| `CONTRIBUTING.md` | ❌ Missing | Lives in the Phaser version (`elemental_arena/`), not here |
| In-game guidebook | ✅ | 4-tab guide covering Basics, Combat, Elements, Tips |
| Code comments | ✅ | Section headers in all files, JSDoc on key functions |

---

## 9. Recommendations

### Priority 1 — Quick Wins

1. **Audit unused assets** — Run a grep of all audio/sprite filenames against the JS source. Remove unreferenced files from `public/` to reduce deploy size.
2. **Add `.gitignore` for dist/** — The `dist/` folder (30 MB) appears committed. If it's a build artifact, exclude it.
3. **Minify for production** — A simple build script (`terser` one-liner) could cut JS payload. Not critical now but useful as traffic grows.

### Priority 2 — Maintainability

4. **Split `config.js`** — Separate unit definitions, wave configs, and upgrade data into individual files. Easier to edit as content grows.
5. **Extract shop logic from `game.js`** — Shop buy/sell/refresh is ~200 lines that could live in `src/shop.js`.
6. **Add EventEmitter** — Replace the 12 direct callback assignments on `BattleSystem` with a lightweight event bus (~30 lines). Makes adding new visual effects or logging much easier.

### Priority 3 — Future Features

7. **Backend prep (leaderboards/saves)** — Start with localStorage-based save states as a proof-of-concept. When ready for a server, a simple REST API (Node/Express or serverless) for:
   - Score submission / leaderboard
   - Save/load game state
   - Player accounts (optional)
8. **Enhanced stats tracking** — `_battleStats` and `_gameStats` already exist in `game.js`. Surface them in a post-game summary screen.
9. **Unit repositioning** — Allow moving placed units between waves (infrastructure exists with `_preBattlePositions`).
10. **Accessibility** — Add ARIA labels to key buttons, keyboard navigation for shop/grid.

### Not Recommended

- **Migrating to a framework/engine** — The vanilla approach works well for this scope. Adding React/Phaser would increase complexity without proportional benefit.
- **TypeScript conversion** — The codebase is small and clean enough that TS overhead isn't justified currently.
- **Database for game data** — Config-as-code is the right choice at this scale.

---

## 10. Health Verdict

| Category | Grade | Notes |
|----------|:-----:|-------|
| Code Quality | **A** | Clean, no debug code, good separation |
| Architecture | **A-** | Solid modules; callback count getting high |
| Performance | **B+** | Fine for scope; asset size is the main concern |
| Documentation | **A-** | Good README and in-game docs; missing CONTRIBUTING |
| Security | **A** | No attack surface |
| Test Coverage | **C** | No automated tests (common for solo game projects) |
| **Overall** | **A-** | Healthy, well-built codebase ready for new features |

The codebase is in excellent shape for a vanilla JS game. The biggest opportunities are **asset pruning** (reducing the 45 MB payload) and **event bus refactoring** (to simplify adding new features). No urgent fixes needed.
