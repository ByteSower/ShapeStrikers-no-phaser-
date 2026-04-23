/**
 * Shape Strikers Web — MultiplayerGame Module
 * Manages the best-of-5 round loop, seeded shop RNG, and gold economy for 1v1.
 * Integrates with Room (channel sync) and exposes callbacks to game.js.
 *
 * Load order: ...room.js → multiplayerGame.js → game.js
 */
'use strict';

const MultiplayerGame = (() => {

  // ── Mulberry32 PRNG (deterministic, no dependencies) ─────────────────────
  function _mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Constants ─────────────────────────────────────────────────────────────
  const TOTAL_ROUNDS   = 5;
  const WINS_NEEDED    = 3;  // best of 5
  const BASE_GOLD      = 10;
  const WIN_BONUS      = 5;
  const UNIT_BONUS     = 2;  // per surviving unit
  const CARRY_CAP      = 30; // max gold carried into next round
  const SHOP_SIZE      = 5;

  // ── Module State ─────────────────────────────────────────────────────────
  let _active      = false;
  let _roomId      = null;
  let _isHost      = false;
  let _opponentId  = null;

  let _round       = 1;
  let _myScore     = 0;
  let _oppScore    = 0;
  let _gold        = BASE_GOLD;   // local player's current gold this round
  let _rerollIdx   = 0;           // reroll count within this round (for seed derivation)
  let _baseSeed    = 0;           // master seed for this round (reset each round)
  let _shopRng     = null;        // active mulberry32 instance

  let _callbacks   = {};          // { onRoundReady, onBothReady, onMatchEnd }

  // Ready flags (local tracking)
  let _myReady     = false;
  let _oppReady    = false;

  // Battle hash stored locally for debug (no cross-client comparison)
  let _myBattleHash  = null;

  // Opponent's serialised unit army received with their ready signal
  let _oppUnits = [];

  // One-shot guard: prevents double-fire of onBothReady per round
  let _battleThisRound = false;
  // One-shot guard: prevents double-fire of onRoundReady (cache-hit + live broadcast race)
  let _shopReadyThisRound = false;

  // Room state-change handler ref so we can detach it
  let _stateHandler = null;

  // ── Public: init (call at page load, idempotent) ─────────────────────────
  function init() {}

  // ── Public: start a new match ─────────────────────────────────────────────
  // callbacks: { onRoundReady(round, gold), onBothReady(), onMatchEnd(winner) }
  function start(roomId, isHost, opponentId, callbacks) {
    _active     = true;
    _roomId     = roomId;
    _isHost     = isHost;
    _opponentId = opponentId;
    _round      = 1;
    _myScore    = 0;
    _oppScore   = 0;
    _gold       = BASE_GOLD;
    _callbacks  = callbacks || {};
    _myReady    = false;
    _oppReady   = false;

    // Attach a persistent Room state-change listener for this match
    _stateHandler = _onRoomState.bind(null);
    if (typeof Room !== 'undefined') Room.onStateChange(_stateHandler);

    if (_isHost) {
      _shopReadyThisRound = false;
      _broadcastNewSeed();
    } else {
      _shopReadyThisRound = false;
      // Guest: the host's 'shop_seed' broadcast may have arrived during the versus screen
      // (before start() was called and _stateHandler was registered).  Room always caches
      // the latest value of every key it receives, so check now and fire onRoundReady
      // immediately if the seed is already available.
      const cachedSeed = (typeof Room !== 'undefined') ? Room.getState()['shop_seed'] : null;
      if (cachedSeed !== null && cachedSeed !== undefined) {
        console.info('[MultiplayerGame] Guest: shop_seed already cached — firing onRoundReady immediately.');
        _initRng(cachedSeed);
        _shopReadyThisRound = true;
        // Defer one microtask so callers finish their own setup before the callback fires.
        Promise.resolve().then(() => _callbacks.onRoundReady?.(_round, _gold));
      }
      // Otherwise _onRoomState will fire when the broadcast arrives.
    }
  }

  // ── Internal: generate and broadcast a new round seed (host only) ────────
  function _broadcastNewSeed() {
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    _shopReadyThisRound = false; // reset so the next round's onRoundReady can fire
    _initRng(seed);
    if (typeof Room !== 'undefined') Room.syncState('shop_seed', seed);
    // Host fires onRoundReady immediately after broadcasting seed
    _shopReadyThisRound = true;
    _callbacks.onRoundReady?.(_round, _gold);
  }

  // ── Internal: initialise RNG from a seed ─────────────────────────────────
  function _initRng(seed) {
    _baseSeed   = seed >>> 0;
    _rerollIdx  = 0;
    _shopRng    = _mulberry32(_deriveSeed(_baseSeed, 0));
  }

  // Derive a deterministic sub-seed from base + reroll index.
  // Both clients call this with the same arguments → identical shops.
  function _deriveSeed(base, rerollN) {
    return (base ^ (rerollN * 0x9e3779b9)) >>> 0;
  }

  // ── Internal: one-shot battle trigger (prevents double-fire via both ready paths) ──────
  function _triggerBothReady() {
    if (_battleThisRound) return;
    _battleThisRound = true;
    _myReady  = false;
    _oppReady = false;
    if (_isHost && typeof Room !== 'undefined') {
      Room.syncState('battle_start', { round: _round });
    }
    _callbacks.onBothReady?.();
  }

  // ── Internal: Room state-change listener ─────────────────────────────────
  function _onRoomState(key, value, fromId) {
    if (!_active) return;

    switch (key) {
      case 'shop_seed':
        // Guest: received seed from host
        if (!_isHost) {
          if (_shopReadyThisRound) {
            // Already handled via cache-hit in start() — skip duplicate.
            break;
          }
          _shopReadyThisRound = true;
          _initRng(value);
          _callbacks.onRoundReady?.(_round, _gold);
        }
        break;

      case 'mp_reroll':
        // Opponent rerolled — advance our RNG so shops stay in sync,
        // then surface the new shop to the local player too.
        _rerollIdx = value;
        _shopRng   = _mulberry32(_deriveSeed(_baseSeed, _rerollIdx));
        _callbacks.onOpponentReroll?.(_round, _gold);
        break;

      case 'ready_p1':
      case 'ready_p2': {
        const mySlot  = _isHost ? 'ready_p1' : 'ready_p2';
        const oppSlot = _isHost ? 'ready_p2' : 'ready_p1';
        // Value is { ready: true, units: [...] } — accept plain true as legacy fallback
        const isReady = value === true || value?.ready === true;
        if (key === oppSlot && isReady) {
          _oppReady = true;
          _oppUnits = value?.units || [];
          _callbacks.onOppReady?.();
        }
        if (key === mySlot && isReady) {
          _myReady = true;
        }
        if (_myReady && _oppReady) _triggerBothReady();
        break;
      }

      case 'battle_start':
        // Non-host receives host's signal — one-shot guard prevents double-fire
        if (!_isHost) _triggerBothReady();
        break;
    }
  }

  // ── Internal: battle hash helpers (MP-4) ────────────────────────────────

  /** Derive a battle seed from the round seed (distinct from shop seed). */
  function getBattleSeed() {
    return (_baseSeed ^ 0xDEADC0DE) >>> 0;
  }

  /** Called by game.js after each battle with the local board hash. Stored locally for debug.
   * Cross-client comparison removed: enemy spawn positions use Math.random() per client,
   * so board states diverge by design. */
  function submitBattleHash(hash) {
    _myBattleHash = hash;
  }

  // ── Public: generate shop units using seeded RNG ─────────────────────────
  // pool: array of unit defs (from UNIT_DEFINITIONS, already filtered)
  // count: number of shop slots (default SHOP_SIZE)
  function generateShopUnits(pool, count) {
    if (!_shopRng) return null; // RNG not seeded yet
    count = count || SHOP_SIZE;
    const rng = _shopRng;
    const { maxTier, w1, w2, w3 } = getTierWeightsForRound(_round);
    return Array.from({ length: count }, () => {
      const roll = rng() * 100;
      let tier = 1;
      if (roll > w1)      tier = 2;
      if (roll > w1 + w2) tier = 3;
      tier = Math.min(tier, maxTier);
      const tierPool = pool.filter(d => d.tier === tier);
      const pick = tierPool.length > 0 ? tierPool : pool;
      return pick[Math.floor(rng() * pick.length)];
    });
  }

  // ── Public: player requested a reroll ────────────────────────────────────
  // Called by game.js when the Refresh button is clicked in MP mode.
  // Returns new shop units array (or null if not seeded).
  function doReroll(pool, count) {
    _rerollIdx++;
    _shopRng = _mulberry32(_deriveSeed(_baseSeed, _rerollIdx));
    // Broadcast so opponent advances their RNG in sync
    if (typeof Room !== 'undefined') Room.syncState('mp_reroll', _rerollIdx);
    return generateShopUnits(pool, count);
  }

  // ── Public: signal this player is ready and broadcast their army ─────────
  // units: array of player unit objects (from game.js state.playerUnits)
  function signalReady(units) {
    _myReady = true;
    const slot = _isHost ? 'ready_p1' : 'ready_p2';

    // Compute synergy multipliers so the opponent spawns our units with
    // synergy-boosted stats — matching what battle.js applies at battle start.
    // Without this, enemy units spawn at base stats, biasing each client's
    // simulation toward their own side (a major cause of cross-client divergence).
    const elemCounts = {};
    for (const u of (units || [])) {
      elemCounts[u.definition.element] = (elemCounts[u.definition.element] || 0) + 1;
    }
    const synergyMult = {};
    if (typeof ELEMENT_SYNERGIES !== 'undefined') {
      // Mirror _applyElementSynergies: group by element+stat, pick highest tier.
      const byElementStat = {};
      for (const syn of ELEMENT_SYNERGIES) {
        if ((elemCounts[syn.element] || 0) >= syn.requiredCount) {
          byElementStat[syn.element + ':' + syn.bonus.stat] = syn;
        }
      }
      for (const syn of Object.values(byElementStat)) {
        const s = syn.bonus.stat;
        synergyMult[s] = (synergyMult[s] || 1) * syn.bonus.multiplier;
      }
    }

    const payload = {
      ready: true,
      units: (units || []).map(u => {
        const stats = { ...u.stats };
        for (const [stat, mult] of Object.entries(synergyMult)) {
          stats[stat] = Math.floor(stats[stat] * mult);
        }
        return {
          defId: u.definition.id,
          row:   u.row,
          col:   u.col,
          stats,
        };
      })
    };
    if (typeof Room !== 'undefined') Room.syncState(slot, payload);
    // Edge case: opponent may already be ready before our signal arrives
    if (_myReady && _oppReady) _triggerBothReady();
  }

  // ── Public: advance to next round after results are shown ────────────────
  // iWon: boolean — did the local player win this round?
  // survivingUnits: number of player units still alive at round end
  function endRound(iWon, survivingUnits) {
    if (!_active) return;

    // Reset per-round battle guard so next round can fire onBothReady
    _battleThisRound = false;
    _shopReadyThisRound = false;

    // Update scores
    if (iWon) _myScore++;
    else       _oppScore++;

    // Gold carry-over + bonus
    const bonus     = getRoundGoldBonus(iWon, survivingUnits);
    const carry     = Math.min(_gold, CARRY_CAP);
    _gold           = carry + BASE_GOLD + bonus;

    // Check for match winner
    const winner = matchWinner();
    if (winner) {
      _callbacks.onMatchEnd?.(winner);
      return;
    }

    // Advance round
    _round++;

    // Reset ready flags for next round
    _myReady  = false;
    _oppReady = false;

    // Host generates new seed; guest waits
    if (_isHost) {
      _broadcastNewSeed();
    }
    // If guest: onRoundReady fires via _onRoomState → 'shop_seed'
  }

  // ── Public helpers ────────────────────────────────────────────────────────
  function getTierWeightsForRound(round) {
    // R1=T1 only, R2=T1-2, R3=T1-3, R4-5=T2-3 heavy
    let maxTier, w1, w2, w3;
    if      (round <= 1) { maxTier = 1; w1 = 100; w2 = 0;  w3 = 0;  }
    else if (round === 2) { maxTier = 2; w1 = 55;  w2 = 45; w3 = 0;  }
    else if (round === 3) { maxTier = 3; w1 = 35;  w2 = 45; w3 = 20; }
    else if (round === 4) { maxTier = 3; w1 = 20;  w2 = 50; w3 = 30; }
    else                  { maxTier = 3; w1 = 10;  w2 = 45; w3 = 45; }
    return { maxTier, w1, w2, w3 };
  }

  function getRoundGoldBonus(iWon, survivingCount) {
    return (iWon ? WIN_BONUS : 0) + Math.max(0, survivingCount || 0) * UNIT_BONUS;
  }

  function matchWinner() {
    if (_myScore  >= WINS_NEEDED) return 'me';
    if (_oppScore >= WINS_NEEDED) return 'opponent';
    // All rounds played — decide by score
    if (_round > TOTAL_ROUNDS) {
      if (_myScore > _oppScore) return 'me';
      if (_oppScore > _myScore) return 'opponent';
      return 'draw';
    }
    return null; // still ongoing
  }

  function isActive()      { return _active; }
  function isHost()        { return _isHost; }
  function getRound()      { return _round; }
  function getGold()       { return _gold; }
  function getScores()     { return { my: _myScore, opp: _oppScore }; }
  function getTotalRounds(){ return TOTAL_ROUNDS; }
  function getBattleSeed() { return (_baseSeed ^ 0xDEADC0DE) >>> 0; }
  function getOppUnits()   { return _oppUnits; }

  // ── Public: destroy (call on match end or leave) ──────────────────────────
  function destroy() {
    if (_stateHandler && typeof Room !== 'undefined') {
      Room.offStateChange(_stateHandler);
    }
    _active          = false;
    _roomId          = null;
    _shopRng         = null;
    _callbacks       = {};
    _stateHandler    = null;
    _myBattleHash    = null;
    _oppUnits        = [];
    _battleThisRound  = false;
    _shopReadyThisRound = false;
  }

  return {
    init,
    start,
    destroy,
    generateShopUnits,
    doReroll,
    signalReady,
    endRound,
    getTierWeightsForRound,
    getRoundGoldBonus,
    matchWinner,
    isActive,
    isHost,
    getRound,
    getGold,
    getScores,
    getTotalRounds,
    getBattleSeed,
    submitBattleHash,
    getOppUnits,
  };
})();
