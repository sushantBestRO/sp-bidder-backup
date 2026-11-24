'use strict';
/**
 * DECISIVE-BAND PREDICATE TRUTH TABLE - the four predicates that decide, on live money, whether the
 * one reserved floor rung is released now, held, or lost with the auction.
 *
 * scripts/test-softclose-decisive-shot-timing.js drives these through _decide and a countdown sweep:
 * it proves the MECHANISM (the shot lands in the band, at production cadence, on every auction).
 * This file is the complement and deliberately does NOT re-drive _decide. It pins the four predicates
 * as a truth table, point by point, so that a one-character operator flip inside any of them dies here
 * with a message naming the exact cell - rather than surfacing three files away as "the floor rung was
 * never spent", which is what the sweep tests can say and no more.
 *
 * The four, and the contract each is held to:
 *
 *   _effectivelyHard(monitor)                -> bool
 *       Three short-circuits to TRUE, then the cap arithmetic:
 *         closeModel !== 'soft'  -> true. No extension mechanic exists, so the close is final.
 *         softStrategy === 'off' -> true. Not opted in; keep the deployed answer everywhere.
 *         extendCap == null      -> true. An unknown cap FAILS CLOSED: SuperProcure omits
 *           branchExtendAuctionCount on real loads, and "we do not know whether extensions remain"
 *           has to resolve to "treat the believed close as final", because the opposite (wait for a
 *           later chance) is how a load closes with its best price never bid.
 *         otherwise              -> extendsObserved >= extendCap.
 *       The first two are also re-checked independently inside _decisiveBandFor. That duplication is
 *       defence in depth and is pinned twice below on purpose: EH6/EH7 hold this predicate, BAND2/BAND3
 *       hold the band's own copy, and dropping EITHER copy alone fails exactly one of the four.
 *
 *   _decisiveBandFor(monitor)                -> {opensAt, closesAt} | null
 *       null on five independent fall-throughs; otherwise _softFinalShotBand(monitor).
 *
 *   _softEndgameUnlocked(monitor, remaining) -> bool
 *       not effectively hard -> false; no band -> _isLastChance; inside the band -> true;
 *       outside a band that exists -> _isLastChance.
 *
 *   _decisiveShotDue(monitor, remaining)     -> bool
 *       soft AND softStrategy !== 'off' -> _softEndgameUnlocked; otherwise _isLastChance, which must be
 *       byte-for-byte the deployed answer for the 571 healthy hard-close loads.
 *
 * These are pure predicates over a monitor, so every case builds a plain monitor object literal and
 * calls the predicate directly. No timers, no countdown sweep, no network, and placeBid is a throw -
 * nothing in this file can reach the wire.
 *
 * WORKED EXAMPLE used throughout, taken from the live Havells soft branch (the same shape the timing
 * suite's header records): branchAuctionRemainingTime 100s, branchAuctionExtendTime 180s, engine
 * floorWindowMs 2,500ms. The band is floorWindowMs wide and opens one floor-window above the
 * anti-snipe trigger window, so it is the half-open interval (100000, 102500] in remaining-ms.
 * Every boundary number below is derived from those three published inputs by hand, not read back
 * off the implementation.
 *
 *   node scripts/test-decisive-band-predicates.js
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
const FAILURES = [];
const STATE_FILE = path.join(os.tmpdir(), `band-predicates-${process.pid}.json`);

// COMPLETION SENTINEL, registered HERE - before the engine is even built, and long before a single
// case runs - and fired on process exit.
//
// scripts/run-tests.js grades every file by EXIT CODE ALONE. A sentinel asserted at the BOTTOM of the
// file does not close the hole it is written for: it sits downstream of everything it guards, so a
// `return` above the cases, a bare process.exit(0), a require resolving to a stub, or a throw caught
// by a handler all skip the sentinel along with the cases and exit 0 as a silent green zero-assertion
// run. Registration ORDER is the whole fix - an exit handler installed before the work runs fires on
// every path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 30;
process.on('exit', (code) => {
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* best effort */ }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\ndecisive-band predicates: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// Each case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of which truth-table cells moved matters more than failing fast. The exit code stays
// honest: the sentinel above asserts every case both RAN and PASSED.
function run(name, fn) {
  ran++;
  try { fn(); ok(name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures. The engine is needed only because these are instance methods that read cfg.floorWindowMs;
// the adapter is inert and placeBid throws, so no case can reach a bid path.
// ---------------------------------------------------------------------------------------------
const FLOOR_WINDOW_MS = 2_500;      // engine config below; the deployed last-chance window
const TRIGGER_WINDOW_MS = 100_000;  // Havells branchAuctionRemainingTime: a bid inside this EXTENDS
const EXTEND_MS = 180_000;          // Havells branchAuctionExtendTime: how far each extension pushes

// Derived BY HAND from the two published numbers above, per the band's definition (one floor-window
// wide, sitting immediately above the anti-snipe trigger window so a shot there cannot self-extend):
const BAND_OPENS_AT = TRIGGER_WINDOW_MS + FLOOR_WINDOW_MS;  // 102_500
const BAND_CLOSES_AT = TRIGGER_WINDOW_MS;                   // 100_000

const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => { throw new Error('placeBid must not be reachable from a predicate unit test'); },
};
const eng = new BidEngine(adapter, new DurableScheduler(STATE_FILE), {
  config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, rungs: 6 },
  softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
  onEvent: () => {},
});

/**
 * The BAND-BEARING monitor: a live Havells soft branch with an UNKNOWN extension cap (the real
 * population - SuperProcure omits the count), an allowlisted soft strategy, and a published
 * anti-snipe window. Every fall-through case below is this exact object with ONE field changed, so a
 * null band is attributable to that one field and nothing else.
 */
const monitor = (o = {}) => Object.assign({
  closeModel: 'soft',
  softStrategy: 'live',
  extendCap: null,
  extendsObserved: 0,
  triggerWindowMs: TRIGGER_WINDOW_MS,
  extendMs: EXTEND_MS,
}, o);

// A countdown sweep that straddles every threshold in play: far above the band, both band edges and
// their neighbours, deep inside the trigger window, both floor-window edges, the buzzer, past-close,
// and the year-2100-placeholder NaN. Used for the hard-close identity control.
const REMAINING_SWEEP = [
  900_000, 200_000, 102_501, 102_500, 102_499, 100_001, 100_000, 99_999,
  50_000, 10_000, 2_501, 2_500, 2_499, 1_200, 1, 0, -1, NaN,
];

console.log('decisive-band predicates');

// =============================================================================================
// _effectivelyHard - the gate every other predicate sits behind.
// =============================================================================================

// catches: default-value swap (`return true` for an unknown cap -> `return false`), i.e. silently
// "hardening away" the fail-closed direction. A null cap means WE DO NOT KNOW; the safe answer is to
// treat the believed close as final, because the alternative is a load that closes with the reserved
// floor unspent while the engine waits for a later chance that never comes.
run('EH1 an UNKNOWN extension cap (null) fails CLOSED to hard', () => {
  // Arrange - SuperProcure omitted branchExtendAuctionCount, which is the common real shape.
  const m = monitor({ extendCap: null, extendsObserved: 0 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'an unknown cap resolved to NOT-hard. That defers the decisive shot to an extension bookkeeping '
    + 'signal SuperProcure never publishes, so the load closes with its best price never bid');
});

// catches: comparator narrowing `extendCap == null` -> `extendCap === null`, which lets an ABSENT
// field (undefined, not null) fall through to `extendsObserved >= undefined` = false and quietly
// un-does the fail-closed rule for every load whose monitor never had the key set at all.
run('EH2 a MISSING extension cap (undefined) fails CLOSED to hard, same as null', () => {
  // Arrange - the key is present-but-undefined, exactly as a monitor built before the field existed.
  const m = monitor({ extendCap: undefined, extendsObserved: 0 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'undefined took a different path from null. `== null` must catch both - an absent cap is no more '
    + 'known than an explicitly null one, and both must fail closed');
});

// catches: comparator flip `>=` -> `<=`, and argument-order swap `observed >= cap` -> `cap >= observed`.
// Both mutants return true here.
run('EH3 one extension BELOW the cap is not yet hard', () => {
  // Arrange - cap 3 is the live Havells value; 2 observed means one extension still remains.
  const m = monitor({ extendCap: 3, extendsObserved: 2 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, false,
    'a load with an extension still in hand was called hard. The reserved floor would be released into '
    + 'a round the auction can still answer, spending our best price where it can be undercut');
});

// catches: comparator flip `>=` -> `>`. This is THE one-character mutation that reopens the original
// bug: at exactly the cap the extensions are exhausted and the next close is final.
run('EH4 exactly AT the cap is hard', () => {
  // Arrange - cap 3, three extensions observed: the auction has no extension left to give.
  const m = monitor({ extendCap: 3, extendsObserved: 3 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'at exactly the cap the load was still treated as extendable. `>=` became `>` - the auction ends '
    + 'while the engine is still holding the floor rung for a round that cannot happen');
});

// catches: off-by-one in the other direction / any bound that stops matching once observed overshoots
// (extensions are counted from a socket feed that can double-count, so cap+1 is a real state).
run('EH5 one extension ABOVE the cap is hard', () => {
  // Arrange
  const m = monitor({ extendCap: 3, extendsObserved: 4 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'an over-run extension count stopped reading as hard - a load past its own cap is unambiguously final');
});

// catches: removal of the `closeModel !== 'soft'` short-circuit that sits AHEAD of the cap arithmetic.
// A hard/unknown branch has no extension mechanic at all, so it is final by construction and its
// extension counters are meaningless - but they can still be POPULATED (the socket writes them off
// whatever the feed carries). Drop the short-circuit and a hard load with a half-used cap starts
// reading as not-final, which reaches _lastResortFloor and the wouldSnipe telemetry, not just routing.
run('EH6 a HARD close model is effectively hard regardless of its extension counters', () => {
  // Arrange - counters say one extension of three is used; the close model says they cannot apply.
  const m = monitor({ closeModel: 'hard', extendCap: 3, extendsObserved: 1 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'a hard-close load read as NOT effectively hard because its extension counters were populated. '
    + 'Hard close has no extension mechanic - the counters are noise and must not gate anything');
});

// catches: removal of the `softStrategy === 'off'` short-circuit. A shipper that was never opted into
// the rung-expansion allowlist must behave exactly like the deployed engine everywhere the engine asks
// "is this auction final?", not only in the band routing.
run('EH7 a soft load with softStrategy "off" is effectively hard regardless of its counters', () => {
  // Arrange - extensions genuinely remain, but this shipper is not opted in.
  const m = monitor({ softStrategy: 'off', extendCap: 3, extendsObserved: 1 });

  // Act
  const hard = eng._effectivelyHard(m);

  // Assert
  assert.strictEqual(hard, true,
    'a non-allowlisted soft load read as NOT effectively hard. That is new behaviour for a shipper '
    + 'nobody opted in - the reversibility spine requires the deployed answer here');
});

// catches: truthy/falsy collapse `extendCap == null` -> `!extendCap`, which swallows cap 0, and any
// off-by-one at the minimum end of the cap range. Table-driven so the Act stays one call.
run('EH8 the cap boundary holds at the MINIMUM caps (0 and 1)', () => {
  // Arrange - min-1 is not expressible (a negative cap is not a thing SuperProcure publishes), so the
  // range starts at 0. Renewsys runs extendSeconds 0, i.e. a cap of 0 that is hard from the first tick.
  const CELLS = [
    { cap: 0, observed: 0, want: true, why: 'cap 0 is hard immediately - there is no extension to wait for' },
    { cap: 1, observed: 0, want: false, why: 'cap 1 with none observed still has its single extension' },
    { cap: 1, observed: 1, want: true, why: 'cap 1 with one observed is exhausted' },
  ];

  // Act
  const wrong = CELLS.filter((c) => eng._effectivelyHard(monitor({ extendCap: c.cap, extendsObserved: c.observed })) !== c.want);

  // Assert
  assert.strictEqual(wrong.length, 0,
    'cap boundary wrong at the minimum caps: '
    + wrong.map((c) => `cap=${c.cap} observed=${c.observed} expected ${c.want} (${c.why})`).join('; '));
});

// =============================================================================================
// _decisiveBandFor - five INDEPENDENT fall-throughs to null, then the one shape that resolves.
// Each is asserted on its own so a future edit that collapses two of them into one condition is
// caught by the case for the condition that was dropped. BAND6 is the control that proves the base
// fixture does resolve a band, without which the five nulls below would be vacuous.
// =============================================================================================

// catches: dropped null-guard `if (!monitor)` -> a throw, or -> a band computed off undefined fields.
run('BAND1 a null monitor resolves no band', () => {
  // Arrange - the engine calls this from _cadence, which can run against a monitor already torn down.
  const noMonitor = null;

  // Act
  const band = eng._decisiveBandFor(noMonitor);

  // Assert
  assert.strictEqual(band, null,
    'a null monitor did not resolve to null - the guard is the only thing between a torn-down monitor '
    + 'and a band computed from undefined fields');
});

// catches: negation dropped / comparator flip on the close-model test (`=== 'soft'` -> `!== 'soft'`).
// A hard branch has no anti-snipe mechanic, so there is no window to dodge and no band to build.
run('BAND2 a HARD close model resolves no band', () => {
  // Arrange - everything else is band-worthy; only the close model differs from the BAND6 control.
  const m = monitor({ closeModel: 'hard' });

  // Act
  const band = eng._decisiveBandFor(m);

  // Assert
  assert.strictEqual(band, null,
    'a hard-close load resolved a decisive band. Hard close has no extension mechanic to avoid, so a '
    + 'band there moves the proven Module-1 snipe off the buzzer for 571 healthy loads');
});

// catches: negation dropped on the allowlist test (`softStrategy === 'off'` -> `!== 'off'`).
// This is the reversibility spine: a customer not on the rung-expansion allowlist keeps the deployed
// timing exactly, so this fix can never move a shipper nobody opted in.
run('BAND3 softStrategy "off" resolves no band', () => {
  // Arrange
  const m = monitor({ softStrategy: 'off' });

  // Act
  const band = eng._decisiveBandFor(m);

  // Assert
  assert.strictEqual(band, null,
    'a non-allowlisted soft load resolved a band - its timing must stay byte-identical to the deployed '
    + 'engine, which is the entire reversibility argument for shipping this');
});

// catches: negation dropped `if (!this._effectivelyHard(m))` -> `if (this._effectivelyHard(m))`.
// While extensions genuinely remain there is no final shot to schedule, so no band.
run('BAND4 extensions still REMAINING resolve no band', () => {
  // Arrange - cap 3 with one observed: two extensions in hand, the close is not final.
  const m = monitor({ extendCap: 3, extendsObserved: 1 });

  // Act
  const band = eng._decisiveBandFor(m);

  // Assert
  assert.strictEqual(band, null,
    'a load with extensions left resolved a decisive band. The floor is reserved precisely until the '
    + 'close is final - a band here dumps it into a round that can still be answered');
});

// catches: constant replaced / condition deleted on the `extendCap === 0` fall-through. REAL CASE:
// six Renewsys loads publish extendSeconds 0 - a HARD window wearing a soft close model. There is no
// anti-snipe mechanic to dodge, so those loads must keep the deployed last-chance answer.
run('BAND5 extendCap 0 - a hard window wearing a soft close model - resolves no band', () => {
  // Arrange - closeModel says soft, but the branch cannot extend even once.
  const m = monitor({ extendCap: 0, extendsObserved: 0 });

  // Act
  const band = eng._decisiveBandFor(m);

  // Assert
  assert.strictEqual(band, null,
    'a branch that can never extend resolved a decisive band. With no extension mechanic there is '
    + 'nothing to dodge, and moving the shot 100s early only exposes the price to the rest of the auction');
});

// catches: math identity collapse / sign flip in the band arithmetic (`trigger + floor` -> `trigger - floor`,
// or either endpoint returned as the trigger window alone). This is the CONTROL for BAND1-5: without a
// resolving base fixture those five nulls prove nothing.
run('BAND6 CONTROL: the live Havells shape resolves the hand-derived band (100000, 102500]', () => {
  // Arrange - the exact live shape: 100s anti-snipe window, 180s extension, 2.5s engine floor window.
  const m = monitor();

  // Act
  const band = eng._decisiveBandFor(m);

  // Assert - opensAt = 100000 + 2500 = 102500 and closesAt = 100000, derived by hand from the load's
  // own published numbers: the band is one floor-window wide and sits immediately ABOVE the trigger
  // window, which is the only place a final shot cannot extend the auction it is meant to end.
  assert.deepStrictEqual(band, { opensAt: BAND_OPENS_AT, closesAt: BAND_CLOSES_AT },
    `the band is ${JSON.stringify(band)}, not (${BAND_CLOSES_AT}, ${BAND_OPENS_AT}]. Either endpoint moving `
    + 'puts the decisive shot back inside the anti-snipe window, where a bid extends the auction instead '
    + 'of ending it - our best price on the board, blind, with a fresh round handed to every rival');
});

// =============================================================================================
// _softEndgameUnlocked - the asymmetric comparison `remaining <= opensAt && remaining > closesAt`,
// pinned at both edges in both directions, plus the two fall-through routes.
// =============================================================================================

// catches: comparator flip `remaining <= opensAt` -> `remaining < opensAt`. The band opens AT 102500,
// inclusive - and at production cadence a poll mark can land exactly on an endpoint.
run('UNLOCK1 remaining exactly AT opensAt (102500) unlocks', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, BAND_OPENS_AT);

  // Assert
  assert.strictEqual(unlocked, true,
    'the band did not open at its own opensAt. `<=` became `<`, shaving the one decision point most '
    + 'likely to be offered - the far poll steps in 30s jumps, so losing an endpoint can lose the band');
});

// catches: off-by-one shrinking the band from the top edge inward.
run('UNLOCK2 remaining one ms BELOW opensAt (102499) unlocks', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, BAND_OPENS_AT - 1);

  // Assert
  assert.strictEqual(unlocked, true,
    'one ms inside the top edge did not unlock - the band is narrower than the (100000, 102500] it claims');
});

// catches: comparator flip `<=` -> `>=` / band widening upward. Above the band and nowhere near the
// floor window, the answer must be the deployed hold.
run('UNLOCK3 remaining one ms ABOVE opensAt (102501) does NOT unlock', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, BAND_OPENS_AT + 1);

  // Assert
  assert.strictEqual(unlocked, false,
    'the endgame unlocked ABOVE the band. A floor rung released 102.5s+ out is a price on the board for '
    + 'the rest of the auction, with nothing left to answer the undercut it invites');
});

// catches: comparator flip `remaining > closesAt` -> `remaining >= closesAt`. This edge is EXCLUSIVE by
// design: 100000 remaining IS the anti-snipe trigger boundary, and a bid at or below it extends.
run('UNLOCK4 remaining exactly AT closesAt (100000) does NOT unlock', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, BAND_CLOSES_AT);

  // Assert
  assert.strictEqual(unlocked, false,
    'the band included its own closesAt. `>` became `>=`, which puts the decisive shot exactly ON the '
    + "load's published anti-snipe boundary - the one bid guaranteed to trigger another extension");
});

// catches: off-by-one shrinking the band from the bottom edge inward.
run('UNLOCK5 remaining one ms ABOVE closesAt (100001) unlocks', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, BAND_CLOSES_AT + 1);

  // Assert
  assert.strictEqual(unlocked, true,
    'one ms inside the bottom edge did not unlock - the band is narrower than the (100000, 102500] it claims');
});

// catches: negation dropped `if (!this._effectivelyHard(m))` -> `if (this._effectivelyHard(m))`, i.e.
// the endgame opening on exactly the loads that still have rounds left to play.
run('UNLOCK6 extensions still remaining never unlock, at any remaining time', () => {
  // Arrange - two extensions in hand; sweep the whole countdown including the buzzer.
  const m = monitor({ extendCap: 3, extendsObserved: 1 });

  // Act
  const unlockedAt = REMAINING_SWEEP.filter((r) => eng._softEndgameUnlocked(m, r));

  // Assert
  assert.deepStrictEqual(unlockedAt, [],
    `the endgame unlocked at ${JSON.stringify(unlockedAt)}ms remaining while the load still held `
    + 'extensions. Not-effectively-hard is the first gate and it is unconditional - a load that can '
    + 'still be extended has no final shot to take');
});

// catches: default-value swap on the no-band route (`return this._isLastChance(remaining)` -> `return false`,
// which forfeits every load with no published window, or -> `return true`, which dumps the floor early).
// D6 / the legal-inference wall: when SuperProcure publishes no branchAuctionRemainingTime the engine
// must NOT invent one, so the deployed last-chance answer governs unchanged.
run('UNLOCK7 with NO published trigger window the answer is exactly the deployed last-chance answer', () => {
  // Arrange - no window published, so there is no band to resolve and nothing to move the shot to.
  const m = monitor({ triggerWindowMs: null });

  // Act
  const divergent = REMAINING_SWEEP.filter((r) => eng._softEndgameUnlocked(m, r) !== eng._isLastChance(r));

  // Assert - the sweep pins the shape; the two absolute anchors below pin the VALUE, so a mutation
  // that moves both this predicate and _isLastChance together still dies.
  assert.deepStrictEqual(divergent, [],
    `no-band fallback diverged from the deployed last-chance answer at ${JSON.stringify(divergent)}ms. `
    + 'With no window published a band would have to be fabricated, and a fabricated window is an '
    + 'inference about the load we are not entitled to make');
  assert.strictEqual(eng._softEndgameUnlocked(m, FLOOR_WINDOW_MS), true,
    `no-band anchor: the shot must be due at exactly ${FLOOR_WINDOW_MS}ms, the deployed floor window`);
  assert.strictEqual(eng._softEndgameUnlocked(m, FLOOR_WINDOW_MS + 1), false,
    `no-band anchor: the shot must NOT be due at ${FLOOR_WINDOW_MS + 1}ms, one ms outside the floor window`);
});

// catches: default-value swap on the outside-the-band route (`return this._isLastChance(remaining)` ->
// `return false`), which is a SILENT FORFEIT. Real case: the load was armed late (or the band's poll
// mark was missed) and the countdown is already past the band with the floor rung unspent. Such a shot
// MAY self-extend - that is a deliberate, accepted trade, because forfeiting the load outright with
// budget still in hand is strictly worse than handing the rivals one more round.
run('UNLOCK8 armed late, band already passed, buzzer reached: the shot is RELEASED, not held', () => {
  // Arrange - 1200ms left: past the band, deep inside the trigger window, and inside the floor window.
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, 1_200);

  // Assert
  assert.strictEqual(unlocked, true,
    'the shot was HELD past the band at the buzzer. That is the Alwar forfeit: the load closes with the '
    + 'reserved floor never spent. A shot here may extend the auction, which is worse than a clean band '
    + 'shot and strictly better than not bidding at all');
});

// catches: default-value swap in the other direction (`return this._isLastChance(remaining)` ->
// `return true`), and proves UNLOCK8 is not a constant. Past the band but nowhere near the buzzer,
// the deployed hold still governs.
run('UNLOCK9 past the band but not yet the buzzer: still held', () => {
  // Arrange - 50000ms left: below the band, inside the trigger window, far outside the floor window.
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, 50_000);

  // Assert
  assert.strictEqual(unlocked, false,
    'the endgame unlocked 50s out, below the band and outside the floor window. That spends the reserved '
    + 'price deep inside the anti-snipe window with 50 seconds left for every rival to undercut it');
});

// catches: ANY comparator flip on either edge at once, and - the reason this case exists - an unlock
// rule that is satisfiable-looking but EMPTY. `_isLastChance(remaining) && outside-the-trigger-window`
// reads as the natural rule and is the empty set at these numbers (2.5s floor vs a 100s window), which
// would forfeit every soft load rather than merely mistime it. That is worse than the original bug.
run('UNLOCK10 the unlock set is non-empty and exactly 2500ms wide on a real branch', () => {
  // Arrange - scan a 200ms-padded range around both edges at 1ms resolution, so the measured width is
  // independent of where the edges actually are.
  const scan = [];
  for (let r = BAND_CLOSES_AT - 100; r <= BAND_OPENS_AT + 100; r++) scan.push(r);

  // Act
  const unlocking = scan.filter((r) => eng._softEndgameUnlocked(monitor(), r));

  // Assert - exactly 2500 values unlock: the half-open interval (100000, 102500]. A `>` -> `>=` flip
  // reads 2501, a `<=` -> `<` flip reads 2499, and an empty-set rule reads 0.
  assert.strictEqual(unlocking.length, FLOOR_WINDOW_MS,
    `${unlocking.length} of the ${scan.length} scanned remaining-values unlock the endgame, expected exactly `
    + `${FLOOR_WINDOW_MS} (the half-open band (${BAND_CLOSES_AT}, ${BAND_OPENS_AT}]). 0 means the rule is `
    + 'unsatisfiable and every soft load is forfeited; anything else means an edge moved');
  assert.strictEqual(Math.min(...unlocking), BAND_CLOSES_AT + 1,
    `the lowest unlocking value is ${Math.min(...unlocking)}, expected ${BAND_CLOSES_AT + 1} - the bottom edge moved`);
  assert.strictEqual(Math.max(...unlocking), BAND_OPENS_AT,
    `the highest unlocking value is ${Math.max(...unlocking)}, expected ${BAND_OPENS_AT} - the top edge moved`);
});

// catches: NaN leaking through the band comparison as true (a comparison rewritten to `!(remaining > opensAt)`
// inverts NaN handling). SuperProcure publishes a year-2100 PLACEHOLDER close time on some loads, which
// parses as a valid date and produces a nonsense remaining; every time field off that feed has to be
// bound-checked rather than trusted.
run('UNLOCK11 a NaN remaining never unlocks the endgame', () => {
  // Arrange
  const m = monitor();

  // Act
  const unlocked = eng._softEndgameUnlocked(m, NaN);

  // Assert
  assert.strictEqual(unlocked, false,
    'a NaN countdown unlocked the endgame. A placeholder close time would release the reserved floor '
    + 'immediately on a load whose real close is unknown');
});

// =============================================================================================
// _decisiveShotDue - the routing predicate. The whole safety case for shipping this rests on it
// being an IDENTITY on everything that is not an allowlisted soft branch.
// =============================================================================================

// catches: any leak of the new band logic into hard-close loads (the 571 healthy ones). Sweep-wide
// identity plus two absolute anchors, so a mutation moving BOTH this and _isLastChance together
// still dies on the anchors.
run('DUE1 CONTROL hard close: byte-for-byte the deployed last-chance answer, across the countdown', () => {
  // Arrange - a hard branch, allowlisted shipper, unknown cap: the shape most able to leak.
  const m = monitor({ closeModel: 'hard' });

  // Act
  const divergent = REMAINING_SWEEP.filter((r) => eng._decisiveShotDue(m, r) !== eng._isLastChance(r));

  // Assert
  assert.deepStrictEqual(divergent, [],
    `hard close diverged from the deployed answer at ${JSON.stringify(divergent)}ms remaining. Hard-close `
    + 'timing is proven in production on 571 loads and this change is not allowed to move any of it');
  assert.strictEqual(eng._decisiveShotDue(m, FLOOR_WINDOW_MS), true,
    `hard-close anchor: the shot must be due at exactly ${FLOOR_WINDOW_MS}ms, the deployed floor window`);
  assert.strictEqual(eng._decisiveShotDue(m, FLOOR_WINDOW_MS + 1), false,
    `hard-close anchor: the shot must NOT be due at ${FLOOR_WINDOW_MS + 1}ms - one ms outside the floor window`);
});

// catches: negation dropped on the allowlist test (`softStrategy !== 'off'` -> `=== 'off'`). A soft
// load whose shipper was never opted in runs the deployed engine unchanged - the reversibility spine.
run('DUE2 CONTROL soft but softStrategy "off": byte-for-byte the deployed last-chance answer', () => {
  // Arrange
  const m = monitor({ softStrategy: 'off' });

  // Act
  const divergent = REMAINING_SWEEP.filter((r) => eng._decisiveShotDue(m, r) !== eng._isLastChance(r));

  // Assert
  assert.deepStrictEqual(divergent, [],
    `a non-allowlisted soft load diverged from the deployed answer at ${JSON.stringify(divergent)}ms. `
    + 'No shipper gets new timing without being opted in');
});

// catches: default-value swap on the non-soft route (`return this._isLastChance(remaining)` -> `false`)
// for the shape most likely to be mis-routed - a HARD branch carrying populated extension counters,
// which is what the socket writes whenever the feed supplies them. A hard-close load must snipe at the
// buzzer no matter what those counters say.
//
// NOT claimed here: the `and` -> `or` swap in the routing condition. That mutant is EQUIVALENT on this
// tree, because _effectivelyHard and _decisiveBandFor each re-check closeModel and softStrategy
// themselves, so the OR-mutant's extra trip through _softEndgameUnlocked lands back on _isLastChance
// with the same answer. Verified by hand-mutation; recorded rather than papered over with a case that
// would pass either way.
run('DUE3 hard close with extension bookkeeping set: the buzzer shot still fires', () => {
  // Arrange - closeModel hard, but cap/observed say a soft-style extension remains.
  const m = monitor({ closeModel: 'hard', extendCap: 3, extendsObserved: 1 });

  // Act
  const due = eng._decisiveShotDue(m, 1_200);

  // Assert
  assert.strictEqual(due, true,
    'a hard-close load stopped sniping at the buzzer because its extension counters were populated. '
    + 'Hard close has no extension mechanic - `and` became `or` and the soft gate is now deciding for '
    + 'loads that never asked for it');
});

// catches: default-value swap on the non-soft route for the OTHER population that must not move - a
// soft branch whose shipper was never opted in, carrying extension counters that say a round remains.
// It must still take the deployed buzzer shot, exactly as prod does today.
run('DUE4 softStrategy "off" with extensions remaining: the buzzer shot still fires', () => {
  // Arrange
  const m = monitor({ softStrategy: 'off', extendCap: 3, extendsObserved: 1 });

  // Act
  const due = eng._decisiveShotDue(m, 1_200);

  // Assert
  assert.strictEqual(due, true,
    'a non-allowlisted soft load stopped sniping at the buzzer. Its timing must be identical to the '
    + 'deployed engine, extension counters or not');
});

// catches: whole-branch collapse `_decisiveShotDue` -> `return this._isLastChance(remaining)`, i.e. the
// change reverted to a no-op while every control above still passes. This is the ONLY case where the
// soft route and the deployed answer disagree, so it is the case that proves the soft branch is
// genuinely reached.
run('DUE5 DISCRIMINATOR allowlisted soft with extensions remaining: the buzzer shot is HELD', () => {
  // Arrange - an allowlisted soft branch with two extensions still in hand.
  const m = monitor({ extendCap: 3, extendsObserved: 1 });

  // Act
  const due = eng._decisiveShotDue(m, 1_200);

  // Assert - the deployed answer here is TRUE (1200ms is inside the floor window), so a false reading
  // is only possible if the soft route actually ran.
  assert.strictEqual(due, false,
    'the soft route was not taken: the load still had extensions left and the shot came due anyway, '
    + 'which is the deployed answer verbatim. Either the routing condition collapsed or the whole '
    + 'predicate reverted to _isLastChance - the change is a no-op');
});

// (the completion sentinel is registered at the TOP of this file, before any case runs)
