# Shape Strikers (Vanilla Web) — Progress Tracker

> **Version**: `shape_strikers_web` (vanilla HTML/CSS/JS — NO Phaser)  
> **Repo**: `games/shape_strikers_web/`  
> **⚠️ Do NOT reference** `games/elemental_arena/` feedback — that's the OLD Phaser version.

---

## Committed Features (in `main`)

- [x] Core auto-battler: 6×5 grid, shop, placement, selling, movement
- [x] 31 units (28 playable + 3 bosses), 6 elements, 15 waves
- [x] Turn-based battle system with abilities & status effects
- [x] Elemental synergies (2+ same element = stat bonus)
- [x] Boss phases (Chaos Overlord W15: 3 phases)
- [x] Void element (enemy-exclusive, unlock after win)
- [x] Unit glossary with portraits, stats, abilities, roles
- [x] Guided onboarding / tutorial
- [x] Tabbed guidebook (Basics, Combat, Elements, Tips)
- [x] Upgrades system (Army Expansion, Logistics, Banking, Field Medic, Frontline Boost, Lucky Draw)
- [x] Dark mode toggle
- [x] Mobile layout support
- [x] Splash screen with contributors
- [x] Audio system (title music, battle SFX, ability sounds)
- [x] Animation-aware battle (actions wait for animations)
- [x] Status icons with visual auras (burn, freeze, barrier, etc.)
- [x] Battle VFX: heal burst, freeze/ghost effects, status auras
- [x] Max stack caps for status effects
- [x] Healer skip when allies full HP
- [x] Range targeting fix + shop selection cancel
- [x] Click selected unit to deselect
- [x] Void units in glossary with unlock gating
- [x] 4 status effect bug fixes (wound halves healing, untargetable blocks abilities, freeze stacks, lateral movement)

---

## Batch 1 — Visual Polish & QOL (uncommitted, ready to commit)

### Visual Features
- [x] Unit idle breathing animation (CSS keyframe + random delay)
- [x] Element-colored damage numbers (glow matches element)
- [x] 4× speed button (½× / 1× / 2× / 4× controls)
- [x] Ranged projectile animations (`animateProjectile`)
- [x] Synergy activation VFX pulse (`animateSynergyPulse`)
- [x] Boss entrance cinematic overlay (`_showBossIntro`)
- [x] Wave preview tooltip on hover (enemy scout)
- [x] Post-battle & game-over stats summary
- [x] Keyboard shortcuts (B=Battle, R=Refresh, N=Next, 1-4=Speed, Esc=Cancel)

### QOL Improvements
- [x] Sell confirmation popup (right-click → confirm)
- [x] Double screen shake prevention guard
- [x] Status effect hover descriptions (9 effects)
- [x] Color-coded shop card mini-stats (ATK/DEF/HP/SPD)
- [x] Victory overlay green gradient
- [x] Game-over overlay red gradient
- [x] Result overlay blue accent
- [x] Healing decimal display fix (Math.round)
- [x] Keyboard shortcuts section in help overlay

---

## Batch 2 — Next Up (approved by user, not started)

### High Priority
- [ ] More diverse upgrades — expand beyond current 6. Audit suggested:
  - Scout's Intel — See the next wave composition before buying
  - Elite Training — Units gain +1 stat per wave survived
  - Mercenary Contract — Unlock 1 random Void unit in the shop
  - Double Edge — +20% ATK but -10% DEF for all units
- [ ] Enhanced game-over stats with per-unit accolades (MVP, most damage, most healed, longest survivor, etc.)
- [x]Free unit repositioning during shop phase (audit #15 — currently must sell+rebuy to move)

### Medium Priority — Bigger Features (user approved with caveats)
- [ ] Elemental reactions system (Fire+Ice=Steam, Lightning+Ice=Shatter, Earth+Arcane=Crystallize) — user removed from Phaser version because "players didn't understand what they did visually." Only re-add if we can represent them better with clear visual feedback
- [ ] Unit merging system — "only if we can make it an actual likeable intuitive, robust, animated system"
- [ ] Item/equipment system — "might need to rework some angles" or "build entire new UI's players can transition to so we wont clutter the main game"
- [ ] Fill Tier 3 gaps — Lightning has 0 T3 units, Earth only has 2 (audit #4)

### Lower Priority
- [ ] Sprite icon integration (icons added to `public/sprites/Icons_Sprites/`)

### Architecture (when needed, not urgent)
- [ ] Event bus to replace direct callbacks in battle.js (audit #1)
- [ ] Split config.js into units.js, waves.js, upgrades.js (audit #2)
- [ ] State serialization — save/resume mid-run via localStorage (audit #3)

---

## User Feedback Items (from play-testing THIS version)

> Items below were raised during testing. Check off when addressed.

### Bugs
- [x] Double screen shake — fixed (guard flag in Batch 1)
- [x] Huge decimal when healing — fixed (Math.round in Batch 1)
- [x] Multiple boss text overlap (phase text stacking)
- [x] Synergy description hover container doesn't go away sometimes
- [x] Synergy bonus doesn't apply to all player units
- [x] Hover text spam

### Balance
- [x] Fire mini boss gating — remove from W5 first playthrough, add after game completion
- [x] Void Horror ability damage nerf + Void Rapture animation
- [x] Slightly increase gold per wave (currently 7)
- [x] Arcane/Void units unlock gating (Arcane after 1st win, Void after 2nd)

### UI/UX
- [x] Barrier ability indicator (visual feedback)
- [x] Boss tab in unit glossary
- [x] Top bar tracker/glossary layout fix
- [x] Upgrade bonuses display
- [x] Title screen rescaling support

### Design Discussions (no action yet)
- [x] Ability refresh on wave start vs status carry-over — decide philosophy
- [x] New unit factions / deck system after game completion
- [ ] New enemy units that sacrifice weaker allies to buff self
- [ ] Backend setup scope (what will it handle?)

---

## Notes

- **Two versions exist** — don't mix them up:
  - `games/elemental_arena/` → Phaser 3 version (archived / separate development)
  - `games/shape_strikers_web/` → Vanilla web version (**THIS one**)
- User feedback file at `elemental_arena/USER_FEEDBACK_REVIEW.md` is for the **Phaser version** — some items overlap but balance values differ
- Run with: `cd games/shape_strikers_web && npx serve .` (or `python3 -m http.server 3001`)
- Original audit: 19 suggestions total, Batch 1 covered #9-14, #16-19; Batch 2 covers #5-8, #15 + enhanced stats
