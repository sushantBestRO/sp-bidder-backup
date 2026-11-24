'use strict';
/**
 * SOFT-CLOSE FLOOR REACHABILITY - does the reserved rung actually reach the wire, and when it does,
 * does the desk hear about it?
 *
 * This file exists because of a specific hole in the suite. `bidEngine.js`'s last-chance floor snipe
 * was gated on `_effectivelyHard(monitor)`, which is false for the whole life of a soft-close load
 * that still believes it has extensions left. On such a load the buzzer shot was skipped entirely -
 * the auction closed with our best price never sent. The in-code comment at the blind-rank hold
 * asserted the opposite ("Holding can cost margin; it can never cost the auction"), which is true on
 * a hard close and false on a soft one. Nine Havells soft loads closed with zero landed bids.
 *
 * Nothing in the suite caught it, and nothing caught the proposed fix that made it worse, for one
 * reason: NO TEST ASSERTED THAT THE FLOOR ACTUALLY FIRES ON A SOFT LOAD. The single test touching
 * the endgame predicate used a HARD load, which short-circuits before the soft branch is reached, so
 * a predicate that is the empty set on every real soft branch stayed green. F1-F4 below are that
 * missing assertion, written so that a "fix" which strands the reserve fails as loudly as the
 * original defect does.
 *
 * X1-X8 cover the frozen zeroed countdown. They pinned the extension-count inference salvaged from
 * the PR #105 draft; the round tracker retired it (ruling 56), so a frozen close now counts nothing and
 * makes a round that is not final UNCERTAIN_AFTER_CLOSE. N1-N2 measure the floor on a load already on
 * the board: N1 at a pre-cap buzzer and at a frozen close, N2 at the last pre-cap tick.
 *
 * R1-R4 pin the notification routing: the release is a commercial fact for the desk, not an outage
 * for the on-call class, so it routes through DESK_NOTICE_KINDS and must not render as a refusal.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, no network, no wall-clock waits
 * beyond one short debounce in the end-to-end case. NO competitor modelling anywhere - every input is
 * our own rank, our own ladder, and the load's own published clock and mechanics.
 *
 *   node scripts/test-softclose-floor-reachability.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification, ERROR_KINDS, DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');

// The live Havells soft-branch mechanics, as read off the load object on the box:
//   branchAuctionRemainingTime 100s -> a bid landing with <= 100,000ms left CAUSES an extension
//   branchAuctionExtendTime    180s -> each extension pushes the close out by 180,000ms
const TRIGGER_MS = 100_000;
const EXTEND_MS = 180_000;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-reach-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINES = [];
function mkEngine({ shippers = ['Havells'], mode = 'live', reserve = 1, onEvent, adapter } = {}) {
  const a = adapter || {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached in a decision test'); },
  };
  const eng = new BidEngine(a, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers, mode, reserve },
    onEvent: onEvent || (() => {}),
  });
  ENGINES.push(eng);
  return eng;
}

// Arm on the coarse 3-rung desk band every current customer runs: rung 0 establish, rung 1 the one
// defend step, rung 2 the reserved floor. The auto-tick is detached so decisions are driven
// synchronously and nothing races a real timer.
function armLoad(eng, { companyName = 'Havells', branchName = 'ALWAR', closeModel = 'soft',
  extendCap = null, extendsObserved = 0, triggerWindowMs = TRIGGER_MS, revisionsLeft = 30 } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName, branchName, closesAt: Date.now() + 900_000 };
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

// One socket frame as _observeExtension reads it.
const frame = (closesAtMs, over = {}) => Object.assign({
  ok: true, status: 'live', closesAtMs, closesInMs: 1, extendMs: EXTEND_MS,
  extendCount: 3, triggerWindowMs: TRIGGER_MS, closeModel: 'soft',
}, over);

// Advance monitor state exactly as an ACCEPTED bid would, so a driven countdown progresses the way
// the live engine's fire point does (rung banked, revision spent, endgame latches advanced,
// participation counted).
function applyDecision(m, d) {
  if (!d) return;
  m.lastBidPrice = d.price;
  if (d.rungIndex != null) { m.currentRungIndex = Math.max(m.currentRungIndex, d.rungIndex); m.firedRungs.add(d.rungIndex); }
  if (m.revisionsLeft != null) m.revisionsLeft -= 1;
  if (d.snipe) m.snipeFired = true;
  if (d.defend) m._lastDefendAtExtend = m.extendsObserved;
  // named re-pin: round tracker, ruling 56 - the fire point's buzzer latch is the round's roundId.
  if (d.buzzerShotRoundId != null) m._shotRoundId = d.buzzerShotRoundId;
  m.landedBids = (m.landedBids || 0) + 1;
}

// Walk the load's own countdown from `from` down to `to`, recording every decision and the remaining
// time it was taken at. `rank` may be a function of (monitor, remaining) so a case can model our own
// rank arriving late - our rank only, never any rival's price.
function sweep(eng, m, { from, to = 0, stepMs = 100, rank }) {
  const shots = [];
  for (let r = from; r >= to; r -= stepMs) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) {
      shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe });
      applyDecision(m, d);
    }
  }
  return shots;
}
const floorShot = (shots, last) => shots.find((s) => s.rungIndex === last) || null;

// The same walk, stepped at the cadence the ENGINE would have scheduled. A 100ms sweep offers a
// decision point production never provides above the 10s hot threshold (the far poll is ~30 SECONDS),
// so any claim about WHERE a shot lands has to be made against this one - a 2,500ms band and a
// 30,000ms stride do not intersect except by luck, and a 100ms sweep cannot see the difference.
function sweepCadence(eng, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const shots = [];
  let r = from;
  let ticks = 0;
  while (r >= to && ticks++ < maxTicks) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) { shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe }); applyDecision(m, d); }
    r -= Math.max(1, eng._cadence(r, m));
  }
  return shots;
}

/**
 * Drive the REAL _maybeBid down a countdown at PRODUCTION cadence on a virtual clock.
 *
 * Two things here are load-bearing rather than convenience.
 *
 * _maybeBid, NOT _decide. Every case above drives the decision function directly, which skips the
 * whole gate stack that sits above it in the live loop - the multi-vehicle hold, the revisions
 * stand-down, minInterFireMs, and maxBidsPerMin. Those gates return BEFORE _decide is ever called, so
 * a decision test cannot see a rule that starves the decisive shot before the decision is even taken.
 * That is precisely the class of defect this file was written to stop shipping.
 *
 * A VIRTUAL CLOCK. minInterFireMs (150ms) and the 60-second maxBidsPerMin window are both measured
 * against Date.now. A synchronous drive on the real clock collapses an entire countdown into a few
 * milliseconds, so every tick after the first is blocked by the inter-fire floor and the run measures
 * a rate limiter production never encounters. Stepping a virtual clock by exactly the cadence the
 * engine itself would have scheduled is what makes the two agree. The global is restored in a finally.
 */
async function driveMaybeBid(eng, m, { from, to = 0, rank = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      const k = typeof rank === 'function' ? rank(m, r) : rank;
      await eng._maybeBid(m, st(r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

// The most common real rejection string in the corpus (8 of 25 records) - a PRICE-class refusal, where
// SuperProcure's own cap sits below our opening rung. Not the cap class, not a load-state class.
//
// The CAP has to be consistent with this file's own ladder, and it was not: it read 9,200 against a
// ladder running 78,820 down to a 74,410 floor, i.e. a cap no rung on the load could ever satisfy.
// That is a different refusal - if not even the floor can be accepted, walking the ladder is not the
// retry this file is about - and the engine classifies it as one. 78,720 is the real shape: our
// opening rung minus the branch's 100 minimum decrement, which leaves the floor offerable and keeps
// every case below testing exactly what it says it tests.
const PRICE_REJECT = 'Amount is invalid. Amount should be less than or equal to 78720';
const rejectRes = () => ({ accepted: false, ok: false, status: 400, reason: PRICE_REJECT, text: PRICE_REJECT, raw: PRICE_REJECT });

// Each case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of what is broken matters more than failing fast. The exit code stays honest: the
// completion sentinel below asserts every case both RAN and PASSED.
let ran = 0, pass = 0;
const FAILURES = [];

// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
//
// The runner grades by EXIT CODE ALONE, and this file is async. The sentinel used to be an assert at
// the BOTTOM of the async IIFE, which does not close the hole it was written for: it sits DOWNSTREAM
// of everything it guards, so deleting a case is caught but a `return` above the cases, a swallowed
// rejection, or a require resolving to a stub all skip the assert along with the cases and reach
// exit 0 as a silent green zero-assertion run.
//
// Registration ORDER is the whole fix. An exit handler installed before the work runs fires on every
// path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 24;
process.on('exit', (code) => {
  cleanup();
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close floor reachability: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
function run(name, fn) {
  ran++;
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}
async function runAsync(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('soft-close floor reachability');

  // ===========================================================================================
  // F - THE MISSING ASSERTION. Does the reserved floor rung reach the wire on a SOFT load?
  // ===========================================================================================

  // F1 is the defect, stated directly. A soft load whose establish bid was REFUSED never lands
  // anything, so SuperProcure never self-matches us and our own rank stays null for the life of the
  // auction. Every discretionary path then holds, the snipe branch below them is gated on
  // _effectivelyHard and is never reached, and the auction closes with our best price never sent.
  // This is the 13-load, Rs 3,10,000 signature.
  run('F1 SOFT load, rank never arrives: the reserved floor rung still reaches the wire', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 }); // extensions BELIEVED to remain
    const last = m.ladder.length - 1;
    assert.strictEqual(m.closeModel, 'soft', 'fixture must be a soft load');
    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture must be the case the old gate excluded: a soft load that never becomes effectively hard');
    // the reject handler's banking, verbatim (bidEngine _maybeBid, non-cap rejection path)
    m.firedRungs.add(0);
    m.currentRungIndex = 0;
    m.landedBids = 0;                       // the establish bid was REFUSED - nothing on the board
    const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: null }); // rank NEVER arrives
    const shot = floorShot(shots, last);
    assert.ok(shot, 'the auction closed with the reserved floor rung UNSPENT - the load was forfeited in silence, '
      + 'which is exactly what the last-chance snipe being gated on _effectivelyHard produces on a soft branch');
    assert.strictEqual(shot.price, m.ladder[last], 'the shot must be our floor price, not a discretionary mid rung');
  });

  // F2. REVERSED 2026-09-24 for this cap-reached fixture. A bid inside the trigger window extends the
  // auction only while extensions remain; once the known cap is used up it cannot, so the decisive shot
  // goes in the last seconds like hard close rather than ~100s out.
  run('F2 cap reached: the decisive shot lands in the last-chance window, like hard close', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 }); // cap reached: endgame is open
    const last = m.ladder.length - 1;
    const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
    const shot = floorShot(shots, last);
    assert.ok(shot, 'the reserved floor rung must be spent before close');
    assert.ok(shot.remaining <= 2_500,
      `the decisive shot landed at ${shot.remaining}ms remaining - reversed 2026-09-24: once the known extension cap is `
      + 'used up no bid can extend the auction, so final bids go in the last seconds like hard close (<= 2,500ms)');
  });

  // F3. THE EMPTY-SET TRAP, pinned. `_isLastChance(remaining) && !insideTriggerWindow(remaining)`
  // reads as the natural rule for F2 and is the empty set on every real branch: floorWindowMs is
  // 2,500 and a published window is 100,000-200,000, so it requires remaining <= 2,500 AND
  // remaining > 100,000. A predicate like that converts "spends the floor too early" into "never
  // spends the floor at all", which forfeits every soft load - strictly worse than the defect. It is
  // CI-invisible unless a test sweeps a soft countdown, which is what this does.
  run('F3 the unlock predicate is SATISFIABLE: the floor fires somewhere in every soft countdown', () => {
    for (const cap of [null, 0, 1, 3]) {
      const eng = mkEngine();
      const m = armLoad(eng, { extendCap: cap, extendsObserved: cap == null ? 0 : cap });
      const last = m.ladder.length - 1;
      const shots = sweep(eng, m, { from: 200_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
      assert.ok(floorShot(shots, last),
        `extendCap=${cap}: the reserved floor rung fired at NO point in a 200,000ms countdown - the unlock predicate `
        + 'is unsatisfiable on this branch, so every soft load is forfeited rather than bid');
    }
  });

  // F4. The proven Module-1 hard-close snipe must not move. 385 bids were accepted at >100s lead
  // across 224 auctions; the establish mark and the hard-close buzzer shot are both designed, and
  // nothing in the soft-close work is allowed to shift them.
  run('F4 hard close is untouched: the Module-1 snipe still fires inside floorWindowMs', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { closeModel: 'hard', extendCap: null, triggerWindowMs: null });
    const last = m.ladder.length - 1;
    const shots = sweep(eng, m, { from: 30_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
    const shot = floorShot(shots, last);
    assert.ok(shot, 'hard close must still snipe the floor');
    assert.ok(shot.remaining <= 2_500, `hard-close snipe moved to ${shot.remaining}ms - it must stay inside floorWindowMs`);
  });

  // ===========================================================================================
  // X - the extension-count inference salvaged from PR #105 (_observeExtension's zero-run branch)
  // ===========================================================================================

  // X1. Live evidence, 2026-07-25, 4 of 4 Havells soft auctions: once the believed close passed the
  // socket stopped publishing, closesInMs pinned to 0 and closesAtMs froze for ~183s while the
  // auction demonstrably ran on. No forward jump arrived, so the LAST extension was never counted.
  // named re-pin: round tracker, ruling 56 - the frozen zero no longer infers a round; a round that is
  // not already final reads UNCERTAIN_AFTER_CLOSE instead, and no time is invented either way.
  run('X1 a frozen zeroed countdown past the skew guard makes the round UNCERTAIN_AFTER_CLOSE, counts nothing', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 2 });
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - (eng.cfg.finalizeDebounceMs + 500);
    const counted = eng._observeExtension(m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(counted, false, 'the sustained zero was counted as a round (ruling 56 retired the inference)');
    assert.strictEqual(m.extendsObserved, 2, 'the frozen zero changed the count');
    const v = eng.roundVerdict(m);
    assert.deepStrictEqual([v.verdict, v.reason], ['UNCERTAIN_AFTER_CLOSE', 'frozen_zero'],
      `a frozen zero on a round that is not final reads ${v.verdict} ${v.reason}`);
    assert.strictEqual(m.believedCloseAt, t0,
      'NO TIME MAY BE INVENTED - believedCloseAt was advanced, which is the year-2100 placeholder mistake');
  });

  // X2. The box took ~900 samples at the 200ms hot cadence inside that window. None of them may count
  // a round, or the count manufactures phantom rounds and unlocks the endgame on a lie.
  // named re-pin: round tracker, ruling 56 - exactly zero rounds now, where the inference counted one.
  run('X2 a 900-sample frozen run counts no round, never one per tick', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - (eng.cfg.finalizeDebounceMs + 500);
    for (let i = 0; i < 900; i++) eng._observeExtension(m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(m.extendsObserved, 3, `900 frozen samples produced ${m.extendsObserved - 3} inferred extensions, not 0`);
  });

  // X3. Fail closed on ambiguous timing: a brief zero is clock wobble, and this machine's own clock
  // drifts materially. finalizeDebounceMs is the engine's EXISTING skew guard, reused deliberately
  // rather than a new magic number.
  run('X3 a transient zero under the skew guard counts nothing (fail closed)', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - 100; // well under finalizeDebounceMs
    const counted = eng._observeExtension(m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(counted, false, 'a brief zero is wobble, not an extension');
    assert.strictEqual(m.extendsObserved, 1, 'count must be unchanged');
  });

  // X4. The socket wakes up and finally publishes the close the frozen zero was hiding. That is ONE
  // round, counted once when it is published.
  // named re-pin: round tracker, ruling 56 - nothing was inferred, so the late close IS the count.
  run('X4 a late real close time after a frozen zero is counted exactly once', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - (eng.cfg.finalizeDebounceMs + 500);
    eng._observeExtension(m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(m.extendsObserved, 1, 'the frozen run counted a round');
    const counted = eng._observeExtension(m, frame(t0 + EXTEND_MS, { closesInMs: EXTEND_MS }));
    assert.strictEqual(counted, true, 'the published close of the hidden round was not counted');
    assert.strictEqual(m.extendsObserved, 2, 'the hidden round was not counted exactly once');
    assert.strictEqual(m.believedCloseAt, t0 + EXTEND_MS, 'the real close time must be adopted once it arrives');
  });

  // X5. A genuine NEXT round after that one is counted too.
  // named re-pin: round tracker, ruling 56 - the next round is read inside its own trigger window.
  run('X5 a genuine forward jump after the published resume is still counted', () => {
    const REAL_NOW = Date.now;
    let vnow = REAL_NOW();
    Date.now = () => vnow;
    try {
      const eng = mkEngine();
      const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
      const t0 = Date.now() + 60_000;
      m.believedCloseAt = t0;
      m._zeroSince = Date.now() - (eng.cfg.finalizeDebounceMs + 500);
      eng._observeExtension(m, frame(t0, { closesInMs: 0 }));                   // nothing inferred
      m._zeroSince = null;
      eng._observeExtension(m, frame(t0 + EXTEND_MS, { closesInMs: 1 }));       // the hidden round -> 2
      vnow = t0 + EXTEND_MS - 30_000;
      const counted = eng._observeExtension(m, frame(t0 + 2 * EXTEND_MS, { closesInMs: 1 }));
      assert.strictEqual(counted, true, 'a further genuine forward jump is a new round');
      assert.strictEqual(m.extendsObserved, 3, 'the second real round was not counted');
    } finally { Date.now = REAL_NOW; }
  });

  // X6/X7. The inference is scoped to the surface it was measured on. A hard close has no extension
  // mechanic at all, and a non-allowlisted soft load runs the deployed path byte-for-byte.
  run('X6 a HARD-close load never infers an extension from a zeroed countdown', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { closeModel: 'hard', extendCap: 3, extendsObserved: 0 });
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - 600_000;
    const counted = eng._observeExtension(m, frame(t0, { closesInMs: 0, closeModel: 'hard' }));
    assert.strictEqual(counted, false, 'hard close must infer nothing');
    assert.strictEqual(m.extendsObserved, 0, 'count untouched');
  });

  run('X7 a NON-allowlisted soft load infers nothing (deployed path untouched)', () => {
    const eng = mkEngine({ shippers: ['SomeoneElse'] });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 });
    assert.strictEqual(m.softStrategy, 'off', 'fixture must produce a non-allowlisted monitor');
    const t0 = Date.now() + 60_000;
    m.believedCloseAt = t0;
    m._zeroSince = Date.now() - 600_000;
    const counted = eng._observeExtension(m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(counted, false, 'the deployed path must be unchanged');
    assert.strictEqual(m.extendsObserved, 0, 'count untouched');
  });

  // X8. WIRING, not just the unit. The cases above set _zeroSince by hand. This one proves _tick
  // itself maintains the zero run AHEAD of _observeExtension - if that tracking sits below the
  // observer (where it used to), the observer reads the PREVIOUS tick's run and the inference never
  // fires on the tick that matters.
  await runAsync('X8 end-to-end: _tick maintains the zero run ahead of the observer', async () => {
    const frozenClose = Date.now() + 30_000;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      // The box's own signature: countdown pinned to 0, close time frozen, platform still answering.
      getAuctionState: async () => ({ ok: true, status: 'live', closesInMs: 0, closesAtMs: frozenClose,
        myRank: 2, totalBidders: 4, extendMs: EXTEND_MS, extendCount: 3, triggerWindowMs: TRIGGER_MS,
        closeModel: 'soft', minDecrement: 100, revisionLimit: 30, revisionsLeft: null, standingL1Price: null }),
      placeBid: async () => ({ ok: true, status: 201 }),
    };
    const eng = mkEngine({ adapter });
    // named re-pin: round tracker, ruling 56 - a round that is not final (2 of 3) is what the frozen
    // zero turns UNCERTAIN_AFTER_CLOSE; the zero run _tick maintains is what the tracker reads.
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 2 });
    m.believedCloseAt = frozenClose;
    m.landedBids = 1;
    // first tick opens the zero run; the debounce then has to elapse before the zero is honest.
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    assert.ok(m._zeroSince != null, '_tick did not open the zero run at all');
    await sleep(eng.cfg.finalizeDebounceMs + 200);
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    const v = eng.roundVerdict(m);
    assert.ok(v.verdict === 'UNCERTAIN_AFTER_CLOSE' && m.extendsObserved === 2,
      `verdict ${v.verdict}, extendsObserved ${m.extendsObserved} - _tick's zero-run tracking is not reaching `
      + 'the round tracker, so the frozen close is invisible to the live loop even though the unit cases pass');
    assert.strictEqual(m.believedCloseAt, frozenClose, 'no time may be invented through the live loop either');
    eng.kill();
  });

  // ===========================================================================================
  // N - the KNOWN GAP: _lastResortFloor fires only at landedBids === 0
  // ===========================================================================================

  // N1. WHAT THE SALVAGED INFERENCE IS ACTUALLY WORTH, now that the on-the-board load is no longer
  // excluded from the release. The question is no longer WHETHER the floor is spent on such a load -
  // it is - but WHERE.
  //
  // With the extension count one short, _effectivelyHard stays false, the load never leaves the soft
  // defend branch, and the release fires at the last-chance fallback: 2.5s out, which is 97.5 SECONDS
  // INSIDE this branch's published anti-snipe trigger window, so the shot that was supposed to end the
  // auction starts another round instead. Correcting the count opens the endgame and the shot lands in
  // the band ABOVE the window, where it can actually be final. That is the difference between bidding
  // and winning, and it is what the inference buys.
  //
  // Measured at PRODUCTION cadence, because a band claim measured at 100ms is not a claim about the
  // live loop.
  //
  // REVERSED 2026-09-24, both halves. (a) Outranked at the buzzer of a round before the cap, the load
  // sends its next middle price and keeps the floor for the final round. (b) With the count corrected
  // the known cap is used up, so the floor goes in the last seconds like hard close, not in the band.
  run('N1 an ON-THE-BOARD load: the pre-cap buzzer keeps the floor; a frozen close fires it at the buzzer', () => {
    const mk = (extendsObserved) => {
      const eng = mkEngine();
      const m = armLoad(eng, { extendCap: 3, extendsObserved });
      m.firedRungs.add(0); m.currentRungIndex = 0;
      m.landedBids = 1;                       // the establish bid LANDED - we are on the board
      m._lastDefendAtExtend = extendsObserved; // this round's one defend already fired
      return { eng, m };
    };

    // (a) count one short of the real 3: the load is stuck on the defend branch, and the release is
    // the only thing that spends the floor - at 2.5s, inside the trigger window.
    const a = mk(2);
    assert.strictEqual(a.eng._effectivelyHard(a.m), false, 'fixture: the short count keeps the load on the defend branch');
    const shotsA = sweepCadence(a.eng, a.m, { from: 200_000, rank: 4 });
    const lastA = a.m.ladder.length - 1;
    const shotA = floorShot(shotsA, lastA);
    assert.ok(!shotA,
      `the floor went at ${shotA && shotA.remaining}ms with the count short - reversed 2026-09-24: outranked at a pre-cap `
      + 'buzzer the load sends its next middle price and keeps the floor for the final round');
    // named re-pin: round tracker piece C, rulings 40 and 56 - the pre-cap shot goes in the round's last
    // 6,000 ms (the probe lead), ahead of the 2,500 ms buzzer, not in its last 2,500 ms.
    const buzzA = shotsA.filter((s) => s.remaining <= 6_000 && s.remaining > 2_500);
    assert.ok(buzzA.length === 1 && buzzA[0].rungIndex > 0 && buzzA[0].rungIndex < lastA,
      `pre-cap buzzer sent ${JSON.stringify(buzzA)} - reversed 2026-09-24: one shot at the next middle price, never the `
      + 'floor, so the load is not left silent and the floor is kept for the final round');

    // (b) the countdown freezes at zero past the close, exactly as X1 drives it.
    // named re-pin: round tracker, ruling 56 - no round is inferred; the round reads
    // UNCERTAIN_AFTER_CLOSE and T4's fallback sends the floor at the buzzer (ruling 57).
    const b = mk(2);
    const t0 = Date.now() + 60_000;
    b.m.believedCloseAt = t0;
    b.m._zeroSince = Date.now() - (b.eng.cfg.finalizeDebounceMs + 500);
    b.eng._observeExtension(b.m, frame(t0, { closesInMs: 0 }));
    assert.strictEqual(b.m.extendsObserved, 2, 'the frozen zero must not infer a round');
    assert.strictEqual(b.eng.roundVerdict(b.m).verdict, 'UNCERTAIN_AFTER_CLOSE', 'the frozen zero must make the round uncertain');
    const shotsB = sweepCadence(b.eng, b.m, { from: 200_000, rank: 4 });
    const shotB = floorShot(shotsB, b.m.ladder.length - 1);
    assert.ok(shotB, 'the floor must be spent at a frozen close with nothing to check it against');
    assert.ok(shotB.remaining <= 2_500,
      `the frozen close put the floor at ${shotB.remaining}ms - T4's fallback sends it at the buzzer (<= 2,500ms), not in the band`);
  });

  // N2. THE DELIBERATE BEHAVIOUR CHANGE, pinned - the inverse of what this case used to assert.
  //
  // It previously pinned "on the board, extensions remaining -> the floor stays held" as CURRENT
  // behaviour, with its own message saying the opposite might well be right but needed a decision from
  // the principal rather than a side effect of a forfeit guard. That decision has now been made, and
  // the loads made it: the reported live symptom is "not bidding properly, only first being placed" -
  // landedBids 1, which the old scope excluded by construction - and 15 soft loads across three
  // customers (13 Havells, 1 Epack, 1 Shriji) closed with their floor unspent while armed and priced.
  //
  // The suppression's own reasoning is what fails here. It holds the floor because a price spent early
  // can be undercut for the rest of the auction, which is true mid-auction (W3 still pins it) and
  // vacuous at the buzzer, where there is no rest of the auction. At _isLastChance, outranked, the
  // choice is spend-now versus never-spend, and firing weakly dominates: we cannot go below the floor
  // on either branch, so holding has no upside that firing does not also have.
  //
  // REVERSED 2026-09-24 (the pre-cap buzzer): the last tick of a round before the cap still bids, so the
  // load is never left silent, but it sends the next middle price and keeps the floor for the final round.
  run('N2 BEHAVIOUR CHANGE (deliberate): on the board and outranked, the last pre-cap tick sends the next middle price', () => {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 }); // extensions really do remain
    m.firedRungs.add(0); m.currentRungIndex = 0;
    m.landedBids = 1;
    m._lastDefendAtExtend = 0;
    const last = m.ladder.length - 1;
    const shots = sweepCadence(eng, m, { from: 20_000, rank: 4 });
    // named re-pin: round tracker piece C, rulings 40 and 56 - the pre-cap shot goes in the round's last
    // 6,000 ms (the probe lead), not its last 2,500 ms.
    const shot = shots.find((s) => s.remaining <= 6_000) || null;
    assert.ok(shot,
      'REGRESSION: an on-the-board, outranked load closed silent at the buzzer. This is the reported live symptom '
      + '("only first being placed") and the 15 loads behind it');
    assert.ok(shot.remaining <= 6_000 && shot.remaining > 2_500,
      `the shot fired at ${shot.remaining}ms. It goes in the last 6 s, ahead of the buzzer: mid-auction the reserve-gated `
      + 'defend still governs, or a price spent early can be undercut for the rest of the auction');
    assert.ok(shot.rungIndex > 0 && shot.rungIndex < last && !floorShot(shots, last),
      `the pre-cap buzzer sent rung ${shot.rungIndex} of ${last} - reversed 2026-09-24: outranked at a pre-cap buzzer the `
      + 'load sends its next middle price and keeps the floor for the final round');
  });

  // ===========================================================================================
  // R - routing. The release is a commercial fact for the desk, not an outage for the on-call class.
  // ===========================================================================================

  const noticeEvt = {
    type: 'alert', level: 'warn', kind: 'last_resort_floor_fired', auctionId: '23700092',
    remainingMs: 1200, myRank: null, triggerWindowMs: TRIGGER_MS, extendsObserved: 3, extendCap: 3,
    floor: 28_150,
    detail: 'every soft-close defend path held on the final tick with the floor rung unspent - firing 28150 rather than forfeiting the load',
    lane: { origin: 'ALWAR', destination: 'Manimajra' }, companyName: 'Havells', branchName: 'ALWAR',
  };

  run('R1 last_resort_floor_fired routes as a desk notice, not as an error', () => {
    assert.ok(DESK_NOTICE_KINDS.has('last_resort_floor_fired'), 'the kind is not on the desk-notice channel');
    const n = toNotification(noticeEvt);
    assert.ok(n, 'the event produced no notification at all');
    assert.strictEqual(n.kind, 'desk_notice',
      `routed as '${n.kind}' - paging the fault class for a bid the engine placed correctly is the noise that trains `
      + 'people to stop reading alerts');
  });

  run('R2 the notice carries the scope keys, so it can reach the customer\'s own group', () => {
    const n = toNotification(noticeEvt);
    assert.strictEqual(n.data.shipper, 'Havells', 'no shipper key - no shipper-scoped group can ever match this');
    assert.strictEqual(n.data.branch, 'ALWAR', 'no branch key - a branch-split load routes to the general group, not the branch group');
    assert.strictEqual(n.data.origin, 'ALWAR', 'no origin key');
    assert.strictEqual(n.data.reason, 'last_resort_floor_fired', 'the reason must ride the payload for the template to key on');
  });

  run('R3 the rendered message does NOT tell the desk we declined a load we actually bid', () => {
    const n = toNotification(noticeEvt);
    const body = renderMessage('desk_notice', n.data);
    assert.ok(body && body.length, 'nothing rendered');
    assert.ok(!/not bidding/i.test(body),
      'the desk-notice template\'s refusal default leaked onto a notice about a bid we DID place:\n---\n' + body + '\n---');
    assert.ok(/28,?150/.test(body), 'the price we actually sent is not on the message:\n---\n' + body + '\n---');
  });

  run('R4 it is on exactly ONE channel - not also an error kind', () => {
    assert.ok(!ERROR_KINDS.has('last_resort_floor_fired'),
      'the kind is in BOTH sets; the desk-notice branch is checked first so the error routing would be dead code, '
      + 'but a kind that reads as both is one edit away from paging again');
  });

  // ===========================================================================================
  // W - THROUGH _maybeBid. The gate stack, not just the decision.
  // ===========================================================================================

  // W1. THE CASE NEITHER PR HAD, and the one that matters most. Everything above drives _decide, and
  // _decide never sees the gates that sit above it. This drives the production shape end to end: a
  // soft load whose rung-0 establish is REFUSED, from currentRungIndex -1, rank never arriving, every
  // subsequent write refused, walked at production cadence through the real _maybeBid - and asserts
  // the reserved floor still reaches the wire. It is the assertion that fails on origin/main, fails on
  // the rejection-taxonomy branch alone, and must hold on both branches merged.
  await runAsync('W1 rejected rung-0 establish through _maybeBid: the floor still reaches the wire', async () => {
    const sent = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async (_id, price) => { sent.push(price); return rejectRes(); },
    };
    const eng = mkEngine({ adapter });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    const last = m.ladder.length - 1;
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.ok(sent.includes(m.ladder[last]),
      `the floor price ${m.ladder[last]} never reached the wire. Prices actually sent: [${sent.join(', ')}] - the load `
      + 'closed without our best price ever being offered, which is the 13-load signature');
    assert.ok(sent.length <= 8,
      `${sent.length} refused writes went out on a shared LIVE account for one load. A retry that is bounded only by `
      + 'maxBidsPerMin is not bounded in any way that protects the decisive shot');
  });

  // W2. THE LANDED-THEN-HELD SHAPE - the live client symptom, verbatim: "not bidding properly, only
  // first being placed". Rung 0 is ACCEPTED, so the load is on the board with landedBids 1. Then our
  // own rank never arrives (SuperProcure only self-matches the routed carrier, and on these loads the
  // frame never came), the blind-rank guard holds every discretionary rung, and the load closes with
  // its floor unspent. 15 soft loads across three customers - 13 Havells, 1 Epack, 1 Shriji - closed
  // exactly this way while armed and priced.
  //
  // This is the case the previous scope excluded BY CONSTRUCTION: the never-forfeit release fired only
  // at landedBids === 0, and this load has landedBids 1 from the very bid the client can see. Driven
  // through the real _maybeBid at production cadence, because the whole point is what reaches the wire.
  await runAsync('W2 landed-then-held ("only the first being placed"): the floor still reaches the wire', async () => {
    const sent = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      // Every write is ACCEPTED - this load is not being refused, it is being held.
      placeBid: async (_id, price) => { sent.push(price); return { accepted: true, status: 201, myRank: null, revisionsLeft: null }; },
    };
    const eng = mkEngine({ adapter });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 }); // extensions BELIEVED to remain
    const last = m.ladder.length - 1;
    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture must be the held case: a soft load that never becomes effectively hard on its own');
    await driveMaybeBid(eng, m, { from: 160_000, rank: null }); // rank NEVER arrives
    assert.strictEqual(sent[0], m.ladder[0], 'precondition: the establish bid is the first thing sent');
    assert.ok(m.landedBids >= 1, 'precondition: the establish bid LANDED - this is the on-the-board case');
    assert.ok(sent.includes(m.ladder[last]),
      `only [${sent.join(', ')}] reached the wire - the establish landed and then the engine held for the rest of the `
      + 'auction, closing with the reserved floor unspent. This is the reported live symptom ("only first being '
      + 'placed") and these loads were winnable');
  });

  // W3. ...and the discipline that must survive it. The release is the LAST TICK only: the reserve-gated
  // mid-auction behaviour is untouched, so the floor is not dumped early on an on-the-board load just
  // because the countdown got low. Same fixture as W2, stopped before the last-chance window.
  await runAsync('W3 the widened release is the LAST TICK only - no early floor dump mid-auction', async () => {
    const sent = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async (_id, price) => { sent.push(price); return { accepted: true, status: 201, myRank: null, revisionsLeft: null }; },
    };
    const eng = mkEngine({ adapter });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    const last = m.ladder.length - 1;
    await driveMaybeBid(eng, m, { from: 160_000, to: 3_000, rank: null });
    assert.ok(!sent.includes(m.ladder[last]),
      `the floor went to the wire at ${'>'}3000ms remaining. A price spent before the buzzer can be undercut for the `
      + 'rest of the auction - the reserve suppression is correct everywhere except the last tick');
  });

  // ===========================================================================================
  // S - the desk notice is a MONEY CLAIM. It may only be made where money actually moved.
  // ===========================================================================================

  // S1. SHADOW MODE, whose entire contract is ZERO wire writes. The notice was emitted at DECISION
  // time inside _decide, and _maybeBid reaches its shadow branch afterwards - so the desk group was
  // told "Lowest price sent - nothing left in reserve, Rs 74,410" against placeBid calls: 0.
  await runAsync('S1 shadow mode: no wire write AND no "lowest price sent" claim to the desk', async () => {
    const sent = [];
    const kinds = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async (_id, price) => { sent.push(price); return { accepted: true, status: 201, myRank: 1 }; },
    };
    const eng = mkEngine({ adapter, mode: 'shadow', onEvent: (e) => { if (e && e.kind) kinds.push(e.kind); } });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    assert.strictEqual(m.softStrategy, 'shadow', 'fixture must produce a shadow monitor');
    m.firedRungs.add(0); m.currentRungIndex = 0; m.landedBids = 0;
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.strictEqual(sent.length, 0, `shadow placed ${sent.length} real bid(s) - shadow means zero wire writes`);
    assert.ok(!kinds.includes('last_resort_floor_fired'),
      'shadow told the desk we sent our lowest price on a load nothing was sent on. A money claim made where no money '
      + 'moved is worse than no claim at all - it is the one alert the desk is meant to be able to trust');
  });

  // S2. LIVE, and the platform REFUSED the floor. Nothing landed, so there is nothing to announce.
  // Every other money claim in this engine emits at the fire point, after an accepted response.
  await runAsync('S2 live but the floor was REJECTED: no money claim is made', async () => {
    const kinds = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async () => rejectRes(),
    };
    const eng = mkEngine({ adapter, onEvent: (e) => { if (e && e.kind) kinds.push(e.kind); } });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.ok(!kinds.includes('last_resort_floor_fired'),
      'the desk was told the lowest price was sent on a load where SuperProcure refused every write');
  });

  // S3. LIVE and ACCEPTED - the one case where the claim is true. Exactly once, carrying the price
  // that actually went out.
  await runAsync('S3 live and ACCEPTED: exactly one notice, carrying the price actually sent', async () => {
    const evts = [];
    const sent = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      // rung 0 refused (the establish that started the deadlock); the floor is accepted.
      placeBid: async (_id, price) => {
        sent.push(price);
        if (sent.length === 1) return rejectRes();
        return { accepted: true, status: 201, myRank: 2, revisionsLeft: null };
      },
    };
    const eng = mkEngine({ adapter, onEvent: (e) => { if (e && e.kind === 'last_resort_floor_fired') evts.push(e); } });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
    const last = m.ladder.length - 1;
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.strictEqual(evts.length, 1,
      `${evts.length} last_resort_floor_fired notices for one release - it must be emitted once, at the fire point, `
      + 'not once per tick the guard happened to release on');
    assert.strictEqual(evts[0].floor, m.ladder[last], 'the notice must carry the price that actually went to the wire');
    assert.ok(sent.includes(m.ladder[last]), 'the floor must actually have reached the wire for the claim to be true');
  });

  // (the completion sentinel is registered at the TOP of this file, before any case runs)
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
