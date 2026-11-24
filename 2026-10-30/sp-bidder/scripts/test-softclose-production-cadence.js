'use strict';
/**
 * SOFT-CLOSE DECISIVE BAND, MEASURED AT PRODUCTION CADENCE - the regression pin for the poll-planner
 * / rung-selector SPLIT.
 *
 * TRACKER. PR #143 (branch fix/rejection-taxonomy-v2), reviewing the mechanism that landed in
 * `496148d` - "fix(engine): the soft-close floor snipe never fired - release the reserved rung where
 * it can end the auction (#133)". The 2026-08-01 soft-close diagnosis is the source of the numbers
 * quoted below and of the empty-set finding this file's C4 guards.
 *
 * THE BUG, in one line: the decisive-shot band was SATISFIABLE and UNREACHABLE.
 *
 * `_softFinalShotBand` opens at triggerWindowMs + floorWindowMs - 102,500ms on a real Havells branch -
 * and is floorWindowMs (2,500ms) wide. Production polls at ~30,040ms at that range, because 102,500ms
 * is deep inside far-poll territory. A 2,500ms target and a 30,000ms stride do not intersect except by
 * luck: the decisive shot fired on 19 of 200 simulated loads (9.5%), corroborated at 8.4% across 2,000
 * real soft auctions. On the other ~91% the shot fell through to the deployed 2.5s answer - i.e. 97.5
 * SECONDS INSIDE the anti-snipe window it exists to dodge, which is the self-extension defect the
 * mechanism was built to remove, still happening on nine loads in ten.
 *
 * AND IT IS A TEST-METHODOLOGY BUG, which is the reason this file exists as its own suite. The tests
 * that green-lit the band stepped the countdown at 100ms. At a 100ms step you cannot miss a 2,500ms
 * band, so every one of them passed against code that essentially never fired in production. A test
 * that passes at 100ms steps proves NOTHING about a 2,500ms band sampled at 30,040ms. Every timing
 * claim in this file is therefore made against a walk stepped by the engine's OWN `_cadence` return
 * value - never a fixed step, never a wall-clock sleep.
 *
 * THE FIX BEING PINNED is `_decisiveBandFor`: ONE predicate read by BOTH `_cadence` (the poll planner)
 * and `_softEndgameUnlocked`/`_decisiveShotDue` (the rung selector), so the two cannot disagree about
 * where the decisive shot lives. Approaching the band shortens the poll to land a quarter-width inside
 * it; inside the band the poll goes hot. Everything with NO band - hard closes, soft-off loads,
 * extendCap 0, an unpublished window - keeps the deployed far/mid/hot mapping byte-for-byte.
 *
 * RELATION TO test-softclose-decisive-shot-timing.js (do not merge the two). That file owns the
 * DECISION arc - where the shot lands, the never-forfeit release, the rejection-bank cases - and its
 * D12/D13 make the headline cadence claim. This file owns the PREDICATE-AGREEMENT contract that makes
 * the claim structurally true rather than empirically lucky: it seeds the engine's jitter so a failure
 * is reproducible from a printed seed, it proves no planned poll can step over the unlock set (an
 * analytic statement, not a sampled one), and it pins the four no-band fall-throughs against literal
 * deployed values rather than against a re-read of eng.cfg.
 *
 * LIVE-MONEY DISCIPLINE. No adapter call, no network, no timers, no sleeps, no wall-clock timing:
 * placeBid throws if anything reaches it, every countdown value is supplied explicitly, and every
 * random draw comes from a seeded LCG (this machine's clock drift SIGN has been observed to flip day
 * to day, so nothing here may be derived from it).
 *
 *   node scripts/test-softclose-production-cadence.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
let ran = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const tmp = () => path.join(os.tmpdir(), `sc-cadence-${process.pid}-${seq++}.json`);
const CLEAN = [];
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const FAILURES = [];

// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
//
// scripts/run-tests.js grades by EXIT CODE ALONE, so a file that exits 0 having asserted nothing is
// indistinguishable from a green run. A sentinel at the BOTTOM of the file does not close that hole:
// it sits downstream of everything it guards, so an early `return`, a bare `process.exit(0)`, or a
// throw swallowed by a handler skips the sentinel along with the cases and still exits 0.
//
// Registration ORDER is the whole fix. An exit handler installed before the work runs fires on every
// path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 5;
process.on('exit', (code) => {
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close production cadence: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------------------------
// Fixture constants.
//
// The DEPLOYED poll mapping, written as LITERALS on purpose. Reading these back off eng.cfg would
// make the byte-for-byte case (C3) assert a constant against itself, which cannot notice the constant
// moving - and "the loads with no band keep exactly the deployed cadence" is the reversibility promise
// the whole change rests on. Source: bidEngine.js DEFAULTS, identical on the pre-band tree (2aaf838).
// ---------------------------------------------------------------------------------------------
const DEPLOYED = {
  pollFarMs: 30_000,       // > 60s to close
  pollMidMs: 1_000,        // 10-60s
  pollHotMs: 200,          // <= 10s (the snipe window - never jittered)
  farThresholdMs: 60_000,
  hotThresholdMs: 10_000,
  cadenceJitterMs: 250,    // random spread on the far/mid poll only
};

// Real Havells soft-branch shape, read off the live load object:
//   branchAuctionRemainingTime 100s -> a bid landing with <= 100_000ms left CAUSES an extension
//   branchAuctionExtendTime    180s -> each extension pushes the close out by 180_000ms
const TRIGGER_WINDOW_MS = 100_000;
const EXTEND_MS = 180_000;
const FLOOR_WINDOW_MS = 2_500;
const BAND_OPENS_AT = TRIGGER_WINDOW_MS + FLOOR_WINDOW_MS;   // 102_500
const SCAN_TO = 250_000;      // covers the whole armed countdown of a real soft load, to the ms
const ARM_HORIZON_MS = 900_000; // arm bookkeeping only; NO assertion in this file reads a clock

/**
 * Hand-rolled LCG (Numerical Recipes 32-bit). Seeded and REWINDABLE, for two reasons that both matter
 * on a money path: an unseeded Math.random makes a failure unreproducible (and a flaky money-path test
 * is worse than no test), and rewinding lets C3 feed the SAME jitter draw to the engine and to the
 * reference mapping, so "byte-for-byte" is an exact equality rather than a range check.
 */
function makeRand(seed) {
  let s = seed >>> 0;
  const fn = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
  fn.reseed = (v) => { s = v >>> 0; };
  return fn;
}

/** The deployed far/mid/hot mapping, reimplemented verbatim from the pre-band tree, against literals. */
function deployedCadence(rand, closesInMs) {
  const j = () => Math.floor(rand() * DEPLOYED.cadenceJitterMs);
  if (closesInMs > DEPLOYED.farThresholdMs) return DEPLOYED.pollFarMs + j();
  if (closesInMs > DEPLOYED.hotThresholdMs) return DEPLOYED.pollMidMs + j();
  return DEPLOYED.pollHotMs;
}

function mkEngine({ shippers = ['Havells'], seed = 0x5EED } = {}) {
  const f = tmp(); CLEAN.push(f);
  const rand = makeRand(seed);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    // Live-money guard: these are decision/cadence tests. Nothing may reach the wire.
    placeBid: async () => { throw new Error('placeBid must not be reached in these cadence tests'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, rungs: 6 },
    softClose: { enabled: true, shippers, mode: 'live', reserve: 1 },
    onEvent: () => {},
    rand,
  });
  eng._testRand = rand;   // the same instance the engine draws from, so a case can rewind the stream
  return eng;
}

// Arm on the coarse 3-rung desk band every current customer runs: rung 0 establish, rung 1 the one
// defend step, rung 2 the reserved floor. Detach the auto-tick so decisions are driven synchronously.
function armLoad(eng, { companyName = 'Havells', closeModel = 'soft', extendCap = null,
  triggerWindowMs = TRIGGER_WINDOW_MS, extendsObserved = 0, revisionsLeft = 30 } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'A', destination: 'B' }, units: 1, companyName,
    closesAt: Date.now() + ARM_HORIZON_MS };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = triggerWindowMs;
  m.extendMs = EXTEND_MS;
  m.revisionsLeft = revisionsLeft;
  return m;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });

// Advance monitor state exactly as an ACCEPTED bid would, so a driven sequence progresses the same way
// the live engine's fire point does (_maybeBid: rung banked, revision spent, endgame latches advanced).
function applyDecision(m, d) {
  if (!d) return;
  m.lastBidPrice = d.price;
  if (d.rungIndex != null) { m.currentRungIndex = Math.max(m.currentRungIndex, d.rungIndex); m.firedRungs.add(d.rungIndex); }
  if (m.revisionsLeft != null) m.revisionsLeft -= 1;
  if (d.snipe) m.snipeFired = true;
  if (d.defend) m._lastDefendAtExtend = m.extendsObserved;
}

/**
 * Walk the countdown from `from` to 0, stepping ONLY by what the engine itself planned - the return
 * value of `_cadence(remaining, monitor)`. This is the whole methodological point of the file: the
 * live loop never gets to choose its own resolution, so neither does this walk. A fixed 100ms step
 * here would silently restore the exact blindness that let an unreachable band ship.
 */
function walkAtEngineCadence(eng, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const shots = [];
  let r = from;
  let ticks = 0;
  while (r >= to && ticks++ < maxTicks) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) {
      shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe, defend: !!d.defend });
      applyDecision(m, d);
    }
    const step = eng._cadence(r, m);
    assert.ok(Number.isFinite(step) && step > 0, `_cadence(${r}) planned a non-advancing poll (${step}) - the walk would hang`);
    r -= step;
  }
  return shots;
}

/**
 * The contiguous ms-resolution regions in which the RUNG SELECTOR says the decisive shot is due.
 * `_decisiveShotDue` is the real seam `_decide` calls (it routes soft/allowlisted loads through
 * `_softEndgameUnlocked` and everything else through `_isLastChance`), so this is the satisfying set
 * the poll planner has to be able to reach - read off the engine, never assumed.
 */
function unlockRegions(eng, m, from, to) {
  const regions = [];
  let start = null;
  for (let r = from; r <= to; r++) {
    const on = eng._decisiveShotDue(m, r);
    if (on && start == null) start = r;
    if (!on && start != null) { regions.push([start, r - 1]); start = null; }
  }
  if (start != null) regions.push([start, to]);
  return regions;
}

const floorShot = (shots, last) => shots.find((s) => s.rungIndex === last) || null;

// Each case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of what is broken matters more than failing fast. The exit code stays honest: the
// completion sentinel registered at the top asserts every case both RAN and PASSED.
function run(name, fn) {
  ran++;
  try { fn(); ok(name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}

console.log('soft-close production cadence');

// ---------------------------------------------------------------------------------------------
// C1 - THE HEADLINE, AS A RATE, SEEDED. 200 cap-reached soft loads, each armed at a different offset
// relative to the poll marks (which is exactly what varies between real auctions), each walked at the
// cadence the engine itself planned. The decisive shot must land inside the band on ALL 200.
//
// 200/200 is the assertion, not "at least one": the pre-fix number is 19/200 (9.5%), corroborated at
// 8.4% across 2,000 real soft auctions, so any tolerance below 200 passes on the broken code and pins
// nothing. Both the arm offsets and the engine's own cadence jitter are seeded, so a failure here is
// reproducible from the printed seed rather than a coin flip on a live-money path.
//
// REVERSED 2026-09-24 for these cap-reached loads: once a known extension cap is used up there is no
// band, and the decisive shot lands in the last-chance window on all 200.
// ---------------------------------------------------------------------------------------------
run('C1 PRODUCTION CADENCE: on 200 of 200 seeded cap-reached soft loads the decisive shot lands at the buzzer', () => {
  const N = 200;
  const OFFSET_SEED = 0xC0FFEE;
  const offsets = makeRand(OFFSET_SEED);
  let fired = 0;
  let atBuzzer = 0;
  const misses = [];
  for (let i = 0; i < N; i++) {
    const engSeed = 0x5EED + i;
    const eng = mkEngine({ seed: engSeed });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
    const last = m.ladder.length - 1;
    const band = eng._decisiveBandFor(m);
    assert.strictEqual(band, null,
      `load ${i}: reversed 2026-09-24 - a cap-reached soft load resolves no band; after the extension cap final bids go `
      + 'in the last seconds like hard close');
    // Where a real arm falls relative to the poll marks is arbitrary to the millisecond: 120s-420s out.
    const from = 120_000 + Math.floor(offsets() * 300_000);
    const shots = walkAtEngineCadence(eng, m, { from, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
    const shot = floorShot(shots, last);
    if (shot) fired += 1;
    if (shot && shot.remaining <= FLOOR_WINDOW_MS) atBuzzer += 1;
    else misses.push(`from=${from}ms engSeed=0x${engSeed.toString(16)} shot=${shot ? shot.remaining + 'ms' : 'NEVER FIRED'}`);
  }
  assert.strictEqual(fired, N,
    `the reserved floor rung never fired at all on ${N - fired} of ${N} loads (offsetSeed=0x${OFFSET_SEED.toString(16)}) - `
    + 'a soft load that never bids its best price is a forfeit');
  assert.strictEqual(atBuzzer, N,
    `only ${atBuzzer} of ${N} cap-reached loads placed the decisive shot at <= ${FLOOR_WINDOW_MS}ms - reversed 2026-09-24: `
    + 'after the extension cap final bids go in the last seconds like hard close, not in the band above the trigger '
    + 'window. First misses: ' + misses.slice(0, 5).join(' | '));
});

// ---------------------------------------------------------------------------------------------
// C2 - THE AGREEMENT CONTRACT, and the case that catches the regression structurally rather than
// statistically. The poll planner (_cadence) and the rung selector (_decisiveShotDue ->
// _softEndgameUnlocked) must not be able to disagree about where the decisive shot lives; that shared
// reading of _decisiveBandFor IS the fix. Editing one without the other is exactly the regression.
//
// Stated as an invariant rather than a sample: from strictly ABOVE an unlock region, one planned poll
// may never land strictly BELOW it. A step that can cross the region without offering a tick inside it
// is precisely how a satisfiable rule becomes unreachable. Checked at 1ms resolution across the whole
// armed countdown, on every load shape - including the ones that must have NO band, where the two
// readers would silently diverge if either stopped consulting _decisiveBandFor.
// ---------------------------------------------------------------------------------------------
run('C2 the poll planner and the rung selector cannot disagree: no planned poll steps over the unlock set', () => {
  const SHAPES = [
    { name: 'soft, cap reached', shippers: ['Havells'], arm: { extendCap: 3, extendsObserved: 3 } },
    { name: 'soft, unknown cap', shippers: ['Havells'], arm: { extendCap: null } },
    { name: 'soft, extendCap 0', shippers: ['Havells'], arm: { extendCap: 0, extendsObserved: 0 } },
    { name: 'soft, no published window', shippers: ['Havells'], arm: { extendCap: 3, extendsObserved: 3, triggerWindowMs: null } },
    { name: 'soft but not allowlisted', shippers: ['SomeoneElse'], arm: { extendCap: 3, extendsObserved: 3 } },
    { name: 'hard close', shippers: ['Havells'], arm: { closeModel: 'hard', extendCap: null, triggerWindowMs: null } },
  ];
  for (const s of SHAPES) {
    const eng = mkEngine({ shippers: s.shippers });
    const m = armLoad(eng, s.arm);
    const regions = unlockRegions(eng, m, 0, SCAN_TO);
    assert.ok(regions.length,
      `${s.name}: the rung selector unlocks at NO countdown value in 0..${SCAN_TO}ms - the predicate is the empty set, `
      + 'which forfeits the load outright instead of merely mistiming it (strictly worse than the bug)');
    for (const [lo, hi] of regions) {
      for (let r = hi + 1; r <= SCAN_TO; r++) {
        const next = r - eng._cadence(r, m);
        assert.ok(next >= lo,
          `${s.name}: at ${r}ms remaining the planner schedules the next poll at ${next}ms, straight over the unlock `
          + `region [${lo}, ${hi}]ms - the rung selector says the decisive shot is due in there and the poll planner `
          + 'never offers a tick inside it. The two must read the SAME band (_decisiveBandFor); a rule the engine '
          + 'cannot reach is not a fix');
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// C3 - REVERSIBILITY. Every load WITHOUT a decisive band keeps the deployed far/mid/hot mapping
// byte-for-byte: hard closes, soft-off (non-allowlisted) loads, extendCap 0 (a hard window wearing a
// soft close model - no anti-snipe mechanic to dodge), and a branch publishing no window or a zero one
// (no window is ever invented). No existing customer's timing may shift because of this change.
//
// Compared against LITERAL deployed values fed the SAME rewound jitter draw, not against a second call
// to _cadence (which would re-jitter) and not against eng.cfg (which would assert a constant against
// itself). The no-monitor call is checked too: the monitor argument is additive, so dropping it must
// land on the identical deployed answer.
// ---------------------------------------------------------------------------------------------
run('C3 no band: the deployed far/mid/hot cadence is byte-for-byte unchanged on all four fall-throughs', () => {
  const PROBE_SEED = 0xA11CE;
  const SHAPES = [
    { name: 'hard close', shippers: ['Havells'], arm: { closeModel: 'hard', extendCap: null, triggerWindowMs: null } },
    { name: 'soft but not allowlisted (soft-off)', shippers: ['SomeoneElse'], arm: { extendCap: 3, extendsObserved: 3 } },
    { name: 'extendCap 0', shippers: ['Havells'], arm: { extendCap: 0, extendsObserved: 0 } },
    { name: 'unpublished trigger window', shippers: ['Havells'], arm: { extendCap: 3, extendsObserved: 3, triggerWindowMs: null } },
    { name: 'zero trigger window', shippers: ['Havells'], arm: { extendCap: 3, extendsObserved: 3, triggerWindowMs: 0 } },
  ];
  // The probes straddle every deployed threshold, plus the two marks the band would have moved
  // (110_000 approaches it, 102_500 is its opening edge) so a leaked band shows up immediately.
  const PROBES = [400_000, 130_000, 110_000, 102_500, 60_001, 60_000, 30_000, 10_001, 10_000, 2_500, 200, 0];
  for (const s of SHAPES) {
    const eng = mkEngine({ shippers: s.shippers });
    const m = armLoad(eng, s.arm);
    assert.strictEqual(eng._decisiveBandFor(m), null,
      `${s.name}: this load has no anti-snipe mechanic to aim at and must resolve NO decisive band - a band here `
      + 'pulls the poll cadence of a load that never uses it, which is a live timing change to a shipped customer');
    for (const r of PROBES) {
      eng._testRand.reseed(PROBE_SEED);
      const actual = eng._cadence(r, m);
      eng._testRand.reseed(PROBE_SEED);
      const expected = deployedCadence(eng._testRand, r);
      assert.strictEqual(actual, expected,
        `${s.name}: _cadence(${r}, monitor) returned ${actual}ms where the DEPLOYED mapping returns ${expected}ms `
        + `(far ${DEPLOYED.pollFarMs} > ${DEPLOYED.farThresholdMs}ms / mid ${DEPLOYED.pollMidMs} > `
        + `${DEPLOYED.hotThresholdMs}ms / hot ${DEPLOYED.pollHotMs}). Loads with no band must not be perturbed`);
      eng._testRand.reseed(PROBE_SEED);
      const noMonitor = eng._cadence(r);
      eng._testRand.reseed(PROBE_SEED);
      assert.strictEqual(noMonitor, deployedCadence(eng._testRand, r),
        `_cadence(${r}) with no monitor returned ${noMonitor}ms - the monitor argument is ADDITIVE, so omitting it `
        + 'must land on the deployed mapping exactly');
    }
  }
});

// ---------------------------------------------------------------------------------------------
// C4 - THE BAND IS NEVER THE EMPTY SET. The natural-reading rule for "late but still final" is
// `_isLastChance(remaining) && !_insideTriggerWindow(...)` - remaining <= 2,500 AND remaining > 100,000
// on a real Havells branch. That is the EMPTY SET, and shipping it would forfeit every soft load
// instead of mistiming it: strictly worse than the bug. (A merged-looking PR carried exactly that
// predicate; it was CI-green because no test asserted the unlock is ever true on a soft load.)
//
// So the satisfying set is asserted by COUNT, not by existence: exactly floorWindowMs integer
// countdown values above the trigger window, and the deployed last-chance answer still reachable
// below it. An exact count fails on a widened band, a narrowed band, and on a revert to a bare
// _effectivelyHard test (which unlocks nothing above the window at all).
//
// REVERSED 2026-09-24 for this cap-reached fixture: the known cap is used up, so nothing unlocks above
// the trigger window and the last-chance window alone is the (non-empty) unlock set.
// ---------------------------------------------------------------------------------------------
run('C4 on a cap-reached Havells-shaped soft branch the unlock set is the last-chance window, never the naive empty set', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
  assert.strictEqual(m.triggerWindowMs, TRIGGER_WINDOW_MS, 'fixture: real Havells trigger window (branchAuctionRemainingTime 100s)');
  assert.strictEqual(m.extendMs, EXTEND_MS, 'fixture: real Havells extension (branchAuctionExtendTime 180s)');
  assert.strictEqual(eng._decisiveBandFor(m), null,
    'reversed 2026-09-24: after the extension cap final bids go in the last seconds like hard close, so a cap-reached '
    + 'load resolves no band above the trigger window');

  let naive = 0;
  let unlockedAbove = 0;
  let unlockedInside = 0;
  for (let r = 0; r <= SCAN_TO; r++) {
    // A089: _insideTriggerWindow was removed from bidEngine.js (dead code - zero production callers,
    // this fixture was the only thing that ever executed it). Inlined here verbatim, because this
    // scan's whole point is demonstrating that the NAIVE formula is the empty set - it needs the
    // naive formula, not the real engine method.
    const naiveInsideTriggerWindow = m.triggerWindowMs != null && Number.isFinite(m.triggerWindowMs)
      && Number.isFinite(r) && r <= m.triggerWindowMs;
    if (eng._isLastChance(r) && !naiveInsideTriggerWindow) naive += 1;
    if (eng._decisiveShotDue(m, r)) { if (r > TRIGGER_WINDOW_MS) unlockedAbove += 1; else unlockedInside += 1; }
  }
  assert.strictEqual(naive, 0,
    `FIXTURE INTEGRITY: the naive rule (_isLastChance AND outside-the-trigger-window) unlocked at ${naive} values here, `
    + 'so this fixture no longer reproduces the hazard the case exists to guard. On a real branch floorWindowMs (2.5s) '
    + 'is far below the trigger window (100-200s) and the conjunction is unsatisfiable');
  assert.strictEqual(unlockedAbove, 0,
    `the rung selector unlocks at ${unlockedAbove} countdown values above the ${TRIGGER_WINDOW_MS}ms trigger window - `
    + 'reversed 2026-09-24: after the extension cap final bids go in the last seconds like hard close, never ~100s out');
  assert.strictEqual(unlockedInside, FLOOR_WINDOW_MS + 1,
    `the deployed last-chance answer (0..${FLOOR_WINDOW_MS}ms) must SURVIVE as the fall-through for a load already inside `
    + `the window with the rung unspent - it unlocked at ${unlockedInside} values instead of ${FLOOR_WINDOW_MS + 1}. `
    + 'Firing there may self-extend, which is accepted deliberately: forfeiting the load outright is strictly worse');
});

// ---------------------------------------------------------------------------------------------
// C5 - THE APPROACH. The band only becomes reachable because the planner AIMS at it: a quarter of the
// band's width past its opening edge, so ordinary poll latency and SP-clock slack in either direction
// cannot land the tick just outside. Pinned exactly (a half-width or edge-aimed approach fails here),
// with the control that proves the assertion is about the approach and not about luck: the same
// countdown on a load with no band keeps the far poll and steps straight over the band.
//
// And the approach only ever SHORTENS - a load still minutes out keeps its deployed far poll.
//
// REVERSED 2026-09-24 for this cap-reached fixture: with the known cap used up there is no band to aim
// at, so the poll at 110,000ms is the deployed far poll, exactly like the no-band control.
// ---------------------------------------------------------------------------------------------
run('C5 approaching where the band was, a cap-reached load keeps the deployed far poll', () => {
  const PROBE_SEED = 0xBEEF;
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
  assert.strictEqual(eng._decisiveBandFor(m), null,
    'reversed 2026-09-24: a cap-reached load resolves no band - after the extension cap final bids go in the last '
    + 'seconds like hard close');
  const width = BAND_OPENS_AT - TRIGGER_WINDOW_MS;
  const APPROACH = 110_000;   // 7.5s above the band's opening edge - deep in far-poll territory

  eng._testRand.reseed(PROBE_SEED);
  const step = eng._cadence(APPROACH, m);
  eng._testRand.reseed(PROBE_SEED);
  assert.strictEqual(step, deployedCadence(eng._testRand, APPROACH),
    `at ${APPROACH}ms the planner scheduled a ${step}ms poll - reversed 2026-09-24: after the extension cap the poll `
    + 'is not pulled toward the band; it keeps the deployed far poll');

  // CONTROL. Without the band the same countdown keeps the far poll and clears the band entirely - so
  // the assertions above are about the approach rule, not about 110_000 happening to be convenient.
  const engB = mkEngine({ seed: 0x1234 });
  const noBand = armLoad(engB, { extendCap: 0, extendsObserved: 0 });
  assert.strictEqual(engB._decisiveBandFor(noBand), null, 'control fixture must resolve no band');
  const overshoot = APPROACH - engB._cadence(APPROACH, noBand);
  assert.ok(overshoot < TRIGGER_WINDOW_MS,
    `control: with no band the poll at ${APPROACH}ms steps to ${overshoot}ms, which is NOT past the band - if the far `
    + `poll does not clear the ${width}ms band on its own then this case proves nothing about the approach`);

  // ...and the pull never lengthens or fires early: a load minutes out keeps the deployed far poll.
  eng._testRand.reseed(PROBE_SEED);
  const far = eng._cadence(400_000, m);
  eng._testRand.reseed(PROBE_SEED);
  assert.strictEqual(far, deployedCadence(eng._testRand, 400_000),
    `a load 400s out was polled at ${far}ms instead of the deployed far poll - the band may only SHORTEN the poll as it `
    + 'is approached, never re-time a load that is nowhere near it');
});

// (the completion sentinel is registered at the TOP of this file, before any case runs)
