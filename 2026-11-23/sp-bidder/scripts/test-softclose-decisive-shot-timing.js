'use strict';
/**
 * SOFT-CLOSE DECISIVE-SHOT TIMING - the money-path regression suite for two live defects.
 *
 * Defect 1 (SELF-EXTENSION). On a soft (anti-snipe) branch the reserved floor rung was released by
 * _isLastChance alone - the fixed 2.5s floorWindowMs. Every real soft branch publishes an anti-snipe
 * trigger window (branchAuctionRemainingTime) of 100-200 SECONDS, so 2.5s is deep INSIDE it, and a bid
 * landing there is exactly what causes the next extension. The decisive shot therefore extended the
 * auction it was meant to end: our best price on the board, blind, out of ammunition, with a fresh
 * round handed to every rival.
 *
 * Defect 2 (FORFEIT-BY-HOLD, the Havells Alwar loss). The soft-close defend branch has five discretionary
 * HOLD paths (blind rank, no reserve slack, the once-per-round latch, the outside-trigger-window gate,
 * and selectRung declining). Each returns null. The final-snipe branch sits BELOW them in _decide, so a
 * hold landing on the last tick forfeits the load outright with the floor rung never spent. The in-code
 * claim that "holding can cost margin; it can never cost the auction" was false.
 *
 * Both are the same structural root: the reserved decisive rung was not correctly REACHABLE on a soft
 * branch - released at a moment where it could not be final (defect 1), and swallowed entirely by an
 * upstream hold (defect 2).
 *
 * Drives _decide directly with scripted states - no timers, no network, no wall-clock waits - the same
 * reach-into-internals style as test-softclose-extend-sequences.js. NO competitor modelling anywhere:
 * every input is our own rank, the load's own published clock, and the load's own published mechanics.
 *
 *   node scripts/test-softclose-decisive-shot-timing.js
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
const tmp = () => path.join(os.tmpdir(), `sc-shot-${process.pid}-${seq++}.json`);
const CLEAN = [];
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const FAILURES = [];

// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
//
// The runner grades by EXIT CODE ALONE. The sentinel used to be an assert at the BOTTOM of the file,
// which does not close the hole it was written for: it sits DOWNSTREAM of everything it guards, so
// deleting a case is caught but anything that ends the process before reaching it - a `return` above
// the cases, a bare `process.exit(0)`, a throw swallowed by a handler - skips the assert along with
// the cases and exits 0 as a silent green zero-assertion run.
//
// Registration ORDER is the whole fix. An exit handler installed before the work runs fires on every
// path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 20;
process.on('exit', (code) => {
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close decisive-shot timing: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// Real Havells soft-branch shape, as read off the live load object:
//   branchAuctionRemainingTime 100s -> a bid landing with <= 100_000ms left CAUSES an extension
//   branchAuctionExtendTime    180s -> each extension pushes the close out by 180_000ms
const TRIGGER_WINDOW_MS = 100_000;
const EXTEND_MS = 180_000;

function mkEngine({ mode = 'live', reserve = 1, shippers = ['Havells'] } = {}) {
  const f = tmp(); CLEAN.push(f);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached in these decision tests'); },
  };
  return new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers, mode, reserve },
    onEvent: () => {},
  });
}

// Arm on the coarse 3-rung desk band every current customer runs: rung 0 establish, rung 1 the one
// defend step, rung 2 the reserved floor. Detach the auto-tick so decisions are driven synchronously.
function armLoad(eng, { companyName = 'Havells', closeModel = 'soft', extendCap = null,
  triggerWindowMs = TRIGGER_WINDOW_MS, extendsObserved = 0, revisionsLeft = 30 } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'A', destination: 'B' }, units: 1, companyName,
    closesAt: Date.now() + 900_000 };
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
 * Walk the load's own countdown from `from` down to 0 at `stepMs`, recording every decision the engine
 * makes and the remaining-time it was made at. `rank` may be a function of (monitor, remaining) so a
 * case can model our own rank arriving late - our rank only, never any rival's price.
 */
function sweep(eng, m, { from, to = 0, stepMs = 100, rank }) {
  const shots = [];
  for (let r = from; r >= to; r -= stepMs) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) { shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe, defend: !!d.defend });
      applyDecision(m, d); }
  }
  return shots;
}

/**
 * The SAME walk, stepped at the cadence the engine itself would have scheduled - `_cadence`, with the
 * production far/mid/hot mapping (30_000 / 1_000 / 200 ms at the 60s / 10s thresholds).
 *
 * WHY THIS EXISTS, and why the 100ms `sweep` above is not enough on its own. A 100ms sweep offers the
 * engine a decision point every 100ms of countdown. Production never does: above 60s to close the poll
 * is ~30 SECONDS apart. Any rule whose satisfying set is narrower than one poll interval is therefore
 * satisfiable-in-theory and unreachable-in-practice, and a 100ms sweep cannot tell the two apart - it
 * reports the rule as reachable while the live loop steps straight over it. That is exactly how a
 * 2,500ms decisive band sitting ~102,500ms out (well inside far-poll territory) stayed invisible.
 *
 * Every timing claim about WHERE the decisive shot lands has to be made against this walk.
 */
function sweepCadence(eng, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const shots = [];
  let r = from;
  let ticks = 0;
  while (r >= to && ticks++ < maxTicks) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) { shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe, defend: !!d.defend });
      applyDecision(m, d); }
    // `_cadence` is passed the monitor as well as the countdown. On origin/main it takes one argument
    // and simply ignores the second, so this walk is the production cadence on BOTH trees.
    r -= Math.max(1, eng._cadence(r, m));
  }
  return shots;
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

console.log('soft-close decisive-shot timing');

// ---------------------------------------------------------------------------------------------
// D1 - THE SELF-EXTENSION DEFECT, unknown cap. SuperProcure omitted branchExtendAuctionCount, so
// _effectivelyHard degrades to TRUE from the first tick and the load is treated as hard. The deployed
// engine then releases the floor at <= 2_500ms remaining, which is 97.5 SECONDS inside this branch's
// own published 100s anti-snipe trigger window. The load's published mechanic says a bid there extends
// the auction. The decisive shot must land where it can actually BE decisive.
// ---------------------------------------------------------------------------------------------
run('D1 unknown cap: the decisive rung is never spent inside the anti-snipe trigger window', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: null });
  const last = m.ladder.length - 1;
  // establish fires at max(openAtMs, triggerWindow + establishLeadMs) = 140_000; sweep from above it.
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'the reserved floor rung must be spent before close - a soft load that never bids its best price is a forfeit');
  assert.ok(shot.remaining > m.triggerWindowMs,
    `the decisive shot landed at ${shot.remaining}ms remaining, INSIDE this branch's ${m.triggerWindowMs}ms anti-snipe trigger window - `
    + 'a bid there extends the auction instead of ending it, spending our best price into a round we then cannot answer');
});

// ---------------------------------------------------------------------------------------------
// D2 - a KNOWN cap that has been reached (the live Havells shape, cap 3). REVERSED 2026-09-24: once the
// known cap is used up no bid can extend the auction, so the decisive shot goes in the last seconds like
// hard close. The band above the trigger window is kept only for an UNKNOWN cap (D1, D18).
// ---------------------------------------------------------------------------------------------
run('D2 cap reached: the decisive rung lands in the last-chance window, like hard close', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'the reserved floor rung must be spent before close');
  assert.ok(shot.remaining <= 2_500,
    `the decisive shot landed at ${shot.remaining}ms remaining - reversed 2026-09-24: after the extension cap final `
    + 'bids go in the last seconds like hard close (<= 2,500ms), not ~100s out where rivals can undercut them freely');
});

// ---------------------------------------------------------------------------------------------
// D3 - REACHABILITY. The structural guard against "fixing" defect 1 with a predicate that can never be
// satisfied. floorWindowMs is 2_500 and a real trigger window is 100_000-200_000, so any unlock rule of
// the form (_isLastChance AND outside-the-trigger-window) is the empty set and the reserved rung would
// NEVER fire on a soft branch. This case fails loudly if that is ever reintroduced.
// ---------------------------------------------------------------------------------------------
run('D3 the decisive rung is reachable on a soft branch at some point in the countdown', () => {
  for (const cap of [null, 0, 3]) {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: cap, extendsObserved: cap == null ? 0 : cap });
    const last = m.ladder.length - 1;
    const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
    assert.ok(floorShot(shots, last),
      `extendCap=${cap}: the reserved floor rung NEVER fired anywhere in the countdown - the unlock predicate is unsatisfiable, `
      + 'which forfeits every soft load instead of self-extending it');
  }
});

// ---------------------------------------------------------------------------------------------
// D4 - NEVER FORFEIT, blind rank. This is the Havells Alwar loss reproduced: a REJECTED establish bid
// banks firedRungs + currentRungIndex (the reject handler does this deliberately, "consumed; try a lower
// one next") and the restore block rolls back only snipeFired and _lastDefendAtExtend. currentRungIndex
// is now >= 0, so _decide's establish branch is closed forever; nothing ever LANDS, so SuperProcure
// never self-matches us and our own rank stays null for the life of the auction. The blind-rank guard
// then holds on every tick - and it sits ABOVE the final-snipe branch, so the floor rung is never
// spent and the load is lost in silence. Three loads, Rs 1,25,000.
// ---------------------------------------------------------------------------------------------
run('D4 rejected establish + rank never arrives: the decisive rung still reaches the wire', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 }); // extensions believed REMAINING
  const last = m.ladder.length - 1;
  // the reject handler's banking, verbatim (bidEngine _maybeBid, non-cap rejection path)
  m.firedRungs.add(0);
  m.currentRungIndex = 0;
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: null }); // rank NEVER arrives
  assert.ok(floorShot(shots, last),
    'nothing was ever bid: the establish branch is closed by the banked rung, rank never arrives, and every soft-branch hold '
    + 'returns null above the final snipe - the load is forfeited with the floor rung unspent');
});

// ---------------------------------------------------------------------------------------------
// D5 - NEVER FORFEIT, no reserve slack. A different hold path, same forfeit. With revisionsLeft at the
// reserve the discretionary defend is correctly refused - but that refusal must not also swallow the
// decisive shot on the last tick.
// ---------------------------------------------------------------------------------------------
run('D5 no reserve slack and nothing on the board: the hold does not swallow the decisive shot', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1, revisionsLeft: 1 }); // exactly the reserve
  const last = m.ladder.length - 1;
  m.firedRungs.add(0); m.currentRungIndex = 0;  // establish was attempted...
  m.landedBids = 0;                             // ...and REJECTED, so nothing is on the board
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: 2 });
  assert.ok(floorShot(shots, last),
    'the reserve gate held on the last tick with zero landed bids - the load closes having never been bid');
});

// ---------------------------------------------------------------------------------------------
// D5b - THE BOUNDARY, restated after the deliberate widening (2026-08-01). This case used to pin the
// opposite: the release fired only at landedBids === 0, so a load we were ALREADY bidding could close
// with its floor unspent, and its own message said that might well be right but needed a decision
// rather than a side effect. The decision was made by the loads - the reported live symptom is "not
// bidding properly, only first being placed" (landedBids 1, excluded by the old scope by construction)
// and 15 soft loads across three customers closed with the floor unspent while armed and priced.
//
// The boundary that remains is TIME, not participation: the release is the last tick only, so a price
// is never spent early where it could be undercut for the rest of the auction. Both halves asserted
// here, so a re-narrowing to landedBids 0 and an early floor dump each fail loudly.
// ---------------------------------------------------------------------------------------------
run('D5b BOUNDARY: on the board, the floor is released at the buzzer and nowhere earlier', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1, revisionsLeft: 1 });
  const last = m.ladder.length - 1;
  m.firedRungs.add(0); m.currentRungIndex = 0;
  m.landedBids = 1;  // the establish bid LANDED - we are on the board
  const shots = sweepCadence(eng, m, { from: 160_000, rank: 2 });
  const shot = floorShot(shots, last);
  assert.ok(shot,
    'REGRESSION: an on-the-board, outranked load closed with its floor unspent - the reported live symptom. The '
    + 'release must not be re-narrowed to landedBids === 0 without a decision that says so');
  assert.ok(shot.remaining <= 2_500,
    `the floor was spent at ${shot.remaining}ms remaining. The widening is the buzzer only: a price spent earlier `
    + 'can be undercut for the rest of the auction, which is the reserve strategy and still stands');
});

// ---------------------------------------------------------------------------------------------
// D6 - the discipline that must SURVIVE the fix. While the cap says extensions genuinely remain, the
// floor stays reserved through the whole non-final stretch: it is not dumped early just because the
// countdown is low, and the one defend step is still the reserve-gated reaction. Only the genuinely-last
// tick may release it.
// ---------------------------------------------------------------------------------------------
run('D6 extensions still remaining: the floor is not dumped before the final window', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 0 });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 160_000, to: 3_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  assert.ok(!floorShot(shots, last),
    'the reserved floor rung was spent while the load still had extensions left - a price spent early can be undercut for the rest of the auction');
});

// ---------------------------------------------------------------------------------------------
// D7 - HARD-CLOSE BYTE-IDENTITY. A hard branch has no anti-snipe mechanic, so nothing here may move:
// the proven Module-1 snipe still fires inside floorWindowMs.
// ---------------------------------------------------------------------------------------------
run('D7 hard close: the proven Module-1 snipe still fires inside floorWindowMs', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { closeModel: 'hard', extendCap: null, triggerWindowMs: null });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 30_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'hard close must still snipe the floor');
  assert.ok(shot.remaining <= 2_500, `hard-close snipe moved to ${shot.remaining}ms - it must stay inside floorWindowMs`);
});

// ---------------------------------------------------------------------------------------------
// D8 - NON-ALLOWLISTED BYTE-IDENTITY. A soft-close load whose shipper is not on the rung-expansion
// allowlist runs the DEPLOYED always-floor snipe unchanged. The reversibility spine: no existing
// customer's timing shifts because of this fix.
// ---------------------------------------------------------------------------------------------
run('D8 soft but not allowlisted: deployed always-floor snipe, unchanged', () => {
  const eng = mkEngine({ shippers: ['SomeoneElse'] });
  const m = armLoad(eng, { extendCap: null });
  assert.strictEqual(m.softStrategy, 'off', 'fixture must produce a non-allowlisted monitor');
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 30_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'non-allowlisted soft load must still snipe the floor');
  assert.ok(shot.remaining <= 2_500, `non-allowlisted snipe moved to ${shot.remaining}ms - it must stay byte-identical to prod`);
});

// ---------------------------------------------------------------------------------------------
// D9 - NO FABRICATED WINDOW (D6, the legal/inference wall). When SuperProcure does not publish
// branchAuctionRemainingTime the engine must NOT invent one. With no window there is nothing to move
// the shot to, so the deployed last-chance answer governs.
// ---------------------------------------------------------------------------------------------
run('D9 unknown trigger window: falls back to the deployed last-chance answer, no invented window', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: null, triggerWindowMs: null });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 60_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'unknown window must still snipe');
  assert.ok(shot.remaining <= 2_500, `unknown window produced a shot at ${shot.remaining}ms - a window was fabricated`);
});

// ---------------------------------------------------------------------------------------------
// D10 - SINGLE DECISIVE SHOT. The floor is fired exactly once no matter how long the auction runs on.
// ---------------------------------------------------------------------------------------------
run('D10 the decisive rung is spent exactly once', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: null });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const n = shots.filter((s) => s.rungIndex === last).length;
  assert.strictEqual(n, 1, `the floor rung fired ${n} times - the decisive shot must be single`);
});

// ---------------------------------------------------------------------------------------------
// D11 - WINNING IS STILL SACRED. The never-forfeit release must never give away an L1 we already hold.
// ---------------------------------------------------------------------------------------------
run('D11 holding L1: the never-forfeit release never gives away a leading bid', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
  const last = m.ladder.length - 1;
  const shots = sweep(eng, m, { from: 160_000, stepMs: 100, rank: (mon) => (mon.firedRungs.size ? 1 : null) });
  assert.ok(!floorShot(shots, last), 'the floor was spent while we were already L1 - that only pushes the clock out and invites a counter');
});

// ---------------------------------------------------------------------------------------------
// D12 - THE HEADLINE MECHANISM, MEASURED AT PRODUCTION CADENCE. Everything above walks the countdown
// at 100ms, a resolution the live loop never provides above the 10s hot threshold. The decisive band
// is floorWindowMs wide (2,500ms) and opens at triggerWindowMs + floorWindowMs = 102,500ms on a real
// Havells branch - and _cadence(102_500) is the 30-SECOND far poll. A real poll loop therefore steps
// from ~110,000 to ~80,000 and never offers the engine a single decision point inside the band.
//
// So the band, as originally written, was satisfiable and unreachable: a rule the tests could see and
// the engine could not. This case is the one that tells those apart.
//
// REVERSED 2026-09-24 for this cap-reached fixture: with the known cap used up the band is no longer
// used, and the decisive shot must land in the last-chance window at production cadence instead.
// ---------------------------------------------------------------------------------------------
run('D12 PRODUCTION CADENCE: on a cap-reached load the decisive shot lands at the buzzer, not in the band', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
  const last = m.ladder.length - 1;
  const band = eng._softFinalShotBand(m);
  assert.ok(band, 'fixture must publish a usable trigger window');
  const shots = sweepCadence(eng, m, { from: 160_000, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'the reserved floor rung was never spent at production cadence');
  assert.ok(shot.remaining <= 2_500,
    `the decisive shot landed at ${shot.remaining}ms - reversed 2026-09-24: after the extension cap final bids go in `
    + `the last seconds like hard close (<= 2,500ms), not in the band (${band.closesAt}, ${band.opensAt}]`);
});

// ---------------------------------------------------------------------------------------------
// D13 - the same claim as a RATE, not a single lucky run. The far poll is jittered (cadenceJitterMs),
// so where a real countdown's poll marks fall relative to the band is effectively random per auction.
// REVERSED 2026-09-24 with D12: on every cap-reached load the shot lands at the buzzer.
// ---------------------------------------------------------------------------------------------
run('D13 every cap-reached soft auction takes its decisive shot at the buzzer, none in the band', () => {
  const N = 200;
  let atBuzzer = 0;
  let fired = 0;
  for (let i = 0; i < N; i++) {
    const eng = mkEngine();
    const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 });
    const last = m.ladder.length - 1;
    // vary where the poll marks fall relative to the band, exactly as a real arm time does
    const shots = sweepCadence(eng, m, { from: 160_000 + (i * 137) % 30_000, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
    const shot = floorShot(shots, last);
    if (shot) fired++;
    if (shot && shot.remaining <= 2_500) atBuzzer++;
  }
  assert.strictEqual(fired, N, `the floor failed to fire at all on ${N - fired} of ${N} auctions`);
  assert.strictEqual(atBuzzer, N,
    `only ${atBuzzer} of ${N} cap-reached auctions placed the decisive shot at <= 2,500ms - reversed 2026-09-24: after `
    + 'the extension cap final bids go in the last seconds like hard close, not in the band above the trigger window');
});

// ---------------------------------------------------------------------------------------------
// D14 - NEVER-FORFEIT, AFTER A REFUSED FLOOR. The guard's whole job is that a hold is never the last
// word. But it gated on `snipeFired || firedRungs.has(last)`, and the rejection path BANKS firedRungs
// while the restore rolls back only snipeFired. So one non-cap refusal of the floor rung permanently
// disabled the guard - the identical forfeit it exists to prevent, one level deeper.
//
// SPENT MEANS LANDED. A refused bid put nothing on the board, so the decisive shot is still owed.
// ---------------------------------------------------------------------------------------------
run('D14 a REFUSED floor does not disable the never-forfeit guard - spent means LANDED, not offered', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 }); // extensions believed to remain
  const last = m.ladder.length - 1;
  // the reject handler's banking, verbatim: rung 0 refused, then the floor offered and refused too.
  m.firedRungs.add(0); m.firedRungs.add(last);
  m.currentRungIndex = last;
  m.snipeFired = false;      // restored by the non-cap NOTHING-PLACED block
  m.landedBids = 0;          // nothing ever reached the board
  const shots = sweepCadence(eng, m, { from: 160_000, rank: null });
  assert.ok(floorShot(shots, last),
    'the floor was never re-offered after being refused once: firedRungs.has(last) latched the guard OFF, so the load '
    + 'closed with nothing on the board and budget still in hand - the exact forfeit this guard exists to prevent');
});

// ---------------------------------------------------------------------------------------------
// D15 - the OTHER half of the same bank, on the branch that owns the floor once the endgame IS open.
// With extensions exhausted the load runs the snipe branch, whose single-shot guard also reads
// firedRungs. A refused floor there made _decide return null for the entire remaining countdown -
// silent forfeit, with no hold to blame and nothing in the log to see.
// ---------------------------------------------------------------------------------------------
run('D15 endgame open, floor refused: _decide does not go silent for the rest of the countdown', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 3 }); // cap reached -> the snipe branch owns it
  const last = m.ladder.length - 1;
  m.firedRungs.add(0); m.firedRungs.add(last);
  m.currentRungIndex = last;
  m.snipeFired = false;
  m.landedBids = 0;
  const shots = sweepCadence(eng, m, { from: 160_000, rank: 3 });
  assert.ok(floorShot(shots, last),
    'the snipe branch dead-ended on firedRungs.has(last) and returned null on every remaining tick - the reserved '
    + 'shot was abandoned because it was OFFERED once, not because it ever landed');
});

// ---------------------------------------------------------------------------------------------
// D16 - the retry has an EXPLICIT BOUND. The diagnosis names this as a requirement in its own right:
// leaning on maxBidsPerMin as the only brake is what let a retry loop eat the budget the decisive shot
// needed. A load SuperProcure refuses forever must not produce an unbounded stream of refused writes
// on a shared live account.
// ---------------------------------------------------------------------------------------------
run('D16 the never-forfeit release is explicitly bounded, not left to maxBidsPerMin', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
  const last = m.ladder.length - 1;
  m.firedRungs.add(0);
  m.currentRungIndex = 0;
  m.landedBids = 0;
  // Every offer is refused, so nothing is ever banked as landed - the unbounded case.
  const shots = [];
  for (let r = 2_500; r > 0; r -= 200) {
    const d = eng._decide(m, st(r, null));
    if (d) shots.push(d);           // deliberately NOT applied: a refused bid advances no state
  }
  assert.ok(shots.length >= 1, 'the floor must still be offered at least once');
  const bound = eng.softCfg.lastResortFloorAttempts;
  assert.ok(Number.isFinite(bound) && bound > 0, 'there is no configured bound on the never-forfeit retry at all');
  assert.ok(shots.length <= bound,
    `the never-forfeit release fired ${shots.length} times in one 2.5s window against a bound of ${bound} - an `
    + 'unbounded retry on a load the platform refuses is exactly the runaway the explicit bound exists to stop');
});

// ---------------------------------------------------------------------------------------------
// D17 - the WINNING guard inside _lastResortFloor, exercised directly. An audit found it dead: 8,180
// recorded entries into the guard, none with rank 1, and deleting the line left the whole suite green.
// It is KEPT, and this case is why rather than an argument for why.
//
// Two reasons. It is a one-line belt on live money whose failure mode is giving away an L1 we already
// hold - a guard is not made worthless by never having fired, and "no test covers it" is an argument
// for a test, not for deleting it. And it stops being dead the moment the establish branch can hold
// with a rank in hand, which is exactly what the rejection-taxonomy rung rollback produces: with
// currentRungIndex restored to -1, `myRank === 1` at step 2 is no longer upstream of every route into
// this function, so a load standing at L1 on a foreign bid can reach it. Covered here as a unit so
// the guard is pinned on THIS branch rather than acquiring its first coverage in a later one.
// ---------------------------------------------------------------------------------------------
run('D17 rank 1: the never-forfeit release refuses to give away a leading bid', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
  const last = m.ladder.length - 1;
  m.landedBids = 0; m.snipeFired = false;
  assert.strictEqual(eng._lastResortFloor(m, st(1_200, 1), 1_200, last), null,
    'the release fired while we were already L1 - spending the floor there only pushes the clock out and invites a counter');
  // ...and the same call with any other rank DOES release, so the null above is the rank guard and
  // not some unrelated gate quietly holding.
  const m2 = armLoad(eng, { extendCap: 3, extendsObserved: 1 });
  m2.landedBids = 0; m2.snipeFired = false;
  assert.ok(eng._lastResortFloor(m2, st(1_200, 2), 1_200, last),
    'control: at rank 2 the release must fire, or D17 proves nothing about the rank guard');
});

// ---------------------------------------------------------------------------------------------
// D18 - SCOPE, stated as a test because the PR body states it as prose. An UNKNOWN extension cap
// (SuperProcure omitted branchExtendAuctionCount) fails _effectivelyHard CLOSED to true (D4), so those
// loads get the band as well - they are not only the cap-reached population. Failing closed means
// treating the believed close as final, and on a branch that publishes an anti-snipe window the band
// is where a final shot belongs. Pinned at production cadence, since that is the only walk that can
// tell a reachable rule from a merely satisfiable one.
// ---------------------------------------------------------------------------------------------
run('D18 unknown cap: the band governs those loads too, at production cadence', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: null });
  const last = m.ladder.length - 1;
  assert.strictEqual(eng._effectivelyHard(m), true, 'fixture: an unknown cap must fail closed to true (D4)');
  const band = eng._decisiveBandFor(m);
  assert.ok(band, 'an unknown-cap soft load with a published window must resolve a band');
  const shots = sweepCadence(eng, m, { from: 160_000, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'the reserved floor rung must still be spent');
  assert.ok(shot.remaining <= band.opensAt && shot.remaining > band.closesAt,
    `unknown cap put the decisive shot at ${shot.remaining}ms, outside the band (${band.closesAt}, ${band.opensAt}]`);
});

// A soft branch that publishes extendCount 0 is a HARD window wearing a soft close model: there is no
// anti-snipe mechanic to dodge, so it must keep the deployed last-chance answer and must NOT have its
// poll cadence pulled toward a band it does not use.
run('D19 extendCap 0: no band, no cadence pull, deployed last-chance answer', () => {
  const eng = mkEngine();
  const m = armLoad(eng, { extendCap: 0, extendsObserved: 0 });
  const last = m.ladder.length - 1;
  assert.strictEqual(eng._decisiveBandFor(m), null, 'a branch that cannot extend has no decisive band');
  // Compared against the far-poll FLOOR, not against a second _cadence call: the far/mid cadence is
  // jittered per call, so two calls never return the same number and an equality assertion here would
  // be testing Math.random. A cadence still >= pollFarMs at 102.5s out is what "not pulled in" means.
  assert.ok(eng._cadence(102_500, m) >= eng.cfg.pollFarMs,
    `the cadence was pulled to ${eng._cadence(102_500, m)}ms toward a band this load does not use`);
  const shots = sweepCadence(eng, m, { from: 160_000, rank: (mon) => (mon.firedRungs.size ? 2 : null) });
  const shot = floorShot(shots, last);
  assert.ok(shot, 'extendCap 0 must still snipe the floor');
  assert.ok(shot.remaining <= 2_500, `extendCap 0 shot moved to ${shot.remaining}ms - it must stay on the deployed answer`);
});

// (the completion sentinel is registered at the TOP of this file, before any case runs)
