# Multiplayer Battle Sync

## Overview

Shape Strikers multiplayer now uses a **host-simulated, replay-driven** battle flow.
The host runs one deterministic battle, records the event log, and broadcasts that
replay package to the guest. Both clients then render the same sequence of battle
events, so the round presentation stays aligned even if browser timing or animation
timing differs.

Round scoring is still host-authoritative, but the presentation path is now shared:
the guest no longer runs an independent live battle to decide what happens on screen.

---

## Architecture

```
Host client                              Guest client
──────────────────────────────           ──────────────────────────────
signalReady(board)                       signalReady(board)
   │                                        │
build replay payload                        wait for room phase events
(seed, stable ids, snapshots, log)          │
   │                                        │
Room.syncState('battle_replay', ...)        receive battle_replay
Room.syncState('phase_event', ...)          receive phase_event
Room.syncState('playback_checkpoint', ...)  resume from checkpoint if needed
   │                                        │
render replay locally                       render same replay locally
   │                                        │
Room.syncState('round_result', ...)         apply host round_result
```

The room protocol now uses explicit phase markers:

* `prep_end`
* `battle_script_ready`
* `playback_start`
* `result_show`

These keep battle start, result reveal, and round transitions aligned across both clients.

---

## Replay Package

The host-generated replay payload includes:

* The seeded battle RNG value
* Stable unit ids stamped before the simulation starts
* A `battle_start` snapshot for both armies
* Full turn checkpoints captured on `turn_start`
* A `battle_end` snapshot plus the round board hash

Those checkpoints let a reconnecting guest resume from the latest safe sequence number
instead of restarting the whole replay from the beginning.

---

## Determinism Building Blocks

| File | Global | Purpose |
|---|---|---|
| `src/utils/prng.js` | `PRNG` | Seeded mulberry32 RNG factory + helpers |
| `src/battle/hashUtils.js` | `HashUtils` | Canonical board hashing for multiplayer payload checks |
| `src/multiplayer/keys.js` | `UnitKeys` | Stable cross-client unit ids (`ownerId::defId::row::col`) |
| `src/battleReplay.js` | `BattleReplay` | Renderer-agnostic replay player with checkpoint resume |

The battle engine also uses explicit tie-breakers so equal-speed units always act in the
same order on every machine.

---

## Stable Unit Keys

Unit ids are stamped in the format:

```
{ownerId}::{defId}::{row}::{col}
```

This gives the host and guest the same identifier for the same placed unit, which keeps
sorting, replay events, and board hashing stable across clients.

Example: `abc123::fire_scout::3::2`

---

## Board Hashes

The multiplayer replay payload uses `HashUtils.hashState()` to produce a canonical hash of
the end-of-round board state. Units are sorted by stable id before hashing.

Hash format per unit:

```
{id}:{roundedHp}:{alive}:{row}:{col}
```

Guests compare the replay payload hash with the host's final `round_result` hash. A mismatch
is logged locally for debugging, but the host result still wins.

---

## Reconnect And Resume

Reconnect recovery now works in two layers:

1. The host re-broadcasts cached `battle_replay`, `phase_event`, `playback_checkpoint`, and
   `round_result` payloads when an opponent reconnects.
2. The guest also re-checks cached room state when its room channel returns to `SUBSCRIBED`,
   so self-recovery works even if opponent presence callbacks do not fire first.

The saved guest room session now persists explicit reconnect identity metadata:

* `seatId` — deterministic seat ownership for the room (`roomId:playerId:role`)
* `sessionId` — the current room session identifier carried on presence and room traffic
* `reconnectToken` — local reconnect credential reserved for the saved room session
* `resumeContext` — last known round / checkpoint / phase metadata for reload recovery

`Room.reconnect()` now rejects a saved session if the current backend user id no longer matches
the saved `playerId`, so a stale or foreign local session cannot silently reclaim the old seat.

Guest reload bootstrap now uses that saved `resumeContext` directly to resolve the target round,
checkpoint sequence, and recovery mode before fresh room cache arrives. That lets a reconnecting
guest request the right `authoritative_state` bundle for the last known battle/prep phase instead
of rediscovering the entire resume target from room broadcasts alone.

Intentional match exits now use a separate `mp_match_quit` path instead of piggybacking on the
disconnect lifecycle. `Quit Match` is treated as an explicit forfeit: it ends the best-of-5
immediately, shows a quit-specific result overlay on both clients, clears the saved room session,
and returns both players to the title screen. Guest refresh / tab close still stays on the
reconnect path so an in-progress match can be resumed if the host and room are still alive.
Host disconnects do not: once the host drops long enough to trip the disconnect hook, the match
is force-ended for both players and both clients return to title instead of attempting a host
resume.

Cold host resume is intentionally disabled for now. If a saved room session belongs to the host
and the page reloads back to the title screen, the client clears that stale host session instead
of attempting a partial host restore. Guest reload resume remains enabled because the current
recovery path can rebuild guest state from authoritative host room data. The guest saved-session
bootstrap window is intentionally longer than the room disconnect grace so a real reconnect does
not self-abort before the host can observe the guest return and rebroadcast prep or battle state.

The replay player can resume from the latest checkpoint sequence by using the most recent
turn snapshot that contains full army state.

Authoritative recovery now distinguishes request and response modes instead of treating every
recovery path as a full-state resync:

* `battle` — used for replay/bootstrap recovery such as `missing_battle_replay` or replay hash mismatches
* `prep` — used when a reload resume only needs the current prep/shop snapshot
* `full` — fallback for generic or manual recovery requests
* `auto` — request-side hint that lets the host choose `prep` or `battle` from the current room state

The host includes the resolved response mode in `authoritative_state.meta.responseMode`, so
recovery behavior is explicit in both logs and payloads.

Room liveness now uses both presence and explicit keepalive traffic:

* `room_heartbeat` broadcasts are sent every 3 seconds while the room channel is subscribed
* any inbound opponent packet (`state_sync` or `room_heartbeat`) refreshes `lastRemoteActivityAt`
* 7 seconds of silence moves the room lifecycle to `STALE`
* 10 seconds of silence moves the room lifecycle to `DISCONNECTED` and fires the disconnect hook
* an explicit presence leave still marks `STALE` immediately, but recovery can now happen from fresh heartbeat traffic even if presence join is delayed
* browser `pagehide` now proactively calls `SupabaseClient.leaveAll()` so refresh / tab close drops room presence faster without clearing the saved room session used for reconnect

## Connection Lifecycle

The room controller now tracks a match-facing lifecycle separately from the raw Supabase
Realtime channel status:

```text
CONNECTING -> ACTIVE -> STALE -> DISCONNECTED -> RECONNECTING -> RESYNCING -> ACTIVE
```

These states currently mean:

* `CONNECTING` — room join started and the Realtime channel is not yet subscribed
* `ACTIVE` — channel is subscribed and no recovery flow is in progress
* `STALE` — opponent presence disappeared and the disconnect grace window is running
* `DISCONNECTED` — the grace window expired and match recovery UI is active
* `RECONNECTING` — the room channel dropped or a manual reconnect is underway
* `RESYNCING` — an `authoritative_state` request/apply flow is rebuilding guest state

`Room.getConnectionState()` still exposes the raw channel status (`pending`, `SUBSCRIBED`,
`TIMED_OUT`, and so on). `Room.getLifecycleState()` is the higher-level state intended for
HUD display and multiplayer recovery logic.

---

## Debugging

On `localhost` or `127.0.0.1`:

* `Ctrl+Shift+D` toggles the multiplayer debug overlay
* `Ctrl+Shift+X` forces a transient realtime disconnect for reconnect testing

These tools are intended for local multiplayer validation and are not part of production gameplay.

Structured client-side multiplayer telemetry is also recorded to local storage under
`shape_strikers_mp_telemetry_log` as a bounded ring buffer. Current event types include
room lifecycle transitions, resync begin/end, saved-session rejection, and battle hash mismatches.

---

## Running Tests

```bash
node tests/battle/determinism.test.js
node tests/battle/replayPlayer.test.js
node tests/multiplayer/hostResultFlow.test.js
node tests/multiplayer/matchmakingQueue.test.js
node scripts/checkDeterminism.js --seeds 500 --verbose
```

---

## Current Limitation

The host is still the single authority for battle generation and round results. If the host
disconnects, the match cannot continue from the guest alone. The runtime now reflects that
directly by ending the set for both players after a confirmed host disconnect instead of trying
to keep the room recoverable for the host. Moving that authority to a backend service remains a
future option if host loss becomes a recurring issue.
