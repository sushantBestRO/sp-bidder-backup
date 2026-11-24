'use strict';
/**
 * Offline unit check for gap A1: the socket -> getAuctionState merge.
 * No token, no network. Injects a fake socket + seeds loadMeta, then asserts
 * RealSuperProcureAdapter.getAuctionState merges live rank/countdown/close-model
 * correctly over the cached REST metadata.
 *
 * Also pins the PMT fail-closed classification END-TO-END at the wire seam (check 8): a raw SP load
 * SP typed "PMT" maps (via _mapLoad -> deriveLoadRules) to pricingMode 'per_tonne' and buildBidPayload
 * REFUSES it before building a createV2 body (the per-tonne write wire is uncaptured); a genuinely-FTL
 * load still builds its normal body, so the refusal is not widened past PMT.
 *
 *   node scripts/test-adapter-wire.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

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
const EXPECTED_CHECKS = 11;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`
COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});


// A minimal SpSocket stand-in (same surface getAuctionState uses).
function fakeSock(frame, nowMs) {
  return {
    watched: [],
    _frame: frame,
    watch(id, open) { this.watched.push([String(id), open]); },
    state() { return this._frame; },
    serverNow() { return nowMs; },
    closesInMs(id, fallbackCloseMs) {
      const end = (this._frame && this._frame.loadEndTimeMs) || fallbackCloseMs;
      return end ? Math.max(0, end - this.serverNow()) : null;
    },
  };
}

const NOW = 1_700_000_000_000; // fixed epoch so countdown math is deterministic
const meta = (over = {}) => Object.assign({
  id: '42', closesAt: NOW + 60_000, softClose: false, revisionLimit: 3, isOpenAuction: false,
}, over);

(async () => {
  // 1) REST-only (no socket): countdown from metadata, rank stays null, hard close.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.serverNow = () => NOW; // pin the adapter clock for the REST fallback path
    a.loadMeta.set('42', meta());
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.ok, true, 'ok');
    assert.strictEqual(st.myRank, null, 'no socket -> rank null');
    assert.strictEqual(st.closeModel, 'hard', 'hard close from metadata');
    // static per-load cap is surfaced as revisionLimit; revisionsLeft stays null (no
    // authoritative live remaining), so the engine seeds once and decrements locally.
    assert.strictEqual(st.revisionLimit, 3, 'static cap surfaced as revisionLimit');
    assert.strictEqual(st.revisionsLeft, null, 'no authoritative live remaining');
    assert.ok(Math.abs(st.closesInMs - 60_000) < 5, 'countdown ~60s from REST closesAt');
    assert.strictEqual(st.measuredRttMs, a.assumedRttMs, 'rtt defaults to assumed before any bid');
    ok('REST-only fallback (no socket): countdown + null rank + hard');
  }

  // 2) Socket frame present: live rank + ladder size + socket-driven countdown.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.loadMeta.set('42', meta());
    a.attachSocket(fakeSock({ myRank: 2, bids: [{}, {}, {}], loadEndTimeMs: NOW + 8_000, extended: false }, NOW));
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.myRank, 2, 'rank from socket frame');
    assert.strictEqual(st.totalBidders, 3, 'totalBidders from ladder length');
    assert.ok(Math.abs(st.closesInMs - 8_000) < 5, 'countdown ~8s from socket loadEndTime');
    assert.strictEqual(st.closeModel, 'hard', 'still hard (no extension yet)');
    ok('socket frame: live rank + ladder + loadEndTime countdown');
  }

  // 3) Socket reports an extension -> close model upgrades to soft even if REST said hard.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.loadMeta.set('42', meta({ softClose: false }));
    a.attachSocket(fakeSock({ myRank: 1, bids: [{}], loadEndTimeMs: NOW + 5_000, extended: true }, NOW));
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.closeModel, 'soft', 'live extension overrides REST hard -> soft');
    ok('soft upgrade on observed AuctionExtended');
  }

  // 4) Watching is emitted exactly once per load (subscribe is idempotent).
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.loadMeta.set('42', meta({ isOpenAuction: true }));
    const sock = fakeSock({ myRank: 1, bids: [{}], loadEndTimeMs: NOW + 5_000 }, NOW);
    a.attachSocket(sock);
    await a.getAuctionState('42');
    await a.getAuctionState('42');
    assert.strictEqual(sock.watched.length, 1, 'auctionStart emitted once, not per tick');
    assert.deepStrictEqual(sock.watched[0], ['42', 1], 'watch carries isOpenAuction=1');
    ok('watch() is once-per-load and carries isOpenAuction');
  }

  // 5) Unknown load with no metadata and no socket -> ok:false (engine skips, never finalizes).
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    // account stays null -> no network safety-net list attempted
    const st = await a.getAuctionState('999');
    assert.strictEqual(st.ok, false, 'unknown load -> ok:false, not closesInMs:0');
    ok('unknown load -> ok:false (no premature finalize)');
  }

  // 5b) closesAtMs is ABSENT, never null. The engine's scheduled-wake path tests it with
  // Number.isFinite(Number(closesAtMs)) (bidEngine.js:1047), and Number(null) is 0 - which IS
  // finite - so a null would be read as an absolute close of epoch 0. Absent gives NaN and
  // resolves to null as intended.
  //
  // This ALSO pins the coupling that makes the null branch unreachable today: closesInMs and
  // closesAtMs are derived from the same two sources, so ok:true implies a close exists. If a
  // future change gives closesInMs a third fallback, the second assertion here fails and says so
  // before an epoch-0 close reaches the engine.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.serverNow = () => NOW;
    a.loadMeta.set('42', meta());
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.ok, true, 'precondition: this load reports ok');
    assert.ok(Object.prototype.hasOwnProperty.call(st, 'closesAtMs'), 'a load with a close publishes closesAtMs');
    assert.strictEqual(st.closesAtMs, NOW + 60_000, 'and it is the REST close, by value');
    ok('closesAtMs is published by value when a close is known');

    // The invariant: any ok:true state must carry a usable close - never a null that coerces to 0.
    const liveClose = Number.isFinite(Number(st.closesAtMs)) ? Number(st.closesAtMs) : null;
    assert.strictEqual(liveClose, NOW + 60_000, 'the engine consumer reads back the real epoch');
    assert.notStrictEqual(liveClose, 0, 'and never epoch 0');
    ok('ok:true implies a close the engine consumer resolves to a real epoch, never 0');
  }

  // 6) Measured write RTT (once a bid has fired) replaces the assumed default.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.loadMeta.set('42', meta());
    a.lastWriteRttMs = 137;
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.measuredRttMs, 137, 'rtt reflects last measured write latency');
    ok('measuredRttMs uses real write latency once known');
  }

  // 7) KNOWN load whose close time is UNKNOWN (scheduled-but-not-yet-open window: _mapLoad
  // nulls closesAt while biddingOn !== 1, and the socket has no frame until the room goes
  // live) -> skip + retry, never ok:true with closesInMs:0. The old `?? 0` fallback here
  // finalized OA 23088404 AND OA 23088465 as "lost" ~30 minutes before their real closes,
  // at the arm-lead wake 10 seconds before each bidding window opened (2026-07-13).
  {
    // REST-only variant
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.serverNow = () => NOW;
    a.loadMeta.set('42', meta({ closesAt: null, status: 'unscheduled' }));
    const st = await a.getAuctionState('42');
    assert.strictEqual(st.ok, false, 'null closesAt + no frame -> ok:false, not closed');
    // socket-attached variant: sock connected but no frame for this load yet
    const b = new RealSuperProcureAdapter({ token: 'x' });
    b.sock = fakeSock(null, NOW);
    b.loadMeta.set('42', meta({ closesAt: null, status: 'unscheduled' }));
    const st2 = await b.getAuctionState('42');
    assert.strictEqual(st2.ok, false, 'null closesAt + sock with no frame -> ok:false, not closed');
    ok('unknown close time on a known load -> skip/retry, no premature finalize');
  }

  // 8) PMT classification reaches the WIRE seam. A raw SP load SP typed 'PMT' maps (via _mapLoad ->
  //    deriveLoadRules) to pricingMode 'per_tonne', and buildBidPayload REFUSES it before building a
  //    createV2 body - per_tonne is not in SUPPORTED_MECHANICS (the per-tonne write wire is uncaptured),
  //    so the existing fail-closed guard holds it at the wire boundary. A genuinely-FTL load still
  //    builds a normal body, so the refusal is not widened past a load SP itself typed 'PMT'.
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, serverTimeOffsetMs: 0 };
    a.writeEnabled = true;
    const future = new Date(NOW + 600_000).toISOString();
    // real PMT shape (Vishal Pipes 23195633): branchQuoteType/rateType 'PMT'; loadShipmentType lies 'FTL'.
    const pmt = a._mapLoad({ id: 23195633, companyName: 'Vishal Pipes Ltd', biddingOn: 1, biddingCloseTime: future,
      branchAuctionExtendTime: '00:00:00', branchQuoteType: 'PMT', rateType: 'PMT', loadShipmentType: 'FTL', vehicleCount: 22 });
    assert.strictEqual(pmt.rules.pricingMode, 'per_tonne', 'a mapped PMT load carries rules.pricingMode per_tonne');
    let be = null; try { a.buildBidPayload(pmt.rules, 60000, pmt.id); } catch (e) { be = e; }
    assert.ok(be && be.code === 'UNSUPPORTED_RULE', 'buildBidPayload refuses the PMT load at the wire seam (no createV2 body built)');

    // control: a genuinely-FTL load maps to flat and still builds a normal createV2 body (unchanged).
    const ftl = a._mapLoad({ id: 23196002, companyName: 'Epack Prefab', biddingOn: 1, biddingCloseTime: future,
      branchAuctionExtendTime: '00:00:00', branchQuoteType: 'FTL', rateType: 'FTL', loadShipmentType: 'FTL', vehicleCount: 1 });
    assert.strictEqual(ftl.rules.pricingMode, 'flat', 'a mapped FTL load stays pricingMode flat');
    const built = a.buildBidPayload(ftl.rules, 90000, ftl.id);
    assert.strictEqual(built.body.amount, 90000, 'the FTL load still builds a normal createV2 body (refusal not widened past PMT)');
    ok('PMT classification reaches the wire: _mapLoad -> per_tonne -> buildBidPayload refuses; FTL still builds');
  }

  // 9) PER-TONNE WIRE SHAPE (SP_PMT_BID=1), pinned to THE CAPTURED BID. With the safety gate on, an
  //    MT per-tonne load flips from refused (check 8) to biddable, and the wire carries the desk's
  //    BARE PER-MT RATE - SuperProcure does the tonnage multiplication itself.
  //
  //    THE GOLDEN IS A REAL CAPTURE, not a worked example: load 23828313, browser sent
  //    { amount: 2240, in: "PMT", vcq: -1 } -> HTTP 201, and SP stored amount 33600 (= 2240 x 15,
  //    the per-vehicle tonnage 30/2) while echoing amountPMT 2240 and bidRate 2240
  //    (_research/2026-08-05_pmt-createv2-capture-SETTLED.md).
  //
  //    RED-then-GREEN against #88: this assertion (2240, the rate) FAILS on the shipped
  //    pmtWireTotal() behaviour, which sent rate x tonnage and made SP multiply a SECOND time -
  //    Rs 2,240/MT recorded as Rs 49,280/MT on a 22 MT load, an overbid scaling with tonnage. The
  //    load's tonnage must appear NOWHERE in the body, which is why the negative assertions below
  //    name the products it would have produced.
  {
    const priorFlag = process.env.SP_PMT_BID;
    process.env.SP_PMT_BID = '1';
    try {
      const a = new RealSuperProcureAdapter({ token: 'x' });
      a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, serverTimeOffsetMs: 0 };
      a.writeEnabled = true;
      const future = new Date(NOW + 600_000).toISOString();
      // THE CAPTURED LOAD: 23828313, PMT/MT, bidQuantity 30 across 2 vehicles (15 MT/vehicle).
      const pmt = a._mapLoad({ id: 23828313, companyName: 'Vishal Pipes Ltd', biddingOn: 1, biddingCloseTime: future,
        branchAuctionExtendTime: '00:03:00', branchQuoteType: 'PMT', rateType: 'PMT', loadShipmentType: 'FTL',
        brancheUnit: 'MT', vehicleCount: 30 });
      assert.strictEqual(pmt.rules.pricingMode, 'per_tonne', 'MT PMT load classifies per_tonne');
      assert.strictEqual(pmt.rules.unit, 'MT', 'the load unit is MT');

      const opts = Object.assign({}, pmt.rules, { floor: 2000 }); // per-MT operating floor
      const built = a.buildBidPayload(opts, 2240, pmt.id);
      // THE pin (red on the #88 code): amount is the captured RATE 2240, byte-identical to what the
      // browser sent. NOT 2240 x 30 (the whole-load product) and NOT 2240 x 15 (the per-vehicle one).
      assert.strictEqual(built.body.amount, 2240, 'wire amount is the BARE PER-MT RATE, exactly as the captured browser bid sent it');
      assert.notStrictEqual(built.body.amount, 2240 * 30, 'wire amount is NOT rate x the load quantity (the #88 double-multiply)');
      assert.notStrictEqual(built.body.amount, 2240 * 15, 'wire amount is NOT rate x the per-vehicle tonnage either - no tonnage touches the write path');
      assert.strictEqual(built.body.in, 'PMT', 'the wire in-flag is PMT, not the lying loadShipmentType "FTL" (proven sent by the browser)');
      assert.strictEqual(built.body.vcq, -1, 'a per-tonne bid sends the vcq:-1 sentinel (accepted; SP derived bidVehicleCount 2 from the load)');
      // the floor is NOT rescaled: per-MT amount vs per-MT floor keeps assertAboveFloor unit-consistent.
      assert.strictEqual(built.wireFloor, 2000, 'the wireFloor is the per-MT operating floor UNCHANGED (no tonnage conversion on either operand)');

      // a fractional per-MT rate still rounds to the whole rupee, exactly like the flat path.
      const builtFrac = a.buildBidPayload(Object.assign({}, opts, { floor: 1 }), 3689.6, pmt.id);
      assert.strictEqual(builtFrac.body.amount, 3690, 'a fractional per-MT rate rounds to the rupee (Math.round, same as flat)');
      ok('per-tonne wire shape pinned to the 2026-08-05 capture: amount = the bare per-MT rate 2240, in:"PMT", vcq:-1, floor left per-MT');
    } finally {
      if (priorFlag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorFlag;
    }
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
