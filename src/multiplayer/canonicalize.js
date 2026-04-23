/**
 * Shape Strikers — multiplayer/canonicalize.js
 *
 * Army canonicalization for deterministic 1v1 battles.
 *
 * Problem solved: Each client calls BattleSystem.start(myUnits, oppUnits).
 * The host runs [A vs B]; the guest runs [B vs A].  These produce different
 * simulations even with the same RNG seed because array ordering affects
 * turn priority, target selection, and every rng() draw thereafter.
 *
 * Solution: both clients agree on a canonical ordering (army1 = lexicographically
 * smaller playerId) before building the simulation input arrays.  Each client
 * maps their own army to the correct "army1" or "army2" slot and applies the
 * corresponding row-mirror transform.  The simulation input is now byte-for-byte
 * identical on both clients.
 *
 * Row mapping (5-row grid, battleLineRow = 2):
 *   Canonical army1 occupies sim-rows 3–4 (bottom player zone).
 *   Canonical army2 occupies sim-rows 0–1 (top enemy zone).
 *   Visual render for army2's side mirrors: visualRow = 4 - simRow.
 *
 * Exposed as a plain global object (Canonicalize) to match the IIFE pattern.
 */
'use strict';

const Canonicalize = (() => {

  /**
   * Determine which player is "army1" (canonical bottom/player side).
   * Lexicographically smaller playerId wins army1 slot.
   *
   * @param {string} playerIdA
   * @param {string} playerIdB
   * @returns {'A'|'B'}  which player maps to army1
   */
  function army1Owner(playerIdA, playerIdB) {
    return playerIdA <= playerIdB ? 'A' : 'B';
  }

  /**
   * Convert a unit's visual row (from `signalReady` payload) to the canonical
   * sim-row for the army1 slot (rows 3–4 stay as-is).
   *
   * @param {number} visualRow  – original row as placed on player's own grid
   * @returns {number}          – canonical sim row (3 or 4)
   */
  function toArmy1Row(visualRow) {
    // Player places in rows 3 (front) and 4 (back).
    // These map directly to sim rows 3 and 4.
    return visualRow;
  }

  /**
   * Convert a unit's visual row to the canonical sim-row for the army2 slot.
   * Army2 occupies the top of the grid (rows 0–1), mirrored from rows 3–4.
   *
   *   visualRow 3 (front) → simRow 1 (front of top zone)
   *   visualRow 4 (back)  → simRow 0 (back of top zone)
   *
   * Formula: simRow = 4 - visualRow
   *
   * @param {number} visualRow  – original row as placed on player's own grid
   * @returns {number}          – canonical sim row (0 or 1)
   */
  function toArmy2Row(visualRow) {
    return 4 - visualRow;
  }

  /**
   * Build canonical [army1Units, army2Units] arrays from both players' ready
   * payloads.  Stamps stable unit keys onto every unit object.
   *
   * @param {string}   myPlayerId   – local player's Supabase user id
   * @param {string}   oppPlayerId  – opponent's Supabase user id
   * @param {object[]} myUnits      – local player's live unit objects (has .definition, .row, .col, .stats)
   * @param {object[]} oppUnitData  – serialised opponent units from signalReady payload
   *                                  each: { defId, row, col, stats }
   * @param {Function} mkUnit       – game.js _mkUnit(def, row, col, isEnemy) factory
   * @param {object}   UNIT_MAP     – { [defId]: unitDefinition }
   * @returns {{ army1: object[], army2: object[], iAmArmy1: boolean }}
   */
  function canonicalizeArmies(myPlayerId, oppPlayerId, myUnits, oppUnitData, mkUnit, UNIT_MAP) {
    const iAmArmy1 = army1Owner(myPlayerId, oppPlayerId) === 'A'
      ? myPlayerId <= oppPlayerId
      : myPlayerId > oppPlayerId;

    // Rebuild opponent units as proper unit objects in canonical positions
    const oppUnits = (oppUnitData || []).map(data => {
      const def = UNIT_MAP[data.defId];
      if (!def) return null;
      const isEnemy = true; // from local perspective, opp units are enemies
      // canonical sim-row for opp: if opp is army1, rows stay; if army2, mirror
      const simRow = iAmArmy1 ? toArmy2Row(data.row) : toArmy1Row(data.row);
      const unit = mkUnit(def, simRow, data.col, isEnemy);
      if (data.stats) {
        unit.stats = { ...data.stats };
        unit.hp    = data.stats.hp;
        unit.maxHp = data.stats.hp;
      }
      return unit;
    }).filter(Boolean);

    // Assign canonical positions to local player units
    const myCanonical = myUnits.map(u => {
      const simRow = iAmArmy1 ? toArmy1Row(u.row) : toArmy2Row(u.row);
      // Clone to avoid mutating placed units' row during simulation
      return Object.assign({}, u, { row: simRow, stats: { ...u.stats } });
    });

    // Stamp stable keys onto all units
    const myOwnerId  = iAmArmy1 ? 'army1' : 'army2';
    const oppOwnerId = iAmArmy1 ? 'army2' : 'army1';
    if (typeof UnitKeys !== 'undefined') {
      for (const u of myCanonical) UnitKeys.stampUnit(u, myOwnerId);
      for (const u of oppUnits)    UnitKeys.stampUnit(u, oppOwnerId);
    }

    const army1 = iAmArmy1 ? myCanonical : oppUnits;
    const army2 = iAmArmy1 ? oppUnits    : myCanonical;

    return { army1, army2, iAmArmy1 };
  }

  return { army1Owner, toArmy1Row, toArmy2Row, canonicalizeArmies };

})();
