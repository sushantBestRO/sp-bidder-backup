'use strict';
/**
 * SNIPE-HARNESS WIRE OPTS - the live manual bid tool must cross the SAME payload seam as the engine.
 *
 * scripts/snipe.js is one of only TWO sanctioned placeBid callers (the grep gate in
 * scripts/test-placebid-floor-gate.js pins the set), it places REAL bids with --live, and it lets the
 * operator pick ANY listed auction - including a PMT one. It handed placeBid a bare
 * `{ shipmentType }` bag, so on a per-tonne load `o.pricingMode` was undefined and the flat branch
 * ran - bypassing the SP_PMT_BID gate, the MT-only refusal, the ceiling refusal, and the true
 * in:"PMT" basis, and bidding a PMT load the engine itself would have held. No floor was asserted at
 * the wire either: wireFloor was null and opts.floor absent, so the adapter belt had nothing to
 * compare.
 *
 * The mapped load already carries everything needed - realAdapter._mapLoad sets rules =
 * deriveLoadRules(l), and the harness receives loads straight from listAuctions() - so passing
 * this.load.rules (plus the plan floor) routes the harness through the SAME classification and belts
 * as the engine.
 *
 * This suite proves:
 *   1. PMT + SP_PMT_BID OFF (the shipped default) -> the harness REFUSES, nothing on the wire.
 *   2. PMT + SP_PMT_BID ON -> the wire amount is the BARE per-MT rate with in:"PMT", vcq:-1.
 *   3. The opts bag actually carries the LoadRules facts + the plan floor (so the belt has operands).
 *   4. FTL is BYTE-IDENTICAL to the pre-fix `{ shipmentType }` bag - no regression on the loads the
 *      harness is actually used for today.
 *
 *   node scripts/test-snipe-harness-opts.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { SnipeHarness } = require('../src/engine/snipeHarness');

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


const FUTURE = new Date(Date.now() + 600_000).toISOString();

// The harness only ever reads state/closesInMs off the socket and calls watch() once at arm.
// closesInMs null keeps _tick's decision path inert, so arm() is exercised without a live clock.
function stubSock() {
  return { watch() {}, state() { return {}; }, closesInMs() { return null; } };
}

// A real RealSuperProcureAdapter whose write is captured by a stub fetch (201 accepted), so the full
// buildBidPayload + belt path runs with nothing on the network.
function capturingAdapter(carrierId, captured) {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    captured.url = url; captured.method = init.method;
    captured.bodyRaw = init.body; captured.body = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 2, bidVehicleCount: 1 } }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return { a, fetchCalls: () => calls };
}

// arm the harness exactly as scripts/snipe.js does, then stop its tick timer (arm() sets it
// synchronously on the closesInMs-null path) so the test drives _fire itself.
function armedHarness(adapter, load, cost) {
  const lines = [];
  const h = new SnipeHarness({ realAdapter: adapter, sock: stubSock(), log: (t) => lines.push(String(t)) });
  // live: true is REQUIRED here - this suite exists to pin the opts object _fire hands placeBid,
  // and a dry-run arm deliberately returns before placeBid is ever reached. snipe.js passes the
  // operator's confirmed choice through this same key; these cases are the confirmed-live path.
  h.arm(load, { cost, maxMarginPct: 12, minMarginPct: 6, live: true });
  h.stop();
  return { h, lines };
}

// Transrail-shape 25 MT PMT load, straight through the real map boundary (this is the object
// listAuctions() hands the harness).
function pmtLoad(a) {
  return a._mapLoad({ id: 23308655, companyName: 'Transrail Lighting Ltd', biddingOn: 1,
    biddingCloseTime: FUTURE, branchAuctionExtendTime: '00:03:00', branchQuoteType: 'PMT',
    rateType: 'PMT', loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: 25,
    branchBidCountAllowed: 3 });
}

(async () => {
  const priorFlag = process.env.SP_PMT_BID;
  try {
    // ---- 1. PMT + flag OFF (the shipped default): REFUSED at the harness, nothing on the wire ----
    // Pre-fix this sent amount:3500 in:"FTL" - Rs 3,500 on a load where Rs 87,500 was intended.
    {
      delete process.env.SP_PMT_BID;
      const captured = {};
      const { a, fetchCalls } = capturingAdapter(2667, captured);
      const { h, lines } = armedHarness(a, pmtLoad(a), 3000); // per-MT cost -> floor 3180/MT
      await h._fire({ rung: 0, price: 3500, why: 'test' }, null, 5000);
      assert.strictEqual(fetchCalls(), 0, 'NO createV2 was sent for a PMT load with the gate off (fail closed)');
      assert.strictEqual(captured.body, undefined, 'no wire body was built at all');
      assert.ok(lines.some((l) => /unsupported_rule/.test(l)),
        'the harness surfaces the refusal reason (unsupported_rule) instead of silently mispricing');
      ok('PMT + SP_PMT_BID off: the harness REFUSES exactly like the engine path (no bid, reason surfaced)');
    }

    // ---- 2. PMT + flag ON: the wire amount is the BARE PER-MT RATE ----
    // SuperProcure applies the tonnage itself (captured 2026-08-05: sent 2240, stored 33600), so the
    // harness must put the rate on the wire unconverted, exactly as the engine path does.
    {
      process.env.SP_PMT_BID = '1';
      const captured = {};
      const { a, fetchCalls } = capturingAdapter(2667, captured);
      const { h } = armedHarness(a, pmtLoad(a), 3000);
      await h._fire({ rung: 0, price: 3500, why: 'test' }, null, 5000);
      assert.strictEqual(fetchCalls(), 1, 'exactly one createV2 was sent');
      assert.strictEqual(captured.body.amount, 3500, 'wire amount is the BARE per-MT rate 3500');
      assert.notStrictEqual(captured.body.amount, 87500, 'wire amount is NOT 3500 x 25 (the #88 double-multiply overbid)');
      assert.strictEqual(captured.body.in, 'PMT', 'the wire in-flag is the true basis PMT, not the lying loadShipmentType');
      assert.strictEqual(captured.body.vcq, -1, 'a per-tonne bid sends the vcq:-1 sentinel');
      ok('PMT + SP_PMT_BID on: the harness sends the bare rate at the same seam the engine does (in:"PMT", vcq:-1)');
    }

    // ---- 3. the opts bag carries the LoadRules facts AND the plan floor (the belt's operands) ----
    // Pre-fix it carried only { shipmentType }, so wireFloor was null and NO floor was asserted at
    // the wire on any harness bid - FTL included.
    {
      process.env.SP_PMT_BID = '1';
      const seen = [];
      const stub = { writeEnabled: true, placeBid: async (id, price, opts) => { seen.push({ id, price, opts }); return { accepted: true, status: 201 }; } };
      const { a } = capturingAdapter(2667, {});
      const load = pmtLoad(a);
      const { h } = armedHarness(stub, load, 3000);
      await h._fire({ rung: 0, price: 3500, why: 'test' }, null, 5000);
      assert.strictEqual(seen.length, 1, 'placeBid was called once');
      const o = seen[0].opts;
      assert.strictEqual(o.pricingMode, 'per_tonne', 'opts carry the load classification');
      assert.strictEqual(o.pmtQuantity, 25, 'opts carry the load quantity as a fact (diagnostics/display only - nothing multiplies by it)');
      assert.strictEqual(o.unit, 'MT', 'opts carry the load unit (the MT-only gate reads it)');
      assert.strictEqual(o.floor, 3180, 'opts carry the plan floor, so the adapter belt has a floor to assert');
      assert.strictEqual(o.shipmentType, 'FTL', 'the legacy shipmentType passthrough is preserved');
      ok('the harness hands placeBid the load rules + the plan floor (classification, conversion and belt all have operands)');
    }

    // ---- 4. FTL BYTE-IDENTITY: the loads the harness is actually used for today are unchanged ----
    // A same-carrier FTL load must produce the EXACT body the pre-fix `{ shipmentType }` bag did.
    // LoadRules keys are disjoint from the wire keys and `floor` is not a wire field, so nothing moves.
    {
      process.env.SP_PMT_BID = '1'; // flag state is irrelevant on a flat load - pin that too
      const capH = {}, capOld = {};
      const { a: aH } = capturingAdapter(10686, capH);
      const { a: aOld } = capturingAdapter(10686, capOld);
      const raw = { id: 23088090, companyName: 'Syngenta India', biddingOn: 1, biddingCloseTime: FUTURE,
        branchCarrierCarrierId: 10686, branchFreighterId: 10686, branchQuoteType: 'PER_TRUCK',
        brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3,
        loadShipmentType: 'FTL', loadIsTransitTimeOn: 0 };
      const ftl = aH._mapLoad(raw);
      assert.strictEqual(ftl.rules.pricingMode, 'flat', 'precondition: the FTL load is flat');
      const { h } = armedHarness(aH, ftl, 50000); // floor 53000
      await h._fire({ rung: 0, price: 56000, why: 'test' }, null, 5000);
      await aOld.placeBid(String(ftl.id), 56000, { shipmentType: ftl.shipmentType }); // the PRE-FIX opts bag

      const norm = (rawBody) => { const b = JSON.parse(rawBody); b.requestTime = 0; return JSON.stringify(b); };
      assert.strictEqual(capH.url, capOld.url, 'FTL: the createV2 URL is unchanged');
      assert.strictEqual(norm(capH.bodyRaw), norm(capOld.bodyRaw),
        'FTL: the harness body is BYTE-IDENTICAL to the pre-fix { shipmentType } bag');
      assert.strictEqual(capH.body.amount, 56000, 'FTL amount is still the flat rounded rupee amount');
      assert.strictEqual(capH.body.in, 'FTL', 'FTL keeps the legacy shipmentType passthrough on the wire');
      ok('FTL through the harness is BYTE-IDENTICAL to the pre-fix opts bag (no regression on today\'s loads)');
    }
  } finally {
    if (priorFlag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorFlag;
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
