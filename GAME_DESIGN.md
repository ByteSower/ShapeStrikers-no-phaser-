# Shape Strikers — Game Design Document

> Tactical Auto-Battler Rogue-like · Vanilla HTML/CSS/JS · No Engine Required

---

## Table of Contents
1. [Game Overview](#game-overview)
2. [Core Loop](#core-loop)
3. [Grid & Zones](#grid--zones)
4. [Unit Stats & Combat](#unit-stats--combat)
5. [Damage Formula](#damage-formula)
6. [Targeting & Range](#targeting--range)
7. [Movement Rules](#movement-rules)
8. [Abilities](#abilities)
9. [Status Effects](#status-effects)
10. [Elements & Synergies](#elements--synergies)
11. [Unit Roster](#unit-roster)
12. [Bosses & Phases](#bosses--phases)
13. [Shop & Economy](#shop--economy)
14. [Upgrades](#upgrades)
15. [Wave System](#wave-system)
16. [Campaign Modes](#campaign-modes)
17. [Win / Loss Conditions](#win--loss-conditions)
18. [Achievements](#achievements)
19. [Daily & Weekly Challenges](#daily--weekly-challenges)
20. [Visual Indicators](#visual-indicators)
21. [Leaderboards](#leaderboards)
22. [Patch Notes](#patch-notes)

---

## Game Overview

Shape Strikers is a **lane-based auto-battler** where players buy and place procedurally-drawn shape units on a grid, then watch them fight enemy waves automatically. Strategic depth comes from **element synergies**, **unit positioning**, **ability interactions**, and **economy management**.

**Key Features:**
- 8 elements with synergy bonuses
- 44 unique units (39 playable + 5 bosses) across 4 tiers
- 5 boss fights with multi-phase mechanics (Waves 5, 10, 15, 20, 25)
- 2 campaign modes: Normal (15 waves) and Void Campaign (25 waves)
- Hard mode stat scaling for waves 16–25
- 4 advanced mechanics (evolve, knockback, pull, kill-stacking)
- Seeded wave generation for variety across runs
- Shop with refresh, sell, and upgrade systems

---

## Core Loop

```
┌─────────────────────────────────────────────┐
│  SHOP PHASE                                 │
│  • Buy units from shop (5 cards)            │
│  • Place units on player zone (bottom rows) │
│  • Refresh shop for new units               │
│  • Sell placed units (right-click)          │
│  • Purchase upgrades (Stats tab)            │
│  • Review synergies and plan composition    │
└─────────────┬───────────────────────────────┘
              │ Press "Fight!"
              ▼
┌─────────────────────────────────────────────┐
│  BATTLE PHASE                               │
│  • Enemy wave spawns in enemy zone (top)    │
│  • Units auto-battle: move → attack/ability │
│  • Action order: highest speed goes first   │
│  • Both sides converge at the battle line   │
│  • Battle ends when one side is eliminated  │
└─────────────┬───────────────────────────────┘
              │ Victory or Defeat
              ▼
┌─────────────────────────────────────────────┐
│  RESULT                                     │
│  • Earn gold (base + bonus + interest)      │
│  • Post-battle healing (Field Medic)        │
│  • Advance to next wave → back to SHOP      │
│  • Wave 15 victory = Game Win               │
│  • All units dead = Game Over               │
└─────────────────────────────────────────────┘
```

---

## Grid & Zones

```
         Col 0   Col 1   Col 2   Col 3   Col 4   Col 5
       ┌───────┬───────┬───────┬───────┬───────┬───────┐
Row 0  │  👾   │  👾   │  👾   │  👾   │  👾   │  👾   │  ENEMY ZONE
       ├───────┼───────┼───────┼───────┼───────┼───────┤
Row 1  │  👾   │  👾   │  👾   │  👾   │  👾   │  👾   │  ENEMY ZONE
       ├───────┼───────┼───────┼───────┼───────┼───────┤
Row 2  │  ⚡   │  ⚡   │  ⚡   │  ⚡   │  ⚡   │  ⚡   │  BATTLE LINE
       ├───────┼───────┼───────┼───────┼───────┼───────┤
Row 3  │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  PLAYER ZONE
       ├───────┼───────┼───────┼───────┼───────┼───────┤
Row 4  │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  ⚔️   │  PLAYER ZONE
       └───────┴───────┴───────┴───────┴───────┴───────┘
```

| Zone | Rows | Usage |
|------|------|-------|
| **Enemy Zone** | 0–1 | Enemies spawn here. Players cannot place units here. |
| **Battle Line** | 2 | Shared contested row. Both sides converge here. |
| **Player Zone** | 3–4 | Players place purchased units here during shop phase. |

- Grid size: **6 columns × 5 rows**
- Tile size: 88×88 pixels
- Each tile holds at most **one unit**

---

## Unit Stats & Combat

### Stat Definitions

| Stat | Symbol | Description | Example |
|------|--------|-------------|---------|
| **HP** | ❤️ | Hit points. Unit dies at 0. | 80, 150, 300 |
| **Max HP** | — | Maximum health. Used for heal cap and HP bar display. | Same as HP at start |
| **Attack** | ⚔️ | Offensive power. Higher = more damage dealt. | 10–45 |
| **Defense** | 🛡️ | Damage reduction (diminishing returns). | 3–22 |
| **Speed** | 💨 | Determines action order. Higher speed acts first. | 2–12 |
| **Range** | 🎯 | How many rows away a unit can attack. Measured in **row distance only**. | 1 (melee), 2–3 (ranged) |

### Action Order

Each round, all living units are sorted by **effective speed** (descending). Units with the `slow` status effect have their speed reduced by **10% per stack** (min 20% speed at max 8 stacks).

```
Effective Speed = unit.stats.speed × max(0.2, 1 - slowStacks × 0.1)
```

Each unit takes one action per round: **Ability** (if off cooldown + target in range) → **Attack** (if target in range) → **Move** (if no target in range).

---

## Damage Formula

Shape Strikers uses **diminishing returns defense** matching the Phaser original:

```
Defense Reduction = totalDefense / (totalDefense + 50)
Damage = max(1, floor(attackMod × (1 - defenseReduction) × abilityMult))
```

### Modifiers

| Modifier | Effect |
|----------|--------|
| **Shield** status | Adds `value × stacks` to defense total before reduction calc (e.g., 15 value × 2 stacks = +30 DEF) |
| **Weaken** status | Reduces attacker's attack by 8% per stack (max 24% at 3 stacks): `atk × max(0.5, 1 - stacks × 0.08)` |
| **Ability multiplier** | Varies per ability (0.3× to 2.5×) |

### Examples

| Attacker ATK | Target DEF | Mult | Damage |
|-------------|-----------|------|--------|
| 15 | 5 | 1.0× | `15 × (1 - 5/55) = 15 × 0.91 = 13` |
| 25 | 15 | 1.0× | `25 × (1 - 15/65) = 25 × 0.77 = 19` |
| 30 | 20 | 1.4× | `30 × (1 - 20/70) × 1.4 = 30 × 0.71 × 1.4 = 29` |
| 15 (weakened ×1) | 8 | 1.0× | `(15×0.92) × (1 - 8/58) = 13.8 × 0.86 = 11` |
| 35 | 10+15×2 (shield ×2) | 1.0× | `35 × (1 - 40/90) = 35 × 0.56 = 19` |

---

## Targeting & Range

### Range Check

Range is measured in **row distance only** (lane-based combat):

```
distance = abs(attacker.row - target.row)
canTarget = distance <= attacker.stats.range
```

A melee unit (range 1) at row 2 can hit any enemy at row 1. A ranged unit (range 3) at row 4 can hit enemies at rows 1–4.

### Target Priority

1. **Same column (lane)** targets are preferred
2. Within the preferred pool, **lowest HP** target is chosen
3. Untargetable units are filtered out

---

## Movement Rules

Units move **one tile per round** when they have no target in range.

### Boundary Enforcement

| Team | Direction | Limit |
|------|-----------|-------|
| **Player** | Moves UP (row decreases) | Cannot go below **row 2** (battle line) |
| **Enemy** | Moves DOWN (row increases) | Cannot go above **row 2** (battle line) |

Units **never cross the battle line**. Both sides converge at row 2.

### Movement Priority

When advancing toward battle line:
1. **Forward** in same column (directly toward enemy)
2. **Diagonal** toward nearest enemy's column
3. **Diagonal** other direction (just to advance a row)

When **at the battle line** (row 2):
- **Horizontal only** — move toward the nearest enemy's column

### Collision

A unit cannot move onto an occupied tile. If all adjacent valid tiles are blocked, the unit stays put.

---

## Abilities

Each unit has one ability with a **cooldown** (number of rounds between uses). When off cooldown and a target is in range, the ability fires instead of a basic attack.

### Ability Multipliers by Unit

| Unit | Ability | Mult | Special |
|------|---------|------|---------|
| Fire Imp | Ember Strike | 1.5× | + Burn (3 turns, 5 dmg/tick) |
| Ice Slime | Frost Coat | — | Slows ALL enemies in range 2 |
| Earth Golem | Stone Skin | — | Self shield (+15 DEF, 2 turns) |
| Lightning Sprite | Chain Lightning | 1.4× | Bounces to 3 targets |
| Earth Archer | Boulder Toss | 1.4× | + Stun (1 turn) |
| Fire Scout | Fire Bolt | 1.4× | + Minor burn (2 turns, 3 dmg) |
| Frost Fairy | Healing Frost | — | Heals lowest HP ally 25 HP |
| Blood Sprite | Drain Touch | 1.4× | + 40% lifesteal |
| Konji Scout | Toxic Dart | 1.4× | + Poison (3 turns, 8 dmg/tick) |
| Void Shade | Shadow Phase | 1.8× | Self untargetable (1 turn) + stealth strike |
| Fire Warrior | Blazing Charge | 1.4× | Hits ALL enemies in same column + burn |
| Ice Archer | Frost Arrow | 1.2× | + Freeze (1 turn) |
| Arcane Mage | Arcane Blast | 2.0× | Heavy single-target magic |
| Lightning Knight | Thunder Strike | 1.6× | + Stun (1 turn) |
| Ice Guardian | Frozen Wall | — | Self shield (3 turns) + slow ALL enemies |
| Arcane Assassin | Shadow Strike | 1.5–2.5× | 50% chance for 2.5× crit |
| Nature Spirit | Rejuvenate | — | Heals ALL allies 15 HP |
| Arcane Priest | Arcane Restoration | — | Heals lowest ally 25 HP + shield |
| Blood Knight | Crimson Cleave | 1.2× | Up to 3 targets + 30% lifesteal |
| Konji Shaman | Plague Cloud | 0.3× | Poisons ALL enemies (2 turns, 8 dmg) |
| Void Knight | Corruption Strike | 1.4× | + Weaken (2 turns) |
| Void Blighter | Cursed Wound | 0.6× | ALL enemies + wound (3 turns) |
| Fire Demon | Hellfire | 0.6× | Up to 3 targets + burn |
| Martial Master | Thousand Fists | 0.4× × 4 | 4 rapid strikes (1.6× total) |
| Lightning Lord | Thunder Storm | 0.7× | Hits ALL enemies |
| Ice Empress | Blizzard | 0.5× | ALL enemies + freeze |
| Life Guardian | Guardian's Blessing | — | Heals ALL allies 30 HP + barrier to ALL |
| Void Horror | Void Rupture | 1.2× | AoE, **ignores defense** |
| Arcane Pupil | Arcane Bolt | 1.3× | + Evolve passive (+10% ATK/DEF every 3 turns, max 3 stacks) |
| Earth Enforcer | Ground Slam | 1.4× | + Knockback (pushes target 1 row back) |
| Lightning Hunter | Grapple Pull | 1.2× | + Pull (drags target 1 row forward) |
| Fire Ravager | Rampage | 1.5× | Up to 2 targets + Kill-stack passive (+10% ATK per kill, max +50%) |
| Arcane Illusionist | Mirage | 0.3× | Hits ALL enemies + blinds all (30% miss, 2 turns) |

---

## Status Effects

| Status | Icon | Duration | Effect | Max Stacks | Blocked by Barrier? |
|--------|------|----------|--------|-----------|---------------------|
| **Burn** | 🔥 | 2–3 turns | `value × stacks` damage per tick (e.g., 5 dmg × 3 = 15/tick) | 3 | Yes |
| **Poison** | ☠️ | 2–3 turns | `value × stacks` damage per tick (e.g., 8 dmg × 5 = 40/tick) | 5 | Yes |
| **Freeze** | ❄️ | 1–2 turns | Skips action entirely (cooldowns still tick) | 3 | Yes |
| **Slow** | 🐌 | 2 turns | −10% speed per stack for action order (min 20% speed) | 8 | Yes |
| **Shield** | 🛡️ | 2–3 turns | Adds `value × stacks` bonus defense (e.g., 15 × 2 = +30 DEF) | 3 | No |
| **Barrier** | 🔮 | 2 turns | Blocks ALL negative status effects | 1 | No |
| **Weaken** | 💔 | 2 turns | −8% ATK per stack (max −24% at 3 stacks) | 3 | Yes |
| **Wound** | 🩸 | 3 turns | Healing received reduced by 50% | 3 | Yes |
| **Untargetable** | 👻 | 1 turn | Cannot be selected as target | 1 | No |
| **Blind** | 😵 | 2 turns | 30% chance to miss basic attacks | 2 | Yes |

### Stacking Rules
- **Same status**: Each reapplication adds +1 stack (up to the cap) and refreshes duration to the longer value
- **At max stacks**: Further applications only refresh duration
- **Different statuses**: Can coexist (e.g., burned + poisoned + slowed)
- **Barrier**: Only blocks burn, poison, freeze, slow, weaken, wound, blind. Allows shield/barrier/untargetable.

### Tick Timing
Burn and poison damage are applied at the **start** of the affected unit's turn (before their action).

---

## Advanced Mechanics

### Evolve

Certain units (e.g., Arcane Pupil) grow stronger the longer they survive in battle.

| Parameter | Description |
|-----------|-------------|
| `interval` | Turns between stat boosts (e.g., every 3 turns) |
| `statBonus` | Percentage of **base** ATK/DEF gained per stack (e.g., 0.1 = +10%) |
| `maxStacks` | Cap on evolve stacks (e.g., 3 = max +30% ATK/DEF) |

- Tracked per unit via `_turnsSurvived` and `_evolveStacks`
- Multiplier applies from **base stats** (non-compounding)
- Checked at the **start** of the unit's turn

### Knockback

Abilities with knockback push the target **1 row toward their spawn side** (enemies → row 0, players → row 4).

- Fails silently if the destination tile is **occupied** or **out of bounds**
- Fires `onUnitMove` callback for animation
- Currently used by: **Earth Enforcer** (Ground Slam)

### Pull

Abilities with pull drag the target **1 row toward the attacker's side** (pulling enemies → row 4, pulling players → row 0).

- Same occupation/bounds checks as knockback
- Fires `onUnitMove` callback for animation
- Currently used by: **Lightning Hunter** (Grapple Pull)

### Kill-Stacking

Units with the `killStackBonus` property gain permanent ATK bonuses for each kill they score during a battle.

| Parameter | Description |
|-----------|-------------|
| `atkPerKill` | ATK multiplier gained per kill (e.g., 0.1 = +10%) |
| `maxBonus` | Maximum total bonus (e.g., 0.5 = +50% ATK cap) |

- Tracked via `unit._kills` counter (incremented when any unit dies by their hand)
- Bonus is applied during damage calculation: `finalATK = atk × (1 + min(maxBonus, kills × atkPerKill))`
- Resets each battle (kill counter starts at 0)
- Currently used by: **Fire Ravager** (Rampage)

---

## Elements & Synergies

### Elements

| Element | Emoji | Color | Available To |
|---------|-------|-------|-------------|
| 🔥 Fire | `fire` | `#ff4422` | All players |
| 🧊 Ice | `ice` | `#44ccff` | All players |
| ⚡ Lightning | `lightning` | `#c8a000` | All players |
| 🌍 Earth | `earth` | `#88cc44` | All players |
| ✨ Arcane | `arcane` | `#bb44ff` | Unlocked after first win |
| 🕳️ Void | `void` | `#7744aa` | Enemy-only (unlock after game completion) |

### Synergy Bonuses

Synergies activate when you have **2 or more** units of the same element. Only the **highest matching tier** applies (not cumulative).

| Element | Count | Bonus | Description |
|---------|-------|-------|-------------|
| 🔥 Fire | 2 | +15% ATK | Aggressive damage boost |
| 🔥 Fire | 3 | +30% ATK | Major damage boost |
| 🧊 Ice | 2 | +15% DEF | Defensive boost |
| 🧊 Ice | 3 | +30% DEF | Major defensive boost |
| ⚡ Lightning | 2 | +20% SPD | Speed advantage |
| ⚡ Lightning | 3 | +40% SPD | Major speed advantage |
| 🌍 Earth | 2 | +20% HP | Durability boost |
| 🌍 Earth | 3 | +40% HP | Major durability boost |
| ✨ Arcane | 2 | +10% ATK | Minor hybrid boost |
| ✨ Arcane | 3 | +25% SPD | Speed specialist |
| 🕳️ Void | 2 | +25% ATK | Enemy-exclusive power |
| 🕳️ Void | 3 | +20% HP | Enemy-exclusive durability |

### Synergy Application Rules

- Applied at **battle start** to **all player units** (not just element-matching units)
- Calculated from **base stats** (not current modified stats)
- **Reset after battle** — stats return to base values
- Only the highest matching synergy per element+stat is applied
- Multiple synergies boosting the same stat **multiply together** (e.g. Fire +15% ATK × Blood +15% ATK = ×1.32 total ATK for every unit)

**Example**: 3 Fire units → +30% ATK applies to the **whole team** (NOT +15% AND +30%; NOT fire units only)

---

## Unit Roster

### Tier 1 (Cost 1–2g)

| Unit | Element | Cost | Role | HP | ATK | DEF | SPD | Range |
|------|---------|------|------|-----|-----|-----|-----|-------|
| Flame Child Yun | 🔥 | 1 | Skirmisher | 80 | 15 | 5 | 8 | 1 |
| Frost Slime Yon | 🧊 | 1 | Tank | 100 | 10 | 8 | 4 | 1 |
| Shape Golem Bofu | 🌍 | 2 | Tank | 150 | 12 | 15 | 2 | 1 |
| Thundorian Child | ⚡ | 2 | Sniper | 60 | 18 | 3 | 12 | 2 |
| Scout Trooper Pebbles | 🌍 | 2 | Sniper | 90 | 14 | 10 | 5 | 2 |
| Flame Child Yunni | 🔥 | 1 | Skirmisher | 65 | 12 | 4 | 10 | 2 |
| Frost Fairy Yoko | 🧊 | 2 | Healer | 70 | 8 | 6 | 7 | 2 |
| Vamp Kid Yoi | 🔥 | 2 | Skirmisher | 75 | 14 | 5 | 7 | 1 |
| Plague Son Yav | 🌍 | 2 | Sniper | 70 | 12 | 6 | 8 | 2 |
| Void Embryo Shadi | 🕳️ | 2 | Skirmisher | 60 | 18 | 3 | 10 | 1 |
| Arcane Servant Qua | ✨ | 2 | Skirmisher | 70 | 14 | 5 | 8 | 1 |

### Tier 2 (Cost 3–4g)

| Unit | Element | Cost | Role | HP | ATK | DEF | SPD | Range |
|------|---------|------|------|-----|-----|-----|-----|-------|
| Flame Soldier Magna | 🔥 | 4 | Tank | 180 | 25 | 12 | 6 | 1 |
| Ice Archer ColdShot | 🧊 | 4 | Sniper | 120 | 22 | 8 | 9 | 3 |
| Arcane Descendant | ✨ | 4 | Caster | 100 | 30 | 5 | 7 | 2 |
| Thundorian Soldier | ⚡ | 4 | Tank | 160 | 20 | 14 | 8 | 1 |
| Frost Guardian IceBur | 🧊 | 4 | Tank | 200 | 15 | 18 | 3 | 1 |
| Arcane Shadow | ✨ | 3 | Skirmisher | 85 | 35 | 4 | 11 | 1 |
| Shape Spirit Runi | 🌍 | 4 | Healer | 120 | 10 | 12 | 5 | 2 |
| Arcane Sorcerer | ✨ | 4 | Healer | 100 | 15 | 8 | 6 | 3 |
| Vamp General Parasect | 🔥 | 4 | Tank | 170 | 24 | 10 | 6 | 1 |
| Plague Caster Fuu | 🌍 | 4 | Caster | 130 | 18 | 9 | 5 | 2 |
| Void Berserker Zeku | 🕳️ | 3 | Tank | 180 | 28 | 10 | 6 | 1 |
| Void Curser Ukez | 🕳️ | 4 | Caster | 160 | 25 | 8 | 6 | 2 |
| Shape Enforcer Ooglong | 🌍 | 4 | Tank | 160 | 22 | 14 | 5 | 1 |
| Thundorian Elite Danza | ⚡ | 4 | Skirmisher | 110 | 24 | 6 | 10 | 2 |
| Inferno Ravager Rye | 🔥 | 4 | Skirmisher | 130 | 26 | 7 | 8 | 1 |

### Tier 3 (Cost 5–6g)

| Unit | Element | Cost | Role | HP | ATK | DEF | SPD | Range |
|------|---------|------|------|-----|-----|-----|-----|-------|
| Daemon The Incinerator | 🔥 | 6 | Caster | 200 | 30 | 12 | 5 | 2 |
| Shape Boxer Tysr | 🌍 | 6 | Tank | 280 | 35 | 20 | 8 | 1 |
| Thundorian King Zesper | ⚡ | 6 | Sniper | 180 | 45 | 10 | 10 | 3 |
| Ice Queen Elaine | 🧊 | 5 | Caster | 220 | 32 | 16 | 6 | 3 |
| Shape Guardian Ari | 🌍 | 5 | Healer | 200 | 12 | 18 | 4 | 2 |
| Void Horror Yui | 🕳️ | 5 | Caster | 300 | 38 | 12 | 4 | 2 |
| Arcane Illusionist Shera | ✨ | 6 | Caster | 170 | 28 | 10 | 7 | 3 |

### Unit Roles

| Role | Description | Typical Stats |
|------|-------------|---------------|
| **Tank** | High HP/DEF, front-line fighters | High HP & DEF, low SPD |
| **Skirmisher** | Fast, aggressive melee damage | High SPD & ATK, low HP |
| **Sniper** | Ranged damage dealer | High ATK & Range, low DEF |
| **Caster** | AoE/special ability focused | High ATK, ability-dependent |
| **Healer** | Sustain through healing abilities | Low ATK, heal-focused ability |

---

## Bosses & Phases

### Wave 5: 🔥 Sun Dragon Sel

| Stat | Value |
|------|-------|
| HP | 425 |
| ATK / DEF / SPD | 32 / 14 / 5 |
| Range | 4 |
| Ability | Tyrant's Wrath — 0.6× AoE ALL + burn |

| Phase | HP Threshold | Modifier |
|-------|-------------|----------|
| Burning Fury | 100% | — |
| Inferno | 50% | +40% ATK |

### Wave 10: 🧊 Frost Giant Anvalog

| Stat | Value |
|------|-------|
| HP | 675 |
| ATK / DEF / SPD | 30 / 22 / 3 |
| Range | 4 |
| Ability | Absolute Zero — 0.3× AoE + freeze ALL (2 turns) + self-heal 80 HP |

| Phase | HP Threshold | Modifier |
|-------|-------------|----------|
| Frozen Fortress | 100% | — |
| Glacier's Wrath | 50% | +50% DEF, −20% SPD |

### Wave 15: 🕳️ The Void Supreme

| Stat | Value |
|------|-------|
| HP | 300 (Phase 1) → 350 (Phase 2) → 400 (Phase 3) |
| ATK / DEF / SPD | 35 / 15 / 6 |
| Range | 4 |
| Ability | Void Cataclysm — 0.4× AoE ALL + enrage shield at <30% HP |

| Phase | HP Threshold | New HP Pool | Modifier |
|-------|-------------|-------------|----------|
| Awakening | 100% | 300 | — |
| Corruption | 66% | 350 | +30% ATK, +20% SPD |
| Cataclysm | 33% | 400 | +60% ATK, +50% SPD, −30% DEF |

### Wave 20: 🕳️ Void Leviathan (Void Campaign)

| Stat | Value |
|------|-------|
| HP | 800 |
| ATK / DEF / SPD | 52 / 25 / 5 |
| Range | 4 |
| Ability | Abyssal Devour — consumes target HP, heals self 60 HP, applies wound + weaken |

| Phase | HP Threshold | New HP Pool | Modifier |
|-------|-------------|-------------|----------|
| Emergence | 100% | 500 | — |
| Deep Hunger | 50% | 600 | +40% ATK, +30% SPD |

### Wave 25: 🕳️ The Void Architect (Void Campaign)

| Stat | Value |
|------|-------|
| HP | 600 |
| ATK / DEF / SPD | 60 / 18 / 8 |
| Range | 4 |
| Ability | Reality Tear — massive void damage to ALL + blind + poison |

| Phase | HP Threshold | New HP Pool | Modifier |
|-------|-------------|-------------|----------|
| Blueprint | 100% | 400 | — |
| Reconstruction | 66% | 450 | +30% ATK, +30% DEF |
| Annihilation | 33% | 500 | +80% ATK, +50% SPD, −50% DEF |

**Boss Phase Rules:**
- Phase transitions trigger when HP drops below threshold (checked on every damage taken)
- Stat multipliers are applied from **base stats** (not compounding)
- The Void Supreme and Void Architect HP resets to new phase pool on transition
- In Void Campaign, boss phaseHp is scaled by HARD_MODE_SCALING multipliers
- Boss escorts spawn alongside each boss (see Wave System)

---

## Shop & Economy

### Gold Sources

| Source | Amount | Notes |
|--------|--------|-------|
| Starting gold | 10g | At wave 1 |
| Base gold per wave won | 7g | `GAME_CONFIG.goldPerWave` |
| Wave bonus gold | 3–50g | Per wave template (`bonusGold`) |
| Victory Bonus upgrade | +2g per level | Up to 3 levels = +6g |
| Interest (War Chest) | 10% per level | Up to 3 levels = 30% interest, capped at 5g |

**Gold earned per victory** = `goldPerWave + bonusGold + interest + victoryBonus`

### Shop Mechanics

| Parameter | Value |
|-----------|-------|
| Shop size | 5 cards |
| Refresh cost | 2g base (−1 per Bargain Hunter level) |
| Max tier available | `min(3, ceil(wave / 3))` — T1 at W1, T2 at W4, T3 at W7 |
| Sell refund | 50% of cost (minimum 1g) |

### Shop Pool

- Non-boss, non-void units (unless void unlocked)
- Arcane units only if `arcane_unlocked` flag set
- Filtered by `tier <= maxTier`
- 5 random units drawn each refresh

---

## Upgrades

| Upgrade | Cost | Max Level | Per Level | Description |
|---------|------|-----------|-----------|-------------|
| 🏰 Army Expansion | 8g | 5 | +1 max unit slot | Start with 7, max 12 |
| 💚 Field Medic | 5g | 3 | +15% healing | Base 25% + 15% per level |
| Hovs Handouts | 4g | 2 | −1 refresh cost | Minimum 0g refresh |
| 📈 War Chest | 6g | 3 | +10% interest | On current gold, max 5g |
| 🏆 Victory Bonus | 5g | 3 | +2g per wave won | Extra gold income |
| 🔄 Refresh Master | 6g | 2 | +1 refresh per round | More shop options |

### Post-Battle Healing

After each victorious battle:
```
healPct = 0.25 + (fieldMedicLevel × 0.15)
healAmount = floor(unit.maxHp × healPct)
```

---

## Wave System

### Generation

Waves are generated using a **seeded PRNG** (mulberry32) for reproducibility within a run while varying across runs.

- **Boss waves** (5, 10, 15): Fixed compositions with escort units
- **Non-boss waves** (1–4, 6–9, 11–14): Template-based with role slots

### Wave Templates

Each non-boss wave has 2–3 template variants with difficulty ratings. The generator picks units matching each role slot, applying:

- **Tier cap**: `min(3, ceil(wave / 3))`
- **Variety weighting**: Prefer units not recently seen
- **Forced roles**: Healer or counter-role every 3 waves
- **Void gate**: Void units only appear from wave 3+

### Boss Wave Escorts

| Boss Wave | Boss | Escorts |
|-----------|------|---------|
| Wave 5 | Sun Dragon Sel | 3 Skirmishers + 1 Tank + 1 Sniper |
| Wave 10 | Frost Giant Anvalog | 3 Tanks + 2 Healers + 2 Snipers |
| Wave 15 | The Void Supreme | 3 Casters + 3 Tanks + 3 Skirmishers + 1 Healer |
| Wave 20 | Void Leviathan | 3 Tanks + 3 Casters + 2 Healers + 2 Snipers |
| Wave 25 | The Void Architect | 4 Casters + 4 Tanks + 3 Skirmishers + 2 Healers |

---

## Campaign Modes

| Mode | Waves | Final Boss | Unlock Condition |
|------|-------|------------|------------------|
| **Normal** | 15 | The Void Supreme (W15) | Available from start |
| **Void Campaign** | 25 | The Void Architect (W25) | Beat Normal mode once |

Void Campaign includes all 15 Normal waves plus 10 additional waves (16–25) with **hard mode scaling**.

### Hard Mode Scaling (Waves 16–25)

Enemy stats are multiplied based on wave number:

| Wave | HP | ATK | DEF | SPD |
|------|----|-----|-----|-----|
| 16 | 1.15× | 1.10× | 1.10× | 1.05× |
| 18 | 1.30× | 1.20× | 1.20× | 1.10× |
| 20 (Boss) | 1.50× | 1.30× | 1.30× | 1.15× |
| 22 | 1.65× | 1.40× | 1.40× | 1.20× |
| 25 (Final) | 2.00× | 1.60× | 1.55× | 1.30× |

Boss `phaseHp` values are also scaled by the wave's HP multiplier.

During Void Campaign, **void units become available** in the player shop.

---

## Win / Loss Conditions

| Condition | Trigger |
|-----------|--------|
| **Normal Victory** | Defeat all 15 waves including Wave 15 boss |
| **Void Victory** | Defeat all 25 waves including Wave 25 boss |
| **Defeat** | All player units die during battle |
| **Soft Lock** | No units, no gold, no refreshes available → game over prompt |

### Unlocks on Victory

- **Arcane faction**: `localStorage.shape_strikers_arcane_unlocked = '1'`
- **Void faction + Void Campaign button**: `localStorage.shape_strikers_void_unlocked = '1'`
- **Void Conqueror badge**: `localStorage.shape_strikers_void_campaign_cleared = '1'` (Void Campaign only)

---

## Achievements

11 achievements tracked via `localStorage.shape_strikers_achievements` (JSON object).

| Achievement | Condition | Icon |
|-------------|-----------|------|
| First Victory | Win the Normal Campaign | 🏆 |
| Void Conqueror | Win the Void Campaign | 🕳️ |
| Boss Slayer | Defeat all 5 bosses across runs | 👑 |
| Full Army | Fill all unit slots on the board | 🏰 |
| Synergy Master | Activate 3+ element synergies at once | 🔗 |
| Untouchable | Win a wave without losing any unit | 🛡️ |
| Speed Demon | Win a battle on 4× speed | ⚡ |
| Big Spender | Buy 10+ upgrades in a single run | 💰 |
| Extinction | Kill 100+ enemies in a single run | 💀 |
| Flawless Run | Win the game without losing any unit | ✨ |
| Good Student | Complete the tutorial | 🎓 |

### Post-Game Accolades

After each battle, per-unit accolades are shown in the stats table:

| Accolade | Icon | Condition |
|----------|------|-----------|
| MVP | 🌟 | Highest damage dealt |
| Executioner | 💀 | Most kills |
| Lifeline | 💚 | Most healing done |

---

## Daily & Weekly Challenges

### Daily Challenge

- **Seed**: `YYYY * 10000 + MM * 100 + DD` (deterministic per calendar day)
- **Mode**: Normal campaign (15 waves), no modifiers
- **Waves**: Seeded via `_mulberry32(seed)` — same for all players on the same day
- **Shop**: Non-deterministic (uses `Math.random`) — shop luck varies per player
- **Tracking**: `localStorage.shape_strikers_daily_challenge` — JSON keyed by `"YYYY-MM-DD"`
- **Data**: `{ bestScore, attempts, completed }`

### Weekly Challenge

- **Seed**: `YYYY * 100 + weekNumber` (deterministic per ISO week)
- **Modifier**: One of 8 modifiers selected deterministically from the seed
- **Tracking**: `localStorage.shape_strikers_weekly_challenge` — JSON keyed by `"YYYY-WNN"`

### Challenge Modifiers

| Modifier | Icon | Effect |
|----------|------|--------|
| Inferno | 🔥 | Only fire-element units available in shop |
| Frozen Front | 🧊 | Only ice-element units available in shop |
| No Mercy | 🚫 | Healer-role units banned from shop |
| Glass Cannon | 💥 | Player units: +50% ATK, −50% HP |
| Budget Run | 💰 | Start with 5g (instead of 10g), gold rewards reduced to 70% |
| Fragile | 🩸 | Player units: −30% HP |
| Purity | ✨ | Only one element available (determined by seed) |
| Titan Wave | 🏔️ | Enemy units: +40% HP |

### Challenge Rules

- Challenges always use Normal campaign (15 waves)
- **No campaign unlocks** during challenges (void, arcane factions protected)
- **No achievement progress** during challenges
- Restart during a challenge re-seeds and replays the same challenge
- Quitting returns to title screen and resets challenge state

---

## Visual Indicators

| Indicator | Meaning |
|-----------|---------|
| 💀 Skull badge (top-right) | Enemy unit |
| Red inset glow on tile | Enemy unit tile |
| Happy/cheerful face | Player unit |
| Angry/menacing face | Enemy unit |
| Green HP bar | Healthy (60%+) |
| Orange HP bar | Wounded (25–60%) |
| Red HP bar | Critical (<25%) |
| Blue spotlight ring | Tutorial highlight |
| Floating red number | Damage dealt |
| Floating green number | Healing received |
| Green sparkle particles | Heal burst VFX |
| Golden/purple tile glow | Shield/barrier aura |
| Fire/green/blue tile glow | Burn/poison/freeze aura |
| Ghost effect (faded unit) | Untargetable status |
| Desaturated unit | Frozen status |
| Screen shake | Unit death (strong for bosses) |

---

## Leaderboards

Online leaderboards powered by Supabase (PostgreSQL + anonymous auth).

### Authentication

- **Anonymous sign-in** — no account creation required
- Session persists via Supabase auth tokens in browser storage
- Optional future upgrade to email/social accounts

### Score Submission

Triggered after game-over or win. Player enters a display name (max 20 characters, saved to localStorage for future sessions). Submitted data:

| Field | Type | Description |
|-------|------|-------------|
| `player_name` | text | Display name (sanitized, 1-20 chars) |
| `score` | int | Final score |
| `wave_reached` | int | Last wave completed |
| `campaign_mode` | text | `normal` or `void` |
| `challenge_type` | text | `daily`, `weekly`, or `null` |
| `challenge_key` | text | `YYYY-MM-DD` or `YYYY-WNN`, or `null` |
| `units_used` | int | Total units placed during the run |
| `won` | bool | Whether the player won |

### Leaderboard Tabs

| Tab | Shows | Sort |
|-----|-------|------|
| **Global** | Top scores across all non-challenge games | Score desc |
| **Daily** | Today's daily challenge scores | Score desc |
| **Weekly** | This week's weekly challenge scores | Score desc |
| **Personal** | Current player's best scores | Score desc |

### Graceful Degradation

If Supabase SDK fails to load, credentials are missing, or network is unavailable:
- Game is fully playable without leaderboards
- Leaderboard button shows "Backend not configured" message
- Score submit UI is hidden from game-over/win overlays

---

## Patch Notes

In-game "What's New" overlay accessible from the title screen.

### Data Source

`PATCH_NOTES` array in `src/config.js`. Each entry:

```javascript
{ version: "0.8.0", date: "April 2026", title: "Online Leaderboards", notes: [...] }
```

New entries are added at the **top** of the array (newest first). The overlay renders all entries in order with version badges, titles, dates, and bulleted note lists.

---

## Architecture

```
index.html          Entry point, all screens & overlays
style.css           All styling, animations, responsive layout, themes
src/config.js       Unit definitions, synergies, upgrades, wave templates, scaling, patch notes
src/battle.js       BattleSystem class — pure logic, no DOM
src/grid.js         Grid controller — tile management, canvas rendering, animations
src/vfx.js          CSS particle VFX engine — pooled effects, shockwaves, projectiles
src/ui.js           UI controller — shop, glossary, logs, overlays
src/audio.js        Sound pool management
src/backend.js      Supabase client, authentication, leaderboard API
src/game.js         Game controller — state machine, shop, battle wiring, leaderboard, tutorial
```

---

*Shape Strikers v0.8.0 · By ByteSower*
