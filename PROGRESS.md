# Shape Strikers (Vanilla Web) — Progress Tracker

> **Version**: `shape_strikers_web` (vanilla HTML/CSS/JS — NO framework/engine)
> **Repo**: `games/shape_strikers_web/`
> **Live**: [Play Now](https://bytesower.github.io/ShapeStrikers-no-phaser-/)
> **Last Updated**: May 7, 2026

---

## Current Stats

| Metric | Value |
|--------|-------|
| Source lines | ~11,500 (JS + CSS + HTML) |
| Source files | 14 JS modules, 1 CSS, 1 HTML |
| Dependencies | **Zero** — fully vanilla |
| Units | 44 (39 playable + 5 bosses) |
| Elements | 8 (Fire, Ice, Lightning, Earth, Arcane, Void, Blood, Plague) |
| Status effects | 10 |
| Upgrades | 10 |
| Achievements | 11 |
| Waves | 15 (Normal) / 25 (Void Campaign) |
| Bosses | 5 (W5, W10, W15, W20, W25) |
| Multiplayer | ✅ Live 1v1, best-of-5, seeded shops |

---

## ✅ Completed Phases

### Phase 1 — Core Game
- [x] 6×5 grid, shop, placement, selling, movement
- [x] 39 playable units + 5 bosses, 8 elements, 15 waves
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
- [x] Achievement system — 11 achievements tracked in localStorage with overlay UI
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

### Phase 8 — Backend & Leaderboards
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

### Phase 9.1 — Multiplayer Presence & Global Chat
- [x] Supabase Realtime Presence — live online player count shown on title screen
- [x] Global real-time chat panel — floating 💬 button, bottom-left corner (all screens)
- [x] `supabaseClient.js` — singleton channel registry with connect/reconnect/visibility lifecycle
- [x] `presence.js` — refactored to delegate lifecycle to SupabaseClient
- [x] `globalChat.js` — broadcast chat with rate-limiting (2s), 50-msg buffer, XSS-safe rendering
- [x] Unread badge counter on chat toggle when panel is collapsed
- [x] Status dot (green = connected, grey = connecting)
- [x] Exponential backoff reconnect (base 2s → cap 30s, max 6 retries)
- [x] Tab visibility reconnect — channels rejoin when tab regains focus
- [x] Input sanitization: strips control chars, max 200-char messages, max 20-char names
- [x] Chat panel repositioned bottom-left to avoid overlapping in-game speed controls

### Phase 9.2 — 1v1 Multiplayer ✨ LATEST
- [x] `matchmaking.js` — queue join/leave, `join`/`join_ack` broadcast pairing, DB room creation with fallback
- [x] `room.js` — `room:{roomId}` channel, state sync via broadcast, presence-based disconnect detection (10s grace)
- [x] `multiplayerGame.js` — best-of-5 round loop, seeded shop RNG (mulberry32), gold economy, hash verification
- [x] Matchmaking overlay — Find Match / Cancel buttons, connection badge, player name display
- [x] Versus screen — animated 2.5-second VS splash with player names and Bo5 tracker
- [x] In-game MP HUD — round indicator, live score (You vs Opp), connection dot
- [x] Ready system — ✅ Ready button, 35-second countdown, auto-ready on expiry, opponent status
- [x] Seeded deterministic shops — host generates seed, broadcasts to guest; both see identical units
- [x] Reroll sync — `mp_reroll` room state keeps RNG in lock-step across both clients
- [x] Tier escalation — shops progress T1→T3 over rounds (R1: T1 only → R5: T2/T3 heavy)
- [x] Gold economy — 10G base per round + win bonus (5G) + per-surviving-unit bonus (2G), 30G carry cap
- [x] Deterministic battle RNG — `BattleSystem.setSeed()` installs mulberry32; single-player unaffected
- [x] Battle hash verification — djb2 hash of final board state broadcast and compared; desync logged to localStorage
- [x] Match end screen — Victory/Defeat/Draw with final score, Bo5 dots, Rematch + Return buttons
- [x] Quit and host-disconnect policy — explicit quits end the Bo5 immediately; guest refresh/reload stays reconnectable, but any confirmed host disconnect now ends the set for both players and returns them to title
- [x] Host cold-resume policy — stale host saved sessions are cleared on reload until a dedicated host resume flow exists
- [x] Rematch flow — room state `mp_rematch_request` handshake; both must agree
- [x] Disconnect handling — guest disconnects still use the grace notice + reconnect countdown; guest reload resume now waits longer than the room disconnect grace before self-aborting; host disconnects now terminate the match after the room disconnect hook fires; page refresh still releases realtime channels proactively before guest reconnect resume
- [x] Opponent-ready audio cue — `objective` SFX fires when opponent locks in
- [x] Opponent-ready cue dedupe — repeated ready snapshots after reconnect/resync no longer replay the ready SFX
- [x] Multiplayer lifecycle regression coverage — automated tests now cover guest saved-session resume, guest-observed host disconnect, and local host channel-loss termination
- [x] Startup hotfix — repaired a malformed `config.js` merge so the game boots and players can enter again after the latest coverage sync
- [x] Debug overlay (localhost only) — `Ctrl+Shift+D` toggles real-time Room event log panel
- [x] `supabase_schema.sql` — `mp_queue`, `mp_rooms`, `mp_room_state` tables with RLS policies

### Phase 9.3 — Multiplayer Authoritative Replay (In Progress)
- [x] Stop relying on two independent client battle sims for multiplayer presentation
- [x] Define a canonical battle package: seed, stable unit IDs, starting board snapshots, round metadata
- [x] Add battle event recording in `battle.js` so one sim can produce a deterministic action timeline
- [x] Capture host-side replay logs in multiplayer battles for the next playback step
- [x] Add a reusable `battleReplay.js` player that replays recorded events turn-by-turn
- [x] Add local playback-safe rendering via `Game.playLastMpReplay()` for validating authoritative logs in-browser
- [x] Add multiplayer playback mode that renders from recorded events instead of guest-side live combat
- [x] Drive round transitions from protocol events (`prep_end`, `battle_script_ready`, `playback_start`, `result_show`)
- [x] Add replay checkpoints / resume support for reconnects mid-battle
- [x] Add guest-side replay view transforms so both players see their own army on the near side
- [x] Recover cached replay/result payloads when a guest room channel re-subscribes after a transient disconnect
- [x] Resume hardening now covers saved guest sessions, result-show recovery, and retained older unresolved rounds after reload/reconnect
- [x] Centralized multiplayer telemetry now best-effort uploads reconnect, resync, disconnect, and desync events to Supabase `mp_telemetry_events`
- [x] Multiplayer round resets now preserve each player-owned roster while clearing temporary battle damage, statuses, and cooldowns
- [x] Multiplayer-only upgrade rules now disable economy/scouting upgrades and reset round-sensitive buffs each prep round
- [x] Player-facing multiplayer rules, reconnect expectations, and mobile-readable upgrade descriptions are now surfaced in the queue overlay and help overlay
- [x] Two-client live validation rechecked guest reload/rejoin telemetry and confirmed reconnect and recovery events arrive in the shared telemetry log
- [x] Added game-level regression coverage to confirm host matches stay reconnectable on guest disconnect while confirmed host-loss paths still terminate immediately
- [x] Battle-system audit fixes now let support healers cast without an in-range enemy when an ally is damaged, and restore Blood Knight ability lifesteal to the documented 30%
- [x] Follow-up battle audit fixes now align Fire Imp and Fire Scout burn ticks with their documented values, and make Blood Knight cleave heal from 30% of total damage instead of per-hit floor rounding
- [x] Fixed a live repro where confirmed guest disconnects during prep could fabricate a host win; prep now freezes and the ready timer resumes after reconnect
- [x] Matchmaking now falls back cleanly when optional Supabase multiplayer room tables are unavailable, and the near-term release target is explicitly locked to terminal host-loss handling on the current host-authoritative architecture
- [x] Single-player audit fixes now recheck shop affordability at placement time, apply War Chest interest before victory rewards, block upgrades outside prep, and ignore non-prep tile moves after battle
- [x] Additional unit-action audit fixes now let Ice Slime cast at its documented 2-row ability range, keep Fire Warrior hits in the same column, let Konji Shaman poison the full enemy team, and align Earth Archer and Lightning Knight freeze wording with their implemented status effect
- [x] Continued battle audit fixes now keep blocked units from sidestepping off the documented movement lanes, make Void Horror respect Weaken during Void Rupture, and teach Ice Guardian, Arcane Illusionist, Lightning Lord, Ice Empress, and Void Blighter to hit their full documented enemy roster
- [x] Clarified Blood, Plague, and Void campaign boss ability rules are now implemented for Blood Imp, Crimson Mage, Blood Lord, Plague Rat, Blight Weaver, Plague Sovereign, Void Leviathan, and Void Architect with matching regression coverage
- [x] Follow-up audit coverage now locks Ground Slam and Grapple Pull movement rules with focused regressions, and the player-facing unit-card/tutorial text has been cleaned up to match the current ability names and summaries
- [ ] Revisit stronger multiplayer authority when ranked, spectate, or broader platform targets raise the reliability bar beyond transient reconnect recovery

### Phase 9 — Audio Overhaul, Leaderboard v2 & Balance
- [x] Gameplay BGM rotates between two tracks; boss waves play dedicated boss music
- [x] "Get Ready" call triggers at shop phase start; "Enemy Spotted" on boss wave
- [x] Wave clear: random victory SFX (3 varieties); game over: jingle + cry after 1.5s
- [x] Win: "Let's Go!" fanfare; achievement unlock: objective-complete chime
- [x] Audio unlock/retry layer — blocked music and key phase cues retry after the next user gesture instead of failing silently on mobile browsers
- [x] Multiplayer music handoff — title BGM now stops when a multiplayer set begins and gameplay music starts for live and resumed matches
- [x] Mobile mute reliability — muting now silences active cloned SFX as well as current BGM during multiplayer and single-player sessions
- [x] Personal best tracking per campaign (`best_score_normal` / `best_score_void`) + high-score SFX
- [x] Synergy buffs now apply to ALL player units (not just the matching element)
- [x] Synergy preview on unit card projects boosted stats for all active synergies
- [x] Void & Arcane synergies appear in synergy sidebar when faction is unlocked
- [x] Leaderboard: new Void Campaign tab with separate rankings
- [x] Leaderboard: trophy icons (🥇🥈🥉) for top 3; #1 name animated gold gradient glow
- [x] Leaderboard: capped at 10 entries per tab
- [x] Inferno Ravager Rye: Rampage kill-stack shown live on unit card (ATK + pill counter)
- [x] Void Supreme & Void Architect upgraded to Tier 5 (★★★★★)
- [x] Void Supreme HP buffed 450→600, phase HPs scaled up
- [x] Void Architect HP buffed 600→900, phase HPs scaled up
- [x] Tutorial Complete achievement now requires tutorial + all 8 contextual tips seen

### Phase 8.2 — Mobile v2
- [x] Portrait: tutorial overlay pointer-events pass-through so users can scroll to Fight button
- [x] Portrait: scrollIntoView on spotlight targets during tutorial
- [x] Landscape: grid gets flex:1 (dominant), panel capped at clamp(140px, 28vw, 220px)
- [x] Landscape: tile sizing uses 75% viewport height and reserves panel width
- [x] Added overscroll-behavior containment on html/body and game screen
- [x] Replaced dvh with svh viewport units throughout mobile CSS
- [x] Removed deprecated -webkit-overflow-scrolling: touch

### Phase 8.1 — Tutorial & Tips Polish
- [x] Streamlined onboarding tutorial from 7 steps to 3 focused steps
- [x] 8 contextual tips triggered at the right moment (first unit, synergy, battle, boss, etc.)
- [x] Battle auto-pauses while a contextual tip is displayed
- [x] "In-Game Tips" checkbox on title screen — toggle tips on/off, resets seen tips on re-enable
- [x] Tips version system — stale localStorage auto-cleared when tip definitions change
- [x] Color-coded buff/debuff status pills with emoji icons and stack counts
- [x] Background image adjusted to show more of the scene (contain instead of cover)
- [x] Viewport clamping for tutorial/tip box positioning

---

## 🗺️ Roadmap

> Active execution order now lives in `docs/current-roadmap.md`.
> This section is the long-tail backlog, not the current source of truth.

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
| `shape_strikers_tips_seen` | JSON object of seen contextual tip IDs (versioned) | On tip display |
| `shape_strikers_tips_enabled` | In-Game Tips toggle preference | Toggle in title |
| `shape_strikers_mp_desync_log` | JSON array of MP battle hash mismatches (last 10) | On MP battle desync |

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
| Contextual tips not appearing after tutorial re-enable | Version-gated tip reset + deferred seen-marking | 8.1 |
| Background image too zoomed in | Changed `cover` to `contain` on game screen | 8.1 |
| Multiplayer guest resume self-aborted before room grace elapsed | Resume bootstrap timeout now derives from room disconnect grace with an explicit buffer | 9.2 |
| Multiplayer host-loss behavior only covered by helper tests | Added game-level lifecycle regression tests for guest resume and both terminal host-disconnect flows | 9.2 |
| Multiplayer title music persisted into live matches and mute missed active sounds on mobile | MP entry now swaps to gameplay music, audio retries on gesture, and mute stops active cloned SFX | 9 |
| Latest coverage merge malformed `config.js`, blocking game boot and title entry | Restored the broken `PATCH_NOTES` boundaries and `SHAPE_COLORS` map, then revalidated startup | 9.2 |

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