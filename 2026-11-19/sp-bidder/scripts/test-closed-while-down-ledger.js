'use strict';
/**
 * The unknown-close flag has to reach the CLOSED-BIDS LEDGER, not just the scheduler's intents file.
 *
 * THE DEFECT. The restart sweep wrote closedWhileDown onto the durable intent only. No reporting
 * surface reads that file - every one of them joins against the closedBids record, which kept its
 * pre-restart shape: landed bids, no final rank, no won. That shape is byte-identical to a fought
 * loss, so 52 GoComet orphans sat in the loss column with the flag that would have explained them
 * sitting in a file nothing queried.
 *
 * scripts/test-closed-unknown-surfacing.js pins what the CLASSIFIERS do with a record in the unknown
 * shape. It hand-builds that record, so it stays green whether or not anything ever produces one.
 * This file pins the producer: bidLogger, driven through its own dispatch, must write that shape.
 *
 *   A. a closed_while_down event stamps the ledger record: closedWhileDown true, won null, finalRank
 *      null, and closedAt = THE AUCTION'S close, not the instant we swept it.
 *   B. a later auction_result CLEARS the flag, because an authoritative result outranks a sweep.
 *   C. the neighbours: no record -> no skeleton invented; a record that already settled for real is
 *      not re-opened and stamped with doubt.
 *   D. a RE-PRICE after the retirement rebuilds the record and its fresh bids land. The retirement
 *      alert tells the desk to go check the portal, so this is the expected next step - and closing
 *      the record made _onArmed/_onBid drop the whole re-armed ladder in silence.
 *
 *   node scripts/test-closed-while-down-ledger.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The two instants that must not be confused. CLOSED_AT is when the auction ended; SWEPT_AT is when
// the process came back and noticed. They are two hours apart precisely so a fallback to the wrong
// one is visible as a value rather than as a coin flip.
const CLOSED_AT = Date.UTC(2026, 8, 1, 12, 0, 0);
const SWEPT_AT = CLOSED_AT + 7_200_000;

const armed = (id) => ({
  type: 'armed', auctionId: id, ts: CLOSED_AT - 3_600_000,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Waaree Energies', platformKey: 'gocomet',
  cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  ladder: [56_300, 53_600, 53_150], floor: 53_150,
});

/** The event the engine's _persistClosedWhileDown actually emits - same field names, same nulls. */
const sweep = (id, over = {}) => Object.assign({
  type: 'closed_while_down', auctionId: id, won: null, finalRank: null,
  closesAt: CLOSED_AT, ts: SWEPT_AT,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, companyName: 'Waaree Energies', branchName: null,
}, over);

(async () => {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store });

  // ---- A. the sweep stamps the ledger -----------------------------------------------------------

  await logger.handle(armed('GC-1'));
  await logger.handle({ type: 'bid_placed', auctionId: 'GC-1', ts: CLOSED_AT - 60_000, price: 56_300, rungIndex: 0, rank: null });
  let rec = await store.getDoc('closedBids', 'GC-1');
  ok(rec && rec.status === 'open' && rec.ourBids.length === 1,
    'A: the orphan starts as the box\'s real shape - armed, one landed bid, nothing settled');

  await logger.handle(sweep('GC-1'));
  rec = await store.getDoc('closedBids', 'GC-1');
  ok(rec.status === 'closed',
    `A: the sweep closes the LEDGER record, not only the intent (got '${rec.status}')`);
  ok(rec.closedWhileDown === true,
    'A: ...stamped closedWhileDown on the document every reporting surface joins against');
  ok(rec.won === null,
    `A: won stays null - written through, never coerced, because false would assert a loss (got ${JSON.stringify(rec.won)})`);
  ok(rec.finalRank === null, 'A: and no final rank is invented');
  ok(rec.closedAt === CLOSED_AT,
    `A: closedAt is the AUCTION'S close (${CLOSED_AT}), not the sweep instant (${SWEPT_AT}) - downstream that field IS auctionCloseAt, so the restart time would drop the load out of a filter for the week it ran (got ${rec.closedAt})`);
  ok(rec.ourBids.length === 1 && rec.lastBidPrice === 56_300,
    'A: the landed bid is untouched - the sweep records doubt, it does not erase evidence');

  const stream = await store.readEvents('bids');
  ok(stream.some((e) => e.kind === 'closed_while_down' && e.auctionId === 'GC-1'),
    'A: the audit stream carries the retirement');
  ok(!stream.some((e) => e.kind === 'auction_result' && e.auctionId === 'GC-1'),
    'A: and NOT as an auction_result - that type coerces won to a boolean and routes a won/lost receipt to WhatsApp, so replaying orphans through it would tell the desk it lost them');

  // The retirement instant is the last resort, not the rule - it applies only where the close was
  // never known at all. Pinned so the fallback order cannot be quietly reversed.
  await logger.handle(armed('GC-2'));
  await logger.handle({ type: 'bid_placed', auctionId: 'GC-2', ts: CLOSED_AT - 60_000, price: 56_300, rungIndex: 0, rank: null });
  await logger.handle(sweep('GC-2', { closesAt: null }));
  rec = await store.getDoc('closedBids', 'GC-2');
  ok(rec.closedAt === SWEPT_AT,
    `A: a load whose close was NEVER known falls back to the retirement instant (got ${rec.closedAt})`);

  // ---- B. an authoritative result clears the flag ------------------------------------------------

  // Reachable in the direction that matters: the unreadable retire fires on a load we cannot see,
  // which may still have been running. Re-priced, it gets a fresh monitor and genuinely finalizes.
  // Without the clear, a real fought loss keeps reading as unknown - _finalize writes a null rank
  // whenever the last read fails, so flag + null rank would classify it out of the win denominator.
  await logger.handle({ type: 'auction_result', auctionId: 'GC-1', ts: SWEPT_AT + 60_000, won: false, finalRank: 4, closeModel: 'soft' });
  rec = await store.getDoc('closedBids', 'GC-1');
  ok(rec.closedWhileDown === false,
    `B: a real result CLEARS the flag - not merely leaves it unset (got ${JSON.stringify(rec.closedWhileDown)})`);
  ok(rec.won === false && rec.finalRank === 4, 'B: and the record carries the outcome it was finally given');

  // A win clears it too - the clear must not be a loss-only path.
  await logger.handle(armed('GC-3'));
  await logger.handle({ type: 'bid_placed', auctionId: 'GC-3', ts: CLOSED_AT - 60_000, price: 56_300, rungIndex: 0, rank: null });
  await logger.handle(sweep('GC-3'));
  ok((await store.getDoc('closedBids', 'GC-3')).closedWhileDown === true, 'B: (GC-3 is retired first)');
  await logger.handle({ type: 'auction_result', auctionId: 'GC-3', ts: SWEPT_AT + 60_000, won: true, finalRank: 1, closeModel: 'soft' });
  rec = await store.getDoc('closedBids', 'GC-3');
  ok(rec.closedWhileDown === false && rec.won === true && rec.finalRank === 1,
    'B: a real WIN clears it as well - the clear is on the result, not on the verdict');

  // ---- C. the neighbours ---------------------------------------------------------------------------

  await logger.handle(sweep('GC-NEVER-ARMED'));
  ok((await store.getDoc('closedBids', 'GC-NEVER-ARMED')) == null,
    'C: a sweep for a load that was never logged invents no skeleton row - there is nothing on any surface to correct');

  // A record that settled for real BEFORE the sweep reached it keeps its truth. A late sweep must
  // never re-open a closed record to stamp doubt on an outcome we actually saw.
  await logger.handle(armed('GC-4'));
  await logger.handle({ type: 'bid_placed', auctionId: 'GC-4', ts: CLOSED_AT - 60_000, price: 56_300, rungIndex: 0, rank: null });
  await logger.handle({ type: 'auction_result', auctionId: 'GC-4', ts: CLOSED_AT, won: true, finalRank: 1, closeModel: 'soft' });
  await logger.handle(sweep('GC-4'));
  rec = await store.getDoc('closedBids', 'GC-4');
  ok(rec.won === true && rec.finalRank === 1 && rec.closedWhileDown === false,
    'C: a load that already settled for real is left exactly as it is by a late sweep');

  // ---- D. a re-price after the retirement is authoritative over the doubt-stamp -----------------

  // The load the sweep gave up on may still be running - that is why the alert says "check the
  // portal". The desk re-prices it, which is stop() + a fresh monitor emitting 'armed' then
  // 'bid_placed'. Every one of those bids used to be discarded: the record was closed, so _onArmed
  // returned before rebuilding it and _onBid returned before appending. The auction could then be
  // won at a price no reporting surface has, with Realized Margin % computed off the stale bid.
  await logger.handle(armed('GC-5'));
  await logger.handle({ type: 'bid_placed', auctionId: 'GC-5', ts: CLOSED_AT - 60_000, price: 56_300, rungIndex: 0, rank: null });
  await logger.handle(sweep('GC-5'));
  ok((await store.getDoc('closedBids', 'GC-5')).status === 'closed', 'D: (GC-5 is retired first)');

  await logger.handle(Object.assign(armed('GC-5'), { ts: SWEPT_AT + 60_000, cost: 47_000, ladder: [52_000, 49_900, 49_350], floor: 49_350 }));
  rec = await store.getDoc('closedBids', 'GC-5');
  ok(rec.status === 'open',
    `D: the re-arm REOPENS the record - an unknown close is provisional, a real result is not (got '${rec.status}')`);
  ok(rec.closedWhileDown !== true,
    'D: ...and the doubt-stamp is gone, so the load stops reading as unknown while it is being bid again');
  ok(rec.closedAt === null, 'D: ...and it carries no close time, because it has not closed');
  ok(rec.ourBids.length === 1 && rec.cost === 47_000 && rec.floor === 49_350,
    'D: the earlier bid is carried forward while the re-priced cost and ladder replace the stale ones');

  await logger.handle({ type: 'bid_placed', auctionId: 'GC-5', ts: SWEPT_AT + 120_000, price: 52_000, rungIndex: 0, rank: 2 });
  rec = await store.getDoc('closedBids', 'GC-5');
  ok(rec.ourBids.length === 2 && rec.lastBidPrice === 52_000,
    `D: the re-priced ladder's bids LAND - this is the money data the silent drop lost (got ${rec.ourBids.length} bid(s), last ${rec.lastBidPrice})`);

  // The other half of the rule: a record closed by a real RESULT is still never reopened. Without
  // this, "reopen on re-arm" would erase settled outcomes instead of only provisional ones.
  await logger.handle(armed('GC-4'));
  rec = await store.getDoc('closedBids', 'GC-4');
  ok(rec.status === 'closed' && rec.won === true && rec.finalRank === 1,
    'D: a record carrying a real result is NOT reopened by a later armed event');

  const EXPECTED_CHECKS = 23;
  assert.strictEqual(fail, 0, `${fail} closed-while-down ledger checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
