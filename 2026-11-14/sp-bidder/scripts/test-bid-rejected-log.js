'use strict';
/**
 * Regression: a FIRED-and-REJECTED bid (SuperProcure HTTP 400) must be durably
 * distinguishable on disk from a bid that NEVER FIRED. Before the fix, BidLogger's
 * switch had no `bid_rejected` case, so the event fell through `default: return` and
 * left NO trace - byte-identical to never-fired (ourBids:[], won:false, finalRank:null).
 *
 * The fix's `_onRejected` handler must:
 *   (a) ALWAYS append a `{ kind:'bid_rejected', ... }` line to the daily `bids` stream, and
 *   (b) record the rejection on the OPEN closedBids doc as a lazily-created `rejectedBids[]`
 *       (but NOT on a doc whose status is already 'closed', and NOT conjure a doc that was
 *        never armed).
 *
 * Offline, deterministic: memory store, synthetic events, fixed timestamps. Mirrors
 * test-bid-logger.js exactly (same store, same handle() feed style, same `ok` counter).
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Concrete, intentional fixtures (per orchestrator contract): carrier 2667, the real
// SuperProcure rejection text, and the Renewsys ladder whose top rung is 56300.
const BODY = 'Load is under approval for allotment. Bidding is not allowed.';
const CARRIER = 2667;
const PRICE = 56300;
const HTTP = 400;
const T0 = 1700000000000;

const fresh = () => {
  const store = createStore({ backend: 'memory' });
  return { store, logger: new BidLogger({ store }) };
};

const armEvt = (auctionId, t) => ({
  type: 'armed', auctionId, ts: t,
  lane: { origin: 'P', destination: 'Q' }, equipment: 'Open', units: 1,
  companyName: 'Renewsys', cost: 50000,
  marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  ladder: [56300, 53600, 53150], floor: 53150,
});

const rejectEvt = (auctionId, t) => ({
  type: 'bid_rejected', auctionId, price: PRICE, status: HTTP,
  body: BODY, carrierSent: CARRIER, reason: BODY, rungIndex: 0, ts: t,
});

(async () => {
  // =====================================================================
  // Behaviors 1, 2, 6 share ONE scenario: arm R1, then feed ONE bid_rejected.
  // Asserted from three independent angles (jsonl line / doc record / ourBids).
  // =====================================================================
  {
    // Arrange
    const { store, logger } = fresh();
    await logger.handle(armEvt('R1', T0));

    // Act (the one line under test)
    await logger.handle(rejectEvt('R1', T0 + 1000));

    // Assert - Behavior 1: rejected_appends_jsonl_line
    const events = await store.readEvents('bids');
    const rej = events.find((e) => e.kind === 'bid_rejected' && e.auctionId === 'R1');
    // catches: removed `case 'bid_rejected'` (falls to default:return -> no jsonl line at all)
    ok(!!rej, 'B1 bid_rejected line appended to bids stream for R1');
    // catches: httpStatus default-swap (evt.status dropped -> null); constant-replace 400->0
    ok(rej && rej.httpStatus === HTTP, 'B1 jsonl httpStatus === 400 (mapped from evt.status)');
    // catches: carrierSent field dropped / argument wired wrong
    ok(rej && rej.carrierSent === CARRIER, 'B1 jsonl carrierSent === 2667');
    // catches: body field dropped (rejection text is the whole point of the trace)
    ok(rej && rej.body === BODY, 'B1 jsonl body === the SuperProcure rejection text');
    // catches: price field dropped / wrong-field wiring
    ok(rej && rej.price === PRICE, 'B1 jsonl price === 56300');
    // catches: reason field dropped
    ok(rej && rej.reason === BODY, 'B1 jsonl reason carried through');

    // Assert - Behavior 2: rejected_recorded_on_doc
    const recR1 = await store.getDoc('closedBids', 'R1');
    // catches: doc-write removed (only jsonl written) -> rejectedBids never created
    ok(recR1 && Array.isArray(recR1.rejectedBids) && recR1.rejectedBids.length === 1,
      'B2 R1 doc has exactly one rejectedBids entry');
    const dr = recR1 && recR1.rejectedBids && recR1.rejectedBids[0];
    // catches: httpStatus mapping/default-swap on the DOC record (evt.status ?? evt.httpStatus ?? null)
    ok(dr && dr.httpStatus === HTTP, 'B2 doc rejection httpStatus === 400');
    // catches: carrierSent not persisted on the doc record
    ok(dr && dr.carrierSent === CARRIER, 'B2 doc rejection carrierSent === 2667');
    // catches: body not persisted on the doc record
    ok(dr && dr.body === BODY, 'B2 doc rejection body === the rejection text');
    // catches: price not persisted on the doc record / constant-replace
    ok(dr && dr.price === PRICE, 'B2 doc rejection price === 56300');

    // Assert - Behavior 6: ourBids_untouched (a rejection is NOT a placed bid)
    // catches: _onRejected mistakenly pushing into ourBids (rejection polluting placed-bid list)
    ok(recR1 && Array.isArray(recR1.ourBids) && recR1.ourBids.length === 0,
      'B6 R1 ourBids stays [] after a rejection');
  }

  // =====================================================================
  // Behavior 3: distinguishable_from_never_fired (the headline).
  // R2 armed but NEVER rejected; R1 armed + rejected. The two docs must differ.
  // =====================================================================
  {
    // Arrange + Act
    const { store, logger } = fresh();
    await logger.handle(armEvt('R2', T0));            // armed, never fires
    await logger.handle(armEvt('R1', T0));
    await logger.handle(rejectEvt('R1', T0 + 1000));  // fired -> rejected

    // Assert
    const recR2 = await store.getDoc('closedBids', 'R2');
    const recR1 = await store.getDoc('closedBids', 'R1');
    // catches: doc-write removed -> R1 would also lack rejectedBids, collapsing the distinction
    ok(recR2 && recR2.rejectedBids === undefined, 'B3 never-fired R2 has NO rejectedBids (byte-identical to legacy)');
    ok(recR1 && Array.isArray(recR1.rejectedBids) && recR1.rejectedBids.length === 1,
      'B3 fired-and-rejected R1 HAS a rejectedBids entry');
    // catches: any mutant that makes rejected look identical to never-fired (case removal OR doc-write removal)
    ok(JSON.stringify(recR2.rejectedBids) !== JSON.stringify(recR1.rejectedBids),
      'B3 the two records are NOT identical on rejectedBids (distinguishable)');
  }

  // =====================================================================
  // Behavior 4: jsonl_trace_without_armed_record. R3 was never armed.
  // The reject must NOT throw, must still write the jsonl trace, must NOT conjure a doc.
  // =====================================================================
  {
    // Arrange
    const { store, logger } = fresh();

    // Act (guarded so we can assert "does not throw" as observable behavior)
    let threw = false;
    try { await logger.handle(rejectEvt('R3', T0 + 1000)); } catch (e) { threw = true; }

    // Assert
    // catches: unguarded rec.status access when getDoc returns null -> TypeError
    ok(!threw, 'B4 bid_rejected for an un-armed auction does not throw');
    const events = await store.readEvents('bids');
    const rej = events.find((e) => e.kind === 'bid_rejected' && e.auctionId === 'R3');
    // catches: jsonl-append moved inside the "doc exists" branch (trace lost when never armed)
    ok(!!rej && rej.httpStatus === HTTP, 'B4 jsonl bid_rejected trace still written for un-armed R3');
    const recR3 = await store.getDoc('closedBids', 'R3');
    // catches: a mutant that putDoc's an empty/new doc for an auction that was never armed
    ok(recR3 === null, 'B4 no closedBids doc conjured for un-armed R3');
  }

  // =====================================================================
  // Behavior 5: rejection_after_close_not_reopened. Mirrors how _onBid ignores
  // post-close bids: guard is `rec.status !== 'closed'`.
  // =====================================================================
  {
    // Arrange: arm R4, then close it via auction_result.
    const { store, logger } = fresh();
    await logger.handle(armEvt('R4', T0));
    await logger.handle({ type: 'auction_result', auctionId: 'R4', ts: T0 + 2000, won: false, finalRank: 3, closeModel: 'hard' });

    // Act: a late rejection arrives after the doc is already closed.
    await logger.handle(rejectEvt('R4', T0 + 3000));

    // Assert
    const recR4 = await store.getDoc('closedBids', 'R4');
    // catches: guard sign-flip / negation-drop that resurrects a closed doc's status
    ok(recR4 && recR4.status === 'closed', 'B5 closed R4 doc stays closed');
    // catches: guard flip `status !== closed` -> `=== closed` (or guard removed) writing onto a closed doc
    ok(recR4 && recR4.rejectedBids === undefined, 'B5 post-close rejection NOT recorded on the closed doc');
    const events = await store.readEvents('bids');
    const rej = events.find((e) => e.kind === 'bid_rejected' && e.auctionId === 'R4');
    // catches: jsonl-append gated behind the same closed-guard (trace must persist regardless)
    ok(!!rej && rej.httpStatus === HTTP, 'B5 jsonl bid_rejected line still written for post-close R4');
  }

  // =====================================================================
  // Behavior 7: rearm_preserves_rejections. A restart re-enters arm() for every
  // still-live auction (bidEngine rehydrate -> arm -> emit 'armed'), which rebuilds the
  // OPEN doc. That rebuild must NOT wipe a rejectedBids[] already recorded on it, or a
  // deploy mid-auction erases the doc-level rejection trace this whole fix exists to keep.
  // =====================================================================
  {
    // Arrange: arm R5, record a rejection on it.
    const { store, logger } = fresh();
    await logger.handle(armEvt('R5', T0));
    await logger.handle(rejectEvt('R5', T0 + 1000));

    // Act: the auction is still live, so a restart re-arms it (a second 'armed').
    await logger.handle(armEvt('R5', T0 + 2000));

    // Assert
    const recR5 = await store.getDoc('closedBids', 'R5');
    // catches: _onArmed rebuild dropping rejectedBids -> re-arm wipes the doc-level trace
    ok(recR5 && Array.isArray(recR5.rejectedBids) && recR5.rejectedBids.length === 1,
      'B7 re-arm after a rejection preserves the rejectedBids entry');
    const dr = recR5 && recR5.rejectedBids && recR5.rejectedBids[0];
    // catches: a carry-forward that keeps the array but loses its contents
    ok(dr && dr.body === BODY && dr.httpStatus === HTTP,
      'B7 the carried-forward rejection keeps its body + httpStatus');
    // catches: re-arm resetting the still-open doc's status
    ok(recR5 && recR5.status === 'open', 'B7 re-armed R5 doc is still open');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
