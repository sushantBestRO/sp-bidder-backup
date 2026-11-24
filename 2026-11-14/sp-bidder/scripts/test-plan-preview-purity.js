'use strict';
/**
 * planPreview PURITY + sim soft-close forwarding EDGE CASES.
 *
 * Two seams, one file:
 *
 *   A. bidEngine.planPreview(meta, inputs) - the side-effect-free planner that feeds the /price page
 *      preview. Contract: it runs the SAME _planFor / _deriveRungCount gates arm() runs, returns
 *      { ladder (a detached COPY), floor, rungCount }, and must be PURE - no monitor created, no engine
 *      state mutated, no scheduler intent written, no crash on a null/absent meta. The preview must not be
 *      able to drift from what a real arm() would produce (checks 1, 5), and must not be able to corrupt a
 *      later arm() by handing out a live internal array (check 1).
 *
 *   B. The sim soft-close forwarding EDGES that test-sim-softclose-forwarding.js does not cover. That
 *      file pins the PRESENCE path (all six fields forwarded when set). Here we pin the HONESTY edges the
 *      engine's fail-closed soft-close logic depends on:
 *        - an UNKNOWN extension cap is reported null, never a fabricated finite default (check 8),
 *        - a ZERO cap survives the wire as 0, not collapsed to null by a falsy `|| null` (check 9),
 *        - a cap of 1 consumed after exactly one observed extension flips the engine to effectively-hard
 *          and engages the genuinely-final snipe (check 10).
 *
 * Offline and deterministic: fake adapter for the engine, injected-clock AuctionSim + MockSuperProcure
 * adapter for the sim seam, memory-backed scheduler, no real timers on the money path.
 *
 * READ-ONLY on the impl: this file requires bidEngine / auctionSim / mockAdapter and never edits them.
 *
 *   node scripts/test-plan-preview-purity.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder } = require('../src/engine/pricing');
const { AuctionSim } = require('../src/sim/auctionSim');
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `plan-preview-purity-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A soft-strategy engine (same construction pattern as test-rank-driven-endgame.js): rank-only caps,
// 30-revision default, minDecrement 100. Havells is the single allowlisted shipper.
function mkEngine(cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
  });
}

// meta builder for the /price preview + arm parity checks.
const meta = (id, rules, companyName = 'Havells India Ltd') => ({
  id, lane: { origin: 'A', destination: 'B' }, units: 1, companyName, rules, closesAt: Date.now() + 600_000 });

// Bands with a KNOWN shape (verified against buildBandLadder):
//   WIDE  -> anchors [24520, 23440, 20060], floor 20060; a 30-cap fine ladder expands to exactly 30 rungs.
//   BAND3 -> anchors [22400, 21600, 20800], floor 20800; a 3-anchor coarse ladder.
const WIDE = { cost: 20_000, marginsPct: [22.6, 17.2, 0.3], minMarginPct: 0.3 };
const BAND3 = { cost: 20_000, marginsPct: [12, 8, 4], minMarginPct: 4 };

// Arm a SOFT Havells monitor and reset the extension-observation fields to UNKNOWN, so the engine must
// LEARN the cap + absolute close from adapter.getAuctionState (the sim seam) rather than a hand-set value.
// Mirrors armFine's post-establish override discipline from test-rank-driven-endgame.js.
function armSoftLearner(eng, id, ladder) {
  const m = eng.arm(meta(id, { revisionLimit: 30, minDecrement: 100 }, 'Havells'), { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = null;         // UNKNOWN until getAuctionState surfaces it
  m.believedCloseAt = null;   // seeded by the first observation's closesAtMs
  m.extendsObserved = 0;
  m.triggerWindowMs = null;
  return m;
}

// A synthetic live-state for _decide (same shape as the state() helper in test-rank-driven-endgame.js).
const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// A lane with generous headroom so US bids never brush the (randomised) ceiling (matches
// test-sim-softclose-forwarding.js).
const LANE = { origin: 'Bhiwandi, MH', destination: 'Hosur, TN', equipment: '32ft SXL', weight: 15, baseRate: 100_000 };

(async () => {
  // ============================================================================================
  // 1. PREVIEW RETURNS A DETACHED COPY. Mutating the array planPreview hands back must not (a) truncate
  //    what the caller sees vs rungCount, (b) drop the floor, or (c) corrupt a later arm() of the same
  //    load. Catches: dropped `.slice()` REPLACED BY a shared-reference reuse in arm; a `.slice(1)` /
  //    `.slice(0,-1)` arg mutation; rungCount computed off a different array than the one returned.
  // ============================================================================================
  {
    // Arrange: an allowlisted shipper on a 30-cap load -> a 30-rung fine ladder (long enough that a
    // truncation or a leaked-junk mutation is unmistakable).
    const eng = mkEngine();
    const m1 = meta('COPY', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd');

    // Act: preview, snapshot a pristine copy, then vandalise the returned ladder, THEN arm the same load.
    const preview = eng.planPreview(m1, WIDE);
    const pristine = preview.ladder.slice();
    preview.ladder.push(999999);
    preview.ladder[0] = -1;
    const armed = eng.arm(m1, WIDE);
    if (armed.timer) clearTimeout(armed.timer);

    // Assert: the returned ladder covered the WHOLE plan (length parity with rungCount) and ended at the
    // floor - so a `.slice(1)` or `.slice(0,-1)` on the copy would have been caught.
    assert.strictEqual(pristine.length, preview.rungCount,
      `returned ladder length (${pristine.length}) must equal rungCount (${preview.rungCount}) - the copy covers the whole plan`);
    assert.strictEqual(pristine[pristine.length - 1], preview.floor,
      `returned ladder must end at the floor (${preview.floor}), got ${pristine[pristine.length - 1]}`);
    // Assert: the vandalism did NOT reach the armed plan - arm() built its own fresh ladder.
    assert.deepStrictEqual(armed.ladder, pristine,
      'arming the same load after mutating the preview array yields the pristine ladder (preview handed out a detached copy)');
    assert.ok(!armed.ladder.includes(999999), 'junk pushed into the preview array never leaked into the armed ladder');
    assert.strictEqual(armed.ladder[0], pristine[0],
      `overwriting preview.ladder[0] with -1 did not corrupt the armed opening rung (${pristine[0]})`);
    ok('preview returns a detached copy: mutating it cannot truncate the caller view or corrupt a later arm');
  }

  // ============================================================================================
  // 2. PREVIEW IS IDEMPOTENT. Ten identical calls return byte-identical results. Catches any hidden
  //    per-call state (a counter, an in-place sort of rules/marginsPct, a memo that drifts).
  // ============================================================================================
  {
    // Arrange
    const eng = mkEngine();
    const m2 = meta('IDEM', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd');

    // Act: 10 consecutive identical previews.
    const first = eng.planPreview(m2, WIDE);
    // Assert: every subsequent call deep-equals the first, field by field.
    for (let i = 0; i < 10; i++) {
      const p = eng.planPreview(m2, WIDE);
      assert.deepStrictEqual(p.ladder, first.ladder, `call ${i + 1}: ladder identical to the first preview`);
      assert.strictEqual(p.floor, first.floor, `call ${i + 1}: floor identical (${first.floor})`);
      assert.strictEqual(p.rungCount, first.rungCount, `call ${i + 1}: rungCount identical (${first.rungCount})`);
    }
    ok('preview is idempotent: 10 identical calls return byte-identical ladder / floor / rungCount');
  }

  // ============================================================================================
  // 3. PREVIEW CREATES NO MONITOR AND NO INTENT. A load that is only ever previewed must not show up as
  //    armed anywhere the operator or the stop-all loops read (snapshot, monitors, scheduler intents).
  //    Catches: planPreview accidentally routed through arm()/schedule() (a side effect).
  // ============================================================================================
  {
    // Arrange: fresh engine, nothing armed.
    const eng = mkEngine();
    assert.strictEqual(eng.monitors.size, 0, 'precondition: no monitors before any preview');
    assert.strictEqual(eng.snapshot().length, 0, 'precondition: empty snapshot before any preview');
    assert.strictEqual(eng.scheduler.activeIntents().length, 0, 'precondition: no scheduler intents before any preview');

    // Act: preview a load that WOULD arm to a 30-rung fine monitor if arm() had been called.
    eng.planPreview(meta('NOMON', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd'), WIDE);

    // Assert: still nothing armed, nothing scheduled, nothing in the snapshot.
    assert.strictEqual(eng.monitors.size, 0, 'no monitor created by planPreview');
    assert.strictEqual(eng.scheduler.activeIntents().length, 0, 'no scheduler intent written by planPreview');
    assert.ok(!eng.snapshot().some((r) => r.auctionId === 'NOMON'), 'previewed load never appears in snapshot()');
    ok('preview creates no monitor and no scheduler intent (nothing armed by a preview)');
  }

  // ============================================================================================
  // 4. PREVIEW DOES NOT DRIFT ENGINE STATE. A batch of varied previews (allowlisted / non-allowlisted,
  //    different caps, different cost/margins) leaves an EXISTING armed monitor's snapshot byte-identical.
  //    Catches: planPreview mutating a shared config (this.cfg.rungCap), the armed monitor's ladder, or
  //    the softCfg allowlist as a side effect of resolving the strategy.
  // ============================================================================================
  {
    // Arrange: one real armed monitor whose 30-rung ladder makes the snapshot non-trivial to compare.
    const eng = mkEngine();
    const armed = eng.arm(meta('KEEP', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    if (armed.timer) clearTimeout(armed.timer);
    const before = JSON.stringify(eng.snapshot());

    // Act: a batch of previews spanning every derive branch and different pricing inputs.
    eng.planPreview(meta('B1', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    eng.planPreview(meta('B2', { revisionLimit: 3, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    eng.planPreview(meta('B3', { revisionLimit: 30, minDecrement: 100 }, 'Globex Zzz Corp'), BAND3);
    eng.planPreview(meta('B4', undefined, 'Havells India Ltd'), BAND3);
    eng.planPreview(meta('B5', { revisionLimit: 30, minDecrement: 500 }, 'Havells India Ltd'),
      { cost: 55_000, marginsPct: [15, 9, 3], minMarginPct: 3 });
    eng.planPreview(undefined, WIDE);

    // Assert: the snapshot is byte-identical - no varied preview leaked into engine state.
    assert.strictEqual(JSON.stringify(eng.snapshot()), before,
      'a batch of varied previews leaves the armed monitor snapshot byte-identical (no state drift)');
    ok('preview does not drift engine state: an armed monitor is untouched by a batch of varied previews');
  }

  // ============================================================================================
  // 5. RUNG-COUNT DERIVE PARITY. On an allowlisted shipper the preview's rungCount matches the derive
  //    contract exactly (30-cap -> expanded; 3-cap -> 3 anchors; unknown-cap -> 3 anchors, fail closed),
  //    AND equals what a real arm() of the same load produces. Catches: an off-by-one in the derived
  //    count, the LOW_CAP_THRESHOLD gate, the fail-closed null path, and any preview/arm divergence.
  // ============================================================================================
  {
    const eng = mkEngine();

    // (a) 30-cap allowlisted -> the fine ladder expands to EXACTLY 30 rungs (platform cap binds on WIDE).
    const p30 = eng.planPreview(meta('R30', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    assert.strictEqual(p30.rungCount, 30, `allowlisted 30-cap WIDE band -> 30 expanded rungs, got ${p30.rungCount}`);
    assert.strictEqual(p30.floor, 20060, `expanded ladder keeps the WIDE floor 20060, got ${p30.floor}`);
    // Parity: an actual arm() of the same load produces the SAME ladder (preview cannot drift from arm).
    const armed30 = eng.arm(meta('R30', { revisionLimit: 30, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    if (armed30.timer) clearTimeout(armed30.timer);
    assert.deepStrictEqual(p30.ladder, armed30.ladder, 'preview ladder is byte-identical to the armed ladder (no arm drift)');

    // (b) 3-cap allowlisted -> coarse: the 3 anchors, unchanged (cap <= LOW_CAP_THRESHOLD -> fail closed).
    const p3 = eng.planPreview(meta('R3', { revisionLimit: 3, minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    assert.strictEqual(p3.rungCount, 3, `allowlisted 3-cap -> 3 coarse anchors (<= LOW_CAP_THRESHOLD), got ${p3.rungCount}`);

    // (c) unknown-cap allowlisted -> coarse: 3 anchors (fail closed - no rules.revisionLimit surfaced).
    const pU = eng.planPreview(meta('RU', { minDecrement: 100 }, 'Havells India Ltd'), WIDE);
    assert.strictEqual(pU.rungCount, 3, `allowlisted unknown-cap -> 3 coarse anchors (fail closed), got ${pU.rungCount}`);
    ok('rung-count derive parity: 30-cap expands to 30 (== arm), 3-cap and unknown-cap stay 3 anchors');
  }

  // ============================================================================================
  // 6. UNKNOWN COMPANY -> COARSE, NO CRASH. A shipper not on ANY config (not the allowlist) previews the
  //    3-anchor coarse ladder even with a 30-cap that WOULD expand for an allowlisted shipper. Catches:
  //    the allowlist gate being dropped from _deriveRungCount (an un-opted customer silently expanding).
  // ============================================================================================
  {
    // Arrange + Act: a 30-cap load for a company with no allowlist match.
    const eng = mkEngine();
    const p = eng.planPreview(meta('UNK', { revisionLimit: 30, minDecrement: 100 }, 'Globex Zzz Corporation'), BAND3);

    // Assert: coarse 3-anchor ladder, correct floor, no expansion - the allowlist gate held.
    assert.strictEqual(p.rungCount, 3, `unknown company + 30-cap stays 3 anchors (allowlist gate), got ${p.rungCount}`);
    assert.deepStrictEqual(p.ladder, buildBandLadder(BAND3).ladder, 'unknown company previews the byte-identical coarse band');
    assert.strictEqual(p.floor, 20800, `coarse band floor is 20800, got ${p.floor}`);
    ok('unknown company previews the coarse 3-anchor ladder (allowlist gate holds), no crash');
  }

  // ============================================================================================
  // 7. NULL-SAFE META. planPreview(undefined | {}, band) must not crash on the `meta && meta.rules` /
  //    `meta && meta.companyName` guards, and falls through to the coarse 3-anchor ladder. Catches: the
  //    null-guard being dropped (planPreview throwing a TypeError on a preview with no load metadata).
  // ============================================================================================
  {
    const eng = mkEngine();

    // (a) meta entirely undefined.
    const pNoMeta = eng.planPreview(undefined, BAND3);
    assert.strictEqual(pNoMeta.rungCount, 3, `meta undefined -> 3 coarse anchors, got ${pNoMeta.rungCount}`);
    assert.strictEqual(pNoMeta.floor, 20800, `meta undefined still resolves the band floor 20800, got ${pNoMeta.floor}`);
    assert.deepStrictEqual(pNoMeta.ladder, buildBandLadder(BAND3).ladder, 'meta undefined previews the coarse band exactly');

    // (b) meta present but rules undefined.
    const pNoRules = eng.planPreview({ id: 'X', companyName: 'Havells India Ltd' }, BAND3);
    assert.strictEqual(pNoRules.rungCount, 3, `meta without rules -> 3 coarse anchors (fail closed), got ${pNoRules.rungCount}`);
    ok('null-safe meta: planPreview(undefined | rules-less, band) does not crash and previews the coarse ladder');
  }

  // ============================================================================================
  // 8. SIM HONESTY - UNKNOWN CAP REPORTED NULL, NEVER FABRICATED. A soft load spawned WITHOUT an
  //    extendCap must forward extendCount === null (UNKNOWN), so the engine FAILS CLOSED to
  //    effectively-hard. A fabricated finite default here would make the engine believe there is a known
  //    cap and defend for phantom extension rounds that never come. Complements the PRESENCE path in
  //    test-sim-softclose-forwarding.js (which forwards a finite 2). Catches: `extendCount: a.extendCap
  //    ?? <finite>` / any fabricated cap default; the engine trusting a fabricated cap over fail-closed.
  // ============================================================================================
  {
    // Arrange: a genuinely soft load whose extension cap is UNKNOWN (extendCap omitted -> null).
    const sim = new AuctionSim({ onEvent: () => {} });
    const a = sim.spawn({ lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 60_000,
      minDecrement: 100, revisionLimit: 3 });
    const adapter = new MockSuperProcureAdapter(sim, { transientFailRate: 0 }); // deterministic: no read blip
    await adapter.login();

    // Act: read state through the real adapter forwarding.
    const s = await adapter.getAuctionState(a.id);

    // Assert (seam): the cap is honestly null, never a fabricated finite number.
    assert.strictEqual(s.ok, true, 'state read ok');
    assert.strictEqual(s.closeModel, 'soft', 'the load is genuinely soft-close');
    assert.strictEqual(s.extendCount, null, 'an unconfigured extension cap forwards as null (UNKNOWN), not a fabricated default');
    assert.ok(!Number.isFinite(s.extendCount), 'the UNKNOWN cap is not a finite number (no fabricated cap slipped through)');

    // Assert (engine consumes honestly): a soft monitor fed the null cap stays UNKNOWN and fails closed to
    // effectively-hard - so the final snipe is never deferred waiting on phantom extensions.
    const eng = mkEngine();
    const m = armSoftLearner(eng, a.id, [10_000, 9_400, 8_000]);
    eng._observeExtension(m, s);
    assert.strictEqual(m.extendCap, null, 'the engine leaves extendCap UNKNOWN (null) when the wire reports null');
    assert.strictEqual(eng._effectivelyHard(m), true,
      'an UNKNOWN cap fails closed to effectively-hard (Module-1 snipe), never a phantom-extension wait');
    ok('sim honesty: an unknown extension cap forwards null and the engine fails closed (no fabricated cap)');
  }

  // ============================================================================================
  // 9. SIM HONESTY - A ZERO CAP SURVIVES AS 0. A soft load with extendCap 0 is effectively hard from the
  //    first tick: a late bid must NOT extend, and the wire must forward extendCount === 0 (NOT collapse
  //    it to null via a falsy `|| null`). The engine reads 0 as a KNOWN, already-exhausted cap -> snipe
  //    immediately. Catches: `extendCount: a.extendCap || null` (0 -> null); the sim extending under a
  //    zero cap; _effectivelyHard mishandling extendsObserved >= 0.
  // ============================================================================================
  {
    // Arrange: injected clock so the window math is deterministic; soft load, extendCap 0.
    let nowMs = 3_000_000;
    const sim = new AuctionSim({ clock: () => nowMs, onEvent: () => {} });
    const a = sim.spawn({ lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 30_000,
      extendCap: 0, softExtendWindowMs: 10_000, softExtendByMs: 20_000, revisionLimit: 20, minDecrement: 100 });
    const origClose = a.closesAt;
    const adapter = new MockSuperProcureAdapter(sim, { transientFailRate: 0 });
    await adapter.login();

    // Act + Assert (seam): the cap forwards as a strict 0, not null.
    const s = await adapter.getAuctionState(a.id);
    assert.strictEqual(s.extendCount, 0, 'extendCap 0 forwards as the number 0, not null (no falsy `|| null` collapse)');
    assert.ok(Number.isFinite(s.extendCount), 'the zero cap is a finite number on the wire');

    // Act + Assert (sim): a bid inside the extension window does NOT push the close - the cap has no room.
    nowMs = origClose - 5_000; // remaining 5000 <= window 10000
    const r = sim.submitBid(a.id, 'US', 60_000);
    assert.strictEqual(r.accepted, true, 'the late bid is accepted');
    assert.strictEqual(r.extended, false, 'a late bid under a 0 cap does NOT extend (no phantom extension round)');
    assert.strictEqual(a.extendsUsed, 0, 'extendsUsed stays 0 - the cap had no room from the start');
    assert.strictEqual(a.closesAt, origClose, 'the close is unchanged - a 0 cap is effectively hard immediately');

    // Assert (engine): the engine reads the 0 cap as a KNOWN, exhausted cap -> effectively hard at once.
    const eng = mkEngine();
    const m = armSoftLearner(eng, a.id, [10_000, 9_400, 8_000]);
    eng._observeExtension(m, s);
    assert.strictEqual(m.extendCap, 0, 'the engine records the KNOWN cap of 0 (not null)');
    assert.strictEqual(eng._effectivelyHard(m), true, 'a known 0 cap is effectively hard immediately (extendsObserved 0 >= cap 0)');
    ok('sim honesty: a zero cap survives as 0 (no `|| null` collapse) and is effectively hard immediately');
  }

  // ============================================================================================
  // 10. SIM -> ENGINE: ONE EXTENSION CONSUMED UNDER A CAP OF 1 -> FINAL WINDOW ENGAGES. Drives the whole
  //     seam: sim extension -> adapter closesAtMs forwarding -> engine counts the extension -> cap reached
  //     -> _effectivelyHard flips false->true -> the genuinely-final rank-aware snipe fires. Before the cap
  //     is reached the same final-window tick DEFENDS (never snipes); after, it snipes. Catches: closesAtMs
  //     not forwarding the extension; _effectivelyHard ignoring the reached cap (premature snipe) or never
  //     reaching it (snipe never fires); the snipe branch firing while extensions remain.
  // ============================================================================================
  {
    // Arrange: injected clock; soft load, extendCap 1; adapter + a soft Havells monitor that LEARNS the
    // cap and absolute close from the wire (extendCap null, believedCloseAt null to start).
    let nowMs = 5_000_000;
    // named re-pin: round tracker, ruling 56 - the engine reads the extension on the sim's clock, so the
    // move is seen inside the trigger window and the sim's close is a plausible time for that clock.
    const REAL_NOW = Date.now;
    Date.now = () => nowMs;
    const sim = new AuctionSim({ clock: () => nowMs, onEvent: () => {} });
    const a = sim.spawn({ lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 60_000,
      extendCap: 1, softExtendWindowMs: 10_000, softExtendByMs: 20_000, revisionLimit: 30, minDecrement: 100 });
    const adapter = new MockSuperProcureAdapter(sim, { transientFailRate: 0 });
    await adapter.login();
    const eng = mkEngine();
    const m = armSoftLearner(eng, a.id, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0]; // established, standing on rung 0

    // Act 1: first observation seeds believedCloseAt + learns the cap of 1. No extension counted yet.
    const s1 = await adapter.getAuctionState(a.id);
    assert.strictEqual(s1.extendCount, 1, 'the cap of 1 forwards on the wire');
    eng._observeExtension(m, s1);
    // Assert: extension still available -> NOT yet final.
    assert.strictEqual(m.extendCap, 1, 'the engine learned the cap of 1 from the wire');
    assert.strictEqual(m.extendsObserved, 0, 'no extension counted from the first (seeding) observation');
    assert.strictEqual(eng._effectivelyHard(m), false, 'with the extension still available the load is NOT effectively hard');
    // Assert: a final-window tick here DEFENDS (floor held in reserve), it does NOT snipe.
    const dBefore = eng._decide(m, state(1_500, 2));
    assert.ok(!(dBefore && dBefore.snipe === true),
      'while an extension remains, the final-window tick does not fire the reserved-floor snipe');

    // Act 2: consume the one extension - a late bid inside the window pushes the close by softExtendByMs.
    nowMs = a.closesAt - 5_000;
    const rExt = sim.submitBid(a.id, 'US', 60_000);
    assert.strictEqual(rExt.extended, true, 'the late bid fired the one available extension');
    assert.strictEqual(a.extendsUsed, 1, 'the sim consumed extension #1');

    // Act 3: second observation - closesAtMs jumped forward by exactly extendMs -> the engine counts it.
    const s2 = await adapter.getAuctionState(a.id);
    assert.strictEqual(s2.closesAtMs - s1.closesAtMs, 20_000, 'closesAtMs forwarded the extension (moved by softExtendByMs)');
    eng._observeExtension(m, s2);
    // Assert: the cap is now reached -> effectively hard.
    assert.strictEqual(m.extendsObserved, 1, 'the engine counted the single observed extension');
    assert.strictEqual(eng._effectivelyHard(m), true, 'cap reached (extendsObserved 1 >= cap 1) -> now effectively hard');

    // Assert (sim seam): with the cap exhausted a further late bid no longer extends - genuinely final.
    nowMs = a.closesAt - 5_000;
    const rNoExt = sim.submitBid(a.id, 'US', 59_000);
    assert.strictEqual(rNoExt.extended, false, 'once the cap is reached a late bid no longer extends (final window)');

    // Assert (decision trace): the genuinely-final window now engages the rank-aware snipe (highest rung
    // that still wins, not the floor) - k=2 from rung 0 selects rung 1 (9700), marked snipe.
    const dAfter = eng._decide(m, state(1_500, 2));
    assert.ok(dAfter && dAfter.snipe === true, 'the genuinely-final window fires the rank-aware snipe once the cap is reached');
    assert.strictEqual(dAfter.rungIndex, 1, 'the rank-aware snipe fires the highest winning rung (rung 1), not the floor');
    assert.strictEqual(dAfter.price, 9_700, 'the snipe price is the rung-1 price 9700');
    Date.now = REAL_NOW;
    ok('sim->engine: one extension consumed under a cap of 1 flips effectively-hard and engages the final snipe');
  }

  cleanup();
  console.log(`\n${pass}/10 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
