'use strict';
/**
 * Pins the fresh-monitor FLOOR branch in bidEngine.js _decide (the reprice-deadline-guard work).
 *
 * When a monitor is armed with currentRungIndex still -1 (a genuinely late FIRST cost, or a
 * re-price that rebuilt the monitor via stop + arm) AND remaining time is already inside the
 * last-chance floor window on an effectively-hard load, _decide must send it STRAIGHT to the
 * floor rung (ladder[last], the price that wins) - NOT establish at the opening rung and hope to
 * walk down. On a late re-price the establish-first path would leave us bidding our HIGHEST price
 * at the buzzer (the exact footgun this branch exists to kill). The guard is gated on
 * _effectivelyHard: a soft (anti-snipe) load still holding extensions must NOT dump its reserved
 * floor early (L3) - it establishes instead.
 *
 * These tests are hostile to that branch: they assert the EXACT floor price (hand-derived from the
 * band, independent of the engine's own ladder builder), that it is never the opening rung, that a
 * bid always lands (never a silent zero-bid on a live auction), and that the soft-still-extending
 * guard suppresses the floor while an exhausted-extension soft load releases it.
 *
 *   node scripts/test-late-reprice-floor.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const tmp = (n) => path.join(os.tmpdir(), `late-reprice-floor-${n}-${process.pid}.json`);
const cleanup = (f) => { try { fs.unlinkSync(f); } catch (_) {} };

// --- Hand-derived expected ladder values (worked by hand from buildBandLadder's spec, NOT read
// back from the engine, so an assertion catches _decide picking the wrong rung independently of
// the ladder builder). buildBandLadder: floor = round(cost*(1+minMargin%/100)), opening =
// round(cost*(1+maxMargin%/100)). ------------------------------------------------------------
// cost 50000, margins [12.6, 7.2, 6.3] -> floor round(50000*1.063)=53150 ; opening round(50000*1.126)=56300
const A_COST = 50_000, A_MARGINS = [12.6, 7.2, 6.3];
const A_FLOOR = 53_150, A_OPENING = 56_300;
// re-price NEW band: cost 60000, margins [10, 8, 6.3], minMargin 6.3
//   -> floor round(60000*1.063)=63780 ; opening round(60000*1.10)=66000
const NEW_COST = 60_000, NEW_MARGINS = [10, 8, 6.3], NEW_MIN = 6.3;
const NEW_FLOOR = 63_780, NEW_OPENING = 66_000;
// re-price OLD band: cost 45000, margins [12,10,8,7,6.3] -> ladder [50400,49500,48600,48150,47835].
// None of those prices survive the cost change to 60000, so the fired-rung remap-by-price drops
// them ALL - the re-armed monitor is genuinely fresh at -1 with empty firedRungs.
const OLD_COST = 45_000, OLD_MARGINS = [12, 10, 8, 7, 6.3];

// A rank-only, hard-close adapter that records the plain prices it was asked to place. No network.
function hardAdapter() {
  return {
    writeEnabled: true,
    placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    // benign default so any stray auto-tick (rank 1, far from close) places nothing
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 1, totalBidders: 3, standingL1Price: null,
      closesInMs: 60_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) {
      if (!this.writeEnabled) throw new Error('write disabled');
      this.placed.push(price);
      return { accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 30 };
    },
  };
}

// Hard-close snipe-window state: outranked (rank 2), remaining inside the floor window.
const hardSnipe = (remaining) => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: remaining, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });

// Load fixture for the re-price composition: live now, closes in 8s (real timing the engine needs).
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Durian Industries', closesAt: Date.now() + 8_000, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

// Drive the REAL re-price composition WITH a cost change: arm on the OLD band, mark rungs 0/1/2
// fired (as the live accept-path persists), re-price to a DIFFERENT-cost NEW band via
// setBidOverride + stop + armFromRequest, and hand back the fresh re-armed monitor.
async function armAndRepriceCostChange() {
  const f = tmp('reprice-cost');
  const adapter = hardAdapter();
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: OLD_MARGINS, minMarginPct: 6.3 });

  const created = await requests.createForLoad(mkLoad('RPX'), { deadlineAt: Date.now() + 60_000 });
  const capt = await requests.capture(created.id, { cost: OLD_COST });
  const m1 = armFromRequest(engine, capt);
  if (m1 && m1.timer) clearTimeout(m1.timer);            // isolate: no auto-ticks
  engine.scheduler.update('RPX', { status: 'bidding', firedRungs: [0, 1, 2] });

  const updated = await requests.setBidOverride(created.id,
    { marginsPct: NEW_MARGINS, minMarginPct: NEW_MIN, cost: NEW_COST }, { setBy: 'operator' });
  engine.stop('RPX');
  const m2 = armFromRequest(engine, updated);
  if (m2 && m2.timer) clearTimeout(m2.timer);
  return { engine, adapter, monitor: m2, f };
}

// A plain hand-built monitor for driving _decide directly (soft-close cases the public arm() path
// makes awkward to reach - softStrategy resolution needs live config + the extendCap must come off
// a live state read). _decide reads only these fields on the fresh-monitor path.
const softMonitor = (over) => Object.assign({
  auctionId: 'SOFT', meta: { lane: { origin: 'A', destination: 'B' }, companyName: 'Anti-Snipe Shipper' },
  ladder: [A_OPENING, 53_600, A_FLOOR], floor: A_FLOOR,
  ceiling: null, ceilingBelowFloor: false,
  currentRungIndex: -1, firedRungs: new Set(),
  closeModel: 'soft', softStrategy: 'live', extendCap: 2, extendsObserved: 0,
}, over || {});
const decideState = (remaining, rank = 2) => ({ closesInMs: remaining, standingL1Price: null, myRank: rank,
  minDecrement: 100, measuredRttMs: 50 });

(async () => {
  // Sanity: the hand-derived expected numbers really are what buildBandLadder produces. If this
  // ever drifts, every downstream assertion's expected value is suspect - fail loud here first.
  {
    const a = buildBandLadder({ cost: A_COST, marginsPct: A_MARGINS });
    assert.strictEqual(a.ladder[a.ladder.length - 1], A_FLOOR, 'band A floor is the hand-derived 53150');
    assert.strictEqual(a.ladder[0], A_OPENING, 'band A opening is the hand-derived 56300');
    const n = buildBandLadder({ cost: NEW_COST, marginsPct: NEW_MARGINS, minMarginPct: NEW_MIN });
    assert.strictEqual(n.ladder[n.ladder.length - 1], NEW_FLOOR, 'new band floor is the hand-derived 63780');
    assert.strictEqual(n.ladder[0], NEW_OPENING, 'new band opening is the hand-derived 66000');
    ok('fixture sanity: hand-derived floor/opening prices match buildBandLadder');
  }

  // ---- 1) late_first_arm_fires_floor (+ never_zero_bids). A fresh hard-close monitor armed with
  // remaining (1500) already inside floorWindowMs (default 2500): _decide's currentRungIndex<0
  // branch must go STRAIGHT to the floor. Exactly one bid, and it is the floor - never the opening,
  // never zero. ----
  {
    // Arrange
    const f = tmp('late-arm');
    const adapter = hardAdapter();
    const engine = new BidEngine(adapter, new DurableScheduler(f)); // default cfg: floorWindowMs 2500
    const monitor = engine.arm(
      { id: 'LA1', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt: Date.now() + 1_500 },
      { cost: A_COST, marginsPct: A_MARGINS });
    if (monitor.timer) clearTimeout(monitor.timer); // isolate from the delay-0 auto-tick

    // Act
    await engine._maybeBid(monitor, hardSnipe(1_500)); // remaining 1500 < floorWindowMs 2500

    // Assert
    assert.strictEqual(adapter.placed.length, 1, 'exactly ONE bid lands (never zero on a live armed auction, never a double-fire)');
    assert.strictEqual(adapter.placed[0], A_FLOOR, 'the one bid is the FLOOR (53150, the price that wins), not the opening rung');
    assert.notStrictEqual(adapter.placed[0], A_OPENING, 'the bid is NOT the opening rung (56300) - late arm must not establish-then-hope');
    assert.ok(adapter.placed.every((p) => p >= A_FLOOR), 'no bid below the operating floor');
    engine.kill(); cleanup(f);
    ok('late first arm inside the floor window fires the FLOOR directly (one decisive shot, never opening, never zero)');
  }

  // ---- 2) cost_change_reprice: the re-price rebuilds a genuinely FRESH monitor at -1 with empty
  // firedRungs (a cost change makes every old rung price unmatchable, so remap-by-price drops all).
  // This is the precondition the floor branch depends on. ----
  {
    // Arrange + Act (the whole re-price composition is the act under test)
    const r = await armAndRepriceCostChange();

    // Assert
    assert.strictEqual(r.monitor.currentRungIndex, -1, 'a cost-change re-price leaves the re-armed monitor at currentRungIndex -1 (fresh)');
    assert.strictEqual(r.monitor.firedRungs.size, 0, 'every OLD-ladder fired rung dropped on the cost change (remap-by-price found no match) - firedRungs empty');
    assert.strictEqual(r.monitor.ladder[r.monitor.ladder.length - 1], NEW_FLOOR, 'the re-armed ladder is the NEW band (floor 63780)');
    r.engine.kill(); cleanup(r.f);
    ok('cost-change re-price rebuilds a fresh monitor at -1 with empty firedRungs (new floor not stale-gated)');
  }

  // ---- 3) cost_change_reprice_in_final_window_fires_new_floor (+ floor_safety_invariant). Drive
  // _maybeBid on that fresh re-armed monitor inside the snipe window (remaining 1000, rank 2): the
  // placed bid must be the NEW ladder's floor, NEVER the NEW ladder's opening rung. ----
  {
    // Arrange
    const r = await armAndRepriceCostChange();

    // Act
    await r.engine._maybeBid(r.monitor, hardSnipe(1_000)); // inside floorWindowMs

    // Assert
    assert.strictEqual(r.adapter.placed.length, 1, 'exactly ONE bid lands after the re-price (bot must not go dark, must not double-fire)');
    assert.strictEqual(r.adapter.placed[0], NEW_FLOOR, 'the placed bid is the NEW ladder floor (63780), the price that wins');
    assert.notStrictEqual(r.adapter.placed[0], NEW_OPENING, 'the bid is NEVER the NEW ladder opening rung (66000) - the late-re-price footgun this branch kills');
    assert.ok(r.adapter.placed.every((p) => p >= NEW_FLOOR), 'floor-safety invariant: every placed price >= the NEW operating floor (assertAboveFloor never breached)');
    r.engine.kill(); cleanup(r.f);
    ok('cost-change re-price in the final window fires the NEW floor, never the NEW opening (floor-safety held)');
  }

  // ---- 4) soft_still_extending_does_NOT_dump_floor. A fresh soft-close monitor (softStrategy on,
  // extensions NOT exhausted -> _effectivelyHard false) INSIDE the last-chance window must NOT fire
  // the floor - it establishes at rung 0 instead (the L3 anti-snipe guard). Driven through _decide
  // directly with a hand-built monitor (the public arm() soft path needs live config + a live
  // extendCap read). ----
  {
    // Arrange
    const engine = new BidEngine(hardAdapter(), new DurableScheduler(tmp('soft-hold'))); // default floorWindowMs 2500
    const m = softMonitor({ extendCap: 2, extendsObserved: 0 }); // not exhausted -> _effectivelyHard false

    // Act
    const decision = engine._decide(m, decideState(1_000)); // remaining 1000 < floorWindowMs 2500 (last-chance)

    // Assert
    assert.ok(decision, 'a fresh soft monitor still returns a decision (establish), not null');
    assert.strictEqual(decision.rungIndex, 0, 'soft load still holding extensions establishes at rung 0, does NOT snipe the floor (rungIndex would be 2 if the guard were dropped)');
    assert.strictEqual(decision.price, A_OPENING, 'the establish price is the opening rung (56300), never the floor (53150)');
    cleanup(tmp('soft-hold'));
    ok('soft still extending: fresh monitor in the last-chance window establishes at rung 0, does NOT dump the floor');
  }

  // ---- 5) soft_extensions_exhausted_releases_the_floor. The SAME soft monitor once extensions are
  // exhausted (_effectivelyHard true) must fire the floor - proving the guard keys on
  // extensions-remaining, not on soft-ness per se (the reserved sniper releases into the genuinely
  // final window). This is the contrast partner to test 4. ----
  {
    // Arrange
    const engine = new BidEngine(hardAdapter(), new DurableScheduler(tmp('soft-release')));
    const m = softMonitor({ extendCap: 2, extendsObserved: 2 }); // exhausted -> _effectivelyHard true

    // Act
    const decision = engine._decide(m, decideState(1_000));

    // Assert
    assert.ok(decision, 'an exhausted-extension soft monitor returns a decision');
    assert.strictEqual(decision.rungIndex, m.ladder.length - 1, 'exhausted soft load fires the FLOOR rung (index 2), not establish - the reserved sniper released');
    assert.strictEqual(decision.price, A_FLOOR, 'the fired price is the floor (53150), the winning price');
    cleanup(tmp('soft-release'));
    ok('soft extensions exhausted: fresh monitor releases the reserved floor (guard keys on extensions, not soft-ness)');
  }

  // ---- 6) effectivelyHard boundary. The guard the whole branch hinges on. Pins the >= comparator
  // (at-cap must be hard; one-below-cap must NOT be) plus the fail-closed rows (hard / soft-off /
  // unknown-cap are all effectively hard). ----
  {
    // Arrange
    const engine = new BidEngine(hardAdapter(), new DurableScheduler(tmp('effhard')));

    // Act + Assert (pure predicate; each row is its own labelled assertion)
    assert.strictEqual(engine._effectivelyHard({ closeModel: 'hard' }), true, 'a hard-close load is effectively hard (branch reachable)');
    assert.strictEqual(engine._effectivelyHard({ closeModel: 'soft', softStrategy: 'off' }), true, 'a soft-OFF load fails closed to hard');
    assert.strictEqual(engine._effectivelyHard({ closeModel: 'soft', softStrategy: 'live', extendCap: null, extendsObserved: 0 }), true, 'a soft load with UNKNOWN extend cap fails closed to hard');
    assert.strictEqual(engine._effectivelyHard({ closeModel: 'soft', softStrategy: 'live', extendCap: 2, extendsObserved: 1 }), false, 'soft with extensions REMAINING (1 of cap 2) is NOT yet hard');
    assert.strictEqual(engine._effectivelyHard({ closeModel: 'soft', softStrategy: 'live', extendCap: 2, extendsObserved: 2 }), true, 'soft AT the cap (2 of 2) IS hard - pins the >= boundary (a > mutant would return false here)');
    cleanup(tmp('effhard'));
    ok('_effectivelyHard boundary: at-cap is hard, one-below-cap is not (>= comparator + fail-closed rows pinned)');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
