'use strict';
/**
 * PMT TONNAGE IS NOT A WIRE OPERAND - the `vehicleCount` vs `weight` cross-check is RETIRED.
 *
 * HISTORY, because this file used to assert the exact opposite and the reversal is the point.
 * #88 multiplied the desk's per-MT rate by rules.pmtQuantity (read from SuperProcure's
 * `vehicleCount`, which carries the MT quantity on a PMT load - the documented "PMT lie") to build
 * the wire `amount`. Because the readback showed that MULTI-VEHICLE PMT rows resolve through the
 * per-vehicle `weight` rather than `vehicleCount`:
 *
 *     21594487  Transrail        amount 55900 / amountPMT 5590 = 10  (weight 10 MT/truck, 2 trucks)
 *     20944559  Premier Polyfilm amount 84150 / amountPMT 7650 = 11  (weight 11 MT/truck, 2 trucks)
 *     18861847  Premier Polyfilm amount 60000 / amountPMT 4000 = 15  (weight 15 MT/truck, 2 trucks)
 *
 * ...deriveLoadRules nulled pmtQuantity whenever the two fields disagreed, and buildBidPayload threw
 * PMT_QUANTITY at the wire. That was a sound guard for a multiplication that turns out not to exist.
 *
 * The captured PMT createV2 WRITE (_research/2026-08-05_pmt-createv2-capture-SETTLED.md) settled it:
 * the browser sends the BARE per-MT rate (2240) and SuperProcure applies its own per-vehicle tonnage
 * (33600 = 2240 x 15, where 15 = bidQuantity 30 / bidVehicleCount 2). We never send a tonnage. So the
 * cross-check guarded nothing on the wire while REFUSING REAL LOADS - 3 of the 5 live Vishal Pipes
 * PMT loads on the 2026-08-05 board carry vehicleCount != weight, and every one would have been held
 * with nothing sent, for a mechanic that never needed the number.
 *
 * WHAT THE COMPARISON WAS ACTUALLY FOR, and why it did not die with the multiplier. It was written
 * as a multiplier sanity check, but what it DETECTED was whether a PMT load is split across trucks -
 * and that question outlived the multiplier, because the same capture proved `vcq:-1` is not "one
 * vehicle": we send -1 and SuperProcure records bidVehicleCount 2, derived from the LOAD. A PMT bid
 * therefore commits BRL to the load's FULL truck count, and the desk cannot lower it (there is no
 * partial-tonnage bid shape). So the comparison is kept as a FACT - LoadRules.pmtVehicleCount,
 * vehicleCount / weight - which the pricing page states to the desk before a cost is entered and the
 * engine's read-back oracle checks SuperProcure's recorded count against. It is never a wire operand
 * and never a refusal: refusing split loads would discard 3 of the 5 live Vishal Pipes PMT loads for
 * a commitment shape the desk takes by hand (23828313 took rank 1) and the FTL path takes by default.
 *
 * This suite now proves the reversal, and pins that the tonnage cannot creep back onto the wire:
 *   1. AGREEMENT still reports the quantity (nothing regressed for the loads that always worked).
 *   2. DISAGREEMENT - the multi-truck split shape - reports the raw quantity and BIDS, at the bare
 *      per-MT rate. The former PMT_QUANTITY refusal is gone. Flag OFF still refuses, via the gate.
 *   3. An ABSENT / unusable weight or vehicleCount changes nothing on the wire either way.
 *   4. FTL is BYTE-IDENTICAL, as it always was.
 *   5. THE REGRESSION PIN: across every one of these shapes the wire amount equals the bare rate.
 *      No tonnage - not vehicleCount, not weight, not their ratio - reaches body.amount.
 *   6. The SPLIT DETECTOR survives as pmtVehicleCount, derives the captured counts, and fails to
 *      null rather than guessing on every shape it cannot prove.
 *
 *   node scripts/test-pmt-quantity-crosscheck.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules, derivePmtVehicleCount } = require('../src/model/loadRules');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered above every check, fired on process exit. run-tests.js grades
// by EXIT CODE ALONE, so a file that ends early asserts nothing and still reads green; a count
// assertion at the BOTTOM sits downstream of every path that would skip it. Same shape as
// test-rejection-classify-contract.js.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 8;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

// a PMT load exactly as SuperProcure sends it, with the two tonnage-bearing fields under our control
const pmtLoad = (over) => Object.assign({
  id: 23129542, branchQuoteType: 'PMT', rateType: 'PMT', loadShipmentType: 'FTL',
  brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00',
}, over);

// a fresh adapter whose fetch is counted, so "nothing reached the wire" is an assertion, not a hope
function adapterWithCounter() {
  const state = { calls: 0, lastBody: null };
  const fetchImpl = async (url, init) => {
    state.calls += 1;
    state.lastBody = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: {} }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return { a, state };
}

const withFlag = async (on, fn) => {
  const prior = process.env.SP_PMT_BID;
  try {
    if (on) process.env.SP_PMT_BID = '1'; else delete process.env.SP_PMT_BID;
    await fn();
  } finally {
    if (prior === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = prior;
  }
};

(async () => {
  // ---- 1. AGREEMENT: the quantity is still reported, and the load still bids ----
  {
    // the live Rajratan shape: vehicleCount 18 AND weight 18
    const agree = deriveLoadRules(pmtLoad({ vehicleCount: 18, weight: 18 }));
    assert.strictEqual(agree.pricingMode, 'per_tonne', 'the Rajratan shape classifies per_tonne');
    assert.strictEqual(agree.pmtQuantity, 18, 'the quantity is reported as SuperProcure states it');

    const frac = deriveLoadRules(pmtLoad({ vehicleCount: 20.3, weight: 20.3 }));
    assert.strictEqual(frac.pmtQuantity, 20.3, 'a fractional quantity is reported verbatim');

    // with the gate ON it bids the BARE RATE - the tonnage is not a multiplier any more
    await withFlag(true, async () => {
      const { a, state } = adapterWithCounter();
      await a.placeBid('23129542', 3500, Object.assign({}, agree, { floor: 3000 }));
      assert.strictEqual(state.calls, 1, 'the agreeing load bids');
      assert.strictEqual(state.lastBody.amount, 3500, 'amount = the bare 3500/MT rate (NOT 3500 x 18)');
      assert.notStrictEqual(state.lastBody.amount, 63000, 'specifically NOT the #88 product 3500 x 18');
      assert.strictEqual(state.lastBody.in, 'PMT', 'and it goes out on the PMT basis');
    });
    ok('an agreeing vehicleCount/weight load reports its quantity and bids the bare per-MT rate');
  }

  // ---- 2. DISAGREEMENT: the multi-truck split shape now BIDS instead of failing closed ----
  {
    // 21594487 Transrail, 2 trucks x 10 MT. Under #88 this was PMT_QUANTITY and nothing was sent.
    const split = deriveLoadRules(pmtLoad({ id: 21594487, vehicleCount: 20, weight: 10 }));
    assert.strictEqual(split.pricingMode, 'per_tonne', 'the split load still classifies per_tonne');
    assert.strictEqual(split.pmtQuantity, 20,
      'a disagreeing weight no longer nulls the quantity - the fact layer reports vehicleCount verbatim');

    // flag ON: it BIDS, at the bare rate. This is the deliberate reversal.
    await withFlag(true, async () => {
      const { a, state } = adapterWithCounter();
      await a.placeBid('21594487', 5590, Object.assign({}, split, { floor: 5000 }));
      assert.strictEqual(state.calls, 1, 'flag ON: the split load BIDS (the PMT_QUANTITY refusal is retired)');
      assert.strictEqual(state.lastBody.amount, 5590, 'and it bids the bare per-MT rate');
      assert.notStrictEqual(state.lastBody.amount, 5590 * 20, 'not rate x vehicleCount');
      assert.notStrictEqual(state.lastBody.amount, 5590 * 10, 'not rate x weight either - no tonnage on the wire');
    });
    // flag OFF: still refused, by the gate - the SP_PMT_BID posture is untouched by this change.
    await withFlag(false, async () => {
      const { a, state } = adapterWithCounter();
      let e = null;
      try { await a.placeBid('21594487', 5590, Object.assign({}, split, { floor: 5000 })); } catch (err) { e = err; }
      assert.ok(e && e.code === 'UNSUPPORTED_RULE', 'flag OFF: the gate still refuses every per-tonne load');
      assert.strictEqual(state.calls, 0, 'flag OFF: NO createV2 was sent');
    });
    ok('a disagreeing vehicleCount/weight load bids the bare rate with the flag ON, and is still gated OFF by SP_PMT_BID');
  }

  // ---- 3. an absent / unusable weight or vehicleCount changes nothing on the wire ----
  {
    for (const [label, w] of [['absent', undefined], ['null', null], ['zero', 0], ['junk', 'abc'], ['empty', '']]) {
      const r = deriveLoadRules(pmtLoad({ vehicleCount: 22, weight: w }));
      assert.strictEqual(r.pmtQuantity, 22, `a ${label} weight leaves the reported quantity alone`);
    }
    // and an unusable vehicleCount yields null - which no longer blocks the bid
    const noQty = deriveLoadRules(pmtLoad({ vehicleCount: null, weight: 22 }));
    assert.strictEqual(noQty.pmtQuantity, null, 'an unusable vehicleCount still yields a null quantity (a fact, not a refusal)');
    await withFlag(true, async () => {
      const { a, state } = adapterWithCounter();
      await a.placeBid('23129542', 3500, Object.assign({}, noQty, { floor: 3000 }));
      assert.strictEqual(state.calls, 1, 'a load with NO usable quantity still bids - the wire never needed one');
      assert.strictEqual(state.lastBody.amount, 3500, 'at the bare per-MT rate');
    });
    ok('an absent/zero/junk weight, and even an absent vehicleCount, leave the wire unaffected');
  }

  // ---- 4. FTL is byte-identical ----
  {
    // A genuine 2-truck FTL load legitimately has vehicleCount 2 and weight 20.
    const ftl = deriveLoadRules({ id: 23000001, branchQuoteType: 'FTL', rateType: 'FTL',
      vehicleCount: 2, weight: 20, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(ftl.pricingMode, 'flat', 'the FTL load stays flat');
    assert.strictEqual(ftl.pmtQuantity, 2, 'an FTL load keeps its raw vehicleCount-derived quantity (inert on flat)');

    for (const flagOn of [false, true]) {
      await withFlag(flagOn, async () => {
        const { a, state } = adapterWithCounter();
        await a.placeBid('23000001', 45000, Object.assign({}, ftl, { floor: 40000 }));
        assert.strictEqual(state.calls, 1, `flag ${flagOn ? 'ON' : 'OFF'}: the FTL load bids`);
        assert.strictEqual(state.lastBody.amount, 45000, 'the flat amount is unchanged (byte-identical)');
        assert.strictEqual(state.lastBody.in, 'FTL', 'and stays on the FTL basis');
      });
    }
    ok('FTL is untouched: vehicleCount/weight legitimately differ there and the wire body is byte-identical');
  }

  // ---- 5. THE REGRESSION PIN: no tonnage-derived number can reach body.amount, on any shape ----
  // Sweep every vehicleCount/weight combination this file has ever cared about and assert the wire
  // amount is the bare rate each time. If a future change reintroduces a multiplier, this fails on
  // whichever shape it keys off - vehicleCount, weight, or the ratio between them.
  {
    const RATE = 2240; // the captured per-MT rate
    const shapes = [
      ['agreeing', 30, 30], ['split 2x15', 30, 15], ['split 2x10', 20, 10],
      ['fractional', 20.3, 20.3], ['no weight', 22, undefined], ['no count', undefined, 22],
      ['huge', 423, 423], ['unit', 1, 1],
    ];
    await withFlag(true, async () => {
      for (const [label, vc, w] of shapes) {
        const r = deriveLoadRules(pmtLoad({ vehicleCount: vc, weight: w }));
        const { a, state } = adapterWithCounter();
        await a.placeBid('23129542', RATE, Object.assign({}, r, { floor: 2000 }));
        assert.strictEqual(state.calls, 1, `${label}: the load bids`);
        assert.strictEqual(state.lastBody.amount, RATE,
          `${label}: the wire amount is the bare rate ${RATE}, not a tonnage-scaled figure`);
      }
    });
    ok(`no tonnage reaches the wire on any of ${shapes.length} vehicleCount/weight shapes - amount is always the bare rate`);
  }

  // ---- 6. THE SPLIT DETECTOR SURVIVES, as a fact: pmtVehicleCount = vehicleCount / weight ----
  // The number the pricing page shows the desk and the engine's read-back oracle expects. Checked
  // against every PMT row ever observed - the capture 23828313 is the only one with a DIRECT
  // server-side confirmation (SP recorded bidVehicleCount 2 against exactly this 30/15).
  {
    const trucksOf = (vc, w) => deriveLoadRules(pmtLoad({ vehicleCount: vc, weight: w })).pmtVehicleCount;
    assert.strictEqual(trucksOf(30, 15), 2, 'the capture 23828313: 30 MT / 15 per vehicle = 2 trucks (SP recorded 2)');
    assert.strictEqual(trucksOf(20, 10), 2, '21594487 Transrail: 20/10 = 2');
    assert.strictEqual(trucksOf(22, 11), 2, '20944559 Premier Polyfilm: 22/11 = 2');
    assert.strictEqual(trucksOf(18, 18), 1, 'live Rajratan 23129542: vehicleCount == weight -> 1 truck');
    assert.strictEqual(trucksOf(75, 25), 3, 'a 3-truck split resolves too');
    assert.strictEqual(trucksOf(20.3, 20.3), 1, 'a fractional tonnage is not mistaken for a non-integer ratio');
    assert.strictEqual(trucksOf(60.9, 20.3), 3, 'nor is a fractional per-vehicle tonnage across 3 trucks');
    ok('pmtVehicleCount derives the truck count from vehicleCount / weight on every observed PMT shape');
  }

  // ---- 7. ...and FAILS TO NULL rather than guessing, on every shape it cannot prove ----
  // null means "we do not know how many trucks". Both consumers say exactly that: the page tells the
  // desk SuperProcure decides the count, and the read-back oracle SKIPS its comparison. Substituting
  // 1 is the specific defect this replaces - it made the oracle fire on every correct split bid.
  {
    const trucksOf = (vc, w) => deriveLoadRules(pmtLoad({ vehicleCount: vc, weight: w })).pmtVehicleCount;
    for (const [label, w] of [['absent', undefined], ['null', null], ['zero', 0], ['junk', 'abc'], ['empty', '']]) {
      assert.strictEqual(trucksOf(30, w), null, `a ${label} weight yields null, never a guessed 1`);
    }
    assert.strictEqual(trucksOf(null, 15), null, 'an unusable vehicleCount yields null');
    assert.strictEqual(trucksOf(30, 7), null, 'a non-integer ratio (30/7) yields null - never rounded to 4');
    assert.strictEqual(trucksOf(15, 30), null, 'a weight ABOVE the total yields null, never 0 or 1');
    assert.strictEqual(trucksOf(-30, 15), null, 'a negative total yields null');
    // FTL never gets a truck count from this: there `vehicleCount` IS the truck count and `weight` is
    // the load weight, so the ratio is meaningless. Guarded on pricingMode, not on field presence.
    const ftl = deriveLoadRules({ id: 23000001, branchQuoteType: 'FTL', rateType: 'FTL',
      vehicleCount: 2, weight: 20, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(ftl.pmtVehicleCount, null, 'a FLAT load never carries a pmtVehicleCount');
    assert.strictEqual(derivePmtVehicleCount({ vehicleCount: 30, weight: 15 }, 'flat'), null,
      'and the derivation itself refuses any non-per_tonne mode outright');
    ok('pmtVehicleCount fails to null on an unusable weight/count, a non-integer ratio, and every flat load');
  }

  // ---- 8. IT IS NOT A WIRE OPERAND - the fact must not reach body.amount or body.vcq ----
  // The whole reason the old comparison was safe to delete was that nothing on the write path needed
  // it. Re-adding it as a fact must not quietly re-add it to the wire.
  {
    await withFlag(true, async () => {
      const split = deriveLoadRules(pmtLoad({ id: 23828313, vehicleCount: 30, weight: 15 }));
      assert.strictEqual(split.pmtVehicleCount, 2, 'precondition: the fact is present on the rules');
      const { a, state } = adapterWithCounter();
      await a.placeBid('23828313', 2240, Object.assign({}, split, { floor: 2000 }));
      assert.strictEqual(state.calls, 1, 'the split load bids');
      assert.strictEqual(state.lastBody.amount, 2240, 'at the bare per-MT rate - the truck count is not a multiplier');
      assert.strictEqual(state.lastBody.vcq, -1, 'and vcq stays the -1 sentinel - the count is NOT sent as vcq');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(state.lastBody, 'pmtVehicleCount'), false,
        'and the fact itself never appears as a wire key');
    });
    ok('pmtVehicleCount reaches neither body.amount nor body.vcq - it is a display/oracle fact only');
  }

  // The count assertion is kept here (belt) alongside the exit-handler sentinel at the top
  // (suspenders) - this one gives the clearer failure when the file runs to the end, that one is the
  // only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
