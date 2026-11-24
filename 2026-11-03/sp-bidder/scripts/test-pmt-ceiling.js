'use strict';
/**
 * PER-TONNE + SHIPPER CEILING -> FAIL CLOSED, because the ceiling's UNIT is unproven.
 *
 * rules.ceilingPrice has two consumers - bidEngine.arm (compares it against plan.floor and feeds
 * capLadderToCeiling per-MT rungs) and the adapter belt (asserts it against body.amount). Since the
 * 2026-08-05 wire fix body.amount is the bare per-MT rate, so both consumers now read the field in
 * the SAME per-MT space and can no longer contradict each other. That removed half the problem and
 * none of the reason for this suite: SuperProcure's ceilingPrice may still be a whole-load TOTAL, in
 * which case BOTH consumers are wrong together and, worse, wrong SILENTLY - a total-magnitude number
 * sits far above every per-MT rung, so the ladder cap never binds and the ceiling-below-floor
 * stand-down never fires. A safety check that quietly no-ops is worse than one that refuses.
 *
 * The unit CANNOT be settled from captured data. The evidence leans TOTAL - ceilingPrice on
 * captured FTL loads sits in wire-amount magnitudes (Havells "300000.00", Shriji "90000.00") - but
 * that is an inference FROM FTL, and inferring a PMT semantic from FTL is exactly how the
 * amount-is-a-total error got into this codebase (see the RETRACTION in
 * _research/2026-08-05_pmt-createv2-capture-SETTLED.md). So a per-tonne load carrying a ceiling is
 * REFUSED through the standard unsupported-mechanic path until a real PMT ceilingPrice is observed
 * and compared against that load's own per-MT rates. That is a read on the load object, not a bid.
 *
 * Why refusing is cheap: no PMT load in the captured board carries a ceiling. All four PMT branches
 * in the 476-load v4 capture (Rajratan, Tata, Transrail, Vishal) show ceiling '-', and live PMT load
 * 23129542 carries "ceilingPrice": null. The 430 ceiling-carrying loads are FTL. So this refuses
 * nothing that exists today - it just stops the first ceiling-carrying PMT load from being bid on a
 * coin-flip.
 *
 * This suite proves:
 *   1. Flag OFF: byte-identical to today - every per-tonne load is already refused by the gate.
 *   2. Flag ON: a ceiling-carrying per-tonne load is REFUSED (per_tonne_ceiling), nothing on the
 *      wire, in BOTH candidate unit magnitudes - including the total-magnitude one that used to
 *      bid silently on the unproven reading.
 *   3. Flag ON: a per-tonne load with NO ceiling still bids - the refusal is not widened.
 *   4. FTL ceiling behaviour is BYTE-IDENTICAL in both flag states (sends under, throws over).
 *   5. The engine surfaces it as unsupported_rule_blocked - the standard fail-closed alert with a
 *      per-load dedupe key - not a generic submit error re-fired on every tick.
 *   6. The ENGINE-side consumer is converged too: refusing at the wire makes the adapter belt
 *      unreachable, but bidEngine.arm read the same field in per-MT space and ran FIRST, so a ceiling
 *      that parsed below the per-MT floor preempted the refusal with "cannot win profitably" - a
 *      verdict from the very comparison this file calls unproven. Now the refusal is the single
 *      verdict, on the engine, at _maybeBid, and on the /price preview. FTL is unregressed.
 *
 *   node scripts/test-pmt-ceiling.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules, assertRulesSupported } = require('../src/model/loadRules');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

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
const EXPECTED_CHECKS = 6;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`
COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});


// Transrail-shape 25 MT PMT load. Desk rate 1800/MT against a per-MT operating floor of 1500/MT -
// both of which now go on the wire unscaled (wire amount 1800, wireFloor 1500). The 25 MT quantity
// is kept on the fixture only so the "total magnitude" ceiling cases below stay meaningful: 45,000
// is what this load's whole-load total WOULD be, i.e. the magnitude a total-space ceiling would sit
// in, which is the reading this suite refuses to bet on.
function pmtRules(over = {}) {
  return Object.assign(deriveLoadRules({
    id: 23308655, companyName: 'Transrail Lighting Ltd', branchQuoteType: 'PMT', rateType: 'PMT',
    loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: 25, branchAuctionExtendTime: '00:03:00',
    branchBidCountAllowed: 3,
  }), over);
}
function ftlRules(over = {}) {
  return Object.assign(deriveLoadRules({
    id: 23088090, companyName: 'Syngenta India', branchQuoteType: 'PER_TRUCK', brancheUnit: 'MT',
    branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3, loadShipmentType: 'FTL',
  }), over);
}

function makeAdapter() {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 3, bidVehicleCount: 1 } }) }; };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return { a, fetchCalls: () => calls };
}

const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || 'THREW'; } };

(async () => {
  const priorFlag = process.env.SP_PMT_BID;
  try {
    // ---- 1. flag OFF (shipped default): unchanged - the gate refuses every per-tonne load first ----
    {
      delete process.env.SP_PMT_BID;
      for (const [label, ceil] of [['per-MT magnitude', 2000], ['total magnitude', 50000], ['none', null]]) {
        const { a, fetchCalls } = makeAdapter();
        const code = await codeOf(() => a.placeBid('23308655', 1800, pmtRules({ ceilingPrice: ceil, floor: 1500 })));
        assert.strictEqual(code, 'UNSUPPORTED_RULE', `flag OFF, ceiling ${label}: refused by the gate exactly as before`);
        assert.strictEqual(fetchCalls(), 0, `flag OFF, ceiling ${label}: nothing on the wire`);
      }
      ok('flag OFF: ceiling-carrying and ceiling-free per-tonne loads alike are refused by the gate (posture unchanged)');
    }

    // ---- 2. flag ON: a ceiling-carrying per-tonne load is REFUSED, in EITHER candidate unit ----
    // The total-magnitude case is the sharp one: without the refusal a 50,000 ceiling never binds
    // against a 1,800 per-MT amount, so the ceiling is silently unenforced - which is only harmless
    // if the unproven "PMT ceiling is per-MT" reading holds.
    {
      process.env.SP_PMT_BID = '1';
      for (const [label, ceil] of [['per-MT magnitude', 2000], ['total magnitude', 50000], ['total below our amount', 40000]]) {
        const { a, fetchCalls } = makeAdapter();
        const rules = pmtRules({ ceilingPrice: ceil, floor: 1500 });
        assert.strictEqual(rules.ceilingPrice, ceil, `precondition: the LoadRules carries the ${label} ceiling`);
        const code = await codeOf(() => a.placeBid('23308655', 1800, rules));
        assert.strictEqual(code, 'UNSUPPORTED_RULE', `flag ON, ceiling ${label}: refused as an unbuilt mechanic, not bid on a guess`);
        assert.strictEqual(fetchCalls(), 0, `flag ON, ceiling ${label}: NOTHING reached the wire`);
      }
      // the refusal names the unresolved thing, so the alert is actionable
      let err = null;
      try { assertRulesSupported(pmtRules({ ceilingPrice: 50000 })); } catch (e) { err = e; }
      assert.ok(err && err.code === 'UNSUPPORTED_RULE', 'the pure guard is where the refusal lives (all three layers route through it)');
      assert.ok(err.mechanics.some((m) => /^per_tonne_ceiling:/.test(m)),
        `the refusal names per_tonne_ceiling (got ${JSON.stringify(err.mechanics)})`);
      ok('flag ON: a per-tonne load carrying a ceiling is REFUSED in either candidate unit, nothing on the wire');
    }

    // ---- 3. flag ON: the refusal is NOT widened - a ceiling-free per-tonne load still bids ----
    {
      process.env.SP_PMT_BID = '1';
      const { a, fetchCalls } = makeAdapter();
      const res = await a.placeBid('23308655', 1800, pmtRules({ floor: 1500 }));
      assert.ok(res && res.accepted, 'a per-tonne load with no ceiling still bids normally');
      assert.strictEqual(fetchCalls(), 1, 'exactly one createV2 was sent');
      // implausible ceilings are already normalised to null at the map boundary, so they must NOT refuse
      for (const junk of [0, -1, 2e9, '', 'n/a']) {
        const { a: a2, fetchCalls: fc2 } = makeAdapter();
        const r2 = await a2.placeBid('23308655', 1800, pmtRules({ ceilingPrice: junk, floor: 1500 }));
        assert.ok(r2 && r2.accepted, `an implausible ceiling (${JSON.stringify(junk)}) is "no known ceiling", not a refusal`);
        assert.strictEqual(fc2(), 1, `implausible ceiling ${JSON.stringify(junk)}: the bid still went out`);
      }
      ok('flag ON: a per-tonne load with no plausible ceiling is unaffected (the refusal is not widened)');
    }

    // ---- 4. FTL ceiling behaviour is BYTE-IDENTICAL, in both flag states ----
    {
      for (const flag of [undefined, '1']) {
        if (flag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = flag;
        const label = flag === undefined ? 'flag OFF' : 'flag ON';
        {
          const { a, fetchCalls } = makeAdapter();
          const res = await a.placeBid('23088090', 45000, ftlRules({ ceilingPrice: 50000, floor: 40000 }));
          assert.ok(res && res.accepted, `${label}: FTL under its ceiling still sends`);
          assert.strictEqual(fetchCalls(), 1, `${label}: FTL under-ceiling sent exactly one createV2`);
        }
        {
          const { a, fetchCalls } = makeAdapter();
          const code = await codeOf(() => a.placeBid('23088090', 45000, ftlRules({ ceilingPrice: 40000, floor: 30000 })));
          assert.strictEqual(code, 'CEILING', `${label}: FTL over its ceiling still throws CEILING (not the new refusal)`);
          assert.strictEqual(fetchCalls(), 0, `${label}: FTL over-ceiling sent nothing`);
        }
      }
      ok('FTL ceiling behaviour is byte-identical in both flag states (under sends, over throws CEILING)');
    }

    // ---- 5. the engine surfaces it through the STANDARD fail-closed alert path ----
    // unsupported_rule_blocked is in ERROR_KINDS with a persistent per-load dedupe key, so a refused
    // load pages a human ONCE. The pre-fix path threw CEILING from the belt into the generic
    // transport catch, re-firing a bid_submit_error on every tick with no "cannot be bid" signal.
    {
      process.env.SP_PMT_BID = '1';
      const f = path.join(os.tmpdir(), `pmt-ceiling-${process.pid}.json`);
      let placeBidCalled = 0;
      const adapter = {
        capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
        ensureSession: async () => ({}), writeEnabled: true,
        getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
          closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
        placeBid: async () => { placeBidCalled += 1; return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
      };
      const events = [];
      const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
      // ceiling 50000 sits ABOVE the per-MT operating floor, so arm()'s ceiling_below_floor stand-down
      // does NOT fire - this is precisely the case that used to arm and then bid.
      const monitor = engine.arm({ id: '23308655', lane: { origin: 'Silvassa', destination: 'Jaipur' }, units: 25,
        companyName: 'Transrail Lighting Ltd', quoteType: 'PMT', closesAt: Date.now() + 1000,
        rules: pmtRules({ ceilingPrice: 50000 }) }, { cost: 1500, marginsPct: [20, 10, 5], minMarginPct: 5 });
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(monitor.ceilingBelowFloor, false, 'precondition: the ceiling does NOT trip the arm-time stand-down');
      const state = await adapter.getAuctionState();
      let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
      assert.ok(me && me.code === 'UNSUPPORTED_RULE', '_maybeBid refuses BEFORE the write (no rung spent)');
      assert.strictEqual(placeBidCalled, 0, 'no bid was placed for the ceiling-carrying per-tonne load');
      assert.deepStrictEqual([...monitor.firedRungs], [], 'no rung was spent');
      await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
      const alert = events.find((e) => e.type === 'alert' && e.kind === 'unsupported_rule_blocked');
      assert.ok(alert, '_tick surfaces unsupported_rule_blocked (an ERROR_KIND with a per-load dedupe key)');
      assert.ok(!events.some((e) => e.type === 'alert' && e.kind === 'ceiling_breach_blocked'),
        'it does NOT surface as a ceiling breach - the load cannot be bid at all, which is a different message');
      engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
      ok('the engine refuses at _maybeBid and pages once via unsupported_rule_blocked (no rung spent, no wire write)');
    }

    // ---- 6. the OTHER half of the unit-space bug: the ENGINE's per-MT ceiling consumer ----
    // Refusing at the wire (checks 1-5) makes the adapter-belt consumer unreachable, but bidEngine.arm
    // had its OWN consumer of the same field in per-MT space, and it runs FIRST. When a PMT ceiling
    // happens to parse BELOW the per-MT operating floor, arm() used to set ceilingBelowFloor, _decide
    // returned early, and _maybeBid never reached assertRulesSupported - so the human was told "cannot
    // win profitably", a verdict computed from exactly the comparison the fix declares unproven,
    // instead of "the ceiling's unit is unknown". Money-safe either way (nothing is bid on either
    // path), but it left a mixed-unit comparison live on the money path and reported the wrong reason.
    // Here the per-MT floor is round(1500 * 1.05) = 1575, so a ceiling of 1000 is BELOW it.
    {
      process.env.SP_PMT_BID = '1';
      const f = path.join(os.tmpdir(), `pmt-ceiling-lowfloor-${process.pid}.json`);
      let placeBidCalled = 0;
      const adapter = {
        capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
        ensureSession: async () => ({}), writeEnabled: true,
        getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
          closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
        placeBid: async () => { placeBidCalled += 1; return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
      };
      const events = [];
      const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
      const meta = { id: '23308656', lane: { origin: 'Silvassa', destination: 'Jaipur' }, units: 25,
        companyName: 'Transrail Lighting Ltd', quoteType: 'PMT', closesAt: Date.now() + 1000,
        rules: pmtRules({ ceilingPrice: 1000 }) };
      const inputs = { cost: 1500, marginsPct: [20, 10, 5], minMarginPct: 5 };
      const monitor = engine.arm(meta, inputs);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(monitor.floor, 1575, 'precondition: the per-MT operating floor is 1575');
      assert.strictEqual(monitor.ceilingBelowFloor, false,
        'the per-MT stand-down does NOT fire on a per-tonne load - that comparison is in an unproven unit');
      const state = await adapter.getAuctionState();
      let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
      assert.ok(me && me.code === 'UNSUPPORTED_RULE', '_maybeBid reaches the refusal instead of being preempted');
      assert.ok((me.mechanics || []).some((m) => /^per_tonne_ceiling:/.test(m)),
        `the refusal names per_tonne_ceiling, not a ceiling breach (got ${JSON.stringify(me.mechanics)})`);
      assert.strictEqual(placeBidCalled, 0, 'still nothing on the wire');
      await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
      assert.ok(events.some((e) => e.type === 'alert' && e.kind === 'unsupported_rule_blocked'),
        'the operator is paged with the honest reason');
      assert.ok(!events.some((e) => e.type === 'alert' && e.kind === 'ceiling_below_floor'),
        'and NOT with "cannot win profitably", which is derived from the unproven per-MT comparison');

      // the desk preview mirrors it rather than showing a per-MT-capped ladder or the wrong reason
      const pv = engine.planPreview(meta, inputs);
      assert.strictEqual(pv.willNotBid, 'per_tonne_ceiling', 'the /price preview says the load will not be bid');
      assert.deepStrictEqual(pv.ladder, [], 'and offers no ladder for a load that cannot bid');
      const pvHigh = engine.planPreview(Object.assign({}, meta, { rules: pmtRules({ ceilingPrice: 50000 }) }), inputs);
      assert.strictEqual(pvHigh.willNotBid, 'per_tonne_ceiling',
        'same verdict for a total-magnitude ceiling - the point is the unit is unknown, not its size');

      // FTL CONTROL: the per-MT stand-down and the preview must be UNCHANGED on a flat load.
      const ftlMeta = { id: '23088090', lane: { origin: 'Silvassa', destination: 'Jaipur' }, units: 1,
        companyName: 'Syngenta India', closesAt: Date.now() + 1000, rules: ftlRules({ ceilingPrice: 1000 }) };
      const ftlMon = engine.arm(ftlMeta, inputs);
      if (ftlMon.timer) clearTimeout(ftlMon.timer);
      assert.strictEqual(ftlMon.ceilingBelowFloor, true, 'FTL unregressed: ceiling below floor still stands down');
      assert.strictEqual(engine.planPreview(ftlMeta, inputs).willNotBid, 'ceiling_below_floor',
        'FTL unregressed: the preview still reports ceiling_below_floor');
      const ftlCap = engine.planPreview(Object.assign({}, ftlMeta, { rules: ftlRules({ ceilingPrice: 1700 }) }), inputs);
      assert.strictEqual(ftlCap.willNotBid, undefined, 'FTL unregressed: an above-floor ceiling still previews a ladder');
      assert.ok(ftlCap.ladder.length > 0 && ftlCap.ladder[0] <= 1700, 'FTL unregressed: the ladder is still capped to it');

      engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
      ok('a per-tonne ceiling below the per-MT floor reaches per_tonne_ceiling, not the mixed-unit stand-down (FTL unregressed)');
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
