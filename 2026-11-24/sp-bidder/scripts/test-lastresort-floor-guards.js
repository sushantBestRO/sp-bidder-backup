'use strict';
/**
 * THE NEVER-FORFEIT RELEASE, GUARD BY GUARD - `bidEngine._lastResortFloor`.
 *
 * The soft-close defend branch holds for five separate discretionary reasons (blind rank, no reserve
 * slack, the once-per-round latch, the outside-the-window gate, and selectRung declining), and every
 * one of them returns null. The final-snipe branch sits BELOW that branch in `_decide`, so a hold that
 * lands on the genuinely-last tick used to forfeit the load outright with the reserved rung never
 * spent. Three Havells Alwar loads (Rs 1,25,000) closed exactly that way. `_lastResortFloor` is the
 * one function every one of those holds now routes through, so it is the last thing standing between
 * a priced, armed load and a silent forfeit.
 *
 * `scripts/test-softclose-floor-reachability.js` already asks the REACHABILITY question - does the
 * reserved rung get to the wire, driven through _decide and _maybeBid down a whole countdown - and
 * `test-softclose-decisive-shot-timing.js` (D16/D17) pins the retry ceiling and the rank-1 belt. None
 * of them pins the GUARDS THEMSELVES, one at a time, at the unit. That distinction matters because a
 * sweep answers "did the floor fire somewhere", which stays green when a guard is deleted: delete the
 * rank-1 belt and every sweep still fires the floor, just on loads we were already winning. This file
 * is the other question - for each of the five guards, does it hold when it must, RELEASE when it
 * must, and does it sit where the guard order says it sits.
 *
 * The change being pinned here is the WIDENING. The release was gated on `landedBids === 0`, so the
 * live symptom "not bidding properly, only the first being placed" - a load with exactly one landed
 * establish bid - was excluded from the never-forfeit path BY CONSTRUCTION. Guard 4 now reads two
 * facts TOGETHER: a banked floor index means the floor was OFFERED, and a banked index on a load with
 * something on the board means it LANDED. Either fact read alone is a different defect, and this file
 * fails on both of them (L6 kills `landedBids === 0`, L8 kills `firedRungs.has(last)` alone, and the
 * pair kills `&&` -> `||`). Production evidence for widening rather than holding: across 64 affected
 * loads 33 slipped FURTHER back once the engine went silent and only 6 improved.
 *
 * Offline and deterministic. Plain objects and a fake adapter whose placeBid throws - nothing here may
 * reach a wire, and every case calls the decision function directly, so no bid path is exercised at
 * all. No network, no clock waits, no competitor modelling: every input is our own rank, our own
 * ladder, and the load's own published countdown.
 *
 *   node scripts/test-lastresort-floor-guards.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { assertAboveFloor, selectRung } = require('../src/engine/pricing');

// The real Havells Alwar desk band, as the pricing team enters it: a cost of Rs 70,000 and the coarse
// 3-margin band every current customer runs. 6.3% of 70,000 is 4,410, so the reserved floor rung is
// Rs 74,410 - computed by hand here, deliberately, so no assertion below is derived by re-running the
// ladder builder the engine itself uses.
const COST = 70_000;
const BAND = [12.6, 7.2, 6.3];
const FLOOR_PRICE = 74_410;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `lrf-guards-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const ENGINES = [];
function mkEngine(softOver) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must never be reached in a guard unit test'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: Object.assign({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, softOver || {}),
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

// A freshly armed Havells Alwar load with its auto-tick detached, so every decision below is driven
// synchronously and nothing races a real timer. Never bid, nothing on the board, no shot spent - the
// clean slate each case then perturbs by exactly ONE fact.
function armLoad(eng, marginsPct = BAND) {
  const meta = { id: String(++seq), lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: Date.now() + 900_000 };
  const m = eng.arm(meta, { cost: COST, marginsPct });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.triggerWindowMs = 100_000;   // the live Havells branch fact (branchAuctionRemainingTime 100s)
  m.extendMs = 180_000;
  return m;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });
const lastOf = (m) => m.ladder.length - 1;
// One call at the shape production makes it: (monitor, state, remaining, ladder.length - 1).
const call = (eng, m, remaining, rank) => eng._lastResortFloor(m, st(remaining, rank), remaining, lastOf(m));

// Every case is isolated so ONE failure does not hide the state of the others - on a money path the
// full picture of what is broken matters more than failing fast. The exit code stays honest via the
// completion sentinel below, which asserts every case both RAN and PASSED.
let ran = 0, pass = 0;
const FAILURES = [];

// COMPLETION SENTINEL, registered HERE - before a single case runs - and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE. A sentinel written as an assert at the
// bottom of the file does not close the hole it exists for: it sits DOWNSTREAM of everything it
// guards, so a `return` above the cases, a throw inside a helper, or a require resolving to a stub
// skips the sentinel along with the cases and reaches exit 0 as a silent green zero-assertion run.
// Registration ORDER is the whole fix - an exit handler installed before the work runs fires on every
// path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 14;
process.on('exit', (code) => {
  cleanup();
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nlast-resort floor guards: ${pass}/${EXPECTED_CASES} cases passed`);
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

console.log('last-resort floor guards');

// =================================================================================================
// L1-L3 - GUARD 1: the last tick, and only the last tick.
// =================================================================================================

// L1 is the canonical release and the returned SHAPE, which four different call sites in _decide hand
// straight to the fire point. price is asserted against a number computed by hand (70,000 x 1.063 =
// 74,410), not against a re-run of buildBandLadder, so a ladder builder that silently changed its
// rounding fails here rather than agreeing with itself.
// catches: default value swap (release -> null), constant replaced (ladder[last] -> ladder[0]),
//          truthy/falsy collapse on the snipe/lastResort flags.
run('L1 releases the reserved floor rung on the last tick of a never-bid load, as a lastResort snipe', () => {
  // Arrange - the clean slate: outranked at L4, nothing offered, nothing on the board.
  const eng = mkEngine();
  const m = armLoad(eng);

  // Act
  const d = call(eng, m, 1_200, 4);

  // Assert
  assert.ok(d, 'the release returned null on the final tick of an armed, priced, never-bid load - that load is '
    + 'forfeited in silence with its reserved rung unspent, which is the Rs 1,25,000 Alwar signature');
  assert.strictEqual(d.price, FLOOR_PRICE,
    `released ${d.price}; the reserved rung on a Rs 70,000 cost at the band's 6.3% floor margin is Rs 74,410`);
  assert.strictEqual(d.price, m.ladder[lastOf(m)], 'the released price is not the ladder\'s last rung');
  assert.strictEqual(d.rungIndex, lastOf(m), `rungIndex ${d.rungIndex} is not the floor index ${lastOf(m)} - the fire `
    + 'point banks this index, so a wrong one banks the wrong rung and leaves the floor re-firable');
  assert.strictEqual(d.snipe, true, 'not marked snipe: the caller latches snipeFired off this flag, so an unmarked '
    + 'release can be fired again and again inside the same 2.5s window');
  assert.strictEqual(d.lastResort, true, 'not marked lastResort: the desk notice and the bid log both key on this flag');
});

// L2 is the boundary set on `remaining` against floorWindowMs, the one comparator in guard 1.
// _isLastChance is `remaining <= floorWindowMs`, so the threshold itself RELEASES; threshold+1 holds.
// catches: comparator flip (<= -> <), off-by-one on the window bound.
run('L2 the last-chance boundary is inclusive: holds at floorWindowMs+1, releases at floorWindowMs and below', () => {
  // Arrange
  const eng = mkEngine();
  const W = eng.cfg.floorWindowMs;
  assert.strictEqual(W, 2_500, 'floorWindowMs default moved off 2,500ms - every timing claim in this file and in the '
    + 'reachability suite is stated against that number');
  //                remaining, expect a release?
  const CASES = [[W + 1, false], [W, true], [W - 1, true], [1, true], [0, true], [-1, true]];

  // Act - one fresh monitor per boundary value, so no attempt counter carries across.
  const got = CASES.map(([remaining]) => ({ remaining, d: call(eng, armLoad(eng), remaining, 4) }));

  // Assert
  CASES.forEach(([remaining, shouldRelease], i) => {
    const d = got[i].d;
    if (shouldRelease) {
      assert.ok(d, `remaining ${remaining}ms is at or inside the ${W}ms last-chance window and the floor was NOT `
        + 'released - an exclusive comparator here forfeits every load whose final poll lands exactly on the bound');
      assert.strictEqual(d.price, FLOOR_PRICE, `remaining ${remaining}ms released ${d.price}, not the floor`);
    } else {
      assert.strictEqual(d, null, `remaining ${remaining}ms is OUTSIDE the ${W}ms window and the floor was released `
        + 'anyway - the reserve is dumped mid-auction, where a price spent early can be undercut for the rest of the '
        + 'auction (this is the discipline W3 in the reachability suite protects)');
    }
  });
});

// L3. SuperProcure publishes a year-2100 placeholder close time on some loads; the derived countdown
// comes through as NaN. `NaN <= 2500` is false, so a placeholder must read as "not the last tick" and
// hold. The opposite reading dumps the reserved floor the moment such a load is armed.
// catches: truthy/falsy collapse (a `remaining <= W || !Number.isFinite(remaining)` "fix"), and any
//          NaN-tolerant rewrite of the last-chance predicate.
run('L3 a NaN countdown (the year-2100 placeholder) is NOT the last tick - the floor stays reserved', () => {
  // Arrange
  const eng = mkEngine();
  const m = armLoad(eng);

  // Act
  const d = call(eng, m, NaN, 4);

  // Assert
  assert.strictEqual(d, null, 'a placeholder/NaN countdown released the reserved floor. SuperProcure\'s year-2100 '
    + 'close time parses as a valid date, so this is not a hypothetical: it would dump our lowest price at arm time '
    + 'on a load with hours left to run');
});

// =================================================================================================
// L4 - GUARD 2: a decisive shot already in flight or spent.
// =================================================================================================

// catches: negation dropped (`if (monitor.snipeFired)` -> `if (!monitor.snipeFired)`), guard deleted.
run('L4 holds when a decisive shot is already in flight or spent (snipeFired)', () => {
  // Arrange - identical loads; the ONLY difference is the latch.
  const eng = mkEngine();
  const spent = armLoad(eng);
  spent.snipeFired = true;
  const fresh = armLoad(eng);

  // Act
  const d = call(eng, spent, 1_200, 4);

  // Assert
  assert.strictEqual(d, null, 'a second decisive shot was released while one was already in flight - inside a 2.5s '
    + 'window at the hot poll cadence that is a burst of duplicate writes on a shared LIVE account');
  // Control: the same call on the same fixture WITHOUT the latch must release, or the null above
  // proves nothing about this guard.
  assert.ok(call(eng, fresh, 1_200, 4),
    'control: with snipeFired false the identical load must release, otherwise L4 is measuring some other hold');
});

// =================================================================================================
// L5 - GUARD 3: never give away an L1 we already hold. This is a money guard.
// =================================================================================================

// D17 in test-softclose-decisive-shot-timing.js pins the hold and its rank-2 control. What is NOT
// pinned anywhere is that the rank-1 hold is FREE - that it costs none of the bounded attempts. It
// must be, because a load can stand at L1 on a foreign bid, get beaten a tick later, and still need
// its full budget of shots. That is the same fact as guard ordering (L12) seen from the money side.
// catches: comparator flip (=== 1 -> !== 1 / >= 1), guard deleted, attempt increment hoisted above it.
run('L5 holds while we are leading (rank 1), and that hold costs none of the bounded attempts', () => {
  // Arrange
  const eng = mkEngine();
  const m = armLoad(eng);

  // Act - three final-tick calls while we hold L1, then the rank we actually have when beaten.
  const whileLeading = [call(eng, m, 1_200, 1), call(eng, m, 1_100, 1), call(eng, m, 1_000, 1)];

  // Assert
  whileLeading.forEach((d, i) => assert.strictEqual(d, null, `call ${i + 1} released the floor while we were L1 - `
    + 'undercutting our own leading bid gives away margin we had already won and invites a counter-bid'));
  assert.ok(call(eng, m, 900, 2), 'after three L1 holds the load was beaten to L2 and the release refused to fire: the '
    + 'leading-hold consumed the attempt budget, so a load we led until the last second forfeits its floor');
});

// =================================================================================================
// L6-L8 - GUARD 4: the WIDENING. Two facts read together, never one alone.
// =================================================================================================

// L6 IS THE CHANGE. Under the old `landedBids === 0` rule this load held and the auction closed with
// the reserve unspent - the reported live symptom, "not bidding properly, only the first being placed"
// (15 soft loads across three customers). The floor here has never been offered, so nothing of ours is
// standing at it, so there is nothing for a re-send to duplicate.
// catches: the reverted `landedBids === 0` gate, `&&` -> `||` in guard 4, guard 4 self-banking the rung.
run('L6 releases on a load ALREADY ON THE BOARD whose floor rung was never offered (the widening)', () => {
  // Arrange - two bids landed, ladder walked to rung 1; the floor index is NOT in firedRungs.
  const eng = mkEngine();
  const m = armLoad(eng);
  const last = lastOf(m);
  m.landedBids = 2;
  m.currentRungIndex = 1;
  m.firedRungs.add(0); m.firedRungs.add(1);
  assert.ok(!m.firedRungs.has(last), 'fixture: the reserved floor rung must be unoffered');

  // Act
  const d = call(eng, m, 1_200, 5);

  // Assert
  assert.ok(d, 'an on-the-board load closed with its reserved floor rung unspent. Two bids landing does not put the '
    + 'FLOOR on the board, and holding bought nothing in production: of 64 affected loads 33 slipped further back '
    + 'once the engine went silent and only 6 improved');
  assert.strictEqual(d.price, FLOOR_PRICE, `released ${d.price} on the on-the-board load, not the Rs 74,410 floor`);
  assert.strictEqual(m.firedRungs.has(last), false, 'the release BANKED the floor rung itself. Banking belongs to the '
    + 'fire point, after an accepted write - banking it here makes guard 4 true on the very next tick, so a refused '
    + 'floor can never be retried on a load that has anything on the board');
});

// L7 is the other side of the same guard: the floor is genuinely STANDING - offered, and something of
// ours is on the board - so re-sending it burns one of a cap-3 revision budget to change nothing.
// catches: guard 4 deleted, `&&` -> `||` read from the hold side, comparator flip (landedBids > 0 -> >= 0).
run('L7 holds when the floor is genuinely STANDING on the board (offered AND landed)', () => {
  // Arrange
  const eng = mkEngine();
  const standing = armLoad(eng);
  const last = lastOf(standing);
  standing.landedBids = 1;
  standing.currentRungIndex = last;
  standing.firedRungs.add(last);
  const notStanding = armLoad(eng);   // same load, floor never offered
  notStanding.landedBids = 1;

  // Act
  const d = call(eng, standing, 1_200, 3);

  // Assert
  assert.strictEqual(d, null, 're-sent a price already standing on the board - that spends one of a 3-revision '
    + 'per-load budget to change absolutely nothing, and on a soft branch it can restart the auction clock');
  // Control: identical load, floor never offered -> must release, so the null above is guard 4 and not
  // some unrelated hold.
  assert.ok(call(eng, notStanding, 1_200, 3),
    'control: with the floor unoffered the identical landed load must release');
});

// L8 is the misread that produced the OTHER defect. A banked index means the floor was OFFERED, not
// that it landed: SuperProcure refusing the write banks the rung and leaves the board empty. Reading
// the index alone as "standing" turns one refusal into a permanent stand-down, which is precisely the
// latch this guard was rewritten to remove.
// catches: `&&` -> `||`, guard 4 rewritten as `firedRungs.has(last)` alone.
run('L8 releases when the floor was OFFERED and REJECTED - a banked index alone is not "standing"', () => {
  // Arrange - SP refused the floor write: the rung is banked, the board is empty.
  const eng = mkEngine();
  const m = armLoad(eng);
  const last = lastOf(m);
  m.firedRungs.add(last);
  m.currentRungIndex = last;
  m.landedBids = 0;

  // Act
  const d = call(eng, m, 1_200, 4);

  // Assert
  assert.ok(d, 'one refused floor write latched the never-forfeit release off for the rest of the auction. A banked '
    + 'rung index proves only that we OFFERED the price; with landedBids 0 nothing of ours is on the board and a '
    + 'transient refusal must still be retriable');
  assert.strictEqual(d.price, FLOOR_PRICE, `released ${d.price} rather than re-offering the Rs 74,410 floor`);
});

// =================================================================================================
// L9-L11 - GUARD 5: the explicit attempt bound, and what may consume it.
// =================================================================================================

// The bound exists because a load SuperProcure refuses every time would otherwise produce one refused
// write per hot poll (~12 in the 2.5s window) on an account BRL's human operators share.
// catches: comparator flip (>= -> >, giving a 4th write), off-by-one, constant replaced (3 -> 0/1).
run('L9 the attempt bound is exactly the configured count: three releases, then it stands down', () => {
  // Arrange - the refused-load shape: no decision is applied, exactly as a rejected write applies none.
  const eng = mkEngine();
  assert.strictEqual(eng.softCfg.lastResortFloorAttempts, 3,
    'the default attempt bound moved off 3 (one shot plus two retries) - that is a live-money rate change on a '
    + 'shared account and must be a deliberate, reviewed edit, not a silent default drift');
  const m = armLoad(eng);

  // Act - five consecutive final-tick calls inside one 2.5s window.
  const got = [call(eng, m, 2_400, 4), call(eng, m, 2_100, 4), call(eng, m, 1_800, 4),
    call(eng, m, 1_500, 4), call(eng, m, 1_200, 4)];

  // Assert
  assert.ok(got[0], 'attempt 1 did not release at all');
  assert.ok(got[1], 'attempt 2 did not release - a transient refusal on the first offer must be retriable');
  assert.ok(got[2], 'attempt 3 did not release - the bound is 3, so the third offer is still inside it');
  assert.strictEqual(got[3], null, 'a FOURTH offer went out against a bound of 3 - an off-by-one here is extra '
    + 'refused writes per load on the shared live account, which is the runaway the explicit bound exists to stop');
  assert.strictEqual(got[4], null, 'the stand-down is not sticky: a fifth offer went out after the bound was reached');
  got.slice(0, 3).forEach((d, i) => assert.strictEqual(d.price, FLOOR_PRICE,
    `attempt ${i + 1} released ${d.price} - every retry must re-offer the same floor, never walk the ladder down`));
});

// L10 pins that the bound is READ FROM CONFIG rather than hardcoded. A bound of 1 must give exactly
// one offer and a bound of 5 exactly five - a hardcoded 3 fails both directions at once.
// catches: constant replaced (softCfg.lastResortFloorAttempts -> literal 3), config read dropped.
run('L10 the bound is the configured value, not a hardcoded 3 (bounds of 1 and 5 are both honoured)', () => {
  // Arrange
  const tight = mkEngine({ lastResortFloorAttempts: 1 });
  const loose = mkEngine({ lastResortFloorAttempts: 5 });
  const mTight = armLoad(tight);
  const mLoose = armLoad(loose);

  // Act - offer six times under each configured bound.
  const countReleases = (eng, m) => [0, 1, 2, 3, 4, 5]
    .map(() => call(eng, m, 1_200, 4)).filter(Boolean).length;
  const got = { tight: countReleases(tight, mTight), loose: countReleases(loose, mLoose) };

  // Assert
  assert.strictEqual(got.tight, 1,
    `a configured bound of 1 produced ${got.tight} offers - the operator's cap on writes to a shared live account is `
    + 'not being read');
  assert.strictEqual(got.loose, 5,
    `a configured bound of 5 produced ${got.loose} offers - a hardcoded ceiling silently overrides the config, so `
    + 'raising the bound after a run of transient refusals would do nothing`');
});

// L11. The bound counts OFFERS, never decisions. Production calls _decide on every poll for the whole
// life of the auction, so if a hold outside the window consumed an attempt the budget would be gone
// long before the buzzer and every soft load would forfeit - the exact failure the release prevents.
// catches: return early vs continue (increment hoisted above guard 1), attempt counted on the hold path.
run('L11 holds outside the last-chance window consume no attempts - the full budget survives to the buzzer', () => {
  // Arrange - one monitor, walked from 30s down, the way a real countdown arrives.
  const eng = mkEngine();
  const m = armLoad(eng);

  // Act - twenty far-out ticks (all outside the 2.5s window), then the three offers we are owed.
  const far = [30_000, 25_000, 20_000, 15_000, 12_000, 10_000, 9_000, 8_000, 7_000, 6_000,
    5_500, 5_000, 4_500, 4_000, 3_800, 3_500, 3_200, 3_000, 2_800, 2_600].map((r) => call(eng, m, r, 4));
  const atBuzzer = [call(eng, m, 2_400, 4), call(eng, m, 2_000, 4), call(eng, m, 1_600, 4)];

  // Assert
  far.forEach((d, i) => assert.strictEqual(d, null, `a mid-auction tick (index ${i}) released the reserved floor`));
  atBuzzer.forEach((d, i) => assert.ok(d, `offer ${i + 1} at the buzzer was refused after 20 ordinary mid-auction `
    + 'ticks. Every poll of a live countdown would then eat the budget, so by the last tick there is nothing left '
    + 'to fire and the load forfeits - a bound that counts holds is a bound that guarantees the loss'));
});

// =================================================================================================
// L12 - GUARD ORDER. Reordering these guards changes money behaviour.
// =================================================================================================

// The rank-1 belt sits ABOVE the counter, so leading costs nothing. Moving the increment above it is a
// mutation with no visible effect on any single call - it only shows up in what is left afterwards.
// catches: guard 3 moved below the increment, guard 5 moved above guard 3.
run('L12 guard order is load-bearing: the leading-hold sits above the counter, and an exhausted bound still holds', () => {
  // Arrange
  const eng = mkEngine();
  const led = armLoad(eng);        // led at L1 for the whole window, then beaten
  const spent = armLoad(eng);      // budget exhausted while outranked, then we take L1

  // Act
  const afterLeading = [call(eng, led, 2_400, 1), call(eng, led, 2_200, 1), call(eng, led, 2_000, 1),
    call(eng, led, 1_800, 1)].concat([call(eng, led, 1_600, 3)]);

  // Assert - four L1 holds must leave the budget untouched, so the fifth call (beaten to L3) releases.
  assert.strictEqual(afterLeading.slice(0, 4).filter(Boolean).length, 0, 'a leading load released its floor');
  assert.ok(afterLeading[4], 'four leading-holds burned the attempt budget, so the load forfeited the moment it was '
    + 'actually beaten. The rank check must sit ABOVE the counter: holding an L1 is not an attempt at anything');

  // ...and the reverse pairing: with the bound already spent, taking L1 must not re-open it.
  [0, 1, 2].forEach(() => call(eng, spent, 2_400, 4));
  assert.strictEqual(call(eng, spent, 1_200, 1), null,
    'the bound was already spent and the load then took L1 - both guards say hold, and the function released anyway');
});

// =================================================================================================
// L13-L14 - the cost-floor invariant, and the Set the walk-down shares.
// =================================================================================================

// The cost floor is the one invariant in this codebase that should never be in question. Whatever
// shape the desk's band takes, the released price is the LAST rung and never a rupee below the
// operating floor - checked here through the engine's own production belt (assertAboveFloor) as well
// as directly, so the two cannot drift apart.
// catches: off-by-one on the floor index (ladder[last - 1] / ladder[last + 1] -> undefined), math
//          identity collapse (min/max swap), sub-floor arithmetic on the released price.
run('L13 the released price is the operating floor on every ladder shape, including a 1-rung ladder', () => {
  // Arrange - the coarse desk band, a 2-margin band, the widest band a customer runs, and the
  // degenerate 1-rung ladder (marginsPct [0]) where the floor IS the establish rung.
  const eng = mkEngine();
  const SHAPES = [[12.6, 7.2, 6.3], [10, 5], [20, 16, 12, 8, 4, 1], [0]];

  // Act
  const got = SHAPES.map((band) => { const m = armLoad(eng, band); return { band, m, d: call(eng, m, 1_200, 4) }; });

  // Assert
  for (const { band, m, d } of got) {
    const label = `band [${band.join(',')}] (${m.ladder.length} rungs)`;
    assert.ok(d, `${label}: no release at all on the final tick`);
    assert.strictEqual(d.rungIndex, m.ladder.length - 1, `${label}: released rung ${d.rungIndex}, not the last rung`);
    assert.strictEqual(d.price, m.ladder[m.ladder.length - 1], `${label}: released ${d.price}, not the last rung`);
    assert.strictEqual(d.price, m.floor, `${label}: released ${d.price} against an operating floor of ${m.floor}`);
    assert.doesNotThrow(() => assertAboveFloor(d.price, m.floor),
      `${label}: the engine's own floor belt rejects the price the release produced`);
    assert.ok(d.price >= COST, `${label}: released ${d.price}, BELOW the desk's true cost of Rs ${COST} - a `
      + 'guaranteed-loss bid on live money');
    if (m.ladder.length > 1) {
      assert.ok(d.price < m.ladder[0], `${label}: released the opening rung ${d.price} as the "floor" - a decisive `
        + 'shot at our highest price is not a decisive shot');
    }
  }
});

// L14. firedRungs is not private bookkeeping - it doubles as the ladder walk-down mechanism that
// selectRung reads to skip spent rungs. The guard-4 fixtures above write into that Set, so the Set
// they build has to stay legible to its OTHER consumer; a rung banked as a string or a price rather
// than an index would satisfy guard 4 while silently breaking the walk-down.
// catches: outside-taxonomy - a firedRungs fixture whose members the shared walk-down cannot read.
run('L14 the firedRungs Set these fixtures build keeps its walk-down meaning for selectRung', () => {
  // Arrange - the six-rung ladder, standing on rung 1, with rung 2 already spent.
  const eng = mkEngine();
  const m = armLoad(eng, [20, 16, 12, 8, 4, 1]);
  const last = lastOf(m);
  m.currentRungIndex = 1;
  m.firedRungs.add(0); m.firedRungs.add(1); m.firedRungs.add(2);
  m.landedBids = 1;

  // Act - one rival ahead of us steps down exactly one rung, onto the spent rung 2.
  const next = selectRung({ i: 1, k: 2, last, firedRungs: m.firedRungs, phase: 'defend', jumpPerRival: 1 });

  // Assert
  assert.strictEqual(next, 3, `the walk-down landed on rung ${next}. Stepping one rung from rung 1 targets rung 2, `
    + 'which is spent, so the only unspent rung below is 3 - a Set whose members the walk-down cannot read would '
    + 're-fire a spent rung while still reading as "fired" to the floor guard');
  assert.strictEqual(m.firedRungs.has(last), false,
    'the walk-down must never be able to reach the reserved floor rung on a defend');
});
