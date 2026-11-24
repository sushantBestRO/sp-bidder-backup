'use strict';
/**
 * A RE-PRICE MUST NOT LEAVE A CLOSED-BID RECORD THAT CONTRADICTS ITSELF (CW-211).
 *
 * _onArmed rebuilds the whole doc and putDoc is a full replace, so a re-price replaced cost, floor
 * and ladder with the new epoch's while ourBids - placed against the OLD ladder - carried forward.
 * The production record for 260908LD2Z reads, verbatim:
 *
 *   {"auctionId":"260908LD2Z","cost":38000,"floor":38684,"ladder":[41420,40736,38684],
 *    "ourBids":[{"price":31610,"rungIndex":0}],"lastBidPrice":31610,"finalRank":1,"won":true}
 *
 * A winning bid of 31,610 in a row whose own lowest rung is 38,684 - the bid is not on the ladder
 * at all. It is structural, not a loss-case artefact: 260908A2W4 shows cost 90,000 with a first
 * bid of 130,800. Recovering the pre-revision cost then needs dividing a bid by a ladder
 * multiplier, which is what the 2026-09-08 forensic reconstruction actually had to do.
 *
 * The superseded epoch is now kept beside the current one, with the running bid count that joins
 * ourBids to it. Two halves are asserted just as hard. A margin-only re-price - "Revert to standard
 * margins", which rebuilds the ladder at an UNCHANGED cost - produces the same contradictory row, so
 * the trigger is the priced plan changing rather than the cost; a cost-only guard leaves that case
 * broken AND makes an absent field read as "never re-priced", which is a false claim rather than a
 * silent one. And byte-compat: a restart re-arm and a never-re-priced load must record nothing, or
 * 3,136 existing rows all grow a field for no reason.
 *
 *   node scripts/test-closed-bid-cost-history.js
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

// Every assertion below must run - the runner grades on exit status alone.
const EXPECTED_CHECKS = 21;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store });
  const ts = Date.now();

  // ---- the LD2Z sequence: capture at 29,000, one bid, re-price to 38,000 ----
  await logger.handle({ type: 'armed', auctionId: 'LD2Z', ts, companyName: 'Waaree', units: 1,
    cost: 29000, marginsPct: [9, 5, 1], minMarginPct: 1, ladder: [31610, 30450, 29290], floor: 29290 });
  await logger.handle({ type: 'bid_placed', auctionId: 'LD2Z', ts: ts + 1000, price: 31610, rungIndex: 0 });
  await logger.handle({ type: 'armed', auctionId: 'LD2Z', ts: ts + 117_000, companyName: 'Waaree', units: 1,
    cost: 38000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8, ladder: [41420, 40736, 38684], floor: 38684 });

  let rec = await store.getDoc('closedBids', 'LD2Z');
  ok(rec.cost === 38000 && rec.floor === 38684, 'the current epoch is the corrected Rs 38,000 - the live numbers are unchanged');
  ok(rec.ourBids.length === 1 && rec.ourBids[0].price === 31610, 'the bid placed under the old ladder is still on the record');
  ok(Array.isArray(rec.costHistory) && rec.costHistory.length === 1, 'the superseded pricing epoch is retained');

  const epoch = (rec.costHistory && rec.costHistory[0]) || {};
  ok(epoch.cost === 29000, 'the prior cost is recorded as a value, not recoverable only by division');
  ok(Array.isArray(epoch.ladder) && epoch.ladder.includes(31610),
    'and the ladder it built - so the 31,610 bid sits on a ladder the record actually holds');
  ok(epoch.floor === 29290 && epoch.minMarginPct === 1, 'the prior floor and band ride with it');
  ok(epoch.ourBidsBefore === 1, 'ourBidsBefore joins ourBids[0] to the epoch it was priced under');
  ok(epoch.supersededAt === ts + 117_000, 'and the epoch records when it was replaced');

  // ---- a restart re-arm re-emits the SAME plan and must record nothing ----
  await logger.handle({ type: 'armed', auctionId: 'LD2Z', ts: ts + 200_000, companyName: 'Waaree', units: 1,
    cost: 38000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8, ladder: [41420, 40736, 38684], floor: 38684 });
  rec = await store.getDoc('closedBids', 'LD2Z');
  ok(rec.costHistory && rec.costHistory.length === 1, 'a restart re-arm at the identical plan adds no epoch');

  // ---- a load that is never re-priced stays byte-identical to today ----
  await logger.handle({ type: 'armed', auctionId: 'PLAIN', ts, companyName: 'Havells', units: 1,
    cost: 80000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [90080, 85760, 85040], floor: 85040 });
  await logger.handle({ type: 'bid_placed', auctionId: 'PLAIN', ts: ts + 500, price: 90080, rungIndex: 0 });
  const plain = await store.getDoc('closedBids', 'PLAIN');
  ok(!('costHistory' in plain), 'a never-re-priced load carries no costHistory key at all - not an empty array');

  // ---- a historical row (3,136 of them) re-armed unchanged gains nothing ----
  await store.putDoc('closedBids', 'OLD', {
    auctionId: 'OLD', cost: 50000, floor: 52500, ladder: [56000, 54000, 52500],
    ourBids: [{ price: 56000, rungIndex: 0, ts }], lastBidPrice: 56000, status: 'open', armedAt: ts,
  });
  await logger.handle({ type: 'armed', auctionId: 'OLD', ts: ts + 1000, cost: 50000,
    marginsPct: [12, 8, 5], minMarginPct: 5, ladder: [56000, 54000, 52500], floor: 52500 });
  const old = await store.getDoc('closedBids', 'OLD');
  ok(!('costHistory' in old), 'a pre-existing row re-armed at its own cost is left without the field');

  // ---- epochs accumulate in order across successive re-prices ----
  await logger.handle({ type: 'armed', auctionId: 'OLD', ts: ts + 2000, cost: 65000,
    marginsPct: [12, 8, 5], minMarginPct: 5, ladder: [72800, 70200, 68250], floor: 68250 });
  await logger.handle({ type: 'armed', auctionId: 'OLD', ts: ts + 3000, cost: 45000,
    marginsPct: [12, 8, 5], minMarginPct: 5, ladder: [50400, 48600, 47250], floor: 47250 });
  const multi = await store.getDoc('closedBids', 'OLD');
  ok(multi.costHistory && multi.costHistory.map((h) => h.cost).join(',') === '50000,65000',
    'three costs in one auction leave both superseded ones, oldest first');
  ok(multi.cost === 45000, 'and the current cost is the latest one');

  // ---- A MARGIN-ONLY RE-PRICE IS THE SAME DEFECT. "Revert to standard margins" (clearBidOverride)
  // and a margin-only override both rebuild the ladder at an UNCHANGED cost, so a cost-only trigger
  // left them producing exactly the contradictory row this file exists to pin - and with the field
  // absent, which reads as "never re-priced". This is the case a cost-only guard cannot see.
  await logger.handle({ type: 'armed', auctionId: 'REVERT', ts, companyName: 'Waaree', units: 1,
    cost: 29000, marginsPct: [5, 3, 1], minMarginPct: 1, ladder: [30450, 29870, 29290], floor: 29290 });
  await logger.handle({ type: 'bid_placed', auctionId: 'REVERT', ts: ts + 1000, price: 29290, rungIndex: 2 });
  await logger.handle({ type: 'armed', auctionId: 'REVERT', ts: ts + 60_000, companyName: 'Waaree', units: 1,
    cost: 29000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [32654, 31088, 30827], floor: 30827 });
  const rev = await store.getDoc('closedBids', 'REVERT');
  const revEpoch = (rev.costHistory && rev.costHistory[0]) || {};
  ok(Array.isArray(rev.costHistory) && rev.costHistory.length === 1,
    'a revert to standard margins at an unchanged cost still retains its epoch');
  ok(Array.isArray(revEpoch.ladder) && revEpoch.ladder.includes(29290) && revEpoch.floor === 29290,
    'and the epoch holds the ladder the 29,290 bid was actually placed on');
  ok(rev.cost === 29000 && revEpoch.cost === 29000,
    'both plans share one cost - the epoch is the band change, not a cost change');

  // ---- the join is CUMULATIVE, and the record must let a reader prove it ----
  await logger.handle({ type: 'armed', auctionId: 'JOIN', ts, cost: 10000,
    marginsPct: [10], minMarginPct: 10, ladder: [11000], floor: 11000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'JOIN', ts: ts + 100, price: 11000, rungIndex: 0 });
  await logger.handle({ type: 'armed', auctionId: 'JOIN', ts: ts + 200, cost: 20000,
    marginsPct: [10, 5], minMarginPct: 5, ladder: [22000, 21000], floor: 21000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'JOIN', ts: ts + 300, price: 22000, rungIndex: 0 });
  await logger.handle({ type: 'bid_placed', auctionId: 'JOIN', ts: ts + 400, price: 21000, rungIndex: 1 });
  await logger.handle({ type: 'armed', auctionId: 'JOIN', ts: ts + 500, cost: 30000,
    marginsPct: [10], minMarginPct: 10, ladder: [33000], floor: 33000 });
  const j = await store.getDoc('closedBids', 'JOIN');
  const jh = Array.isArray(j.costHistory) ? j.costHistory : [];
  ok(jh.map((h) => h.ourBidsBefore).join(',') === '1,3',
    'ourBidsBefore is the running total at each supersession, not a per-epoch count');
  // The documented rule, executed: epoch i owns ourBids[prev.ourBidsBefore .. this.ourBidsBefore-1].
  const owned = (i) => (jh[i] ? j.ourBids : [])
    .slice(i === 0 ? 0 : jh[i - 1].ourBidsBefore, jh[i] && jh[i].ourBidsBefore)
    .map((b) => b.price);
  ok(owned(0).join(',') === '11000', 'the documented range attributes 11,000 to the Rs 10,000 plan');
  ok(owned(1).join(',') === '22000,21000', 'and 22,000 + 21,000 to the Rs 20,000 plan, not to the first one');
  ok(jh.length > 0 && j.ourBids.slice(jh[jh.length - 1].ourBidsBefore).length === 0,
    'no bid has yet been placed under the current Rs 30,000 plan');

  // ---- the finalized record keeps the history ----
  await logger.handle({ type: 'auction_result', auctionId: 'LD2Z', ts: ts + 300_000, finalRank: 1 });
  const closed = await store.getDoc('closedBids', 'LD2Z');
  ok(closed.status === 'closed' && Array.isArray(closed.costHistory) && closed.costHistory.length === 1,
    'the history survives finalization - the record is readable after the auction, which is when it is read');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`  FAIL - ran ${pass + fail} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
