'use strict';
/**
 * Blind-rank guard: a DISCRETIONARY step-down must never fire on an unknown rank.
 *
 * SuperProcure's socket only self-matches the routed carrier once we have bid AS that carrier, so
 * our own rank takes about 1.15s to appear after the establishing bid (live-measured on a real
 * Havells soft load). Through that window state.myRank is null - and null is not 1, so the
 * hold-while-winning test (`myRank === 1`) let it fall straight through into the step-down and the
 * soft-close defend. At the fixed 200ms hot cadence that could spend two rungs ~400ms apart, blind,
 * while possibly already winning. On a soft load the defend caps at last-1 (the floor is reserved
 * until extensions exhaust), so those are the ONLY usable rungs - blind-burning them exhausts the
 * whole reachable ladder before the engine has ever seen a rank.
 *
 * The guard holds instead. What it must NOT touch:
 *   - the establishing bid (fires with no rank - that is how we get one),
 *   - the final floor snipe (never consults rank), which is what makes a never-arriving rank cost
 *     margin rather than the auction.
 *
 *   node scripts/test-blind-rank-guard.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// COMPLETION SENTINEL, registered HERE - before a single check runs - and fired on process exit.
//
// The runner grades by EXIT CODE ALONE, and this file is async, so a `return` above the checks, a
// swallowed rejection, or a require resolving to a stub all reach exit 0 as a silent green
// zero-assertion run. The sentinel used to be an assert at the BOTTOM of the async IIFE, which does
// not close that hole: it sits downstream of everything it guards, so any of those paths skips the
// assert along with the checks. It catches a deleted check and nothing else.
//
// Registration order is the whole fix. An exit handler installed before the work runs fires on every
// path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CHECKS = 9;
process.on('exit', (code) => {
  if (pass === EXPECTED_CHECKS) {
    if (code === 0) console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: only ${pass} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  process.exitCode = 1;
});

const tmp = (tag) => path.join(os.tmpdir(), `blind-rank-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 };
const BAND = { cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 };
// The live band at cost 18000. Rung 0 establishes, rung 1 is the only discretionary step, rung 2 is
// the reserved floor.
const LADDER = [20268, 19296, 18486];

const baseAdapter = () => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  writeEnabled: true,
  async getAuctionState() { return { ok: false }; },
  async placeBid() { return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 20 }; },
});

const mkEngine = (f, opts = {}) => new BidEngine(baseAdapter(), new DurableScheduler(f),
  Object.assign({ config: CFG, rand: () => 0 }, opts));

const armed = (eng, id, closesInMs) => eng.arm(
  { id, lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells', closesAt: Date.now() + closesInMs },
  BAND);

// A state object as getAuctionState would return it.
const st = (o) => Object.assign({ ok: true, status: 'live', myRank: null, totalBidders: 1,
  standingL1Price: null, closesInMs: 10000, revisionLimit: 3, revisionsLeft: null,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }, o);

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. Hard close: the blind window holds; a known rank steps.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('hard');
    const eng = mkEngine(f);
    const m = armed(eng, 'H1', 10000);
    assert.deepStrictEqual(m.ladder, LADDER);

    // Establishing bid: currentRungIndex is -1 and rank is null. Must STILL fire rung 0 - this is
    // decided before any rank test and is how we come to have a rank at all.
    const est = eng._decide(m, st({ closesInMs: 10000 }));
    assert.deepStrictEqual(est, { price: 20268, rungIndex: 0 }, 'establish fires blind');
    ok('the establishing bid is unaffected by the guard (fires with no rank)');

    // Bank the establish, as _maybeBid would.
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;

    // Blind window: rank still null, well outside the final window -> HOLD.
    const blind = eng._decide(m, st({ myRank: null, closesInMs: 10000 }));
    assert.strictEqual(blind, null, 'a null rank must not select a discretionary step-down');
    ok('hard close: a discretionary step-down is withheld while the rank is unknown');

    // Rank arrives and we are outranked -> the step-down proceeds exactly as before.
    const seen = eng._decide(m, st({ myRank: 2, closesInMs: 10000 }));
    assert.ok(seen && seen.rungIndex === 1 && seen.price === 19296, 'steps to the mid rung once rank is known');
    ok('hard close: the step-down proceeds normally as soon as a rank arrives');

    // And a known winning rank still holds, unchanged.
    assert.strictEqual(eng._decide(m, st({ myRank: 1, closesInMs: 10000 })), null, 'rank 1 still holds');
    ok('holding while winning (rank 1) is unchanged');
    eng.kill(); rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The final floor snipe never consults rank and must stay that way.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('snipe');
    const eng = mkEngine(f);
    const m = armed(eng, 'H2', 2000);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;

    // Inside floorWindowMs (2500) with a null rank: the floor must still be selected.
    const snipe = eng._decide(m, st({ myRank: null, closesInMs: 1200 }));
    // This monitor is NOT on the rung-expansion allowlist (soft-close off), so it runs the DEPLOYED
    // always-floor snipe: the floor rung fires blind with no snipe:true marker, byte-identical to prod.
    assert.deepStrictEqual(snipe, { price: 18486, rungIndex: 2 }, 'floor rung fires blind inside the final window');
    ok('the final floor snipe is unaffected by the guard (fires with no rank)');
    eng.kill(); rm(f);
  }

  {
    // NEVER-ARRIVES: rank stays null for the whole auction (the mid-auction-restart case, where the
    // routed carrier is not re-registered until we bid again). The guard must cost margin, never the
    // load: the middle rung is withheld, but the buzzer floor shot still fires.
    const f = tmp('never');
    const placed = [];
    const adapter = Object.assign(baseAdapter(), {
      async getAuctionState() { return st({ myRank: null, closesInMs: this._t }); },
      async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 20 }; },
    });
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, rand: () => 0 });
    const m = armed(eng, 'H3', 30000);
    for (const t of [20000, 12000, 8000, 5000, 1200]) {
      adapter._t = t;
      await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    }
    eng.kill();
    assert.ok(placed.includes(20268), 'the establishing rung still fired');
    assert.ok(placed.includes(18486), 'the floor snipe still fired despite a rank that never arrived');
    assert.ok(!placed.includes(19296), 'the discretionary mid rung was correctly withheld');
    ok('rank never arrives: establish + floor snipe still fire, only the mid rung is withheld');
    rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Soft close: the guard withholds the DISCRETIONARY rung while blind - but a hold must never be
  //    the last word on the final tick.
  //
  //    *** CORRECTED 2026-07-31. This case used to assert that a blind rank on a soft load holds even
  //    at 1200ms remaining, on the rationale that falling through would "dump the RESERVED floor
  //    early". 1200ms is not early - _isLastChance(1200) is true, so that IS the final window, the
  //    exact window the reserve is reserved FOR. The old assertion encoded the defect that lost three
  //    Havells Alwar loads (Rs 1,25,000): a rejected establish bid banks currentRungIndex, so nothing
  //    ever lands, SuperProcure never self-matches us, rank stays null for the life of the auction,
  //    and this guard then held on every remaining tick until the load closed with the floor rung
  //    unspent. The old design tolerated that because it assumed a later chance once extensions
  //    exhausted - but extensions are systematically undercounted (once the believed close passes, the
  //    socket stops publishing and the forward jump never arrives), so _effectivelyHard never flips
  //    and the later chance never comes.
  //
  //    What the guard SHOULD protect is unchanged and is still asserted below: no discretionary mid
  //    rung is spent on a guess. Only the never-forfeit release at the final tick is new. ***
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('soft');
    const eng = mkEngine(f, { softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
    const m = armed(eng, 'S1', 10000);
    assert.strictEqual(m.softStrategy, 'live', 'the soft-close endgame is engaged for this shipper');
    // A soft load still holding extensions: not effectivelyHard, so the defend branch owns the decision.
    m.closeModel = 'soft'; m.extendCap = 3; m.extendsObserved = 0;
    m.revisionsLeft = 3;
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;
    assert.strictEqual(eng._effectivelyHard(m), false, 'extensions remain, so the auction is not yet final');

    // OUTSIDE the final window, blind: holding is mandatory and nothing is spent. This is the guard's
    // real job - a rung is scarce and shared with the human desk, so it is never spent on a guess.
    const blindEarly = eng._decide(m, st({ myRank: null, closesInMs: 8000, closeModel: 'soft' }));
    assert.strictEqual(blindEarly, null, 'soft + null rank outside the final window must hold: no rung on a guess');
    ok('soft close: a null rank holds outside the final window - no discretionary rung is spent blind');

    // AT the final window, blind, with the reserved rung still unspent: the hold must NOT be the last
    // word. Fire the floor rather than let the auction close having never bid our best price.
    const blindFinal = eng._decide(m, st({ myRank: null, closesInMs: 1200, closeModel: 'soft' }));
    assert.ok(blindFinal, 'soft + null rank on the FINAL tick must not forfeit the load - this is the Alwar defect');
    assert.strictEqual(blindFinal.rungIndex, m.ladder.length - 1,
      'the never-forfeit release spends the reserved FLOOR rung, not a discretionary mid rung');
    ok('soft close: on the final tick a blind hold releases the reserved floor instead of forfeiting');

    // Rank arrives, outranked -> the reserve-gated defend proceeds, still capped above the floor.
    const m2 = armed(eng, 'S2', 10000);
    m2.closeModel = 'soft'; m2.extendCap = 3; m2.extendsObserved = 0;
    m2.revisionsLeft = 3;
    m2.currentRungIndex = 0; m2.firedRungs.add(0); m2.lastBidPrice = 20268;
    const seen = eng._decide(m2, st({ myRank: 2, closesInMs: 10000, closeModel: 'soft' }));
    assert.ok(seen && seen.rungIndex === 1, 'defends to the mid rung once rank is known');
    assert.ok(seen.rungIndex < m2.ladder.length - 1, 'the defend never selects the reserved floor rung');
    ok('soft close: the reserve-gated defend proceeds once a rank arrives, floor still reserved');
    eng.kill(); rm(f);
  }

})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exitCode = 1; });
