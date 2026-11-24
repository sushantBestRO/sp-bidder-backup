'use strict';
/**
 * RAISE REFUSALS AND THE REFUSED-PRICE BOUND - the two defects measured on 2026-09-08.
 *
 * Regression target: .build/cache/audit/2026-09-08_negative-margin-forensics.md, root causes RC3 and
 * RC4, independently re-verified the same day. Both were live at the deployed sha 68dd042.
 *
 * RC3 - THE ENGINE ANSWERED "YOU MAY NOT RAISE YOUR PRICE" BY LOWERING ITS PRICE. Neither portal's
 * upward-revision refusal matched any classifier, so both fell to the default PRICE/STATE class -
 * "this PRICE was refused, walk the ladder down and retry". On load 260908LD2Z the desk corrected the
 * cost upward at 17:38:44 IST, the rebuilt ladder was refused at every rung, and the ladder walked
 * 41,420 -> 40,736 -> 38,684 against a refusal that had nothing to do with the price being too high.
 * A reverse auction refuses an upward revision because a bid of OURS is already standing, lower - so
 * every rupee conceded on the way down bought nothing, and the old bid stayed live and won at 6,390
 * below the corrected cost.
 *
 * RC4 - A REFUSED FLOOR RUNG WAS RE-OFFERED WITHOUT BOUND. The nothing-placed restore un-banks the
 * floor rung on every non-cap refusal (correct: a refused write put nothing on the board), which
 * reopens the always-floor snipe gate on the next tick. At the floor there is nothing lower to walk
 * to, so the two form a loop whose only brake was maxBidsPerMin - a RATE limit, which bounds writes
 * per minute and not per auction. Measured: 42 identical refused submissions of 38,684 over 304
 * seconds (19:42:58 to 19:48:02 IST) against a shared live vendor account.
 *
 * WHAT MUST NOT MOVE, and it is pinned here as hard as the fix, because over-latching is the way this
 * fix fails: a refusal that genuinely IS "your price is too high" must still walk the ladder down.
 * SuperProcure's monotonicity refusal fires routinely and harmlessly whenever a rung lands inside the
 * branch's minimum decrement of our own last bid. Measured over the 2026-08-02 box snapshot: of 140
 * such refusals, 126 named a cap BELOW the load's own floor (no rung could ever be accepted) and 14
 * named one at or above it - and those 14 loads went on to land a bid by walking down. Checks 3 and 8
 * are those 14.
 *
 * SAMPLE DATA IS REAL. Every refusal string here is verbatim from BRL's own production records, and
 * every ladder is a real one:
 *   - GoComet 260908LD2Z: HTTP 422, "You've increased the quote price. Please add a remark explaining
 *     the change to continue"; ladder [41420, 40736, 38684], 44 refusals of which 42 were the floor.
 *   - SuperProcure 23413312: "Amount is invalid. Amount should be less than or equal to 51650" against
 *     ladder [84500, 74750, 69095] - the cap is our own standing 51,750 minus the 100 decrement.
 *   - SuperProcure 23675281: the same string with cap 48000 against ladder [50670 ... 47700], which
 *     DID land at 47,700. The walk-down is correct here and must survive.
 *   - SuperProcure "Auction has already ended for this load" - 5,276 refused writes over 120 loads.
 *   - GoComet "Validation failed: Cannot Submit Quote either the enquiry is closed or you have reached
 *     maximum revision limit" - 2,304 refusals over 57 loads.
 *
 * Mock policy: the ONLY seam mocked is the platform adapter's placeBid. No engine internal is
 * stubbed - every decision comes from the real _decide through the real _maybeBid. Offline and
 * deterministic: fake adapter, temp-file scheduler, explicit state, no timers, no network.
 *
 *   node scripts/test-raise-refusal-and-retry-bound.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// Each case is ISOLATED so one failure does not hide the state of the others. On a money path the
// full picture of what is broken matters more than failing fast, and these sixteen checks cover two
// separate defects - a run that stops at the first tells you nothing about the second. The exit code
// stays honest: the completion sentinel asserts every case both RAN and PASSED.
let ran = 0, pass = 0;
const FAILURES = [];
const check = async (name, fn) => {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { FAILURES.push({ name, message: (e && e.message) ? e.message : String(e) }); console.log('  FAIL  ' + name); }
};

// COMPLETION SENTINEL, registered before any case runs. run-tests.js grades this file by EXIT CODE
// alone, so an async file that ends early - a swallowed rejection, a stray return - reaches exit 0
// having asserted nothing and reads as a silent green. A count assertion at the bottom of the file
// sits downstream of every one of those paths and would be skipped with them.
const EXPECTED_CHECKS = 16;
process.on('exit', () => {
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `raise-refusal-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

// ------------------------------------------------------------------------------------------------
// FIXTURES - verbatim platform strings.
// ------------------------------------------------------------------------------------------------
const GC_RAISE = "You've increased the quote price. Please add a remark explaining the change to continue";
const GC_CLOSED = 'Validation failed: Cannot Submit Quote either the enquiry is closed or you have reached maximum revision limit';
const SP_ENDED = 'Auction has already ended for this load';
const spCap = (n) => `Amount is invalid. Amount should be less than or equal to ${n}`;

// The soft-close opt-in, in the shape _resolveSoftStrategy actually requires: master gate ON and the
// shipper named. Without BOTH, softStrategy resolves to 'off' - the default for every shipper - and
// _observeExtension never advances believedCloseAt. Which monitors get this matters to checks 9-11.
const SOFT_ON = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };

// THE BOUND, AS A LITERAL. Every assertion below compares against this rather than against
// `eng.cfg.refusedPriceAttempts`, and the difference is the whole value of the checks. Reading the
// engine's own config back at it is self-referential: `floorSends <= eng.cfg.refusedPriceAttempts`
// is satisfied by ANY shipped default big enough to cover what the run happened to send, so the
// suite stayed green with the shipped bound mutated from 3 to 999 - fifteen checks reporting success
// having verified nothing about the number that actually ships. Check 16 pins the shipped value
// itself; these pin the observed behaviour against a number the engine cannot move.
const SHIPPED_BOUND = 3;

// ------------------------------------------------------------------------------------------------
// HARNESS - the same shape scripts/test-rejection-taxonomy.js uses, so the two files agree on what
// "drive the engine" means and a change to one is visible against the other.
// ------------------------------------------------------------------------------------------------
function mkEngine({ softClose, cfg } = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfg || {}),
    softClose: softClose || { enabled: false },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function armFine(eng, ladder, { companyName = 'Havells', id = 'F', closesAt = null,
  revisionsLeft = 30 } = {}) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName, branchName: 'Alwar Cable', closesAt: closesAt != null ? closesAt : Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = 100_000;
  return m;
}

const state = (remaining, myRank = null, extra = {}) => Object.assign(
  { closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 }, extra);

// Refuse every write with one body, recording every price that reached the wire.
function refuseAll(eng, body, { status = 400, standingPrice } = {}) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return Object.assign({ accepted: false, reason: body, status, text: body }, standingPrice !== undefined ? { standingPrice } : {});
  };
  return box;
}

// Walk the countdown down at the engine's own cadence with a frozen, advancing clock, exactly as
// test-rejection-taxonomy does - the storm only appears across many hot ticks, never in one call.
async function driveMaybeBid(eng, m, { from, to = 0, rank = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r, rank));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const countOf = (arr, v) => arr.filter((x) => x === v).length;
const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

(async () => {
  // ============================================================================================
  // 1. RC3, GoComet. The refusal says the price may not be RAISED over a standing quote. With that
  //    quote below the whole ladder no band price is offerable, so nothing lower goes out.
  // ============================================================================================
  // Owner ruling 26 Sep (260925SQRC): the next price goes BELOW the standing quote the refusal carries,
  // and the load stands down only when no band price is below it. On LD2Z the standing quote was our own
  // 31,610, below the whole re-priced ladder - so this load still stands down after one write.
  await check('GoComet raise refusal with the standing quote below the whole ladder (LD2Z): the load stands down and no lower price is ever submitted', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [41_420, 40_736, 38_684], { id: '260908LD2Z' });
    // A bid of OURS is standing, which is the premise the GoComet latch rests on and the state the
    // real load was in: 31,610 landed at 17:36:53 IST, then the desk corrected the cost upward and
    // the rebuilt ladder could no longer be submitted. landedBids is durable across a re-price, so
    // this is exactly what the engine sees on the second arm.
    // lastBidPrice is deliberately left null: arm() resets it on a re-price while landedBids is
    // restored from the durable intent, so "a bid of ours landed, but the engine no longer knows at
    // what price" is exactly the state the second arm of LD2Z was in.
    m.landedBids = 1;
    const box = refuseAll(eng, GC_RAISE, { status: 422, standingPrice: 31_610 });

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(m.priceRaiseRefused, true, 'the raise refusal did not latch its own class');
    assert.deepStrictEqual(box.attempted, [41_420],
      `the ladder walked DOWN against a refusal that was never about the price being too high. `
      + `Prices sent: [${box.attempted.join(', ')}] - on the real load this conceded 41,420 -> 40,736 -> 38,684 `
      + 'and every rupee of it bought nothing, because the portal refuses the revision either way');
    const lower = box.attempted.filter((p) => p < 41_420);
    assert.strictEqual(lower.length, 0,
      `${lower.length} lower price(s) were submitted in answer to "you may not raise your price": [${lower.join(', ')}]`);
  });

  // ============================================================================================
  // 2. RC3, SuperProcure. Same verdict, stated as a numeric cap. Load 23413312: the cap is our own
  //    standing 51,750 minus the decrement, and the ladder's FLOOR (69,095) is above it - so no rung
  //    the engine still owns could ever be accepted, and walking down is pure concession.
  // ============================================================================================
  await check('SuperProcure raise refusal (cap below the floor): the load stands down, the cap is recorded', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [84_500, 74_750, 69_095], { id: '23413312' });
    const box = refuseAll(eng, spCap(51_650));

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(m.priceRaiseRefused, true, 'the SP monotonicity refusal below our own floor did not latch');
    assert.strictEqual(m.priceRaiseRefusedCap, 51_650, "the platform's own cap is not carried on the latch");
    assert.deepStrictEqual(box.attempted, [84_500],
      `the ladder walked down under a cap no rung could satisfy. Prices sent: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 3. THE OVER-LATCH GUARD, and the check that fails if this fix is written as a string match.
  //    Load 23675281: the same SuperProcure string, cap 48,000, ladder floor 47,700. A rung the
  //    engine still owns IS acceptable, so this is a genuine "your price is too high" refusal and
  //    the walk-down is the correct answer. It landed at 47,700 in production.
  // ============================================================================================
  await check('a price-too-high refusal whose cap leaves a rung reachable still walks the ladder down', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [50_670, 50_063, 49_455, 48_848, 48_240, 47_700], { id: '23675281' });
    const box = refuseAll(eng, spCap(48_000));

    await driveMaybeBid(eng, m, { from: 160_000 });

    // A GUARD, not a regression: it holds before this fix and after it, and it is the one check that
    // fails if the raise classifier is ever rewritten as a bare string match on SuperProcure's
    // wording. That rewrite is the obvious way to write this fix and it silently forfeits winnable
    // loads, so the check is worth its place precisely because it is meant to pass on both sides.
    assert.ok(!m.priceRaiseRefused,
      'a refusal that genuinely IS about our price being too high was latched as a raise refusal - '
      + 'the engine has just stopped bidding a load it could still win');
    for (const rung of [50_063, 49_455, 48_848, 48_240, 47_700]) {
      assert.ok(box.attempted.includes(rung),
        `rung ${rung} never reached the wire. Prices sent: [${box.attempted.join(', ')}] - the ladder must still `
        + 'walk down when a lower rung can actually be accepted');
    }
  });

  // ============================================================================================
  // 4. The desk notice is raised ONCE per load, not once per 200 ms poll. The stand-down gate is
  //    silent by design; a flood here is what the gate exists to prevent.
  // ============================================================================================
  await check('the raise refusal raises exactly one alert and records its own machine-readable reason', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [41_420, 40_736, 38_684], { id: 'ALERT1' });
    m.landedBids = 1;
    refuseAll(eng, GC_RAISE, { status: 422 });

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(alertsOfKind(eng, 'bid_price_raise_refused').length, 1,
      `${alertsOfKind(eng, 'bid_price_raise_refused').length} raise-refusal alerts for one load`);
    assert.ok(m.noBid && m.noBid.reason === 'price_raise_refused',
      'the refusal is not recorded, so the close-time receipt falls back to the generic no-bid line '
      + 'that sends the desk hunting a pricing mistake which does not exist');
  });

  // ============================================================================================
  // 5. RC4 - THE STORM. A persistent refusal that is genuinely price/state (cap 9,900, floor 8,000,
  //    so the walk-down is correct and must happen) still ends with the floor rung being re-offered
  //    over and over: the nothing-placed restore un-banks it and the always-floor snipe re-fires it.
  //    Bounded now by an explicit per-price cap rather than by the rate limit.
  // ============================================================================================
  await check('a refused floor rung is re-offered a bounded number of times, and the walk-down above it is unchanged', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'STORM' });
    const box = refuseAll(eng, spCap(9_900));

    await driveMaybeBid(eng, m, { from: 160_000 });

    // The walk-down is untouched - this bound must cost the engine nothing on the way down.
    for (const rung of [10_000, 9_700, 9_400, 9_100, 8_000]) {
      assert.ok(box.attempted.includes(rung), `rung ${rung} never reached the wire under a bounded retry`);
    }
    const floorSends = countOf(box.attempted, 8_000);
    assert.ok(floorSends <= SHIPPED_BOUND,
      `the floor price was put on a shared LIVE vendor account ${floorSends} times for one load, against a bound of `
      + `${SHIPPED_BOUND}. On 260908LD2Z this was 42 identical refused submissions over 304 seconds`);
  });

  // ============================================================================================
  // 6. The bound is PER PRICE and resets on an accepted bid, which is what keeps it off healthy
  //    loads: every rung of an ordinary walk-down is a new price, so the count never accumulates.
  // ============================================================================================
  await check('the refused-price bound counts one price at a time and never fires on a load that is bidding', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'HEALTHY' });
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      // Every rung refused once, then accepted - the shape of a load bidding normally against a
      // minimum decrement it keeps landing just inside of. The cap is the FLOOR, so a rung the
      // engine still owns is always acceptable and this is never the terminal verdict; nothing here
      // should approach the bound.
      const first = countOf(attempted, price) === 1;
      if (first) { const t = spCap(8_000); return { accepted: false, reason: t, status: 400, text: t }; }
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };

    await driveMaybeBid(eng, m, { from: 160_000 });

    // The first two are GUARDS - true before this fix and after it. The third is the regression: on
    // origin/main there is no per-price run to read at all.
    assert.ok(!m.priceRaiseRefused, 'a load bidding normally was latched as a raise refusal');
    assert.ok(m.landedBids > 0, 'nothing landed on a load whose every second attempt was accepted');
    assert.ok(m._refusedPriceCount != null && m._refusedPriceCount <= SHIPPED_BOUND,
      'the refused-price run accumulated across DIFFERENT prices - the bound must count one price at a time');
  });

  // ============================================================================================
  // 7. The platform says the auction has ENDED. One refused write is how the engine learns that;
  //    the ~45 per load that followed it were the cost of having no class to put the answer in.
  // ============================================================================================
  await check('"Auction has already ended" latches after exactly one refused write', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'ENDED' });
    const box = refuseAll(eng, SP_ENDED);

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(m.submissionClosed, true, 'the auction-ended refusal did not latch');
    assert.strictEqual(box.attempted.length, 1,
      `${box.attempted.length} writes went into an auction the platform had already declared over`);
    assert.ok(m.noBid && m.noBid.reason === 'submission_window_closed', 'the refusal is not recorded');
  });

  // ============================================================================================
  // 8. GoComet's conflated string, and the ONE thing it may not be read as licensing. It cannot
  //    distinguish "the enquiry is closed" from "the revision limit is reached", so the engine draws
  //    only the conclusion both readings share - stop submitting - and must NOT zero the per-load
  //    budget, which would hand a later re-price a phantom exhausted load if it was the former.
  // ============================================================================================
  await check('the conflated closed/revision-limit string stops submission without zeroing the budget', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'GCCLOSED' });
    const box = refuseAll(eng, GC_CLOSED, { status: 422 });

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(m.submissionClosed, true, "GoComet's closed/revision-limit refusal did not latch");
    assert.strictEqual(box.attempted.length, 1,
      `${box.attempted.length} writes on one load; the production population is 2,304 refusals over 57 loads`);
    assert.strictEqual(m.revisionsLeft, 30,
      'the per-load budget was zeroed from a string that cannot say whether the budget is the problem');
    assert.strictEqual(m.capExhausted, false, 'and it must not be read as the cap class either');
  });

  // ============================================================================================
  // 10. THE YEAR-2100 PLACEHOLDER cannot defeat the bound, because the bound reads no clock at all.
  //     That close parses as a perfectly valid date, so any guard written as `now > believedCloseAt`
  //     is false forever on exactly the loads that carry it. This is why the post-close guarantee
  //     rests on the platform's own refusal (check 7) and on a clock-free per-price bound, rather
  //     than on any timestamp the engine holds.
  // ============================================================================================
  await check('a year-2100 placeholder close cannot defeat the retry bound, and the clock guard declines rather than guessing', async () => {
    const eng = mkEngine({ softClose: SOFT_ON });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'Y2100' });
    m.believedCloseAt = Date.parse('2100-05-24T19:53:25.000Z');
    const box = refuseAll(eng, spCap(9_900));

    await driveMaybeBid(eng, m, { from: 160_000 });

    const floorSends = countOf(box.attempted, 8_000);
    assert.ok(floorSends <= SHIPPED_BOUND,
      `the floor was re-offered ${floorSends} times on a load whose close time the clock guard cannot read. `
      + 'The placeholder must not be able to defeat the bound - which is why the bound reads no clock');
    assert.ok(box.attempted.length < eng.cfg.maxBidsPerMin,
      `${box.attempted.length} refused writes on a placeholder-close load: the rate limit is bounding this, `
      + 'not the per-price bound, and the rate limit is exactly what 42 identical writes already passed through');
  });

  // ============================================================================================
  // 12. THE LATE HAND-QUOTE. A BRL person quotes on the shared vendor identity AFTER the bot's first
  //     write; neither landedBids nor foreignBidsDetected can see it, so the refusal is the evidence,
  //     and the standing quote it carries is the price the next one goes below.
  // ============================================================================================
  // Owner ruling 26 Sep (260925SQRC) reverses the old stand-down here: the next price goes BELOW the
  // quote standing on the shared login, never at or above it, down to the lowest band price.
  await check('a hand quote placed AFTER the first write: the next price goes below it, never at or above it', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'LATEHANDQUOTE' });
    const DESK = 9_500;
    const attempted = [];
    let deskQuoteStanding = false;
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (!deskQuoteStanding) {
        deskQuoteStanding = true; // a person quotes on the shared identity right after
        const t = spCap(9_990);
        return { accepted: false, reason: t, status: 400, text: t };
      }
      if (price >= DESK) return { accepted: false, reason: GC_RAISE, status: 422, text: GC_RAISE, standingPrice: DESK };
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.ok(!m.priceRaiseRefused, 'the load stood down although band prices below the desk quote remain');
    const firstRaise = attempted.findIndex((p, k) => k > 0 && p >= DESK);
    assert.ok(firstRaise > 0, `harness assumption broken: no write was refused as a raise (${attempted.join(', ')})`);
    const later = attempted.slice(firstRaise + 1);
    assert.ok(later.length > 0 && later.every((p) => p < DESK),
      `after the raise refusal over the desk quote ${DESK} the engine sent [${later.join(', ')}]`);
  });

  // ============================================================================================
  // 13. A TRANSIENT SERVER FAULT IS NOT A VERDICT. realAdapter.placeBid funnels every non-2xx that
  //     is not 401/403/429 into the same rejection branch, so an HTTP 502 arrives looking exactly
  //     like a refusal. If those counted, three hiccups at one price would retire that price for the
  //     rest of the auction - and the same three 502s on origin/main are followed by the bid
  //     LANDING. The bound exists to stop the engine arguing with a wall, not to stop it recovering.
  // ============================================================================================
  await check('transient 5xx failures do not accumulate toward the bound, and the price still lands', async () => {
    const eng = mkEngine();
    // A ONE-RUNG ladder, so every attempt is the same price and the run actually accumulates. On a
    // multi-rung ladder the walk-down hands each 502 a different price and nothing ever reaches the
    // bound - which would make this check pass against the defect it exists to catch.
    const m = armFine(eng, [8_000], { id: 'FLAKY502' });
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      // Six server faults - twice the bound - then the platform recovers and takes the bid.
      if (attempted.length <= 6) return { accepted: false, reason: 'http_502', status: 502 };
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.strictEqual(m._refusedPriceCount, 0,
      `a server fault was counted as a platform verdict (_refusedPriceCount ${m._refusedPriceCount}) - three `
      + 'transient 502s would then permanently retire a price the platform was about to accept');
    assert.ok(m.landedBids > 0,
      `nothing landed after the platform recovered. Prices sent: [${attempted.join(', ')}] - on origin/main this `
      + 'same sequence lands the bid, so holding here is a regression the bound introduced');
  });

  // ============================================================================================
  // 14. THE CAP MUST NOT BE MISREAD AS A SMALLER NUMBER. A right-unanchored `(\d+)` against a
  //     thousands-separated cap captures only the leading group - `51` out of `51,650` - which is
  //     finite, passes every guard, and sits below every floor there is, silently latching the whole
  //     class. Unobserved in the corpus (every recorded cap is a bare integer), which is exactly why
  //     it is worth pinning: a bad READ of the number must never look like a valid verdict.
  // ============================================================================================
  await check('a thousands-separated cap is read whole, not truncated to its first digit group', async () => {
    const eng = mkEngine();
    // Floor 8,000 sits BELOW the true cap 51,650, so the correct read leaves the ladder walking.
    // A truncated read of 51 would put the floor above the cap and latch the load instead.
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'COMMACAP' });
    const box = refuseAll(eng, 'Amount is invalid. Amount should be less than or equal to 51,650');

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.ok(!m.priceRaiseRefused,
      'a cap of 51,650 was read as 51 and latched a load whose floor of 8,000 is comfortably under it');
    assert.ok(box.attempted.includes(8_000),
      `the floor never reached the wire. Prices sent: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 15. A REJECTION THAT CARRIES NO STATUS STILL COUNTS. Both production adapters stamp a status on
  //     every rejection envelope, but mockAdapter's does not - so a bound written as "count only a
  //     4xx" is unobservable in the simulator, where a refusal is a modelled verdict and the storm
  //     it guards against is exactly what the sim exists to rehearse. Only a positively identified
  //     server fault is excluded, so this shape counts.
  // ============================================================================================
  await check('a rejection with no HTTP status still counts toward the bound', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [8_000], { id: 'NOSTATUS' });
    const attempted = [];
    // mockAdapter's rejection shape: accepted/myRank/revisionsLeft/reason/latencyMs, and no status.
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      return { accepted: false, myRank: 2, revisionsLeft: null, reason: 'rejected', latencyMs: 20 };
    };

    await driveMaybeBid(eng, m, { from: 160_000 });

    assert.ok(m._refusedPriceCount > 0,
      'a status-less rejection was read as a transport fault and never counted - the bound cannot be '
      + 'observed in the simulator at all, which is where this storm is rehearsed');
    assert.ok(attempted.length <= SHIPPED_BOUND,
      `${attempted.length} writes of one price against a bound of ${SHIPPED_BOUND}`);
  });

  // ============================================================================================
  // 16. THE SHIPPED VALUE, PINNED AT ITS SOURCE. Every check above drives an engine built by
  //     mkEngine(), and mkEngine passes a config object - so a check that reads the bound back off
  //     that engine proves only that the engine agrees with itself. Measured: with the shipped
  //     default mutated from 3 to 999 and no test touched, all fifteen stayed green. A threshold
  //     nothing pins is a threshold anyone can move.
  //
  //     Both halves matter. DEFAULTS is what src/web/server.js merges config.engine OVER
  //     (Object.assign({}, ENGINE_DEFAULTS, config.engine)), and `refusedPriceAttempts` appears in
  //     neither src/config.js nor server.js, so DEFAULTS is not a fallback here - it IS the deployed
  //     number. The bare-default engine then proves the constructor actually carries it through to
  //     the field the fire-point gate reads, rather than dropping it on the floor.
  // ============================================================================================
  await check('the SHIPPED refused-price bound is 3, read from its source and not from an injected fixture', async () => {
    const { DEFAULTS } = require('../src/engine/bidEngine');
    assert.strictEqual(DEFAULTS.refusedPriceAttempts, SHIPPED_BOUND,
      `the shipped default is ${DEFAULTS.refusedPriceAttempts}, not ${SHIPPED_BOUND} - every behavioural check `
      + 'above is written against 3, so a moved default silently decouples this suite from what deploys');

    // A bare-default engine: no config object at all, so cfg can only have come from DEFAULTS.
    const bare = new BidEngine({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
    }, new DurableScheduler(tmp()), {});
    assert.strictEqual(bare.cfg.refusedPriceAttempts, SHIPPED_BOUND,
      'the constructor did not carry the shipped bound onto cfg, which is the field the fire-point gate reads');

    // ...and the injected path agrees with the shipped one, so the checks above are measuring the
    // same number that deploys rather than a fixture's private value.
    const injected = mkEngine();
    assert.strictEqual(injected.cfg.refusedPriceAttempts, DEFAULTS.refusedPriceAttempts,
      'the harness engine and the shipped default disagree - every other check in this file is then '
      + 'testing a number that never reaches production');
  });

  // ============================================================================================
  // 17. A QUOTE ALREADY STANDING ON THE SHARED VENDOR IDENTITY before we bid, seen as a rank on the
  //     state read (foreignBidsDetected). The raise refusal's standing quote bounds the next price.
  // ============================================================================================
  // Owner ruling 26 Sep (260925SQRC) reverses the old stand-down here too: below the standing quote.
  await check('a standing quote from the shared vendor identity with nothing of ours landed: the next price goes below it, never at or above it', async () => {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'GCSHARED' });
    const STANDING = 9_000;
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (price >= STANDING) return { accepted: false, reason: GC_RAISE, status: 422, text: GC_RAISE, standingPrice: STANDING };
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };

    eng._detectForeignBids(m, state(160_000, 2));
    await driveMaybeBid(eng, m, { from: 160_000, rank: 2 });

    assert.ok(m.foreignBidsDetected,
      'harness assumption broken: a standing rank before our first bid should have latched foreignBidsDetected');
    assert.ok(!m.priceRaiseRefused, 'the load stood down although the floor 8,000 is below the standing 9,000');
    assert.strictEqual(attempted.filter((p) => p >= STANDING).length, 1,
      `more than one write at or above the standing ${STANDING}: [${attempted.join(', ')}]`);
    assert.ok(attempted.includes(8_000), `the floor below the standing quote never went: [${attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 16. WHY THERE IS NO CLOCK-BASED POST-CLOSE GATE, pinned so one does not come back. A guard keyed
  //     on the countdown running NEGATIVE was written and deleted: every shipped adapter floors it at
  //     zero, so such a guard is dead code on every production path, and the only alternative -
  //     comparing the platform's close epoch against this box's wall clock - measures clock skew as
  //     well as elapsed time and was measured holding a LIVE auction for up to a full extension round
  //     on a fast box. This check fails the moment an adapter starts emitting a negative countdown,
  //     which is the fact that would make such a guard viable and is the only thing that should
  //     reopen the question.
  // ============================================================================================
  await check('every shipped adapter floors the countdown at zero, so a negative-countdown gate is unreachable', async () => {
    const { SpSocket } = require('../src/platform/spSocket');
    const sock = new SpSocket({ token: 't', auctionId: '1' });
    sock.serverOffsetMs = 0;
    sock.endAtMs = Date.now() - 600_000; // closed ten minutes ago
    const past = typeof sock.closesInMs === 'function' ? sock.closesInMs() : null;
    assert.ok(past === null || past >= 0,
      `spSocket emitted a NEGATIVE countdown (${past}) for a close ten minutes past - the clamp that made a `
      + 'countdown-based post-close gate unreachable is gone, so that design decision needs revisiting');

    // The clamp is the shipped contract in all three, asserted from source so a rewrite of any one
    // of them trips this rather than silently re-enabling a guard nobody re-reviewed.
    const fs = require('fs');
    const pathMod = require('path');
    for (const [file, needle] of [
      ['spSocket.js', 'Math.max(0,'],
      ['realAdapter.js', 'Math.max(0,'],
      ['gocometAdapter.js', 'closed ? 0 :'],
    ]) {
      const src = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'platform', file), 'utf8');
      assert.ok(src.includes(needle),
        `${file} no longer clamps its countdown (looked for ${needle}) - a negative countdown may now reach the `
        + 'engine, which is the precondition a post-close gate would need');
    }
  });

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack ? e.stack : e); process.exitCode = 1; });
