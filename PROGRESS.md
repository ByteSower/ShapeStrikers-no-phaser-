# Shape Strikers (Vanilla Web) — Progress Tracker

> **Version**: `shape_strikers_web` (vanilla HTML/CSS/JS — NO framework/engine)
> **Repo**: `games/shape_strikers_web/`
> **Live**: [Play Now](https://bytesower.github.io/ShapeStrikers-no-phaser-/)
> **Last Updated**: April 16, 2026

---

## Current Stats

| Metric | Value |
|--------|-------|
| Source lines | ~7,700 (JS + CSS + HTML) |
| Source files | 8 JS modules, 1 CSS, 1 HTML |
| Dependencies | **Zero** — fully vanilla |
| Units | 38 (33 playable + 5 bosses) |
| Elements | 6 (Fire, Ice, Lightning, Earth, Arcane, Void) |
| Status effects | 10 |
| Upgrades | 10 |
| Achievements | 10 |
| Waves | 15 (Normal) / 25 (Void Campaign) |
| Bosses | 5 (W5, W10, W15, W20, W25) |

---

## ✅ Completed Phases

### Phase 1 — Core Game
- [x] 6×5 grid, shop, placement, selling, movement
- [x] 33 playable units + 3 bosses, 6 elements, 15 waves
- [x] Turn-based battle system with abilities & status effects
- [x] Elemental synergies (2+ same element = stat bonus)
- [x] Boss phases (Chaos Overlord W15: 3 phases with HP reset)
- [x] Void element (enemy-exclusive, unlock after win)
- [x] Unit glossary with portraits, stats, abilities, roles
- [x] Guided onboarding / tutorial system
- [x] Tabbed guidebook (Basics, Combat, Elements, Tips)
- [x] 6 upgrades (Army Expansion, Field Medic, Bargain Hunter, War Chest, Victory Bonus, Refresh Master)
- [x] Dark mode toggle
- [x] Mobile layout support
- [x] Splash screen with contributors
- [x] Audio system (title music, battle SFX, ability sounds)

### Phase 2 — Status Effects & Balance
- [x] 10 status effects: burn, poison, freeze, slow, shield, barrier, weaken, wound, untargetable, blind
- [x] Max stack caps for all effects
- [x] Healer skip when allies full HP
- [x] Range targeting fix + shop selection cancel
- [x] Void units in glossary with unlock gating

### Phase 3 — New Units & Mechanics
- [x] 5 new units: Arcane Pupil (T1), Earth Enforcer (T2), Lightning Hunter (T2), Fire Ravager (T2), Arcane Illusionist (T3)
- [x] 4 new mechanics: Evolve (stat growth), Knockback, Pull, Kill-stacking

### Phase 4 — Visual Polish & QOL
- [x] Unit idle breathing animation (CSS keyframe + random delay)
- [x] Element-colored damage numbers with glow
- [x] Speed controls (½× / 1× / 2× / 4×)
- [x] Ranged projectile animations
- [x] Synergy activation VFX pulse
- [x] Boss entrance cinematic overlay
- [x] Wave preview tooltip (enemy scout)
- [x] Post-battle & game-over stats summary
- [x] Keyboard shortcuts (B=Battle, R=Refresh, N=Next, 1-4=Speed, Esc=Cancel)
- [x] Sell confirmation popup (right-click → confirm)
- [x] Status effect hover descriptions
- [x] Color-coded shop card mini-stats
- [x] Victory/game-over/result overlay gradients
- [x] Free unit repositioning during shop phase

### Phase 5 — VFX System
- [x] CSS particle engine with object pooling (`_spawnPooled`)
- [x] Element-specific VFX: burnSpread, freezeBurst, voidRupture, poisonCloud, healAoE
- [x] Shockwave effect (small/medium/large, element-colored)
- [x] Projectile system with travel animation
- [x] Screen shake (light/medium/heavy) and screen flash (damage/heal/phase)
- [x] Shield dome and tendril effects
- [x] Boss-specific VFX triggers for all 5 bosses
- [x] `src/vfx.js` — 508 lines, fully self-contained module

### Phase 6 — UI/UX Overhaul (~85% done, remaining deferred)

### Phase 7A — Void Campaign / Hard Mode
- [x] Campaign mode selector on title screen (Normal 15 waves vs Void 25 waves)
- [x] 2 new void bosses: Void Leviathan (W20, 2 phases), Void Architect (W25, 3 phases)
- [x] 10 new wave templates (W16-24) with escalating difficulty
- [x] Hard mode stat scaling (W16: 1.15× HP → W25: 2.0× HP, 1.6× ATK)
- [x] Boss phaseHp scaled with hard mode multipliers
- [x] Void units available to players in void campaign
- [x] Dark purple grid theme for void campaign
- [x] Void-themed win overlay + Void Conqueror badge
- [x] Dynamic tutorial text (15 vs 25 waves)

### Phase 7B — Meta-Progression & Unlocks
- [x] Achievement system — 10 achievements tracked in localStorage with overlay UI
- [x] Achievement badges displayed on title screen with progress counter
- [x] Post-game per-unit accolades (🌟 MVP, 💀 Executioner, 💚 Lifeline)
- [x] Per-unit kill tracking — kills attributed via battle callback with killer param
- [x] Battle participants snapshot — dead units now appear in stats with ☠️ marker
- [x] Enhanced stats table — added Kills column + accolade badges
- [x] 4 new upgrades: Scout's Intel, Elite Training, Mercenary, Double Edge
- [x] Scout's Intel — L1: enemy HP/ATK/DEF in wave preview, L2: abilities
- [x] Elite Training — +5% ATK & DEF per level (applied/removed at battle start/end)
- [x] Mercenary — +1 shop card per refresh per level
- [x] Double Edge — +20% ATK, −10% DEF (risk/reward)
- [x] Player loss tracking per-battle and per-run (Untouchable & Flawless achievements)

### Phase 7C — Daily / Weekly Challenges
- [x] Seeded daily challenge — deterministic wave composition via `_mulberry32(seed)`
- [x] Weekly modifier challenges — 8 modifiers: Inferno, Frozen Front, No Mercy, Glass Cannon, Budget Run, Fragile, Purity, Titan Wave
- [x] Challenge overlay UI — daily/weekly cards with stats, best score, attempts, play buttons
- [x] Challenge HUD label — shows "📅 Daily" or "📆 🔥 Weekly" + modifier icon during battles
- [x] Challenge save/load — localStorage per day/week with bestScore, attempts, completed
- [x] Challenge-safe unlocks — challenges don't grant campaign unlocks or achievements
- [x] Title screen challenge badges — shows ✅ for completed daily/weekly

### Phase 8 — Backend & Leaderboards ✨ LATEST
- [x] Supabase integration (PostgreSQL + anonymous auth via CDN)
- [x] `src/backend.js` — IIFE module: init, auth, submitScore, fetchGlobal/Challenge/Personal
- [x] Anonymous sign-in — no account required, sessions persist via Supabase auth
- [x] Leaderboard overlay — Global / Daily / Weekly / Personal tabs
- [x] Score submission UI in game-over and win overlays (name input + submit)
- [x] Player name saved to localStorage, pre-filled on subsequent games
- [x] RLS policies — public read, authenticated insert (own rows only)
- [x] Graceful degradation — game fully playable if backend unavailable
- [x] Supabase schema provided (`supabase_schema.sql`)
- [x] Patch notes system — `PATCH_NOTES` array in config.js, "What's New" overlay on title screen

---

## 🗺️ Roadmap

### Backlog — Feature Ideas (User Approved with Caveats)
- [ ] Elemental reactions (Fire+Ice=Steam, etc.) — "only if clear visual feedback"
- [ ] Unit merging — "only if intuitive, robust, animated"
- [ ] Item/equipment system — "may need separate UI"
- [ ] New enemy units that sacrifice allies to buff self
- [ ] Fill T3 gaps (Lightning has 0 T3 units)

### Backlog — Architecture
- [ ] Event bus to replace direct callbacks in battle.js
- [ ] Split config.js into units.js, waves.js, upgrades.js
- [ ] State serialization — save/resume mid-run

### Deferred — Accessibility
- [ ] Flash warnings for 4× speed
- [ ] Settings consolidation
- [ ] ARIA labels on key buttons

---

## localStorage Keys

| Key | Purpose | Set When |
|-----|---------|----------|
| `shape_strikers_void_unlocked` | Unlock void faction + void campaign | First game win |
| `shape_strikers_arcane_unlocked` | Unlock arcane faction in shop | First game win |
| `shape_strikers_dark_mode` | Persist dark mode preference | Toggle in title |
| `shape_strikers_encountered_bosses` | JSON array of boss IDs seen | During battle |
| `shape_strikers_void_campaign_cleared` | Void Conqueror badge | Beat void campaign |
| `shape_strikers_achievements` | JSON object of unlocked achievements | On achievement unlock |
| `shape_strikers_daily_challenge` | JSON: `{ "YYYY-MM-DD": { bestScore, attempts, completed } }` | On challenge end |
| `shape_strikers_weekly_challenge` | JSON: `{ "YYYY-WNN": { bestScore, attempts, completed } }` | On challenge end |
| `shape_strikers_player_name` | Leaderboard display name (max 20 chars) | On first score submit |

---

## Bug Fixes Log

| Bug | Fix | Phase |
|-----|-----|-------|
| Double screen shake | Guard flag | 4 |
| Healing decimal spam | Math.round | 4 |
| Boss text overlap | Proper phase banner | 4 |
| Synergy hover stuck | Auto-dismiss | 4 |
| VFX transition timing | `void el.offsetWidth` force-layout | 5 |
| Void button always visible | Generic `.hidden` CSS rule | 7A |
| Boss phaseHp not scaled in hard mode | Scale with HARD_MODE_SCALING | 7A |
| Tutorial "15 waves" in void campaign | Getter-based dynamic text | 7A |

---

## Source File Map

| File | Lines | Role |
|------|------:|------|
| `src/game.js` | 1,967 | State, wave flow, shop, battle wiring, tutorial, leaderboard |
| `src/config.js` | 996 | Units, elements, waves, upgrades, bosses, scaling, patch notes |
| `src/battle.js` | 786 | Turn-based combat logic (pure, no DOM) |
| `src/grid.js` | 543 | Canvas rendering, placement, animation |
| `src/vfx.js` | 508 | CSS particle VFX engine |
| `src/ui.js` | 439 | DOM overlays, HUD, shop UI |
| `src/backend.js` | 193 | Supabase client, auth, leaderboard API |
| `src/audio.js` | 108 | Sound pool management |
| `style.css` | 1,771 | Layout, animations, responsive, themes |
| `index.html` | 354 | Entry point, screens, overlays |

---

## How to Run

```bash
cd games/shape_strikers_web
python3 -m http.server 8000   # or: npx serve .
```

Open `http://localhost:8000`