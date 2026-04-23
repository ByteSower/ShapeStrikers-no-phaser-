/**
 * Shape Strikers — multiplayer/keys.js
 *
 * Stable unit keys for deterministic multiplayer.
 *
 * Problem solved: game.js assigns every unit a monotonically-increasing
 * integer id (`nextUnitId++`).  Each client starts counting from 1, so
 * the same unit may have id=3 on the host and id=7 on the guest.
 * That causes the board-hash sort to differ and produces diverging
 * event-logs.
 *
 * Solution: before the battle starts, assign each unit a canonical key
 * based on the owner's playerId, the unit definition id, and the unit's
 * initial (pre-battle) grid position.  The key is stable across clients
 * because both clients received the same unit payload with `signalReady`.
 *
 * Exposed as a plain global object (UnitKeys) to match the IIFE pattern.
 */
'use strict';

const UnitKeys = (() => {

  /**
   * Build a canonical stable key for a unit.
   *
   * Format: `{ownerId}::{defId}::{row}::{col}`
   *
   * @param {string} ownerId  – playerId of the unit's owner ('host' or 'guest' side)
   * @param {string} defId    – unit definition id (e.g. 'fire_scout')
   * @param {number} row      – initial canonical sim-row (0-indexed)
   * @param {number} col      – initial canonical sim-col (0-indexed)
   * @returns {string}
   */
  function makeUnitKey(ownerId, defId, row, col) {
    return `${ownerId}::${defId}::${row}::${col}`;
  }

  /**
   * Parse a key back into its components.
   *
   * @param {string} key
   * @returns {{ ownerId: string, defId: string, row: number, col: number }}
   */
  function parseUnitKey(key) {
    const [ownerId, defId, row, col] = key.split('::');
    return { ownerId, defId, row: Number(row), col: Number(col) };
  }

  /**
   * Stamp a stable `stableKey` onto a unit object in place.
   * Also sets `unit.id = stableKey` so BattleSystem comparisons are deterministic.
   *
   * @param {object} unit     – live unit object (must have .definition.id, .row, .col)
   * @param {string} ownerId  – 'p1' or 'p2' (lexicographic player-id side)
   */
  function stampUnit(unit, ownerId) {
    unit.stableKey = makeUnitKey(ownerId, unit.definition.id, unit.row, unit.col);
    // Override the auto-increment id with the stable key so hash/sort are equal
    // on both clients.  The visual id used by Grid callbacks is irrelevant to
    // determinism — Grid uses row/col, not id.
    unit.id = unit.stableKey;
  }

  return { makeUnitKey, parseUnitKey, stampUnit };

})();
