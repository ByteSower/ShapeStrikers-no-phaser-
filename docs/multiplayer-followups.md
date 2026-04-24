# Multiplayer Follow-Ups

Notes captured from live multiplayer testing with real users on different devices and networks.

Purpose: keep these issues documented for a later pass without diverting the current multiplayer slice.

## Guardrails

- Any multiplayer-specific fix must not regress single-player behavior.
- Scope rule changes to multiplayer only unless explicitly intended for both modes.
- Re-test desktop and mobile separately after each future fix.
- Prefer improving existing UI/help surfaces over inventing new one-off controls unless needed.

## Priority 0: Long-Term Release Architecture Hardening

### Why This Matters

If multiplayer is heading toward an `itch.io` release and potentially Steam / console later, the current transient reconnect model is not enough on its own.

For a public release, multiplayer should survive more than a short socket drop. It should also give us production visibility when desyncs, reconnect loops, or host failures happen in the wild.

### Long-Term Goals

- crash-proof matches where a temporary app/browser interruption does not automatically kill the match
- host-loss survival so a match can continue even if the original host fully disconnects, reloads, or crashes
- centralized telemetry for desyncs, reconnect failures, room failures, and other production multiplayer faults
- enough server-side state to support post-launch debugging instead of relying only on local browser logs

### Architecture Questions To Answer Later

- keep host authority and add host migration, or move battle authority fully off-client
- if keeping some client authority, decide what minimum match state must be persisted server-side
- define how a reconnecting player discovers and restores an in-progress match after full reload/app relaunch
- define what event stream or checkpoint data should be retained for diagnosis and replay support

### Candidate Directions

#### Option A: Host Migration

Keep the current client-hosted match model, but add:

- persistent room state / replay checkpoints stored server-side
- election of a replacement host if the original host disappears
- deterministic resume from the last committed checkpoint

Tradeoff:

- lower infrastructure cost than full server authority
- more complexity around re-electing authority safely
- still carries some client-trust risk

#### Option B: Server-Authoritative Match Service

Move battle authority off the players entirely and let clients act as viewers / input senders.

This would require:

- server-owned round simulation
- persistent room and checkpoint storage
- clients reconnecting to the server-owned match state instead of a player-owned host

Tradeoff:

- strongest path for Steam / console / competitive reliability
- biggest implementation and infrastructure jump
- cleanest answer for host-loss survival

### Telemetry Requirements

At minimum, record these centrally instead of only in local browser storage:

- room creation / join / leave lifecycle
- matchmaking timeout and queue failures
- reconnect attempts and reconnect outcomes
- desync or board-hash mismatches
- round_result delivery failures / retries
- battle replay resume usage and failures
- unexpected room closes / channel errors
- client version and platform data for multiplayer faults

### Suggested Data To Persist Server-Side

- active room metadata
- current round number
- player identities and reconnect tokens
- latest committed board / shop / gold state
- latest battle replay payload or a compact checkpoint form
- latest result payload and match score
- failure / recovery audit events

### Release Gate For This Work

Before treating multiplayer as release-ready beyond the current testing phase, decide whether the target is:

- good transient reconnect only
- full crash/reload recovery
- full host-loss survival

If the target includes Steam / console readiness, assume we need at least full crash/reload recovery and centralized telemetry, and very likely host-loss survival too.

## Priority 1: Audio Audit And Mobile Mute Regression

### Summary

Audio behavior is inconsistent in multiplayer and especially unreliable on mobile browsers.

### Reported Symptoms

- Title music is often the only music that plays reliably.
- Voice lines and event cues sometimes fire at the wrong time or do not fire at all.
- The `getReady` cue that should signal the shop phase is unreliable in multiplayer.
- Single-player audio behaves correctly on desktop and laptop browsers.
- Multiplayer audio is glitchy in general.
- The in-game mute button is broken on mobile.

### Desired Outcome

- Title music, gameplay music, boss music, and multiplayer phase cues all transition correctly.
- Multiplayer-specific shop and readiness cues are reliable on desktop and mobile.
- Mute/unmute works from both the title setting and the in-game button on mobile.

### Suggested Audit Areas

- `src/audio.js`
  - BGM lifecycle
  - SFX pooling and replay behavior
  - mute persistence and mute toggle handling
- `src/game.js`
  - title music start path
  - gameplay music swaps
  - `Audio.play('getReady')`
  - `Audio.play('objective')`
  - mute button wiring
- Browser autoplay / mobile gesture restrictions
  - confirm audio unlock behavior after first user interaction in multiplayer flows

### Acceptance Checks For Later

- Title music stops when gameplay music should begin.
- `getReady` plays at the start of every multiplayer prep phase.
- opponent-ready cue plays exactly once when appropriate.
- mute works from the title screen and in-match HUD on mobile.
- no duplicated or delayed voice lines after round transitions or reconnects.

## Priority 1: Multiplayer Round Reset Rules

### Current Bug

At round end, the round winner keeps surviving units while the loser loses units. This snowballs the match too quickly and does not match the intended multiplayer rules.

### Intended Multiplayer Rule

Both players keep their army between rounds regardless of who wins or loses the round.

### Reset Spec

At the start of the next multiplayer prep phase, all surviving owned units should reset to:

- starting position
- full HP
- no buffs
- no debuffs

### Notes

- The player keeps the unit roster, not the prior round's battle state.
- This should be multiplayer-only unless single-player is intentionally being redesigned.
- This needs to stay compatible with the authoritative replay / result flow.

### Suggested Audit Areas

- `src/game.js`
  - multiplayer round-end handling
  - player unit restoration / cleanup between rounds
  - any replay outcome application that currently mutates the owned roster
- `src/multiplayerGame.js`
  - round advancement expectations

### Acceptance Checks For Later

- Winning a round does not preserve battle damage or temporary state.
- Losing a round does not delete the player's owned units.
- Both players begin the next prep phase with the same roster they ended the prior prep phase with.

## Priority 2: Multiplayer-Only Upgrade Rules Pass

### Goal

Trim or rework the upgrade pool for multiplayer so it matches the round-based format and the new reset rules.

### Candidate Upgrades To Remove Or Disable In Multiplayer

- `Scout's Intel`
- `Field Medic`
- `Hovs Handouts`
- `War Chest`
- `Victory Bonus`

### Extra Note: Scout's Intel Is Incomplete

`Scout's Intel` is still not delivering its promised next-wave preview clearly in campaign or multiplayer. Users currently do not have a dependable way to see the next wave as described.

### Reset-Sensitive Upgrades

If multiplayer units fully reset between rounds, these should wear off after each round and become purchasable again in the next prep phase:

- `Double Edge`
- `Elite Training`

### Important Constraint

Do not let multiplayer upgrade restrictions or reset behavior affect single-player.

### Suggested Audit Areas

- `src/config.js`
  - multiplayer-relevant upgrade definitions
- `src/game.js`
  - upgrade purchase flow
  - upgrade application / cleanup
  - wave preview rendering
- `src/ui.js`
  - upgrade badges and upgrade display state

### Acceptance Checks For Later

- multiplayer can use a curated upgrade pool without changing single-player.
- temporary multiplayer-only upgrades expire with the round reset.
- `Scout's Intel` is either fixed, replaced, or intentionally removed from multiplayer.

## Priority 2: Mobile Upgrade Description Discoverability

### Current Problem

Upgrade details depend on mouse hover, which leaves mobile players without a reliable way to understand what upgrades do.

### Preferred Direction

Add upgrade explanations to the help / glossary surface, similar to how synergies are documented, instead of building a hover-only or mouse-first solution.

### Suggested Audit Areas

- `src/config.js`
  - upgrade names and descriptions
- `src/game.js`
  - glossary / help wiring
- `src/grid.js`
  - current tooltip-only upgrade affordances (`title` usage)
- `index.html`
  - glossary/help entry points already available in-match

### Acceptance Checks For Later

- mobile players can view upgrade explanations without relying on hover.
- desktop users still retain fast access to upgrade info.
- help content stays consistent with the actual multiplayer upgrade pool.

## Priority 2: Clear Player-Facing Multiplayer Rules

### Current Problem

Players are confused by the current multiplayer flow and do not have a single clear place to read the actual rules.

### Goal

Add short, readable multiplayer rules somewhere players can reliably find them before and during a match.

### Preferred Direction

Document multiplayer rules in an existing player-facing surface instead of hiding them in tooltips or relying on trial and error.

### Candidate Surfaces

- title-screen help / how-to-play flow
- in-match glossary / help panel
- multiplayer lobby overlay before queueing

### Rules That Need To Be Explained Clearly

- match format: best-of-5 rounds
- round flow: build, ready, battle, results, next prep phase
- round win condition and overall match win condition
- what carries between rounds and what resets between rounds
- how gold works between rounds
- what reconnect / disconnect behavior players should expect
- any multiplayer-only upgrade restrictions or differences from single-player

### Writing Constraints

- use short sentences
- avoid internal terms like protocol, replay payload, host-authoritative, checkpoint, or sync state
- explain what the player experiences, not how it is implemented
- keep the multiplayer rules separate from single-player rules when they differ
- make sure mobile players can read the same rules without hover interactions

### Acceptance Checks For Later

- a new player can understand the multiplayer round loop without external explanation
- players can find the rules before queueing and during a match
- the documented rules match the real multiplayer behavior
- multiplayer-specific rules are clearly distinguished from single-player behavior

## Existing Related Surfaces

- Wave preview container already exists in `index.html` as `#wave-preview`.
- Next-wave preview rendering already exists in `src/game.js` but needs a usability pass.
- Multiplayer prep cues already call `Audio.play('getReady')` in `src/game.js`.
- Opponent-ready cue already uses `Audio.play('objective')` in `src/game.js`.
- Upgrade definitions live in `src/config.js`.

## Recommended Test Matrix When This Work Resumes

- single-player on desktop
- single-player on mobile
- multiplayer on desktop vs desktop
- multiplayer on mobile vs mobile
- multiplayer on desktop vs mobile
- reconnect during battle with audio enabled
- mute/unmute before match, during prep, during battle, and after round end

## Deferred On Purpose

This file is a backlog capture only. No code changes for these items are included in the current pass.