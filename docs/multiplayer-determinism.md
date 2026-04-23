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

The replay player can resume from the latest checkpoint sequence by using the most recent
turn snapshot that contains full army state.

---

## Debugging

On `localhost` or `127.0.0.1`:

* `Ctrl+Shift+D` toggles the multiplayer debug overlay
* `Ctrl+Shift+X` forces a transient realtime disconnect for reconnect testing

These tools are intended for local multiplayer validation and are not part of production gameplay.

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
disconnects permanently, the match cannot continue from the guest alone. Moving that authority
to a backend service remains a future option if host loss becomes a recurring issue.
