'use strict';
/**
 * QUARANTINED FAILING TEST - documents a real seam bug; deliberately OUTSIDE scripts/ so the green
 * gate (scripts/run-tests.js globs scripts/test-*.js only) never runs it. Run it by hand to watch it
 * FAIL - that failure IS the deliverable: it pins the contract the current impl violates.
 *
 * BUG - src/model/loadRules.js  deriveLoadRules()  line 70:
 *
 *     minDecrement: l.loadBidDifference != null ? Number(l.loadBidDifference) : null
 *
 *   When loadBidDifference is a non-numeric string (SuperProcure has shipped junk/placeholder fields
 *   before - see the year-2100 close-time incident), Number('abc') === NaN and that NaN ESCAPES the
 *   seam into rules.minDecrement. The line's own doc comment promises "Absent -> null (the engine
 *   falls back to caps.minDecrement)", but a junk value yields NEITHER a number NOR null - it yields
 *   NaN, which a null-fallback does not catch and which poisons Layer-3 rung interpolation (NaN rung
 *   sizes, sub-decrement bids SuperProcure answers with HTTP 400).
 *
 *   Confirmed live behavior: deriveLoadRules({ loadBidDifference: 'abc' }).minDecrement -> NaN.
 *
 * DESIRED - a junk loadBidDifference is treated like an absent one (-> null), or any finite number,
 *   but NEVER NaN. A one-line guard at the seam (e.g. store the Number only when Number.isFinite,
 *   else null) closes it - mirrors plausibleCeiling's `if (!Number.isFinite(n)) return null` in the
 *   same file's sibling parse site.
 *
 * Promote to scripts/ (or fold into scripts/test-loadrules-config-edges.js B6) once the seam guards NaN.
 *
 *   node docs/tests/quarantine/test-loadrules-mindecrement-nan-escape.js   # exits NON-ZERO today
 */
const assert = require('assert');
const { deriveLoadRules } = require('../src/model/loadRules');

// Arrange
const load = { id: 'JUNK', loadBidDifference: 'abc' };
// Act
const rules = deriveLoadRules(load);
// Assert - DESIRED contract: null OR a finite number, never NaN. FAILS today (value is NaN).
const v = rules.minDecrement;
assert.ok(
  v === null || Number.isFinite(v),
  `minDecrement for a junk wire value must be null or a finite number, got ${String(v)} (Number.isNaN=${Number.isNaN(v)})`,
);

console.log('  ok  junk loadBidDifference does not leak NaN into minDecrement');
process.exit(0);
