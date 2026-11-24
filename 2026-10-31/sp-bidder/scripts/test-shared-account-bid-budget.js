'use strict';
/**
 * Shared-account bid budget + bid-revision observability.
 * Ground truth: docs/diagnoses/2026-07-21_tata-bid-limit-rejection.md (load 23341274, Tata
 * Consumer, carrier 2667, cap branchBidCountAllowed = 3, cost 18000, ladder [20268, 19296, 18486]).
 *
 * Two capabilities are pinned here, plus the observability that makes them auditable.
 *
 * FAULT B - the engine must STOP spending rungs once SuperProcure refuses a bid for an exceeded
 * per-load bid limit. On the live load it did not: the reject branch recorded the fired rung but
 * never touched revisionsLeft, so after rung 1 came back HTTP 400 "Bid limit exceeded" the engine
 * still believed it had budget and fired rung 2 (the floor) into the identical wall 21 seconds
 * later. The cap refusal is terminal for the load - no later moment or lower price changes it.
 *
 * FAULT A - a standing rank on this account BEFORE this process has bid at all means a bid we did
 * not place is holding a position: BRL humans bid manually on the same account, and SuperProcure
 * counts those against the same per-load cap. Detected from OUR OWN rank (the one competitive fact
 * SP does not mask), never concluded from failed bids.
 *
 * OBSERVABILITY - SuperProcure exposes no remaining-bid count anywhere, so the only way to ever
 * witness whether it RESETS a load's cap when a soft-close auction auto-extends is to correlate a
 * bid's accept/reject outcome against how many extensions had been observed at that moment. That
 * requires extendsObserved / believedCloseAt / closeModel / engineRevisionsLeft to be on the durable
 * bid records - it cannot be backfilled from today's logs.
 *
 * Offline and deterministic throughout: fake adapters, memory store, no token, no network.
 *
 *   node scripts/test-shared-account-bid-budget.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { armFromRequest } = require('../src/pricing/priceRequests');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0, fail = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const bad = (n) => { console.error('  FAIL - ' + n); fail++; };
const check = (cond, n) => (cond ? ok(n) : bad(n));

const tmp = (n) => path.join(os.tmpdir(), `sabb-${n}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const cleanup = (f) => { try { fs.unlinkSync(f); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real load's numbers, so the reproduction is the incident and not an abstraction.
const COST = 18_000;
const MARGINS = [12.6, 7.2, 2.7];
const LADDER = [20268, 19296, 18486];
const CAP = 3;                       // branchBidCountAllowed on the Tata load
const CAP_BODY = 'Bid limit exceeded'; // the ENTIRE plaintext body SP returned, verbatim
// A different SuperProcure refusal, captured on another live load. The cap matcher must NOT fire on
// it: treating an unrelated refusal as terminal would silently forfeit a winnable auction.
const OTHER_BODY = 'Load is under approval for allotment. Bidding is not allowed.';

const META = (id) => ({ id, lane: { origin: 'Pune', destination: 'Bengaluru' }, equipment: '32ft',
  units: 1, companyName: 'Tata Consumer Product Ltd', closesAt: Date.now() + 5_000 });
const INPUTS = { cost: COST, marginsPct: MARGINS };

/**
 * Rank-only hard-close adapter shaped like realAdapter's actual contract: revisionsLeft is ALWAYS
 * null (SP publishes no remaining count - realAdapter.getAuctionState hardcodes it) and only the
 * static revisionLimit is surfaced, so the engine seeds from the cap and decrements locally. That
 * detail is the whole reason the shared-account blindness exists, so the fake must not paper over it.
 *
 * rejectAtCall: 1-based index of the placeBid call that comes back rejected with rejectBody.
 * rank: what the socket reports as OUR rank, given how many bids WE have placed. The DEFAULT is a
 *   clean load - no rank until our own first bid lands - so the Fault B scenarios are isolated from
 *   the Fault A budget discount. The Fault A scenarios pass a rank that exists from tick one.
 */
function adapter({ rejectAtCall = null, rejectBody = CAP_BODY,
                   rank = (placedCount) => (placedCount > 0 ? 2 : null),
                   revisionLimit = CAP, revisionsLeft = null, extendsFrom = null } = {}) {
  return {
    placed: [],   // every price that reached the wire, in order
    calls: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const closesAt = this.closesAt;
      const remaining = Math.max(0, closesAt - Date.now());
      const st = {
        ok: true, status: remaining <= 0 ? 'closed' : 'live',
        myRank: rank(this.placed.length), totalBidders: 4, standingL1Price: null,
        closesInMs: remaining, revisionLimit, revisionsLeft,
        closeModel: 'hard', measuredRttMs: 50,
      };
      if (extendsFrom) Object.assign(st, extendsFrom(this.placed.length));
      return st;
    },
    async placeBid(id, price) {
      this.calls += 1;
      this.placed.push(price);
      if (rejectAtCall != null && this.calls === rejectAtCall) {
        return { accepted: false, reason: rejectBody, status: 400, text: rejectBody, carrierSent: 2667 };
      }
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 60 };
    },
  };
}

function run(a, { id = 'T1', closesInMs = 5_000, waitMs = 5_600, config = {} } = {}) {
  const f = tmp(id);
  a.closesAt = Date.now() + closesInMs;
  const events = [];
  const samples = [];
  const engine = new BidEngine(a, new DurableScheduler(f), {
    // The DEPLOYED establish/floor marks, so the rung sequence under test is the real one.
    config: Object.assign({ openAtMs: 15_000, floorWindowMs: 2_500, cadenceJitterMs: 0 }, config),
    onEvent: (e) => events.push(e),
    onSample: (s) => samples.push(s),
    rand: () => 0,
  });
  const meta = Object.assign(META(id), { closesAt: a.closesAt });
  engine.arm(meta, INPUTS);
  return sleep(waitMs).then(() => {
    // snapshot BEFORE stop - stop() deletes the monitor from the map, so the reverse order
    // would silently assert against undefined instead of against the monitor's real end state.
    const snap = engine.snapshot().find((m) => m.auctionId === id) || null;
    engine.stop(id); cleanup(f);
    return { events, samples, engine, snap };
  });
}

const alerts = (events, kind) => events.filter((e) => e.type === 'alert' && e.kind === kind);

(async () => {
  // ==========================================================================================
  // 1. FAULT B - a cap rejection stops further rung spending.
  //    Reproduces the incident: rung 0 lands, rung 1 is refused "Bid limit exceeded". Rung 2
  //    (the floor) must NEVER reach the wire, even though the auction runs on for seconds past
  //    the point the floor-snipe window opens and the engine's own ladder still has it unfired.
  // ==========================================================================================
  {
    const a = adapter({ rejectAtCall: 2 });
    const { events, snap } = await run(a, { id: 'CAP1' });

    check(a.placed.length === 2, `FaultB only two bids reached the wire (got ${a.placed.length}: ${a.placed.join(', ')})`);
    check(a.placed[0] === LADDER[0] && a.placed[1] === LADDER[1],
      'FaultB the two wire bids are the establish + the one step-down, in order');
    check(!a.placed.includes(LADDER[2]),
      'FaultB the FLOOR rung never fired after the cap rejection (the 21s-later second refusal is gone)');

    const capAlerts = alerts(events, 'bid_cap_exhausted');
    check(capAlerts.length === 1, `FaultB bid_cap_exhausted emitted exactly once (got ${capAlerts.length})`);
    const al = capAlerts[0] || {};
    check(al.level === 'error', 'FaultB bid_cap_exhausted is error level');
    check(al.auctionId === 'CAP1' && al.companyName === 'Tata Consumer Product Ltd'
      && al.lane && al.lane.origin === 'Pune' && al.reason === CAP_BODY,
      'FaultB bid_cap_exhausted carries auctionId, lane, companyName, reason');

    check(snap && snap.capExhausted === true, 'FaultB monitor latched capExhausted');
    check(snap && snap.revisionsLeft === 0, 'FaultB revisionsLeft driven to 0 (terminal budget exhaustion)');
    // The cap alert supersedes the vaguer no_revisions_left, so the operator gets one cause, not two.
    check(alerts(events, 'no_revisions_left').length === 0,
      'FaultB no_revisions_left is suppressed - bid_cap_exhausted already named the cause');
    check(alerts(events, 'foreign_bids_detected').length === 0,
      'FaultB isolated: a clean load raises no foreign-bid detection, so the stop is the cap alone');
  }

  // ==========================================================================================
  // 2. The matcher is NARROW. An unrelated SuperProcure refusal must not exhaust the budget:
  //    the engine keeps its ladder and still spends the floor rung in the final window. This is
  //    the control that stops "stop bidding on any 400" from being an acceptable implementation.
  // ==========================================================================================
  {
    const a = adapter({ rejectAtCall: 2, rejectBody: OTHER_BODY });
    const { events, snap } = await run(a, { id: 'CAP2' });

    check(a.placed.includes(LADDER[2]),
      'narrow-matcher a NON-cap rejection leaves the budget intact - the floor rung still fires');
    check(alerts(events, 'bid_cap_exhausted').length === 0,
      'narrow-matcher no bid_cap_exhausted on "Load is under approval for allotment"');
    check(snap && snap.capExhausted === false, 'narrow-matcher capExhausted stays false on an unrelated refusal');
  }

  // ==========================================================================================
  // 3. capExhausted OVERRIDES an adapter-reported revisionsLeft (fail closed). SP reports none
  //    today, but a mock/sim/future adapter that does must not be able to un-exhaust a load the
  //    platform has already refused and walk the engine back into the same wall.
  // ==========================================================================================
  {
    const a = adapter({ rejectAtCall: 2, revisionsLeft: 3 }); // adapter insists 3 remain, every tick
    const { snap } = await run(a, { id: 'CAP3' });
    check(snap && snap.revisionsLeft === 0,
      'fail-closed a live revisionsLeft:3 cannot raise the belief after a cap rejection');
    check(!a.placed.includes(LADDER[2]),
      'fail-closed the floor rung still never fires despite the adapter reporting budget');
  }

  // ==========================================================================================
  // 4. FAULT A - foreign-bid detection fires ONLY when a rank pre-exists our first bid.
  //    4a: rank present from tick 1, no bot bid yet -> detected.
  //    4b: rank null until after our own first bid lands -> NEVER detected (our own rank is not
  //        evidence of a human's bid; a false positive here would silently shrink a clean budget).
  // ==========================================================================================
  {
    // 4a - the Tata shape: the account already held a position (rank 2 since 10:48) an hour
    // before the bot's first bid.
    const a = adapter({ rank: () => 2 });
    const { events, snap } = await run(a, { id: 'FGN1' });
    const det = alerts(events, 'foreign_bids_detected');
    check(det.length === 1, `FaultA foreign_bids_detected emitted exactly once (got ${det.length})`);
    const d = det[0] || {};
    check(d.level === 'warn', 'FaultA foreign_bids_detected is warn level');
    check(d.auctionId === 'FGN1' && d.companyName === 'Tata Consumer Product Ltd'
      && d.lane && d.lane.origin === 'Pune' && d.myRank === 2,
      'FaultA foreign_bids_detected carries auctionId, lane, companyName, myRank');
    check(snap && snap.foreignBidsDetected === true, 'FaultA monitor latched foreignBidsDetected');
  }
  {
    // 4b - rank stays null until the bot has placed a bid of its own. Nothing foreign here.
    const a = adapter({ rank: (placedCount) => (placedCount > 0 ? 1 : null) });
    const { events, snap } = await run(a, { id: 'FGN2' });
    check(alerts(events, 'foreign_bids_detected').length === 0,
      'FaultA NO detection when the rank only appears after our own first bid');
    check(snap && snap.foreignBidsDetected === false, 'FaultA foreignBidsDetected stays false');
    check(snap && snap.ownBidAttempts > 0, 'FaultA precondition: the bot did bid on FGN2');
  }

  // ==========================================================================================
  // 5. The budget response to a detection: on a LOW-CAP load give back exactly the one slot we
  //    have proven is spent (a standing rank means a bid was placed, and SP counts it the moment
  //    it is placed), never more. Above the threshold the cap absorbs it and nothing changes.
  // ==========================================================================================
  {
    // cap 3 (Tata, KEI, Cords Cable, Vishal Pipes, BG - 7 of 12 active customers) -> 3 becomes 2.
    // Asserted on the FIRST tick, before any bid has decremented it, so the discount is isolated.
    const a = adapter({ rank: () => 2, revisionLimit: 3 });
    const f = tmp('LOW'); a.closesAt = Date.now() + 60_000;
    const engine = new BidEngine(a, new DurableScheduler(f), { config: { cadenceJitterMs: 0 }, rand: () => 0 });
    engine.arm(Object.assign(META('LOW'), { closesAt: a.closesAt }), INPUTS);
    await sleep(150);
    const snap = engine.snapshot().find((m) => m.auctionId === 'LOW');
    check(snap && snap.revisionsLeft === 2,
      `low-cap cap 3 + a foreign standing bid -> budget belief 2, not 3 (got ${snap && snap.revisionsLeft})`);
    check(a.placed.length === 0, 'low-cap precondition: no bid fired yet at T-60s (belief isolated from spending)');
    engine.stop('LOW'); cleanup(f);
  }
  {
    // cap 10 (Rajratan, Transrail) - plenty of slack, so the deployed behaviour is unchanged.
    const a = adapter({ rank: () => 2, revisionLimit: 10 });
    const f = tmp('HIGH'); a.closesAt = Date.now() + 60_000;
    const engine = new BidEngine(a, new DurableScheduler(f), { config: { cadenceJitterMs: 0 }, rand: () => 0 });
    engine.arm(Object.assign(META('HIGH'), { closesAt: a.closesAt }), INPUTS);
    await sleep(150);
    const snap = engine.snapshot().find((m) => m.auctionId === 'HIGH');
    check(snap && snap.revisionsLeft === 10, `high-cap cap 10 is NOT discounted (got ${snap && snap.revisionsLeft})`);
    check(snap && snap.foreignBidsDetected === true, 'high-cap the detection still fires and is still recorded');
    engine.stop('HIGH'); cleanup(f);
  }
  {
    // The clamp: a cap of 1 must never be discounted to 0. A detection must not be able to talk
    // the engine out of bidding a load altogether - the establishing bid always still fires.
    const a = adapter({ rank: () => 2, revisionLimit: 1 });
    const f = tmp('CLAMP'); a.closesAt = Date.now() + 60_000;
    const engine = new BidEngine(a, new DurableScheduler(f), { config: { cadenceJitterMs: 0 }, rand: () => 0 });
    engine.arm(Object.assign(META('CLAMP'), { closesAt: a.closesAt }), INPUTS);
    await sleep(150);
    const snap = engine.snapshot().find((m) => m.auctionId === 'CLAMP');
    check(snap && snap.revisionsLeft === 1, `clamp cap 1 stays 1, never 0 (got ${snap && snap.revisionsLeft})`);
    engine.stop('CLAMP'); cleanup(f);
  }

  // ==========================================================================================
  // 6. Restart safety for the detection. After a mid-auction restart ownBidAttempts is 0 even on
  //    a load this bot had already bid, so the bot's OWN standing rank would read as foreign.
  //    rehydrate() restores firedRungs from the durable intent before the first tick; the
  //    detection must consult that too, or every restart silently shrinks a legitimate budget.
  // ==========================================================================================
  //    Run as a PAIR on identical inputs, differing only in whether the durable intent records a
  //    rung this bot already fired - so the assertion is about the guard and not about the fixture.
  //    Rank is 1 throughout (we are holding L1), which keeps the rehydrated monitor from stepping
  //    down and spending a revision of its own; the budget then reflects the detection and nothing
  //    else. The load closes an hour out, the normal shape for a restart mid-auction.
  {
    const far = Date.now() + 3_600_000;
    // Arrange a persisted intent, optionally carrying a rung this bot fired before the "crash".
    const persist = (f, firedRungs) => {
      const a = adapter({ rank: () => 1 }); a.closesAt = far;
      const sch = new DurableScheduler(f);
      const eng = new BidEngine(a, sch, { config: { cadenceJitterMs: 0 } });
      eng.arm(Object.assign(META('REHY'), { closesAt: far }), INPUTS);
      eng.stop('REHY');
      sch.update('REHY', { status: 'bidding', firedRungs });
    };
    const restart = async (f) => {
      const a = adapter({ rank: () => 1 }); a.closesAt = far;
      const events = [];
      const eng = new BidEngine(a, new DurableScheduler(f), {
        config: { cadenceJitterMs: 0 }, onEvent: (e) => events.push(e) });
      await eng.rehydrate();
      await sleep(150);
      const snap = eng.snapshot().find((m) => m.auctionId === 'REHY') || null;
      eng.stop('REHY'); cleanup(f);
      return { events, snap, placed: a.placed };
    };

    // (a) the bot HAD bid before the restart -> its own standing rank must not read as foreign.
    const fA = tmp('REHY-own'); persist(fA, [0]);
    const own = await restart(fA);
    check(own.snap, 'restart precondition: the intent was rehydrated and re-armed');
    check(own.placed.length === 0, 'restart precondition: holding L1, so the restart spent no revision');
    check(alerts(own.events, 'foreign_bids_detected').length === 0,
      'restart our OWN pre-restart bid (durable firedRungs) is not re-detected as a foreign bid');
    check(own.snap && own.snap.revisionsLeft === CAP,
      `restart the rehydrated budget is not silently discounted (got ${own.snap && own.snap.revisionsLeft})`);

    // (b) the control: same load, same rank, but this bot had NOT bid -> the detection does fire,
    //     proving (a) is the firedRungs guard doing the work and not the scenario being inert.
    const fB = tmp('REHY-none'); persist(fB, []);
    const none = await restart(fB);
    check(alerts(none.events, 'foreign_bids_detected').length === 1,
      'restart control: with no durable fired rung, the same standing rank IS detected as foreign');
    check(none.snap && none.snap.revisionsLeft === CAP - 1,
      `restart control: and the low-cap budget is discounted (got ${none.snap && none.snap.revisionsLeft})`);
  }

  // ==========================================================================================
  // 7. OBSERVABILITY - the extension/budget context reaches the durable bid records, on BOTH the
  //    accepted and the rejected path, and lands in the bids jsonl (the un-backfillable stream).
  //    Driven end to end: engine events -> BidLogger -> store, so a break anywhere in the thread
  //    fails here rather than in a unit-level stub.
  // ==========================================================================================
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const a = adapter({ rejectAtCall: 2 });
    const f = tmp('OBS');
    a.closesAt = Date.now() + 5_000;
    const engine = new BidEngine(a, new DurableScheduler(f), {
      config: { openAtMs: 15_000, floorWindowMs: 2_500, cadenceJitterMs: 0 },
      onEvent: (e) => logger.handle(e),
      onSample: (s) => logger.sampleRank(s),
      rand: () => 0,
    });
    const meta = Object.assign(META('OBS'), { closesAt: a.closesAt });
    engine.arm(meta, INPUTS);
    await sleep(5_600);
    engine.stop('OBS');
    await logger.handle({ type: 'noop' }); // drain the serialized write tail
    cleanup(f);

    const events = await store.readEvents('bids');
    const placed = events.find((e) => e.kind === 'bid_placed' && e.auctionId === 'OBS');
    const rejected = events.find((e) => e.kind === 'bid_rejected' && e.auctionId === 'OBS');
    const sample = events.find((e) => e.kind === 'rank_sample' && e.auctionId === 'OBS');

    const KEYS = ['extendsObserved', 'believedCloseAt', 'closeModel', 'engineRevisionsLeft'];
    check(placed && KEYS.every((k) => k in placed),
      'observability bid_placed jsonl line carries all four context fields');
    check(rejected && KEYS.every((k) => k in rejected),
      'observability bid_rejected jsonl line carries all four context fields');
    check(placed && placed.closeModel === 'hard' && placed.extendsObserved === 0,
      'observability the accepted record stamps the live close model + extension count');
    check(placed && placed.believedCloseAt === meta.closesAt,
      'observability believedCloseAt is the absolute server-epoch close, not a countdown');

    // The headline: on a CAP rejection the record must report the belief that AUTHORISED the bid,
    // not the 0 the exhaustion handling then wrote. Reporting 0 would erase the disagreement
    // between our belief and SuperProcure's counter - which is the entire measurement.
    check(rejected && rejected.engineRevisionsLeft === 2,
      `observability the cap rejection records the FIRE-TIME belief (2), not the post-exhaustion 0 (got ${rejected && rejected.engineRevisionsLeft})`);
    check(rejected && rejected.reason === CAP_BODY && rejected.body === CAP_BODY,
      'observability the rejection still carries SuperProcure\'s verbatim plaintext reason + body');

    // The doc-level records the History panel reads.
    const rec = await store.getDoc('closedBids', 'OBS');
    check(rec && rec.ourBids[0] && KEYS.every((k) => k in rec.ourBids[0]),
      'observability the ourBids[] entry on the closedBids doc carries the context too');
    check(rec && Array.isArray(rec.rejectedBids) && rec.rejectedBids[0]
      && rec.rejectedBids[0].engineRevisionsLeft === 2,
      'observability the rejectedBids[] entry carries the fire-time belief');

    // The continuous per-tick trajectory a bid record is correlated against.
    check(sample && 'extendsObserved' in sample && 'closeModel' in sample && 'engineRevisionsLeft' in sample,
      'observability rank_sample carries the continuous extension/budget trajectory');
    check(sample && !('believedCloseAt' in sample),
      'observability rank_sample deliberately omits believedCloseAt (closesInMs is its derivative)');
  }

  // ==========================================================================================
  // 8. The extension counter actually MOVES onto a bid record. A soft-close monitor observing a
  //    forward close-time jump must stamp the incremented extendsObserved and the ADVANCED
  //    believedCloseAt on the bid it then places - a constant 0 would make the whole correlation
  //    vacuous, and that is the failure this asserts against.
  // ==========================================================================================
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const f = tmp('EXT');
    const closesAt = Date.now() + 5_000;
    const EXTEND_MS = 60_000;
    const extendedCloseAt = closesAt + EXTEND_MS;
    let ticks = 0;
    const a = {
      placed: [], calls: 0, closesAt,
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        ticks += 1;
        // From the second tick the close jumps forward by a full extend interval - the
        // authoritative, close-time-based extension signal _observeExtension counts.
        const end = ticks >= 2 ? extendedCloseAt : closesAt;
        // myRank is an EXPLICIT outranked 2, not a "don't care" null. This block needs the monitor to
        // place a SECOND bid after the extension is observed, and a discretionary soft defend now
        // requires a KNOWN rank (the blind-rank guard in _decide: SP's socket does not report our rank
        // until ~1.15s after we bid as the routed carrier, and spending a rung inside that blind window
        // - possibly while winning - is the defect that guard fixes). A null here would correctly HOLD
        // and this block would never get its post-extension bid. The rank value is incidental to what
        // is being asserted (that extendsObserved/believedCloseAt reach the bid record); being outranked
        // is simply the honest precondition for a defend. Note the placeBid response below still returns
        // myRank null, which is faithful to SP - the REST reply never carries a rank.
        return { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
          closesInMs: Math.max(0, end - Date.now()), revisionLimit: 10, revisionsLeft: null,
          closeModel: 'soft', extendMs: EXTEND_MS, extendCount: 5, closesAtMs: end, measuredRttMs: 50 };
      },
      async placeBid(id, price) { this.calls += 1; this.placed.push(price); return { accepted: true, myRank: null, latencyMs: 60 }; },
    };
    const engine = new BidEngine(a, new DurableScheduler(f), {
      // Soft-close endgame ON and this shipper opted in, in LIVE mode, so the monitor actually
      // counts extensions and actually places bids (shadow mode places none).
      softClose: { enabled: true, shippers: ['Tata'], mode: 'live', reserve: 1 },
      config: { cadenceJitterMs: 0, minInterFireMs: 0 },
      onEvent: (e) => logger.handle(e),
      rand: () => 0,
    });
    engine.arm(Object.assign(META('EXT'), { closesAt }), INPUTS);
    await sleep(1_200);
    engine.stop('EXT');
    await logger.handle({ type: 'noop' });
    cleanup(f);

    const events = await store.readEvents('bids');
    const bids = events.filter((e) => e.kind === 'bid_placed' && e.auctionId === 'EXT');
    const after = bids.find((e) => e.extendsObserved === 1);
    check(bids.length > 0, `extension precondition: the soft monitor placed bids (got ${bids.length})`);
    check(!!after, 'extension a bid placed after the observed extension records extendsObserved 1');
    check(after && after.believedCloseAt === extendedCloseAt,
      'extension the record carries the ADVANCED believed close, so the reset question is answerable');
    check(after && after.closeModel === 'soft', 'extension the record carries the soft close model');
  }

  // ==========================================================================================
  // 9. CLIENT-FACING SURFACE UNCHANGED. The two new alert kinds are internal-only: they belong in
  //    the durable logs and the dashboard event stream, NOT on the pricing desk's WhatsApp. Routing
  //    a new kind through the alert path without a dedicated template renders it as the generic
  //    fallback, which would land unannounced on the client. toNotification is the single gate, so
  //    asserting it returns null for both kinds pins the surface as byte-identical to what is
  //    deployed. The bid_placed additions are likewise invisible: bid_live reads named fields only.
  // ==========================================================================================
  {
    const capAlert = { type: 'alert', level: 'error', kind: 'bid_cap_exhausted', auctionId: 'W1',
      lane: { origin: 'Pune', destination: 'Bengaluru' }, companyName: 'Tata', reason: CAP_BODY };
    const fgnAlert = { type: 'alert', level: 'warn', kind: 'foreign_bids_detected', auctionId: 'W1',
      lane: { origin: 'Pune', destination: 'Bengaluru' }, companyName: 'Tata', myRank: 2 };
    check(toNotification(capAlert) === null, 'wa-surface bid_cap_exhausted produces NO WhatsApp notification');
    check(toNotification(fgnAlert) === null, 'wa-surface foreign_bids_detected produces NO WhatsApp notification');

    const base = { type: 'bid_placed', auctionId: 'W1', price: 20268, rungIndex: 0,
      lane: { origin: 'Pune', destination: 'Bengaluru' }, companyName: 'Tata', cost: COST, openingPct: 12.6 };
    const withCtx = Object.assign({}, base, { extendsObserved: 2, believedCloseAt: 123, closeModel: 'soft', engineRevisionsLeft: 1 });
    assert.deepStrictEqual(toNotification(withCtx), toNotification(base));
    ok('wa-surface the bid_placed context fields do not change the bid_live message by even one byte');
  }

  // ==========================================================================================
  // 10. RE-PRICE safety for the detection. Section 6 pins the RESTART path, where firedRungs is
  //     restored verbatim from the durable intent. A COST RE-PRICE is the other re-arm and it
  //     behaves in the opposite way: remapFiredRungs carries fired rungs forward BY PRICE, so a
  //     genuine cost change (every ladder price moves) legitimately carries NOTHING forward, and
  //     armFromRequest's restore no-ops because it guards on .length. The re-armed monitor is then
  //     byte-identical to a never-bid one - ownBidAttempts 0, firedRungs empty, currentRungIndex -1
  //     - while our own pre-re-price bid is still holding a standing rank. The detection would count
  //     OUR OWN spent bid as a foreign one, and on a cap-3 load that walks the budget to 0 and the
  //     FINAL FLOOR SNIPE NEVER FIRES. Not hypothetical: the desk re-priced a live load 75s before
  //     close on 2026-07-22. The durable `everBid` flag is what has to hold here.
  //
  //     Driven through the REAL production path (server.js reArmWithNewBand = engine.stop +
  //     armFromRequest) and with the engine placing its own first bid, so this is the operator
  //     action end to end rather than hand-set monitor fields.
  // ==========================================================================================
  {
    const NEW_COST = 16_500;                      // a real cost correction, not a margin nudge
    const NEW_LADDER = [18579, 17688, 16946];     // shares NO price with LADDER -> remap yields []
    const far = () => Date.now() + 3_600_000;
    // Only status/live + the pricing block matter to armFromRequest; shaped like a real request doc.
    const reqDoc = (id, cost, closesAt) => ({
      loadId: id, status: 'armed',
      load: { lane: { origin: 'Pune', destination: 'Bengaluru' }, equipment: '32ft', units: 1,
        companyName: 'Tata Consumer Product Ltd', status: 'live', closesAt, rules: null },
      price: { cost, marginsPct: MARGINS },
    });

    // rank: nothing standing until a bid exists on the account, then L1 - so the monitor holds and
    // the budget reflects the detection alone, exactly as section 6 does it.
    const repriceRun = async ({ id, bidFirst }) => {
      const f = tmp(id);
      const closesAt = far();
      const a = adapter({ rank: (placed) => ((bidFirst && placed > 0) || !bidFirst ? 1 : null) });
      a.closesAt = closesAt;
      const events = [];
      const engine = new BidEngine(a, new DurableScheduler(f), {
        // openAtMs past the close distance -> the establishing rung fires on the first tick.
        config: { cadenceJitterMs: 0, openAtMs: 7_200_000, minInterFireMs: 0 },
        onEvent: (e) => events.push(e), rand: () => 0,
      });

      if (bidFirst) {
        armFromRequest(engine, reqDoc(id, COST, closesAt));
        await sleep(200); // let the engine place its own establishing bid
      }
      const beforeIntent = engine.scheduler.get(id);
      const placedBefore = a.placed.slice();

      // --- the operator re-prices: exactly what reArmWithNewBand does ---
      engine.stop(id);
      const m2 = armFromRequest(engine, reqDoc(id, NEW_COST, closesAt));
      const afterIntent = engine.scheduler.get(id);
      const rearm = { firedRungs: m2.firedRungs.size, currentRungIndex: m2.currentRungIndex,
        ownBidAttempts: m2.ownBidAttempts, intentFired: (afterIntent.firedRungs || []).length };

      await sleep(200);
      const snap = engine.snapshot().find((m) => m.auctionId === id) || null;
      engine.stop(id); cleanup(f);
      return { events, snap, placedBefore, placed: a.placed, beforeIntent, rearm, ladder: m2.ladder };
    };

    // (a) the bot HAD bid before the re-price -> its own standing rank must not read as foreign.
    const rp = await repriceRun({ id: 'RP-own', bidFirst: true });
    check(rp.placedBefore.length === 1 && rp.placedBefore[0] === LADDER[0],
      `re-price precondition: the bot placed its establishing bid off the OLD ladder (got ${rp.placedBefore.join(', ') || 'none'})`);
    check(rp.beforeIntent && (rp.beforeIntent.firedRungs || []).join() === '0'
      && rp.beforeIntent.everBid === true,
      're-price precondition: the durable intent recorded the fired rung AND everBid');
    check(rp.ladder && rp.ladder.join() === NEW_LADDER.join(),
      `re-price precondition: the re-arm rebuilt a wholly different ladder (got ${rp.ladder && rp.ladder.join(', ')})`);
    // THE hole this section exists for: without everBid the re-armed monitor is indistinguishable
    // from a never-bid one. Pin all three zeroed fields, so a future change that happens to carry
    // one of them forward does not quietly turn this test into a tautology.
    check(rp.rearm.intentFired === 0 && rp.rearm.firedRungs === 0
      && rp.rearm.currentRungIndex === -1 && rp.rearm.ownBidAttempts === 0,
      `re-price precondition: the price-keyed remap carried NOTHING forward (${JSON.stringify(rp.rearm)})`);

    check(alerts(rp.events, 'foreign_bids_detected').length === 0,
      're-price our OWN pre-re-price bid is not re-detected as a foreign bid');
    // Budget arithmetic, spelled out because the exact number IS the revenue property here.
    // cap 3, minus the establishing bid before the re-price, minus the establishing bid the re-armed
    // monitor places off the NEW ladder = 1 revision still in hand, which is what funds the final
    // floor snipe. Run against the deployed v1.4.0 guard set this lands on 0 (the phantom foreign
    // bid takes the third slot), the stand-down guard then blocks every later rung, and the bot goes
    // dark at the buzzer. 1-vs-0 is the whole of it.
    check(rp.placed.length === 2 && rp.placed[1] === NEW_LADDER[0],
      `re-price the re-armed monitor re-established off the new ladder (got ${rp.placed.join(', ')})`);
    check(rp.snap && rp.snap.revisionsLeft === 1,
      `re-price ONE revision survives for the floor snipe, not zero (got ${rp.snap && rp.snap.revisionsLeft})`);
    check(rp.snap && rp.snap.revisionsLeft > 0 && rp.snap.capExhausted === false && rp.snap.stoodDown === false,
      're-price the monitor can still fund and fire the floor rung (not stood down, not cap-exhausted)');
    check(rp.snap && rp.snap.everBid === true,
      're-price the durable everBid survives the re-arm and is visible on the snapshot');
    check(rp.snap && rp.snap.foreignBidsDetected === false,
      're-price the detection latch was never set');

    // (b) the control: same load, same standing rank, but this bot had NOT bid before the re-price
    //     (a genuine human bid from the portal). The detection MUST still fire and still discount -
    //     proving (a) is the everBid guard doing the work and not the scenario being inert.
    const ctl = await repriceRun({ id: 'RP-none', bidFirst: false });
    check(alerts(ctl.events, 'foreign_bids_detected').length === 1,
      're-price control: with no prior bid of ours, the same standing rank IS detected as foreign');
    // cap 3, minus the detection's one-slot discount, minus this run's single establishing bid.
    // Same 1 as (a) by a different route - the point of the control is the detection FIRING, which
    // proves (a)'s silence is the everBid guard and not the fixture being inert.
    check(ctl.placed.length === 1,
      `re-price control: exactly one bid of ours reached the wire (got ${ctl.placed.length})`);
    check(ctl.snap && ctl.snap.revisionsLeft === 1,
      `re-price control: and the low-cap budget took the detection discount (got ${ctl.snap && ctl.snap.revisionsLeft})`);

    // (c) the compound case the durable flag exists for: re-price AND THEN a restart. everBid is
    //     persisted on the intent, so it survives rehydrate even though the re-price already
    //     erased firedRungs - the section-6 guard has nothing left to hold onto by this point.
    {
      const f = tmp('RP-restart');
      const closesAt = far();
      const a1 = adapter({ rank: (placed) => (placed > 0 ? 1 : null) });
      a1.closesAt = closesAt;
      const sch = new DurableScheduler(f);
      const e1 = new BidEngine(a1, sch, {
        config: { cadenceJitterMs: 0, openAtMs: 7_200_000, minInterFireMs: 0 }, rand: () => 0 });
      armFromRequest(e1, reqDoc('RP-restart', COST, closesAt));
      await sleep(200);
      e1.stop('RP-restart');
      armFromRequest(e1, reqDoc('RP-restart', NEW_COST, closesAt)); // re-price
      e1.stop('RP-restart');
      const persisted = sch.get('RP-restart');
      check((persisted.firedRungs || []).length === 0 && persisted.everBid === true,
        're-price+restart precondition: firedRungs was erased by the remap but everBid persisted');

      // the "crash": a brand-new engine reading the same intents file
      const a2 = adapter({ rank: () => 1 }); a2.closesAt = closesAt;
      const ev2 = [];
      const e2 = new BidEngine(a2, new DurableScheduler(f), {
        config: { cadenceJitterMs: 0, openAtMs: 7_200_000, minInterFireMs: 0 },
        onEvent: (e) => ev2.push(e), rand: () => 0 });
      await e2.rehydrate();
      await sleep(200);
      const snap2 = e2.snapshot().find((m) => m.auctionId === 'RP-restart') || null;
      e2.stop('RP-restart'); cleanup(f);
      check(snap2 && snap2.everBid === true, 're-price+restart everBid rehydrates onto the fresh monitor');
      check(alerts(ev2, 'foreign_bids_detected').length === 0,
        're-price+restart our own bid is STILL not counted as foreign after a restart on top of a re-price');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
