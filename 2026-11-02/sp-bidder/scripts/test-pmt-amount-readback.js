'use strict';
/**
 * PER-TONNE READ-BACK ORACLE - did our per-MT rate land on SuperProcure verbatim?
 *
 * Under the settled wire contract (_research/2026-08-05_pmt-createv2-capture-SETTLED.md) a per-tonne
 * bid sends the BARE per-MT rate as `amount`, and SuperProcure echoes that exact number back on TWO
 * fields - `amountPMT` and `bidRate` - while storing its own multiplied figure on `amount`. The
 * capture: sent 2240 -> amountPMT 2240, bidRate 2240, amount 33600, bidQuantity 30, bidVehicleCount 2.
 *
 * So the oracle is an IDENTITY check, not an arithmetic reconstruction: the number we put on the
 * wire must come back unchanged, on both echo fields. bidQuantity is no longer part of the verdict
 * (it is SP's own per-load quantity, nothing we send) - it rides along as context in the alert.
 * Same after-the-fact belt shape as vehicle_count_mismatch, which sits a few lines away in bidEngine.
 *
 * THIS BELT WOULD HAVE CAUGHT #88 - check 2d replays it. #88 sent amount = rate x pmtQuantity, and
 * because SuperProcure echoes our number VERBATIM rather than dividing (the "SP divides the echo"
 * reading is exactly what the capture refuted), it would have echoed rate x pmtQuantity against a
 * rung of rate - a divergence of rate x (pmtQuantity - 1), i.e. 84,000 rupees on this suite's own
 * fixture, against a 1-rupee tolerance. It never fired for one reason only: SP_PMT_BID has never
 * been set, so the bot has never placed a PMT bid. The belt was UNEXERCISED, not blind - do not
 * let anyone conclude from its silence that it is worthless.
 *
 * WHAT IT IS NOT: a pre-send check. It reads back AFTER the money moved, once per load, so it
 * catches a wrong wire on the first bid rather than preventing that bid. It detects SP-side
 * divergence from what we sent; it is not a substitute for having observed the wire.
 *
 * THE TRAP THIS SUITE EXISTS FOR: SP returns amountPMT on FLAT bids too. SIKA (23094081) is an FTL
 * load and still came back with amountPMT 3828 against a 95700 amount, which bears no relation to
 * the per-truck rupee amount we bid. An ungated oracle would therefore fire on essentially every FTL
 * bid - a false alarm on the busiest path in the system, on a channel that reaches the client's
 * director. Check 3 is the guard.
 *
 *   node scripts/test-pmt-amount-readback.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { deriveLoadRules } = require('../src/model/loadRules');
const { ERROR_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered HERE, above every check, and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE. An async file that ends early - a
// swallowed rejection, an unref'd timer letting the loop drain, a stray `return` - reaches exit 0
// having asserted nothing and reads as a silent green. The count assertion this file used to carry
// at the BOTTOM did not close that hole: it sits downstream of everything it guards, so every one
// of those paths skips it too. Registering the handler before any case runs is what makes it fire
// on every path out of the process. Same shape as test-rejection-classify-contract.js.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 13;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

const TONNAGE = 25;
const RATE = 3500;   // per-MT desk rate -> wire total 87500
// The band that puts the OPENING RUNG exactly on RATE, which is the precondition every echo
// comparison below rests on. It used to be a 1-rung 0%% band off a cost of RATE, which the zero-floor
// guard now correctly refuses: a 0%% floor margin is a bid at the desk cost. 2800 x 1.25 = 3500 keeps
// the rung, on a real margin.
const AT_RATE = { cost: 2800, marginsPct: [25], minMarginPct: 25 };

function pmtRules(over = {}) {
  return Object.assign(deriveLoadRules({
    id: 23308655, companyName: 'Transrail Lighting Ltd', branchQuoteType: 'PMT', rateType: 'PMT',
    loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: TONNAGE,
    branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3,
  }), over);
}

// THE CAPTURED LOAD's own shape (23828313): vehicleCount 30 is the load TOTAL in MT and weight 15 is
// SuperProcure's per-vehicle quantity ("Qty/Vehicle"), so the load implies 2 trucks - and 2 is what
// SP recorded as bidVehicleCount against our vcq:-1. pmtRules() above deliberately carries NO weight,
// so the pair covers both states of the derivation: derivable, and not.
function splitRules(over = {}) {
  return Object.assign(deriveLoadRules({
    id: 23308655, companyName: 'Transrail Lighting Ltd', branchQuoteType: 'PMT', rateType: 'PMT',
    loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: 30, weight: 15,
    branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3,
  }), over);
}

// Engine harness whose stub adapter returns a caller-supplied createV2 response shape.
function runBid({ opts, price, response }) {
  const f = path.join(os.tmpdir(), `pmt-readback-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}), writeEnabled: true,
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid: async () => Object.assign({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }, response),
  };
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
  return { engine, adapter, events, f, cleanup: () => { engine.kill('t'); try { fs.unlinkSync(f); } catch (_) {} } };
}

// `units` is overridable because it is a TRUCK count on the FTL control below and a TONNAGE on every
// per-tonne case. Defaulting both to TONNAGE made the FTL control a 25-TRUCK load whose stub response
// recorded 1 vehicle - a self-inconsistent fixture that raised two real vehicle_count_mismatch alerts
// nobody saw, because the only filter in this file looked at pmt_amount_mismatch.
async function driveOnce(h, rules, inputs, over = {}) {
  const monitor = h.engine.arm(Object.assign({ id: '23308655', lane: { origin: 'A', destination: 'B' },
    units: TONNAGE, companyName: 'Transrail Lighting Ltd',
    quoteType: rules.pricingMode === 'per_tonne' ? 'PMT' : 'FTL',
    closesAt: Date.now() + 1000, rules }, over), inputs);
  if (monitor.timer) clearTimeout(monitor.timer);
  const state = await h.adapter.getAuctionState();
  await h.engine._maybeBid(monitor, state);
  if (monitor.timer) clearTimeout(monitor.timer);
  return monitor;
}
const mismatches = (h) => h.events.filter((e) => e.type === 'alert' && e.kind === 'pmt_amount_mismatch');
// THE BLIND SPOT THIS FILE HAD. `mismatches` filters on ONE kind, so the sibling belt a few lines
// away in bidEngine could fire on every per-tonne case here and the suite still printed "8/8 checks
// passed" - which is exactly what it was doing: the captured-shape case (bidVehicleCount 2, sentVcq
// -1) tripped vehicle_count_mismatch on every run, unseen, for the whole life of the branch. Every
// case below now asserts against the kind it cares about AND against this one, so a per-tonne bid
// that quietly pages a human can never again hide behind a green run.
const countMismatches = (h) => h.events.filter((e) => e.type === 'alert' && e.kind === 'vehicle_count_mismatch');
const noCountAlert = (h, where) => assert.strictEqual(countMismatches(h).length, 0,
  `${where}: no vehicle_count_mismatch may fire here (got `
  + `${JSON.stringify(countMismatches(h).map((e) => e.detail))})`);

(async () => {
  const priorFlag = process.env.SP_PMT_BID;
  try {
    // ---- 1. the adapter SURFACES amountPMT + bidRate + bidQuantity off real captured response shapes ----
    {
      // (a) the VERBATIM shape of the 2026-08-05 PMT createV2 response - the settled contract.
      //     Sent 2240; SP echoed amountPMT 2240 and bidRate 2240, stored amount 33600 (2240 x 15).
      const capturedPmt = { body: null };
      const pmtFetch = async (url, init) => {
        capturedPmt.body = JSON.parse(init.body);
        return { status: 201, headers: { get: () => null },
          json: async () => ({ id: 38835536, load: 23828313, amount: 33600, amountPMT: 2240,
            bidRate: 2240, bidQuantity: 30, bidVehicleCount: 2 }) };
      };
      const ap = new RealSuperProcureAdapter({ token: 't', fetchImpl: pmtFetch });
      ap.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
      ap.writeEnabled = true;
      const resP = await ap.placeBid('23828313', 2240, {});
      assert.strictEqual(capturedPmt.body.amount, 2240, 'precondition: the bare per-MT rate went on the wire');
      assert.strictEqual(resP.amountPMT, 2240, 'placeBid surfaces the echoed amountPMT - our own number back');
      assert.strictEqual(resP.bidRate, 2240, 'placeBid surfaces the echoed bidRate - the second copy of our number');
      assert.strictEqual(resP.bidQuantity, 30, 'placeBid surfaces SP\'s own bidQuantity as a number (context, not a verdict)');
      assert.strictEqual(resP.bidVehicleCount, 2, 'the vehicle-count read-back carries SP\'s derived count (vcq:-1 did NOT mean 1)');

      // (b) the live SIKA FTL createV2 response, unchanged - the false-positive fixture for check 3.
      const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: async () => ({ status: 201, headers: { get: () => null },
        json: async () => ({ id: 37709701, load: 23094081, amount: 95700, amountPMT: 3828,
          bidQuantity: 25, bidVehicleCount: 1, transitTime: 3, bidRate: 95700 }) }) });
      a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
      a.writeEnabled = true;
      const res = await a.placeBid('23094081', 95700, {});
      assert.strictEqual(res.amountPMT, 3828, 'the FTL response still surfaces its (unrelated) amountPMT');
      assert.strictEqual(res.bidQuantity, 25, 'and its bidQuantity');

      // a response WITHOUT the fields (mock adapter / older shape) must yield null, never NaN
      const a2 = new RealSuperProcureAdapter({ token: 't', fetchImpl: async () => ({ status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) }) });
      a2.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
      a2.writeEnabled = true;
      const res2 = await a2.placeBid('1', 1000, {});
      assert.strictEqual(res2.amountPMT, null, 'an absent amountPMT is null, not NaN (the oracle is gated on non-null)');
      assert.strictEqual(res2.bidRate, null, 'an absent bidRate is null');
      assert.strictEqual(res2.bidQuantity, null, 'an absent bidQuantity is null');
      ok('placeBid surfaces amountPMT + bidRate + bidQuantity from the captured createV2 response shapes (null when absent)');
    }

    // ---- 2. an echo that does NOT match the rate we sent raises pmt_amount_mismatch, once ----
    // We send RATE (3500/MT); SP echoes 4375 back. Under the settled contract the echo is supposed to
    // be our own number verbatim, so any divergence at all is a real "our rate did not land" signal.
    {
      process.env.SP_PMT_BID = '1';
      const h = runBid({ response: { amountPMT: 4375, bidRate: 4375, bidQuantity: 20, bidVehicleCount: 1 } });
      const monitor = await driveOnce(h, pmtRules(), { cost: 3000, marginsPct: [17, 10, 6], minMarginPct: 6 });
      const alerts = mismatches(h);
      assert.strictEqual(alerts.length, 1, 'exactly one pmt_amount_mismatch alert fired');
      assert.strictEqual(alerts[0].auctionId, '23308655', 'the alert names the load');
      assert.ok(/4375/.test(alerts[0].detail), `the detail names SP's recorded rate (got ${JSON.stringify(alerts[0].detail)})`);
      assert.ok(/20 MT/.test(alerts[0].detail), 'and the quantity SP charged on, as context');
      assert.ok(!/we multiplied by/.test(alerts[0].detail),
        'and it does NOT claim we multiplied by anything - we no longer send a tonnage');
      // one alert per load, not one per rung
      const state = await h.adapter.getAuctionState();
      await h.engine._maybeBid(monitor, state);
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(mismatches(h).length, 1, 'a second bid on the same load does NOT re-alert (one page per load)');
      noCountAlert(h, 'check 2');
      h.cleanup();
      ok('an echoed rate that differs from the rate we sent raises pmt_amount_mismatch exactly once');
    }

    // ---- 2b. bidRate alone diverging is enough to trip it (the second echo field is not decorative) ----
    {
      process.env.SP_PMT_BID = '1';
      const h = runBid({ response: { amountPMT: RATE, bidRate: 4375, bidQuantity: 25, bidVehicleCount: 1 } });
      await driveOnce(h, pmtRules(), AT_RATE);
      assert.strictEqual(mismatches(h).length, 1, 'a divergent bidRate trips the oracle even when amountPMT agrees');
      h.cleanup();
      // ...and the mirror case, amountPMT divergent while bidRate agrees
      const h2 = runBid({ response: { amountPMT: 4375, bidRate: RATE, bidQuantity: 25, bidVehicleCount: 1 } });
      await driveOnce(h2, pmtRules(), AT_RATE);
      assert.strictEqual(mismatches(h2).length, 1, 'a divergent amountPMT trips it even when bidRate agrees');
      noCountAlert(h2, 'check 2b');
      h2.cleanup();
      ok('either echo field diverging is enough - amountPMT and bidRate are checked independently');
    }

    // ---- 2c. THE #88 REPLAY: the defect this oracle is accused of being blind to, executed ----
    // It is NOT blind to it. #88 put amount = rate x pmtQuantity on the wire; SuperProcure echoes
    // our number verbatim, so the response would have carried amountPMT = bidRate = rate x tonnage.
    // Reconstruct exactly that response against a rung of RATE and assert the oracle pages a human.
    // This exists because a comment in bidEngine.js once claimed the opposite, and the risk of that
    // claim is someone deleting a working belt. Prose can drift; this cannot.
    {
      process.env.SP_PMT_BID = '1';
      const eightyEightEcho = RATE * TONNAGE; // 3500 x 25 = 87500, what SP would have echoed under #88
      const h = runBid({ response: { amount: eightyEightEcho * 15, amountPMT: eightyEightEcho,
        bidRate: eightyEightEcho, bidQuantity: TONNAGE, bidVehicleCount: 1 } });
      const monitor = await driveOnce(h, pmtRules(), AT_RATE);
      assert.strictEqual(monitor.ladder[0], RATE, 'precondition: the rung under test is the bare per-MT rate');
      const alerts = mismatches(h);
      assert.strictEqual(alerts.length, 1,
        'the #88 wire (rate x tonnage) trips pmt_amount_mismatch - the belt was UNEXERCISED, never blind');
      assert.ok(/87500/.test(alerts[0].detail) && /3500/.test(alerts[0].detail),
        `the alert names both numbers so the defect is legible (got ${JSON.stringify(alerts[0].detail)})`);
      noCountAlert(h, 'check 2c');
      h.cleanup();
      // and the divergence is orders above the tolerance, not a marginal trip
      assert.strictEqual(eightyEightEcho - RATE, RATE * (TONNAGE - 1), 'divergence is rate x (tonnage - 1)');
      assert.ok(RATE * (TONNAGE - 1) > 1000, 'which is 84,000 here - never inside the 1-rupee slack');
      ok('the #88 wire shape (rate x tonnage echoed back) DOES trip the oracle - it would have caught the defect on the first live PMT bid');
    }

    // ---- 2d. ALERT-ONLY: a mismatch never stops the engine or costs a rung ----
    {
      process.env.SP_PMT_BID = '1';
      const h = runBid({ response: { amountPMT: 4375, bidRate: 4375, bidQuantity: 20, bidVehicleCount: 1 } });
      const monitor = await driveOnce(h, pmtRules(), { cost: 3000, marginsPct: [17, 10, 6], minMarginPct: 6 });
      assert.strictEqual(mismatches(h).length, 1, 'precondition: the oracle fired');
      assert.strictEqual(h.engine.killed, false, 'the engine is NOT killed by a read-back mismatch');
      assert.ok(h.engine.monitors.has('23308655'), 'the monitor is NOT torn down by it either');
      assert.ok(monitor.firedRungs.size >= 1, 'the rung that mismatched still counts as fired (no rung is refunded)');
      // and the monitor stays drivable: another pass does not throw and does not kill
      const state = await h.adapter.getAuctionState();
      await assert.doesNotReject(() => h.engine._maybeBid(monitor, state),
        'a mismatched read-back never makes the next bid attempt throw');
      if (monitor.timer) clearTimeout(monitor.timer);
      assert.strictEqual(h.engine.killed, false, 'still live after a second pass');
      noCountAlert(h, 'check 2d');
      h.cleanup();
      ok('the oracle is alert-only: no kill, no stop, no refunded rung, no throw on the next pass');
    }

    // ---- 3. THE FALSE-POSITIVE GUARD: a FLAT bid never trips it, even though SP echoes amountPMT ----
    // SIKA proves SP returns amountPMT on an FTL bid (3828 against a 95700 amount). If the oracle
    // were not gated on the pricingMode we SENT, every FTL bid would page a human.
    {
      for (const flag of [undefined, '1']) {
        if (flag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = flag;
        const h = runBid({ response: { amountPMT: 3828, bidQuantity: 25, bidVehicleCount: 1 } });
        const ftl = deriveLoadRules({ id: 23308655, companyName: 'Transrail Lighting Ltd',
          branchQuoteType: 'PER_TRUCK', brancheUnit: 'MT', vehicleCount: 1,
          branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3 });
        assert.strictEqual(ftl.pricingMode, 'flat', 'precondition: the control load is flat');
        // units:1 - on this FLAT control `units` is a TRUCK count, and the stub response records
        // bidVehicleCount 1. Passing the shared TONNAGE (25) here made it a 25-truck load answered
        // with 1 vehicle, which legitimately tripped vehicle_count_mismatch twice per run.
        await driveOnce(h, ftl, { cost: 80000, marginsPct: [17, 10, 6], minMarginPct: 6 }, { units: 1 });
        assert.strictEqual(mismatches(h).length, 0,
          `a FLAT bid does not trip the per-tonne oracle even though SP echoed amountPMT (flag ${String(flag)})`);
        noCountAlert(h, `check 3 (flag ${String(flag)})`);
        h.cleanup();
      }
      ok('a flat bid NEVER trips the oracle despite SP echoing amountPMT on FTL too (the false-positive guard)');
    }

    // ---- 3b. THE FLAT PATH IS UNTOUCHED: vcq:-1 -> 1 still holds, and vcq:N still holds ----
    // The mode-awareness added to expectedCount must not soften the belt it was built for. Both flat
    // failure shapes must still page: SP keeping -1 on a single bid, and a Layer-B vcq:N not taking.
    {
      delete process.env.SP_PMT_BID;
      const flatRules = deriveLoadRules({ id: 23308655, branchQuoteType: 'PER_TRUCK', brancheUnit: 'MT',
        vehicleCount: 1, branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3 });
      // (a) single-vehicle flat, SP records something other than 1 -> still alerts
      const h = runBid({ response: { bidVehicleCount: 2 } });
      await driveOnce(h, flatRules, { cost: 80000, marginsPct: [17, 10, 6], minMarginPct: 6 }, { units: 1 });
      assert.strictEqual(countMismatches(h).length, 1, 'a flat bid whose recorded count is not 1 still pages');
      assert.ok(/we bid for 1/.test(countMismatches(h)[0].detail),
        `and keeps the flat wording (got ${JSON.stringify(countMismatches(h)[0].detail)})`);
      h.cleanup();
      // (b) Layer-B multi-vehicle flat: we send vcq:3, SP records 1 -> still alerts against 3
      const h2 = runBid({ response: { bidVehicleCount: 1 } });
      const mv = deriveLoadRules({ id: 23308655, branchQuoteType: 'PER_TRUCK', brancheUnit: 'MT',
        vehicleCount: 3, branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3 });
      await driveOnce(h2, mv, { cost: 80000, marginsPct: [17, 10, 6], minMarginPct: 6 }, { units: 3 });
      assert.strictEqual(countMismatches(h2).length, 1, 'a Layer-B vcq:N that did not take still pages');
      assert.ok(/we bid for 3/.test(countMismatches(h2)[0].detail), 'against the count we actually sent');
      h2.cleanup();
      ok('the FLAT vehicle-count belt is unchanged by the per-tonne carve-out: -1 -> 1 and vcq:N both still page');
    }

    // ---- 4. a MATCHING read-back is silent, and rounding slack does not trip it ----
    {
      process.env.SP_PMT_BID = '1';
      // exact match: SP echoes back the rate we sent, on both fields
      for (const [label, echo] of [['exact', RATE], ['+1 rupee slack', RATE + 1], ['-1 rupee slack', RATE - 1]]) {
        const h = runBid({ response: { amountPMT: echo, bidRate: echo, bidQuantity: TONNAGE, bidVehicleCount: 1 } });
        const monitor = await driveOnce(h, pmtRules(), AT_RATE);
        assert.strictEqual(monitor.ladder[0], RATE, 'precondition: the opening rung is the rate under test');
        assert.strictEqual(mismatches(h).length, 0, `${label}: a matching read-back is silent`);
        noCountAlert(h, `check 4 (${label})`);
        h.cleanup();
      }
      // THE CAPTURED SHAPE end-to-end: SP's STORED amount is the multiplied total (2240 x 15 = 33600)
      // while the echoes carry our rate. The oracle must read the ECHOES and stay silent - reading
      // the stored `amount` instead would page on every correct PMT bid.
      // The load side is the capture's too - vehicleCount 30 (total MT) against weight 15
      // (Qty/Vehicle), which is 2 trucks, exactly the bidVehicleCount SuperProcure recorded. So BOTH
      // read-back belts must be silent on a wholly correct multi-truck PMT bid. Before the
      // vehicle-count belt was made mode-aware this case raised vehicle_count_mismatch on every run
      // ("recorded 2, we bid for 1"), unseen, because the only filter in this file was pmt-scoped.
      {
        const h = runBid({ response: { amount: RATE * 15, amountPMT: RATE, bidRate: RATE, bidQuantity: 30, bidVehicleCount: 2 } });
        await driveOnce(h, splitRules(), AT_RATE, { units: 30 });
        assert.strictEqual(mismatches(h).length, 0,
          'SP\'s multiplied stored `amount` is NOT compared against the rung - a correct PMT bid is silent');
        noCountAlert(h, 'check 4 (the captured 2-truck shape)');
        h.cleanup();
      }
      // null read-back (mock adapter / rejected bid) is silent too
      const h2 = runBid({ response: {} });
      await driveOnce(h2, pmtRules(), { cost: 3000, marginsPct: [17, 10, 6], minMarginPct: 6 });
      assert.strictEqual(mismatches(h2).length, 0, 'a null read-back is silent (the oracle is gated on non-null)');
      noCountAlert(h2, 'check 4 (null read-back)');
      h2.cleanup();
      ok('a matching read-back, the full captured response shape, 1-rupee slack, and an absent read-back are all silent');
    }

    // ---- 4b. THE PER-TONNE COUNT ORACLE: what it expects, and what it does when it cannot know ----
    // vcq:-1 is NOT "one vehicle" on a PMT load - SP derives the count from the load and recorded 2
    // on the capture. So the flat expectation (-1 -> 1) is not merely useless here, it is wrong in
    // the false-alarm direction on every split load. The per-tonne expectation is the load's OWN
    // derived truck count (LoadRules.pmtVehicleCount), which is the same number the pricing page
    // shows the desk - so this belt is the check that the page did not lie about the commitment.
    {
      process.env.SP_PMT_BID = '1';
      // (a) SP records a count the load's figures did NOT imply -> page a human, in per-tonne words
      const h = runBid({ response: { amountPMT: RATE, bidRate: RATE, bidQuantity: 45, bidVehicleCount: 3 } });
      await driveOnce(h, splitRules(), AT_RATE, { units: 30 });
      assert.strictEqual(mismatches(h).length, 0, 'the RATE landed verbatim, so the amount oracle stays quiet');
      const ca = countMismatches(h);
      assert.strictEqual(ca.length, 1, 'but a recorded truck count of 3 against a derived 2 DOES page');
      assert.ok(/3 truck\(s\)/.test(ca[0].detail) && /said 2/.test(ca[0].detail),
        `naming both counts (got ${JSON.stringify(ca[0].detail)})`);
      assert.ok(!/we bid for/.test(ca[0].detail),
        'and NOT claiming we bid for a count - on a per-tonne bid we send no count at all');
      h.cleanup();
      // (b) the count cannot be derived (SP gave no usable weight) -> SKIPPED, never guessed as 1.
      //     Substituting 1 is precisely the defect this carve-out fixes; refusing to guess is the fix.
      const h2 = runBid({ response: { amountPMT: RATE, bidRate: RATE, bidQuantity: 25, bidVehicleCount: 4 } });
      assert.strictEqual(pmtRules().pmtVehicleCount, null, 'precondition: this load yields no derivable truck count');
      await driveOnce(h2, pmtRules(), AT_RATE);
      assert.strictEqual(countMismatches(h2).length, 0,
        'with no derivable count there is nothing to compare against, so the check is skipped - not defaulted to 1');
      h2.cleanup();
      ok('the per-tonne count oracle expects the load\'s own derived truck count, and skips rather than guessing when it has none');
    }

    // ---- 4c. THE MULTIPLIER IN THE ALERT TEXT is the PER-VEHICLE tonnage, not the load total ----
    // This alert is read by a human reconciling against SuperProcure's screen, so the number it names
    // as the multiplier has to be the one SP actually multiplied by: bidQuantity / bidVehicleCount.
    // The two coincide only on a one-truck load, which is why stating bidQuantity looked right for a
    // month. Capture: amount 33600 = 2240 x 15, and 15 = 30 / 2 - never 30.
    {
      process.env.SP_PMT_BID = '1';
      const h = runBid({ response: { amountPMT: 9999, bidRate: 9999, bidQuantity: 30, bidVehicleCount: 2 } });
      await driveOnce(h, splitRules(), AT_RATE, { units: 30 });
      const a = mismatches(h);
      assert.strictEqual(a.length, 1, 'precondition: the amount oracle fired on the divergent echo');
      assert.ok(/15 MT per truck/.test(a[0].detail),
        `the alert names the PER-VEHICLE tonnage SP multiplied by (got ${JSON.stringify(a[0].detail)})`);
      assert.ok(!/charged on 30 MT\b/.test(a[0].detail),
        'and does NOT state the load total 30 as the multiplier - that is the wording this replaces');
      assert.ok(/30 MT across 2 truck\(s\)/.test(a[0].detail),
        'the load total is still there, correctly labelled as the total across the trucks');
      h.cleanup();
      // and with no usable vehicle count it states only what it can prove, never dividing by an assumed 1
      const h2 = runBid({ response: { amountPMT: 9999, bidRate: 9999, bidQuantity: 30 } });
      await driveOnce(h2, splitRules(), AT_RATE, { units: 30 });
      const a2 = mismatches(h2);
      assert.strictEqual(a2.length, 1, 'precondition: it fired');
      assert.ok(/states 30 MT for the whole load/.test(a2[0].detail),
        `with no count it labels 30 as the load total, not as a multiplier (got ${JSON.stringify(a2[0].detail)})`);
      assert.ok(!/per truck/.test(a2[0].detail), 'and claims no per-truck figure it cannot derive');
      h2.cleanup();
      ok('the pmt_amount_mismatch alert names bidQuantity/bidVehicleCount as the multiplier, and stays silent about it when it cannot derive one');
    }

    // ---- 5. the kind is registered so it actually reaches a human ----
    {
      assert.ok(ERROR_KINDS.has('pmt_amount_mismatch'),
        'pmt_amount_mismatch is in ERROR_KINDS, like its vehicle_count_mismatch sibling');
      ok('pmt_amount_mismatch is registered in ERROR_KINDS (it reaches the alert channel, not just the log)');
    }

    // ---- 6. AN ECHO WE CANNOT PARSE IS A MISMATCH, NOT AN AGREEMENT ----
    // The adapter coerces with a bare Number(), so a field that is PRESENT but unparseable arrives as
    // NaN, not null - it clears the `!= null` gate. Under the positive comparison (`diff > 1`) that
    // read as agreement, because Math.abs(NaN) > 1 is false: an oracle silently blind to every
    // response shape it cannot read, while continuing to look healthy. SuperProcure demonstrably does
    // ship numeric fields as strings ("90000.00") and "-" placeholders on adjacent wire fields, so
    // this is a response class to fail closed on, not a hypothetical.
    {
      process.env.SP_PMT_BID = '1';
      for (const junk of ['2,240', '-', '3500/MT', '']) {
        const h = runBid({ response: { amountPMT: junk, bidRate: RATE, bidQuantity: 25, bidVehicleCount: 1 } });
        await driveOnce(h, pmtRules(), AT_RATE);
        const a = mismatches(h);
        assert.strictEqual(a.length, 1, `an unreadable amountPMT (${JSON.stringify(junk)}) must PAGE, never read as agreement`);
        assert.ok(!/NaN/.test(a[0].detail),
          `and the alert must not print "NaN" at a human (got ${JSON.stringify(a[0].detail)})`);
        h.cleanup();
      }
      // The control: a readable echo that agrees is still silent, so the fix did not just make the
      // oracle fire on everything.
      const ok1 = runBid({ response: { amountPMT: RATE, bidRate: RATE, bidQuantity: 25, bidVehicleCount: 1 } });
      await driveOnce(ok1, pmtRules(), AT_RATE);
      assert.strictEqual(mismatches(ok1).length, 0, 'a readable, matching echo stays silent');
      ok1.cleanup();
      ok('an unparseable rate echo trips pmt_amount_mismatch (fail closed on NaN), and a good echo still does not');
    }

    // ---- 7. A STRUCTURALLY INVALID RECORDED COUNT PAGES WITH NO EXPECTATION AT ALL ----
    // "We cannot derive the expected count" and "there is nothing worth checking" are different
    // claims. A recorded count below 1 - the invisible 23167278 "-1 vehicles" failure this oracle was
    // built for - is invalid against EVERY expectation, so it needs none. Without this arm, check 4b(b)
    // above (the legitimate skip) also swallowed the one shape that can never be legitimate.
    {
      process.env.SP_PMT_BID = '1';
      assert.strictEqual(pmtRules().pmtVehicleCount, null, 'precondition: no derivable count, so the comparison arm is skipped');
      for (const bad of [-1, 0, 'x']) {
        const h = runBid({ response: { amountPMT: RATE, bidRate: RATE, bidQuantity: 25, bidVehicleCount: bad } });
        await driveOnce(h, pmtRules(), AT_RATE);
        const ca = countMismatches(h);
        assert.strictEqual(ca.length, 1, `a recorded count of ${JSON.stringify(bad)} must page even with no expectation to compare against`);
        assert.ok(/not a count it can be/.test(ca[0].detail),
          `worded as an invalid count, not as a disagreement (got ${JSON.stringify(ca[0].detail)})`);
        h.cleanup();
      }
      // ...and a PLAUSIBLE count with no expectation is still silent - the skip that check 4b(b) pins
      // is preserved, so this arm did not quietly re-introduce the false-alarm defect it sits beside.
      const h2 = runBid({ response: { amountPMT: RATE, bidRate: RATE, bidQuantity: 25, bidVehicleCount: 4 } });
      await driveOnce(h2, pmtRules(), AT_RATE);
      assert.strictEqual(countMismatches(h2).length, 0, 'a plausible count with nothing to compare it to stays silent');
      h2.cleanup();
      ok('a recorded vehicle count below 1 pages even when no expected count could be derived');
    }
  } finally {
    if (priorFlag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorFlag;
  }

  // The count assertion is ALSO kept here (belt) alongside the exit-handler sentinel registered at
  // the top of the file (suspenders) - this one gives the clearer failure when the file runs to the
  // end, that one is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
