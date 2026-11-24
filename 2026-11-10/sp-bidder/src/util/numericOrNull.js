'use strict';

/**
 * A finite number, or null for anything that is not one. Deliberately TYPED rather than coerced:
 * Number('') / Number(' ') / Number(false) / Number([]) are all 0, so a plain Number.isFinite check
 * reads malformed input as a real zero. Every caller treats null as "unknown", which is the only
 * honest reading of a value SuperProcure did not send as a number.
 *
 * ONE definition, shared by the SuperProcure adapter (which produces remainingQuantity) and the
 * engine's own multi-vehicle plan (the platform-agnostic seam's belt, which has to hold for an
 * adapter that never ran this). A zero read off a malformed field holds a winnable load and tells
 * the customer their load was given out, so the two readers must not be able to disagree.
 */
function numericOrNull(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}

module.exports = { numericOrNull };
