/**
 * Shape Strikers — utils/prng.js
 *
 * Seeded PRNG factory (mulberry32) and helpers.
 * Used by BattleSystem and MultiplayerGame to replace Math.random()
 * calls with a deterministic, seed-driven sequence.
 *
 * Exposed as a plain global object (PRNG) to match the IIFE module pattern.
 */
'use strict';

const PRNG = (() => {

  /**
   * Create a mulberry32 RNG function from a 32-bit seed.
   * Both clients must call this with the same seed to get identical sequences.
   *
   * @param {number} seed  – 32-bit unsigned integer
   * @returns {() => number}  – function returning floats in [0, 1)
   */
  function mulberry32(seed) {
    // Work on a local copy so multiple RNGs don't share mutable state.
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      t  = t >>> 0; // keep 32-bit unsigned
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Draw a random integer in [0, maxExclusive).
   * Avoids the "× floor" floating-point drift that can cause off-by-one
   * errors when maxExclusive is large.
   *
   * @param {() => number} rng
   * @param {number} maxExclusive
   * @returns {number}
   */
  function seededInt(rng, maxExclusive) {
    return Math.floor(rng() * maxExclusive);
  }

  /**
   * Perform a Fisher-Yates shuffle in place using the provided RNG.
   * Returns the mutated array.
   *
   * @param {Array}         arr
   * @param {() => number}  rng
   * @returns {Array}
   */
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = seededInt(rng, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  return { mulberry32, seededInt, shuffle };

})();
