/**
 * Shape Strikers — battle/hashUtils.js
 *
 * Deterministic board-state hashing utilities for multiplayer result
 * verification.
 *
 * Both clients compute the same hash at battle end.  The host broadcasts
 * its hash; the guest compares.  A mismatch indicates divergence (bugs or
 * cheating), but does NOT override the host's authoritative result —
 * it only emits a console warning for debugging.
 *
 * Algorithm: djb2 over a canonical serialisation of all unit states.
 * Units are sorted by stableKey (set by UnitKeys.stampUnit) so the order
 * is independent of insertion order.
 *
 * Exposed as a plain global object (HashUtils) to match the IIFE pattern.
 */
'use strict';

const HashUtils = (() => {

  /**
   * djb2 hash — same implementation used inside BattleSystem for consistency.
   * Returns a 32-bit unsigned integer as a 0-padded 8-hex string.
   *
   * @param {string} str
   * @returns {string}
   */
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /**
   * Serialise a single unit to a compact canonical string.
   * Only the fields that affect game outcome are included.
   *
   * Format: `{id}:{roundedHp}:{alive}:{row}:{col}`
   *
   * @param {object} unit
   * @returns {string}
   */
  function unitToString(unit) {
    const id    = unit.id || unit.stableKey || `${unit.definition?.id}@${unit.row},${unit.col}`;
    const hp    = Math.round(unit.hp);
    const alive = unit.hp > 0 ? '1' : '0';
    return `${id}:${hp}:${alive}:${unit.row}:${unit.col}`;
  }

  /**
   * Compute a deterministic hash for a board state.
   * Units are sorted by id (stable key) before hashing so both clients
   * produce the same string regardless of array insertion order.
   *
   * @param {object[]} allUnits  – combined player + enemy units
   * @returns {string}           – 8-character hex hash
   */
  function hashState(allUnits) {
    const sorted = [...allUnits].sort((a, b) => {
      const ka = String(a.id || a.stableKey || '');
      const kb = String(b.id || b.stableKey || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const payload = sorted.map(unitToString).join('|');
    return djb2(payload);
  }

  /**
   * Log a mismatch warning with both hash values.
   * Never throws — divergence is a diagnostic, not a crash condition.
   *
   * @param {string} localHash
   * @param {string} remoteHash
   */
  function warnMismatch(localHash, remoteHash) {
    console.warn(
      `[HashUtils] Battle hash mismatch — local: ${localHash}, remote: ${remoteHash}.` +
      ' This indicates simulation divergence. Host result is authoritative.'
    );
  }

  return { djb2, hashState, warnMismatch };

})();
