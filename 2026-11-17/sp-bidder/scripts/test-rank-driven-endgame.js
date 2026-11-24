'use strict';
/**
 * RANK-DRIVEN endgame (bidEngine wiring of pricing.selectRung + interpolateBandLadder).
 *
 * Pins the four engine gates that the clock->rank rewire introduced, plus the reversibility spine that
 * keeps every existing customer coarse on merge:
 *
 *   1. ONCE-PER-EXTENSION-ROUND defend gate - the soft defend steps at most one rung per extension
 *      round, then holds until the next extension advances extendsObserved.
 *   2. INSIDE-TRIGGER-WINDOW gate - a soft defend is held while remaining is OUTSIDE (before) the
 *      per-load anti-snipe trigger window, and fires once inside it.
 *   3. DECISIVE-SHOT DECREMENT FALLBACK - when the rank-selected snipe rung sits within the load's
 *      minimum bid difference of our own last bid, the decisive shot falls to the FLOOR (which always
 *      attempts) rather than being silently dropped by _maybeBid's min-decrement guard.
 *   4. SINGLE-SHOT snipe - exactly one decisive final-window shot; no bid war.
 *   5. REVERSIBILITY - a fine ladder + rank-aware snipe activate ONLY for an allowlisted shipper on a
 *      load whose platform cap admits it; every other customer runs the DEPLOYED path (always-floor
 *      snipe + clock step-down), gated on the ALLOWLIST, never on ladder length (see check 7).
 *
 * Offline and deterministic: fake adapter, memory-backed scheduler, no timers, no network.
 *
 *   node scripts/test-rank-driven-endgame.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `rank-endgame-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A soft-strategy engine. Rank-only caps, 30-revision default, minDecrement 100.
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

// Arm a soft monitor and OVERRIDE its ladder to a controlled FINE one, so the engine's gate logic is
// isolated from interpolateBandLadder's pricing math (which has its own unit tests). Post-establish
// state (currentRungIndex/firedRungs/lastBidPrice) is set by each test. triggerWindowMs is surfaced so
// the window gate is exercised. extendCap 5 by default (extensions remain -> soft defend owns the
// decision); pass extendCap 0 for an effectively-hard monitor whose final snipe is eligible.
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

(async () => {
  // ============================================================================================
  // 1. ONCE-PER-EXTENSION-ROUND defend gate. A FINE ladder (so selectRung would allow more than one
  //    defend) proves the ROUND LATCH is what holds the second defend, not the ladder running out.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // last-1 = 3, so rungs 1..3 are defendable
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000; // establish already banked

    // first defend of round 0 (remaining 50s < 100s window -> inside): steps ONE rung (k=2 -> rung 1)
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(placed, [9_700], 'first defend of the round steps exactly one rung (rung 1)');
    assert.strictEqual(m._lastDefendAtExtend, 0, 'the defend latched the current extension round (0)');

    // second attempt in the SAME round: held by the latch even though rungs 2 and 3 are still available
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(placed, [9_700], 'a second defend in the same round is HELD by the once-per-round latch');

    // an extension advances the round -> the next defend is released (k=2 -> rung 2)
    m.extendsObserved = 1;
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(placed, [9_700, 9_400], 'once the extension round advances, the next defend fires (rung 2)');
    assert.strictEqual(m._lastDefendAtExtend, 1, 'the second defend latched round 1');
    ok('once-per-extension-round defend gate: one defend per round, released only by the next extension');
  }

  // ============================================================================================
  // 2. INSIDE-TRIGGER-WINDOW gate. Held while remaining is OUTSIDE (before) the window, fires inside.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { triggerWindowMs: 100_000 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    // OUTSIDE: remaining 150s > 100s window -> the defend is held (no premature step-down)
    assert.strictEqual(eng._decide(m, state(150_000, 2)), null,
      'defend HELD while remaining is outside (before) the trigger window');
    // INSIDE: remaining 80s <= 100s window -> the defend fires (one rung, marked defend)
    const d = eng._decide(m, state(80_000, 2));
    assert.ok(d && d.rungIndex === 1 && d.defend === true, 'defend fires (rung 1, marked defend) once inside the trigger window');
    ok('inside-trigger-window gate: defend held outside the window, fired inside it');
  }

  // ============================================================================================
  // 3. DECISIVE-SHOT DECREMENT FALLBACK. Tight 100-spaced rungs, a WIDE (500) min-decrement: the
  //    rank-selected snipe rung sits 100 below our last bid, under the 500 minimum, so it would be
  //    silently dropped by _maybeBid's guard. It must fall to the FLOOR and reach the wire.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_900, 9_800, 9_700, 9_000], { extendCap: 0 }); // effectively hard -> snipe eligible
    const last = m.ladder.length - 1; // 4 (floor 9000)
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1); m.lastBidPrice = 9_900;

    // snipe with a wide (500) decrement: selectRung('snipe') picks rung 2 (9800), which is only 100
    // below our 9900 last bid -> under 500 -> substitute the floor (rung 4, 9000).
    const d = eng._decide(m, state(1_500, 2, 500));
    assert.ok(d && d.snipe === true, 'the decision is a snipe');
    assert.strictEqual(d.rungIndex, last, 'the decisive shot fell to the FLOOR, not the too-close rank rung (rung 2)');
    assert.strictEqual(d.price, 9_000, 'the decisive shot is the floor price');

    // and it actually reaches the wire (proving the shot is never silently dropped)
    await eng._maybeBid(m, state(1_500, 2, 500));
    assert.deepStrictEqual(placed, [9_000], 'the floor decisive shot reached the wire, not dropped by the min-decrement guard');
    ok('decisive-shot decrement fallback: a rank rung within min-decrement of the last bid falls to the floor, never dropped');
  }

  // ============================================================================================
  // 4. SINGLE-SHOT snipe. On a fine ladder the rank-aware snipe fires a non-floor rung ONCE; further
  //    final-window ticks (still outranked, even more outranked) place nothing more - no bid war.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    recordPlaced(eng, placed);
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 }); // effectively hard
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;

    // first final-window tick: rank-aware snipe fires ONE decisive shot (k=2 -> rung 1, the highest that wins)
    await eng._maybeBid(m, state(1_500, 2));
    assert.deepStrictEqual(placed, [9_700], 'the snipe fired exactly one decisive shot (the rank rung, not always the floor)');
    assert.strictEqual(m.snipeFired, true, 'snipeFired latched after the decisive shot');

    // more final-window ticks, still/again outranked: no second snipe
    await eng._maybeBid(m, state(1_400, 2));
    await eng._maybeBid(m, state(1_200, 3));
    assert.strictEqual(placed.length, 1, 'no further shot fires once the decisive snipe has been placed (single-shot)');
    ok('single-shot snipe: exactly one decisive final-window shot, never a bid war');
  }

  // ============================================================================================
  // 5. REVERSIBILITY SPINE. Fine ladders + rank-aware snipe activate ONLY for an allowlisted shipper on
  //    a load whose platform cap admits it. Every other customer runs the DEPLOYED path, gated on the
  //    ALLOWLIST (not ladder length - check 7 covers the non-allowlisted >3-tier band explicitly).
  // ============================================================================================
  {
    const BAND = { cost: 20_000, marginsPct: [12, 8, 4], minMarginPct: 4 };
    const anchors = buildBandLadder(BAND); // [22400, 21600, 20800]
    const meta = (id, companyName, rules) => ({ id, lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName, rules, closesAt: Date.now() + 600_000 });

    // (a) allowlisted shipper + cap 10 -> a FINE ladder; anchors preserved, floor unchanged.
    const engOn = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const mOn = engOn.arm(meta('ON', 'Havells India Ltd', { revisionLimit: 10, minDecrement: 100 }), BAND);
    if (mOn.timer) clearTimeout(mOn.timer);
    assert.ok(mOn.ladder.length > anchors.ladder.length,
      `allowlisted shipper + cap>3: the ladder expands beyond the 3 anchors (got ${mOn.ladder.length})`);
    for (const a of anchors.ladder) assert.ok(mOn.ladder.includes(a), `anchor ${a} preserved exactly in the fine ladder`);
    assert.strictEqual(mOn.ladder[mOn.ladder.length - 1], anchors.floor, 'the floor is unchanged and still last');
    assert.ok(mOn.ladder.every((p, i) => i === 0 || p < mOn.ladder[i - 1]), 'the fine ladder is strictly descending');

    // (b) NON-allowlisted shipper, same cap -> coarse 3-rung, BYTE-IDENTICAL to buildBandLadder.
    const mOff = engOn.arm(meta('OFF', 'Syngenta', { revisionLimit: 10, minDecrement: 100 }), BAND);
    if (mOff.timer) clearTimeout(mOff.timer);
    assert.deepStrictEqual(mOff.ladder, anchors.ladder,
      'un-allowlisted shipper stays byte-identical on the deployed 3-anchor ladder (reversibility)');

    // (c) allowlisted shipper but a COARSE (<=3) platform cap -> still 3-rung (KEI/Syngenta shape).
    const mLow = engOn.arm(meta('LOW', 'Havells India Ltd', { revisionLimit: 3, minDecrement: 100 }), BAND);
    if (mLow.timer) clearTimeout(mLow.timer);
    assert.deepStrictEqual(mLow.ladder, anchors.ladder,
      'a <=3-cap load stays 3-rung even for an allowlisted shipper (coarse -> always-floor snipe)');

    // (d) allowlisted shipper but UNKNOWN cap (no rules) -> coarse (fail closed to today's ladder).
    const mUnknown = engOn.arm(meta('UNK', 'Havells India Ltd', null), BAND);
    if (mUnknown.timer) clearTimeout(mUnknown.timer);
    assert.deepStrictEqual(mUnknown.ladder, anchors.ladder,
      'an unknown-cap load stays 3-rung even for an allowlisted shipper (fail closed)');

    // (e) auto (rungCap 0): WIDE band binds on the PLATFORM cap (30), not a fixed count.
    //     span 4460 / minDec 100 -> headroom 45; min(30, 45, 40) = 30.
    const WIDE = { cost: 20_000, marginsPct: [22.6, 17.2, 0.3], minMarginPct: 0.3 };
    const mWide = engOn.arm(meta('WIDE', 'Havells India Ltd', { revisionLimit: 30, minDecrement: 100 }), WIDE);
    if (mWide.timer) clearTimeout(mWide.timer);
    assert.strictEqual(mWide.ladder.length, 30,
      `wide band + 30-bid cap -> 30 rungs (platform cap binds, not an arbitrary fixed count; got ${mWide.ladder.length})`);
    for (const a of buildBandLadder(WIDE).ladder) assert.ok(mWide.ladder.includes(a), `wide-band anchor ${a} preserved`);

    // (f) narrow band: spacing headroom binds instead of the platform cap.
    //     span 1600 / minDec 100 -> headroom 17; min(30, 17, 40) = 17.
    const mTight = engOn.arm(meta('TIGHT', 'Havells India Ltd', { revisionLimit: 30, minDecrement: 100 }), BAND);
    if (mTight.timer) clearTimeout(mTight.timer);
    assert.strictEqual(mTight.ladder.length, 17,
      `narrow band + 30-bid cap -> spacing headroom binds (span/minDec + 1 = 17; got ${mTight.ladder.length})`);

    // (g) an explicit rungCap (> 0) still binds as the operator back-off lever.
    const engCap = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, { rungCap: 8 });
    const mCap = engCap.arm(meta('CAP', 'Havells India Ltd', { revisionLimit: 30, minDecrement: 100 }), WIDE);
    if (mCap.timer) clearTimeout(mCap.timer);
    assert.strictEqual(mCap.ladder.length, 8,
      `an explicitly set rungCap=8 forces 8 rungs (operator back-off lever; got ${mCap.ladder.length})`);
    ok('reversibility spine + auto rung count: platform cap / spacing / explicit knob bind - never an arbitrary default');
  }

  // ============================================================================================
  // 6. THE DECISIVE SHOT IS NEVER ABANDONED WITH BUDGET IN HAND. snipeFired latches only where a bid
  //    LANDED (accepted / throw-proven-committed) or the budget is terminally GONE (cap reject). On
  //    every NOTHING-PLACED outcome it is restored so the shot retries: a NON-cap rejection (the rung
  //    refused for price/state - nothing stands), a transient 429, and a transport throw that read-back
  //    proves did NOT land. The "no bid war" rule is about not improving a LANDED bid (check 4), NOT
  //    about swallowing a refused one. Correct single-shot still holds because an ACCEPTED shot keeps
  //    the latch. (Adversarial-review findings, 2026-07-24.)
  // ============================================================================================
  {
    // (a) a NON-cap rejection of the rank rung (e.g. SP's real bid-difference exceeds our min-decrement
    //     view) places NOTHING - the shot must retry the next fireable rung, not be abandoned. Here rung
    //     1 is refused, then the next rung down clears and WINS (at higher margin than dumping the floor).
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed = [];
    let aCalls = 0;
    eng.adapter.placeBid = async (id, price) => {
      aCalls += 1; placed.push(price);
      if (aCalls === 1) return { accepted: false, reason: 'Bid difference too small.', status: 400, text: 'Bid difference too small.' };
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    await eng._maybeBid(m, state(1_500, 2)); // snipe rung 1 (9700), rejected non-cap -> latch RESTORED
    assert.strictEqual(m.snipeFired, false, 'a non-cap rejection restores the snipe latch (nothing landed - not abandoned)');
    await eng._maybeBid(m, state(1_400, 2)); // retry: the shot walks to the next fireable rung and LANDS
    assert.deepStrictEqual(placed, [9_700, 9_400], 'the refused decisive shot retries the next fireable rung and lands (never abandoned)');
    assert.strictEqual(m.snipeFired, true, 'once a shot actually LANDS, snipeFired latches (single-shot from here)');
    await eng._maybeBid(m, state(1_200, 3)); // more outranked, but the shot landed -> no bid war
    assert.strictEqual(placed.length, 2, 'no further shot once one has landed (single-shot on the LANDED bid)');

    // (b) a transient 429 places nothing -> the snipe latch is restored and the shot retries the SAME rung.
    const eng2 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed2 = [];
    let calls = 0;
    eng2.adapter.placeBid = async (id, price) => {
      calls += 1;
      if (calls === 1) return { accepted: false, reason: 'rate_limited', retryAfterMs: 50 };
      placed2.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    const m2 = armFine(eng2, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 });
    m2.currentRungIndex = 0; m2.firedRungs.add(0); m2.lastBidPrice = 10_000;
    await eng2._maybeBid(m2, state(1_500, 2)); // 429 -> nothing placed, latch restored
    assert.strictEqual(m2.snipeFired, false, 'a 429 restores the snipe latch (nothing was placed)');
    await eng2._maybeBid(m2, state(1_400, 2)); // retry -> lands the same rung
    assert.deepStrictEqual(placed2, [9_700], 'the throttled snipe retries the same rung and lands on the next tick');

    // (c) a transport THROW that read-back proves did NOT land -> latch restored, the shot retries the
    //     SAME rung (Finding 2: also protects the COARSE floor snipe's byte-identity).
    const eng3 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const placed3 = [];
    let cCalls = 0;
    eng3.adapter.placeBid = async (id, price) => {
      cCalls += 1;
      if (cCalls === 1) throw new Error('ECONNRESET'); // transport blip
      placed3.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 4, latencyMs: 20 };
    };
    // read-back after the throw reports revisionsLeft UNCHANGED (== the pre-fire value) -> proves not landed.
    eng3.adapter.getAuctionState = async () => ({ ok: true, myRank: 2, revisionsLeft: 5, closesInMs: 1_400 });
    const m3 = armFine(eng3, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 });
    m3.currentRungIndex = 0; m3.firedRungs.add(0); m3.lastBidPrice = 10_000; m3.revisionsLeft = 5;
    await eng3._maybeBid(m3, state(1_500, 2)); // throw, read-back proves not landed -> latch restored
    assert.strictEqual(m3.snipeFired, false, 'a throw that provably did NOT land restores the snipe latch (Finding 2)');
    await eng3._maybeBid(m3, state(1_400, 2)); // retry -> lands the same rung
    assert.deepStrictEqual(placed3, [9_700], 'the throw-not-landed snipe retries the same rung and lands');
    ok('decisive shot never abandoned: restored + retried on non-cap reject / 429 / throw-not-landed; latched only once it LANDS');
  }

  // ============================================================================================
  // 7. NON-ALLOWLISTED >3-TIER BAND is byte-identical to the DEPLOYED engine at the DECISION layer, not
  //    just the ladder. The rank-driven endgame is gated on the ALLOWLIST, never on ladder LENGTH - so a
  //    customer with a 4+ tier desk band who is NOT opted in must snipe the FLOOR (never a rank-driven
  //    non-floor rung) and step down by the CLOCK schedule, exactly as production. This is the exact case
  //    the earlier `last < 3` (ladder-length) guard silently changed. (Adversarial-review Finding 1.)
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const band = { cost: 20_000, marginsPct: [12, 10, 8, 7, 6.3], minMarginPct: 6.3 };
    const coarse = buildBandLadder(band); // [22400,22000,21600,21400,21260] - 5 rungs, last=4 (>3)
    const meta = (id, companyName, rules) => ({ id, lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName, rules, closesAt: Date.now() + 600_000 });

    // (a) non-allowlisted (Durian) + a >3 cap -> NO fine ladder: the deployed coarse band, unchanged.
    const m = eng.arm(meta('D', 'Durian Industries', { revisionLimit: 10, minDecrement: 100 }), band);
    if (m.timer) clearTimeout(m.timer);
    assert.deepStrictEqual(m.ladder, coarse.ladder,
      'a non-allowlisted >3-tier customer keeps the deployed coarse band (no interpolation)');
    const last = m.ladder.length - 1;
    assert.ok(last >= 3, 'precondition: the desk band is >3 rungs (the case the length-based guard missed)');

    // (b) THE FIX: the final-window snipe fires the always-FLOOR rung, never a rank-driven non-floor rung.
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0];
    const snipe = eng._decide(m, state(1_200, 2)); // final window, outranked L2
    assert.deepStrictEqual(snipe, { price: m.ladder[last], rungIndex: last },
      'non-allowlisted snipe is the always-floor rung with NO snipe:true marker (not a rank-driven non-floor rung)');

    // (c) the step-down (outside the final window) uses the DEPLOYED clock schedule, not selectRung's k-1
    //     jump. At remaining 4000 the clock is deep (rung 3); a rank-driven step for k=2 would be rung 1.
    const m2 = eng.arm(meta('D2', 'Durian Industries', { revisionLimit: 10, minDecrement: 100 }), band);
    if (m2.timer) clearTimeout(m2.timer);
    m2.currentRungIndex = 0; m2.firedRungs.add(0);
    const step = eng._decide(m2, state(4_000, 2)); // outside final window, L2 - clock-deep, not rank-shallow
    assert.strictEqual(step && step.rungIndex, 3, 'non-allowlisted step-down follows the clock schedule (rung 3), not selectRung (rung 1)');
    assert.strictEqual(step.snipe, undefined, 'a deployed step-down carries no snipe marker');
    ok('non-allowlisted >3-tier band is byte-identical to the deployed engine: always-floor snipe + clock step-down (Finding 1)');
  }

  cleanup();
  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
