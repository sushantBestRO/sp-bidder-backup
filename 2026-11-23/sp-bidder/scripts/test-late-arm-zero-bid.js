'use strict';
/**
 * Pins the "never bid, never alerted" fix (bidEngine.js _isLastChance / _finalize's landed-bid
 * split).
 *
 * Root cause: on a HARD-close, RANK-ONLY auction, _decide()'s currentRungIndex<0 branch ALWAYS
 * returns either the establish decision or null - it never falls through to the step-3
 * final-snipe branch (which ignores the RTT-compensated latency guard) in the same call. So if
 * an auction is armed so late that the establish decision never clears that latency guard,
 * currentRungIndex never leaves -1, the floor-rung branch is structurally unreachable, and the
 * engine places ZERO bids on a real, armed auction - silently, since the old lost_after_bidding
 * alert only fired when currentRungIndex >= 0. Confirmed as a real, previously-observed failure
 * signature (different root cause, same "zero bids, alerts: none" shape) in
 * docs/diagnoses/2026-07-13_zero-bid-silent-miss-and-placeholder-cleanup.md (Class B).
 *
 * NOT included: a dedicated "min-decrement decoupling" test. _decide's own branch order makes
 * it structurally impossible to reach a non-floor, non-null-lastBidPrice decision while
 * _isLastChance is true - once currentRungIndex>=0, the remaining<=floorWindowMs branch always
 * short-circuits to the floor rung (or null), never a mid-ladder step; the one case that
 * legitimately combines isLastChance=true with isFloorRung=false (the emergency establish shot)
 * always has monitor.lastBidPrice still null, so the min-decrement guard's own condition
 * (`monitor.lastBidPrice != null`) is moot for it. A synthetic test driving _maybeBid directly
 * (bypassing _decide) would test code that can never run for real - the guarantee this file
 * relies on instead is that isFloorRung and the new lastChance flag are kept as separate
 * booleans in bidEngine.js (see the code comment at the min-decrement check).
 *
 *   node scripts/test-late-arm-zero-bid.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
// A per-run directory, not a pid-named file in the shared tmpdir: Windows reuses pids, and the
// normal section's intent file survives the run, so a later same-pid run rehydrates its fired rungs.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'late-arm-'));
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const tmp = (n) => path.join(TMP_DIR, `${n}.json`);
const cleanup = (f) => { try { fs.unlinkSync(f); } catch (_) {} };

// Rank-only, hard-close, never-win adapter with a CONFIGURABLE measured RTT - the knob that
// determines whether the old latency guard would have blocked the establish decision forever.
function lateArmAdapter(closesAt, measuredRttMs, { rank = 2 } = {}) {
  let revs = 3;
  return {
    placed: [], // { price, at }
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return {
        ok: true, status: Date.now() >= closesAt ? 'closed' : 'live',
        myRank: rank, totalBidders: 3, standingL1Price: null,
        closesInMs: Math.max(0, closesAt - Date.now()),
        revisionsLeft: revs, closeModel: 'hard', measuredRttMs,
      };
    },
    async placeBid(id, price) {
      this.placed.push({ price, at: Date.now() });
      revs = Math.max(0, revs - 1);
      return { accepted: true, myRank: rank, revisionsLeft: revs, latencyMs: measuredRttMs };
    },
  };
}

// Reports closed on the very FIRST read - deterministic stand-in for "no time even clears the
// floor attempt" without relying on a real sub-tick race.
function alreadyClosedAdapter() {
  return {
    placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: 'closed', myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: 0, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid() { throw new Error('placeBid must never be called - the auction is already closed'); },
  };
}

// Price-visible adapter: a handful of successful undercut bids land (lastBidPrice gets set,
// currentRungIndex stays -1 by construction - rungIndex is always null on this path), then the
// rival goes below our floor and we stand down for the rest of the auction.
//
// This case is WHY _finalize's alarm keys off LANDED evidence rather than ladder bookkeeping. The
// condition used to be `currentRungIndex >= 0 || lastBidPrice != null` and this adapter exercised
// the second half; it is now landed-only (landedBids/lastBidPrice), so this scenario is the whole
// test rather than half of it. The currentRungIndex half was dropped because it counted REJECTED
// attempts as bids - see scripts/test-no-bid-outcome.js, which pins the all-rejected close that
// silently mis-reported as LOST (load 23484018, 2026-07-25). Assertions below are unchanged.
function priceVisibleThenFloorAdapter(closesAt, floorBreachAfter) {
  let standing = 54_000, calls = 0;
  return {
    placed: [],
    capabilities: () => ({ standingPriceVisible: true, minDecrement: 500, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      calls += 1;
      if (calls > floorBreachAfter) standing = 39_000; // now below floor(40000)+minDecrement -> undercut() returns null
      else standing -= 300;
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 4,
        standingL1Price: standing, closesInMs: Math.max(0, closesAt - Date.now()),
        revisionsLeft: null, closeModel: 'hard', measuredRttMs: 30 };
    },
    async placeBid(id, price) {
      this.placed.push({ price, at: Date.now() });
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

function alertKinds(events) {
  return events.filter((e) => e.type === 'alert').map((e) => e.kind);
}

(async () => {
  // ---- 1) Reproducer A: armed at T-1.5s with elevated RTT -> pre-fix, the latency guard
  // (oneway=1500ms + minLeadMs=400ms = 1900ms) would have blocked the establish decision from
  // the very first tick, forever (remaining only decreases), leaving ZERO bids. The fix guarantees a
  // bid; and a fresh monitor already INSIDE the final snipe window (_isLastChance) now goes straight
  // to the FLOOR - the price that wins - instead of wasting its one shot on the opening rung. There
  // is no time to establish-then-walk this late, and on a re-price the establish-first path would
  // leave us at our HIGHEST price at the buzzer (the late-re-price footgun). One decisive shot. ----
  {
    const f = tmp('repro-a');
    const closesAt = Date.now() + 1500;
    const adapter = lateArmAdapter(closesAt, 3000); // oneway=1500, +400 minLead = 1900 > 1500 remaining
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    const band = buildBandLadder({ cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }).ladder; // [56300, 53600, 53150]

    const monitor = engine.arm(
      { id: 'A1', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 2200));

    assert.strictEqual(adapter.placed.length, 1, 'a late arm inside the final window fires exactly ONE bid (the floor), not establish-then-floor');
    assert.strictEqual(adapter.placed[0].price, band[band.length - 1], 'that one bid is the FLOOR (the price that wins), never the opening rung');
    assert.ok(adapter.placed.every((b) => b.price >= band[band.length - 1]), 'no bid below the floor');
    assert.ok(monitor.currentRungIndex >= 0, 'currentRungIndex left -1 (the floor bid landed)');
    assert.ok(!alertKinds(events).includes('never_bid_before_close'), 'a bid landed, so never_bid_before_close did not fire');
    cleanup(f);
    ok('Reproducer A: late arm inside the final window fires the FLOOR directly (one decisive shot, never the opening price, never zero)');
  }

  // ---- 2) Reproducer B: closed on the very first read -> _tick routes straight to hardClosed
  // before _maybeBid ever runs. currentRungIndex stays -1 AND lastBidPrice stays null, so
  // _finalize must emit never_bid_before_close, not lost_after_bidding. ----
  {
    const f = tmp('repro-b');
    const adapter = alreadyClosedAdapter();
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    const monitor = engine.arm(
      { id: 'B1', lane: { origin: 'X', destination: 'Y' }, equipment: '32ft', units: 1, closesAt: Date.now() + 500 },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 400));

    assert.strictEqual(adapter.placed.length, 0, 'placeBid never called');
    assert.strictEqual(monitor.currentRungIndex, -1, 'currentRungIndex never left -1');
    const kinds = alertKinds(events);
    assert.ok(kinds.includes('never_bid_before_close'), 'never_bid_before_close alert fired');
    assert.ok(!kinds.includes('lost_after_bidding'), 'lost_after_bidding did NOT fire (we never bid)');
    cleanup(f);
    ok('Reproducer B: already-closed-on-first-read -> never_bid_before_close, not lost_after_bidding');
  }

  // ---- 3) Normal-arm regression guard: comfortably far out + LOW/realistic RTT. The fix is
  // additive-only, so this must escalate through the exact same HIGH -> MED -> LOW sequence as
  // pre-fix (mirrors test-band-escalation.js's own shape at compressed timing). ----
  {
    const f = tmp('normal');
    const closesAt = Date.now() + 3000;
    const adapter = lateArmAdapter(closesAt, 50); // oneway=25, +400 minLead = 425ms - never binds here
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 2500, floorWindowMs: 500 } });
    const band = buildBandLadder({ cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }).ladder;

    engine.arm(
      { id: 'N1', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3500));

    assert.deepStrictEqual(adapter.placed.map((b) => b.price), band, 'fired exactly HIGH, MEDIUM, LOW in order, unchanged from pre-fix behavior');
    cleanup(f);
    ok('Normal-arm regression: far-out + low-RTT arm escalates identically to pre-fix (fix is additive-only)');
  }

  // ---- 4) minInterFireMs is irrelevant to the decisive late-arm shot. The floor bid is the FIRST
  // fire (lastFireAt starts at 0), so it always clears the inter-fire gate whatever the configured
  // value. At the 150ms ceiling and (bypassing configStore) well above it, the one floor shot lands. ----
  {
    const f = tmp('interfire-ok');
    const closesAt = Date.now() + 1500;
    const adapter = lateArmAdapter(closesAt, 3000);
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 150 } });
    engine.arm({ id: 'C1', lane: { origin: 'X', destination: 'Y' }, units: 1, closesAt },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    await new Promise((r) => setTimeout(r, 2200));
    assert.strictEqual(adapter.placed.length, 1, 'the decisive floor shot lands at the 150ms inter-fire ceiling');
    cleanup(f);
    ok('minInterFireMs at the 150ms ceiling: the decisive floor shot lands');
  }
  {
    const f = tmp('interfire-bypass');
    const closesAt = Date.now() + 1500;
    const adapter = lateArmAdapter(closesAt, 3000);
    // Direct construction bypasses configStore's AD_LIMITS ceiling on purpose: even far above the
    // hot-poll cadence, the FIRST (and only) decisive shot clears the inter-fire gate and lands.
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 500 } });
    engine.arm({ id: 'C2', lane: { origin: 'X', destination: 'Y' }, units: 1, closesAt },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    await new Promise((r) => setTimeout(r, 2200));
    assert.strictEqual(adapter.placed.length, 1, 'the decisive floor shot still lands even with an above-cadence minInterFireMs');
    cleanup(f);
    ok('minInterFireMs above the hot-poll cadence: the decisive floor shot still lands');
  }

  // ---- 5) Price-visible "never falsely alerts": currentRungIndex is NEVER populated on this
  // path (rungIndex is always null), so lastBidPrice must be what proves a real bid landed.
  // Several undercut bids land, then the rival goes below our floor and we lose - must alert
  // lost_after_bidding, not never_bid_before_close. ----
  {
    const f = tmp('price-visible');
    const closesAt = Date.now() + 2000;
    const adapter = priceVisibleThenFloorAdapter(closesAt, 3); // breach after 3 reads
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    const monitor = engine.arm(
      { id: 'D1', lane: { origin: 'X', destination: 'Y' }, units: 1, closesAt },
      { marketRate: 50_000, costFloor: 40_000 }
    );
    await new Promise((r) => setTimeout(r, 2400));

    assert.ok(adapter.placed.length >= 1, 'at least one undercut bid landed before the floor breach');
    assert.strictEqual(monitor.currentRungIndex, -1, 'currentRungIndex stays -1 on the price-visible path (by design)');
    assert.ok(monitor.lastBidPrice != null, 'lastBidPrice IS set (proves a real bid landed despite currentRungIndex=-1)');
    const kinds = alertKinds(events);
    assert.ok(kinds.includes('lost_after_bidding'), 'lost_after_bidding fired (a real loss, not a zero-bid miss)');
    assert.ok(!kinds.includes('never_bid_before_close'), 'never_bid_before_close did NOT falsely fire');
    cleanup(f);
    ok('Price-visible platform: lastBidPrice (not currentRungIndex) proves a real bid landed - no false never_bid_before_close');
  }

  // ---- 6) stop() before any tick ran, and a scheduled-but-never-armed retire, must never
  // spuriously emit the new alert - both structurally never reach _finalize at all. ----
  {
    const f = tmp('stop-before-tick');
    const adapter = lateArmAdapter(Date.now() + 5000, 50);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    engine.arm({ id: 'E1', lane: { origin: 'X', destination: 'Y' }, units: 1, closesAt: Date.now() + 5000 },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    engine.stop('E1'); // synchronous, before the delay-0 first tick ever runs
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(adapter.placed.length, 0, 'no bid ever fired');
    assert.ok(!alertKinds(events).includes('never_bid_before_close'), 'stop() before any tick emits nothing from the new path');
    assert.strictEqual(engine.monitors.has('E1'), false, 'monitor removed by stop()');
    cleanup(f);
    ok('stop() before any tick ran: zero never_bid_before_close events (structurally never reaches _finalize)');
  }
  {
    const f = tmp('scheduled-retire');
    const past = Date.now() - 1000;
    const adapter = lateArmAdapter(past, 50);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: { armLeadMs: 0 }, onEvent: (e) => events.push(e) });
    engine.schedule({ id: 'F1', lane: { origin: 'X', destination: 'Y' }, units: 1, startsAt: past, closesAt: past },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    await new Promise((r) => setTimeout(r, 400)); // let the (already-due) wake timer fire and retire it
    assert.strictEqual(engine.monitors.has('F1'), false, 'never armed - retired straight from the scheduled wake');
    assert.ok(!alertKinds(events).includes('never_bid_before_close'), 'scheduled-then-closed-before-arming emits nothing from the new path either');
    cleanup(f);
    ok('scheduled, never armed, closed before starting: zero never_bid_before_close events');
  }

  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
