'use strict';
/**
 * REVERSIBILITY SPINE - the rank-driven-rungs branch's core rollout guarantee.
 *
 * On merge, NOTHING changes for any non-allowlisted customer. The new rank-driven endgame (fine
 * anchor-preserving ladder + establish-late + rank-aware snipe + k-driven step-down) is gated
 * EXCLUSIVELY on softStrategy !== 'off' - i.e. soft-close ENABLED *and* this shipper on
 * softCfg.shippers (the word-boundary tokenMatch allowlist). It is NEVER gated on ladder length,
 * NEVER on revisionLimit alone. Every customer off the allowlist runs the DEPLOYED (Module-1)
 * RUNG logic byte-for-byte: clock-scheduled _scheduledRungIndex step-downs, the always-floor snipe,
 * and a plain 3-anchor buildBandLadder with no interpolation. That is what makes this deploy safe to
 * ship dark - a leak here would change live-money behaviour for KEI / Syngenta / Cords Cable without
 * anyone deciding it.
 *
 * ONE EXCEPTION, deliberate and dated: a non-allowlisted SOFT-close load no longer establishes
 * immediately (CW-209, 2026-09-08). It used to bid rung 0 on the first tick at any remaining, which
 * put every GoComet load's opening price on the board seconds after the desk typed a rate. It now
 * holds to the softOpenAtMs mark. The rung logic above is unchanged - only WHEN the first bid goes
 * out moved - and hard-close loads are untouched. Case 2 below pins both halves of that.
 *
 * This file pins the leak surfaces the sibling scripts/test-rank-driven-endgame.js check 7 does NOT
 * cover. Check 7 pins ONE case (a non-allowlisted >3-tier band - Durian - is byte-identical at the
 * decision layer; Adversarial-review Finding 1, 2026-07-24). Here we pin the remaining surfaces of the
 * SAME single guarantee. The gate under test lives in bidEngine.js: _resolveSoftStrategy (soft off
 * unless enabled + allowlisted), _deriveRungCount (null -> coarse buildBandLadder unless every gate
 * opens), and _decide's `rankDriven = monitor.softStrategy !== 'off'` split.
 *
 *   Tracker: branch feat/rank-driven-rungs; reversibility spine = bidEngine.js _deriveRungCount +
 *            _decide rankDriven gate; sibling test-rank-driven-endgame.js check 7 (Finding 1).
 *
 * Trace-comparison approach (as check 7): capture the sequence of placed prices (the WIRE - the byte
 * that reaches SuperProcure) and a per-poll price-or-HOLD trace, and assert deep equality against the
 * independently-computed DEPLOYED contract (clock step-downs + always-floor snipe). The adapter is the
 * ONLY mocked seam. Offline and deterministic: fake adapter, memory-backed scheduler, no timers, no
 * network, injected rand.
 *
 *   node scripts/test-reversibility-spine.js
 */
process.env.LOG_LEVEL = 'silent'; // pin returned values/traces, not log lines; keep PASS output clean

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
const tmp = () => { const f = path.join(os.tmpdir(), `revspine-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// Rank-only adapter (SuperProcure shape): standing prices invisible, minDecrement 100, 30-revision cap,
// close model unknown until a socket frame says otherwise. mkEngine's config pins openAtMs 25000 (the
// establish mark) and floorWindowMs 2500 (the last-chance floor window) so the clock schedule and the
// snipe window are deterministic. rand injected so the establish jitter is fixed (openJitterMs is 0
// anyway, so the mark is exactly openAtMs).
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
    rand: () => 0,
  });
}

// Arm a real monitor via the true arm() path (so the ladder is the one arm actually builds), then kill
// its self-scheduled tick timer - the tests drive the decision loop synchronously, not off a clock.
function armCo(eng, id, companyName, rules, band) {
  const meta = { id, lane: { origin: 'A', destination: 'B' }, units: 1, companyName, rules, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, band);
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

// One live-state read: closing countdown (ms), our own rank (null in the ~1.15s blind window after the
// establishing bid, 1 = winning), and the per-load bid difference. Rank-only, so no standing L1 price.
const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// Drive the real fire path (_maybeBid) poll by poll against the mocked adapter seam, capturing the WIRE
// (placed prices) and a per-poll price-or-HOLD trace. state.myRank drives the decision; the adapter's
// accepted response advances the monitor exactly as a live accept would.
async function fireSeq(eng, m, polls) {
  const wire = [];
  const trace = [];
  eng.adapter.placeBid = async (id, price) => { wire.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; };
  for (const p of polls) {
    const before = wire.length;
    await eng._maybeBid(m, state(p.remaining, p.rank, p.minDecrement));
    trace.push(wire.length > before ? wire[wire.length - 1] : 'HOLD');
  }
  return { wire, trace };
}

// Fixtures. A 3-anchor desk band (the KEI / Syngenta shape), a 5-anchor desk band, and a WIDE-span
// 3-anchor band whose rupee span (4460) would interpolate to ~30 rungs IF the allowlist gate ever
// leaked - so "still 3 rungs" is a load-bearing assertion for it.
const B3 = { cost: 20_000, marginsPct: [12, 8, 4], minMarginPct: 4 };       // -> [22400, 21600, 20800]
const W5 = { cost: 20_000, marginsPct: [12, 10, 8, 6, 4], minMarginPct: 4 }; // -> [22400,22000,21600,21200,20800]
const WIDE = { cost: 20_000, marginsPct: [22.6, 17.2, 0.3], minMarginPct: 0.3 }; // -> [24520, 23440, 20060]

(async () => {
  // ============================================================================================
  // 1. HARD_CLOSE_UNCHANGED. A 3-anchor hard-close customer (KEI-like), soft entirely OFF, driven
  //    through a full auction with the rank MOVING (2 -> 5 -> 5). The wire is the deployed contract:
  //    establish -> one clock step -> hold (floor reserved) -> always-floor snipe -> hold. The rank
  //    movement must NOT influence a single rung choice (the step-down is clock-driven,
  //    _scheduledRungIndex), and no rank-driven marker (snipe / defend) is ever set.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: false }); // soft-close disabled: pure Module-1
    const m = armCo(eng, 'hard-kei', 'KEI Industries', { revisionLimit: 3, minDecrement: 100 }, B3);
    assert.strictEqual(m.softStrategy, 'off', 'a soft-disabled hard load resolves softStrategy off');

    const { wire, trace } = await fireSeq(eng, m, [
      { remaining: 20_000, rank: null }, // establish at the openAtMs mark (rank not yet online)
      { remaining: 13_750, rank: 2 },    // outranked -> clock step to rung 1
      { remaining: 5_000, rank: 5 },     // more outranked, but the clock reserves the floor -> HOLD
      { remaining: 2_000, rank: 5 },     // last-chance -> always-floor snipe (rung 2)
      { remaining: 1_500, rank: 5 },     // floor already fired -> HOLD (single shot)
    ]);
    assert.deepStrictEqual(wire, [22_400, 21_600, 20_800],
      'deployed wire: establish 22400 -> clock step 21600 -> floor snipe 20800, byte-for-byte');
    assert.deepStrictEqual(trace, [22_400, 21_600, 'HOLD', 20_800, 'HOLD'],
      'the poll trace matches the deployed contract even as rank moves 2 -> 5 -> 5 (rungs are clock-driven, not rank-driven)');
    assert.strictEqual(m.snipeFired, false, 'the deployed floor snipe sets no rank-aware snipe latch (single-shot comes from firedRungs)');
    assert.strictEqual(m._lastDefendAtExtend, null, 'no soft once-per-round defend ever fired on the deployed hard path');
    ok('hard_close_unchanged: 3-anchor KEI-like load runs the deployed clock step-down + always-floor snipe; rank movement never moves a rung');
  }

  // ============================================================================================
  // 2. SOFT_FLAG_OFF_SHIPPER. Soft-close globally ENABLED but this shipper is NOT on the allowlist,
  //    on a soft-close load. It must run the DEPLOYED soft path: a clock step-down, then the
  //    always-floor snipe. Zero rank-driven defends, no extension-round latch, no rank-aware endgame.
  //
  //    The ESTABLISH is the one thing here that is no longer the deployed answer, and the change is
  //    deliberate (CW-209). This branch used to fire rung 0 at ANY remaining, which is why every
  //    GoComet load - closeModel 'soft' by static capability, no GoComet shipper ever allowlisted -
  //    put its opening price on the board seconds after the desk typed a rate: 376 of 504 bid more
  //    than an hour before close. It now holds to the softOpenAtMs mark. Everything downstream of
  //    the establish is untouched, and this case still pins that.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live' });
    const m = armCo(eng, 'soft-off-syngenta', 'Syngenta', { revisionLimit: 3, minDecrement: 100 }, B3);
    m.closeModel = 'soft'; // the branch runtime-reports soft close...
    assert.strictEqual(m.softStrategy, 'off', '...but an un-allowlisted shipper still resolves softStrategy off (opt-in, never blanket)');

    // DELIBERATE CHANGE (CW-209): 200s out is now a HOLD. rand is pinned to 0 here, so the mark is
    // exactly softOpenAtMs with no jitter, and 200_000 sits outside it. This load publishes no
    // trigger window, so nothing raises the mark above it. On the deployed engine this returned rung 0.
    const softOpenAt = eng._softEstablishThreshold(m);
    assert.strictEqual(softOpenAt, 150_000, 'zero jitter and no published window put the mark exactly at softOpenAtMs');
    assert.strictEqual(eng._decide(m, state(200_000, null)), null,
      'non-allowlisted soft load HOLDS outside the closing window - it used to establish at any remaining (CW-209)');

    // ...and it establishes at the same rung, the same price, on the first poll inside the mark.
    const est = eng._decide(m, state(149_000, null));
    assert.deepStrictEqual(est, { price: m.ladder[0], rungIndex: 0 },
      'inside the mark the establish is the deployed one: rung 0 at the opening price');

    const { wire, trace } = await fireSeq(eng, m, [
      { remaining: 200_000, rank: null }, // outside the mark -> HOLD (CW-209)
      { remaining: 149_000, rank: null }, // inside the mark -> establish
      { remaining: 13_750, rank: 2 },    // clock step to rung 1
      { remaining: 2_000, rank: 2 },     // always-floor snipe
      { remaining: 1_500, rank: 2 },     // HOLD
    ]);
    assert.deepStrictEqual(wire, [22_400, 21_600, 20_800],
      'the WIRE is still byte-identical to Module-1 - same three prices, same order; only WHEN the first one goes out moved');
    assert.deepStrictEqual(trace, ['HOLD', 22_400, 21_600, 20_800, 'HOLD'],
      'the poll trace is the deployed contract with one hold in front of it (CW-209)');
    assert.strictEqual(m._lastDefendAtExtend, null, 'no once-per-extension-round soft defend ever engaged (the soft-defend branch is gated on softStrategy != off)');
    assert.strictEqual(m.extendsObserved, 0, 'no extension-round latching behaviour is visible on the deployed path');
    ok('soft_flag_off_shipper: soft globally on but shipper off the allowlist -> establish held to the closing window, then deployed clock step + always-floor snipe, zero rank-driven defends');
  }

  // ============================================================================================
  // 3. ALLOWLISTED_BUT_COARSE. Shipper ON the allowlist but the platform bid cap is coarse
  //    (revisionLimit 3): the ladder must stay the exact 3-anchor buildBandLadder (_deriveRungCount ->
  //    null), and the final snipe must still be the FLOOR (selectRung's `last < 3` coarse guard). Being
  //    opted in alone must expand NOTHING on a <=3-cap load.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live' });
    const m = armCo(eng, 'allow-coarse', 'Havells India Ltd', { revisionLimit: 3, minDecrement: 100 }, B3);
    assert.strictEqual(m.softStrategy, 'live', 'the allowlisted shipper IS soft-enabled (rankDriven), so this is not a soft-off masking of the effect');
    assert.deepStrictEqual(m.ladder, buildBandLadder(B3).ladder,
      'a <=3-cap load keeps the exact 3-anchor buildBandLadder even for an allowlisted shipper (no interpolation)');
    assert.strictEqual(eng._deriveRungCount(B3, { revisionLimit: 3, minDecrement: 100 }, 'Havells India Ltd'), null,
      'the rung-count derivation returns null (coarse) on a <=3 cap regardless of the allowlist');

    // The rank-aware snipe still collapses to the floor on a coarse (<3-rung) ladder: same WIRE as the
    // deployed always-floor snipe. (The internal decision may carry snipe:true - floor-equivalent - but
    // the rung/price that reaches SuperProcure is the floor either way.)
    const last = m.ladder.length - 1;
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0];
    const snipe = eng._decide(m, state(1_500, 2)); // last-chance, outranked L2, allowlisted
    assert.strictEqual(snipe.rungIndex, last, 'the coarse-guard snipe fires the FLOOR rung, never a rank-driven non-floor rung');
    assert.strictEqual(snipe.price, m.ladder[last], 'the snipe price is the floor - byte-identical wire to the deployed always-floor snipe');
    ok('allowlisted_but_coarse: allowlist alone expands nothing on a <=3-cap load - coarse 3-anchor ladder + always-floor snipe');
  }

  // ============================================================================================
  // 4. DEFAULT_CONFIG_INERT. Constructed with ALL soft/rung knobs absent (the "deploy dark" belt): the
  //    defaults must be soft OFF, rungCap 0, jumpPerRival 1, establishLeadMs 40000. Under that default
  //    engine, both a hard and a soft load run the deployed path, and even a wide-band high-cap load
  //    gets NO fine ladder (the allowlist gate is closed because soft-close is disabled).
  // ============================================================================================
  {
    const eng = mkEngine(); // no softClose opts at all -> DEFAULT_SOFT
    assert.strictEqual(eng.softCfg.enabled, false, 'default soft-close is OFF (fail closed)');
    assert.strictEqual(eng.cfg.rungCap, 0, 'default rungCap is 0 (auto, no fixed grid)');
    assert.strictEqual(eng.softCfg.jumpPerRival, 1, 'default jumpPerRival is 1');
    assert.strictEqual(eng.softCfg.establishLeadMs, 40_000, 'default establishLeadMs is 40000');

    // A wide-band, high-cap load still gets the coarse ladder under default config (allowlist gate closed).
    const mWide = armCo(eng, 'default-wide', 'Renewsys', { revisionLimit: 30, minDecrement: 100 }, W5);
    assert.deepStrictEqual(mWide.ladder, buildBandLadder(W5).ladder,
      'default config: a wide-band 30-cap load stays the exact coarse buildBandLadder (deploy dark changes no ladder)');
    assert.strictEqual(eng._deriveRungCount(W5, { revisionLimit: 30, minDecrement: 100 }, 'Renewsys'), null,
      'default config: rung-count derivation is null for every shipper (soft-close disabled closes the gate)');
    assert.strictEqual(mWide.softStrategy, 'off', 'default config resolves softStrategy off for every shipper');

    // Hard load: establish is gated on the openAtMs mark, deployed timing.
    const mHard = armCo(eng, 'default-hard', 'KEI Industries', { revisionLimit: 3, minDecrement: 100 }, B3);
    assert.strictEqual(eng._decide(mHard, state(26_000, null)), null, 'default hard load holds outside the establish mark (margin hidden)');
    assert.deepStrictEqual(eng._decide(mHard, state(20_000, null)), { price: mHard.ladder[0], rungIndex: 0 },
      'default hard load establishes at rung 0 once inside the openAtMs mark (deployed)');

    // Soft load: gated on the softOpenAtMs mark, NOT the allowlisted establish-late rule. The mark is
    // wider than the hard one because a soft portal's write and read budgets are wider (CW-209); the
    // rung and price it establishes at are the deployed ones.
    const mSoft = armCo(eng, 'default-soft', 'Syngenta', { revisionLimit: 3, minDecrement: 100 }, B3);
    mSoft.closeModel = 'soft';
    assert.strictEqual(eng.cfg.softOpenAtMs, 150_000, 'default softOpenAtMs is 150000');
    assert.strictEqual(eng._decide(mSoft, state(200_000, null)), null,
      'default soft load holds outside the softOpenAtMs mark - it used to establish at any remaining (CW-209)');
    assert.deepStrictEqual(eng._decide(mSoft, state(149_000, null)), { price: mSoft.ladder[0], rungIndex: 0 },
      'default soft load establishes at rung 0 once inside the mark - the deployed rung, later');
    ok('default_config_inert: bare-default engine builds no fine ladder and runs the deployed rung logic for hard AND soft loads; the soft first-bid TIME is the one deliberate change (CW-209)');
  }

  // ============================================================================================
  // 5. LADDER_NULL_DERIVE_BYTE_PARITY. Every arm whose _deriveRungCount returns null must produce a
  //    plan.ladder that deep-equals buildBandLadder EXACTLY - same values, same length, no interpolation
  //    artifacts. Uses the 5-anchor band so an accidental interpolation would visibly insert rungs
  //    between the anchors (length > 5).
  // ============================================================================================
  {
    const anchors = buildBandLadder(W5).ladder; // 5 rungs
    const engOff = mkEngine({ enabled: false });
    const engOn = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live' });

    const arms = [
      // [engine, id, company, rules, why-null]
      [engOff, 'byte-disabled', 'Renewsys', { revisionLimit: 30, minDecrement: 100 }, 'soft-close disabled'],
      [engOn, 'byte-unlisted', 'Syngenta', { revisionLimit: 30, minDecrement: 100 }, 'shipper not on allowlist'],
      [engOn, 'byte-lowcap', 'Havells India Ltd', { revisionLimit: 3, minDecrement: 100 }, 'allowlisted but cap <= 3'],
      [engOn, 'byte-unknowncap', 'Havells India Ltd', null, 'allowlisted but unknown cap (no rules)'],
    ];
    for (const [eng, id, co, rules, why] of arms) {
      const m = armCo(eng, id, co, rules, W5);
      assert.deepStrictEqual(m.ladder, anchors,
        `null-derive arm (${why}) is byte-identical to buildBandLadder - no interpolation artifacts`);
      assert.strictEqual(m.ladder.length, anchors.length, `null-derive arm (${why}) keeps the exact anchor count (${anchors.length})`);
    }
    ok('ladder_null_derive_byte_parity: every null-derive arm returns buildBandLadder byte-for-byte (same values + length, no interpolation)');
  }

  // ============================================================================================
  // 6. REVISION_LIMIT_ALONE_NO_LEAK. A soft-OFF shipper on a WIDE-span band with a HIGH bid cap
  //    (revisionLimit 30). A high cap and a wide span would interpolate to ~30 rungs IF the gate ever
  //    keyed off cap/span/ladder-length instead of the allowlist. It must NOT: the ladder stays the
  //    exact 3-anchor buildBandLadder and the decision path stays deployed (clock step + always-floor
  //    snipe with no snipe marker). This is the exact adversarial finding this branch already had once
  //    (ladder-length / limit gating leaking behaviour - Finding 1).
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live' });
    const m = armCo(eng, 'revlimit-kei', 'KEI Industries', { revisionLimit: 30, minDecrement: 100 }, WIDE);
    assert.strictEqual(m.softStrategy, 'off', 'the wide-band high-cap shipper is still off the allowlist -> softStrategy off');
    assert.deepStrictEqual(m.ladder, buildBandLadder(WIDE).ladder,
      'a revisionLimit-30 wide-span load stays the exact 3-anchor buildBandLadder (limit/span never expands it)');
    assert.strictEqual(m.ladder.length, 3, 'STILL 3 rungs despite a 30-bid cap and a 4460 rupee span (an allowlisted load here would be ~30 rungs)');
    assert.strictEqual(eng._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: 100 }, 'KEI Industries'), null,
      'the allowlist gate - not the cap or the span - is what returns null here');

    const last = m.ladder.length - 1;
    // Deployed always-floor snipe: floor rung, NO snipe marker (byte-identical decision object to prod).
    const mSnipe = armCo(eng, 'revlimit-snipe', 'KEI Industries', { revisionLimit: 30, minDecrement: 100 }, WIDE);
    mSnipe.currentRungIndex = 0; mSnipe.firedRungs.add(0); mSnipe.lastBidPrice = mSnipe.ladder[0];
    assert.deepStrictEqual(eng._decide(mSnipe, state(1_500, 2)), { price: mSnipe.ladder[last], rungIndex: last },
      'the snipe is the deployed always-floor rung with NO snipe:true marker (not a rank-driven non-floor rung)');

    // Deployed step-down: the clock rung, NO defend/snipe marker.
    const mStep = armCo(eng, 'revlimit-step', 'KEI Industries', { revisionLimit: 30, minDecrement: 100 }, WIDE);
    mStep.currentRungIndex = 0; mStep.firedRungs.add(0);
    const step = eng._decide(mStep, state(13_750, 2)); // outside the final window, outranked
    assert.strictEqual(step.rungIndex, 1, 'the step-down follows the clock schedule (rung 1), not a rank-driven jump');
    assert.strictEqual(step.snipe, undefined, 'a deployed step-down carries no snipe marker');
    assert.strictEqual(step.defend, undefined, 'a deployed step-down carries no once-per-round defend marker');
    ok('revision_limit_alone_no_leak: a high revisionLimit + wide span never leaks rank behaviour without the allowlist - 3-anchor ladder + deployed snipe/step (Finding 1)');
  }

  // ============================================================================================
  // 7. RANK_FEED_IGNORED_WHEN_OFF. A soft-OFF customer on a 5-anchor band, where a rank-driven step
  //    WOULD differ sharply from the clock step (at 18s remaining the clock is rung 1, but a rank-5
  //    step - 4 rivals ahead - would jump to rung 3). Driving the identical poll timings with rank held
  //    at 5, then 2, then 8, must yield the IDENTICAL wire every time: the deployed step-down is
  //    clock-driven and never reads the rank value. Rank still gates only hold-while-winning (k==1) and
  //    the blind-window hold (k==null), neither of which is exercised here.
  // ============================================================================================
  {
    const anchors = buildBandLadder(W5).ladder; // [22400,22000,21600,21200,20800]
    const polls = (R) => ([
      { remaining: 20_000, rank: null }, // establish rung 0 (rank not yet online)
      { remaining: 18_000, rank: R },    // clock rung 1 (22000); a rank-5 step would be rung 3 (21200)
      { remaining: 12_000, rank: R },    // clock rung 2
      { remaining: 6_000, rank: R },     // clock rung 3
      { remaining: 2_000, rank: R },     // always-floor snipe (rung 4)
      { remaining: 1_500, rank: R },     // HOLD
    ]);
    const expected = [22_400, 22_000, 21_600, 21_200, 20_800];

    const runs = {};
    for (const R of [5, 2, 8]) {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live' });
      const m = armCo(eng, 'rankfeed-' + R, 'Cords Cable', { revisionLimit: 30, minDecrement: 100 }, W5);
      assert.strictEqual(m.softStrategy, 'off', 'soft-off customer (Cords Cable not on the allowlist)');
      assert.deepStrictEqual(m.ladder, anchors, 'the soft-off customer keeps the coarse 5-anchor ladder (no interpolation)');
      runs[R] = (await fireSeq(eng, m, polls(R))).wire;
    }
    // The distinguishing byte: at 18s remaining with rank 5, the fired price is the CLOCK rung (22000),
    // never the rank-5 rung (21200). If the rank value leaked into rung choice this would be 21200.
    assert.strictEqual(runs[5][1], 22_000, 'rank 5 fires the clock rung (22000) at 18s, not the rank-driven rung');
    assert.notStrictEqual(runs[5][1], 21_200, 'rank 5 does NOT fire the rank-driven (4-rivals-ahead) rung (21200)');
    assert.deepStrictEqual(runs[5], expected, 'rank 5 produces the deployed clock wire end-to-end');
    assert.deepStrictEqual(runs[2], runs[5], 'rank 2 produces the identical wire (rank value ignored on the deployed path)');
    assert.deepStrictEqual(runs[8], runs[5], 'rank 8 produces the identical wire (rank value ignored on the deployed path)');
    ok('rank_feed_ignored_when_off: a soft-off customer bids the same clock wire whether rank reads 2, 5, or 8 - the rank feed never moves a rung');
  }

  cleanup();
  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
