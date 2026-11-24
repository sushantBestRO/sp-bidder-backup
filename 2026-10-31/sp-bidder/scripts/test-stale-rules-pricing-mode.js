'use strict';
/**
 * STALE LoadRules SNAPSHOT -> the pricing basis is RE-DERIVED at arm time, never trusted.
 *
 * Classification happens ONCE, at map time (realAdapter._mapLoad -> deriveLoadRules), and is
 * snapshotted WHOLE onto the price request and the durable intent. Every restore path
 * (armFromRequest on capture/re-price, _intentToArm on a scheduled wake or a post-restart
 * rehydrate) hands that snapshot straight back to arm() -> monitor.meta.rules -> _bidOpts ->
 * buildBidPayload, which branches purely on `pricingMode`.
 *
 * A PMT price request captured or armed BEFORE the per-tonne build deployed carries
 * pricingMode:'flat' (the old hardcode) and no pmtQuantity. Replayed after the deploy it takes the
 * FLAT branch. Since 2026-08-05 that is no longer an AMOUNT error - both branches put
 * Math.round(price) on the wire - but it silently strips every per-tonne GUARD: the SP_PMT_BID gate
 * (so it bids a PMT load on a box where per-tonne is switched off), the MT-only refusal (so a
 * KG-quoted Tata/Ashirvad load would bid an unproven per-KG rate), the ceiling refusal, the true
 * in:"PMT" basis on the wire, and the pmt_amount_mismatch oracle, which is gated on the mode we sent.
 *
 * The datum that catches it is already on the snapshot: `rateType` holds the raw basis string.
 * arm() now re-derives pricingMode from it through the SAME classifier deriveLoadRules uses, the
 * way server.js/priceRequests.js already re-derive for "a request captured before the transit
 * build deployed". The reconciliation is ONE-DIRECTIONAL and fail-closed: it only ever corrects
 * a PMT-basis load UP to per_tonne, never rewrites anything down to flat.
 *
 * This suite proves:
 *   1. Flag OFF (the shipped default): a stale pre-build snapshot REFUSES instead of bidding flat.
 *   2. Flag ON: a stale snapshot with no pmtQuantity now BIDS the bare per-MT rate - the tonnage it
 *      lacks was never a wire operand (this reverses the former PMT_QUANTITY refusal deliberately).
 *   3. Flag ON, drifted-but-complete snapshot: a snapshotted tonnage does NOT resurrect a multiply.
 *   4. The durable round trip (_intentToArm on a persisted stale intent) is healed the same way.
 *   5. Byte-identity: an FTL / unknown-basis / legacy-opts bag is returned UNTOUCHED (same object).
 *
 *   node scripts/test-stale-rules-pricing-mode.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules, reconcilePricingMode } = require('../src/model/loadRules');

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
const EXPECTED_CHECKS = 5;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`
COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});


// EXACTLY the LoadRules shape the deployed (pre-per-tonne) build snapshotted for the Transrail
// 25 MT PMT load: the raw basis is recorded on `rateType`, but pricingMode was the old hardcoded
// 'flat' and pmtQuantity did not exist as a field yet.
function stalePre88Rules(over = {}) {
  return Object.assign({
    loadId: '23308655',
    branchCarrierCarrierId: null, branchFreighterId: null,
    loadIsTransitTimeOn: false,
    ceilingPrice: null,
    rateType: 'PMT',      // the load's OWN recorded basis - present on every LoadRules snapshot
    unit: 'MT',
    softClose: true, extendSeconds: 180,
    revisionLimit: 3, minDecrement: 10,
    pricingMode: 'flat',  // the pre-build hardcode: what makes this snapshot dangerous
    requires: [],
  }, over);
}

// A real adapter used only to build the wire body from the opts the engine hands down, so the
// assertion is on the ACTUAL createV2 payload, not on an intermediate.
function wireBuilder() {
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: async () => ({ status: 201, headers: { get: () => null }, json: async () => ({}) }) });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return a;
}

// A BidEngine on a stub adapter whose placeBid runs the REAL buildBidPayload first, exactly as
// RealSuperProcureAdapter.placeBid does. Without that the wire-boundary guards (PMT_UNIT,
// PMT_MULTI_VEHICLE, the floor/ceiling belts) never execute and the test would prove nothing about the
// payload. A build refusal is rethrown so the engine handles it the way it handles a real one.
function makeEngine() {
  const f = path.join(os.tmpdir(), `stale-rules-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const builder = wireBuilder();
  const calls = [];
  const wire = { built: null, buildErr: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}), writeEnabled: true,
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid: async (id, price, opts) => {
      calls.push({ id, price, opts });
      try { wire.built = builder.buildBidPayload(opts, price, id); }
      catch (e) { wire.buildErr = e; throw e; }
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 };
    },
  };
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
  return { engine, adapter, calls, events, wire, cleanup: () => { engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {} } };
}

function armMeta(rules) {
  return { id: '23308655', lane: { origin: 'Silvassa', destination: 'Jaipur' }, units: 25,
    companyName: 'Transrail Lighting Ltd', quoteType: 'PMT', closesAt: Date.now() + 1000, rules };
}
const INPUTS = { cost: 3000, marginsPct: [12, 8, 6], minMarginPct: 6 }; // per-MT cost -> per-MT ladder

(async () => {
  const priorFlag = process.env.SP_PMT_BID;
  try {
    // ---- 1. flag OFF (shipped default): the stale snapshot REFUSES, it does not bid flat ----
    {
      delete process.env.SP_PMT_BID;
      const { engine, adapter, calls, events, cleanup } = makeEngine();
      const monitor = engine.arm(armMeta(stalePre88Rules()), INPUTS);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(monitor.meta.rules.pricingMode, 'per_tonne',
        'arm() re-derived the basis from rateType: the stale flat snapshot is corrected to per_tonne');
      const state = await adapter.getAuctionState();
      let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
      assert.ok(me && me.code === 'UNSUPPORTED_RULE', '_maybeBid REFUSES the stale PMT snapshot before the write');
      assert.strictEqual(calls.length, 0, 'NO bid was placed off the stale snapshot');
      assert.deepStrictEqual([...monitor.firedRungs], [], 'no rung was spent by the refused attempt');
      await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
      assert.ok(events.some((e) => e.type === 'alert' && e.kind === 'unsupported_rule_blocked'),
        'the operator is paged (unsupported_rule_blocked), not left with a silent underbid');
      cleanup();
      ok('flag OFF: a pre-build PMT snapshot is REFUSED + alerted, never bid at the bare per-MT rate');
    }

    // ---- 2. flag ON, genuine pre-build snapshot (no pmtQuantity): it BIDS, correctly ----
    // A snapshot taken before the build carries no tonnage. That used to be fatal (PMT_QUANTITY),
    // because the tonnage was the wire multiplier. Since the 2026-08-05 capture settled that
    // SuperProcure does the multiplying, the tonnage is not a wire operand at all and its absence
    // costs nothing: the bare per-MT rate goes out, exactly as on a fresh snapshot. What the
    // RE-DERIVATION still buys is everything else - the SP_PMT_BID gate, the MT-only refusal, the
    // ceiling refusal, in:"PMT", and an armed pmt_amount_mismatch oracle.
    {
      process.env.SP_PMT_BID = '1';
      const { engine, adapter, calls, cleanup, wire } = makeEngine();
      const monitor = engine.arm(armMeta(stalePre88Rules()), INPUTS);
      if (monitor.timer) clearTimeout(monitor.timer);
      const state = await adapter.getAuctionState();
      await engine._maybeBid(monitor, state);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(wire.buildErr, null, 'a pre-build snapshot with no tonnage no longer refuses at the wire');
      assert.strictEqual(calls.length, 1, 'it bids');
      const perMtRate = calls[0].price;
      assert.strictEqual(wire.built.body.amount, Math.round(perMtRate),
        'and it bids the bare per-MT rung - the absent tonnage is irrelevant to the wire');
      assert.strictEqual(wire.built.body.in, 'PMT', 'on the true PMT basis, which is what the re-derivation restored');
      cleanup();
      ok('flag ON: a pre-build snapshot with no tonnage bids the bare per-MT rate (the tonnage was never a wire operand)');
    }

    // ---- 3. flag ON, drifted-but-complete snapshot: the wire amount is the BARE per-MT rung ----
    // pricingMode drifted to 'flat' but the tonnage IS on the snapshot. Re-derivation restores the
    // per-tonne branch; the amount is byte-identical to what the flat branch would have produced,
    // and the presence of a tonnage on the snapshot must NOT change it.
    {
      process.env.SP_PMT_BID = '1';
      const { engine, adapter, calls, cleanup, wire } = makeEngine();
      const monitor = engine.arm(armMeta(stalePre88Rules({ pmtQuantity: 25 })), INPUTS);
      if (monitor.timer) clearTimeout(monitor.timer);
      const state = await adapter.getAuctionState();
      await engine._maybeBid(monitor, state);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(wire.buildErr, null, 'the drifted-but-complete snapshot builds a wire body');
      assert.strictEqual(calls.length, 1, 'the drifted-but-complete snapshot does bid');
      const built = wire.built;
      const perMtRate = calls[0].price;
      assert.ok(perMtRate >= 3180 && perMtRate <= 3360, `the engine still ladders in per-MT space (got ${perMtRate})`);
      assert.strictEqual(built.body.amount, Math.round(perMtRate), 'the wire amount is the BARE per-MT rung');
      assert.notStrictEqual(built.body.amount, Math.round(perMtRate) * 25,
        'the wire amount is NOT the rung x 25 MT (a snapshotted tonnage must not resurrect the #88 multiply)');
      assert.strictEqual(built.body.in, 'PMT', 'the wire carries the true basis');
      assert.strictEqual(built.wireFloor, 3180, 'the floor stays in per-MT space, unscaled');
      cleanup();
      ok('flag ON: a drifted snapshot carrying a tonnage still bids the bare per-MT rate, with the floor unscaled');
    }

    // ---- 4. the DURABLE round trip: a persisted stale intent is healed by _intentToArm -> arm ----
    {
      delete process.env.SP_PMT_BID;
      const { engine, calls, cleanup } = makeEngine();
      engine.scheduler.upsert({ auctionId: '23308655', lane: { origin: 'Silvassa', destination: 'Jaipur' },
        units: 25, quoteType: 'PMT', companyName: 'Transrail Lighting Ltd', rules: stalePre88Rules(),
        closesAt: Date.now() + 1000, cost: 3000, marginsPct: [12, 8, 6], minMarginPct: 6, status: 'armed', firedRungs: [] });
      const it = engine.scheduler.get('23308655');
      assert.strictEqual(it.rules.pricingMode, 'flat', 'precondition: the PERSISTED intent still carries the stale flat basis');
      const { meta, inputs } = engine._intentToArm(it);
      assert.strictEqual(meta.rules.pricingMode, 'flat', 'precondition: _intentToArm restores the snapshot verbatim');
      const monitor = engine.arm(meta, inputs);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(monitor.meta.rules.pricingMode, 'per_tonne', 'arm() heals the restored snapshot');
      assert.strictEqual(engine.scheduler.get('23308655').rules.pricingMode, 'per_tonne',
        'the re-persisted intent carries the corrected basis, so the next restart starts from the healed value');
      assert.strictEqual(calls.length, 0, 'no bid was placed during the round trip');
      cleanup();
      ok('durable round trip: a persisted pre-build intent is re-derived at arm and healed on disk');
    }

    // ---- 5. BYTE-IDENTITY: everything that is not a PMT-basis load is returned UNTOUCHED ----
    // Same-object identity is the strongest statement available: nothing is copied, nothing is
    // added, so no non-PMT load can see any change at all - including a legacy/mock opts bag that
    // never went through deriveLoadRules and has no basis to re-derive FROM.
    {
      const ftl = deriveLoadRules({ id: 1, branchQuoteType: 'PER_TRUCK', branchAuctionExtendTime: '00:00:00' });
      assert.strictEqual(reconcilePricingMode(ftl), ftl, 'an FTL LoadRules is returned as the SAME object');
      const unknown = deriveLoadRules({ id: 2, branchAuctionExtendTime: '00:00:00' }); // SP sent no basis
      assert.strictEqual(reconcilePricingMode(unknown), unknown, 'an unknown-basis LoadRules is returned as the SAME object');
      const legacy = { shipmentType: 'FTL', carrierBranchId: 2667 };
      assert.strictEqual(reconcilePricingMode(legacy), legacy, 'a legacy opts bag with no rateType is returned as the SAME object');
      assert.strictEqual(reconcilePricingMode(null), null, 'null is passed through');
      assert.strictEqual(reconcilePricingMode(undefined), undefined, 'undefined is passed through');
      const fresh = deriveLoadRules({ id: 3, branchQuoteType: 'PMT', rateType: 'PMT', brancheUnit: 'MT',
        vehicleCount: 25, branchAuctionExtendTime: '00:03:00' });
      assert.strictEqual(reconcilePricingMode(fresh), fresh, 'an ALREADY-correct per_tonne LoadRules is returned as the SAME object (no needless copy)');
      // and the one case it does act on, it acts on in the fail-closed direction only
      const corrected = reconcilePricingMode(stalePre88Rules());
      assert.strictEqual(corrected.pricingMode, 'per_tonne', 'a PMT-basis snapshot claiming flat is corrected UP to per_tonne');
      assert.notStrictEqual(corrected, stalePre88Rules(), 'the correction returns a new object rather than mutating the caller\'s snapshot');
      // whitespace / case junk classifies identically to deriveLoadRules (ONE classifier, no drift)
      assert.strictEqual(reconcilePricingMode(stalePre88Rules({ rateType: '  pmt  ' })).pricingMode, 'per_tonne',
        'the re-derivation applies the SAME trim + upper-case normalisation deriveLoadRules applies');
      ok('reconciliation is one-directional and byte-identical for FTL / unknown / legacy / already-correct rules');
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
