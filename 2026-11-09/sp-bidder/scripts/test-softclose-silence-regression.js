'use strict';
/**
 * SOFT-CLOSE DECISION-WRITER SILENCE - the regression pin for the two-way deadlock that made the
 * engine stop writing on a live soft auction and lose it holding a price it never offered.
 *
 * TRACKER
 *   branch fix/rejection-taxonomy-v2, PR #143 (this file is the regression pin for that PR)
 *   the two fixes it pins:  496148d  fix(engine): the soft-close floor snipe never fired - release
 *                                    the reserved rung where it can end the auction (#133)
 *                           5c459fc  fix(engine): classify SuperProcure rejections into three
 *                                    classes, respond per class (#134)
 *   diagnosis: docs/diagnoses/2026-08-01_soft-close-retry-deadlock-and-pr-verdict.md
 *
 * WHAT WAS MEASURED IN PRODUCTION (2026-08-01, 866 closed auctions on the box - not a hypothesis)
 *
 *   64 loads - 23.4% of every closed SOFT-close load, and ZERO hard-close loads - land the opening
 *   bid, adjust once, then go SILENT for a median of 271s (max 643s) while the auction is still
 *   live, never offer the operating floor the desk approved, and lose.
 *
 *   The idle tail (time from the LAST write to the close) splits totally, with no overlap:
 *     hard close  n=571  median   2s  max  29s  ZERO loads idle > 30s
 *     soft close  n=272  median 186s  max 931s  100% of them idle > 60s
 *
 *   One traced Havells load (closed 14:31:03 IST) ran 817 decision ticks at closesInMs 0 with rank
 *   known (6) and 28 revisions in hand, and placed nothing. Siblings: 817, 1352, 1335 ticks.
 *
 * THE MECHANISM, and why nothing in the logs showed it: BOTH sides of the deadlock returned null,
 * and a null decision writes no bid and logs no reason. The silence was invisible.
 *   1. the defend latch (_lastDefendAtExtend === extendsObserved) permits ONE defend per extension
 *      round. With extendsObserved stuck at 0 the engine defends exactly once, EVER, then holds.
 *   2. the floor snipe is gated behind _effectivelyHard(), which needs extendsObserved >= extendCap.
 *   Both unlock only on an OBSERVED extension. The auctions DO extend - 251 soft loads demonstrably
 *   ran past their believed close (median +183s, matching Havells' extendSeconds 180 exactly) - but
 *   62 still carried extendsObserved == 0 at their last bid.
 *
 * WHAT THIS FILE ASSERTS, and how it differs from the neighbouring soft-close suites. The existing
 * files assert that a decision is REACHABLE (floor-reachability) and that it lands in the right BAND
 * (decisive-shot-timing). Neither measures the production symptom, which is a DURATION: how long the
 * engine went without writing before the close. Every case here is graded on the IDLE TAIL of what
 * actually reached the placeBid seam, against the hard-close population's own measured ceiling.
 *
 * Offline and deterministic: stub adapter at the placeBid seam (every call recorded), temp-file
 * scheduler, injected rand so the cadence jitter is 0, a virtual clock so the rate limiters see the
 * intervals production sees. NO network, NO real adapter, NO wall-clock sleeps. NO competitor
 * modelling - every input is our own rank, our own ladder, and the load's own published mechanics.
 *
 *   node scripts/test-softclose-silence-regression.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// ---------------------------------------------------------------------------------------------
// The live branch mechanics, read off the load objects on the box.
// ---------------------------------------------------------------------------------------------
// Havells soft branch: branchAuctionRemainingTime 100s (a bid landing with <= 100,000ms left CAUSES
// an extension), branchAuctionExtendTime 180s (each extension pushes the close out by 180,000ms).
const TRIGGER_MS = 100_000;
const EXTEND_MS = 180_000;

// The measured idle-tail populations. The hard-close ceiling is the grading line: 571 hard loads and
// not one of them went longer than this without writing before the close, so a soft load that does
// is the defect, stated in the units the incident was measured in.
const HARD_IDLE_MAX_MS = 29_000;      // hard close, n=571, worst case observed
const SOFT_IDLE_MEDIAN_MS = 186_000;  // soft close, n=272, median - the shape being killed
const SOFT_IDLE_MAX_MS = 931_000;     // soft close, n=272, worst case observed

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-silence-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// EVERY price that reached the placeBid seam in this file, from every case, tagged with the load's
// own operating floor. C7 grades the cost-floor invariant across the whole set rather than
// re-asserting it per case - one invariant, every path this file exercised.
const ALL_SENDS = [];
const ENGINES = [];

/**
 * A soft-strategy engine wired to a RECORDING placeBid stub. Never the real adapter: this is
 * live-money code sharing a SuperProcure account with human operators at the client, so the seam is
 * stubbed and every call is captured (price, the rung it maps to, the countdown it fired at, ts).
 *
 * rand is injected as () => 0 so the cadence jitter and the establish jitter are both exactly zero -
 * the run has to be bit-identical across repeats or an idle-tail measurement means nothing.
 */
function mkEngine(caseName, { shippers = ['Havells'], mode = 'live', reserve = 1, revisionLimit = 30,
  softEnabled = true, accept = true } = {}) {
  const sends = [];
  const clock = { remaining: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_auctionId, price) => {
      sends.push({ price, remaining: clock.remaining, ts: Date.now() });
      return accept
        ? { accepted: true, status: 201, myRank: null, revisionsLeft: null }
        : { accepted: false, ok: false, status: 400, reason: 'Amount is invalid', text: 'Amount is invalid' };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: softEnabled, shippers, mode, reserve },
    rand: () => 0,
    onEvent: () => {},
  });
  eng._caseName = caseName;
  eng._sends = sends;
  eng._clock = clock;
  // The virtual clock lives on the ENGINE, not inside one drive() call, so a case driven in two legs
  // (an auction that extends between them) keeps moving forward. Restarting it per leg would rewind
  // Date.now behind monitor.lastFireAt and silently block every write in the second leg on the
  // inter-fire gate - a green run that measured a rewound clock instead of the engine.
  eng._vnow = Date.now();
  ENGINES.push(eng);
  return eng;
}

/**
 * Arm on the coarse 3-rung desk band every current customer runs: rung 0 establish, rung 1 the one
 * defend step, rung 2 the reserved floor (cost 70,000 / [12.6, 7.2, 6.3] -> [78820, 75040, 74410]).
 * The auto-tick is detached so nothing races a real timer, and the soft-close facts are set the way
 * _tick would set them off a live socket frame.
 */
function armLoad(eng, { companyName = 'Havells', branchName = 'ALWAR', closeModel = 'soft',
  extendCap = null, extendsObserved = 0, triggerWindowMs = TRIGGER_MS, revisionsLeft = null } = {}) {
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
  if (revisionsLeft != null) m.revisionsLeft = revisionsLeft;
  return m;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });

/**
 * Drive the REAL _maybeBid down the load's own countdown at PRODUCTION cadence on a virtual clock.
 *
 * _maybeBid, NOT _decide: the gate stack that starves a decisive shot (minInterFireMs, the
 * maxBidsPerMin split, the revisions stand-down, the latency guard) all sits ABOVE _decide and
 * returns before it is ever called. A decision-level drive cannot see a load starved before the
 * decision is taken, and that is the class of defect this file exists to stop shipping.
 *
 * A VIRTUAL CLOCK, stepped by exactly the interval the engine itself would have scheduled: both rate
 * limiters are measured against Date.now, so a synchronous drive on the real clock collapses a
 * 200-second countdown into a few milliseconds and measures a rate limiter production never meets.
 * The global is restored in a finally.
 */
async function drive(eng, m, { from, to = 0, rank = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  Date.now = () => eng._vnow;
  let ticks = 0;
  try {
    let r = from;
    while (r >= to && ticks++ < maxTicks) {
      eng._clock.remaining = r;
      const k = typeof rank === 'function' ? rank(m, r) : rank;
      await eng._maybeBid(m, st(r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      eng._vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
  for (const s of eng._sends) {
    if (s._tagged) continue;
    s._tagged = true;
    s.rungIndex = m.ladder.indexOf(s.price);
    ALL_SENDS.push({ caseName: eng._caseName, price: s.price, floor: m.floor,
      floorPrice: m.ladder[m.ladder.length - 1], remaining: s.remaining });
  }
  return { sends: eng._sends, ticks };
}

// The production metric, in the engine's own terms: how long the load went WITHOUT a write before it
// closed. `null` when nothing was ever written - a total forfeit, the worst reading there is.
const idleTailMs = (sends) => (sends.length ? sends[sends.length - 1].remaining : null);

/**
 * Is this engine build carrying the named internal predicate?
 *
 * This file grades BEHAVIOUR - what reached the placeBid seam and when - because that is what the
 * incident was measured in and what the desk loses money on. The internal predicates are used only
 * for fixture validity and for the hard-close leak checks, so a build that predates one must fail on
 * the behaviour it got wrong, not on a TypeError about a helper's name. Ordering matters as much as
 * the guard: every behavioural assertion in a case runs BEFORE any predicate assertion, so the
 * message a failing run prints is the defect and never the API shape.
 */
const has = (eng, fn) => typeof eng[fn] === 'function';
// Our own rank only ever appears AFTER something of ours lands - SuperProcure self-matches the routed
// carrier, so a load with nothing on the board sees myRank null for its whole life.
const rankAfterLanding = (k) => (m) => (m.landedBids > 0 ? k : null);

// ---------------------------------------------------------------------------------------------
// Each case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of what is broken matters more than failing fast. The exit code stays honest: the
// completion sentinel below asserts every case both RAN and PASSED.
//
// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
// scripts/run-tests.js grades by EXIT CODE ALONE, and this file is async, so a sentinel placed at
// the BOTTOM of the IIFE does not close the hole it was written for: it sits downstream of
// everything it guards, and a `return` above the cases, a swallowed rejection, or a require
// resolving to a stub all skip it along with the cases and reach exit 0 as a silent green
// zero-assertion run. Registration ORDER is the whole fix - an exit handler installed before the
// work runs fires on every path out of the process.
// ---------------------------------------------------------------------------------------------
let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 7;
process.on('exit', (code) => {
  cleanup();
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close silence regression: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function runAsync(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('soft-close silence regression (PR #143 / #133 / #134)');

  // =============================================================================================
  // C1. THE INCIDENT ITSELF. 64 loads, 23.4% of every closed soft load.
  // =============================================================================================
  //
  // The exact production shape: allowlisted soft load, opening bid LANDS, our rank comes back, the
  // engine adjusts once, extension detection never fires (extendsObserved stays 0), and the clock
  // runs to zero. The deadlock made both unlock conditions unreachable, so the engine wrote nothing
  // more and the desk's approved floor was never offered.
  //
  // Graded on the idle TAIL, and on the rung IDENTITY. "Some bid went out" is not the contract - the
  // establish bid also goes out on all 64 losing loads. What was never offered is the floor.
  await runAsync('C1 soft_load_never_goes_silent_holding_unoffered_floor', async () => {
    const eng = mkEngine('C1');
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 });
    const last = m.ladder.length - 1;

    // fixture validity: this must BE the deadlocked case, not a load that unlocks on its own.
    assert.strictEqual(m.closeModel, 'soft', 'fixture must be a soft-close load');
    assert.notStrictEqual(m.softStrategy, 'off', 'fixture must be an allowlisted (soft-strategy) load');
    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture invalid: this load is already effectively hard, so it never enters the deadlock the 64 loads died in');

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(5) });

    assert.strictEqual(m.extendsObserved, 0,
      'fixture invalid: an extension was observed, which is the very thing that did NOT happen on the 62 measured loads');
    assert.ok(sends.length >= 1, 'nothing reached the wire at all - the load was forfeited outright');
    assert.strictEqual(sends[0].price, m.ladder[0], 'precondition: the opening bid is the first thing sent');

    const floorSend = sends.find((s) => s.price === m.ladder[last]);
    assert.ok(floorSend,
      `the operating floor Rs ${m.ladder[last]} NEVER reached the wire. Prices actually sent: [${sends.map((s) => s.price).join(', ')}]. `
      + 'This is the 64-load signature: open, adjust once, then hold a price the desk approved until the auction closes without it');
    assert.strictEqual(floorSend.price, m.ladder[last],
      'the decisive shot must be the FLOOR rung specifically, not merely "some further bid" - a mid rung leaves the '
      + 'approved price unoffered exactly as the incident did');

    const tail = idleTailMs(sends);
    assert.ok(tail <= eng.cfg.floorWindowMs,
      `the load went ${Math.round(tail / 1000)}s without a write before it closed. The measured soft-close population `
      + `sat at a median idle tail of ${SOFT_IDLE_MEDIAN_MS / 1000}s (max ${SOFT_IDLE_MAX_MS / 1000}s) while 571 hard-close `
      + `loads never once exceeded ${HARD_IDLE_MAX_MS / 1000}s. Anything above floorWindowMs (${eng.cfg.floorWindowMs}ms) `
      + 'here is the engine going silent on a live auction');

    // currentRungIndex is OVERLOADED - it is both "where do we stand on the ladder" and, at -1, "this
    // load has never been bid". A test that leans on one meaning has to show the other still agrees,
    // because the two silently diverging is what shipped the retry deadlock in the first place.
    assert.strictEqual(m.currentRungIndex, last, 'ladder position did not reach the floor rung');
    assert.ok(m.firedRungs.has(last), 'the floor rung was not banked - firedRungs and currentRungIndex disagree');
    assert.strictEqual(m.everBid, true, 'the "has ever bid" fact disagrees with a currentRungIndex >= 0');
    assert.strictEqual(m.landedBids, sends.length, 'the participation count disagrees with what reached the wire');

    // maxBidsPerMin is the third overloaded control (runaway guard AND the floor-shot reserve). The
    // floor landing above must not have come at the cost of the guard, and the guard must not have
    // been what allowed it: a real auction places 3 bids, nowhere near the cap.
    assert.ok(sends.length < eng.cfg.maxBidsPerMin,
      `${sends.length} writes on one load - the runaway guard's ordinary budget is doing work it should never need to`);
  });

  // =============================================================================================
  // C2. THE DEFEND LATCH, on its own. One defend per extension round is correct; one defend per
  // AUCTION is the freeze. With extendsObserved pinned at 0 the latch condition
  // (_lastDefendAtExtend === extendsObserved) is permanently true from the first defend onward, and
  // every subsequent tick took the hold path and returned null - 817, 1352 and 1335 of them on the
  // traced loads, all silent, with no log line between them.
  //
  // Driven in TWO LEGS because that is what stretched the measured idle tail to a 271s median: the
  // auction EXTENDS (251 soft loads demonstrably ran past their believed close by a median of +183s,
  // matching Havells' extendSeconds 180) and the engine does not see it. Leg 2 replays the extended
  // round with extendsObserved deliberately still 0 - detection failed, which is the whole point -
  // so the latch stays pinned across a freeze window the size of the real one.
  // =============================================================================================
  await runAsync('C2 defend_latch_does_not_freeze_the_whole_auction', async () => {
    const eng = mkEngine('C2');
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 });
    const last = m.ladder.length - 1;

    // leg 1: down to just above the last-chance window, so the establish and the single defend fire
    // and nothing else can.
    await drive(eng, m, { from: 200_000, to: 3_000, rank: rankAfterLanding(5) });
    assert.strictEqual(eng._sends.length, 2,
      `expected exactly the opening bid and the one adjustment before the extension; got `
      + `[${eng._sends.map((s) => s.price).join(', ')}]`);
    const defend = eng._sends[1];

    // the extension the engine never counts: the close jumps forward by extendSeconds and the
    // countdown runs down again from there.
    const { sends } = await drive(eng, m, { from: EXTEND_MS, rank: rankAfterLanding(5) });

    // fixture validity: the latch really is stuck shut for the rest of the auction.
    assert.strictEqual(m.extendsObserved, 0, 'fixture invalid: extendsObserved moved, so the latch was never pinned');
    assert.strictEqual(m._lastDefendAtExtend, 0,
      'fixture invalid: no defend ever fired, so this case is not measuring the latch at all');
    assert.strictEqual(m._lastDefendAtExtend, m.extendsObserved,
      'fixture invalid: the latch is not in its frozen state, so a passing result proves nothing');

    const afterDefend = sends.filter((s) => s !== defend && sends.indexOf(s) > sends.indexOf(defend));
    // the freeze window this case actually reproduced, in the units the incident was measured in:
    // countdown burned from the one defend to the next write (or to the close, if there was none).
    const nextWrite = afterDefend.length ? afterDefend[0] : null;
    const silentSpanMs = (defend.remaining - 3_000) + EXTEND_MS - (nextWrite ? nextWrite.remaining : 0);
    assert.ok(silentSpanMs > SOFT_IDLE_MEDIAN_MS,
      `the fixture only reproduced a ${Math.round(silentSpanMs / 1000)}s freeze window, short of the ${SOFT_IDLE_MEDIAN_MS / 1000}s `
      + 'median measured on the losing loads - it is not exercising a freeze of incident size');

    assert.ok(afterDefend.length >= 1,
      `the engine wrote nothing for the whole ${Math.round(silentSpanMs / 1000)}s between its single adjustment and the close, `
      + 'with the latch pinned and an unobserved extension in between. That is the freeze: one defend per AUCTION instead '
      + 'of one per extension round, every tick after it returning null, and nothing in the logs to show for it');
    assert.strictEqual(afterDefend[afterDefend.length - 1].price, m.ladder[last],
      'the engine broke its silence with something other than the floor rung - the reserved price is what the latch was '
      + 'holding, so it is what must come out');
    assert.ok(idleTailMs(sends) <= eng.cfg.floorWindowMs,
      `the frozen latch still cost ${Math.round(idleTailMs(sends) / 1000)}s of silence before the close`);
  });

  // =============================================================================================
  // C3. EXTENSION DETECTION FAILING - the real production case, isolated. The auctions extend (251
  // soft loads demonstrably ran past their believed close, median +183s against Havells'
  // extendSeconds 180), but the engine never counts it, so extendsObserved sits at 0 against a cap
  // of 1 and _effectivelyHard is false for the entire life of the load. The floor must still be
  // offered: correctness of the endgame cannot depend on a detector we have measured to be lossy.
  // =============================================================================================
  await runAsync('C3 extendsObserved_zero_still_reaches_the_floor', async () => {
    const eng = mkEngine('C3');
    const m = armLoad(eng, { extendCap: 1, extendsObserved: 0 });
    const last = m.ladder.length - 1;

    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture invalid: cap 1 with 0 observed extensions must NOT be effectively hard, or the gate under test is bypassed');

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(5) });

    assert.strictEqual(m.extendsObserved, 0,
      'fixture invalid: the extension counter moved, so this no longer models the detector failing');
    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture invalid: the load became effectively hard, so the floor was not reached through the gate under test');
    assert.ok(sends.some((s) => s.price === m.ladder[last]),
      `the floor Rs ${m.ladder[last]} was never offered on a load whose extension count never moved. Sent: `
      + `[${sends.map((s) => s.price).join(', ')}]. 62 of the 64 lost loads had extendsObserved == 0 at their last bid - `
      + 'the endgame must not be gated behind a detector that is measurably lossy');
    assert.ok(idleTailMs(sends) <= eng.cfg.floorWindowMs,
      `idle tail ${Math.round(idleTailMs(sends) / 1000)}s with the extension count stuck at 0`);
  });

  // =============================================================================================
  // C4. THE RENEWSYS BRANCH: a soft close model over an extendCap of 0 - an auction that can NEVER
  // extend (six real loads are configured this way). extendsObserved >= extendCap is satisfied
  // trivially, and there is no anti-snipe window to dodge, so the proven Module-1 last-chance answer
  // must apply. The failure mode being pinned is the opposite of C1's: not a hold that outlives the
  // auction, but a decisive rung that is STRUCTURALLY unreachable because the release predicate is
  // an empty set on this branch shape.
  // =============================================================================================
  await runAsync('C4 renewsys_extendSeconds_zero_branch', async () => {
    const eng = mkEngine('C4');
    const m = armLoad(eng, { extendCap: 0, extendsObserved: 0, triggerWindowMs: 0 });
    const last = m.ladder.length - 1;

    assert.strictEqual(eng._effectivelyHard(m), true,
      'fixture invalid: a cap of 0 means no extension is possible, so the load is effectively hard from the start');

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(5) });
    assert.ok(sends.some((s) => s.price === m.ladder[last]),
      `the floor Rs ${m.ladder[last]} never reached the wire on a load that can never extend. Sent: `
      + `[${sends.map((s) => s.price).join(', ')}]. The reserved rung is locked out for the whole life of the load`);
    assert.ok(idleTailMs(sends) <= eng.cfg.floorWindowMs,
      `idle tail ${Math.round(idleTailMs(sends) / 1000)}s on a non-extending branch`);

    // SATISFIABILITY, asserted directly rather than only inferred from a write. A predicate no
    // countdown value can satisfy converts "spends the floor too early" into "never spends the floor
    // at all", which forfeits the load outright - strictly worse than the defect it would be fixing,
    // and invisible unless something walks the whole countdown looking for a value that opens it.
    if (has(eng, '_decisiveShotDue')) {
      const reachable = [];
      for (let r = 200_000; r >= 0; r -= 100) if (eng._decisiveShotDue(m, r)) reachable.push(r);
      assert.ok(reachable.length > 0,
        'the decisive shot is due at NO point in a 200,000ms countdown on this branch - the release predicate is the '
        + 'empty set here, so the reserved rung is structurally locked out for the whole life of the load');
    }
    if (has(eng, '_decisiveBandFor')) {
      assert.strictEqual(eng._decisiveBandFor(m), null,
        'a load that can never extend has no anti-snipe mechanic to dodge, so it must take the deployed last-chance '
        + 'answer rather than aim at a band');
    }
  });

  // =============================================================================================
  // C5. THE DYNAMIC CABLES RESERVE TRAP - 10 of 10 of their loads lost this way. revisionLimit 3,
  // reserve 1, two attempts already spent, so hasSlack goes false and the discretionary defend is
  // refused. That is correct as far as it goes: the last revision is being held for the decisive
  // shot. The trap is that the gate which would spend it never opens, so the reserve is carried
  // unspent past the close - held for a snipe the gate then forbids.
  //
  // The contract: the reserved revision is SPENT, on the floor, at the buzzer and nowhere earlier.
  // =============================================================================================
  await runAsync('C5 dynamic_cables_reserve_trap', async () => {
    const eng = mkEngine('C5', { revisionLimit: 3, reserve: 1 });
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 });
    const last = m.ladder.length - 1;
    assert.strictEqual(m.revisionsLeft, 3, 'fixture: this is a 3-revision customer');

    // two attempts already spent - the load is on the board at rung 1 with one revision left.
    m.firedRungs.add(0); m.firedRungs.add(1);
    m.currentRungIndex = 1;
    m.landedBids = 2;
    m.revisionsLeft = 1;

    const reserve = eng.softCfg.reserve;
    assert.strictEqual(reserve, 1, 'fixture: reserve 1');
    assert.strictEqual((m.revisionsLeft - reserve) > 0, false,
      'fixture invalid: slack still remains, so the reserve-gated hold under test is never taken');

    const { sends } = await drive(eng, m, { from: 200_000, rank: 4 });

    assert.strictEqual(sends.length, 1,
      `expected exactly the reserved shot to go out; got [${sends.map((s) => s.price).join(', ')}]`);
    assert.strictEqual(sends[0].price, m.ladder[last],
      `the reserved revision was spent on Rs ${sends[0].price}, not on the floor Rs ${m.ladder[last]}`);
    assert.strictEqual(m.revisionsLeft, 0,
      'the reserved revision was carried past the close unspent - held back for a decisive shot that the same gate then '
      + 'refused to authorise. 10 of 10 Dynamic Cables loads closed exactly this way');
    assert.ok(sends[0].remaining <= eng.cfg.floorWindowMs,
      `the reserve was released at ${sends[0].remaining}ms remaining. A price spent before the buzzer can be undercut for `
      + 'the rest of the auction - the reserve discipline is correct everywhere except the last tick');

    // firedRungs is OVERLOADED - it is the walk-down mechanism as well as the bank of what was
    // offered. Leaning on the bank meaning above obliges this to show the walk-down meaning still
    // holds: the floor is now banked, and no already-spent rung was re-offered.
    assert.ok(m.firedRungs.has(last), 'the floor rung was not banked, so the walk-down would re-offer it');
    assert.strictEqual(new Set(sends.map((s) => s.price)).size, sends.length,
      'a price was sent twice - the ladder walk-down re-offered a rung that was already spent');
  });

  // =============================================================================================
  // C6. THE CONTROL. 571 hard-close loads are healthy (median idle 2s, max 29s, zero above 30s) and
  // none of this may touch them. Two proofs, because "the hard load also ends up bidding the floor"
  // is far too weak a claim to carry a 571-load population:
  //   (a) the same hard fixture driven with soft-close ENABLED and with it entirely DISABLED
  //       produces a byte-identical write sequence - same prices, same countdown marks - and the
  //       establish and the buzzer shot both sit where the deployed schedule puts them;
  //   (b) the identities the fix rests on hold on a hard load - the decisive-shot predicate IS
  //       _isLastChance for every countdown value, and the poll cadence is the deployed far/mid/hot
  //       mapping with no band pull anywhere.
  // =============================================================================================
  await runAsync('C6 hard_close_path_is_byte_unchanged', async () => {
    const engOn = mkEngine('C6');
    const mOn = armLoad(engOn, { closeModel: 'hard', extendCap: null, triggerWindowMs: null });
    assert.notStrictEqual(mOn.softStrategy, 'off',
      'fixture invalid: the control must run with the soft-close machinery ENABLED and this shipper allowlisted, or it '
      + 'proves nothing about leakage');
    const { sends: sendsOn } = await drive(engOn, mOn, { from: 200_000, rank: rankAfterLanding(5) });

    // (a) the same load with the soft-close machinery entirely switched off.
    const engOff = mkEngine('C6-control', { softEnabled: false });
    const mOff = armLoad(engOff, { closeModel: 'hard', extendCap: null, triggerWindowMs: null });
    assert.strictEqual(mOff.softStrategy, 'off', 'fixture invalid: the control engine must resolve to strategy off');
    const { sends: sendsOff } = await drive(engOff, mOff, { from: 200_000, rank: rankAfterLanding(5) });

    const fmt = (s) => s.map((x) => `${x.price}@${x.remaining}`).join(', ');
    assert.deepStrictEqual(sendsOn.map((s) => [s.price, s.remaining]), sendsOff.map((s) => [s.price, s.remaining]),
      `a hard-close load bid DIFFERENTLY with soft-close enabled than with it switched off.\n  soft on : [${fmt(sendsOn)}]\n`
      + `  soft off: [${fmt(sendsOff)}]\nThe 571 healthy hard-close loads must not see any of this`);

    assert.strictEqual(sendsOn[0].remaining, engOn.cfg.openAtMs,
      `the hard-close establish moved to ${sendsOn[0].remaining}ms - it fires at the openAtMs mark and nowhere else`);
    assert.strictEqual(sendsOn[sendsOn.length - 1].price, mOn.ladder[mOn.ladder.length - 1],
      'the hard-close buzzer shot must still be the floor rung');
    const tail = idleTailMs(sendsOn);
    assert.ok(tail <= engOn.cfg.floorWindowMs && tail <= HARD_IDLE_MAX_MS,
      `the hard-close idle tail moved to ${tail}ms; the measured population (n=571) never exceeded ${HARD_IDLE_MAX_MS}ms`);

    // (b) the identities, over the whole countdown rather than at a couple of sampled points.
    for (let r = 200_000; r >= 0; r -= 100) {
      if (has(engOn, '_decisiveShotDue')) {
        assert.strictEqual(engOn._decisiveShotDue(mOn, r), engOn._isLastChance(r),
          `at ${r}ms remaining the hard-close decisive-shot predicate diverged from _isLastChance - the soft endgame has `
          + 'leaked onto the hard path');
      }
      assert.strictEqual(engOn._cadence(r, mOn), engOn._cadence(r),
        `at ${r}ms remaining the hard-close poll cadence diverged from the deployed far/mid/hot mapping - the band pull `
        + 'has leaked onto the hard path');
    }
    if (has(engOn, '_decisiveBandFor')) {
      assert.strictEqual(engOn._decisiveBandFor(mOn), null, 'a hard-close load must have no decisive band at all');
    }
  });

  // =============================================================================================
  // C7. THE COST-FLOOR INVARIANT, over every write this file produced. The whole incident is about
  // getting the floor OFFERED; the one thing worse than never offering it is offering something
  // under it. Graded across all paths at once so no case can exercise a route this does not cover.
  // =============================================================================================
  await runAsync('C7 floor_is_never_offered_below_the_operating_floor', async () => {
    assert.ok(ALL_SENDS.length > 0, 'no writes were recorded at all - this invariant would pass vacuously');
    // non-vacuity: every earlier case must have contributed at least one write, or a case that
    // silently stopped writing would make this assertion weaker rather than fail.
    for (const c of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C6-control']) {
      assert.ok(ALL_SENDS.some((s) => s.caseName === c),
        `case ${c} contributed no write to the floor invariant - it is being graded on an empty set`);
    }
    for (const s of ALL_SENDS) {
      assert.ok(s.price >= s.floor,
        `${s.caseName} put Rs ${s.price} on the wire against an operating floor of Rs ${s.floor} - a sub-floor bid `
        + 'left the building');
      assert.ok(s.price >= s.floorPrice,
        `${s.caseName} put Rs ${s.price} on the wire, below the lowest ladder rung Rs ${s.floorPrice}`);
    }
    const cheapest = Math.min(...ALL_SENDS.map((s) => s.price));
    const floors = new Set(ALL_SENDS.map((s) => s.floor));
    assert.strictEqual(floors.size, 1, 'fixtures drifted apart on the operating floor; this comparison assumes one band');
    assert.strictEqual(cheapest, [...floors][0],
      `the cheapest price offered anywhere in this file was Rs ${cheapest} against an operating floor of Rs ${[...floors][0]} - `
      + 'the floor is the price that wins and every case here is supposed to reach it');
  });

  // (the completion sentinel is registered at the TOP of this file, before any case runs)
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
