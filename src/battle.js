/**
 * Shape Strikers Web — Battle System
 * Ported from elemental_arena/src/battle/BattleSystem.ts
 *
 * Pure logic — no DOM access. Communicates via callbacks.
 */

// ── Status stack caps ────────────────────────────────────────────────────────
const STATUS_MAX_STACKS = {
  burn: 3, poison: 5, freeze: 3, slow: 8,
  shield: 3, barrier: 1, weaken: 3, wound: 3, untargetable: 1,
};

class BattleSystem {
  constructor() {
    // Callbacks wired by game.js
    this.onUnitDeath   = null;  // (unit)
    this.onBattleEnd   = null;  // (playerWon: bool)
    this.onLogMessage  = null;  // (msg, type)
    this.onPhaseChange = null;  // (boss, phaseName, desc)
    this.onUnitAttack  = null;  // (attacker, target)  — visual: attacker lunges
    this.onUnitHit     = null;  // (target, dmg)       — visual: target flashes + HP bar update
    this.onAbilityUsed = null;  // (unit, abilityName)  — visual: ability effect
    this.onScreenShake = null;  // (intensity)          — visual: screen shake
    this.onUnitMove    = null;  // (unit, fromRow, fromCol, toRow, toCol) — visual: unit slides
    this.onStatusChange = null; // (unit) — visual: status icons update
    this.onActionDone  = null;  // () → Promise<void> — resolves when current animation finishes

    this._running = false;
    this._actionDelay = 500; // ms between individual unit actions
    this._turnDelay   = 300; // ms pause between full rounds
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(playerUnits, enemyUnits) {
    this._playerUnits = playerUnits.slice();
    this._enemyUnits  = enemyUnits.slice();
    this._running = true;
    this._log('⚔️ Battle begins!', 'system');
    this._applyElementSynergies(this._playerUnits);
    this._scheduleRound();
  }

  stop() {
    this._running = false;
    clearTimeout(this._turnTimer);
  }

  setSpeed(multiplier) {
    this._actionDelay = Math.max(80, 500 / multiplier);
    this._turnDelay   = Math.max(50, 300 / multiplier);
  }

  // ── Internal: Round-based action queue ────────────────────────────────────

  _scheduleRound() {
    if (!this._running) return;

    const alive = u => u.hp > 0;
    const players = this._playerUnits.filter(alive);
    const enemies = this._enemyUnits.filter(alive);

    if (players.length === 0 || enemies.length === 0) {
      this._endBattle(enemies.length === 0);
      return;
    }

    // Build action queue: all living units sorted by effective speed desc
    this._actionQueue = [...players, ...enemies].sort((a, b) => {
      const aSlow = a.statusEffects.find(s => s.type === 'slow');
      const bSlow = b.statusEffects.find(s => s.type === 'slow');
      const aSpd = aSlow ? a.stats.speed * Math.max(0.2, 1 - aSlow.stacks * 0.1) : a.stats.speed;
      const bSpd = bSlow ? b.stats.speed * Math.max(0.2, 1 - bSlow.stacks * 0.1) : b.stats.speed;
      return bSpd - aSpd;
    });
    this._actionIndex = 0;
    this._processNextAction();
  }

  _processNextAction() {
    if (!this._running) return;

    // Skip to next living unit
    while (this._actionIndex < this._actionQueue.length && this._actionQueue[this._actionIndex].hp <= 0) {
      this._actionIndex++;
    }

    // End of round — check if battle is over, else start new round
    if (this._actionIndex >= this._actionQueue.length) {
      const alive = u => u.hp > 0;
      const pAlive = this._playerUnits.filter(alive);
      const eAlive = this._enemyUnits.filter(alive);
      if (pAlive.length === 0 || eAlive.length === 0) {
        this._endBattle(eAlive.length === 0);
      } else {
        this._turnTimer = setTimeout(() => this._scheduleRound(), this._turnDelay);
      }
      return;
    }

    const unit = this._actionQueue[this._actionIndex];
    this._actionIndex++;

    const alive = u => u.hp > 0;
    const players = this._playerUnits.filter(alive);
    const enemies = this._enemyUnits.filter(alive);

    // Tick status effects
    this._tickStatus(unit);
    if (unit.hp <= 0) {
      this._killUnit(unit);
      this._turnTimer = setTimeout(() => this._processNextAction(), this._actionDelay);
      return;
    }

    // Skip frozen units (but still tick cooldowns)
    const frozen = unit.statusEffects.find(s => s.type === 'freeze');
    if (frozen) {
      frozen.duration--;
      if (frozen.duration <= 0) unit.statusEffects = unit.statusEffects.filter(s => s !== frozen);
      unit.abilityCooldown = Math.max(0, unit.abilityCooldown - 1);
      this._log(`❄️ ${this._n(unit)} is frozen!`, 'system');
      this._turnTimer = setTimeout(() => this._processNextAction(), this._actionDelay * 0.5);
      return;
    }

    // Use ability if off cooldown, else try attack, else move
    const targets = unit.isEnemy ? players : enemies;
    const hasTarget = this._pickTarget(unit, targets);

    // Healers should only use ability when an ally is actually damaged
    const isHealer = unit.definition.ability?.healAmount > 0;
    const allyNeedsHeal = isHealer
      ? (unit.isEnemy ? enemies : players).some(u => u.hp > 0 && u.hp < u.maxHp)
      : true;

    if (hasTarget && unit.abilityCooldown <= 0 && allyNeedsHeal) {
      this._useAbility(unit, unit.isEnemy ? players : enemies, unit.isEnemy ? enemies : players);
      unit.abilityCooldown = unit.definition.ability.cooldown;
    } else if (hasTarget) {
      unit.abilityCooldown--;
      this._attack(unit, targets);
    } else {
      // No target in range — try to move closer
      unit.abilityCooldown = Math.max(0, unit.abilityCooldown - 1);
      this._moveTowardEnemy(unit, targets);
    }

    // Wait for attack/ability animation to finish before scheduling next action
    const proceed = () => {
      const pAlive2 = this._playerUnits.filter(alive);
      const eAlive2 = this._enemyUnits.filter(alive);
      if (pAlive2.length === 0 || eAlive2.length === 0) {
        this._turnTimer = setTimeout(() => this._endBattle(eAlive2.length === 0), this._actionDelay);
      } else {
        this._turnTimer = setTimeout(() => this._processNextAction(), this._actionDelay);
      }
    };
    if (this.onActionDone) {
      this.onActionDone().then(proceed);
    } else {
      proceed();
    }
  }

  // ── Combat primitives ────────────────────────────────────────────────────

  _attack(attacker, targets) {
    const target = this._pickTarget(attacker, targets);
    if (!target) return;

    const dmg = this._calcDamage(attacker, target);
    if (this.onUnitAttack) this.onUnitAttack(attacker, target);
    this._applyDamage(target, dmg);
    if (this.onUnitHit) this.onUnitHit(target, dmg);
    this._log(`${this._n(attacker)} attacks ${this._n(target)} for ${dmg} dmg`, 'attack', this._side(attacker));

    // Lifesteal (blood units)
    if (attacker.definition.id.startsWith('blood_')) {
      const heal = Math.floor(dmg * 0.4);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
      this._log(`🩸 ${this._n(attacker)} heals ${heal} HP`, 'heal', this._side(attacker));
      if (this.onUnitHit) this.onUnitHit(attacker, -heal);
    }

    if (target.hp <= 0) this._killUnit(target);
  }

  _useAbility(unit, enemies, allies) {
    const ab = unit.definition.ability;
    const uid = unit.definition.id;
    this._log(`✨ ${this._n(unit)} uses ${ab.name}!`, 'ability', this._side(unit));
    if (this.onAbilityUsed) this.onAbilityUsed(unit, ab.name);

    const unitRange = unit.stats.range || 1;
    const aliveEnemies = enemies.filter(u => u.hp > 0 && Math.abs(unit.row - u.row) <= unitRange);
    const aliveAllies  = allies.filter(u => u.hp > 0);

    // ── Per-unit ability dispatch ─────────────────────────────────────────
    switch (uid) {
      // ---- TIER 1 ----
      case 'fire_imp':       // Ember Strike: 1.5× single + burn
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.5);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'burn', 3, 5);
        break;
      case 'ice_slime':      // Frost Coat: slow all nearby enemies (range 2)
        { const nearby = aliveEnemies.filter(e => Math.abs(unit.row - e.row) <= 2);
          for (const t of nearby) this._addStatus(t, 'slow', 2);
          if (nearby.length) this._log(`❄️ ${nearby.length} enemies slowed!`, 'ability'); }
        break;
      case 'earth_golem':    // Stone Skin: self shield
        this._addStatus(unit, 'shield', 2, 15);
        this._log(`🛡️ ${this._n(unit)} hardens!`, 'ability');
        break;
      case 'lightning_sprite': // Chain Lightning: bounces to 3 targets
        this._abilityDamage(unit, aliveEnemies.slice(0, 3), 1.4);
        break;
      case 'earth_archer':   // Boulder Toss: 1.4× + stun 1 turn
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.4);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'freeze', 1);
        if (aliveEnemies[0]) this._log(`💫 ${this._n(aliveEnemies[0])} stunned!`, 'ability');
        break;
      case 'fire_scout':     // Fire Bolt: 1.4× + minor burn
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.4);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'burn', 2, 3);
        break;
      case 'frost_fairy':    // Healing Frost: heal lowest HP ally 25
        this._healAllies(unit, aliveAllies, ab.healAmount || 25, false);
        break;
      case 'blood_sprite':   // Drain Touch: 1.4× + 40% lifesteal
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.4, true);
        break;
      case 'konji_scout':    // Toxic Dart: 1.4× + poison 3 turns
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.4);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'poison', 3, 8);
        break;
      case 'void_shade':     // Shadow Phase: untargetable 1 turn + 1.8× stealth strike
        this._addStatus(unit, 'untargetable', 1);
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.8);
        break;

      // ---- TIER 2 ----
      case 'fire_warrior':   // Blazing Charge: damage ALL enemies in same column + burn
        { const sameCol = aliveEnemies.filter(e => e.col === unit.col);
          const targets = sameCol.length ? sameCol : aliveEnemies.slice(0, 1);
          this._abilityDamage(unit, targets, 1.4);
          this._applyStatusToTargets(targets, 'burn', 3, 5); }
        break;
      case 'ice_archer':     // Frost Arrow: 1.2× + freeze
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.2);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'freeze', 1);
        break;
      case 'arcane_mage':    // Arcane Blast: 2.0× single
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 2.0);
        break;
      case 'lightning_knight': // Thunder Strike: 1.6× + stun
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.6);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'freeze', 1);
        if (aliveEnemies[0]) this._log(`⚡ ${this._n(aliveEnemies[0])} stunned!`, 'ability');
        break;
      case 'ice_guardian':   // Frozen Wall: self shield 3 turns + slow ALL enemies
        this._addStatus(unit, 'shield', 3, 15);
        for (const t of aliveEnemies) this._addStatus(t, 'slow', 2);
        this._log(`❄️ All enemies slowed by Frozen Wall!`, 'ability');
        break;
      case 'arcane_assassin': // Shadow Strike: 50% chance 2.5× crit or 1.5×
        { const crit = Math.random() < 0.5;
          this._abilityDamage(unit, aliveEnemies.slice(0, 1), crit ? 2.5 : 1.5);
          if (crit) this._log(`💥 Critical hit!`, 'ability'); }
        break;
      case 'nature_spirit':  // Rejuvenate: heal ALL allies 15 HP
        this._healAllies(unit, aliveAllies, ab.healAmount || 15, true);
        break;
      case 'arcane_priest':  // Arcane Restoration: heal lowest 25 HP + shield
        this._healAllies(unit, aliveAllies, ab.healAmount || 25, false);
        { const lowest = aliveAllies.sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
          if (lowest) this._addStatus(lowest, 'shield', 2, 10); }
        break;
      case 'blood_knight':   // Crimson Cleave: 1.2× to up to 3 + 30% lifesteal
        this._abilityDamage(unit, aliveEnemies.slice(0, 3), 1.2, true, 0.3);
        break;
      case 'konji_shaman':   // Plague Cloud: 0.3× + poison ALL enemies
        this._abilityDamage(unit, aliveEnemies, 0.3);
        this._applyStatusToTargets(aliveEnemies, 'poison', 2, 8);
        break;
      case 'void_knight':    // Corruption Strike: 1.4× + weaken
        this._abilityDamage(unit, aliveEnemies.slice(0, 1), 1.4);
        this._applyStatusToTargets(aliveEnemies.slice(0, 1), 'weaken', 2);
        break;
      case 'void_blighter':  // Cursed Wound: 0.6× ALL enemies + wound
        this._abilityDamage(unit, aliveEnemies, 0.6);
        this._applyStatusToTargets(aliveEnemies, 'wound', 3);
        break;

      // ---- TIER 3 ----
      case 'fire_demon':     // Hellfire: 0.6× up to 3 targets + burn
        this._abilityDamage(unit, aliveEnemies.slice(0, 3), 0.6);
        this._applyStatusToTargets(aliveEnemies.slice(0, 3), 'burn', 3, 5);
        break;
      case 'martial_master': // Thousand Fists: 4 rapid strikes at 0.4× each
        for (let i = 0; i < 4; i++) {
          const alive = aliveEnemies.filter(e => e.hp > 0);
          if (alive.length === 0) break;
          this._abilityDamage(unit, [alive[0]], 0.4);
        }
        break;
      case 'lightning_lord':  // Thunder Storm: 0.7× ALL enemies
        this._abilityDamage(unit, aliveEnemies, 0.7);
        break;
      case 'ice_empress':    // Blizzard: 0.5× ALL + freeze
        this._abilityDamage(unit, aliveEnemies, 0.5);
        this._applyStatusToTargets(aliveEnemies, 'freeze', 1);
        break;
      case 'life_guardian':  // Guardian's Blessing: heal ALL 30 + barrier ALL
        this._healAllies(unit, aliveAllies, ab.healAmount || 30, true);
        for (const t of aliveAllies) this._addStatus(t, 'barrier', 2);
        break;
      case 'void_horror':    // Void Rupture: AoE ignores defense
        for (const t of aliveEnemies) {
          const dmg = Math.max(1, Math.floor(unit.stats.attack * 1.2));
          this._applyDamage(t, dmg);
          if (this.onUnitHit) this.onUnitHit(t, dmg);
          this._log(`💥 ${this._n(t)} takes ${dmg} void dmg`, 'attack', this._side(unit));
          if (t.hp <= 0) this._killUnit(t);
        }
        break;

      // ---- BOSSES ----
      case 'boss_flame_tyrant': // Tyrant's Wrath: 0.6× ALL enemies + burn
        this._abilityDamage(unit, aliveEnemies, 0.6);
        this._applyStatusToTargets(aliveEnemies, 'burn', 3, 8);
        break;
      case 'boss_frost_colossus': // Absolute Zero: freeze ALL + 0.3× dmg + heal self
        this._abilityDamage(unit, aliveEnemies, 0.3);
        for (const t of aliveEnemies.filter(u => u.hp > 0)) this._addStatus(t, 'freeze', ab.freezeDuration || 2);
        this._log(`❄️ All units frozen by Absolute Zero!`, 'ability');
        { const actual = Math.min(ab.healAmount || 80, unit.maxHp - unit.hp);
          unit.hp += actual;
          if (actual > 0) this._log(`💚 ${this._n(unit)} restores ${actual} HP`, 'heal', this._side(unit)); }
        break;
      case 'boss_chaos_overlord': // Elemental Cataclysm: 0.4× ALL + enrage at <30%
        this._abilityDamage(unit, aliveEnemies, 0.4);
        if (unit.hp / unit.maxHp < 0.3) {
          this._addStatus(unit, 'shield', 1, 20);
          this._log(`⚡ ${this._n(unit)} is enraged!`, 'ability');
        }
        break;

      // ---- FALLBACK: generic ability ----
      default:
        if (ab.healAmount) {
          this._healAllies(unit, aliveAllies, ab.healAmount, ab.description?.toLowerCase().includes('all'));
        } else {
          this._abilityDamage(unit, aliveEnemies.slice(0, ab.maxTargets || 1), 1.4);
        }
        break;
    }
  }

  // ── Ability helpers ───────────────────────────────────────────────────────

  _abilityDamage(unit, targets, mult, lifesteal = false, lifestealPct = 0.4) {
    for (const target of targets) {
      if (target.hp <= 0) continue;
      const dmg = this._calcDamage(unit, target, mult);
      this._applyDamage(target, dmg);
      if (this.onUnitHit) this.onUnitHit(target, dmg);
      this._log(`💥 ${this._n(target)} takes ${dmg} ability dmg`, 'attack', this._side(unit));
      if (lifesteal || unit.definition.id.startsWith('blood_')) {
        const pct = unit.definition.id.startsWith('blood_') ? 0.4 : lifestealPct;
        const heal = Math.floor(dmg * pct);
        unit.hp = Math.min(unit.maxHp, unit.hp + heal);
        this._log(`🩸 ${this._n(unit)} heals ${heal} HP`, 'heal', this._side(unit));
        if (this.onUnitHit) this.onUnitHit(unit, -heal);
      }
      if (target.hp <= 0) this._killUnit(target);
    }
  }

  _healAllies(unit, allies, amount, healAll) {
    const targets = healAll
      ? allies.filter(u => u.hp > 0)
      : [allies.filter(u => u.hp > 0).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0]].filter(Boolean);
    for (const t of targets) {
      const actual = Math.min(amount, t.maxHp - t.hp);
      t.hp += actual;
      this._log(`💚 ${this._n(t)} healed ${actual} HP`, 'heal', this._side(unit));
      if (this.onUnitHit) this.onUnitHit(t, -actual);
    }
  }

  _applyStatusToTargets(targets, type, duration, stacks = 0) {
    for (const t of targets) {
      if (t.hp > 0) this._addStatus(t, type, duration, stacks);
    }
  }

  _calcDamage(attacker, target, mult = 1.0) {
    const atk = attacker.stats.attack;
    const def = Math.max(0, target.stats.defense);

    // Shield adds to defense (value per stack)
    const shield = target.statusEffects.find(s => s.type === 'shield');
    const defTotal = shield ? def + (shield.value || 10) * shield.stacks : def;

    // Weaken reduces attacker (8% per stack, max 24% at 3 stacks)
    const weaken = attacker.statusEffects.find(s => s.type === 'weaken');
    const atkMod = weaken ? atk * Math.max(0.5, 1 - weaken.stacks * 0.08) : atk;

    // Diminishing returns defense: reduction = def / (def + 50)
    const dmgReduction = defTotal / (defTotal + 50);
    let dmg = Math.max(1, Math.floor(atkMod * (1 - dmgReduction) * mult));
    return dmg;
  }

  _applyDamage(unit, dmg) {
    unit.hp = Math.max(0, unit.hp - dmg);
    // Check boss phase transitions whenever a boss takes damage
    if (unit.definition.isBoss) this._checkBossPhase(unit);
  }

  _pickTarget(attacker, targets) {
    const alive = targets.filter(t => {
      if (t.hp <= 0) return false;
      if (t.statusEffects.find(s => s.type === 'untargetable')) return false;
      // Check range: row distance only (lane-based combat)
      const dist = Math.abs(attacker.row - t.row);
      if (dist > (attacker.stats.range || 1)) return false;
      return true;
    });
    if (alive.length === 0) return null;
    // Prefer units in same column (lane), else lowest HP
    const sameCol = alive.filter(t => t.col === attacker.col);
    const pool = sameCol.length > 0 ? sameCol : alive;
    return pool.sort((a, b) => a.hp - b.hp)[0];
  }

  _moveTowardEnemy(unit, targets) {
    const alive = targets.filter(t => t.hp > 0 && !t.statusEffects.find(s => s.type === 'untargetable'));
    if (alive.length === 0) return;

    // Find closest enemy
    let closest = alive[0];
    let closestDist = Math.abs(unit.row - closest.row) + Math.abs(unit.col - closest.col);
    for (const t of alive) {
      const d = Math.abs(unit.row - t.row) + Math.abs(unit.col - t.col);
      if (d < closestDist) { closest = t; closestDist = d; }
    }

    const allUnits = [...this._playerUnits, ...this._enemyUnits].filter(u => u.hp > 0 && u !== unit);
    const isOccupied = (r, c) => allUnits.some(u => u.row === r && u.col === c);

    const battleLine = GRID_CONFIG.battleLineRow; // row 2
    const fromRow = unit.row;
    const fromCol = unit.col;
    let moved = false;

    // Lane-based movement: advance toward battle line, clamped at row 2
    // Player units move UP (row--), clamped at battleLine minimum
    // Enemy units move DOWN (row++), clamped at battleLine maximum
    let preferredRow;
    if (unit.isEnemy) {
      preferredRow = Math.min(unit.row + 1, battleLine); // enemies can't go past row 2
    } else {
      preferredRow = Math.max(unit.row - 1, battleLine); // players can't go past row 2
    }

    const colDir = closest.col > unit.col ? 1 : closest.col < unit.col ? -1 : 0;

    // If already at the battle line, move horizontally toward target (or find any open lane)
    if (preferredRow === unit.row) {
      if (colDir !== 0) {
        const newCol = unit.col + colDir;
        if (newCol >= 0 && newCol < GRID_CONFIG.cols && !isOccupied(unit.row, newCol)) {
          unit.col = newCol;
          moved = true;
        }
      }
      // Fallback: if same column or blocked, try moving toward ANY reachable enemy
      if (!moved) {
        for (const t of alive) {
          const dir = t.col > unit.col ? 1 : t.col < unit.col ? -1 : 0;
          if (dir !== 0) {
            const nc = unit.col + dir;
            if (nc >= 0 && nc < GRID_CONFIG.cols && !isOccupied(unit.row, nc)) {
              unit.col = nc;
              moved = true;
              break;
            }
          }
        }
      }
    } else {
      // Priority 1: advance forward in same column
      if (!isOccupied(preferredRow, unit.col)) {
        unit.row = preferredRow;
        moved = true;
      }
      // Priority 2: diagonal toward target
      else if (colDir !== 0) {
        const diagCol = unit.col + colDir;
        if (diagCol >= 0 && diagCol < GRID_CONFIG.cols && !isOccupied(preferredRow, diagCol)) {
          unit.row = preferredRow;
          unit.col = diagCol;
          moved = true;
        }
      }
      // Priority 3: diagonal other direction (just to advance row)
      if (!moved) {
        const dirs = colDir !== 0 ? [-colDir, colDir] : [-1, 1];
        for (const d of dirs) {
          const tryCol = unit.col + d;
          if (tryCol >= 0 && tryCol < GRID_CONFIG.cols && !isOccupied(preferredRow, tryCol)) {
            unit.row = preferredRow;
            unit.col = tryCol;
            moved = true;
            break;
          }
        }
      }
    }

    if (moved && this.onUnitMove) {
      this.onUnitMove(unit, fromRow, fromCol, unit.row, unit.col);
    }
  }

  _addStatus(unit, type, duration, value = 0) {
    // Barrier blocks only negative effects
    const NEGATIVE = ['burn', 'poison', 'freeze', 'slow', 'weaken', 'wound'];
    if (NEGATIVE.includes(type) && unit.statusEffects.find(s => s.type === 'barrier')) return;

    const maxStacks = STATUS_MAX_STACKS[type] || 1;
    const existing = unit.statusEffects.find(s => s.type === type);

    if (existing) {
      existing.stacks = Math.min(existing.stacks + 1, maxStacks);
      existing.duration = Math.max(existing.duration, duration);
      if (value > 0) existing.value = Math.max(existing.value || 0, value);
    } else {
      unit.statusEffects.push({ type, duration, stacks: 1, value: value || 0 });
    }
    if (this.onStatusChange) this.onStatusChange(unit);
  }

  _tickStatus(unit) {
    for (const eff of unit.statusEffects.slice()) {
      if (eff.type === 'burn' || eff.type === 'poison') {
        const baseDmg = eff.value || 5;
        const dmg = baseDmg * eff.stacks;
        unit.hp = Math.max(0, unit.hp - dmg);
        this._log(`${eff.type === 'burn' ? '🔥' : '☠️'} ${this._n(unit)} takes ${dmg} ${eff.type} dmg (×${eff.stacks})`, 'attack');
        if (this.onUnitHit) this.onUnitHit(unit, dmg);
      }
      eff.duration--;
    }
    unit.statusEffects = unit.statusEffects.filter(e => e.duration > 0);
    if (this.onStatusChange) this.onStatusChange(unit);
  }

  _killUnit(unit) {
    unit.hp = 0;
    this._log(`💀 ${this._n(unit)} defeated!`, 'death', this._side(unit));
    if (this.onScreenShake) this.onScreenShake(unit.definition.isBoss ? 12 : 5);
    if (this.onUnitDeath) this.onUnitDeath(unit);
  }

  // ── Synergies ────────────────────────────────────────────────────────────

  _applyElementSynergies(units) {
    // Save base stats before applying synergies (including hp/maxHp for HP synergies)
    for (const u of units) {
      u._baseStats = { ...u.stats };
      u._baseHp = u.hp;
      u._baseMaxHp = u.maxHp;
    }

    const counts = {};
    for (const u of units) counts[u.definition.element] = (counts[u.definition.element] || 0) + 1;

    // Group synergies by element, pick only highest matching tier
    const byElement = {};
    for (const syn of ELEMENT_SYNERGIES) {
      if ((counts[syn.element] || 0) >= syn.requiredCount) {
        byElement[syn.element + ':' + syn.bonus.stat] = syn; // last (highest count) wins
      }
    }

    for (const syn of Object.values(byElement)) {
      for (const u of units.filter(u2 => u2.definition.element === syn.element)) {
        u.stats[syn.bonus.stat] = Math.floor(u._baseStats[syn.bonus.stat] * syn.bonus.multiplier);
        // HP synergies must also update the live hp/maxHp fields
        if (syn.bonus.stat === 'hp') {
          const newMaxHp = Math.floor(u._baseMaxHp * syn.bonus.multiplier);
          const hpGain = newMaxHp - u.maxHp;
          u.maxHp = newMaxHp;
          u.hp = Math.min(u.hp + hpGain, u.maxHp);
        }
      }
      this._log(`✨ Synergy: ${syn.description}`, 'ability');
    }
  }

  _resetSynergies(units) {
    for (const u of units) {
      if (u._baseStats) {
        Object.assign(u.stats, u._baseStats);
        delete u._baseStats;
      }
      // Restore live hp/maxHp from pre-synergy values
      if (u._baseMaxHp !== undefined) {
        u.maxHp = u._baseMaxHp;
        u.hp = Math.min(u.hp, u.maxHp);
        delete u._baseHp;
        delete u._baseMaxHp;
      }
    }
  }

  // ── Boss Phases ──────────────────────────────────────────────────────────

  _checkBossPhase(boss) {
    const phases = boss.definition.bossPhases;
    if (!phases || boss._currentPhaseIndex === undefined) boss._currentPhaseIndex = 0;

    const pct = boss.hp / boss.maxHp;
    const nextPhase = phases[boss._currentPhaseIndex + 1];
    if (nextPhase && pct <= nextPhase.hpThreshold) {
      boss._currentPhaseIndex++;
      const phase = phases[boss._currentPhaseIndex];

      // Apply stat multipliers from BASE stats (not compounding)
      if (!boss._bossBaseStats) boss._bossBaseStats = { attack: boss.stats.attack, defense: boss.stats.defense, speed: boss.stats.speed };
      if (phase.statModifiers.attackMult)  boss.stats.attack  = Math.floor(boss._bossBaseStats.attack  * phase.statModifiers.attackMult);
      if (phase.statModifiers.defenseMult) boss.stats.defense = Math.floor(boss._bossBaseStats.defense * phase.statModifiers.defenseMult);
      if (phase.statModifiers.speedMult)   boss.stats.speed   = Math.floor(boss._bossBaseStats.speed   * phase.statModifiers.speedMult);

      // For Chaos Overlord: reset HP to new phase pool
      if (phase.phaseHp) {
        boss.hp = phase.phaseHp;
        boss.maxHp = phase.phaseHp;
      }

      this._log(`⚡ BOSS PHASE: ${phase.name} — ${phase.description}`, 'phase');
      if (this.onPhaseChange) this.onPhaseChange(boss, phase.name, phase.description);
    }
  }

  // ── End Battle ───────────────────────────────────────────────────────────

  _endBattle(playerWon) {
    this._running = false;
    // Reset synergy-modified stats back to base
    this._resetSynergies(this._playerUnits);
    this._log(playerWon ? '🏆 Victory!' : '💀 Defeated!', 'system');
    if (this.onBattleEnd) this.onBattleEnd(playerWon);
  }

  _log(msg, type = 'system', side = null) {
    if (this.onLogMessage) this.onLogMessage(msg, type, side);
  }

  // Tag unit name for log clarity — "⚔Fire Scout" (player) vs "👾Fire Scout" (enemy)
  _n(unit) { return unit.isEnemy ? `👾${unit.name}` : `⚔${unit.name}`; }
  _side(unit) { return unit.isEnemy ? 'enemy' : 'player'; }
}
