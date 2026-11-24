'use strict';
/**
 * Rank-driven rung selection (pricing.selectRung) - the single source of "which rung next" for
 * soft-close defend, hard-close step-down and the final snipe. Table-driven over BOTH worked-example
 * bands in the logic spec (_research/2026-07-24_softclose-rung-logic-and-arm-inputs.md s4):
 *
 *   - the live 3-rung band  [20268, 19296, 18486]  (cost 18000 on the 12.6/7.2/2.7 band, floor 18486)
 *   - a finer 6-rung band   [20268, 19944, 19620, 19296, 18891, 18486]  (same top + floor, 4 between;
 *     this is exactly what interpolateBandLadder(rungs 6, minDecrement 100) builds off that band)
 *
 * Covers every rank path (k=1 hold, k>1 defend, k>1 snipe, k=null defend->hold, k=null snipe->floor),
 * the target<=i hold/floor branches, skip-already-fired, the last<3 coarse-floor guard, and a
 * jumpPerRival=2 row. Asserts the exact returned rung INDEX and, when a rung fires, its price.
 *
 *   node scripts/test-rung-select.js
 */
const assert = require('assert');
const { selectRung } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const BAND3 = [20268, 19296, 18486];                       // last = 2 (coarse; snipe collapses to floor)
const BAND6 = [20268, 19944, 19620, 19296, 18891, 18486];  // last = 5 (fine; snipe keeps the highest winner)

// Each row: which band, standing rung i, live rank k, phase, already-fired rungs, jumpPerRival, and
// the expected rung index (or null to hold). `why` documents the branch the row pins.
const rows = [
  // --- 3-rung band, the spec's first worked table --------------------------------------------------
  { name: 'k=1 defend -> hold (winning, never improve)',            band: BAND3, i: 0, k: 1,    phase: 'defend', expect: null },
  { name: 'k=1 snipe -> hold (still winning at the buzzer)',        band: BAND3, i: 1, k: 1,    phase: 'snipe',  expect: null },
  { name: 'L3 defend from rung0: jump2 target2 clamp last-1=1',     band: BAND3, i: 0, k: 3,    phase: 'defend', expect: 1 },
  { name: 'L2 defend from rung1: target2 clamp1 = current -> hold', band: BAND3, i: 1, k: 2,    phase: 'defend', expect: null },
  { name: 'L2 snipe on 3-rung: last<3 coarse guard -> floor',       band: BAND3, i: 1, k: 2,    phase: 'snipe',  expect: 2 },
  { name: 'L3 snipe on 3-rung: last<3 coarse guard -> floor',       band: BAND3, i: 0, k: 3,    phase: 'snipe',  expect: 2 },
  { name: 'k=null defend on 3-rung -> hold (no bidding on a guess)', band: BAND3, i: 0, k: null, phase: 'defend', expect: null },
  { name: 'k=null snipe on 3-rung -> floor (last-shot fallback)',   band: BAND3, i: 0, k: null, phase: 'snipe',  expect: 2 },

  // --- 6-rung band, the spec's finer worked table --------------------------------------------------
  { name: 'L3 defend from rung0 on 6-rung: jump2 -> rung2',         band: BAND6, i: 0, k: 3,    phase: 'defend', expect: 2 },
  { name: 'L2 defend from rung2 on 6-rung: jump1 -> rung3',         band: BAND6, i: 2, k: 2,    phase: 'defend', expect: 3 },
  { name: 'L2 snipe from rung3 on 6-rung: target4 -> rung4, NOT floor', band: BAND6, i: 3, k: 2, phase: 'snipe', expect: 4 },
  { name: 'deep-rank snipe on 6-rung: jump3 target7 clamp last=5 -> floor', band: BAND6, i: 4, k: 4, phase: 'snipe', expect: 5 },
  { name: 'snipe target<=i (already on floor) -> floor',            band: BAND6, i: 5, k: 2,    phase: 'snipe',  expect: 5 },
  { name: 'defend clamps to last-1, never the floor (jump5 -> rung4)', band: BAND6, i: 0, k: 6, phase: 'defend', expect: 4 },
  { name: 'defend skip-fired: rung2 fired -> walk down to rung3',   band: BAND6, i: 0, k: 3,    phase: 'defend', fired: [2], expect: 3 },
  { name: 'defend skip-fired runs out below floor -> hold',         band: BAND6, i: 0, k: 6,    phase: 'defend', fired: [4], expect: null },
  { name: 'snipe skip-fired: rung3 fired -> walk down to rung4',    band: BAND6, i: 2, k: 2,    phase: 'snipe',  fired: [3], expect: 4 },
  { name: 'jumpPerRival=2 defend from rung0 (L3): jump4 -> rung4',  band: BAND6, i: 0, k: 3,    phase: 'defend', jumpPerRival: 2, expect: 4 },
];

for (const r of rows) {
  const last = r.band.length - 1;
  const fired = new Set(r.fired || []); // the live monitor passes a Set; selectRung tolerates both
  const args = { i: r.i, k: r.k, last, firedRungs: fired, phase: r.phase };
  if (r.jumpPerRival != null) args.jumpPerRival = r.jumpPerRival;
  const got = selectRung(args);
  assert.strictEqual(got, r.expect, `${r.name}: expected rung ${r.expect}, got ${got}`);
  if (r.expect !== null) {
    // a fired rung must resolve to a real, in-bounds price on the band
    assert.ok(got >= 0 && got <= last, `${r.name}: rung ${got} in bounds`);
    ok(`${r.name} -> rung ${got} (${r.band[got]})`);
  } else {
    ok(`${r.name} -> hold`);
  }
}

// The array form of firedRungs (durable-intent path) must behave identically to the Set form.
{
  const asSet = selectRung({ i: 0, k: 3, last: 5, firedRungs: new Set([2]), phase: 'defend' });
  const asArr = selectRung({ i: 0, k: 3, last: 5, firedRungs: [2], phase: 'defend' });
  assert.strictEqual(asSet, asArr, 'Set and array firedRungs agree');
  assert.strictEqual(asArr, 3, 'array firedRungs still skips the fired rung');
  ok('firedRungs accepts a Set or an array identically');
}

// Purity: selectRung never mutates the firedRungs it is handed.
{
  const fired = new Set([2]);
  selectRung({ i: 0, k: 3, last: 5, firedRungs: fired, phase: 'defend' });
  assert.strictEqual(fired.size, 1, 'firedRungs untouched');
  assert.ok(fired.has(2) && !fired.has(3), 'no rung was added or removed');
  ok('selectRung is pure - it does not mutate firedRungs');
}

console.log(`\n${pass}/${rows.length + 2} checks passed`);
process.exit(0);
