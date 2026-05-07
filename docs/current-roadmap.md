# Shape Strikers — Current Roadmap

Last updated: 2026-05-07

Purpose: this is the single source of truth for the active work order in `games/shape_strikers_web/`.

## How To Use This Doc

- Use this file for current priority, sequencing, and stop-doing guidance.
- Use `PROGRESS.md` for shipped work and historical phase tracking.
- Use `docs/multiplayer-followups.md` for detailed multiplayer backlog notes and acceptance checklists.
- Use `AUDIT.md` for broad technical debt ideas, not day-to-day execution order.
- Treat `_MULTIPLAYER_ROADMAP.md` as historical scaffolding only. It is no longer the execution plan.

## Current State

- Single-player, challenges, leaderboards, presence/chat, and live 1v1 multiplayer are shipped.
- Multiplayer authoritative replay is live.
- Guest reload/reconnect hardening for battle-start, result-show, and older retained-round recovery was recently stabilized with focused tests and live browser validation.
- A best-effort centralized multiplayer telemetry upload path is now live: the `mp_telemetry_events` schema is applied in Supabase and a browser-backed insert was verified end to end.
- Multiplayer round-reset roster rules are now covered by focused multiplayer tests: owned units persist between rounds and reset to their prep-phase HP, positions, and cleared battle state.
- Multiplayer-only upgrade rules are now enforced in the live prep flow: economy/scouting upgrades are hidden in multiplayer and round-sensitive buffs clear between prep rounds.
- Player-facing multiplayer rules and reconnect expectations are now surfaced in the title help overlay and the multiplayer queue overlay, and mobile players can read upgrade details there without hover.
- A two-client live pass on 2026-05-07 confirmed guest reload/resync reasons such as `reload_resume_authoritative_request` and `reload_resume_authoritative_applied` land in `mp_telemetry_events`, alongside live stale/recovery `room.lifecycle` transitions.
- The current release target is stable host-authoritative multiplayer with strong transient reconnect recovery.
- Host-loss survival remains an unresolved release-hardening gap.

## Active Roadmap

### 1. Multiplayer Hardening On The Current Architecture
Status: active now

Focus:
- use the centralized reconnect, resync, disconnect, and desync telemetry path during future live multiplayer audits instead of relying only on local browser logs
- keep closing reconnect/resync gaps only where a test or live repro proves a real hole
- preserve deterministic battle behavior and keep authoritative recovery bundles narrow

Exit criteria:
- multiplayer faults are confirmed in the centralized store, not only the local client ring buffer
- live validation passes prep reload, battle-start reload, result-show reload, and mid-battle reconnect cases
- reconnect behavior is documented clearly enough for players and future development work

### 2. Multiplayer Rules Cleanup
Status: completed 2026-05-07

Focus:
- preserve roster ownership between rounds while clearing temporary battle state
- curate the multiplayer-only upgrade pool and decide the outcome of `Scout's Intel`

Exit criteria:
- round-reset behavior is covered by focused multiplayer tests
- upgrade restrictions and reset-sensitive upgrades stay multiplayer-only
- no regressions to single-player economy, upgrades, or unit persistence

### 3. Player-Facing Multiplayer Clarity
Status: completed 2026-05-07

Focus:
- explain reconnect/disconnect expectations without internal protocol language
- improve mobile upgrade-description discoverability
- keep audio/mobile issues as reopen-only unless fresh live testing shows a regression

Exit criteria:
- multiplayer rules are understandable in-game and in docs
- mobile players can inspect upgrade behavior without hover-only UI

### 4. Release Architecture Decision
Status: later, but strategically important

Decision to make:
- continue with host authority plus host migration
- or move to a dedicated authoritative match service

Needed before public-release confidence:
- decide the real target for crash/reload recovery
- decide whether host-loss survival is required
- define the minimum server-side state and telemetry retention model

## Non-Active But Important Backlog

- asset audit and pruning from `AUDIT.md`
- event-bus vs callback refactor in battle flow
- `config.js` data splitting if content work resumes heavily
- accessibility polish
- larger content/system ideas from the backlog in `PROGRESS.md`

## Not Current Priorities

- framework migration
- TypeScript conversion
- large content expansions before multiplayer hardening is stable
- broad refactors that do not directly improve shipped multiplayer reliability or release readiness

## Immediate Next Actions

1. Decide whether host-loss survival stays on the host-authority path or needs a stronger authoritative match service before wider public release.
2. Keep future live passes focused on host-loss and disconnect-confirmation cases now that guest reload/resync telemetry is centrally verified.
3. Reopen audio/mobile polish only if the next live multiplayer pass shows a real regression.