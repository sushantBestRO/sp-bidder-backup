'use strict';
/**
 * PER-TONNE FLOOR INVARIANT + fail-closed pins.
 *
 * The one invariant that must never be in question on a per-tonne bid: assertAboveFloor compares
 * LIKE UNITS. Since the PMT wire contract was SETTLED from a captured desk WRITE
 * (_research/2026-08-05_pmt-createv2-capture-SETTLED.md - sent amount 2240, SP stored 33600 and
 * echoed amountPMT/bidRate 2240), the wire `amount` on a PMT load is the BARE PER-MT RATE. So the
 * operating floor needs NO conversion at all: buildBidPayload puts Math.round(price) on the wire and
 * hands the placeBid belt the per-MT operating floor unchanged, and the belt compares per-MT
 * against per-MT.
 *
 * That is a STRONGER invariant than the one this suite used to prove. #88 multiplied both operands
 * by the load tonnage and the suite proved the two conversions stayed in lockstep across rounding
 * edges. There are no conversions left to desync, so the property is now exact rather than
 * lockstep-by-construction - and the suite pins that no tonnage sneaks back onto EITHER operand.
 *
 * This suite proves:
 *   1. THE INVARIANT: the wire comparison (amount vs wireFloor) is EXACTLY the desk's per-MT
 *      comparison (rate vs floor), across a sweep of rates around the floor - including fractional
 *      rates, where Math.round is the only transformation either operand sees.
 *   2. THE BELT end-to-end: placeBid on a per-tonne load rejects (FLOOR, no createV2 sent) a per-MT
 *      rate below the per-MT floor, and accepts one at/above it.
 *   3. NEITHER operand is scaled by the load tonnage - the regression pin against #88 coming back.
 *   4. FAIL CLOSED regardless of the flag: KG / unknown-unit per-tonne is refused; multi-vehicle
 *      per-tonne (vcq:N) is refused. A normal per-tonne bid sends the vcq:-1 sentinel. A load with
 *      no usable pmtQuantity now BIDS NORMALLY - the write path does not read it any more.
 *
 *   node scripts/test-pmt-floor.js
 */
// This whole suite exercises the SP_PMT_BID=1 (per-tonne enabled) path. Set the gate here (read fresh
// by the guard, not snapshotted); run-tests.js spawns every test file as its own process, so this can
// never leak into another suite.
process.env.SP_PMT_BID = '1';

const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');
const { assertAboveFloor } = require('../src/engine/pricing');

let pass = 0;
const ok = (name) => { console.log('  ok  ' + name); pass++; };

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


// A per-tonne LoadRules for a given MT quantity (captured-load shape: PMT, MT, soft-close).
function pmtRules(qty, over = {}) {
  return Object.assign(deriveLoadRules({
    id: 23828313, branchQuoteType: 'PMT', rateType: 'PMT', loadShipmentType: 'FTL',
    brancheUnit: 'MT', vehicleCount: qty, branchAuctionExtendTime: '00:03:00',
  }), over);
}

// A RealSuperProcureAdapter whose write goes to a counting stub (201 accepted). Mirrors the harness
// test-loadrules-fail-closed.js uses, so placeBid runs its full belt without a real network call.
function makeAdapter() {
  let fetchCalls = 0;
  let lastBody = null;
  const fetchImpl = async (url, init) => {
    fetchCalls += 1;
    lastBody = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 5, bidVehicleCount: 1 } }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return { a, fetchCalls: () => fetchCalls, lastBody: () => lastBody };
}

(async () => {
  // ---- 1. THE INVARIANT: the wire comparison IS the desk's per-MT comparison ----
  // Sweep a band of rates around the floor, on tonnages that used to be the multiplier (including
  // fractional and .5-rounding ones), and assert the biconditional. The tonnages are deliberately
  // still swept: if anything ever reintroduces a per-load scaling on either operand, a fractional or
  // .5 tonnage is where it would first show up as an asymmetry.
  {
    const tonnages = [25, 18, 20.3, 12.5, 7.5, 22];   // real PMT quantities incl. fractional + .5 edges
    const floors = [3000, 100, 1237];                 // integer per-MT operating floors
    let combos = 0;
    for (const qty of tonnages) {
      for (const floor of floors) {
        const { a } = makeAdapter();
        for (let rate = floor - 3; rate <= floor + 3; rate += 0.5) {
          const built = a.buildBidPayload(pmtRules(qty, { floor }), rate, '23828313');
          const wirePasses = built.body.amount >= built.wireFloor; // what the belt decides
          const perMtPasses = Math.round(rate) >= floor;           // the desk's per-MT model, rounded to the wire
          assert.strictEqual(wirePasses, perMtPasses,
            'invariant broke: rate ' + rate + ' floor ' + floor + ' qty ' + qty
              + ' -> amount ' + built.body.amount + ' wireFloor ' + built.wireFloor);
          combos += 1;
        }
      }
    }
    ok('floor invariant holds across ' + combos + ' rate/floor/tonnage combos incl. fractional rates and tonnages (the wire comparison IS the per-MT comparison)');
  }

  // ---- 2. THE BELT end-to-end: placeBid rejects a sub-floor per-MT rate, accepts an at/above one ----
  {
    // accepted: rate 3500/MT, floor 3000/MT -> amount 3500 >= wireFloor 3000.
    {
      const { a, fetchCalls, lastBody } = makeAdapter();
      const res = await a.placeBid('23828313', 3500, pmtRules(25, { floor: 3000 }));
      assert.ok(res && res.accepted, 'an at/above-floor per-tonne bid is accepted');
      assert.strictEqual(fetchCalls(), 1, 'exactly one createV2 was sent for the accepted bid');
      assert.strictEqual(lastBody().amount, 3500, 'and it carried the bare per-MT rate');
    }
    // rejected: rate 2999/MT (below the 3000 floor) -> FLOOR, no send.
    {
      const { a, fetchCalls } = makeAdapter();
      let fe = null; try { await a.placeBid('23828313', 2999, pmtRules(25, { floor: 3000 })); } catch (e) { fe = e; }
      assert.ok(fe && fe.code === 'FLOOR', 'a sub-floor per-MT rate throws FLOOR at the adapter belt');
      assert.strictEqual(fetchCalls(), 0, 'NO createV2 was sent for the sub-floor per-tonne bid (fail closed)');
    }
    ok('adapter belt: a sub-floor per-MT rate is rejected (FLOOR, no wire send); an at/above-floor rate is accepted - per-MT vs per-MT');
  }

  // ---- 3. NEITHER operand is scaled by the load tonnage (the #88 regression pin) ----
  // #88 shipped amount = round(rate x tonnage) AND wireFloor = round(floor x tonnage). Both are gone.
  // Pin both explicitly, and pin that the tonnage is IRRELEVANT: the same rate and floor on wildly
  // different tonnages must produce byte-identical wire numbers.
  {
    const { a } = makeAdapter();
    const built = a.buildBidPayload(pmtRules(25, { floor: 3000 }), 2999, '23828313');
    assert.strictEqual(built.body.amount, 2999, 'the wire amount is the bare rate, NOT 2999 x 25');
    assert.notStrictEqual(built.body.amount, 74975, 'specifically NOT the #88 product 2999 x 25');
    assert.strictEqual(built.wireFloor, 3000, 'the wireFloor is the per-MT floor unchanged, NOT 3000 x 25');
    assert.notStrictEqual(built.wireFloor, 75000, 'specifically NOT the #88 product 3000 x 25');
    // the belt correctly rejects this amount against the unconverted floor
    assert.throws(() => assertAboveFloor(built.body.amount, built.wireFloor), (e) => e.code === 'FLOOR',
      'amount 2999 < floor 3000 -> FLOOR (the comparison the desk actually means)');
    // tonnage-independence: 1 MT and 423 MT produce the same two numbers
    for (const qty of [1, 22, 423, 20.3]) {
      const b = a.buildBidPayload(pmtRules(qty, { floor: 3000 }), 3500, '23828313');
      assert.strictEqual(b.body.amount, 3500, 'tonnage ' + qty + ' does not touch the amount');
      assert.strictEqual(b.wireFloor, 3000, 'tonnage ' + qty + ' does not touch the floor');
    }
    ok('no tonnage on either operand: amount and wireFloor are byte-identical across 1 / 20.3 / 22 / 423 MT loads');
  }

  // ---- 4. FAIL CLOSED regardless of the flag: KG / unknown-unit / multi-vehicle ----
  {
    const { a } = makeAdapter();
    // KG per-tonne: refused by the guard (per_tonne_unit:KG) even with SP_PMT_BID=1 - MT-only.
    let kge = null; try { a.buildBidPayload(pmtRules(9000, { floor: 5, unit: 'KG' }), 8, '1'); } catch (e) { kge = e; }
    assert.ok(kge && kge.code === 'UNSUPPORTED_RULE', 'a KG per-tonne load is refused at the wire even with the flag on');
    // unknown-unit per-tonne: refused (per_tonne_unit:unknown).
    let unke = null; try { a.buildBidPayload(pmtRules(22, { floor: 100, unit: null }), 200, '1'); } catch (e) { unke = e; }
    assert.ok(unke && unke.code === 'UNSUPPORTED_RULE', 'an unknown-unit per-tonne load is refused at the wire even with the flag on');
    // multi-vehicle per-tonne: refused (a partial-tonnage PMT bid shape is uncaptured).
    let mve = null; try { a.buildBidPayload(pmtRules(25, { floor: 3000, vcq: 2 }), 3500, '1'); } catch (e) { mve = e; }
    assert.ok(mve && mve.code === 'PMT_MULTI_VEHICLE', 'a multi-vehicle per-tonne bid (vcq:2) is refused - multi-vehicle PMT is unbuilt');
    // a normal MT per-tonne bid sends the vcq:-1 sentinel.
    const single = a.buildBidPayload(pmtRules(25, { floor: 3000 }), 3500, '23828313');
    assert.strictEqual(single.body.vcq, -1, 'a normal per-tonne bid sends the vcq:-1 sentinel');
    // NO usable pmtQuantity now BIDS - the write path never reads it. This is the deliberate reversal
    // of the old PMT_QUANTITY refusal: the tonnage guarded a multiplication that no longer happens,
    // and the refusal was holding real loads (3 of 5 live Vishal Pipes PMT loads on 2026-08-05).
    const noQty = a.buildBidPayload(pmtRules(25, { floor: 3000, pmtQuantity: null }), 3500, '23828313');
    assert.strictEqual(noQty.body.amount, 3500, 'a per-tonne load with no usable quantity still bids the bare rate (the tonnage is not a wire operand)');
    assert.strictEqual(noQty.wireFloor, 3000, 'and its floor is unaffected');
    ok('fail closed on the UNPROVEN cases (KG / unknown-unit / multi-vehicle); a missing tonnage no longer blocks a bid it never affected');
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
