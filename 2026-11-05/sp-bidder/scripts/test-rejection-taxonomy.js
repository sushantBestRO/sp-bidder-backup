'use strict';
/**
 * REJECTION TAXONOMY - three classes of SuperProcure refusal, three behaviours.
 *
 * Regression target: docs/diagnoses/2026-08-01_soft-close-retry-deadlock-and-pr-verdict.md (D3 +
 * the correction box), and the forensic pass that settled what "Load not available for bidding"
 * actually is.
 *
 * Until now `isBidCapRejection` was the ONLY classifier in the engine, so every refusal that was
 * not "Bid limit exceeded" took one undifferentiated path. Three genuinely different things were
 * being handled identically:
 *
 *   1. CAP ("Bid limit exceeded")  - the per-load budget is GONE. Terminal. Unchanged by this file.
 *   2. LOAD-NOT-BIDDABLE ("Load not available for bidding") - a PER-LOAD STATE at SuperProcure: the
 *      load is not biddable at all. Evidence: two Borosil loads in the same 12:06-12:21 IST window
 *      on 2026-07-25, same account, same carrier registration, same session, same connection -
 *      23484018 refused at 12:20:36.096, 23484099 ACCEPTED at 12:20:57.816, 88 ms later. Across
 *      every box bid log there are 19 refusal records over 14 distinct loads (of 831 loads that took
 *      a bid attempt, 1.7%), and all 14 have `ourBids: []` / `landedBids: 0` - none ever landed a
 *      bid at any point, and retries 24 s and 3 min apart were refused alike. Cross-joining the
 *      rank_sample stream against closedBids.json: of the 28 loads whose max totalBidders stayed 0
 *      over their whole monitored life, 13/13 were refused; of the 624 loads with >= 1 bidder, 0
 *      were refused. No bid from anyone, ours or a rival's, ever reached the live auction feed on
 *      these loads. So RETRYING IS PROVABLY FUTILE - the engine must stand down, which also keeps
 *      ~23 refused writes off a live shared account instead of 1.
 *   3. PRICE/STATE (everything else: min-decrement mismatch, "load under approval", ...) - THIS
 *      PRICE was refused, so walking down the ladder is correct and must be preserved.
 *
 * Why the engine fires into class 2 blind: realAdapter.js's `this.loadMeta.set(a.id, a)` is the only
 * write to that cache in the file's entire history - no delete, no TTL, no eviction - so a load
 * SuperProcure stops returning keeps its last-known snapshot forever, holds a healthy local
 * countdown, stays armed, and gets bid into. The instrumentation pinned in checks 7 and 8 is what
 * will tell us whether SP DROPPED the load from its listing or kept listing it while refusing it.
 *
 * WHAT MUST NOT MOVE, pinned here as hard as the fix:
 *   - a CAP rejection stays TERMINAL and rolls back NOTHING (check 6);
 *   - the WALK-DOWN survives. A persistent price rejection must still reach the floor (check 4).
 *     This is the check whose absence let the earlier blanket-rollback attempt through: rolling
 *     firedRungs back on every non-cap rejection pins selectRung in place (`while (target < last &&
 *     rungFired(firedRungs, target)) target++` - the fired-rung history IS the walk-down), and the
 *     ladder never reaches the floor at all;
 *   - fire TIMING is untouched. The diagnosis positively excludes the ~2-minute establish lead as
 *     the defect (385 bids ACCEPTED at > 100 s lead across 224 auctions against 16 refused), so
 *     every check fires at the designed marks and asserts only what happens AFTER a refusal.
 *
 * Mock policy: the ONLY seam mocked is the platform adapter (placeBid, plus the new listingTrace
 * read). No engine internal is stubbed - decisions come from the real _decide via the real
 * _maybeBid, and the notification copy is rendered through the real waTemplates. Offline and
 * deterministic: fake adapter, temp-file scheduler, explicit state, no timers, no network.
 *
 *   node scripts/test-rejection-taxonomy.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `rej-tax-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A soft-strategy engine, same shape as the endgame + latch-restore harnesses so all three files
// agree on what an armed soft monitor looks like.
function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

// Arm a soft monitor on a controlled FINE ladder, isolating the rejection logic from
// interpolateBandLadder. currentRungIndex/firedRungs/lastBidPrice are set per check.
function armFine(eng, ladder, { companyName = 'Havells', revisionsLeft = 30, extendCap = 5,
  triggerWindowMs = 100_000, id = 'F' } = {}) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName, branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = triggerWindowMs;
  return m;
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// PROGRAMMABLE per-call platform adapter (the one mocked seam). Each placeBid pops the next outcome
// off `kinds`; past the end it repeats the last - so a single 'reject-price' models the PERSISTENT
// refusal the walk-down has to survive. `attempted` records every price that reached the wire
// (the ladder walk); `placed` records only what the wire ACCEPTED.
//   'ok' | 'reject-cap' | 'reject-not-biddable' | 'reject-price'
function program(eng, kinds, { listingTrace } = {}) {
  const box = { attempted: [], placed: [], calls: 0 };
  let i = 0;
  eng.adapter.placeBid = async (id, price) => {
    box.calls += 1;
    box.attempted.push(price);
    const kind = kinds[Math.min(i, kinds.length - 1)];
    i += 1;
    if (kind === 'reject-cap') {
      return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded' };
    }
    if (kind === 'reject-not-biddable') {
      // Verbatim from load 23484018 (2026-07-25) and load 23718407 (2026-08-01): HTTP 400 with a
      // plaintext body, carried on `text` because the body does not parse as JSON.
      return { accepted: false, reason: 'rejected', status: 400, text: 'Load not available for bidding' };
    }
    if (kind === 'reject-price') {
      return { accepted: false, reason: 'Bid difference too small.', status: 400, text: 'Bid difference too small.' };
    }
    box.placed.push(price); // 'ok'
    return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
  };
  if (listingTrace) eng.adapter.listingTrace = listingTrace;
  return box;
}

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);
const rejectionEvents = (eng) => eng._events.filter((e) => e.type === 'bid_rejected');

/**
 * Drive the real _maybeBid down a countdown at the ENGINE'S OWN cadence, on a virtual clock.
 *
 * Both halves are load-bearing.
 *
 * PRODUCTION CADENCE. Above the 60s threshold the live poll is ~30 SECONDS apart, and below 10s it
 * is 200ms. A test that steps a fixed 100ms offers the engine decision points production never
 * provides, which makes a rule that the live loop steps straight over look reachable. Stepping at
 * `_cadence` is what makes the test and the box agree.
 *
 * A VIRTUAL CLOCK. minInterFireMs and the 60-second maxBidsPerMin window are both measured against
 * Date.now, so a synchronous drive on the real clock collapses the whole countdown into a few
 * milliseconds and measures a rate limiter the box never hits. The global is restored in a finally.
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
      await eng._maybeBid(m, state(r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

(async () => {
  // ============================================================================================
  // 1. LOAD-NOT-BIDDABLE -> STAND DOWN. The load is not biddable AT SUPERPROCURE, so no price and
  //    no later moment changes the answer. The engine must stop: no retry, no rung walk-down, and
  //    no floor snipe even once the window is genuinely final. Exactly ONE write reaches the wire.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    const box = program(eng, ['reject-not-biddable']);

    // The designed soft establish mark: triggerWindowMs (100s) + establishLeadMs (40s) = 140s, with
    // the 30 s far-poll landing the fire in (110s, 140s]. This is the lead the diagnosis positively
    // EXCLUDES as the defect, so it is fired at unchanged.
    await eng._maybeBid(m, state(126_739, null));
    assert.strictEqual(box.calls, 1, 'the establish reached the wire once');
    assert.deepStrictEqual(box.attempted, [10_000], 'the establish fired the opening rung');
    assert.strictEqual(m.loadNotBiddable, true, 'the load-not-biddable class latched a stand-down on the monitor');

    // Poll hard, across the whole remaining life of the auction, including the genuinely-final
    // window that the floor snipe owns. This is where the retry-storm would show up: without the
    // stand-down the deadlock diagnosis measured ~23 refused writes on a shared LIVE account.
    for (const remaining of [126_000, 100_000, 50_000, 20_000, 5_000]) {
      await eng._maybeBid(m, state(remaining, null));
      await eng._maybeBid(m, state(remaining, 2));
    }
    m.extendsObserved = 5; // extensions exhausted -> effectivelyHard -> the floor snipe is eligible
    assert.strictEqual(eng._effectivelyHard(m), true, 'the window is now genuinely final (the floor snipe would fire here)');
    await eng._maybeBid(m, state(1_500, 2));
    await eng._maybeBid(m, state(1_200, null));

    assert.strictEqual(box.calls, 1, 'attempts stay at 1 - no retry, no walk-down, no floor snipe on a load SP is refusing outright');
    assert.deepStrictEqual(box.attempted, [10_000], 'no second price ever reached the wire');
    assert.deepStrictEqual(box.placed, [], 'nothing landed (SuperProcure refused the only attempt)');
    assert.strictEqual(m.ownBidAttempts, 1, 'exactly one wire attempt is counted against the shared account');
    // LADDER NOT BURNED. currentRungIndex rolls back (the non-cap restore), and the stand-down is
    // what stops the ladder rather than an exhausted ladder or a zeroed budget - so a re-price that
    // rebuilds this monitor starts from a clean position, not a spent one.
    assert.strictEqual(m.currentRungIndex, -1, 'the ladder position is rolled back - the refused rung was never consumed');
    assert.strictEqual(m.revisionsLeft, 30, 'the budget is NOT driven to zero - this is not a cap rejection');
    assert.strictEqual(m.capExhausted, false, 'capExhausted stays false - the two classes must not be conflated');
    ok('load-not-biddable: the engine stands down - one attempt, ladder not burned, no floor snipe');
  }

  // ============================================================================================
  // 2. LOAD-NOT-BIDDABLE raises its OWN alert kind, once, and routes as a desk notice carrying the
  //    load's scope keys - so it reaches the customer's own group rather than paging ops with a
  //    fault they cannot fix.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    program(eng, ['reject-not-biddable']);
    await eng._maybeBid(m, state(126_739, null));
    for (const r of [120_000, 60_000, 5_000]) await eng._maybeBid(m, state(r, 2));

    const alerts = alertsOfKind(eng, 'load_not_biddable');
    assert.strictEqual(alerts.length, 1, 'exactly one load_not_biddable alert per load (latched, not one per poll)');
    assert.strictEqual(alertsOfKind(eng, 'bid_cap_exhausted').length, 0, 'it is NOT reported as a bid-cap exhaustion');

    const n = toNotification(alerts[0]);
    assert.ok(n, 'the alert maps to a notification');
    assert.strictEqual(n.kind, 'desk_notice', 'it routes as a NON-PAGING desk notice, not an ops error');
    assert.strictEqual(n.data.shipper, 'Havells', 'the payload carries the shipper scope key (a customer group can match it)');
    assert.strictEqual(n.data.origin, 'Bhiwandi', 'the payload carries the origin scope key');
    assert.strictEqual(n.data.branch, 'Alwar Cable', 'the payload carries the branch scope key (branch-split loads route to the branch group)');

    const msg = renderMessage('desk_notice', n.data);
    assert.ok(/SuperProcure/.test(msg), 'the desk notice names SuperProcure as the party that closed the load to bidding');
    assert.ok(!/\bbot\b/i.test(msg), 'desk-plain copy - no "bot" wording');
    assert.ok(!/re-price/i.test(msg), 'it does NOT ask the desk to re-price - the rate is not the problem');
    ok('load-not-biddable: one distinct alert kind, routed as a desk notice with the load scope keys');
  }

  // ============================================================================================
  // 3. THE CLOSE-TIME RECEIPT says what actually happened. Before this, a load SuperProcure had
  //    taken out of bidding closed with the generic "A rate was entered but no bid could be placed
  //    before close. Please check this load on SuperProcure." - which sends the desk hunting a
  //    pricing mistake that does not exist.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    program(eng, ['reject-not-biddable']);
    await eng._maybeBid(m, state(126_739, null));
    await eng._finalize(m, { myRank: null });

    const res = eng._events.find((e) => e.type === 'auction_result');
    assert.ok(res, 'auction_result was emitted');
    assert.strictEqual(res.landedBids, 0, 'nothing landed');
    assert.strictEqual(res.noBidReason, 'load_not_biddable',
      'the RECORDED refusal reason rides the outcome (the same _recordRefusal spine ceiling_below_floor uses)');

    const n = toNotification(res);
    assert.strictEqual(templateFor('lost', n.data), 'no_bid', 'the close still renders the no_bid template');
    const msg = renderMessage(templateFor('lost', n.data), n.data);
    assert.ok(/SuperProcure/.test(msg), 'the receipt names SuperProcure as the reason nothing landed');
    assert.ok(!/A rate was entered but no bid could be placed before close/.test(msg),
      'the generic unknown-reason wording is GONE - it sent the desk to look for a pricing mistake that does not exist');
    assert.ok(!/Our Final Ranking/.test(msg), 'still no dangling ranking line');
    ok('load-not-biddable: the close-time receipt states the platform reason, not the generic no-bid line');
  }

  // ============================================================================================
  // 4. THE WALK-DOWN SURVIVES. A PERSISTENT price/state rejection means THIS PRICE was refused, so
  //    the ladder must keep stepping down and still reach the floor. This is the check whose absence
  //    let the blanket-rollback regression through: rolling firedRungs back on every non-cap
  //    rejection pins selectRung on one rung forever (measured: 9700 x 12, floor never reached).
  //    Correct shape - currentRungIndex rolled back, firedRungs kept except at the floor - measured
  //    9700, 9400, 9100, 8000, 8000, ... which is what this asserts.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000; // established at the opening rung
    const box = program(eng, ['reject-price']); // PERSISTENT - every attempt refused, forever

    // Mid-auction defends, extensions still in hand: step down one rung per poll. The floor stays
    // RESERVED for the genuinely-final window (selectRung clamps defend at last - 1), which is why
    // the walk stops at 9100 here rather than dumping the floor early.
    for (let i = 0; i < 5; i++) await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(box.attempted, [9_700, 9_400, 9_100],
      'the ladder WALKS DOWN under a persistent refusal and does not stall on one rung (the regression this pins)');

    // Extensions exhaust -> genuinely final -> the reserved floor is spent, and keeps being retried.
    m.extendsObserved = 5;
    await eng._maybeBid(m, state(1_500, 2));
    await eng._maybeBid(m, state(1_400, 2));
    await eng._maybeBid(m, state(1_300, 2));
    assert.deepStrictEqual(box.attempted, [9_700, 9_400, 9_100, 8_000, 8_000, 8_000],
      'the walk reaches the FLOOR and the refused floor is retried (nothing lower to walk to)');
    assert.deepStrictEqual(box.placed, [], 'a persistent refusal lands nothing, by construction');
    assert.strictEqual(m.loadNotBiddable, false, 'a price/state refusal must NOT be misread as load-not-biddable');
    ok('persistent price rejection: the ladder still walks 9700 -> 9400 -> 9100 -> floor, then retries the floor');
  }

  // ============================================================================================
  // 5. A REFUSED FLOOR RUNG IS RETRIED, NOT ABANDONED. Both snipe paths gate on firedRungs, so
  //    banking a refused floor gives up the single decisive shot of the auction with seconds and
  //    budget still in hand. At the floor there is nothing lower to walk to, so the rung history is
  //    the one thing that must roll back here.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0, revisionsLeft: 5 });
    m.currentRungIndex = 0; m.lastBidPrice = 10_000;
    for (const r of [0, 1, 2, 3]) m.firedRungs.add(r); // every rung above the floor already spent
    const box = program(eng, ['reject-price', 'ok']);

    await eng._maybeBid(m, state(1_500, 2)); // the decisive floor shot, REFUSED
    assert.deepStrictEqual(box.attempted, [8_000], 'the decisive shot fired the floor');
    assert.strictEqual(m.snipeFired, false, 'a non-cap rejection restores the snipe latch (nothing landed)');
    assert.ok(!m.firedRungs.has(4), 'the refused FLOOR rung is un-banked - at the floor there is nothing lower to fall to');

    await eng._maybeBid(m, state(1_400, 2)); // the very next poll re-fires it and LANDS
    assert.deepStrictEqual(box.placed, [8_000], 'the refused floor is retried on the next poll and lands');
    assert.strictEqual(m.snipeFired, true, 'once the shot actually LANDS, the snipe latches (single-shot from here)');
    await eng._maybeBid(m, state(1_200, 3));
    assert.strictEqual(box.calls, 2, 'no further wire attempt once the decisive shot has landed (no double-fire)');
    ok('refused floor rung: retried on the next poll and landed - the decisive shot is never abandoned');
  }

  // ============================================================================================
  // 6. A CAP REJECTION STAYS TERMINAL and rolls back NOTHING. "Bid limit exceeded" is SuperProcure
  //    stating the per-load budget is gone, so no rung, price or later moment changes the answer.
  //    This is the class the fix must not widen or narrow.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['reject-cap', 'ok']);

    await eng._maybeBid(m, state(50_000, 2)); // defend rung 1, refused for the shared-account cap
    assert.deepStrictEqual(box.attempted, [9_700], 'the defend rung reached the wire');
    assert.strictEqual(m.capExhausted, true, 'the cap rejection latched capExhausted');
    assert.strictEqual(m.revisionsLeft, 0, 'the budget is driven to zero');
    assert.strictEqual(m.loadNotBiddable, false, 'a cap rejection is NOT the load-not-biddable class');
    // The rung bookkeeping is HELD, not rolled back: a cap-refused load has no path back onto the
    // board, so un-banking the rung would only invite a retry storm into a wall.
    assert.ok(m.firedRungs.has(1), 'a CAP rejection banks the refused rung (no rollback - terminal)');
    assert.strictEqual(m.currentRungIndex, 1, 'a CAP rejection advances the ladder position (no rollback - terminal)');

    const callsAfter = box.calls;
    m.extendsObserved = 5; // even in the genuinely-final window, a capped load spends nothing
    await eng._maybeBid(m, state(50_000, 2));
    await eng._maybeBid(m, state(1_500, 2));
    assert.strictEqual(box.calls, callsAfter, 'no further wire attempt on a capped load - no retry storm');
    assert.deepStrictEqual(box.placed, [], 'nothing ever landed on the capped load');
    ok('cap rejection: still terminal - budget zeroed, rung bookkeeping HELD, no retry');
  }

  // ============================================================================================
  // 7. INSTRUMENTATION ON THE REJECTION RECORD (U1, the question still open). We cannot yet tell
  //    whether SuperProcure DROPPED these loads from its listing or kept listing them as open while
  //    refusing every bid. The rejection record now carries how long ago the load was last seen in a
  //    list response and the cached biddingOn - both read from the adapter's own cache, so no extra
  //    request is made on the money path.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    program(eng, ['reject-not-biddable'], {
      listingTrace: () => ({ lastSeenInListAgoMs: 94_000, lastSeenInListAt: Date.now() - 94_000, biddingOn: true }),
    });
    await eng._maybeBid(m, state(126_739, null));

    const rej = rejectionEvents(eng);
    assert.strictEqual(rej.length, 1, 'one bid_rejected record');
    assert.strictEqual(rej[0].lastSeenInListAgoMs, 94_000,
      'the rejection record carries how long ago the load was last seen in a /sp/loads/v4 listing');
    assert.strictEqual(rej[0].biddingOn, true, 'and the cached biddingOn from that listing');
    assert.strictEqual(rej[0].body, 'Load not available for bidding', 'the raw platform body is still carried verbatim');

    // An adapter with NO listingTrace (mockAdapter, gocometAdapter, every sim harness) must still
    // reject cleanly - the fields simply degrade to null. This is not optional: the engine is
    // platform-agnostic and the trace is a SuperProcure-only capability.
    const eng2 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m2 = armFine(eng2, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'G' });
    program(eng2, ['reject-price']);
    await eng2._maybeBid(m2, state(126_739, null));
    const rej2 = rejectionEvents(eng2);
    assert.strictEqual(rej2.length, 1, 'an adapter without listingTrace still produces a rejection record');
    assert.strictEqual(rej2[0].lastSeenInListAgoMs, null, 'the listing age degrades to null rather than throwing');
    assert.strictEqual(rej2[0].biddingOn, null, 'biddingOn degrades to null too');

    // TELEMETRY MUST NEVER REWRITE A MONEY OUTCOME. The trace is read inside the same try{} whose
    // catch is the uncertain-outcome handler ("placeBid threw - the write may have COMMITTED"). An
    // adapter whose listingTrace THROWS must not be routed there: that handler runs the read-back
    // oracle and, unable to disprove a commit, banks the rung and increments landedBids - inventing
    // a LANDED bid out of a response we are holding and know was REJECTED.
    const eng3 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m3 = armFine(eng3, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'H' });
    program(eng3, ['reject-not-biddable'], {
      listingTrace: () => { throw new Error('listing cache blew up'); },
    });
    await eng3._maybeBid(m3, state(126_739, null));
    assert.strictEqual(m3.landedBids, 0, 'a throwing listingTrace does NOT fabricate a landed bid out of a rejected one');
    assert.strictEqual(m3.lastBidPrice, null, 'nor a last bid price');
    assert.strictEqual(rejectionEvents(eng3).length, 1, 'the rejection is still recorded normally');
    assert.strictEqual(rejectionEvents(eng3)[0].lastSeenInListAgoMs, null, 'the failed trace degrades to null');
    assert.strictEqual(m3.loadNotBiddable, true, 'and the load-not-biddable class is still classified correctly');
    ok('instrumentation: the rejection record carries the listing age + cached biddingOn, and never rewrites a money outcome');
  }

  // ============================================================================================
  // 8. THE ADAPTER SIDE of that instrumentation: listAuctions stamps a last-seen time per load, and
  //    _mapLoad stops discarding the three raw /sp/loads/v4 fields that would explain the refusal.
  // ============================================================================================
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });
    const future = new Date(Date.now() + 600_000).toISOString();
    a._post = async () => ({ status: 200, json: { data: { loadDetails: [
      { id: 23484018, companyName: 'Borosil', biddingOn: 1, biddingCloseTime: future,
        biddingStartTime: new Date(Date.now() - 60_000).toISOString(), branchAuctionExtendTime: '00:03:00',
        loadStatusKey: 'BID_CLOSED', loadNotificationStatus: 3, oldLoadId: 23400001 },
    ] } } });

    const mapped = await a.listAuctions();
    assert.strictEqual(mapped.length, 1, 'the load mapped');
    assert.strictEqual(mapped[0].loadStatusKey, 'BID_CLOSED', '_mapLoad carries loadStatusKey (was discarded)');
    assert.strictEqual(mapped[0].loadNotificationStatus, 3, '_mapLoad carries loadNotificationStatus (was discarded)');
    assert.strictEqual(mapped[0].oldLoadId, 23400001, '_mapLoad carries oldLoadId (was discarded)');

    const trace = a.listingTrace('23484018');
    assert.ok(trace, 'listingTrace resolves for a load just seen in a listing');
    assert.ok(trace.lastSeenInListAgoMs != null && trace.lastSeenInListAgoMs < 5_000,
      'the last-seen age is ~now for a load in the response we just processed');
    assert.strictEqual(trace.biddingOn, true, 'the trace reports the cached biddingOn');

    // A load the adapter has NEVER listed - the exact shape a dropped-from-listing load degrades to.
    const unseen = a.listingTrace('99999999');
    assert.strictEqual(unseen.lastSeenInListAgoMs, null, 'a never-listed load reports a null age, never a fabricated one');
    assert.strictEqual(unseen.biddingOn, null, 'and a null biddingOn');
    ok('adapter: listAuctions stamps a per-load last-seen time, and _mapLoad keeps the three explanatory fields');
  }

  // ============================================================================================
  // 9. THE PRODUCTION SHAPE, end to end through _maybeBid. Every check above sets currentRungIndex
  //    by hand and drives _decide. The real deadlock starts one step earlier and from the OTHER
  //    end of the ladder: currentRungIndex is -1 (nothing has ever been banked on this load), the
  //    ESTABLISH bid is what gets refused, and the trace from 23700092 reads exactly
  //    `placeBid REJECTED price 28150 rungIndex 0`.
  //
  //    That is the case the currentRungIndex rollback re-opens - and, on its own, the case it turns
  //    into a loop: the establish branch does not consult firedRungs, so it re-offers the SAME
  //    refused price every tick until maxBidsPerMin is exhausted, and that gate returns BEFORE
  //    _decide, so the exhaustion also starves the floor snipe. Measured on the most common real
  //    rejection string in the corpus (8 of 25 records), where SP's cap sits below ladder[0]:
  //
  //      origin/main   attempts 5    LANDED [9100, 8000]   won a bid
  //      this rollback attempts 20   LANDED []             won nothing
  //
  //    The branch lost auctions main was winning. Both properties are asserted: the walk-down is
  //    restored (the establish skips rungs already refused, exactly as selectRung walks), and the
  //    write count stays bounded well under the cap.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'P9' });
    m.currentRungIndex = -1;                       // the real production shape: nothing banked yet
    m.firedRungs.clear();
    m.landedBids = 0;
    // SuperProcure's own cap sits at 9,200 - below ladder[0] and ladder[1] - so those two are refused
    // and everything at or under the cap lands. Verbatim wire string.
    const attempted = [];
    const landed = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (price > 9_200) {
        const t = 'Amount is invalid. Amount should be less than or equal to 9200';
        return { accepted: false, reason: t, status: 400, text: t };
      }
      landed.push(price);
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.ok(landed.length > 0,
      `nothing landed at all. Attempted [${attempted.join(', ')}] - the establish branch re-offered the refused `
      + 'price instead of walking past it, so the ladder never reached a price SuperProcure would take. '
      + 'origin/main wins this load; this loses it');
    assert.ok(attempted.length <= 8,
      `${attempted.length} writes went to the wire on ONE load against a maxBidsPerMin of ${eng.cfg.maxBidsPerMin}. `
      + 'Those are refused writes on a shared live account, and burning the per-minute budget on them is what '
      + 'starves the floor snipe - its gate returns before _decide is ever called');
    assert.ok(new Set(attempted).size >= 3,
      `only ${new Set(attempted).size} distinct prices were offered: [${attempted.join(', ')}]. The establish branch `
      + 'is re-offering a rung already in firedRungs rather than walking down past it');
    ok('production shape (establish refused from currentRungIndex -1): the walk-down resumes and the writes stay bounded');
  }

  // ============================================================================================
  // 10. THE SAME, on a NON-ALLOWLISTED shipper. Every engine in this file is soft-close allowlisted,
  //     so every check runs the rank-driven path - and the DEPLOYED clock-scheduled step-down has
  //     never been exercised with a rejection anywhere in the suite. The currentRungIndex rollback
  //     is not allowlist-gated (it is in the shared restore block), so it changes that path too, and
  //     an untested behaviour change on the deployed path is how a customer who never opted in gets
  //     a regression.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['SomeoneElse'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { companyName: 'NotOnTheList', id: 'P10' });
    assert.strictEqual(m.softStrategy, 'off', 'fixture must produce a NON-allowlisted monitor (the deployed path)');
    m.currentRungIndex = -1;
    m.firedRungs.clear();
    m.landedBids = 0;
    const attempted = [];
    const landed = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (price > 9_200) {
        const t = 'Amount is invalid. Amount should be less than or equal to 9200';
        return { accepted: false, reason: t, status: 400, text: t };
      }
      landed.push(price);
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    assert.ok(landed.length > 0,
      `the DEPLOYED (non-allowlisted) path landed nothing. Attempted [${attempted.join(', ')}] - a customer who never `
      + 'opted into soft close had their load turned from a win into a loss by a change they are not enrolled in');
    assert.ok(attempted.length <= 8,
      `${attempted.length} refused writes on the deployed path (cap ${eng.cfg.maxBidsPerMin})`);
    ok('deployed (non-allowlisted) path: a refused establish still walks the ladder down, bounded');
  }

  // ============================================================================================
  // 11. THE FLOOR RESERVATION. maxBidsPerMin is doing two jobs: it is a runaway rate limit AND, by
  //     accident, the only thing standing between a retry loop and the write budget the decisive
  //     shot needs. Its gate returns BEFORE _decide, so whichever code path spends the budget first
  //     wins - and a retry loop always gets there first, because it runs for the whole auction while
  //     the floor shot has one 2.5s window at the end.
  //
  //     The diagnosis names an explicit reservation as a requirement in its own right. This asserts
  //     it directly: burn the ordinary budget to its limit, then check the floor can still fire.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'P11' });
    m.currentRungIndex = -1;
    m.firedRungs.clear();
    m.landedBids = 0;
    // EVERY write refused, so nothing ever lands and the retry path has every incentive to run away.
    // The cap in the refusal is our opening rung minus the 100 minimum decrement, which is the shape
    // SuperProcure actually sends and leaves the 8,000 floor offerable. It read `equal to 1` before,
    // which says no rung on this ladder could EVER be accepted - a refusal the engine now stands
    // down on rather than walking, so the fixture no longer described the retry this case is about.
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      const t = 'Amount is invalid. Amount should be less than or equal to 9900';
      return { accepted: false, reason: t, status: 400, text: t };
    };
    await driveMaybeBid(eng, m, { from: 160_000, rank: null });
    const floorPrice = m.ladder[m.ladder.length - 1];
    assert.ok(attempted.includes(floorPrice),
      `the floor price ${floorPrice} never reached the wire. Attempted [${attempted.join(', ')}] - the retry path ate `
      + 'the write budget and the decisive shot was starved by the very cap cited as its protection');
    assert.ok(attempted.length < eng.cfg.maxBidsPerMin,
      `${attempted.length} writes against a cap of ${eng.cfg.maxBidsPerMin}: the run was bounded by the rate limit, `
      + 'not by a reservation. A reservation means ordinary retries stop BELOW the cap so the floor always has budget');
    ok('floor reservation: ordinary retries stop below the cap and the decisive shot still reaches the wire');
  }

  // ============================================================================================
  // 12. WINNING IS STILL SACRED through the reopened establish path. With currentRungIndex rolled
  //     back to -1, `myRank === 1` at step 2 of _decide is no longer upstream of every route into
  //     the never-forfeit release - a load standing at L1 on a foreign bid can now reach it. That
  //     guard had zero recorded exercises before this change; it has one now.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'P12' });
    m.currentRungIndex = -1;
    m.firedRungs.clear();
    m.landedBids = 0;
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      const t = 'Amount is invalid. Amount should be less than or equal to 9900';
      return { accepted: false, reason: t, status: 400, text: t };
    };
    await driveMaybeBid(eng, m, { from: 160_000, rank: 1 }); // we hold L1 throughout
    assert.ok(!attempted.includes(m.ladder[m.ladder.length - 1]),
      `the floor was sent while we were already L1 (attempted [${attempted.join(', ')}]) - that only pushes the clock `
      + 'out and invites a counter on a load we are winning');
    ok('holding L1: the reopened establish path never gives away a leading bid');
  }

  cleanup();
  // Completion sentinel. run-tests.js grades by EXIT CODE alone, so a file that returns early - an
  // unhandled early return, an unref'd timer, a swallowed rejection - is a silent green with zero
  // assertions. Asserting the count before exiting makes that impossible: the process can only reach
  // exit(0) having run all twelve checks.
  assert.strictEqual(pass, 12, `expected all 12 checks to run, got ${pass}`);
  console.log(`\n${pass}/12 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
