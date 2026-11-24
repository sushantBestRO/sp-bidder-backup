'use strict';
/**
 * SOFT-CLOSE DECISION-WRITER SILENCE, ON THE FINE RANK-DRIVEN LADDER - the regression pin for the
 * ladder shape the 64 money-losing production loads ACTUALLY ran.
 *
 * TRACKER
 *   branch fix/rejection-taxonomy-v2, PR #143 (this file is the fine-ladder half of that PR's pin)
 *   the fixes it pins:  496148d  fix(engine): the soft-close floor snipe never fired - release the
 *                                reserved rung where it can end the auction (#133)
 *                       5c459fc  fix(engine): classify SuperProcure rejections into three classes,
 *                                respond per class (#134)
 *                       7a07acb  fix(engine): setSoftClose was deleting the never-forfeit bound
 *   pre-fix tree:       2aaf838  (has _deriveRungCount / interpolateBandLadder, has NO
 *                                _lastResortFloor / _decisiveShotDue / _decisiveBandFor)
 *   diagnosis: docs/diagnoses/2026-08-01_soft-close-retry-deadlock-and-pr-verdict.md
 *   sibling:   scripts/test-softclose-silence-regression.js - the SAME incident on the COARSE ladder.
 *
 * WHY THIS FILE EXISTS, stated as the gap it closes rather than as a restatement of the incident.
 *
 *   The soft-close suite reproduces the incident's customer, lane, prices, clock and extension
 *   mechanics - and then runs a DIFFERENT ENGINE PATH than the incident did.
 *
 *   `_deriveRungCount` (bidEngine.js) reads `meta.rules.revisionLimit`. Above LOW_CAP_THRESHOLD (3)
 *   and on an allowlisted shipper it returns a rung count and `_planFor` builds the anchor-preserving
 *   FINE ladder via interpolateBandLadder; otherwise it returns null and the load keeps the coarse
 *   3-anchor buildBandLadder ladder. Not one soft-close test file sets `meta.rules` at all - every one
 *   of them puts `revisionLimit: 30` on `adapter.capabilities()`, which feeds `monitor.revisionsLeft`
 *   and is NEVER read by `_deriveRungCount`. Measured on this tree:
 *
 *     meta.rules absent (what the whole existing suite arms)  -> ladder.length 3   [78820, 75040, 74410]
 *     meta.rules.revisionLimit 30 (what the 64 loads carried) -> ladder.length 30
 *
 *   The 64 Havells loads that lost the money closed with ~28 revisions still in hand, i.e. they were
 *   30-rung fine-ladder loads. So a regression that restores the production defect on the fine ladder
 *   passes the entire existing suite green. This file arms the fine shape and nothing else.
 *
 * WHAT WAS MEASURED IN PRODUCTION (2026-08-01, 866 closed auctions on the box - not a hypothesis)
 *
 *   64 loads - 23.4% of every closed SOFT-close load, ZERO of 593 hard - landed the opening bid,
 *   adjusted once, then went SILENT for a median of 271s (max 643s) while the auction was still live,
 *   never offered the desk-approved operating floor, and lost. Rs 1,83,266 of authorised headroom was
 *   never put on the board; 33 of the 64 slipped FURTHER back after the engine went quiet, 6 improved.
 *
 *   The IDLE TAIL - the countdown still on the clock at the LAST write, i.e. how long the load ran
 *   with the engine silent before it closed - is the discriminator, and the two populations do not
 *   overlap at all:
 *     hard close  n=571  median   2s  max  29s   ZERO loads idle > 30s
 *     soft close  n=272  median 186s  max 931s   100% of them idle > 60s
 *
 *   One traced Havells load ran 817 decision ticks at closesInMs 0 with rank known (6) and 28
 *   revisions in hand, and placed nothing. Siblings: 817, 1352, 1335 ticks.
 *
 * THE MECHANISM: both sides of the deadlock returned null, and a null decision writes no bid and logs
 * no reason, so the silence was invisible.
 *   1. the defend latch (_lastDefendAtExtend === extendsObserved) permits ONE defend per extension
 *      round. With extendsObserved stuck at 0 the engine defends exactly once, EVER, then holds.
 *   2. the floor snipe is gated behind _effectivelyHard(), which needs extendsObserved >= extendCap.
 *   Both unlock only on an OBSERVED extension. The auctions DO extend - 251 soft loads demonstrably
 *   ran past their believed close (median +183s, matching Havells' extendSeconds 180) - but 62 still
 *   carried extendsObserved == 0 at their last bid.
 *
 * WHICH METRIC F2 GRADES, and the one it deliberately does NOT.
 *
 *   The hard-close ceiling of 29s is a TAIL-TO-CLOSE statistic (last write -> close), so that is what
 *   this file grades. It is NOT an inter-write statistic, and applying it as one would be a category
 *   error that fails the FIXED build for behaviour that is not the defect: the once-per-extension-round
 *   defend latch is deliberate design, and on this fixed tree it produces a measured 77.6s gap between
 *   the single defend and the floor release (writes at 140,000 / 80,000 / 2,400ms remaining) while the
 *   idle tail is 2,400ms. The longest inter-write gap is therefore RECORDED and printed in every
 *   failure message - it is diagnostic - but never asserted. See the report's coverage-gap note.
 *
 * Offline and deterministic: the adapter is stubbed at the placeBid seam (price, rung index and
 * virtual timestamp recorded on every call), a temp-file scheduler, injected rand so every jitter is
 * exactly 0, and a virtual clock pinned to a FIXED EPOCH constant - never the wall clock, because this
 * machine's clock drift changes sign day to day and both rate limiters measure against Date.now.
 * NO network, NO real adapter, NO wall-clock sleeps. This is live-money code sharing a SuperProcure
 * account with the client's human operators; nothing here may reach a real adapter.
 * NO competitor modelling - every input is our own rank, our own ladder, and the load's own published
 * mechanics (legal-independence wall).
 *
 *   node scripts/test-softclose-fine-ladder-silence.js
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

// THE FIXTURE FACT THIS WHOLE FILE TURNS ON. branchBidCountAllowed 30 on the Havells loads, carried
// to the engine on meta.rules - which is what _deriveRungCount reads, and what every existing
// soft-close file omits. Above LOW_CAP_THRESHOLD (3), so the fine ladder is derived.
const REVISION_LIMIT = 30;

// The measured idle-tail populations. The hard-close ceiling is the grading line: 571 hard loads and
// not one of them went longer than this without writing before the close, so a soft load that does is
// the defect, stated in the units the incident was measured in.
const HARD_IDLE_MAX_MS = 29_000;        // hard close, n=571, worst case observed
const SOFT_IDLE_MEDIAN_MS = 186_000;    // soft close, n=272, median
const LOST_64_IDLE_MEDIAN_MS = 271_000; // the 64 losing loads, median idle tail
const LOST_64_IDLE_MAX_MS = 643_000;    // the 64 losing loads, worst case

// The two verbatim SuperProcure refusal bodies from the 135 refusals in the 7 days to 2026-08-01.
// They are DIFFERENT CLASSES with different correct responses, which is the whole point of 5c459fc:
//   PRICE/STATE -> this price was refused, walk the ladder down and retry  (what F3/F4 drive)
//   LOAD-NOT-BIDDABLE -> terminal for the LOAD, stand down after ONE write (not driven here; a
//     stand-down cannot be "driven through the endgame", so it is a separate case - see the report)
// F3 asserts the class it drives really is the retrying one, so the drive cannot silently become a
// one-write stand-down and still pass.
const AMOUNT_INVALID = 'Amount is invalid. Amount should be less than or equal to 78820';

// Determinism seed. Printed in every failure message: a fixed epoch is what makes minInterFireMs and
// the maxBidsPerMin rolling window see the intervals production sees instead of a collapsed run.
const CLOCK_EPOCH = 1_800_000_000_000;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-fine-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// EVERY price that reached the placeBid seam in this file, from every case, tagged with the load's own
// operating floor. F6 grades the cost-floor invariant across the whole set rather than re-asserting it
// per case - one invariant, every path this file exercised.
const ALL_SENDS = [];
const ENGINES = [];

/**
 * A soft-strategy engine wired to a RECORDING placeBid stub. Never the real adapter.
 *
 * `accept: false` returns the verbatim SuperProcure refusal body on the three fields realAdapter
 * actually populates (reason / text / raw) rather than throwing - a throw routes into _maybeBid's
 * UNCERTAIN-OUTCOME handler, which is a different code path from a clean refusal and would measure
 * the wrong thing entirely.
 */
function mkEngine(caseName, { shippers = ['Havells'], mode = 'live', reserve = 1,
  accept = true, rejectBody = null } = {}) {
  const sends = [];
  const clock = { remaining: null };
  const adapter = {
    // revisionLimit here feeds monitor.revisionsLeft (the BUDGET). It is deliberately NOT what
    // derives the ladder - meta.rules is, in armFineLoad below. Both carry 30 so the fixture is the
    // production load in both respects.
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: REVISION_LIMIT, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_auctionId, price) => {
      sends.push({ price, remaining: clock.remaining, vts: Date.now() });
      return accept
        ? { accepted: true, status: 201, myRank: null, revisionsLeft: null }
        : { accepted: false, ok: false, status: 400, reason: rejectBody, text: rejectBody, raw: rejectBody };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers, mode, reserve },
    rand: () => 0,
    onEvent: () => {},
  });
  eng._caseName = caseName;
  eng._sends = sends;
  eng._clock = clock;
  // The virtual clock lives on the ENGINE and starts at a FIXED epoch, so a case driven in two legs
  // keeps moving forward and every run is bit-identical. Deriving it from Date.now() would inherit
  // this machine's drift, whose sign flips day to day.
  eng._vnow = CLOCK_EPOCH;
  ENGINES.push(eng);
  return eng;
}

/**
 * Arm the FINE rank-driven ladder - the incident shape. `meta.rules.revisionLimit` above
 * LOW_CAP_THRESHOLD on an allowlisted shipper is what makes _deriveRungCount return a count instead
 * of null, so this arms ~30 rungs between the desk's three margin anchors instead of the 3-rung
 * coarse ladder the rest of the suite arms. The anchors themselves never move: opening 78820 and
 * floor 74410 are identical on both shapes, which is what makes the two files comparable.
 *
 * The auto-tick is detached so nothing races a real timer, and the soft-close facts are set the way
 * _tick would set them off a live socket frame.
 */
function armFineLoad(eng, { companyName = 'Havells', branchName = 'ALWAR', closeModel = 'soft',
  extendCap = 3, extendsObserved = 0, triggerWindowMs = TRIGGER_MS } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName, branchName, closesAt: Date.now() + 900_000,
    rules: { revisionLimit: REVISION_LIMIT, minDecrement: 100 } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = triggerWindowMs;
  m.extendMs = EXTEND_MS;
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
 * The step is the ENGINE'S OWN _cadence return value, never a fixed small constant. Production polls
 * far at 30,040ms where the decisive band is 2,500ms wide; a 100ms-stepped drive passed for weeks
 * against code that fired on 19 of 200 real loads, because a fine step visits countdown values the
 * engine is never actually offered. Stepping by _cadence reproduces the real blind spots.
 *
 * The global Date.now is restored in a finally.
 */
async function drive(eng, m, { from, to = 0, rank = null, maxTicks = 40_000 }) {
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
  assert.ok(ticks < maxTicks, `drive hit the ${maxTicks}-tick guard - the cadence stopped advancing, so this case measured a stall in the harness, not the engine`);
  for (const s of eng._sends) {
    if (s._tagged) continue;
    s._tagged = true;
    s.rungIndex = m.ladder.indexOf(s.price);
    ALL_SENDS.push({ caseName: eng._caseName, price: s.price, floor: m.floor,
      floorPrice: m.ladder[m.ladder.length - 1], remaining: s.remaining });
  }
  return { sends: eng._sends, ticks };
}

// THE PRODUCTION METRIC: the countdown still on the clock at the LAST write - how long the load ran
// with the engine silent before it closed. `null` when nothing was ever written (a total forfeit).
const idleTailMs = (sends) => (sends.length ? sends[sends.length - 1].remaining : null);

// DIAGNOSTIC ONLY, never asserted - see the header note on which metric F2 grades. The longest silence
// BETWEEN two writes, measured from the first write onward (the pre-establish span is not silence,
// it is the engine deliberately keeping its margin hidden).
const maxWriteGapMs = (sends) => {
  let mx = 0;
  for (let i = 1; i < sends.length; i++) mx = Math.max(mx, sends[i - 1].remaining - sends[i].remaining);
  return mx;
};

// The most writes this load ever placed inside any rolling 60s window - the window maxBidsPerMin
// itself is measured over, computed off the same virtual timestamps the engine's own gate read.
const maxWritesIn60s = (sends) => {
  let mx = 0;
  for (let i = 0; i < sends.length; i++) {
    let n = 0;
    for (let j = 0; j <= i; j++) if (sends[i].vts - sends[j].vts < 60_000) n++;
    mx = Math.max(mx, n);
  }
  return mx;
};

const seqOf = (sends) => sends.map((s) => `${s.price}@${s.remaining}`).join(', ');
const ctx = (eng, sends) => `  [seed epoch ${CLOCK_EPOCH}, rand()=0, writes ${sends.length}, `
  + `idle tail ${idleTailMs(sends)}ms, longest inter-write gap ${maxWriteGapMs(sends)}ms]`;

/**
 * Is this engine build carrying the named internal predicate?
 *
 * This file grades BEHAVIOUR - what reached the placeBid seam and when - because that is what the
 * incident was measured in and what the desk loses money on. The internal predicates are used only for
 * fixture validity and the hard-close leak checks, so the PRE-FIX tree (2aaf838 has no
 * _lastResortFloor / _decisiveShotDue / _decisiveBandFor) must fail on the behaviour it got wrong, not
 * on a TypeError about a helper's name. Ordering matters as much as the guard: every behavioural
 * assertion in a case runs BEFORE any predicate assertion, so a failing run prints the defect and
 * never the API shape.
 */
const has = (eng, fn) => typeof eng[fn] === 'function';

// Our own rank only ever appears AFTER something of ours LANDS - SuperProcure self-matches the routed
// carrier - so a load with nothing on the board sees myRank null for its whole life. Rank 6 is the
// traced Havells load's own rank; it is our own rank and nothing else (legal-independence wall).
const rankAfterLanding = (k) => (m) => (m.landedBids > 0 ? k : null);

// ---------------------------------------------------------------------------------------------
// Each case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of what is broken matters more than failing fast. The exit code stays honest: the
// completion sentinel below asserts every case both RAN and PASSED.
//
// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
// scripts/run-tests.js grades by EXIT CODE ALONE, and this file is async, so a sentinel placed at the
// BOTTOM of the IIFE does not close the hole it was written for: it sits downstream of everything it
// guards, and a `return` above the cases, a swallowed rejection, or a require resolving to a stub all
// skip it along with the cases and reach exit 0 as a silent green zero-assertion run. Registration
// ORDER is the whole fix - an exit handler installed before the work runs fires on every path out.
// ---------------------------------------------------------------------------------------------
let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 6;
process.on('exit', (code) => {
  cleanup();
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close FINE-ladder silence regression: ${pass}/${EXPECTED_CASES} cases passed`);
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
  console.log('soft-close FINE-ladder silence regression (PR #143 / #133 / #134 / 7a07acb)');

  // =============================================================================================
  // F1. THE INCIDENT ITSELF, ON THE LADDER THAT LOST THE MONEY.
  //
  // Havells, meta.rules.revisionLimit 30 so the engine derives its FINE rank-driven ladder, soft
  // close, extendSeconds 180,000, triggerWindowMs 100,000. The opening bid lands, rank comes back 6,
  // extendsObserved never moves off 0, and the clock runs to close. The deadlock made both unlock
  // conditions unreachable, so the engine wrote nothing more and the desk's approved floor was never
  // offered on 64 loads.
  //
  // The DERIVED LADDER LENGTH is asserted first and loudest. Every behavioural assertion below is
  // worthless if the fixture quietly routes back onto the coarse path - which is exactly how the
  // existing suite came to reproduce the incident's customer, prices and clock while running a
  // different engine path. A future change to _deriveRungCount's gates must fail HERE, by name.
  // =============================================================================================
  await runAsync('F1 fine_ladder_incident_shape_does_not_go_silent_at_the_buzzer', async () => {
    const eng = mkEngine('F1');
    const m = armFineLoad(eng);
    const last = m.ladder.length - 1;

    // FIXTURE VALIDITY - this must be the fine, deadlocked shape, not a load that unlocks on its own.
    assert.ok(m.ladder.length > 3,
      `FIXTURE ROUTED ONTO THE COARSE LADDER: _deriveRungCount returned null, so this armed a `
      + `${m.ladder.length}-rung buildBandLadder ladder instead of the fine interpolated one. The 64 loads that lost `
      + `Rs 1,83,266 carried branchBidCountAllowed ${REVISION_LIMIT} and ran ~30 rungs. This file measures nothing until `
      + 'that is true again - check the meta.rules / LOW_CAP_THRESHOLD / allowlist gates in _deriveRungCount');
    assert.strictEqual(m.closeModel, 'soft', 'fixture must be a soft-close load');
    assert.notStrictEqual(m.softStrategy, 'off', 'fixture must be an allowlisted (soft-strategy) load, or nothing runs rank-driven');
    assert.strictEqual(eng._effectivelyHard(m), false,
      'fixture invalid: this load is already effectively hard, so it never enters the deadlock the 64 loads died in');

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(6) });

    assert.strictEqual(m.extendsObserved, 0,
      'fixture invalid: an extension was observed, which is the very thing that did NOT happen on the 62 measured loads');
    assert.ok(sends.length >= 1, `nothing reached the wire at all - the load was forfeited outright.${ctx(eng, sends)}`);
    assert.strictEqual(sends[0].price, m.ladder[0], 'precondition: the opening bid is the first thing sent');

    // named re-pin: round tracker piece C, rulings 40, 47 and 56. extendsObserved is 0 of 3, so this is a
    // round BEFORE the cap: outranked, its one middle price goes at <= 6,000 ms (the probe lead), where the
    // close moving after it would show the round is not final. This drive feeds the engine no read, so
    // nothing answers the probe: at the buzzer it is still pending, and outranked the floor goes
    // (ruling 47). A stuck count is caught before the close instead of closing on a middle price.
    const probeSends = sends.filter((s) => s.remaining <= 6_000 && s.remaining > 2_500);
    assert.ok(probeSends.length === 1 && probeSends[0].rungIndex > 0 && probeSends[0].rungIndex < last,
      `expected one middle price at <= 6,000 ms before the buzzer (the pre-cap shot, rulings 40 and 56), sent `
      + `[${seqOf(probeSends)}]. Prices actually sent: [${seqOf(sends)}].${ctx(eng, sends)}`);
    const buzzerSend = sends[sends.length - 1];
    assert.ok(buzzerSend.remaining <= 2_500 && buzzerSend.price === m.ladder[last],
      `the last send was rung ${buzzerSend.rungIndex} at ${buzzerSend.remaining}ms - the load must not go silent: with `
      + `the pre-cap shot unanswered at the buzzer and the load outranked, the floor goes (ruling 47).${ctx(eng, sends)}`);

    // The rung bookkeeping, which is where the fine ladder can diverge from the coarse one: 30 rungs
    // give selectRung far more room to walk, so the "where do we stand" and "what has been offered"
    // facts have far more chances to disagree. Their disagreement is what shipped the retry deadlock.
    assert.strictEqual(m.currentRungIndex, buzzerSend.rungIndex, 'ladder position does not match the last rung sent');
    assert.ok(m.firedRungs.has(last), 'the floor went on the wire but is not banked as fired');
    assert.strictEqual(m.everBid, true, 'the "has ever bid" fact disagrees with a currentRungIndex >= 0');
    assert.strictEqual(m.landedBids, sends.length, 'the participation count disagrees with what reached the wire');

    // A 30-rung ladder must not become 30 writes. maxBidsPerMin is the runaway guard, not the thing
    // that shapes an ordinary auction - a real load places a handful of bids, nowhere near the cap.
    assert.ok(sends.length < eng.cfg.maxBidsPerMin,
      `${sends.length} writes on one load - a fine ladder is more RUNGS, not more BIDS, and the runaway guard is doing `
      + `work it should never need to.${ctx(eng, sends)}`);
  });

  // =============================================================================================
  // F2. THE IDLE TAIL, on the fine shape. This is the assertion the existing suite never makes here.
  //
  // "A bid eventually happened" passes on the bug - the establish bid also went out on all 64 losing
  // loads. What separates a healthy load from a lost one is a DURATION: the countdown still on the
  // clock when the engine last wrote. Graded against the hard-close population's own measured
  // ceiling, because 571 hard loads never once exceeded it.
  // =============================================================================================
  await runAsync('F2 fine_ladder_idle_tail_stays_within_the_hard_close_ceiling', async () => {
    const eng = mkEngine('F2');
    const m = armFineLoad(eng);

    assert.ok(m.ladder.length > 3,
      `FIXTURE ROUTED ONTO THE COARSE LADDER (${m.ladder.length} rungs) - see F1's note`);

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(6) });

    assert.ok(sends.length >= 1,
      `nothing reached the wire, so the idle tail is the whole auction - the worst reading there is.${ctx(eng, sends)}`);
    const tail = idleTailMs(sends);
    assert.ok(tail <= HARD_IDLE_MAX_MS,
      `the load ran ${Math.round(tail / 1000)}s with the engine silent before it closed. The 64 losing soft loads sat at a `
      + `median idle tail of ${LOST_64_IDLE_MEDIAN_MS / 1000}s (max ${LOST_64_IDLE_MAX_MS / 1000}s), the whole soft population at a `
      + `median of ${SOFT_IDLE_MEDIAN_MS / 1000}s, while 571 hard-close loads NEVER ONCE exceeded ${HARD_IDLE_MAX_MS / 1000}s. `
      + `A soft load above the hard ceiling is the engine going silent on a live auction.${ctx(eng, sends)}`);
    // Tighter, and the one the engine's own config makes checkable: the last write is the decisive
    // shot, so it belongs inside the floor window, not merely under a population ceiling.
    assert.ok(tail <= eng.cfg.floorWindowMs,
      `the last write left ${tail}ms on the clock, outside floorWindowMs (${eng.cfg.floorWindowMs}ms) - the decisive shot did `
      + `not land where a decisive shot lands.${ctx(eng, sends)}`);
  });

  // =============================================================================================
  // F3. REFUSED BIDS DRIVEN THROUGH THE ENDGAME - a path nothing else in the suite exercises. The
  // fixtures' `accept: false` branch has no call site anywhere; it is dead code.
  //
  // Every write is refused with the verbatim production body. This is the PRICE/STATE class of the
  // 2026-08-01 taxonomy (5c459fc), and it is the path the implementation's own comment names as the
  // money risk: the nothing-placed restore puts snipeFired back, which REOPENS the guard above it,
  // leaving softCfg.lastResortFloorAttempts and maxBidsPerMin as the only things bounding a retry
  // against a wall. 135 such refusals landed in the 7 days to 2026-08-01.
  //
  // The contract is the walk-DOWN, not the floor: on a load SuperProcure refuses every time nothing
  // can land, so reaching the floor buys nothing and re-offering a refused price costs a write on a
  // SHARED LIVE ACCOUNT. What must hold is that each refusal moves the ladder on and no price is
  // ever offered twice - the exact property the "blanket rollback of both rung markers" regression
  // destroyed (probed in the impl comment: `9700 x 12`, floor never reached).
  // =============================================================================================
  await runAsync('F3 refused_bids_driven_through_the_endgame', async () => {
    const eng = mkEngine('F3', { accept: false, rejectBody: AMOUNT_INVALID });
    const m = armFineLoad(eng);

    assert.ok(m.ladder.length > 3,
      `FIXTURE ROUTED ONTO THE COARSE LADDER (${m.ladder.length} rungs) - see F1's note`);

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(6) });

    // THE WALK-DOWN, asserted FIRST. Ordering is deliberate and is the same discipline the `has()`
    // helper exists for: a build predating this fix must fail on the BEHAVIOUR it got wrong, never on
    // the shape of a field it does not carry yet. More than one write proves the retry is alive at
    // all; strictly descending and all-distinct proves it is a walk rather than a stuck rung
    // hammering one price.
    assert.ok(sends.length > 1,
      `the engine stopped after ${sends.length} write(s) against a retryable price refusal - the ladder never walked down, `
      + `so a load the desk priced was abandoned on a refusal that was never terminal.${ctx(eng, sends)}`);
    for (let i = 1; i < sends.length; i++) {
      assert.ok(sends[i].price < sends[i - 1].price,
        `write ${i + 1} offered Rs ${sends[i].price} after Rs ${sends[i - 1].price} - the ladder did not move DOWN. A refused `
        + `price re-offered is the deadlock shape: SuperProcure refuses it identically every time, and each attempt spends a `
        + `write on the shared live account for nothing. Sent: [${seqOf(sends)}]${ctx(eng, sends)}`);
    }
    assert.strictEqual(new Set(sends.map((s) => s.price)).size, sends.length,
      `a price was offered twice under persistent refusal. firedRungs IS the walk-down (selectRung reads it), so rolling it `
      + `back above the floor pins the engine on one rung - measured at "9700 x 12, floor never reached". `
      + `Sent: [${seqOf(sends)}]${ctx(eng, sends)}`);

    // The D3 repair, which is what keeps the walk alive on a soft load: a non-cap refusal placed
    // nothing, so the ladder POSITION rolls back and _decide's establish branch stays open. Leaving it
    // advanced is what made 23700092 take one refused establish then 962 blind-rank holds and close
    // with zero landed bids on a load the desk had priced.
    assert.strictEqual(m.currentRungIndex, -1,
      'currentRungIndex stayed advanced after refusals that placed nothing. That permanently closes the establish branch - '
      + 'the one bid allowed to fire without a rank - and on a soft load the blind-rank guard then holds every remaining '
      + 'tick on grounds the rejection itself created');

    // FIXTURE VALIDITY, asserted LAST and through the engine's OWN classification rather than by
    // re-testing the regex: this drive must be the retrying PRICE/STATE class. Had the body been read
    // as either terminal class the engine would have stopped after one write and the bounds in F4
    // would pass vacuously. Tested for TRUTH, not for `=== false`: the point is that the load was not
    // stood down, and a build predating the `loadNotBiddable` field carries undefined rather than
    // false - which must not be reported as this defect.
    assert.ok(!m.loadNotBiddable,
      'the refusal body was classified LOAD-NOT-BIDDABLE, which stands the load down after a single write - a stand-down '
      + 'cannot be driven through the endgame, so this case would be measuring nothing');
    assert.ok(!m.capExhausted,
      'the refusal body was classified as the CAP rejection, which is terminal for the budget and deliberately does NOT '
      + 'restore the endgame latches - the opposite of the path under test');
    assert.ok(!m.landedBids, `${m.landedBids} bid(s) landed, so these were not all refusals`);
  });

  // =============================================================================================
  // F4. THE BOUND ON THAT RETRY, as a concrete ceiling rather than "finite".
  //
  // "Finite" is satisfied by every regression this bound exists to stop. Two shipped ones:
  //   - 23 refused writes on the shared live account where ~5 was correct;
  //   - the never-forfeit release running unbounded at 50 releases per 50 hot polls (fixed 7a07acb,
  //     where setSoftClose was deleting lastResortFloorAttempts on every boot so `n >= undefined`
  //     was false for every n).
  // Both are finite. So the ceilings asserted here are structural numbers the engine itself owns.
  // =============================================================================================
  await runAsync('F4 refused_fine_ladder_write_count_is_bounded', async () => {
    const eng = mkEngine('F4', { accept: false, rejectBody: AMOUNT_INVALID });
    const m = armFineLoad(eng);

    assert.ok(m.ladder.length > 3,
      `FIXTURE ROUTED ONTO THE COARSE LADDER (${m.ladder.length} rungs) - see F1's note`);

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(6) });
    assert.ok(sends.length > 0, 'no writes at all - this bound would pass vacuously');

    // CEILING 1, structural: one write per rung, at most. Each refusal banks its rung and the walk
    // steps past what is banked, so the ladder is a hard budget on how many times a persistently
    // refused load may touch the wire. Exceeding it means a rung was re-offered.
    assert.ok(sends.length <= m.ladder.length,
      `${sends.length} refused writes on a ${m.ladder.length}-rung ladder. Every write above the rung count is a price offered a `
      + `second time into a wall SuperProcure has already refused, on an account shared with the client's human `
      + `operators. Sent: [${seqOf(sends)}]${ctx(eng, sends)}`);

    // CEILING 2, the engine's own runaway guard, measured over the window it is actually defined on.
    // maxBidsPerMin is the one explicit brake on this path (the floor snipe is NOT exempt from it -
    // its gate returns before _decide is ever called), so a drive that exceeds it means the brake did
    // not engage at all.
    const burst = maxWritesIn60s(sends);
    assert.ok(burst <= eng.cfg.maxBidsPerMin,
      `${burst} writes inside a single rolling 60s window against a maxBidsPerMin of ${eng.cfg.maxBidsPerMin} - the runaway guard did `
      + `not engage on a load being refused every time.${ctx(eng, sends)}`);

    // CEILING 3, the bound 7a07acb restored: the never-forfeit release owns an explicit per-load cap
    // and may not lean on maxBidsPerMin. Read off the live config so a future default change moves the
    // assertion with it, and asserted as a real number so the `undefined` regression cannot return.
    // Asserted LAST because it is the one config-shape (rather than behavioural) claim in this case:
    // a tree that predates the never-forfeit release entirely also reports undefined here, which is a
    // TRUE violation of this contract but a different upstream cause than the 7a07acb regression. The
    // message names both so a red run is never mis-attributed.
    assert.ok(Number.isFinite(eng.softCfg.lastResortFloorAttempts) && eng.softCfg.lastResortFloorAttempts > 0,
      `softCfg.lastResortFloorAttempts is ${eng.softCfg.lastResortFloorAttempts}, not a positive number, so nothing bounds the `
      + 'never-forfeit release. Two causes produce this: (a) the 7a07acb defect, where setSoftClose dropped the bound on a '
      + 'build that HAS the release - `attempts >= undefined` is false for every attempts and it ran unbounded at 50 releases '
      + 'across 50 hot polls; or (b) a tree predating _lastResortFloor altogether, where the key never existed. Check whether '
      + 'this build has _lastResortFloor before reading this as (a)');
    const releases = m._lastResortFloorAttempts || 0;
    assert.ok(releases <= eng.softCfg.lastResortFloorAttempts,
      `the never-forfeit release fired ${releases} times against its own bound of ${eng.softCfg.lastResortFloorAttempts}${ctx(eng, sends)}`);
  });

  // =============================================================================================
  // F5. THE CONTROL. 571 hard-close loads are healthy (median idle 2s, max 29s, zero above 30s) and
  // none of this may touch them. Same fine fixture, closeModel 'hard'.
  //
  // WHAT THIS CONTROL DELIBERATELY DOES NOT DO, and why. The coarse sibling proves non-leakage by
  // driving the same load with soft-close ON and OFF and demanding a byte-identical write sequence.
  // That comparison is UNAVAILABLE on this shape and asserting it would be a false negative: the fine
  // ladder is itself derived through _resolveSoftStrategy, so switching soft-close off does not
  // produce the same load bidding differently - it produces a 3-rung load instead of a 30-rung one.
  // Two different ladders cannot be compared rung for rung. What IS assertable, and is what the
  // sibling's second half asserts, are the identities the hard path rests on: the decisive-shot
  // predicate is _isLastChance at EVERY countdown value, the poll cadence is the deployed far/mid/hot
  // mapping with no band pull anywhere, and the establish and buzzer marks are where prod puts them.
  // =============================================================================================
  await runAsync('F5 fine_ladder_hard_close_control', async () => {
    const eng = mkEngine('F5');
    const m = armFineLoad(eng, { closeModel: 'hard', extendCap: null, triggerWindowMs: null });

    assert.ok(m.ladder.length > 3,
      `FIXTURE ROUTED ONTO THE COARSE LADDER (${m.ladder.length} rungs) - the control must run the SAME fine ladder as F1, or `
      + 'it proves nothing about the shape that lost the money');
    assert.notStrictEqual(m.softStrategy, 'off',
      'fixture invalid: the control must run with the soft-close machinery ENABLED and this shipper allowlisted, or it '
      + 'proves nothing about leakage');

    const { sends } = await drive(eng, m, { from: 200_000, rank: rankAfterLanding(6) });

    // BEHAVIOUR FIRST - the deployed hard schedule, in the marks an operator would recognise.
    assert.strictEqual(sends[0].remaining, eng.cfg.openAtMs,
      `the hard-close establish moved to ${sends[0].remaining}ms - it fires at the openAtMs mark (${eng.cfg.openAtMs}ms) and nowhere `
      + `else. Sent: [${seqOf(sends)}]${ctx(eng, sends)}`);
    assert.strictEqual(sends[sends.length - 1].price, m.ladder[m.ladder.length - 1],
      `the hard-close buzzer shot must still be the floor rung. Sent: [${seqOf(sends)}]${ctx(eng, sends)}`);
    const tail = idleTailMs(sends);
    assert.ok(tail <= eng.cfg.floorWindowMs && tail <= HARD_IDLE_MAX_MS,
      `the hard-close idle tail moved to ${tail}ms; the measured population (n=571) never exceeded ${HARD_IDLE_MAX_MS}ms and the `
      + `floor window is ${eng.cfg.floorWindowMs}ms.${ctx(eng, sends)}`);

    // THEN the identities, over the whole countdown rather than at a couple of sampled points.
    for (let r = 200_000; r >= 0; r -= 100) {
      if (has(eng, '_decisiveShotDue')) {
        assert.strictEqual(eng._decisiveShotDue(m, r), eng._isLastChance(r),
          `at ${r}ms remaining the hard-close decisive-shot predicate diverged from _isLastChance - the soft endgame has leaked `
          + 'onto the hard path, which 571 healthy loads run');
      }
      assert.strictEqual(eng._cadence(r, m), eng._cadence(r),
        `at ${r}ms remaining the hard-close poll cadence diverged from the deployed far/mid/hot mapping - the decisive-band pull `
        + 'has leaked onto the hard path');
    }
    if (has(eng, '_decisiveBandFor')) {
      assert.strictEqual(eng._decisiveBandFor(m), null,
        'a hard-close load has no anti-snipe window to dodge, so it must have no decisive band at all');
    }
  });

  // =============================================================================================
  // F6. THE COST-FLOOR INVARIANT, over every write this file produced. The whole incident is about
  // getting the floor OFFERED; the one thing worse than never offering it is offering something under
  // it. A 30-rung ladder has ten times the interpolated prices a coarse one does and every one of them
  // is a chance for a rounding step to land under the anchor, so this matters more here, not less.
  // Graded across all paths at once so no case can exercise a route this does not cover.
  // =============================================================================================
  await runAsync('F6 fine_ladder_floor_invariant', async () => {
    assert.ok(ALL_SENDS.length > 0, 'no writes were recorded at all - this invariant would pass vacuously');
    // Non-vacuity: every earlier case must have contributed at least one write, or a case that
    // silently stopped writing would make this assertion weaker rather than fail.
    for (const c of ['F1', 'F2', 'F3', 'F4', 'F5']) {
      assert.ok(ALL_SENDS.some((s) => s.caseName === c),
        `case ${c} contributed no write to the floor invariant - it is being graded on an empty set`);
    }
    for (const s of ALL_SENDS) {
      assert.ok(s.price >= s.floor,
        `${s.caseName} put Rs ${s.price} on the wire against an operating floor of Rs ${s.floor} - a sub-floor bid left the building`);
      assert.ok(s.price >= s.floorPrice,
        `${s.caseName} put Rs ${s.price} on the wire, below the lowest ladder rung Rs ${s.floorPrice}`);
    }
    const cheapest = Math.min(...ALL_SENDS.map((s) => s.price));
    const floors = new Set(ALL_SENDS.map((s) => s.floor));
    assert.strictEqual(floors.size, 1, 'fixtures drifted apart on the operating floor; this comparison assumes one band');
    assert.strictEqual(cheapest, [...floors][0],
      `the cheapest price offered anywhere in this file was Rs ${cheapest} against an operating floor of Rs ${[...floors][0]} - the `
      + 'fine ladder must still be able to reach its own floor rung, and F1 and F5 are supposed to get there');
  });

  // (the completion sentinel is registered at the TOP of this file, before any case runs)
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
