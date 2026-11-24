'use strict';
/**
 * FAIL CLOSED on an unknown rule flag (Module 2 foundation, audit fix #4).
 *
 * If a load carries a mechanic flag we have not built for, the bot must REFUSE + ALERT, never bid a
 * wrong payload on live money. This is the OPPOSITE of json-rules-engine's own run(), which silently
 * emits nothing on a no-match (a fail-OPEN). Proven at three layers:
 *   A. assertRulesSupported (the pure guard) throws UNSUPPORTED_RULE on an unbuilt mechanic; no-op on
 *      today's loads (flat mode, empty requires) and on legacy/mock opts.
 *   B. buildBidPayload (adapter boundary belt) refuses before constructing anything, so NO createV2
 *      request is sent.
 *   C. the engine refuses in _maybeBid BEFORE the write block (no rung spent) and _tick surfaces an
 *      `unsupported_rule_blocked` alert - adapter.placeBid is never called.
 *   D. a GENUINELY-PMT load (branchQuoteType/rateType "PMT") now classifies to pricingMode
 *      'per_tonne' in deriveLoadRules, which is NOT in SUPPORTED_MECHANICS, so the SAME guard refuses
 *      it at all three layers - activating the previously-DORMANT per_tonne refusal (before this the
 *      classifier hardcoded 'flat' for every load, so a PMT load slid past the guard and would have
 *      bid the desk's per-MT rate as the wire amount on an unverified semantic). FTL and an unknown/
 *      missing quoteType stay 'flat' and are NOT refused - the refusal is never widened past PMT.
 *   E. CLASSIFIER PARITY: deriveLoadRules' pricingMode and discovery.isMultiVehicle's PMT test agree
 *      on EVERY quoteType wire shape, including the present-but-falsy branchQuoteType one where the
 *      two fallback operators used to diverge in the fail-OPEN direction.
 *   F. the SP_PMT_BID gate: flag ON makes an MT per-tonne load supported at the guard; a KG or
 *      unknown-unit per-tonne load STAYS fail-closed regardless of the flag (MT-only wire).
 *
 *   node scripts/test-loadrules-fail-closed.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter, normQuoteType } = require('../src/platform/realAdapter');
const { deriveLoadRules, assertRulesSupported } = require('../src/model/loadRules');
const { isMultiVehicle } = require('../src/discovery/discovery');
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


(async () => {
  // ---- A. the pure guard ----
  {
    // no-ops (must NOT throw): nothing, legacy opts, a real load today
    assert.doesNotThrow(() => assertRulesSupported(undefined), 'undefined rules -> no-op');
    assert.doesNotThrow(() => assertRulesSupported({}), 'empty legacy opts -> no-op');
    assert.doesNotThrow(() => assertRulesSupported({ shipmentType: 'FTL', carrierBranchId: 2667 }), 'legacy opts bag -> no-op');
    assert.doesNotThrow(() => assertRulesSupported(deriveLoadRules({ id: '1', branchAuctionExtendTime: '00:00:00' })),
      'a real load today (flat, empty requires) -> no-op');

    // refusals (must throw UNSUPPORTED_RULE)
    let e1 = null; try { assertRulesSupported({ requires: ['per_tonne'] }); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.code === 'UNSUPPORTED_RULE', 'requires:[per_tonne] -> UNSUPPORTED_RULE');
    assert.deepStrictEqual(e1.mechanics, ['per_tonne'], 'the offending mechanic is named on the error');

    let e2 = null; try { assertRulesSupported({ pricingMode: 'per_kg', requires: [] }); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.code === 'UNSUPPORTED_RULE', 'an unbuilt pricingMode -> UNSUPPORTED_RULE');
    ok('assertRulesSupported: no-op on today\'s loads/legacy opts; throws UNSUPPORTED_RULE on an unbuilt mechanic');
  }

  // ---- B. adapter boundary: buildBidPayload + placeBid refuse, no request sent ----
  {
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({}) }; };
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;

    let be = null; try { a.buildBidPayload({ requires: ['per_tonne'] }, 1000, '123'); } catch (e) { be = e; }
    assert.ok(be && be.code === 'UNSUPPORTED_RULE', 'buildBidPayload refuses an unbuilt mechanic');

    let pe = null; try { await a.placeBid('123', 1000, { requires: ['per_tonne'] }); } catch (e) { pe = e; }
    assert.ok(pe && pe.code === 'UNSUPPORTED_RULE', 'placeBid propagates the refusal');
    assert.strictEqual(fetchCalls, 0, 'NO createV2 request was sent for an unbuilt mechanic (fail closed)');
    ok('buildBidPayload/placeBid refuse an unbuilt mechanic and send nothing on the wire');
  }

  // ---- C. engine: refuse in _maybeBid (no bid), alert in _tick ----
  {
    const f = path.join(os.tmpdir(), `failclosed-${process.pid}.json`);
    let placeBidCalled = 0;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
      placeBid: async () => { placeBidCalled += 1; return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
    };
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
    // arm a load whose LoadRules demand a mechanic we have not built
    const monitor = engine.arm(
      { id: 'FC1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 1000,
        rules: { loadId: 'FC1', pricingMode: 'flat', requires: ['per_tonne'] } },
      { cost: 40000, marginsPct: [12, 7, 6], minMarginPct: 6 });
    if (monitor.timer) clearTimeout(monitor.timer); // drive ticks manually

    // _maybeBid refuses BEFORE the write (throws UNSUPPORTED_RULE), so no rung is spent and no bid fires
    const state = await adapter.getAuctionState();
    let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
    assert.ok(me && me.code === 'UNSUPPORTED_RULE', '_maybeBid throws UNSUPPORTED_RULE for an unbuilt mechanic');
    assert.strictEqual(placeBidCalled, 0, 'no bid was placed (refuse, do not bid blind)');
    assert.deepStrictEqual([...monitor.firedRungs], [], 'no rung was spent by the refused attempt');

    // a full _tick catches it and surfaces the operator alert (still no bid)
    await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
    const alert = events.find((e) => e.type === 'alert' && e.kind === 'unsupported_rule_blocked');
    assert.ok(alert, '_tick emits an unsupported_rule_blocked alert');
    assert.strictEqual(alert.auctionId, 'FC1', 'the alert names the load');
    assert.strictEqual(placeBidCalled, 0, 'still no bid placed after a full tick');
    ok('engine refuses in _maybeBid (no rung spent, no bid) and alerts unsupported_rule_blocked in _tick');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- D. a GENUINELY-PMT load classifies per_tonne and fails closed at all three layers ----
  // THE dormant-guard activation. Before this wiring deriveLoadRules hardcoded pricingMode 'flat'
  // for EVERY load, so a PMT ("Quote Per MT") load slid past assertRulesSupported entirely. The PMT
  // wire itself is settled now (2026-08-05 capture: we send the bare per-MT rate), but the gate is
  // what keeps an unrolled-out mechanic dark and, more importantly, keeps the MT-only and ceiling
  // refusals reachable. A load SP typed 'PMT' (branchQuoteType/rateType) classifies per_tonne, which
  // is NOT in the frozen SUPPORTED_MECHANICS, so the SAME guard that refuses an unbuilt mechanic
  // refuses it at all three layers - pure guard, adapter wire, and engine.
  {
    // real PMT load shape (Vishal Pipes 23195633, 2026-07-16 probe): branchQuoteType/rateType 'PMT',
    // loadShipmentType LIES 'FTL', vehicleCount 22 = 22 MT on ~1 truck.
    const pmtRules = deriveLoadRules({
      id: 23195633, companyName: 'Vishal Pipes Ltd', branchQuoteType: 'PMT', rateType: 'PMT',
      loadShipmentType: 'FTL', vehicleCount: 22, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00',
    });
    // the classification itself - this assertion FAILS on unpatched main (pricingMode was 'flat').
    assert.strictEqual(pmtRules.pricingMode, 'per_tonne', 'a PMT load classifies to pricingMode per_tonne (was flat: the dormant guard)');

    // D.a the pure guard now REFUSES a PMT load
    let ge = null; try { assertRulesSupported(pmtRules); } catch (e) { ge = e; }
    assert.ok(ge && ge.code === 'UNSUPPORTED_RULE', 'assertRulesSupported REFUSES a PMT load (per_tonne is unbuilt)');
    assert.ok(ge.mechanics.includes('pricingMode:per_tonne'), 'the per_tonne pricingMode is named on the refusal');

    // the refusal is NOT widened past a genuinely-PMT load: an FTL load and an unknown/missing-basis
    // load stay 'flat' and pass the guard exactly as today (fail-closed on ambiguity, not over-broad).
    const ftlRules = deriveLoadRules({ id: 1, branchQuoteType: 'FTL', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(ftlRules.pricingMode, 'flat', 'an FTL load stays pricingMode flat');
    assert.doesNotThrow(() => assertRulesSupported(ftlRules), 'an FTL load is NOT refused');
    const unknownRules = deriveLoadRules({ id: 2, branchAuctionExtendTime: '00:00:00' }); // SP sent no quoteType
    assert.strictEqual(unknownRules.pricingMode, 'flat', 'an unknown/missing-quoteType load behaves exactly as today (flat)');
    assert.doesNotThrow(() => assertRulesSupported(unknownRules), 'an unknown-basis load is NOT refused (refusal never widened)');

    // D.b adapter wire boundary: buildBidPayload + placeBid refuse a PMT load, NO createV2 is sent
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({}) }; };
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    let be = null; try { a.buildBidPayload(pmtRules, 60000, '23195633'); } catch (e) { be = e; }
    assert.ok(be && be.code === 'UNSUPPORTED_RULE', 'buildBidPayload refuses a PMT load');
    let pe = null; try { await a.placeBid('23195633', 60000, pmtRules); } catch (e) { pe = e; }
    assert.ok(pe && pe.code === 'UNSUPPORTED_RULE', 'placeBid propagates the PMT refusal');
    assert.strictEqual(fetchCalls, 0, 'NO createV2 request was sent for a PMT load (fail closed on the wire)');

    // D.c engine: refuse in _maybeBid (no rung spent), surface unsupported_rule_blocked in _tick
    const f = path.join(os.tmpdir(), `failclosed-pmt-${process.pid}.json`);
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
    const monitor = engine.arm(
      { id: '23195633', lane: { origin: 'A', destination: 'B' }, units: 22, quoteType: 'PMT', closesAt: Date.now() + 1000, rules: pmtRules },
      { cost: 40000, marginsPct: [12, 7, 6], minMarginPct: 6 });
    if (monitor.timer) clearTimeout(monitor.timer); // drive ticks manually
    const state = await adapter.getAuctionState();
    let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
    assert.ok(me && me.code === 'UNSUPPORTED_RULE', '_maybeBid refuses a PMT load BEFORE the write');
    assert.strictEqual(placeBidCalled, 0, 'no bid was placed for the PMT load');
    assert.deepStrictEqual([...monitor.firedRungs], [], 'no rung was spent by the refused PMT attempt');
    await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
    const alert = events.find((e) => e.type === 'alert' && e.kind === 'unsupported_rule_blocked');
    assert.ok(alert, '_tick surfaces an unsupported_rule_blocked alert for the PMT load (the operator sees the refusal, same as any other unbuilt-mechanic refusal)');
    assert.strictEqual(alert.auctionId, '23195633', 'the alert names the PMT load');
    assert.strictEqual(placeBidCalled, 0, 'still no bid placed after a full tick');
    ok('a genuinely-PMT load classifies per_tonne and fails closed at all three layers (FTL/unknown stay flat, not refused)');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- E. CLASSIFIER PARITY with discovery.isMultiVehicle across every quoteType wire shape ----
  // Two independent classifiers read the same SuperProcure basis fields and MUST agree about what
  // counts as 'PMT', because they guard the same money from opposite sides: isMultiVehicle uses it to
  // decide whether `units` is a truck count or a tonnage, and deriveLoadRules uses it to decide
  // whether the per_tonne refusal fires. A load that is PMT to one and not the other is precisely the
  // hole where a per-MT rate reaches the wire as a whole-load amount.
  //
  // They normalise identically (trim + upper-case, compare to the literal 'PMT'), but the FALLBACK
  // operators used to differ - `_mapLoad` does `l.branchQuoteType || l.rateType` (truthy-OR) while
  // deriveLoadRules did `branchQuoteType != null ? ... : rateType` (null-coalescing). Row 5 below is
  // where that splits, and it splits in the FAIL-OPEN direction: isMultiVehicle reads 'PMT' (units are
  // tonnage) while the classifier read '' and stayed 'flat', so the guard never fired and the load
  // would have been bid as a flat FTL amount. Never seen in the 5,532-load census - both fields are
  // always both 'PMT' or both absent - but "unobserved" is not "impossible" on live money, so the
  // parity is pinned by construction here rather than asserted in a PR comment.
  {
    const shapes = [
      { name: 'both PMT (the real Vishal/Rajratan shape)', raw: { branchQuoteType: 'PMT', rateType: 'PMT' }, pmt: true, knownBasis: true },
      { name: 'branchQuoteType PMT only', raw: { branchQuoteType: 'PMT' }, pmt: true, knownBasis: true },
      { name: 'rateType PMT only (branchQuoteType absent)', raw: { rateType: 'PMT' }, pmt: true, knownBasis: true },
      { name: 'whitespace/case junk "  pmt  "', raw: { branchQuoteType: '  pmt  ' }, pmt: true, knownBasis: true },
      // THE divergence row - present-but-EMPTY branchQuoteType with a meaningful rateType.
      { name: 'EMPTY branchQuoteType, rateType PMT (the fail-open divergence)', raw: { branchQuoteType: '', rateType: 'PMT' }, pmt: true, knownBasis: true },
      { name: 'branchQuoteType 0 (falsy), rateType PMT', raw: { branchQuoteType: 0, rateType: 'PMT' }, pmt: true, knownBasis: true },
      { name: 'both FTL', raw: { branchQuoteType: 'FTL', rateType: 'FTL' }, pmt: false, knownBasis: true },
      { name: 'EMPTY branchQuoteType, rateType FTL', raw: { branchQuoteType: '', rateType: 'FTL' }, pmt: false, knownBasis: true },
      // no basis at all: NOT PMT to either side, but isMultiVehicle's OUTPUT cannot be used as the
      // parity probe here - an unknown basis and a PMT basis both make it return false (it defers to
      // strictUnknownBasis). Basis-token parity is still asserted; the behavioural assert is skipped.
      { name: 'no basis at all (mock/sim/legacy)', raw: {}, pmt: false, knownBasis: false },
    ];
    for (const s of shapes) {
      // `units` > 1 so isMultiVehicle's count gate cannot mask the basis read.
      const load = Object.assign({ id: 99, vehicleCount: 22, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' }, s.raw);
      const rules = deriveLoadRules(load);
      // exactly how realAdapter._mapLoad builds the field isMultiVehicle reads
      const mapped = { units: load.vehicleCount, quoteType: normQuoteType(load.branchQuoteType || load.rateType) };
      const classifierSaysPmt = rules.pricingMode === 'per_tonne';
      // the SAME token test isMultiVehicle applies internally (discovery.js: quote !== 'PMT')
      const discoverySaysPmt = (mapped.quoteType == null ? '' : String(mapped.quoteType).trim().toUpperCase()) === 'PMT';
      assert.strictEqual(classifierSaysPmt, s.pmt, `deriveLoadRules classifies ${s.name} as ${s.pmt ? 'per_tonne' : 'flat'}`);
      assert.strictEqual(discoverySaysPmt, s.pmt, `the discovery-side basis reads ${s.name} as ${s.pmt ? 'PMT' : 'not PMT'}`);
      assert.strictEqual(classifierSaysPmt, discoverySaysPmt, `the two PMT classifiers AGREE on ${s.name}`);
      // the behavioural consequence, where it is unambiguous: on a KNOWN basis with units > 1,
      // isMultiVehicle is false exactly when the basis is PMT (units are tonnage, not trucks).
      if (s.knownBasis) {
        assert.strictEqual(isMultiVehicle(mapped), !s.pmt, `isMultiVehicle treats units as ${s.pmt ? 'tonnage' : 'trucks'} on ${s.name}`);
      }
      // and the refusal must follow the classification, not just the label
      if (s.pmt) {
        let e = null; try { assertRulesSupported(rules); } catch (err) { e = err; }
        assert.ok(e && e.code === 'UNSUPPORTED_RULE', `a PMT load is REFUSED: ${s.name}`);
      } else {
        assert.doesNotThrow(() => assertRulesSupported(rules), `a non-PMT load is NOT refused: ${s.name}`);
      }
    }
    // the RAW audit field is unaffected by the classification fallback: an empty branchQuoteType is
    // still recorded VERBATIM as '' on rateType (the fact layer reports what SP sent), even though the
    // load now classifies per_tonne off the rateType fallback.
    const split = deriveLoadRules({ id: 99, branchQuoteType: '', rateType: 'PMT', vehicleCount: 22, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(split.rateType, '', 'the raw rateType audit field still records the empty branchQuoteType verbatim');
    assert.strictEqual(split.pricingMode, 'per_tonne', 'while the CLASSIFICATION falls back to rateType, matching _mapLoad');
    ok('classifier parity: deriveLoadRules and isMultiVehicle agree on PMT across all 9 quoteType wire shapes');
  }

  // ---- F. the SP_PMT_BID safety gate: flag ON makes an MT per-tonne load supported; KG/unknown-unit
  //         per-tonne STAYS fail-closed regardless of the flag ----
  // With SP_PMT_BID=1 the effective supported set gains 'per_tonne', so a genuinely-MT PMT load flips
  // from refused (block D) to biddable at the guard. The KG/unknown-unit gate is INDEPENDENT of the
  // flag: an MT-only per-tonne mechanic must never silently enable the uncaptured KG wire (Tata /
  // Ashirvad), so a KG or unknown-unit PMT load is refused whether the flag is on or off.
  {
    const mtPmt = deriveLoadRules({ id: 23195633, branchQuoteType: 'PMT', rateType: 'PMT',
      brancheUnit: 'MT', vehicleCount: 22, branchAuctionExtendTime: '00:00:00' });
    const kgPmt = deriveLoadRules({ id: 23195634, branchQuoteType: 'PMT', rateType: 'PMT',
      brancheUnit: 'KG', vehicleCount: 9000, branchAuctionExtendTime: '00:00:00' });
    const unkPmt = deriveLoadRules({ id: 23195635, branchQuoteType: 'PMT', rateType: 'PMT',
      vehicleCount: 22, branchAuctionExtendTime: '00:00:00' }); // SP sent no brancheUnit -> unit null

    // classification is flag-INDEPENDENT: all three are pricingMode 'per_tonne' regardless of the gate.
    assert.strictEqual(mtPmt.pricingMode, 'per_tonne', 'MT PMT classifies per_tonne');
    assert.strictEqual(kgPmt.pricingMode, 'per_tonne', 'KG PMT still classifies per_tonne (unit is separate)');
    assert.strictEqual(unkPmt.pricingMode, 'per_tonne', 'unknown-unit PMT still classifies per_tonne');

    const priorFlag = process.env.SP_PMT_BID;
    try {
      // flag OFF (default): every per_tonne load is refused, exactly block D.
      delete process.env.SP_PMT_BID;
      assert.throws(() => assertRulesSupported(mtPmt), (e) => e.code === 'UNSUPPORTED_RULE', 'flag OFF: even an MT PMT load is refused');

      // flag ON: the MT PMT load is now SUPPORTED (guard passes); KG and unknown-unit stay refused.
      process.env.SP_PMT_BID = '1';
      assert.doesNotThrow(() => assertRulesSupported(mtPmt), 'flag ON: an MT per-tonne load is now supported (guard passes)');
      let ke = null; try { assertRulesSupported(kgPmt); } catch (e) { ke = e; }
      assert.ok(ke && ke.code === 'UNSUPPORTED_RULE', 'flag ON: a KG per-tonne load STAYS fail-closed (MT-only)');
      assert.ok(ke.mechanics.includes('per_tonne_unit:KG'), 'the KG refusal names the unit, not the mechanic');
      let ue = null; try { assertRulesSupported(unkPmt); } catch (e) { ue = e; }
      assert.ok(ue && ue.code === 'UNSUPPORTED_RULE', 'flag ON: an unknown-unit per-tonne load STAYS fail-closed');
      assert.ok(ue.mechanics.includes('per_tonne_unit:unknown'), 'the unknown-unit refusal names the unit');

      // round-trip: flipping the flag back OFF refuses the MT load again (the gate is read fresh, not
      // snapshotted - a live operator toggle takes effect on the next evaluation).
      delete process.env.SP_PMT_BID;
      assert.throws(() => assertRulesSupported(mtPmt), (e) => e.code === 'UNSUPPORTED_RULE', 'flag back OFF: the MT PMT load is refused again');
    } finally {
      if (priorFlag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorFlag;
    }
    ok('SP_PMT_BID gate: flag ON makes MT per-tonne supported; KG/unknown-unit stays fail-closed regardless of the flag');
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
