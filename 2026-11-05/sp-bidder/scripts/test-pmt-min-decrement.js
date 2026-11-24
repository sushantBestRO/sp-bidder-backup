'use strict';
/**
 * PER-TONNE + rules.minDecrement (SuperProcure's loadBidDifference) - the unit is UNPROVEN, and the
 * CONSERVATIVE per-MT consumption is deliberate. This file pins it so nobody "optimises" it away.
 *
 * WHERE IT ARRIVES: realAdapter._mapLoad reads SP's `loadBidDifference` and deriveLoadRules carries
 * it as rules.minDecrement. SP's rule is the minimum gap between our own successive bid AMOUNTS, and
 * on a PMT load there are TWO amounts to choose from: the per-MT rate we send (echoed back on
 * amountPMT / bidRate) and the multiplied total SuperProcure STORES on `amount`. Nothing in any
 * capture settles which one the rule measures. Note the 2026-08-05 wire fix did not change this
 * question - the stored total is still rate x tonnage, it is just SP rather than us doing the
 * multiplying.
 *
 * WHERE IT IS CONSUMED: arm-time ladder maths ONLY, in PER-MT space on a per-tonne load -
 * _planFor -> interpolateBandLadder's rung-spacing threshold, and _deriveRungCount's
 * decrementHeadroom. It NEVER reaches the wire: it is not a createV2 key (pinned by
 * test-loadrules-payload.js check 4) and buildBidPayload does not read it.
 *
 * WHY THIS IS NOT FAILED CLOSED, unlike the ceiling. Neither reading can produce a wrong bid:
 *   - reading = STORED TOTAL: the engine enforces per-MT gaps >= minDecrement, so the stored-amount
 *     gap is (per-MT gap x tonnage) >= minDecrement x tonnage >= minDecrement. SP's rule is
 *     satisfied with room to spare. The only cost is a COARSER ladder than SP would have allowed -
 *     fewer rungs, never a rejected or mispriced bid.
 *   - reading = PER-MT: the consumption is exactly correct.
 * Both are floor-safe (the floor rung is an anchor interpolateBandLadder can never drop) and neither
 * can put a wrong amount on the wire. Refusing here would be actively harmful, not safe: real PMT
 * loads DO carry a decrement (live Rajratan 23129542 has loadBidDifference 10), so a fail-closed
 * guard would refuse essentially every per-tonne load and make SP_PMT_BID=1 indistinguishable from
 * the flag being off. Fail-closed is for "a wrong answer costs money", which the ceiling is and this
 * is not.
 *
 * THE ACTUAL RISK is the opposite edit: dividing minDecrement by the load tonnage to win back rungs.
 * If the true reading is PER-MT that produces rungs SuperProcure rejects as too close together. So
 * the conservative behaviour is what gets pinned here.
 *
 * RESOLVED BY: recording loadBidDifference on a PMT load alongside amount / amountPMT / bidQuantity,
 * then placing two rungs and seeing which space SP measured the gap in.
 *
 *   node scripts/test-pmt-min-decrement.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered HERE, above every check, and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE. An async file that ends early - a
// swallowed rejection, an unref'd timer letting the loop drain, a stray `return` - reaches exit 0
// having asserted nothing and reads as a silent green zero-assertion run. The "N/N checks passed"
// line at the bottom is not a guard: it prints whatever `pass` happens to be, and every path that
// exits early skips it entirely. Registering the handler before any case runs is what makes it fire
// on every path out of the process. Same shape as test-rejection-classify-contract.js.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 4;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`
COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});


const TONNAGE = 25;
const MIN_DEC = 100;                       // a real observed loadBidDifference (100/500/1000/1500)
const INPUTS = { cost: 3000, marginsPct: [30, 18, 5], minMarginPct: 5 }; // per-MT -> anchors 3900/3540/3150

// A raw SP load through the real map boundary, so rules.minDecrement comes from loadBidDifference
// exactly as it does in production.
function rawLoad({ pmt, company }) {
  return { id: pmt ? 23308655 : 23088090, companyName: company, biddingOn: 1,
    biddingCloseTime: new Date(Date.now() + 600_000).toISOString(),
    branchAuctionExtendTime: pmt ? '00:03:00' : '00:00:00',
    branchQuoteType: pmt ? 'PMT' : 'PER_TRUCK', rateType: pmt ? 'PMT' : undefined,
    loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: pmt ? TONNAGE : 1,
    loadBidDifference: MIN_DEC, branchBidCountAllowed: 30 };
}

function mapper() {
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: async () => ({ status: 201, headers: { get: () => null }, json: async () => ({}) }) });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
  return a;
}

// softClose config decides whether _deriveRungCount returns a FINE ladder at all: it is gated on
// _resolveSoftStrategy !== 'off', i.e. the master soft-close enable AND the shipper allowlist.
function armLadder(rules, companyName, softClose) {
  const f = path.join(os.tmpdir(), `pmt-mindec-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'soft' }),
    ensureSession: async () => ({}), writeEnabled: true,
    getAuctionState: async () => ({ ok: true, status: 'live', closesInMs: 60_000 }),
    placeBid: async () => ({ accepted: true }),
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, softClose, onEvent: () => {} });
  const monitor = engine.arm({ id: String(rules.loadId), lane: { origin: 'A', destination: 'B' }, units: TONNAGE,
    companyName, quoteType: rules.pricingMode === 'per_tonne' ? 'PMT' : 'FTL',
    closesAt: Date.now() + 60_000, rules }, INPUTS);
  if (monitor.timer) clearTimeout(monitor.timer);
  const ladder = monitor.ladder.slice();
  const floor = monitor.floor;
  engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  return { ladder, floor };
}

const gaps = (l) => l.slice(1).map((p, i) => l[i] - p);

(async () => {
  const a = mapper();
  const pmt = a._mapLoad(rawLoad({ pmt: true, company: 'Transrail Lighting Ltd' }));
  const ftl = a._mapLoad(rawLoad({ pmt: false, company: 'Transrail Lighting Ltd' }));
  assert.strictEqual(pmt.rules.pricingMode, 'per_tonne', 'precondition: the PMT load classifies per_tonne');
  assert.strictEqual(pmt.rules.minDecrement, MIN_DEC, 'precondition: minDecrement comes off loadBidDifference');
  assert.strictEqual(pmt.rules.pmtQuantity, TONNAGE, 'precondition: the tonnage a divide would use is available');

  const OFF = { enabled: false, shippers: [], mode: 'shadow' };
  const ON = { enabled: true, shippers: ['Transrail'], mode: 'shadow' };

  // ---- 1. TODAY'S POSTURE: minDecrement is not consumed on a per-tonne load at all ----
  // _deriveRungCount returns null unless soft-close is enabled AND the shipper is allowlisted, so a
  // PMT shipper (none is on that allowlist today) takes buildBandLadder, which never sees a
  // decrement. The exposure being reasoned about is currently zero; this pins that fact so making a
  // PMT shipper fine-ladder-eligible is a visible change here, not a silent one.
  {
    const { ladder } = armLadder(pmt.rules, 'Transrail Lighting Ltd', OFF);
    assert.deepStrictEqual(ladder, [3900, 3540, 3150],
      'a non-allowlisted PMT load gets the coarse 3-anchor band, so minDecrement is never consumed');
    ok('today: a per-tonne load takes the coarse band, so minDecrement is inert (zero live exposure)');
  }

  // ---- 2. IF a PMT shipper is ever fine-ladder-eligible: the decrement is applied UNDIVIDED ----
  {
    const { ladder, floor } = armLadder(pmt.rules, 'Transrail Lighting Ltd', ON);
    assert.ok(ladder.length > 3, `the decrement IS genuinely consumed on the fine path (got ${ladder.length} rungs, not the 3 anchors)`);
    for (const g of gaps(ladder)) {
      assert.ok(g >= MIN_DEC, `every per-MT rung gap is >= the RAW minDecrement (got ${g} < ${MIN_DEC}) - the decrement was NOT divided by the tonnage`);
    }
    assert.strictEqual(ladder[ladder.length - 1], floor, 'the floor rung survives the decrement pass (it is an anchor)');
    assert.strictEqual(ladder[0], 3900, 'the opening anchor is untouched');
    // and the consequence that makes the conservative reading SAFE under BOTH candidate units:
    for (const g of gaps(ladder)) {
      assert.ok(g * TONNAGE >= MIN_DEC,
        `the resulting STORED gap (${g} x ${TONNAGE}) clears SP's rule under the stored-total reading too`);
    }
    ok('per-MT consumption is undivided, floor-preserving, and satisfies SP\'s rule under EITHER candidate unit');
  }

  // ---- 3. the anti-case, EXECUTED: dividing by the tonnage is the edit that would be unsafe ----
  // Built by actually arming a ladder with minDecrement pre-divided, the same way test-pmt-floor.js
  // demonstrates the convert-only-one-side bug it avoids rather than merely describing it. If SP
  // measures the gap per-MT, the rungs this produces are too close and the revisions are rejected.
  {
    const actual = armLadder(pmt.rules, 'Transrail Lighting Ltd', ON).ladder;
    const dividedRules = Object.assign({}, pmt.rules, { minDecrement: MIN_DEC / TONNAGE });
    const divided = armLadder(dividedRules, 'Transrail Lighting Ltd', ON).ladder;
    assert.ok(divided.length > actual.length,
      `dividing unlocks a much finer ladder (${divided.length} rungs vs the ${actual.length} we build)`);
    assert.ok(Math.min(...gaps(divided)) < MIN_DEC,
      `and its tightest gap (${Math.min(...gaps(divided))}) sits BELOW the raw minDecrement ${MIN_DEC} - refused by SP if the rule is per-MT`);
    assert.notDeepStrictEqual(actual, divided, 'the shipped ladder is NOT the divided one');
    ok('dividing minDecrement by the tonnage would produce rungs below the raw decrement (the unsafe direction, not taken)');
  }

  // ---- 4. FTL is untouched: the engine does not branch on pricingMode for the ladder at all ----
  // Same cost, same margins, same minDecrement -> byte-identical ladders. If a per-tonne conversion
  // were ever introduced at this seam, these two would diverge and this check would fail.
  {
    const p = armLadder(pmt.rules, 'Transrail Lighting Ltd', ON);
    const f = armLadder(ftl.rules, 'Transrail Lighting Ltd', ON);
    assert.deepStrictEqual(f.ladder, p.ladder,
      'a per-tonne and a flat load with identical inputs produce IDENTICAL ladders (no conversion at this seam)');
    assert.strictEqual(f.floor, p.floor, 'and identical floors');
    ok('FTL and PMT ladders are identical for identical inputs - the ladder seam has no unit conversion');
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
