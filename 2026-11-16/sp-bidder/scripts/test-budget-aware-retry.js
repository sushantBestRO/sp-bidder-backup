'use strict';
/**
 * ATTEMPT-BUDGET-AWARE RETRY - one refused price may not spend a scarce revision budget.
 *
 * The bound on repeating a refused price shipped as a constant 3. That number is defensible against
 * a 30-revision SuperProcure branch and indefensible against a 3-revision one, where three writes at
 * one price the platform has already answered ARE the whole auction. GoComet is 3 per vendor per
 * enquiry platform-wide and the budget is shared with BRL's own autopilot on the same vendor
 * identity; 7 of 12 active SuperProcure customers sit at branchBidCountAllowed <= 3.
 *
 * So the bound becomes a function of the budget the PLATFORM states, read off the same seam the
 * engine already reads it from - state.revisionLimit first (live, per-load), capabilities()
 * .revisionLimit second (platform-static), unknown third. Never a per-platform test.
 *
 * Design: _planning/2026-09-11_refusal-taxonomy-and-retry-policy.md, classes C14 and C15.
 *
 * WHAT MUST NOT MOVE is pinned as hard as what changes, because over-tightening is how this fix
 * fails: an ordinary ladder walk-down is a new price at every rung and must never be bounded at any
 * budget (check 4), an ample budget keeps the shipped bound of 3 (check 2), an unknown budget keeps
 * it too (check 3), a refusal the engine cannot NAME still gets the budget's bound rather than a
 * tighter one (check 7), and a 5xx is a server fault rather than a verdict and must not retire a
 * price the platform never refused (check 9).
 *
 * SAMPLE DATA IS REAL. Ladder [41420, 40736, 38684] and the 38,684 floor are GoComet load
 * 260908LD2Z, where 42 identical refused submissions went out over 304 seconds. The unrecognised
 * body is verbatim from BRL's own box snapshots - "Error in remaining time calculation", 4 refusals
 * over 2 loads, the only NAMED member of the unmapped remainder. The remainder itself is wider:
 * only five refusals carry a classifier, so every unnamed price/state wording lands in that class.
 *
 * Mock policy: the ONLY seam mocked is the adapter's placeBid (and capabilities, to state a budget).
 * No engine internal is stubbed - every decision comes from the real _decide through the real
 * _maybeBid. Offline and deterministic: fake adapter, temp-file scheduler, explicit state, no
 * timers, no network.
 *
 *   node scripts/test-budget-aware-retry.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { renderMessage } = require('../src/notify/waTemplates');

let ran = 0, pass = 0;
const FAILURES = [];
const check = async (name, fn) => {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { FAILURES.push({ name, message: (e && e.message) ? e.message : String(e) }); console.log('  FAIL  ' + name); }
};

// COMPLETION SENTINEL, registered before any case runs. run-tests.js grades this file by EXIT CODE
// alone, so an async file that ends early - a swallowed rejection, a stray return - reaches exit 0
// having asserted nothing and reads as a silent green.
const EXPECTED_CHECKS = 17;
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
const tmp = () => { const f = path.join(os.tmpdir(), `budget-retry-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

// ------------------------------------------------------------------------------------------------
// FIXTURES - verbatim platform strings.
// ------------------------------------------------------------------------------------------------
// A recognised refusal that is NOT terminal for the load and NOT the healthy walk-down: SuperProcure
// naming a cap at or above the floor rung. It is the residual price/state class (C14) - the class
// whose retry the budget now bounds - and using it rather than an invented string keeps the checks
// honest about which class they exercise.
const spCap = (n) => `Amount is invalid. Amount should be less than or equal to ${n}`;
// The entire unmapped remainder of BRL's own refusal corpus (C15).
const UNKNOWN_BODY = 'Error in remaining time calculation';

// The shipped ample-budget bound, as a LITERAL. Comparing against eng.cfg.refusedPriceAttempts would
// be self-referential - any shipped default big enough to cover what the run happened to send would
// satisfy it. Check 10 pins the shipped value itself; these pin behaviour against a number the
// engine cannot move.
const AMPLE_BOUND = 3;
// The tight-budget bound: a refused price goes on the wire ONCE and is never re-sent.
const TIGHT_BOUND = 1;

// ------------------------------------------------------------------------------------------------
// HARNESS - same shape as scripts/test-raise-refusal-and-retry-bound.js, so a change to one is
// visible against the other.
// ------------------------------------------------------------------------------------------------
function mkEngine({ capRevisionLimit = 30, cfg } = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100,
      revisionLimit: capRevisionLimit, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfg || {}),
    softClose: { enabled: false },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function armFine(eng, ladder, { companyName = 'Havells', id = 'F', revisionsLeft = 30 } = {}) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName, branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  // The engine's own belief about what is LEFT. Held generously on purpose so the revisions-left
  // stand-down can never be what stops a run - every check below must be attributable to the bound.
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = 100_000;
  return m;
}

// `stateRevisionLimit` is the LIVE per-load cap the adapter surfaces. Passing null models an adapter
// that publishes none (realAdapter does exactly this on a load whose meta was never cached), which
// is what sends the resolution down to capabilities().
const state = (remaining, { stateRevisionLimit = null, myRank = null } = {}) => {
  const s = { closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 };
  if (stateRevisionLimit != null) s.revisionLimit = stateRevisionLimit;
  return s;
};

function refuseAll(eng, body, { status = 400 } = {}) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return { accepted: false, reason: body, status, text: body };
  };
  return box;
}

async function driveMaybeBid(eng, m, { from, to = 0, stateRevisionLimit = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r, { stateRevisionLimit }));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const countOf = (arr, v) => arr.filter((x) => x === v).length;
const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

// The GoComet ladder from 260908LD2Z. Its floor is the price that went out 42 times.
const LD2Z = [41_420, 40_736, 38_684];
const FLOOR = 38_684;
// A cap at the floor keeps the refusal in the RESIDUAL price/state class: raiseRefusal returns null
// while a rung at or below the cap remains, so nothing terminal latches and the only thing that can
// stop the floor re-send loop is the bound under test.
const CAP_AT_FLOOR = spCap(FLOOR);

(async () => {
  // ============================================================================================
  // 1. THE RULING, stated as one assertion. A 3-revision auction sends a refused price ONCE.
  // ============================================================================================
  await check('tight budget from the live per-load cap: a refused price goes on the wire exactly once', async () => {
    const eng = mkEngine({ capRevisionLimit: 30 }); // platform-static says ample...
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);

    // ...and the LIVE per-load number says 3, which must win. This is the SuperProcure shape: the
    // platform-level cap is genuinely unknown and the branch's own number rides the load.
    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });

    assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
      `the floor price went on the wire ${countOf(box.attempted, FLOOR)} times against a 3-revision budget. `
      + `Prices sent: [${box.attempted.join(', ')}] - on a budget of 3 every repeat is a third of the auction`);
  });

  // ============================================================================================
  // 2. WHAT MUST NOT MOVE. An ample budget keeps the shipped bound of 3, byte-identical to the
  //    deployed behaviour. The owner's ruling says "on higher bid budgets we can retry more".
  // ============================================================================================
  await check('ample budget: the shipped bound of 3 is unchanged', async () => {
    const eng = mkEngine({ capRevisionLimit: 30 });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 30 });

    assert.strictEqual(countOf(box.attempted, FLOOR), AMPLE_BOUND,
      `a 30-revision branch has slack the bound is not meant to take away. `
      + `Floor sends: ${countOf(box.attempted, FLOOR)}, expected ${AMPLE_BOUND}. Prices: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 3. WHAT MUST NOT MOVE. An UNKNOWN budget is not coerced to "tight" - it keeps today's shipped
  //    behaviour. Tightening on absence would silently retire prices on every adapter that
  //    publishes no cap, which is a behaviour change nothing in the record supports.
  // ============================================================================================
  await check('unknown budget: neither seam states a cap, so the shipped bound of 3 stands', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: null });

    assert.strictEqual(countOf(box.attempted, FLOOR), AMPLE_BOUND,
      `an unknown budget was read as a tight one. Floor sends: ${countOf(box.attempted, FLOOR)}, `
      + `expected the shipped ${AMPLE_BOUND}. Prices: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 4. WHAT MUST NOT MOVE, and the check that fails if this is written as "stop after one refusal".
  //    "Don't retry a failed price - retry the NEXT rung" is TWO clauses. A tight budget must still
  //    walk the whole ladder: every rung is a new price and the bound has nothing to say about it.
  // ============================================================================================
  await check('tight budget still walks the ladder down - every rung is a new price', async () => {
    const eng = mkEngine({ capRevisionLimit: 3 });
    // A cap ABOVE the whole ladder, so every rung is genuinely offerable and the healthy walk-down
    // is the correct answer. This is the C5 population - 14 of 140 in the box snapshot, which went
    // on to land a bid by walking down.
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, spCap(50_000));

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });

    for (const rung of LD2Z) {
      assert.ok(box.attempted.includes(rung),
        `rung ${rung} never reached the wire under a tight budget. Prices sent: [${box.attempted.join(', ')}] `
        + '- the bound is on repeating ONE price, never on advancing the ladder');
    }
  });

  // ============================================================================================
  // 5. The platform-STATIC seam. GoComet publishes no per-enquiry cap on an enquiry that was never
  //    enriched, so capabilities().revisionLimit (3) is the budget and must bind on its own.
  // ============================================================================================
  await check('tight budget from capabilities() alone: the platform-static cap binds when the load states none', async () => {
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: null });

    assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
      `the adapter declares a 3-revision platform and the floor price still went out `
      + `${countOf(box.attempted, FLOOR)} times. Prices: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 6. THE STAND-DOWN IS LOUD AND REASONED - the repo's price-page gate, applied to the new hold.
  //    A bare return here would be a blocking defect whatever else the change does.
  // ============================================================================================
  await check('the budget-bounded hold records its reason and raises a desk-visible alert', async () => {
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    refuseAll(eng, CAP_AT_FLOOR);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });

    assert.ok(m.noBid, 'the hold recorded nothing - the close receipt would render the generic unknown reason');
    assert.strictEqual(m.noBid.reason, 'refused_price_bound',
      `the hold recorded ${JSON.stringify(m.noBid.reason)} rather than its own mapped reason`);
    // The budget that decided the bound rides the record, because "why did it stop after one?" is
    // the first question anyone asks of this hold and it is not reconstructable later without it.
    assert.strictEqual(m.noBid.attemptBudget, 3, 'the attempt budget that chose the bound is not on the record');
    assert.strictEqual(m.noBid.bound, TIGHT_BOUND, 'the bound applied is not on the record');
    const alerts = alertsOfKind(eng, 'refused_price_bound');
    assert.strictEqual(alerts.length, 1,
      `expected exactly one refused_price_bound alert, got ${alerts.length} - a log line alone is not desk-visible, `
      + 'and one per 200ms poll is the flood the latch exists to prevent');
  });

  // ============================================================================================
  // 7. C15, THE UNMAPPED REMAINDER - "bank it and advance", exactly like any other price/state
  //    refusal. The SHAPE of a refusal decides what the stand-down is CALLED and who is paged; it
  //    must NOT decide how many attempts the price gets, or the healthy walk-down loses its retry.
  //
  //    This is a WHAT-MUST-NOT-MOVE check, and it is here because the first draft of this change
  //    got it wrong: it cut an unrecognised refusal to one attempt at every budget, which reads as
  //    the conservative choice and is not. Only five refusals carry a named regex - the five that
  //    needed a non-default response - so the entire ordinary price/state population classifies as
  //    "unrecognised", and that draft cut the retry on exactly the loads the record shows retrying
  //    successfully.
  // ============================================================================================
  await check('unrecognised refusal on an ample budget keeps the shipped bound - the shape is not the budget', async () => {
    const eng = mkEngine({ capRevisionLimit: 30 });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, UNKNOWN_BODY);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 30 });

    assert.strictEqual(countOf(box.attempted, FLOOR), AMPLE_BOUND,
      `an unrecognised refusal had its retry cut to ${countOf(box.attempted, FLOOR)} on a 30-revision `
      + `branch. Prices: [${box.attempted.join(', ')}] - not knowing what a refusal MEANS is not a reason `
      + 'to spend less of a budget the platform says is there');
    for (const rung of LD2Z) {
      assert.ok(box.attempted.includes(rung),
        `rung ${rung} never reached the wire. Prices: [${box.attempted.join(', ')}] - the fail-safe is `
        + '"bank it and advance", never "stop the load"');
    }
  });

  // ============================================================================================
  // 8. C15's LOUD RECORD, and the reason it is a separate class from C14: nobody can act on
  //    "the portal kept refusing" - somebody has to look at "the portal said something new".
  //
  //    Raised at the HOLD, never at the refusal. At the refusal the load is still biddable and the
  //    next rung may land, so a record there would put a terminal-sounding cause on a load that goes
  //    on to win - and would page ops on every ordinary walk-down besides.
  // ============================================================================================
  await check('unrecognised refusal: the stand-down names its own class and carries the portal\'s words', async () => {
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    refuseAll(eng, UNKNOWN_BODY);

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });

    const alerts = alertsOfKind(eng, 'refusal_unrecognised');
    assert.strictEqual(alerts.length, 1,
      `expected exactly one refusal_unrecognised alert, got ${alerts.length}`);
    assert.ok(String(alerts[0].body || '').includes(UNKNOWN_BODY),
      `the alert does not carry the platform's own words: ${JSON.stringify(alerts[0].body)} - without them `
      + 'the next classifier has to wait for a fresh live incident to be written');
    assert.ok(m.noBid && m.noBid.reason === 'refusal_unrecognised',
      `the stand-down recorded ${JSON.stringify(m.noBid && m.noBid.reason)} - an unrecognised wall and a `
      + 'recognised one tell the desk different things and must not share a reason');
    // The recognised wall must NOT page ops - it is a decision the engine understood, and the close
    // receipt states it. Pinned here so the two classes cannot collapse into one.
    const eng2 = mkEngine({ capRevisionLimit: 3 });
    const m2 = armFine(eng2, LD2Z);
    refuseAll(eng2, CAP_AT_FLOOR);
    await driveMaybeBid(eng2, m2, { from: 160_000, stateRevisionLimit: 3 });
    assert.strictEqual(alertsOfKind(eng2, 'refusal_unrecognised').length, 0,
      'a refusal the engine DOES recognise paged ops as an unmapped one - the alarm is worth nothing once it fires on known classes');
  });

  // ============================================================================================
  // 9. WHAT MUST NOT MOVE. A 5xx is a SERVER FAULT, not a verdict. Three transient 502s at one
  //    price must not retire that price - measured against origin/main, where the same sequence was
  //    followed by the bid LANDING. This also proves "unrecognised" is not a synonym for "4xx".
  // ============================================================================================
  await check('a 5xx at one price is never counted, so it can never retire the price or read as unrecognised', async () => {
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, 'Internal Server Error', { status: 502 });

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });

    assert.ok(countOf(box.attempted, FLOOR) > TIGHT_BOUND,
      `a server fault retired the floor price after ${countOf(box.attempted, FLOOR)} attempt(s) on a tight budget. `
      + 'A bound built to stop the engine arguing with a wall must not stop it recovering from a hiccup');
    assert.strictEqual(alertsOfKind(eng, 'refusal_unrecognised').length, 0,
      'a 5xx was classified as an unrecognised REFUSAL - it is a transport fault and the platform stated no verdict');
  });

  // ============================================================================================
  // 10. THE SHIPPED NUMBERS THEMSELVES, pinned so a mutation of either is caught. The behavioural
  //     checks above compare against literals precisely so that this one has something to guard.
  // ============================================================================================
  await check('the shipped ample bound is 3 and the tight/ample line is a budget of 3', async () => {
    const eng = mkEngine({ capRevisionLimit: 30 });
    assert.strictEqual(eng.cfg.refusedPriceAttempts, AMPLE_BOUND,
      `the shipped ample-budget bound is ${eng.cfg.refusedPriceAttempts}, not ${AMPLE_BOUND}`);
    // The BOUNDARY, both sides of it, read straight off the resolver rather than inferred from a
    // run: a budget of exactly 3 is tight (7 of 12 active customers sit at or below it) and 4 is the
    // first ample one. An off-by-one here silently doubles or halves the write volume on the
    // customers this policy exists for.
    assert.strictEqual(eng._refusedPriceBound(state(10_000, { stateRevisionLimit: 3 })), TIGHT_BOUND,
      'a budget of exactly 3 must be tight - it is the value 7 of 12 active customers carry');
    assert.strictEqual(eng._refusedPriceBound(state(10_000, { stateRevisionLimit: 4 })), AMPLE_BOUND,
      'a budget of 4 must be ample - 4 is the first cap with slack to absorb a repeat');
  });

  // ============================================================================================
  // 11. THE DESK-FACING HALF. Every terminal stand-down must NAME ITSELF on the close receipt.
  //     Without a branch these reasons render the generic "a rate was entered but no bid could be
  //     placed before close", which points the desk at a pricing mistake that does not exist.
  // ============================================================================================
  await check('every mapped reason renders its own close-receipt sentence, not the generic unknown', async () => {
    const base = { oaNo: 'OA-1', from: 'Bhiwandi', to: 'Alwar', vehicleType: '32ft',
      closeTime: '18:30', marketRate: '30,000' };
    const generic = renderMessage('no_bid_short', Object.assign({}, base, { noBidReason: 'something_new' }));
    for (const reason of ['bid_cap_exhausted', 'price_raise_refused', 'submission_window_closed',
      'refused_price_bound', 'refusal_unrecognised']) {
      const body = renderMessage('no_bid_short', Object.assign({}, base, { noBidReason: reason }));
      assert.notStrictEqual(body, generic,
        `reason ${reason} still renders the GENERIC unknown-reason receipt - the desk is sent hunting a `
        + 'pricing mistake that does not exist');
      assert.ok(!/STATUS|revisionsLeft|_refusedPrice|bidEngine|\.js/.test(body),
        `reason ${reason} leaks an internal name onto a message the client's Director reads: ${body}`);
    }
  });

  // ============================================================================================
  // 12. THE CAP MAY ARRIVE AS A STRING. realAdapter maps revisionLimit straight off the
  //     /sp/loads/v4 wire with no coercion, and SuperProcure demonstrably quotes other numerics on
  //     that same payload. A bare Number.isFinite("3") is false, so an uncoerced read would fall
  //     through to the platform-static declaration - which SuperProcure states as null - and this
  //     whole policy would silently no-op on exactly the tight-budget customers it exists for.
  //     Check 1 cannot catch it: it passes a JS number, as every check above does.
  // ============================================================================================
  await check('a quoted per-load cap still binds: the resolver coerces before testing finiteness', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    assert.strictEqual(eng._attemptBudget(state(10_000, { stateRevisionLimit: '3' })), 3,
      'a quoted cap of "3" did not resolve to a budget of 3 - the tight-budget policy would no-op silently');
    assert.strictEqual(eng._refusedPriceBound(state(10_000, { stateRevisionLimit: '3' })), TIGHT_BOUND,
      'a quoted cap of "3" did not produce the tight bound');
    // The permissive direction must stay closed: an empty string and a non-numeric must read as
    // "the platform said nothing", never as a budget of 0, which Number('') would hand back.
    assert.strictEqual(eng._attemptBudget(state(10_000, { stateRevisionLimit: '' })), null,
      'an empty-string cap coerced to a number - a budget of 0 is not something the platform said');
    assert.strictEqual(eng._attemptBudget(state(10_000, { stateRevisionLimit: 'n/a' })), null,
      'an unparseable cap did not resolve to unknown');

    const box = refuseAll(eng, CAP_AT_FLOOR);
    const m = armFine(eng, LD2Z);
    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: '3' });
    assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
      `the floor went on the wire ${countOf(box.attempted, FLOOR)} times against a quoted 3-revision budget`);
  });

  // ============================================================================================
  // 13. bid_cap_exhausted MUST BE REACHABLE. Its receipt branch was written and could never render:
  //     monitor.noBid is written only by _recordRefusal, and the cap block latched, zeroed
  //     revisionsLeft and alerted without ever calling it - so the close fell through to the generic
  //     wording on exactly the shared-account cap-exhaustion loads the branch was written for.
  //     Check 11 cannot catch it: it injects noBidReason directly and never drives the engine.
  // ============================================================================================
  await check('a real "Bid limit exceeded" refusal reaches the close receipt as bid_cap_exhausted', async () => {
    const eng = mkEngine({ capRevisionLimit: 30 });
    const m = armFine(eng, LD2Z);
    refuseAll(eng, 'Bid limit exceeded');

    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 30 });

    assert.ok(m.capExhausted, 'the cap refusal did not latch at all - the fixture no longer matches the classifier');
    assert.ok(m.noBid, 'the cap refusal recorded NO reason - the close renders the generic unknown wording');
    assert.strictEqual(m.noBid.reason, 'bid_cap_exhausted',
      `the cap refusal recorded ${JSON.stringify(m.noBid.reason)} - the bid_cap_exhausted receipt branch stays dead`);
    // And the reason the engine records is the one the receipt keys on - the literal is load-bearing.
    const body = renderMessage('no_bid_short', { landedBids: 0, noBidReason: m.noBid.reason });
    assert.ok(!/A rate was entered but no bid could be placed/.test(body),
      `the recorded reason still renders the generic receipt: ${body}`);
  });

  // ============================================================================================
  // 14. refusal_unrecognised IS NOT ON THE DIRECTOR'S ERROR CHANNEL. ERROR_KINDS membership routes
  //     kind 'error' with a per-auction dedupe key - one DM per load - and the unmapped remainder is
  //     not the rare set the rarity argument described: only six refusals carry a named regex, so
  //     the ordinary min-decrement population lands in this class, and the same change drops the
  //     trigger from three refusals to one on the tight-budget majority. It follows its siblings to
  //     the close receipt until that volume is counted.
  // ============================================================================================
  await check('the unmapped remainder does not page the Director - it rides the receipt like its siblings', async () => {
    const { ERROR_KINDS } = require('../src/notify/engineAlerts');
    for (const kind of ['refusal_unrecognised', 'refused_price_bound', 'bid_price_raise_refused']) {
      assert.ok(!ERROR_KINDS.has(kind),
        `${kind} is on the error channel - that is one WhatsApp DM per load to the client's Director, `
        + 'and it is the alert-storm shape that moved ceiling_below_floor off this channel on 2026-07-27');
    }
  });

  // ============================================================================================
  // 15. THE RECEIPT MAY NOT CLAIM A REPETITION THAT DID NOT HAPPEN. On every tight-budget load the
  //     bound is 1 - one write goes out and nothing is re-sent - yet the first draft told the
  //     Director the portal "kept refusing" and we "stopped re-sending it". An operator reading that
  //     concludes the portal is malfunctioning and misjudges how much of the budget was spent.
  // ============================================================================================
  await check('the hold receipts are bound-aware: no repetition is claimed at a bound of 1', async () => {
    const REPEAT = /kept refusing|several times|stopped re-sending/i;
    for (const reason of ['refused_price_bound', 'refusal_unrecognised']) {
      const tight = renderMessage('no_bid_short', { landedBids: 0, noBidReason: reason, noBidBound: TIGHT_BOUND });
      assert.ok(!REPEAT.test(tight),
        `${reason} claims a repeated send at a bound of 1: ${tight}`);
      const ample = renderMessage('no_bid_short', { landedBids: 0, noBidReason: reason, noBidBound: AMPLE_BOUND });
      assert.ok(REPEAT.test(ample),
        `${reason} does not state the repetition at a bound of 3, where the price genuinely went out three times: ${ample}`);
      // A pre-fix persisted event carries no bound at all and must degrade to the wording that is
      // true at ANY bound, never to the repetition claim.
      const absent = renderMessage('no_bid_short', { landedBids: 0, noBidReason: reason });
      assert.ok(!REPEAT.test(absent),
        `${reason} assumes a repetition on an event carrying no bound: ${absent}`);
    }
    // And the fact actually reaches the receipt off a real run, rather than only off a hand-built
    // payload: the bound the hold applied has to be on the record _finalize reads.
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    refuseAll(eng, CAP_AT_FLOOR);
    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });
    assert.strictEqual(m.noBid.bound, TIGHT_BOUND, 'the bound the hold applied is not on the record the receipt reads');
  });

  // ============================================================================================
  // 16. THE RAISE RECEIPT STATES WHAT THE PORTAL DID, NOT WHY. raiseRefusal's own docstring records
  //     that the cap is not always our own standing bid - BRL's records carry the same wording for a
  //     shipper CEILING - and closes with "nothing here infers it". The receipt may not make on the
  //     Director's behalf an inference the engine refuses to make: reading "our bid is standing" the
  //     desk leaves the load alone, and where the cap was a ceiling it closes with nothing of BRL's
  //     on the board.
  // ============================================================================================
  await check('the raise-refusal receipt does not assert a standing bid of ours as fact', async () => {
    for (const d of [{ noBidReason: 'price_raise_refused', landedBids: 0 },
      { noBidReason: 'price_raise_refused', landedBids: 0, noBidAmountCap: 51_650 }]) {
      const body = renderMessage('no_bid_short', d);
      assert.ok(!/because an earlier and lower bid of ours is still standing/i.test(body),
        `the receipt states the standing-bid reading as fact: ${body}`);
      assert.ok(/either|may be|does not say which/i.test(body),
        `the receipt drops the engine's own hedge - the cap may be a shipper ceiling: ${body}`);
    }
    // The cap figure still rides the sentence where the portal named one; that is what the desk
    // checks the load against.
    const withCap = renderMessage('no_bid_short', { noBidReason: 'price_raise_refused', landedBids: 0, noBidAmountCap: 51_650 });
    assert.ok(/51,650/.test(withCap), `the portal's cap figure is not on the receipt: ${withCap}`);
  });

  // ============================================================================================
  // 17. A LANDED BID MUST NOT SILENCE THESE THREE. _finalize nulls the refusal whenever landedBids
  //     > 0, which is right for a fought loss and wrong for price_raise_refused - that class fires
  //     BY DEFINITION when a quote of ours is still standing, i.e. landedBids > 0 exactly. So the
  //     receipt was suppressed on every close the class exists to explain, the alert for it is
  //     operator-only, and the hold reached nobody but the pm2 log while the desk believed its
  //     corrected higher rate had gone in.
  // ============================================================================================
  await check('a close that landed a bid still tells the desk the board holds the older price', async () => {
    const base = { oaNo: 'OA-1', from: 'Bhiwandi', to: 'Alwar', vehicleType: '32ft', closeTime: '18:30',
      finalRank: 4, attempts: 3, landedBids: 2 };
    const plain = renderMessage('lost', base);
    assert.ok(!/still holds our earlier price/i.test(plain),
      `an ordinary loss carries the held-price clause - it must appear only on the three refusals that can fire with a standing bid: ${plain}`);

    for (const reason of ['price_raise_refused', 'refused_price_bound', 'refusal_unrecognised']) {
      for (const kind of ['lost', 'lost_short']) {
        const body = renderMessage(kind, Object.assign({}, base, { noBidReason: reason, noBidAmountCap: 51_650 }));
        assert.ok(/still holds our earlier price/i.test(body),
          `${kind} on a ${reason} close says nothing about the price still standing on the board: ${body}`);
        assert.ok(!/STATUS|revisionsLeft|_refusedPrice|bidEngine|\.js/.test(body),
          `${kind} on a ${reason} close leaks an internal name: ${body}`);
      }
    }
    // The engine half: the reason has to survive _finalize's landedBids gate to reach the template
    // at all. Driven off the real gate rather than a hand-built payload.
    const eng = mkEngine({ capRevisionLimit: 3 });
    const m = armFine(eng, LD2Z);
    refuseAll(eng, CAP_AT_FLOOR);
    await driveMaybeBid(eng, m, { from: 160_000, stateRevisionLimit: 3 });
    m.landedBids = 2;
    const before = eng._events.length;
    await eng._finalize(m, { closesInMs: 0, myRank: 4 });
    const outcome = eng._events.slice(before).find((e) => e.type === 'auction_result');
    assert.ok(outcome, '_finalize emitted no auction_result');
    assert.strictEqual(outcome.noBidReason, 'refused_price_bound',
      `the refusal was dropped by the landedBids gate (got ${JSON.stringify(outcome.noBidReason)}), so the receipt cannot render the clause`);
    assert.strictEqual(outcome.noBidBound, TIGHT_BOUND, 'the bound did not reach the outcome event');
  });
})();
