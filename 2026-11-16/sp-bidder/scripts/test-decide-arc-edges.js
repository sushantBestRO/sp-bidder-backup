'use strict';
/**
 * RANK-DRIVEN _decide ARC - TIMING and DEGENERATE-INPUT edges.
 *
 * This is the error-path companion to test-rank-driven-endgame.js. That suite pins the basic
 * establish/defend/snipe arc, the rung math vs rank, the basic latch restore and the non-allowlisted
 * byte-identity. This one exercises the edges it deliberately skips - the places a live-money
 * reverse-auction is actually LOST:
 *
 *   1.  establish is robust to an absurd countdown (SP's year-2100 close placeholder / NaN remaining /
 *       an unknown per-load trigger window) - it never establishes INSIDE the window, and the
 *       _establishThreshold backstop guarantees an establish still happens by ~25s. There is never a
 *       state in which no establish ever happens.
 *   2.  the establish-late mark lands OUTSIDE the anti-snipe trigger window (window + establishLeadMs),
 *       so the establishing bid can never self-trigger an extension.
 *   3/4 the soft defend is once-per-extension-round at rank 3 (jump = k-1 = 2 rungs), then held until
 *       the next extension advances the round.
 *   5.  the defend is held while OUTSIDE the trigger window when the window is KNOWN, but an UNKNOWN
 *       window is never fabricated (D6) - the defend then fires regardless of remaining, no more
 *       aggressive than the deployed engine which never read the window.
 *   6.  a rank feed that goes null mid-auction holds every discretionary defend (blind is not losing).
 *   7.  a rank still null at the buzzer still fires the floor snipe (the sure shot is never starved by
 *       blindness).
 *   8.  a rank that flaps 1->3->1 inside one round defends at most once - no bid ping-pong.
 *   9.  the decisive snipe is single-shot: a surprise extension after a LANDED snipe re-runs the same
 *       rules but never fires a second decisive dump; snipeFired stays latched.
 *   10. a rank-chosen snipe rung within the load's min bid difference of our own last bid falls to the
 *       floor and FIRES - never silently dropped - and the boundary (gap == minDec) is respected exactly.
 *   11. the reserved final bid slot is never starved: a defend held for lack of slack still leaves the
 *       one reserved revision, and the final snipe spends it.
 *   12. (cross-cutting) NO bid, on any path above, is ever below the plan floor or off the ladder.
 *
 * Offline and deterministic: the fake adapter + memory-backed scheduler from test-rank-driven-endgame.js,
 * no timers, no network, no wall-clock races (minInterFireMs 0, openJitterMs 0).
 *
 *   node scripts/test-decide-arc-edges.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `decide-arc-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// ---- harness reused verbatim from test-rank-driven-endgame.js (mkEngine / armFine / state / recordPlaced)
// A soft-strategy engine. Rank-only caps, 30-revision default, minDecrement 100. openAtMs 25s ->
// _establishThreshold backstop == 25000 (openJitterMs 0, so deterministic). minInterFireMs 0 so no
// wall-clock gating between the sequential _maybeBid calls each scenario makes.
function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
  });
}

// Arm a soft monitor and OVERRIDE its ladder to a controlled FINE one, so the gate logic is isolated
// from interpolateBandLadder's pricing math (unit-tested elsewhere). Post-establish state
// (currentRungIndex/firedRungs/lastBidPrice) is set by each scenario. extendCap 5 by default
// (extensions remain -> soft defend owns the decision); pass extendCap 0 for an effectively-hard
// monitor whose final snipe is eligible.
function armFine(eng, ladder, { companyName = 'Havells', revisionsLeft = 30, extendCap = 5, triggerWindowMs = 100_000 } = {}) {
  const meta = { id: 'F', lane: { origin: 'A', destination: 'B' }, units: 1, companyName, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = triggerWindowMs;
  return m;
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });
const recordPlaced = (eng, placed, myRank = 2) => {
  eng.adapter.placeBid = async (id, price) => { placed.push(price); return { accepted: true, myRank, revisionsLeft: null, latencyMs: 20 }; };
};

// ---- behavior 12 (cross-cutting): every price the engine ever commits must sit ON the plan ladder AND
// at or above the floor (the lowest rung). Wired into every scenario's bid/decision log. The hard floor
// invariant in _maybeBid (assertAboveFloor) throws below-floor, but that is the impl asserting itself;
// this is the TEST asserting the outcome, and it also catches an off-LADDER price the floor check alone
// would let through (a price >= floor but not a real rung).
function assertOnLadder(prices, ladder, label) {
  const floor = ladder[ladder.length - 1];
  const rungs = new Set(ladder);
  for (const p of prices) {
    assert.ok(p >= floor, `${label}: committed price ${p} is BELOW the plan floor ${floor}`);
    assert.ok(rungs.has(p), `${label}: committed price ${p} is OFF the ladder [${ladder.join(',')}]`);
  }
}

(async () => {
  // ============================================================================================
  // 1. ESTABLISH survives an absurd countdown and an unknown trigger window - and ALWAYS eventually
  //    happens. SP's year-2100 close placeholder parses as a valid (huge, finite) number; a dropped
  //    frame can surface NaN; branchAuctionRemainingTime is sometimes omitted entirely. None of these
  //    may (a) trip an early establish INSIDE the window, nor (b) wedge the load into never establishing.
  //    catches: validation-check-removed (Number.isFinite(remaining) dropped -> establish on NaN),
  //             default-applied-where-validation-should-fail (fabricated window), status/side-effect flip.
  // ============================================================================================
  {
    const YEAR_2100_MS = 4_102_444_800_000; // SP's placeholder close, as a countdown: finite but not real

    // (a) year-2100 placeholder remaining (finite, absurd): HELD - not an early establish.
    const engA = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mA = armFine(engA, [10_000, 9_700, 9_400, 9_100, 8_000]); // currentRungIndex stays -1 (pre-establish)
    assert.strictEqual(engA._decide(mA, state(YEAR_2100_MS, null)), null,
      'establish HELD on a year-2100 placeholder remaining (finite but absurd -> not an early establish)');
    // ...once the countdown is real (<= window+lead = 140000), establish fires the TOP rung.
    const estA = engA._decide(mA, state(20_000, null));
    assert.ok(estA && estA.rungIndex === 0 && estA.price === mA.ladder[0],
      'establish fires rung 0 (top price) once the countdown becomes real - never a no-establish-ever state');
    assertOnLadder([estA.price], mA.ladder, 'b1a establish');

    // (b) NaN remaining: Number.isFinite(remaining) is false -> HELD this tick, establishes on the next
    //     real frame. A dropped establish-on-NaN would spend the top rung against a garbage countdown.
    const engB = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mB = armFine(engB, [10_000, 9_700, 9_400, 9_100, 8_000]);
    assert.strictEqual(engB._decide(mB, state(NaN, null)), null,
      'establish HELD on a NaN remaining (non-finite countdown -> hold, never bid blind on garbage)');
    const estB = engB._decide(mB, state(20_000, null));
    assert.ok(estB && estB.rungIndex === 0, 'establish fires once a finite countdown arrives (NaN did not wedge it)');

    // (c) UNKNOWN trigger window (SP omitted branchAuctionRemainingTime): NO fabricated window - the
    //     establish-late mark falls back to the _establishThreshold backstop (openAtMs == 25000), so
    //     establish is held above ~25s and fires by ~25s. Proves the backstop, and that an unknown
    //     window is never invented into an aggressive (early) establish.
    const engC = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mC = armFine(engC, [10_000, 9_700, 9_400, 9_100, 8_000], { triggerWindowMs: null });
    assert.strictEqual(engC._decide(mC, state(30_000, null)), null,
      'unknown trigger window: establish HELD above the ~25s backstop (30000 > openAtMs 25000)');
    const estC = engC._decide(mC, state(24_000, null));
    assert.ok(estC && estC.rungIndex === 0,
      'unknown trigger window: _establishThreshold backstop fires establish by ~25s (24000 <= openAtMs 25000)');
    ok('establish survives year-2100 / NaN remaining + unknown window: held on garbage, backstops by ~25s, never a no-establish state');
  }

  // ============================================================================================
  // 2. ESTABLISH-LATE lands OUTSIDE the trigger window. With window 100s and establishLeadMs 40s the
  //    establish mark is window + lead = 140s remaining, strictly ahead of the 100s window, so the
  //    establishing bid can never itself land inside the window and self-trigger an anti-snipe extension.
  //    catches: Math.max->Math.min (mark collapses to 25000, INSIDE the 100s window),
  //             establishLeadMs term dropped (mark == window edge, zero safety margin).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { triggerWindowMs: 100_000 });
    const lead = eng.softCfg.establishLeadMs; // 40000 (default)
    const mark = m.triggerWindowMs + lead;    // 140000 - the expected establish-late mark

    assert.strictEqual(eng._decide(m, state(mark + 1, null)), null,
      'establish HELD one ms above the window+lead mark (140001 > 140000)');
    const est = eng._decide(m, state(mark, null));
    assert.ok(est && est.rungIndex === 0 && est.price === m.ladder[0],
      'establish fires rung 0 at exactly window+lead (140000 remaining)');
    assert.ok(mark > m.triggerWindowMs,
      'the establish mark is OUTSIDE the trigger window - the establishing bid can never self-extend');
    assert.strictEqual(mark - m.triggerWindowMs, lead,
      'the establish mark sits establishLeadMs (40s) AHEAD of the trigger window, not on its edge');
    assertOnLadder([est.price], m.ladder, 'b2 establish');
    ok('establish-late lands at window+lead (outside the trigger window), never inside it - no self-triggered extension');
  }

  // ============================================================================================
  // 3 + 4. SOFT DEFEND is ONCE-PER-EXTENSION-ROUND at rank 3 (jump = k-1 = 2 rungs), then held until the
  //        next extension advances extendsObserved, which RELEASES the next defend. Rank 3 (not the
  //        rank-2 case check 1 pins) exercises the multi-rung jump: the step is exactly 2 rungs.
  //        catches: jump math (k-1 -> k, or the jumpPerRival multiply dropped -> wrong rung),
  //                 once-per-round latch removed (second same-round poll would double-step),
  //                 latch never releases (extension would not unlock the next defend).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // last=4 (floor 8000)
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000; // establish already banked

    // round 0, first defend at rank 3: jump = (3-1) = 2 rungs -> rung 2 (9400), NOT one rung.
    await eng._maybeBid(m, state(50_000, 3));
    assert.deepStrictEqual(placed, [9_400], 'rank 3 defend steps EXACTLY 2 rungs (k-1), landing rung 2 (9400)');
    assert.strictEqual(m._lastDefendAtExtend, 0, 'the defend latched extension round 0');

    // round 0, second poll (still rank 3): HELD by the once-per-round latch even though rung 3 is free.
    await eng._maybeBid(m, state(50_000, 3));
    assert.deepStrictEqual(placed, [9_400], 'a second defend in the SAME round is held by the once-per-round latch');

    // an extension advances the round -> the next defend is RELEASED: jump 2 again, clamped to last-1 -> rung 3.
    m.extendsObserved = 1;
    await eng._maybeBid(m, state(50_000, 3));
    assert.deepStrictEqual(placed, [9_400, 9_100], 'the extension releases the next defend (rung 3, floor still reserved)');
    assert.strictEqual(m._lastDefendAtExtend, 1, 'the second defend latched round 1');
    assertOnLadder(placed, m.ladder, 'b3/4 defends');
    ok('soft defend is once-per-round at rank 3 (2-rung jump), held in-round, released by the next extension');
  }

  // ============================================================================================
  // 5. DEFEND is HELD while OUTSIDE a KNOWN trigger window, but an UNKNOWN window is NEVER fabricated
  //    (D6) - with no window read, the defend fires regardless of remaining (no more aggressive than the
  //    deployed engine, which never read the window). Rank 3 throughout.
  //    catches: window comparator flip (remaining > window -> remaining < window would fire outside/hold
  //             inside), a fabricated default window applied when it is unknown (would wrongly hold).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });

    // KNOWN window 100s, remaining 150s (OUTSIDE, before the window): defend HELD.
    const mKnown = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { triggerWindowMs: 100_000 });
    mKnown.currentRungIndex = 0; mKnown.firedRungs.add(0); mKnown.lastBidPrice = 10_000;
    assert.strictEqual(eng._decide(mKnown, state(150_000, 3)), null,
      'defend HELD while remaining (150s) is OUTSIDE the known trigger window (100s)');

    // UNKNOWN window (null), same remaining 150s: NOT gated by a window - the defend fires (rung 2).
    const eng2 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mUnknown = armFine(eng2, [10_000, 9_700, 9_400, 9_100, 8_000], { triggerWindowMs: null });
    mUnknown.currentRungIndex = 0; mUnknown.firedRungs.add(0); mUnknown.lastBidPrice = 10_000;
    const d = eng2._decide(mUnknown, state(150_000, 3));
    assert.ok(d && d.rungIndex === 2 && d.defend === true,
      'unknown window is not fabricated: the defend fires (rung 2) regardless of remaining, no window gate');
    assertOnLadder([d.price], mUnknown.ladder, 'b5 defend');
    ok('defend held outside a KNOWN window; an UNKNOWN window is never invented into a hold (D6)');
  }

  // ============================================================================================
  // 6. BLIND RANK MID-AUCTION: after establish, the rank feed goes null (SP self-matches our carrier
  //    ~1.15s after our first bid; a mid-auction restart can lose it entirely). Every DISCRETIONARY
  //    defend HOLDS while blind - spending a scarce shared-account rung on a guess is strictly worse
  //    than waiting a poll. Zero bids while blind; a blind_rank_hold trace is surfaced once.
  //    catches: selectRung's k==null defend branch returning a rung instead of null (would bid blind),
  //             the blind-rank guard removed (no operator trace on a rung being withheld).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const events = [];
    eng.onEvent = (e) => events.push(e);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // extendCap 5 -> still soft/non-final
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    // blind (rank null), inside the window, extensions remaining: HOLD, zero bids.
    await eng._maybeBid(m, state(50_000, null));
    assert.strictEqual(placed.length, 0, 'no discretionary bid is placed while the rank is unknown (blind is not losing)');
    assert.ok(events.some((e) => e.kind === 'blind_rank_hold'),
      'a blind_rank_hold trace is surfaced when a discretionary defend is withheld for a null rank');

    // CONTRAST on the same (unchanged) monitor: with a KNOWN rank the very same state DOES defend -
    // proving the hold above was caused by blindness, not by some other gate incidentally closing.
    const known = eng._decide(m, state(50_000, 2));
    assert.ok(known && known.defend === true && known.rungIndex === 1,
      'the same state with a KNOWN rank 2 defends (rung 1) - the earlier hold was specifically the blind guard');
    ok('blind rank mid-auction holds every discretionary defend (zero blind bids), and surfaces the hold once');
  }

  // ============================================================================================
  // 7. BLIND AT THE BUZZER: the rank is STILL null in the genuinely-final window (extensions exhausted).
  //    The floor snipe is rank-INDEPENDENT and fires anyway - the sure shot is never starved by
  //    blindness (a load whose rank never comes online must still be bid, not silently forfeited).
  //    catches: selectRung's k==null snipe branch returning null instead of the floor (buzzer hold ->
  //             auction lost), the snipe branch consulting rank and refusing to fire while blind.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 }); // effectively hard
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    const d = eng._decide(m, state(1_500, null)); // final window, rank unknown
    assert.deepStrictEqual(d, { price: 8_000, rungIndex: 4, snipe: true },
      'blind at the buzzer fires the FLOOR snipe (the sure shot), rank-independent');
    await eng._maybeBid(m, state(1_500, null));
    assert.deepStrictEqual(placed, [8_000], 'the blind floor snipe actually reaches the wire - never starved by a null rank');
    assert.strictEqual(m.snipeFired, true, 'snipeFired latched after the floor snipe landed');
    assertOnLadder(placed, m.ladder, 'b7 floor snipe');
    ok('blind at the buzzer still fires the floor snipe - the decisive shot is never starved by blindness');
  }

  // ============================================================================================
  // 8. RANK FLAP inside one round (1 -> 3 -> 1 -> 3): at most ONE defend, no bid ping-pong. Winning
  //    ticks hold (never improve a winning price); the single rank-3 defend latches the round, so a
  //    later rank-3 flap-back in the SAME round does not fire a second time.
  //    catches: hold-while-winning removed (a rank-1 tick would bid), once-per-round latch removed (the
  //             flap-back rank-3 tick would double-step) - either turns a stable hold into a bid war.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // extendCap 5, one round throughout
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    await eng._maybeBid(m, state(50_000, 1)); // winning -> hold
    await eng._maybeBid(m, state(50_000, 3)); // outranked -> ONE defend (jump 2 -> rung 2, 9400)
    await eng._maybeBid(m, state(50_000, 1)); // winning again -> hold
    await eng._maybeBid(m, state(50_000, 3)); // flap back, SAME round -> held by the once-per-round latch

    assert.deepStrictEqual(placed, [9_400], 'a 1->3->1->3 flap inside one round defends exactly once - no ping-pong');
    assert.strictEqual(placed.length, 1, 'exactly one bid across the whole flap');
    assertOnLadder(placed, m.ladder, 'b8 flap defend');
    ok('rank flap 1->3->1->3 in one round: at most one defend, winning ticks hold, no bid ping-pong');
  }

  // ============================================================================================
  // 9. SINGLE-SHOT SNIPE across a SURPRISE EXTENSION. The decisive shot lands once; a surprise extension
  //    afterwards re-runs the same rules but never fires a SECOND decisive dump - snipeFired stays
  //    latched (it is not reset by an extension), so the still-final-window re-entry holds.
  //    catches: the single-shot guard (if snipeFired return null) removed, an extension path that
  //             wrongly clears snipeFired -> a second decisive dump on the same load.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 }); // effectively hard
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    await eng._maybeBid(m, state(1_500, 2)); // decisive snipe: rank-aware rung 1 (9700)
    assert.deepStrictEqual(placed, [9_700], 'the decisive snipe fires one rank-aware shot (rung 1, not the floor)');
    assert.strictEqual(m.snipeFired, true, 'snipeFired latched after the shot LANDED');

    // a surprise extension is observed after the shot (extendsObserved advances). Still effectively hard
    // (cap 0), so a further final-window tick re-enters the snipe branch - and must find snipeFired latched.
    m.extendsObserved = 1;
    await eng._maybeBid(m, state(1_400, 2)); // still outranked, still final window
    assert.deepStrictEqual(placed, [9_700], 'a surprise extension after a LANDED snipe fires NO second decisive dump');
    assert.strictEqual(m.snipeFired, true, 'snipeFired stays latched across the extension (not reset)');
    assertOnLadder(placed, m.ladder, 'b9 snipe');
    ok('single-shot snipe: one decisive dump, a surprise extension re-runs the rules but never fires a second');
  }

  // ============================================================================================
  // 10. DECISIVE-SHOT DECREMENT FALLBACK - the BOUNDARY. When the rank-selected snipe rung sits STRICTLY
  //     within the load's min bid difference of our own last bid it falls to the floor and FIRES; when it
  //     sits EXACTLY at the min difference it is fireable and the rank rung stands (no over-substitution).
  //     check 3 of the endgame suite pins the within-difference substitution; this pins the `<` boundary.
  //     catches: the comparator `< minDec` widened to `<= minDec` (would substitute the floor at the exact
  //              boundary, giving away margin), and the substitution dropped (the too-close shot placed as
  //              the wrong rung).
  // ============================================================================================
  {
    // Case A - boundary: gap == minDec (200) -> NOT within -> the rank rung (9600) stands.
    const engA = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mA = armFine(engA, [10_000, 9_800, 9_600, 9_000], { extendCap: 0 }); // last=3 (floor 9000)
    mA.currentRungIndex = 1; mA.firedRungs.add(0); mA.firedRungs.add(1); mA.lastBidPrice = 9_800;
    const dA = engA._decide(mA, state(1_500, 2, 200)); // snipe picks rung 2 (9600); 9800-9600 == 200 == minDec
    assert.deepStrictEqual(dA, { price: 9_600, rungIndex: 2, snipe: true },
      'gap EXACTLY at min bid difference (200) is fireable - the rank rung stands, no floor over-substitution');
    assertOnLadder([dA.price], mA.ladder, 'b10a snipe');

    // Case B - within: gap (200) < minDec (300) -> substitute the FLOOR (9000) and FIRE it.
    const engB = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placedB = [];
    recordPlaced(engB, placedB);
    const mB = armFine(engB, [10_000, 9_800, 9_600, 9_000], { extendCap: 0 });
    mB.currentRungIndex = 1; mB.firedRungs.add(0); mB.firedRungs.add(1); mB.lastBidPrice = 9_800;
    const dB = engB._decide(mB, state(1_500, 2, 300)); // 9800-9600 == 200 < 300 -> fall to the floor
    assert.deepStrictEqual(dB, { price: 9_000, rungIndex: 3, snipe: true },
      'a snipe rung within the min bid difference falls to the FLOOR (the decisive shot is never dropped)');
    await engB._maybeBid(mB, state(1_500, 2, 300));
    assert.deepStrictEqual(placedB, [9_000], 'the substituted floor snipe reaches the wire');
    assertOnLadder(placedB, mB.ladder, 'b10b snipe');
    ok('snipe decrement fallback boundary: gap==minDec fires the rank rung; gap<minDec substitutes the floor and fires');
  }

  // ============================================================================================
  // 11. THE RESERVED FINAL SLOT IS NEVER STARVED. With the shared-account budget down to exactly the
  //     reserve (revisionsLeft == reserve == 1), a mid-auction defend is HELD (no slack above the
  //     reserve), so the reserved revision survives the extension rounds; once effectively hard the final
  //     snipe spends it. The reserved shot always fires.
  //     catches: the reserve slack gate `(revisionsLeft - reserve) > 0` weakened to `>= 0` or removed
  //              (the defend would spend the reserved slot -> the final snipe is starved, revisionsLeft 0).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 1, revisionsLeft: 1 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    // non-final window, one extension still to come, budget == reserve: the defend is HELD (no slack).
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(placed, [], 'a defend is held when budget is down to the reserve - the reserved slot is protected');
    assert.strictEqual(m.revisionsLeft, 1, 'the reserved revision was NOT spent by the held defend');

    // extension exhausts the cap -> effectively hard -> the final snipe spends the reserved slot.
    m.extendsObserved = 1;
    await eng._maybeBid(m, state(1_500, 2));
    assert.deepStrictEqual(placed, [8_000],
      'the reserved final slot fires the snipe - never starved. Reversed 2026-09-24 from the rank rung 9,700 to the '
      + 'floor: in the final round the last remaining bid is the floor');
    assert.strictEqual(m.snipeFired, true, 'snipeFired latched after the reserved snipe landed');
    assertOnLadder(placed, m.ladder, 'b11 reserved snipe');
    ok('reserved final slot never starved: defend held at budget==reserve, final snipe spends the reserved revision');
  }

  cleanup();
  console.log(`\n${pass}/10 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
