'use strict';
/**
 * RE-SPACING A CEILING-CAPPED LADDER KEEPS EVERY PRICE ON A ROUND-FIGURE SHIPPER'S GRID.
 *
 * Regression target: R2-9 (T4 D1) on a load that also carries a rupee grid. Re-spacing moves a middle
 * price to (previous price - minimum bid difference). When the grid does not divide that minimum, the
 * moved price lands off the grid, and a round-figure shipper refuses it. The gap is taken in whole
 * grid steps instead.
 *
 * Cost 40,000, band [25, 12.5, 7.5, 2.5], minimum 2.5, grid 500, minimum bid difference 700:
 *   band prices [50000, 45000, 43000, 41000], all on the grid, every step clears 700
 *   ceiling 45,600 -> on the grid 45,500 -> capped [45500, 45000, 43000, 41000], first step 500 < 700
 *   re-spaced in whole grid steps (1,000): [45500, 44500, 43000, 41000]
 *   re-spaced by the raw 700 it would be [45500, 44800, 43000, 41000], and 44,800 is off the grid.
 *
 * WHAT MUST NOT MOVE: with no grid the same ceiling re-spaces by the raw minimum,
 * [45600, 44900, 43000, 41000]; and a ceiling above the opening leaves the plan exactly as with no
 * ceiling, even where the grid snap left a short step (band [25, 12.5, 4.5, 2.5] snaps to
 * [50000, 45000, 41500, 41000], and ceiling 60,000 must preview that same ladder).
 *
 *   node scripts/test-ceiling-respace-stays-on-grid.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const MIN_DEC = 700;
const STEP = 500;
const CEILING = 45_600;
const BAND = { cost: 40_000, marginsPct: [25, 12.5, 7.5, 2.5], minMarginPct: 2.5 };

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
quiet.child = () => quiet;

function mkEngine() {
  const f = path.join(os.tmpdir(), `ceiling-respace-grid-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  const eng = new BidEngine({
    capabilities: () => ({ standingPriceVisible: false, minDecrement: MIN_DEC, revisionLimit: null, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached here'); },
  }, new DurableScheduler(f), { log: quiet, onEvent: () => {} });
  ENGINES.push(eng);
  return eng;
}

const metaFor = () => ({
  id: String(820_000 + seq++), lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
  companyName: 'Acme Cables', branchName: 'MAIN', closesAt: Date.now() + 900_000,
  rules: { revisionLimit: 4, minDecrement: MIN_DEC, pricingMode: 'flat', ceilingPrice: CEILING, costByType: null },
});

const steps = (ladder) => ladder.slice(1).map((p, i) => ladder[i] - p);

let ran = 0, pass = 0;
const EXPECTED = 4;
const FAILURES = [];
function check(name, fn) {
  ran++;
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

console.log('ceiling re-space stays on grid');

check('1 preview-on-grid: grid 500, ceiling 45,600 previews [45500, 44500, 43000, 41000]', () => {
  const pv = mkEngine().planPreview(metaFor(), { ...BAND, roundStep: STEP });
  const off = pv.ladder.filter((p) => p % STEP !== 0);
  assert.deepStrictEqual(off, [], `previewed [${pv.ladder}] carries off-grid prices [${off}]`);
  assert.ok(steps(pv.ladder).every((g) => g >= MIN_DEC), `steps [${steps(pv.ladder)}] under ${MIN_DEC}`);
  assert.deepStrictEqual(pv.ladder, [45_500, 44_500, 43_000, 41_000]);
});

check('2 armed-on-grid: grid 500, ceiling 45,600 arms [45500, 44500, 43000, 41000]', () => {
  const m = mkEngine().arm(metaFor(), { ...BAND, roundStep: STEP });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  const off = m.ladder.filter((p) => p % STEP !== 0);
  assert.deepStrictEqual(off, [], `armed [${m.ladder}] carries off-grid prices [${off}]`);
  assert.deepStrictEqual(m.ladder, [45_500, 44_500, 43_000, 41_000]);
});

check('3 control-no-grid: ceiling 45,600 with no grid re-spaces by the raw 700', () => {
  const pv = mkEngine().planPreview(metaFor(), { ...BAND, roundStep: null });
  assert.deepStrictEqual(pv.ladder, [45_600, 44_900, 43_000, 41_000]);
});

check('4 control-cap-unchanged: a ceiling above the opening previews exactly the no-ceiling ladder', () => {
  const band = { cost: 40_000, marginsPct: [25, 12.5, 4.5, 2.5], minMarginPct: 2.5, roundStep: STEP };
  const meta = (ceilingPrice) => ({ ...metaFor(), rules: { ...metaFor().rules, ceilingPrice } });
  const open = mkEngine().planPreview(meta(null), band);
  // Named reversal, A053: this read [50000, 45000, 41500, 41000], whose last step (500) is under the
  // 700 minimum it was derived for. The grid now re-places the middle in whole grid steps.
  assert.deepStrictEqual(open.ladder, [50_000, 45_000, 42_000, 41_000], `precondition no-ceiling ladder: ${open.ladder}`);
  const above = mkEngine().planPreview(meta(60_000), band);
  assert.deepStrictEqual(above.ladder, open.ladder, 'a ceiling that caps nothing re-spaced the ladder');
});

for (const e of ENGINES) { try { e.kill('test done'); } catch (_) {} }
for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
if (ran === EXPECTED && pass === EXPECTED) {
  console.log(`\nPASS ceiling re-space stays on grid: ${pass}/${EXPECTED} checks passed`);
  process.exit(0);
}
console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - re-spacing a ceiling-capped ladder put a `
  + 'price off a round-figure shipper\'s grid');
for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
process.exit(1);
