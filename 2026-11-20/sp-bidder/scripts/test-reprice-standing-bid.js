'use strict';
/**
 * A re-price must bid BELOW the price this load already has standing, or not bid at all.
 *
 * The defect these pin, from the 2026-09-08 negative-margin forensics. reArmWithNewBand is
 * engine.stop() + armFromRequest; arm() rebuilt the monitor with currentRungIndex -1 and an empty
 * firedRungs, and remapFiredRungs carries fired rungs forward BY PRICE, so a genuine cost change
 * legitimately carries nothing. The re-armed monitor was then byte-identical to one that had never
 * bid, and _decide's establish branch offered ladder[0] - our HIGHEST price - over a live bid of our
 * own. A reverse auction refuses that outright, and the refusal is what started the walk down that
 * ended below cost.
 *
 * Verbatim from the records: load 260908LD2Z (Waaree, 2026-09-08) - bid_placed 31,610, then
 * margin_override_set cost 38,000, then bid_rejected 41,420 rungIndex 0 three seconds later, 114
 * minutes before close. SuperProcure said the rule out loud on load 23413312: "Amount is invalid.
 * Amount should be less than or equal to 51650" - our own standing 51,750 minus that load's
 * decrement.
 *
 * The control is load 260908A2W4: same customer, same portal, same day, re-priced DOWNWARD, and it
 * worked perfectly (130,800 -> 98,100 -> 96,480, all accepted). Every fix here has to leave it
 * landing exactly those prices - a guard that also blocks a downward re-price is a failed guard.
 *
 *   node scripts/test-reprice-standing-bid.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder, maxImprovementPrice } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest, assertLadderReachable } = require('../src/pricing/priceRequests');

let pass = 0;
const EXPECTED_CHECKS = 35;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
// A per-run directory, not a pid-named file in the shared tmpdir: Windows reuses pids, and an
// intent file left by an aborted run carries a landed bid that the next same-pid run rehydrates as
// its own standing price.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprice-standing-'));
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const tmp = (n) => path.join(TMP_DIR, `${n}.json`);
const cleanup = (f) => { try { fs.unlinkSync(f); } catch (_) {} };

// --- Hand-derived ladders, worked from buildBandLadder's spec (rung = round(cost * (1 + pct/100)))
// rather than read back from the engine, so a wrong rung is caught independently of the builder. ---
// Case A, load 260908LD2Z as it actually ran: captured at Rs 29,000 on Waaree's inherited band
// (opening 9%, floor 1%), then corrected UP to Rs 38,000 on the desk's own band.
const A_COST = 29_000, A_BAND = [9, 5, 1];
const A_LADDER = [31_610, 30_450, 29_290];          // the standing bid is A_LADDER[0] = 31,610
const A_NEW_COST = 38_000, A_NEW_BAND = [9, 7.2, 1.8];
const A_NEW_LADDER = [41_420, 40_736, 38_684];      // every rung above the standing 31,610
// Case B, the partial-reachability shape: the cost moves up but not past the standing bid, so the
// TOP of the new ladder is unreachable while the middle is fine. This is what proves the fix
// re-enters the ladder below the standing bid rather than merely standing the load down.
const B_NEW_COST = 27_000, B_NEW_BAND = [20, 10, 1];
const B_NEW_LADDER = [32_400, 29_700, 27_270];      // rung 0 above 31,610; rung 1 below it
// The CONTROL, load 260908A2W4: priced at Rs 120,000, corrected DOWN to Rs 90,000.
const C_COST = 120_000, C_BAND = [9, 7.2, 1.8];
const C_LADDER = [130_800, 128_640, 122_160];
const C_NEW_COST = 90_000;
const C_NEW_LADDER = [98_100, 96_480, 91_620];

// A rank-only, HARD-close adapter. The two conditions every case here depends on are that the
// establish branch RUNS at REMAINING_MS and that _decisiveShotDue is FALSE while it does - that
// combination is what sends _decide to ladder[0] and reproduces the defect.
//
// Hard close, not soft, and deliberately so. The original fixture used a soft, non-allowlisted load
// because that path establishes at any remaining time - but WHEN a soft load first bids is exactly
// what the GoComet close-timing work changes, so this file's precondition would silently encode
// behaviour another lane is removing and the two would compose red (proven: composed with
// fix/gocomet-close-timing, `placed` came back [] and the precondition failed).
//
// On a hard close the establish gate is `remaining <= _establishThreshold`, which is cfg.openAtMs
// plus jitter and is ours to set, while _decisiveShotDue reduces to `remaining <= floorWindowMs`
// and is independent of it. So openAtMs above the 114-minute mark buys the establish, floorWindowMs
// far below it keeps the decisive shot shut, and neither depends on the soft-close branch at all.
// Do NOT "fix" a future failure here by lowering REMAINING_MS instead: inside the closing window
// _decisiveShotDue flips true, the guarded floor path runs, and this file would go green while
// testing none of what it exists to test.
function hardAdapter() {
  return {
    writeEnabled: true,
    placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 1, totalBidders: 3, standingL1Price: null,
      closesInMs: 6_840_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 }),
    async placeBid(id, price) {
      if (!this.writeEnabled) throw new Error('write disabled');
      this.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    },
  };
}

// 114 minutes of runway - the real gap on 260908LD2Z between the corrected cost and the close, and
// far outside any final/snipe window, which is exactly why the deployed _decisiveShotDue guard
// never fired. rank 1 because the bot was holding L1 when the desk corrected the cost.
const REMAINING_MS = 114 * 60 * 1000;
// Above REMAINING_MS so the establish gate is open for the whole scenario, and two orders of
// magnitude above floorWindowMs so the decisive-shot gate stays shut. Asserted below.
const OPEN_AT_MS = 2 * 60 * 60 * 1000;
const FLOOR_WINDOW_MS = 2_500;
const liveState = (rank = 1) => ({ ok: true, status: 'live', myRank: rank, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });

const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

function mkEngine(tag) {
  const f = tmp(tag);
  const adapter = hardAdapter();
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
  return { engine, adapter, f };
}

// Arm a load, land its first bid, then re-price to a new cost/band through the ENGINE's own re-arm
// (stop + arm) - the composition reArmWithNewBand performs. Returns the re-armed monitor.
async function armBidAndReArm(tag, { cost, band, newCost, newBand }) {
  const h = mkEngine(tag);
  const m1 = h.engine.arm(mkLoad('LD2Z'), { cost, marginsPct: band, minMarginPct: band[band.length - 1] });
  if (m1.timer) clearTimeout(m1.timer);                  // isolate from auto-ticks
  await h.engine._maybeBid(m1, liveState(2));            // the establishing bid lands
  h.engine.stop('LD2Z');
  const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: newCost, marginsPct: newBand, minMarginPct: newBand[newBand.length - 1] });
  if (m2.timer) clearTimeout(m2.timer);
  return Object.assign(h, { first: m1, monitor: m2 });
}

(async () => {
  // ---- 0) Fixture sanity. Every expected price below is hand-derived; if buildBandLadder ever
  // drifts from these, every downstream assertion is judging against the wrong number. ----
  {
    const rows = [
      [{ cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 }, A_LADDER, 'A opening band'],
      [{ cost: A_NEW_COST, marginsPct: A_NEW_BAND, minMarginPct: 1.8 }, A_NEW_LADDER, 'A corrected band'],
      [{ cost: B_NEW_COST, marginsPct: B_NEW_BAND, minMarginPct: 1 }, B_NEW_LADDER, 'B partially reachable band'],
      [{ cost: C_COST, marginsPct: C_BAND, minMarginPct: 1.8 }, C_LADDER, 'control opening band'],
      [{ cost: C_NEW_COST, marginsPct: C_BAND, minMarginPct: 1.8 }, C_NEW_LADDER, 'control corrected band'],
    ];
    for (const [inputs, expected, label] of rows) {
      assert.deepStrictEqual(buildBandLadder(inputs).ladder, expected, `${label} is the hand-derived ladder`);
    }
    ok('fixture sanity: every hand-derived ladder matches buildBandLadder (incl. the audit\'s 31610 / 41420 / 98100)');
  }

  // ---- 0b) THE GEOMETRY THIS FILE RESTS ON, asserted rather than assumed. Every case below needs
  // the establish branch to RUN at REMAINING_MS while _decisiveShotDue is FALSE - that pair is what
  // sends _decide to ladder[0] and reproduces the defect. Both are engine predicates, so a config
  // change or a re-timed close model can silently take one away and leave the file green while it
  // tests nothing. Fail here first, loudly, instead. ----
  {
    const h = mkEngine('geometry');
    const m = h.engine.arm(mkLoad('GEO'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);

    assert.strictEqual(m.closeModel, 'hard', 'the fixture is a HARD close - it must not depend on the soft-close establish branch');
    assert.strictEqual(m.softStrategy, 'off', 'and it is not soft-allowlisted, so no rank-driven endgame applies');
    assert.ok(REMAINING_MS <= h.engine._establishThreshold(m),
      'the establish gate is OPEN at 114 minutes (remaining <= openAtMs + jitter), so the first bid actually fires');
    assert.strictEqual(h.engine._decisiveShotDue(m, REMAINING_MS), false,
      'and the decisive-shot gate is SHUT at 114 minutes - this is the condition that makes _decide fall through to ladder[0]');
    assert.strictEqual(h.engine._decisiveShotDue(m, 1_000), true,
      'while it does open at the buzzer, which case 11 relies on');
    h.engine.kill(); cleanup(h.f);
    ok('fixture geometry: establish gate open at 114 minutes AND decisive-shot gate shut - the pair the whole file rests on');
  }

  // ---- 1) THE DEFECT, case A. Re-priced 114 minutes from close onto a ladder entirely above the
  // standing bid: not one price may go on the wire. Before the fix this placed 41,420 against its
  // own live 31,610 - the exact bid_rejected in the record. ----
  {
    const r = await armBidAndReArm('caseA', { cost: A_COST, band: A_BAND, newCost: A_NEW_COST, newBand: A_NEW_BAND });
    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0]], 'precondition: the first bid landed at 31,610 and nothing else has');
    assert.deepStrictEqual(r.monitor.ladder, A_NEW_LADDER, 'precondition: the re-armed ladder is the corrected band [41420, 40736, 38684]');
    assert.strictEqual(r.monitor.currentRungIndex, -1, 'precondition: the re-armed monitor is fresh at -1 (the state that used to read as "never bid")');
    assert.strictEqual(r.monitor.firedRungs.size, 0, 'precondition: remap-by-price carried no rung forward across the cost change');

    await r.engine._maybeBid(r.monitor, liveState(1));

    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0]],
      'no second bid went on the wire - 41,420 (the old defect) is absent and so is every other rung of the unreachable ladder');
    r.engine.kill(); cleanup(r.f);
    ok('case A: a re-price onto a ladder entirely above the standing bid places NOTHING (41,420 never reaches the wire)');
  }

  // ---- 2) ...and it says so, rather than going quiet. A silent hold is the failure mode that let
  // this run for 114 minutes with the desk told the correction had worked. ----
  {
    const r = await armBidAndReArm('caseA-alert', { cost: A_COST, band: A_BAND, newCost: A_NEW_COST, newBand: A_NEW_BAND });
    const alerts = [];
    r.engine.onEvent = (e) => { if (e.type === 'alert') alerts.push(e); };

    await r.engine._maybeBid(r.monitor, liveState(1));
    await r.engine._maybeBid(r.monitor, liveState(1));   // a second tick must not re-alert

    const unreachable = alerts.filter((a) => a.kind === 'reprice_unreachable_ladder');
    assert.strictEqual(unreachable.length, 1, 'exactly ONE reprice_unreachable_ladder alert across two ticks (latched, not a per-tick storm)');
    assert.strictEqual(unreachable[0].standingBidPrice, A_LADDER[0], 'the alert names the standing bid (31,610)');
    assert.strictEqual(unreachable[0].floor, A_NEW_LADDER[2], 'the alert names the new floor (38,684) - the two numbers that decide it');
    assert.ok(unreachable[0].companyName && unreachable[0].lane, 'the alert carries its scope-routing keys, so it reaches the desk group and not the unscoped fallback');
    assert.strictEqual(r.monitor.noBid && r.monitor.noBid.reason, 'new_floor_above_standing_bid',
      'the refusal is RECORDED on the monitor, so close time can tell a deliberate stand-down from a broken one');
    // ...and it is READABLE. Until it reached the snapshot the console reported a permanently held
    // load as `monitoring` - status is time-driven - and grep found no other HTTP surface carrying
    // it, so the operator had nothing to act on for a load nobody is bidding.
    const snap = r.engine.snapshot().find((m) => m.auctionId === 'LD2Z');
    assert.ok(snap, 'precondition: the held load is still in the snapshot');
    assert.strictEqual(snap.noBid && snap.noBid.reason, 'new_floor_above_standing_bid',
      'the refusal reaches the monitor snapshot the console and every other HTTP surface are built from');
    r.engine.kill(); cleanup(r.f);
    ok('case A: the refusal is alerted exactly once and recorded as new_floor_above_standing_bid');
  }

  // ---- 3) Case B - partial reachability. The fix must not degrade into "never bid after a
  // re-price": where a rung below the standing bid exists, the establish has to RE-ENTER the ladder
  // there. Rung 0 (32,400) is above the standing 31,610; rung 1 (29,700) is below it. ----
  {
    const r = await armBidAndReArm('caseB', { cost: A_COST, band: A_BAND, newCost: B_NEW_COST, newBand: B_NEW_BAND });
    assert.deepStrictEqual(r.monitor.ladder, B_NEW_LADDER, 'precondition: the re-armed ladder is [32400, 29700, 27270]');

    const decision = r.engine._decide(r.monitor, liveState(1));

    assert.ok(decision, 'a partially reachable re-price still produces a decision - the bot does not go dark');
    assert.strictEqual(decision.price, B_NEW_LADDER[1], 'it establishes at 29,700 - the first rung BELOW the standing 31,610');
    assert.strictEqual(decision.rungIndex, 1, 'and it is rung 1, not rung 0 - the ladder was re-entered below the standing bid, not at the top of it');
    assert.ok(decision.price < A_LADDER[0], 'the chosen price is strictly below the standing bid, which is the whole rule');

    await r.engine._maybeBid(r.monitor, liveState(1));
    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0], B_NEW_LADDER[1]], 'and that price is what actually went on the wire');
    r.engine.kill(); cleanup(r.f);
    ok('case B: a partially reachable re-price re-enters the ladder BELOW the standing bid (rung 1 at 29,700), never at rung 0');
  }

  // ---- 4) THE CONTROL, load 260908A2W4. A downward re-price worked before this change and has to
  // work identically after it: 130,800 standing, corrected to Rs 90,000, and the recorded sequence
  // is 98,100 accepted then 96,480 accepted. ----
  {
    const h = mkEngine('control');
    const m1 = h.engine.arm(mkLoad('A2W4'), { cost: C_COST, marginsPct: C_BAND, minMarginPct: 1.8 });
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    assert.deepStrictEqual(h.adapter.placed, [C_LADDER[0]], 'precondition: the first bid landed at 130,800');

    h.engine.stop('A2W4');
    const m2 = h.engine.arm(mkLoad('A2W4'), { cost: C_NEW_COST, marginsPct: C_BAND, minMarginPct: 1.8 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.deepStrictEqual(m2.ladder, C_NEW_LADDER, 'precondition: the re-armed ladder is [98100, 96480, 91620]');

    await h.engine._maybeBid(m2, liveState(2));          // establish on the new ladder
    await h.engine._maybeBid(m2, liveState(2));          // outranked -> step down one rung

    assert.deepStrictEqual(h.adapter.placed, [C_LADDER[0], C_NEW_LADDER[0], C_NEW_LADDER[1]],
      'the downward re-price lands 98,100 then 96,480, exactly the recorded sequence - the guard never blocks a correction that goes DOWN');
    h.engine.kill(); cleanup(h.f);
    ok('control 260908A2W4: a downward re-price still lands 98,100 then 96,480 (the guard is asymmetric, as the defect is)');
  }

  // ---- 5) The comparand itself. lastBidPrice was reset to null on every arm and never persisted,
  // so the comparison above could not even be written. It has to survive the re-arm, and it has to
  // survive a restart, which is the same hole through a different trigger. ----
  {
    const r = await armBidAndReArm('carry', { cost: A_COST, band: A_BAND, newCost: A_NEW_COST, newBand: A_NEW_BAND });
    assert.strictEqual(r.monitor.lastBidPrice, A_LADDER[0], 'lastBidPrice survives the re-arm (31,610, not null)');
    assert.strictEqual(r.engine.scheduler.get('LD2Z').landedBidPrice, A_LADDER[0],
      'and it is DURABLE on the intent, so a restart mid-auction rehydrates a monitor that knows what it has standing');
    r.engine.kill(); cleanup(r.f);
    ok('the standing price survives a re-arm on the monitor AND on the durable intent');
  }

  // ---- 6) A shadow decision must NOT create a standing price. Shadow performs zero wire writes by
  // construction, so nothing stands and nothing may constrain a later re-price. ----
  {
    const h = mkEngine('shadow');
    const m = h.engine.arm(mkLoad('SHDW'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);
    m.softStrategy = 'shadow';
    // Shadow is an allowlisted-soft strategy, so it establishes LATE - inside the establish window,
    // not 114 minutes out. Drive it there, or the monitor holds and records nothing at all.
    await h.engine._maybeBid(m, Object.assign(liveState(2), { closesInMs: 5_000 }));

    assert.deepStrictEqual(h.adapter.placed, [], 'precondition: shadow placed nothing on the wire');
    assert.strictEqual(m.lastBidPrice, A_LADDER[0], 'precondition: shadow still records the would-have-placed price for its trace');
    assert.strictEqual(h.engine.scheduler.get('SHDW').landedBidPrice, null,
      'but NOTHING is standing, so the durable standing price stays null and a later re-price is unconstrained');
    h.engine.kill(); cleanup(h.f);
    ok('a shadow decision leaves no standing price - the durable comparand counts landed bids only');
  }

  // ---- 7) The belt, for every path _decide's establish branch does not own (_lastResortFloor, the
  // rank-driven snipe, a rehydrate or a scheduled wake). A decision at or above the standing bid
  // never reaches the wire, even on the floor rung - which the min-decrement rule exempts. ----
  {
    const r = await armBidAndReArm('belt', { cost: A_COST, band: A_BAND, newCost: A_NEW_COST, newBand: A_NEW_BAND });
    const last = r.monitor.ladder.length - 1;
    r.monitor.currentRungIndex = 0;                       // past the establish branch entirely
    r.engine._decide = () => ({ price: r.monitor.ladder[last], rungIndex: last, snipe: true });

    await r.engine._maybeBid(r.monitor, liveState(2));

    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0]],
      'the floor rung at 38,684 is held too - a guaranteed refusal is not a best-effort shot, and its exemption from the decrement rule does not extend to this');
    r.engine.kill(); cleanup(r.f);
    ok('belt: a floor/snipe decision at or above the standing bid is held, on every path into _maybeBid');
  }

  // ---- 8) The re-price API refuses an unreachable band outright, with a MACHINE-READABLE reason -
  // it does not save a cost and re-arm a ladder of guaranteed refusals. Driven through the real
  // composition (PriceRequestStore + armFromRequest), not a hand-built monitor. ----
  {
    const h = mkEngine('api');
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: A_BAND, minMarginPct: 1 });
    const created = await requests.createForLoad(mkLoad('LD2Z'), { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: A_COST });
    const m1 = armFromRequest(h.engine, capt);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    assert.deepStrictEqual(h.adapter.placed, [A_LADDER[0]], 'precondition: 31,610 is standing on the portal');

    const standingBid = h.engine.standingBid('LD2Z');
    assert.deepStrictEqual(standingBid, { price: A_LADDER[0], minDecrement: 100 },
      'the engine reports what is standing, so the API judges against the real price and the per-load decrement');

    let thrown = null;
    try {
      await requests.setBidOverride(created.id,
        { marginsPct: A_NEW_BAND, minMarginPct: 1.8, cost: A_NEW_COST }, { setBy: 'pricing', standingBid });
    } catch (e) { thrown = e; }

    assert.ok(thrown, 'the re-price is REFUSED, not saved');
    assert.strictEqual(thrown.code, 'UNREACHABLE', 'the refusal carries a machine-readable code');
    assert.strictEqual(thrown.reason, 'new_floor_above_standing_bid', 'and a machine-readable reason');
    assert.strictEqual(thrown.standingBidPrice, A_LADDER[0], 'and the standing bid it was judged against');
    assert.strictEqual(thrown.floor, A_NEW_LADDER[2], 'and the floor that could not be reached');
    const after = await requests.getByToken(created.id);
    assert.strictEqual(after.price.cost, A_COST, 'the stored cost is UNCHANGED - a refused re-price writes nothing');
    h.engine.kill(); cleanup(h.f);
    ok('the re-price API refuses an unreachable band with a machine-readable reason and writes nothing');
  }

  // ---- 9) ...and accepts a reachable one, including the downward correction that is the control.
  // A gate that refuses the safe direction would be worse than the defect. ----
  {
    const h = mkEngine('api-ok');
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: C_BAND, minMarginPct: 1.8 });
    const created = await requests.createForLoad(mkLoad('A2W4'), { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: C_COST });
    const m1 = armFromRequest(h.engine, capt);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));

    const updated = await requests.setBidOverride(created.id,
      { marginsPct: C_BAND, minMarginPct: 1.8, cost: C_NEW_COST },
      { setBy: 'pricing', standingBid: h.engine.standingBid('A2W4') });

    assert.strictEqual(updated.price.cost, C_NEW_COST, 'the downward re-price to Rs 90,000 is accepted and saved');
    h.engine.kill(); cleanup(h.f);
    ok('the re-price API accepts a downward correction (the control path is untouched by the gate)');
  }

  // ---- 10) The gate's boundary. It refuses only what CANNOT land - a floor at or above the
  // standing bid - and not a floor that merely sits inside the platform's decrement, because the
  // engine still fires its reserved floor shot there and can still win the load. Pins the
  // comparator: a >= mutant fails the first row, a decrement-based one fails the second. ----
  {
    const standing = { price: 51_750, minDecrement: 100 };
    assert.doesNotThrow(() => assertLadderReachable({ floor: 51_749 }, standing),
      'one rupee below the standing bid is an improvement, so it is not refused');
    assert.doesNotThrow(() => assertLadderReachable({ floor: 51_700 }, standing),
      'and neither is a floor inside the decrement - the reserved floor shot is still the engine to spend');
    assert.throws(() => assertLadderReachable({ floor: 51_750 }, standing), /does not improve on/,
      'a floor EQUAL to the standing bid improves on nothing and is refused');
    assert.throws(() => assertLadderReachable({ floor: 51_751 }, standing), /does not improve on/,
      'and so is one above it');
    assert.doesNotThrow(() => assertLadderReachable({ floor: 999_999 }, null),
      'a load with nothing standing is unconstrained - the gate is a no-op on a first capture');
    assert.doesNotThrow(() => assertLadderReachable({ floor: 999_999 }, { price: 0, minDecrement: 100 }),
      'and on a zero/absent standing price, rather than refusing every re-price on a bad comparand');
    ok('gate boundary: a floor at or above the standing bid is refused, one below it (decrement or not) is allowed');
  }

  // ---- 11) A floor INSIDE the decrement is still the engine's to spend. It is below the standing
  // bid, so it improves on something and could win; the reserved floor shot fires it at the buzzer
  // exactly as it does on any other load. This is the case where the refusal deliberately stops
  // short of the platform's stated decrement, and it is the contrast partner to case 1. ----
  {
    // standing 31,610, decrement 100. cost 31,000 on a 1.7% floor -> floor 31,527: below the
    // standing bid, and inside the 100 rupees the platform nominally wants.
    const GAP_COST = 31_000, GAP_BAND = [3, 2, 1.7];
    const gapFloor = buildBandLadder({ cost: GAP_COST, marginsPct: GAP_BAND, minMarginPct: 1.7 }).floor;
    assert.strictEqual(gapFloor, 31_527, 'fixture: the gap-band floor is 31,527');
    assert.ok(gapFloor < A_LADDER[0] && gapFloor > A_LADDER[0] - 100,
      'fixture: below the standing 31,610, and inside its 100-rupee decrement');

    const r = await armBidAndReArm('gap', { cost: A_COST, band: A_BAND, newCost: GAP_COST, newBand: GAP_BAND });
    await r.engine._maybeBid(r.monitor, Object.assign(liveState(2), { closesInMs: 1_000 }));

    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0], gapFloor],
      'the reserved floor shot lands at the buzzer - a guard that dropped it would forfeit loads this engine wins today');
    assert.strictEqual(r.monitor.noBid, null, 'and no refusal is recorded, because none was taken');
    r.engine.kill(); cleanup(r.f);
    ok('a floor inside the decrement is still fired - the refusal stops at what cannot land, not at what might not');
  }

  // ---- 12) A decrement of ZERO must not stall the load. The platform may legitimately report 0
  // ("unknown / not enforced"), and 0 is not null so it passes straight through the fallback. If the
  // rung selector treated 0 as "equal to the standing price is fine" while the fire-point guard
  // refused it, the same rung would be re-picked and re-held on every tick for the rest of the
  // auction - a silent stall, which is worse than either bidding or standing down. ----
  {
    const r = await armBidAndReArm('zerodec', { cost: A_COST, band: A_BAND, newCost: B_NEW_COST, newBand: B_NEW_BAND });
    const zeroDec = Object.assign(liveState(2), { minDecrement: 0 });

    // The property, stated at the unit: the ceiling a new offer must clear is NEVER the standing
    // price itself, whatever the platform reports. Pins the Math.max(1, ...) clamp - drop it and
    // this returns 31,610, a price that improves on nothing.
    assert.strictEqual(maxImprovementPrice(A_LADDER[0], 0), A_LADDER[0] - 1, 'a decrement of 0 still leaves a 1-rupee improvement, never 0');
    assert.strictEqual(maxImprovementPrice(A_LADDER[0], null), A_LADDER[0] - 1, 'and so does a missing one');
    assert.strictEqual(maxImprovementPrice(A_LADDER[0], 100), A_LADDER[0] - 100, 'a real decrement is honoured as reported');
    assert.strictEqual(maxImprovementPrice(null, 100), null, 'and nothing standing means no ceiling at all');

    // ...and the rung selector and the fire-point belt read that ONE ceiling, so the selector can
    // never hand the belt a price the belt will refuse. Same threshold, same source, both directions.
    const reachAt = r.engine._reachableAt(r.monitor, r.engine._minDecrementFor(r.monitor, 0));
    assert.strictEqual(reachAt, A_LADDER[0] - 1, 'the engine computes the same ceiling from the same rule');
    const d = r.engine._decide(r.monitor, zeroDec);
    assert.ok(d && d.price <= reachAt, 'and every price it selects clears it');
    await r.engine._maybeBid(r.monitor, zeroDec);
    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0], B_NEW_LADDER[1]], 'so the selected price actually lands - the two guards never deadlock');
    r.engine.kill(); cleanup(r.f);
    ok('a zero / unknown minDecrement still leaves a one-rupee improvement, and selector and belt read that one ceiling');
  }

  // ---- 13) The belt is not silent. It covers the paths the establish branch does not own, and a
  // held shot nobody is told about is the failure this whole change exists to remove. ----
  {
    const r = await armBidAndReArm('belt-voice', { cost: A_COST, band: A_BAND, newCost: A_NEW_COST, newBand: A_NEW_BAND });
    const last = r.monitor.ladder.length - 1;
    const alerts = [];
    r.engine.onEvent = (e) => { if (e.type === 'alert') alerts.push(e); };
    r.monitor.currentRungIndex = 0;                       // past the establish branch entirely
    r.engine._decide = () => ({ price: r.monitor.ladder[last], rungIndex: last, snipe: true });

    await r.engine._maybeBid(r.monitor, liveState(2));

    assert.strictEqual(r.monitor.noBid && r.monitor.noBid.reason, 'new_floor_above_standing_bid',
      'the belt RECORDS its refusal, like every other deliberate stand-down in this engine');
    assert.strictEqual(alerts.filter((a) => a.kind === 'reprice_unreachable_ladder').length, 1,
      'and raises the same desk alert its sibling guard raises');
    r.engine.kill(); cleanup(r.f);
    ok('the belt records and alerts - a held shot is never silent');
  }

  // ---- 14) The decrement the API is judged on is the LOAD's, not the platform's static default.
  // SuperProcure's per-load Bid Difference has been seen at 1,500 against a capability default of
  // 100; reading the default understates it fifteenfold, and a monitor a restart has just rebuilt
  // has no live reading yet - which is exactly when a re-price gets judged. ----
  {
    const h = mkEngine('perload-dec');
    const m = h.engine.arm(Object.assign(mkLoad('WIDE'), { rules: { minDecrement: 1500 } }),
      { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);
    await h.engine._maybeBid(m, liveState(2));
    m.lastMinDecrement = null;                            // as a monitor rebuilt by a restart has it

    assert.deepStrictEqual(h.engine.standingBid('WIDE'), { price: A_LADDER[0], minDecrement: 1500 },
      'the load\'s own recorded Bid Difference (1,500) is reported, not the 100 capability default');

    // ...and that number is what rung SELECTION steps on, so a wide-decrement load walks past rungs
    // a 100-rupee default would have offered straight into a refusal.
    assert.strictEqual(h.engine._minDecrementFor(m, null), 1500, 'the same source feeds rung selection');
    assert.strictEqual(h.engine._reachableAt(m, h.engine._minDecrementFor(m, null)), A_LADDER[0] - 1500,
      'so the rung the establish branch prefers has to clear 1,500, not the 100 default');
    h.engine.kill(); cleanup(h.f);
    ok('standingBid reports the LOAD\'s decrement (durable rules.minDecrement), not the platform default');
  }

  // ---- 15) "Revert to standard margins" is a re-price too, and the one most likely to be
  // unreachable: the band it restores is the one the desk overrode to make the load biddable, so
  // reverting RAISES the floor. It must be refused on the same rule, not saved with a green tick. ----
  {
    const h = mkEngine('revert');
    // Inherited band is the wide one; the desk overrode it DOWN to price this load at all.
    const INHERITED = [30, 20, 10], LOWERED = [2, 1.5, 1];
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: INHERITED, minMarginPct: 10 });
    const created = await requests.createForLoad(mkLoad('RVT'), { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: A_NEW_COST });
    const lowered = await requests.setBidOverride(created.id, { marginsPct: LOWERED, minMarginPct: 1 },
      { setBy: 'pricing' });
    const m1 = armFromRequest(h.engine, lowered);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    const standing = h.engine.standingBid('RVT');
    const revertFloor = buildBandLadder({ cost: A_NEW_COST, marginsPct: INHERITED, minMarginPct: 10 }).floor;
    assert.ok(standing && standing.price < revertFloor,
      'precondition: the lowered band put a bid on the board BELOW the floor the inherited band would restore');

    let thrown = null;
    try { await requests.clearBidOverride(created.id, { standingBid: standing }); } catch (e) { thrown = e; }

    assert.ok(thrown, 'the revert is REFUSED, not saved with "Reverted to standard margins."');
    assert.strictEqual(thrown.code, 'UNREACHABLE', 'on the same machine-readable code as a band edit');
    const after = await requests.getByToken(created.id);
    assert.strictEqual(after.marginSource, 'bid', 'and the override is still in place - a refused revert writes nothing');
    h.engine.kill(); cleanup(h.f);
    ok('a revert whose restored band cannot be reached from the standing bid is refused, same as a band edit');
  }

  // ---- 15b) ...and a revert whose restored band will not BUILD is refused too, rather than saved.
  // The catch swallowed the build failure and set plan = null, and `if (plan)` then skipped the
  // reachability check entirely - so on the route this file's own comment calls "the one most likely
  // to be unreachable", the single input that disables the guard is an input the guard never sees.
  // setBidOverride reports the identical failure as BAD_INPUT, which is what makes the asymmetry a
  // gap rather than a shared design. ----
  {
    const h = mkEngine('revert-unbuildable');
    const INHERITED = [30, 20, 10], LOWERED = [2, 1.5, 1];
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: INHERITED, minMarginPct: 10 });
    const created = await requests.createForLoad(mkLoad('RVT2'), { deadlineAt: Date.now() + 60_000 });
    await requests.capture(created.id, { cost: A_NEW_COST });
    const lowered = await requests.setBidOverride(created.id, { marginsPct: LOWERED, minMarginPct: 1 }, { setBy: 'pricing' });
    const m1 = armFromRequest(h.engine, lowered);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    const standing = h.engine.standingBid('RVT2');
    assert.ok(standing, 'precondition: a bid is standing, so the gate is in force');
    // The inherited band resolves to one buildBandLadder refuses - the shape whose report was swallowed.
    requests.resolveInherited = async () => ({ marginsPct: [], minMarginPct: 10, source: 'default' });

    let thrown = null;
    try { await requests.clearBidOverride(created.id, { standingBid: standing }); } catch (e) { thrown = e; }

    assert.ok(thrown, 'the revert is refused rather than silently passing the gate it could not evaluate');
    assert.strictEqual(thrown.code, 'BAD_INPUT',
      'and it is reported the way setBidOverride reports the identical failure, not swallowed');
    const after = await requests.getByToken(created.id);
    assert.strictEqual(after.marginSource, 'bid', 'nothing is written - a refused revert leaves the override in place');
    h.engine.kill(); cleanup(h.f);
    ok('a revert whose restored band will not build is refused, not waved past the reachability check');
  }

  // ---- 16) THE DEPLOY-DAY CASE. `sh scripts/deploy.sh` restarts pm2 mid-day, so on the day this
  // ships every live auction rehydrates off an intent written by the OLD build - one that carries no
  // landedBidPrice at all. If the restore had no answer for that, the fix would be inert on exactly
  // the loads it was written for, and an upward re-price would reproduce 260908LD2Z on ship day.
  // The evidence an old intent DOES carry is the ladder it armed on and the rungs it spent. ----
  {
    const f = tmp('backcompat');
    const scheduler = new DurableScheduler(f);
    // Exactly the shape origin/main persists: no landedBidPrice key anywhere.
    scheduler.upsert({ auctionId: 'OLD1', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL',
      units: 1, companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS,
      cost: A_COST, marginsPct: A_BAND, minMarginPct: 1, ladder: A_LADDER,
      status: 'bidding', firedRungs: [0], everBid: true, landedBids: 1 });
    assert.strictEqual(scheduler.get('OLD1').landedBidPrice, undefined, 'precondition: the old intent has no landedBidPrice');

    const engine = new BidEngine(hardAdapter(), scheduler, {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
    const m = engine.arm(mkLoad('OLD1'), { cost: A_NEW_COST, marginsPct: A_NEW_BAND, minMarginPct: 1.8 });
    if (m.timer) clearTimeout(m.timer);

    assert.strictEqual(m.lastBidPrice, A_LADDER[0],
      'the standing price is recovered from the old intent\'s own ladder and fired rungs (31,610), not lost');
    assert.deepStrictEqual(engine.standingBid('OLD1'), { price: A_LADDER[0], minDecrement: 100 },
      'so the re-price API gate works on a load that was already in flight when the fix deployed');
    await engine._maybeBid(m, liveState(1));
    assert.deepStrictEqual(engine.adapter.placed, [],
      'and the upward re-price places nothing - 41,420 does not reach the wire on ship day either');
    engine.kill(); cleanup(f);
    ok('a load already in flight when this deploys still knows what it has standing (back-compat off the old intent)');
  }

  // ---- 3b) THE STRADDLE, and the exit the establish walk takes out of it. The corrected ladder can
  // sit so that the FLOOR is still below our standing bid while every rung above it is not - so the
  // ladder is not unreachable (case A) and it is not partially reachable in the ordinary way (case B).
  // The walk runs off the end, defers to the reserved floor shot, and _lastResortFloor is a no-op on
  // every tick that is not the last one. Holding the floor in reserve is CORRECT - dumping it early
  // reveals the lowest price we will accept - but the exit was a log.debug and was worded identically
  // to the ordinary "every rung is spent" exit, so the one state the desk needs to know about was
  // both silent and indistinguishable from a routine one. ----
  {
    const S_COST = 30_000, S_BAND = [10, 8, 2], S_LADDER = [33_000, 32_400, 30_600];
    assert.deepStrictEqual(buildBandLadder({ cost: S_COST, marginsPct: S_BAND, minMarginPct: 2 }).ladder,
      S_LADDER, 'fixture: the straddle band is the hand-derived ladder');
    assert.ok(S_LADDER[0] > A_LADDER[0] && S_LADDER[1] > A_LADDER[0] && S_LADDER[2] < A_LADDER[0],
      'fixture geometry: the floor straddles the standing 31,610 while every rung above it does not');

    const r = await armBidAndReArm('straddle', { cost: A_COST, band: A_BAND, newCost: S_COST, newBand: S_BAND });
    const alerts = [];
    r.engine.onEvent = (e) => { if (e.type === 'alert') alerts.push(e); };
    await r.engine._maybeBid(r.monitor, liveState(2));
    await r.engine._maybeBid(r.monitor, liveState(2));

    assert.deepStrictEqual(r.adapter.placed, [A_LADDER[0]],
      'the reserved floor is still held back on a non-final tick - this fix reports the state, it does not dump the floor early');
    assert.strictEqual(r.monitor.noBid, null,
      'and it is NOT recorded as a refusal - the floor can still be bid, so a receipt claiming nothing was biddable would be false');
    assert.deepStrictEqual(alerts.filter((a) => a.kind === 'reprice_unreachable_ladder'), [],
      'nor does it borrow the sibling guard\'s alert, whose desk copy says the new rate cannot be bid - false on a load that may still bid its floor');
    const only = r.monitor.floorOnlyBiddable;
    assert.ok(only, 'the walk carries out the fact that it stopped on unreachable rungs, not on spent ones');
    assert.strictEqual(only.standingBidPrice, A_LADDER[0], 'naming the standing bid that bounds the ladder');
    assert.strictEqual(only.floor, S_LADDER[2], 'and the one price still below it');
    const snap = r.engine.snapshot().find((m) => m.auctionId === 'LD2Z');
    assert.ok(snap && snap.floorOnlyBiddable && snap.floorOnlyBiddable.floor === S_LADDER[2],
      'and it is readable on the monitor snapshot every HTTP surface is built from, not only in a log line');
    r.engine.kill(); cleanup(r.f);
    ok('the straddle exit is distinguishable from an all-rungs-spent exit and is readable off the engine');
  }

  // ---- 3c) ...and the ordinary exit is not mislabelled as one. A ladder with no standing bid at all,
  // walked to the end because every rung above the floor is already spent, is the routine deferral to
  // the reserved shot and must carry no such record - or the flag means nothing. ----
  {
    const h = mkEngine('spent-exit');
    const m = h.engine.arm(mkLoad('SPENT'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);
    m.firedRungs.add(0); m.firedRungs.add(1);              // spent, with nothing standing (landedBids 0)
    assert.strictEqual(h.engine._mustImproveOn(m), null, 'precondition: nothing stands, so no rung is unreachable');
    await h.engine._maybeBid(m, liveState(2));
    assert.strictEqual(m.floorOnlyBiddable, null, 'an all-spent exit records nothing - the flag means unreachable, not exhausted');
    h.engine.kill(); cleanup(h.f);
    ok('the ordinary all-rungs-spent exit is not mislabelled as a standing-bid straddle');
  }

  // ---- 16b) ...and the same deploy-day recovery must not read a REFUSED rung as the standing bid.
  // firedRungs banks what was OFFERED - the rejection handler adds the rung the moment SuperProcure
  // refuses it - so a refused rung can ride to disk alongside the landed ones and be read as a price
  // no board ever held. Which of the two entries below is the refusal is not a guess: the durable
  // firedRungs is written at LANDED sites only, each writing the whole set with the rung that just
  // landed already added, and selectRung only walks DOWN the ladder. So the HIGHEST index is the
  // last landed bid and any refusal in the set sits below it. Recovered off the lowest index
  // instead, the comparand is a price the portal never accepted, the re-price gate goes permissive,
  // and the desk saves a band no rung of which can land - the silent hold this branch removes.
  // See scripts/test-standing-bid-recovery.js, which produces both refusal orders through the
  // engine itself rather than hand-writing the intent. ----
  {
    // Every rung improves on the real standing 30,450, so a correct recovery leaves the load biddable.
    const R_COST = 28_000, R_BAND = [5, 4, 2], R_LADDER = [29_400, 29_120, 28_560];
    assert.deepStrictEqual(buildBandLadder({ cost: R_COST, marginsPct: R_BAND, minMarginPct: 2 }).ladder,
      R_LADDER, 'fixture: the recovery band is the hand-derived ladder');

    const f = tmp('backcompat-refused');
    const scheduler = new DurableScheduler(f);
    // firedRungs [0,1] against landedBids 1 has exactly one history behind it: rung 0 was OFFERED at
    // 31,610 and REFUSED, then rung 1 LANDED at 30,450 and persisted the whole set. Had rung 0
    // landed and rung 1 been refused, the refusal would never have reached disk at all and the set
    // would read [0]. That gap is the only evidence the intent carries, and it is sufficient.
    scheduler.upsert({ auctionId: 'OLD2', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL',
      units: 1, companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS,
      cost: A_COST, marginsPct: A_BAND, minMarginPct: 1, ladder: A_LADDER,
      status: 'bidding', firedRungs: [0, 1], everBid: true, landedBids: 1 });

    const engine = new BidEngine(hardAdapter(), scheduler, {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
    const m = engine.arm(mkLoad('OLD2'), { cost: R_COST, marginsPct: R_BAND, minMarginPct: 2 });
    if (m.timer) clearTimeout(m.timer);

    assert.strictEqual(m.lastBidPrice, A_LADDER[1],
      'the refused 31,610 is never taken for the standing bid - the recovery reads the last LANDED rung');
    assert.deepStrictEqual(engine.standingBid('OLD2'), { price: A_LADDER[1], minDecrement: 100 },
      'so the re-price API is not handed a rupee figure the portal does not hold');
    await engine._maybeBid(m, liveState(1));
    assert.deepStrictEqual(engine.adapter.placed, [R_LADDER[0]],
      'and a genuinely biddable correction still bids - the load is not stood down for the rest of the auction');
    assert.strictEqual(m.noBid, null, 'no refusal is recorded against a ladder every rung of which can land');
    engine.kill(); cleanup(f);
    ok('the deploy-day recovery never mistakes a REFUSED rung for the standing bid');
  }

  // ---- 17) The gate must judge the floor the ENGINE will arm, not the bare band's. The
  // round-figure grid ceils the floor UP to the step, so a gate reading the raw band is permissive
  // by up to a step - it would save a re-price with a green receipt that the engine then refuses to
  // bid for the rest of the auction. ----
  {
    const h = mkEngine('grid');
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: A_BAND, minMarginPct: 1 });
    const created = await requests.createForLoad(mkLoad('GRID'), { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: A_COST });
    const m1 = armFromRequest(h.engine, capt);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    const standingBid = h.engine.standingBid('GRID');

    // A band whose bare floor clears the standing bid, but whose floor rounded UP to a 500 grid
    // does not. The gate has to refuse it, and only the engine's own floor says so.
    const GRID_COST = 30_980, GRID_BAND = [3, 2, 1.7];
    const bareFloor = buildBandLadder({ cost: GRID_COST, marginsPct: GRID_BAND, minMarginPct: 1.7 }).floor;
    const griddedFloor = Math.ceil(bareFloor / 500) * 500;
    assert.ok(bareFloor < A_LADDER[0], 'fixture: the bare band floor improves on the standing bid');
    assert.ok(griddedFloor >= A_LADDER[0], 'fixture: ...and the same floor on a 500 grid does not');

    await requests.setBidOverride(created.id, { marginsPct: GRID_BAND, minMarginPct: 1.7, cost: GRID_COST },
      { setBy: 'pricing', standingBid });
    const afterBare = await requests.getByToken(created.id);
    assert.strictEqual(afterBare.price.cost, GRID_COST, 'without an engine floor the gate judges the bare band, and lets it through');
    let thrown = null;
    try {
      await requests.setBidOverride(created.id, { marginsPct: GRID_BAND, minMarginPct: 1.7, cost: GRID_COST },
        { setBy: 'pricing', standingBid, planFloor: griddedFloor });
    } catch (e) { thrown = e; }
    assert.ok(thrown && thrown.code === 'UNREACHABLE',
      'told the floor the engine would actually arm, the gate refuses - no green receipt for a ladder that cannot bid');
    assert.strictEqual(thrown.floor, griddedFloor, 'and it reports the armed floor, not the bare one');
    h.engine.kill(); cleanup(h.f);
    ok('the gate judges the floor the engine will ARM (round-figure grid included), not the bare band floor');
  }

  // ---- 20) THE RACE. stop() retires a monitor without consulting bidInProgress, so a re-price
  // landing while placeBid is on the wire used to discard the accept whole: landedBids not counted,
  // firedRungs not persisted, landedBidPrice never written. The bid is on the board either way, so
  // every later guard was then judging the new ladder against a board it believed was empty - the
  // 260908LD2Z pattern reproduced through this branch's own new field. ----
  {
    const h = mkEngine('race');
    let release;
    const onWire = new Promise((r) => { release = r; });
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      await onWire;                                      // the write is genuinely in flight
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));            // let _maybeBid reach the await
    // The re-price, exactly as reArmWithNewBand performs it: stop, then arm the corrected band.
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: B_NEW_COST, marginsPct: B_NEW_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.strictEqual(m2.lastBidPrice, null,
      'precondition: the successor armed before the accept resolved, so it starts believing nothing stands');
    release();
    await inFlight;

    assert.deepStrictEqual(h.adapter.placed, [A_LADDER[0]], 'precondition: the bid genuinely went on the wire');
    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.landedBidPrice, A_LADDER[0], 'the durable standing price is banked, not dropped');
    assert.strictEqual(intent.landedBids, 1, 'and the landed-bid count with it');
    // The ladder-independent price is what carries; the rung INDEX deliberately does not, because
    // the re-arm has already replaced the ladder those indices refer to and rung 0 of the NEW
    // ladder is a price this bid never offered.
    assert.deepStrictEqual(intent.firedRungs, [],
      'and NO stale rung index is written onto the rebuilt ladder');
    assert.strictEqual(m2.lastBidPrice, A_LADDER[0], 'and the successor is handed the price actually on the board');
    assert.strictEqual(h.engine.standingBid('LD2Z').price, A_LADDER[0],
      'so standingBid() reports the board and the re-price gate judges against a real price');
    h.engine.kill(); cleanup(h.f);
    ok('a bid landing while a re-price retires its monitor is still banked - durable intent AND the successor');
  }

  // ---- 21) SHADOW places nothing, so it must report nothing standing. The shadow branch sets
  // lastBidPrice for its trace while performing zero wire writes, so a read of that price alone
  // reports a phantom standing bid - which refuses a legitimate desk correction on a load that has
  // never been bid, and writes new_floor_above_standing_bid onto the receipt of an empty board. ----
  {
    const h = mkEngine('shadow');
    const m = h.engine.arm(mkLoad('SHDW'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);
    // Precisely the state the shadow branch leaves behind: a would-have-placed price, and
    // deliberately no landed bid.
    m.lastBidPrice = A_LADDER[0];
    assert.strictEqual(m.landedBids, 0, 'precondition: shadow placed nothing, so nothing is on the board');
    assert.strictEqual(h.engine.standingBid('SHDW'), null,
      'standingBid() reports no standing price, so the re-price gate stays a no-op on a load never bid');
    assert.strictEqual(h.engine._mustImproveOn(m), null,
      'and the engine raises no stand-down against a price that was never offered');
    m.landedBids = 1;
    assert.strictEqual(h.engine.standingBid('SHDW').price, A_LADDER[0],
      'while a genuinely landed bid still reports - the guard reads landed evidence, not the price');
    assert.strictEqual(h.engine._mustImproveOn(m), A_LADDER[0] - 1, 'and the refusal rule returns with it');
    h.engine.kill(); cleanup(h.f);
    ok('a shadow decision reports no standing bid - only a LANDED one does');
  }

  // ---- 22) THE ACK. The gate is soft, like the shipper-ceiling gate it sits beside: refusing the
  // WRITE strands the desk holding a correction it cannot record while the monitor it was meant to
  // correct keeps bidding the superseded ladder, which is the money-losing direction. Acknowledged,
  // the corrected cost is stored and the re-arm happens - and the ENGINE then stands the load down,
  // which is the outcome the desk needed and could not reach through a 409. ----
  {
    const h = mkEngine('ack');
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: A_BAND, minMarginPct: 1 });
    const created = await requests.createForLoad(mkLoad('LD2Z'), { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: A_COST });
    const m1 = armFromRequest(h.engine, capt);
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));
    const standingBid = h.engine.standingBid('LD2Z');
    assert.strictEqual(standingBid.price, A_LADDER[0], 'precondition: 31,610 is standing on the portal');

    // Unacknowledged, the gate refuses - unchanged, and case 8 pins the refusal's shape.
    await assert.rejects(
      () => requests.setBidOverride(created.id,
        { marginsPct: A_NEW_BAND, minMarginPct: 1.8, cost: A_NEW_COST }, { setBy: 'pricing', standingBid }),
      (e) => e.code === 'UNREACHABLE', 'precondition: the first attempt is refused');

    // Passed null - which is what the three re-price routes now always pass (CW-225), and the same
    // no-op the gate already applies to a load that has never landed a bid - so the write lands.
    const updated = await requests.setBidOverride(created.id,
      { marginsPct: A_NEW_BAND, minMarginPct: 1.8, cost: A_NEW_COST }, { setBy: 'pricing', standingBid: null });
    assert.strictEqual(updated.price.cost, A_NEW_COST, 'acknowledged, the corrected cost IS recorded');

    // ...and the engine, re-armed on it, refuses to bid rather than sending refusals at the portal.
    h.engine.stop('LD2Z');
    const m2 = armFromRequest(h.engine, updated);
    if (m2.timer) clearTimeout(m2.timer);
    m2.lastBidPrice = standingBid.price;                  // what the re-price stopped; landedBids rides the intent
    assert.deepStrictEqual(m2.ladder, A_NEW_LADDER, 'the ladder is rebuilt on the corrected cost');
    const before = h.adapter.placed.length;
    await h.engine._maybeBid(m2, liveState(2));
    assert.strictEqual(h.adapter.placed.length, before,
      'and NOTHING further goes on the wire - the load is stood down, not walked into refusals');
    h.engine.kill(); cleanup(h.f);
    ok('an acknowledged unreachable re-price records the cost and stands the load down, instead of refusing the write');
  }

  // ---- 23) TWO WRITES, ONE LOAD. The retired monitor's late resolve and the successor's own bid
  // are both in flight against the same intent, and the retired one carries the HIGHER price. Last
  // writer must not win: the ladder descends, so the lowest landed price is what stands. Taking the
  // late one at face value moves the standing price back UP, and a mid-auction restart then reads a
  // comparand above the real board and re-offers over our own live bid - this branch's own defect,
  // re-entered through its repair. ----
  {
    const D_COST = 26_000, D_LADDER = [28_340, 27_300, 26_260];
    assert.deepStrictEqual(buildBandLadder({ cost: D_COST, marginsPct: A_BAND, minMarginPct: 1 }).ladder,
      D_LADDER, 'fixture: the successor band is the hand-derived ladder');

    const h = mkEngine('lww');
    let release;
    const onWire = new Promise((r) => { release = r; });
    let call = 0;
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (++call === 1) await onWire;                     // only the FIRST write parks
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: D_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    await h.engine._maybeBid(m2, liveState(2));           // the successor lands its own, LOWER bid
    assert.deepStrictEqual(h.adapter.placed, [A_LADDER[0], D_LADDER[0]],
      'precondition: 31,610 went out first and is still unresolved; the successor has landed 28,340');
    const mid = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(mid.landedBidPrice, D_LADDER[0], 'precondition: the intent holds the successor\'s 28,340');

    release();
    await inFlight;

    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.landedBidPrice, D_LADDER[0],
      'the LOWER price still stands - a late resolve never raises the durable standing price');
    assert.strictEqual(intent.landedBids, 2, 'and both bids are counted, not one overwritten by the other');
    assert.strictEqual(m2.lastBidPrice, D_LADDER[0], 'the live monitor is not dragged back up either');
    h.engine.kill(); cleanup(h.f);
    ok('a late accept never raises the standing price over a lower bid the successor already landed');
  }

  // ---- 20b) A BID THAT LANDED IS ON THE RECORD, whichever monitor it was fired by. bidLogger._onBid
  // is the only writer of closedBids.ourBids and of the daily bids stream, and it is driven by
  // bid_placed alone - so a bid banked after a retire without that emit is a real bid on the portal
  // that BRL's own History panel and day-1 log deny ever happened, un-backfillably. The reconciled
  // revision count has the same problem one field over: it reached the durable intent and not the
  // live monitor, which then keeps firing against a cap the platform has already closed. ----
  {
    const h = mkEngine('banked-record');
    const events = [];
    h.engine.onEvent = (e) => events.push(e);
    let release;
    const onWire = new Promise((r) => { release = r; });
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      await onWire;
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    h.engine.stop('LD2Z');
    // The successor's own belief is stale-HIGH: it was seeded before the in-flight write spent one.
    h.engine.scheduler.update('LD2Z', { revisionsLeft: 1 });
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: B_NEW_COST, marginsPct: B_NEW_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    m2.revisionsLeft = 3;
    release();
    await inFlight;

    const placed = events.filter((e) => e.type === 'bid_placed');
    assert.strictEqual(placed.length, 1, 'the banked bid is emitted exactly once, so bidLogger records it');
    assert.strictEqual(placed[0].price, A_LADDER[0], 'and it carries the price that really went on the board');
    assert.strictEqual(placed[0].auctionId, 'LD2Z', 'with the load it belongs to');
    assert.ok(placed[0].companyName && placed[0].lane, 'and the routing keys every bid_placed consumer reads');
    assert.strictEqual(placed[0].rungIndex, null,
      'the rung index is dropped, exactly as the durable firedRungs write drops it - the re-arm has '
      + 'already replaced the ladder those indices refer to');

    assert.strictEqual(h.engine.scheduler.get('LD2Z').revisionsLeft, 0,
      'precondition: the reconciled count reached the durable intent');
    assert.strictEqual(m2.revisionsLeft, 0,
      'and it reaches the LIVE successor too - realAdapter reports no revisionsLeft on tick, so this '
      + 'is the only route by which an overstated in-memory count is ever corrected');
    h.engine.kill(); cleanup(h.f);
    ok('a bid banked after a retire reaches the bid record, and the reconciled revision count reaches the live monitor');
  }

  // ---- 20c) THE REFUSED HALF OF THE SAME WINDOW. The retire bail was reopened to bank an ACCEPTED
  // write and left a bare `return` on a refused one, so a rejection resolving after a re-price
  // skipped the whole three-class handler: no bid_rejected record, no everBid, and - the expensive
  // one - no CAP latch. The successor then fires against a per-load budget SuperProcure has already
  // closed, which is terminal for the load. A bare return on the post-price-page path is a blocking
  // defect on its own under this repo's price-page gate. ----
  {
    const h = mkEngine('refused-after-retire');
    const events = [];
    h.engine.onEvent = (e) => events.push(e);
    let release;
    const onWire = new Promise((r) => { release = r; });
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      await onWire;
      return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded' };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: B_NEW_COST, marginsPct: B_NEW_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.ok(m2.revisionsLeft > 0, 'precondition: the successor believes it still has budget');
    release();
    await inFlight;

    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.everBid, true,
      'the attempt is durable - SuperProcure may have counted it against the per-load cap before refusing it');
    assert.strictEqual(intent.revisionsLeft, 0, 'and the exhausted cap is latched on the intent, not lost with the monitor');
    assert.strictEqual(m2.revisionsLeft, 0, 'the live successor is clamped too, so it stops firing into a closed cap');
    assert.strictEqual(m2.capExhausted, true, 'and latched, so no later state read can raise the belief back up');
    assert.strictEqual(intent.landedBids, 0, 'nothing is counted on the board - a refusal placed nothing');
    assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
      'the refusal reaches the durable bid log exactly once instead of vanishing on a bare return');
    assert.strictEqual(events.filter((e) => e.kind === 'bid_cap_exhausted').length, 1,
      'and the cap alert is raised once, as it is on the ordinary rejection path');
    h.engine.kill(); cleanup(h.f);
    ok('a write refused after a re-price retires its monitor still latches the cap and records the refusal');
  }

  // ---- 23b) THE MIRROR OF 23, and it is the ordinary money path rather than the retired one. The
  // retired monitor holds the LOW price and resolves FIRST; the successor's own dearer write resolves
  // last and used to overwrite it at face value, because lowest-wins was written into
  // _recordLandedAfterRetire only. The standing price then sits above the real board, _mustImproveOn
  // with it, and every rung between the two is offered and refused - the 260908LD2Z loop re-entered
  // through the field added to end it. ----
  {
    const D_COST = 26_000, D_LADDER = [28_340, 27_300, 26_260];
    const h = mkEngine('lww-mirror');
    let releaseLow, releaseHigh;
    const lowOnWire = new Promise((r) => { releaseLow = r; });
    const highOnWire = new Promise((r) => { releaseHigh = r; });
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      await (price === D_LADDER[0] ? lowOnWire : highOnWire);
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };
    // The CHEAP monitor fires first and parks.
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: D_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const lowInFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    // The desk re-prices UP; the successor arms believing nothing stands (the first write is still
    // unresolved), so its own belt cannot stop it firing the dearer rung.
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.strictEqual(m2.lastBidPrice, null, 'precondition: the successor starts with nothing standing');
    const highInFlight = h.engine._maybeBid(m2, liveState(2));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.adapter.placed, [D_LADDER[0], A_LADDER[0]],
      'precondition: 28,340 and 31,610 are both on the wire, cheap one first');

    releaseLow(); await lowInFlight;
    assert.strictEqual(h.engine.scheduler.get('LD2Z').landedBidPrice, D_LADDER[0],
      'precondition: the retired monitor banked the 28,340 that is really on the board');
    releaseHigh(); await highInFlight;                     // the ORDINARY accepted path resolves last

    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.landedBidPrice, D_LADDER[0],
      'the durable standing price is still 28,340 - the ordinary accepted path never raises it either');
    assert.strictEqual(m2.lastBidPrice, D_LADDER[0], 'and neither is the live monitor dragged back up');
    assert.strictEqual(h.engine._mustImproveOn(m2), D_LADDER[0] - 1,
      'so the belt judges against the real board, not against a price the portal has already beaten');
    h.engine.kill(); cleanup(h.f);
    ok('lowest-wins holds on EVERY writer of the standing price, not only the retired-monitor one');
  }

  // ---- 23c) The transport-throw writer takes the same two rules. It persists after a retire exactly
  // as the accepted path does, but had neither the finalized/killed guard nor lowest-wins - so a
  // throw whose read-back could not disprove a commit raised the durable standing price over a lower
  // bid the successor had already landed, and dropped the successor's own count with it. ----
  {
    const D_COST = 26_000, D_LADDER = [28_340, 27_300, 26_260];
    const h = mkEngine('throw-after-retire');
    // SP's real read-back shape: no authoritative revision count, so the handler cannot disprove the
    // commit and must treat the write as ON THE BOARD.
    h.adapter.getAuctionState = async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3,
      standingL1Price: null, closesInMs: REMAINING_MS, revisionsLeft: null, closeModel: 'hard',
      measuredRttMs: 50, minDecrement: 100 });
    let releaseThrow;
    const onWire = new Promise((r) => { releaseThrow = r; });
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (price === A_LADDER[0]) { await onWire; const e = new Error('socket hang up'); e.code = 'NETWORK'; throw e; }
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = h.engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: D_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    await h.engine._maybeBid(m2, liveState(2));            // the successor lands its lower bid cleanly
    assert.strictEqual(h.engine.scheduler.get('LD2Z').landedBidPrice, D_LADDER[0],
      'precondition: the successor has 28,340 on the board and banked');
    releaseThrow();
    await inFlight;

    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.landedBidPrice, D_LADDER[0],
      'the uncertain write is counted on the board WITHOUT raising the standing price above it');
    assert.strictEqual(intent.landedBids, 2,
      'and it composes against the intent instead of overwriting the successor\'s own count');
    assert.strictEqual(m2.lastBidPrice, D_LADDER[0], 'the live successor keeps the price the portal really holds');
    h.engine.kill(); cleanup(h.f);
    ok('a transport throw resolving after a retire banks the write without raising the standing price');
  }

  // ---- 24) THE SUCCESSOR STARTS STALE-HIGH, not null. arm() seeds lastBidPrice off the intent as
  // it stood BEFORE the in-flight write, so on a load that has already landed a bid the rebuilt
  // monitor carries the OLD, higher price. A belt reading that lets through rungs the portal will
  // refuse, and standingBid() hands the same stale number to the re-price gate. ----
  {
    const h = mkEngine('stale-successor');
    let release;
    const onWire = new Promise((r) => { release = r; });
    let call = 0;
    h.adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (++call === 2) await onWire;                     // the SECOND write parks
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    };
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, liveState(2));           // first bid lands and is recorded
    assert.strictEqual(h.engine.scheduler.get('LD2Z').landedBidPrice, A_LADDER[0], 'precondition: 31,610 is durable');
    const inFlight = h.engine._maybeBid(m1, liveState(2)); // second bid parks on the wire
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.adapter.placed, [A_LADDER[0], A_LADDER[1]],
      'precondition: 30,450 is on the wire and unresolved');

    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.strictEqual(m2.lastBidPrice, A_LADDER[0],
      'precondition: the successor inherits the STALE 31,610 - the "it would be null" premise is false here');

    release();
    await inFlight;

    assert.strictEqual(m2.lastBidPrice, A_LADDER[1],
      'the successor is corrected DOWN to the price actually on the board');
    assert.strictEqual(h.engine._mustImproveOn(m2), A_LADDER[1] - 1,
      'so the belt judges against 30,450 and stops passing rungs the portal would refuse');
    assert.strictEqual(h.engine.scheduler.get('LD2Z').landedBidPrice, A_LADDER[1], 'and the intent agrees');
    h.engine.kill(); cleanup(h.f);
    ok('a successor that inherited a stale-high price is corrected by the landing it did not see');
  }

  // ---- 25) UNKNOWN REVISIONS IS NOT ZERO REVISIONS. SuperProcure's real adapter reports
  // revisionLimit null, so an intent written before the per-load cap is surfaced carries
  // revisionsLeft null. Reconciling the retired monitor's count against that intent must not read
  // the null as "none left": Number(null) is 0 and is finite, so a finiteness-only guard clamps the
  // durable value to 0, and the NEXT arm - another re-price, or the pm2 restart deploy.sh performs -
  // stands the load down for the rest of the auction behind a green receipt. ----
  {
    const f = tmp('nullrev');
    const adapter = hardAdapter();
    // The SP shape: no static revision cap is known at arm time.
    adapter.capabilities = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'hard' });
    const engine = new BidEngine(adapter, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
    let release;
    const onWire = new Promise((r) => { release = r; });
    let call = 0;
    // Never reports a remaining count, exactly as SP's createV2 response does not.
    adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (++call === 2) await onWire;
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };
    const m1 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    assert.strictEqual(m1.revisionsLeft, null, 'precondition: no static revision cap is known at arm time');
    await engine._maybeBid(m1, liveState(2));              // first bid lands and persists the null
    assert.strictEqual(engine.scheduler.get('LD2Z').revisionsLeft, null,
      'precondition: the intent now carries an EXPLICIT null - "unknown", not "none left"');
    // The socket later surfaces the per-load cap on the live monitor, while the intent still holds
    // the null above. That mismatch is what the reconciliation below has to resolve.
    m1.revisionsLeft = 30;

    const inFlight = engine._maybeBid(m1, liveState(2));   // second bid parks on the wire
    await new Promise((r) => setImmediate(r));
    engine.stop('LD2Z');
    const m2 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    release();
    await inFlight;

    const intent = engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.revisionsLeft, 29,
      'the spend is recorded against the number the monitor actually knew (30 -> 29), not against the null');
    assert.notStrictEqual(intent.revisionsLeft, 0,
      'an UNKNOWN prior count is never read as zero - a 0 here stands the load down for the rest of '
      + 'the auction (bidEngine refuses on revisionsLeft <= 0) behind a green receipt');
    engine.kill(); cleanup(f);
    ok('an intent whose revision count is unknown is not clamped to zero by a late landed-bid write');
  }

  // ---- 26) THE RECONCILIATION RUNS IN BOTH DIRECTIONS. Check 25 pins only what it must NOT do
  // (read an unknown prior as zero); nothing pinned what it must DO, so deleting the Math.min
  // reconciliation outright left this file green. Both halves are asserted here: a KNOWN prior
  // beats a stale-high monitor belief, and a known prior survives an UNKNOWN current. ----
  {
    // (a) known-lower prior vs stale-high monitor. The monitor's count is frozen at the moment it
    // fired and a successor has spent since, so the monitor's own arithmetic overstates what is left.
    const f = tmp('rev-lower-prior');
    const adapter = hardAdapter();
    adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (this.placed.length === 2) await this.parked;      // the SECOND write parks on the wire
      return { accepted: true, myRank: 1, latencyMs: 30 };  // no authoritative count, as SP sends none
    };
    let release;
    adapter.parked = new Promise((r) => { release = r; });
    const engine = new BidEngine(adapter, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
    const m1 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    await engine._maybeBid(m1, liveState(2));               // first bid lands: 3 -> 2, persisted
    assert.strictEqual(engine.scheduler.get('LD2Z').revisionsLeft, 2,
      'precondition: the intent holds a KNOWN 2 remaining');
    m1.revisionsLeft = 30;                                  // the monitor's belief drifts high
    const inFlight = engine._maybeBid(m1, liveState(2));
    await new Promise((r) => setImmediate(r));
    engine.stop('LD2Z');
    const m2 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    release();
    await inFlight;

    const intent = engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.landedBids, 2, 'precondition: two bids genuinely landed against a cap of 3');
    assert.strictEqual(intent.revisionsLeft, 1,
      'the KNOWN prior 2 wins over the retired monitor\'s stale 30, and THIS write\'s own spend is '
      + 'charged against it - two landed bids from a cap of 3 leave 1, not 2');
    assert.notStrictEqual(intent.revisionsLeft, 29,
      'the monitor\'s own 30 -> 29 arithmetic never overwrites a count the intent already knows to be lower');
    assert.ok(intent.revisionsLeft < 2,
      'a write that landed always leaves strictly fewer revisions than the belief it reconciled against - '
      + 'taking the minimum instead of composing discards this write\'s spend and fires one past the real cap');
    engine.kill(); cleanup(f);
    ok('a known prior revision count is not raised by a retired monitor\'s stale-high belief, and this write\'s own spend is charged');
  }
  {
    // (b) known DURABLE 0 vs a null-carrying retired monitor. This is the ordinary SuperProcure
    // shape - the retired monitor holds null because SP publishes no cap at arm time - so gating the
    // reconciliation on a non-null current wrote that null over the terminal exhausted-cap state and
    // the engine went back to firing writes the portal was already refusing on the shared live account.
    const f = tmp('rev-zero-survives');
    const adapter = hardAdapter();
    adapter.capabilities = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'hard' });
    adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (this.placed.length === 2) await this.parked;
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };
    let release;
    adapter.parked = new Promise((r) => { release = r; });
    const engine = new BidEngine(adapter, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
    const m1 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    assert.strictEqual(m1.revisionsLeft, null, 'precondition: SP publishes no cap at arm time');
    await engine._maybeBid(m1, liveState(2));
    const inFlight = engine._maybeBid(m1, liveState(2));    // second bid parks on the wire
    await new Promise((r) => setImmediate(r));
    engine.stop('LD2Z');
    const m2 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    // The successor hits SP's per-load cap - verbatim what the cap-exhaustion writer persists.
    m2.revisionsLeft = 0;
    m2.capExhausted = true;
    engine.scheduler.update('LD2Z', { revisionsLeft: 0 });
    release();
    await inFlight;

    assert.strictEqual(engine.scheduler.get('LD2Z').revisionsLeft, 0,
      'the exhausted cap survives the late resolve - a null "unknown" never erases a known 0');
    engine.stop('LD2Z');
    const m3 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m3.timer) clearTimeout(m3.timer);
    assert.strictEqual(m3.revisionsLeft, 0,
      'so the next arm still knows the cap is spent and stands the load down instead of firing refused writes');
    engine.kill(); cleanup(f);
    ok('a durable exhausted revision cap is not erased by a retired monitor carrying null');
  }

  // Completion sentinel: a file that exits early, or loses checks in an edit, must fail loudly
  // rather than report a smaller green run.
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
