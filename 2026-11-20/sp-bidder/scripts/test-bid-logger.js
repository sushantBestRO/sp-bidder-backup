'use strict';
/**
 * BidLogger test (deterministic, offline): feeds synthetic engine events and asserts
 * the Phase-5 BASE log - the closedBids collection (our bids + outcome), the
 * append-daily `bids` stream, and the win/loss summary. Uses the memory store.
 * Confirms base scope: OUR bids only, no competitor ladder.
 */
const { createStore } = require('../src/store');
const { BidLogger, summarizeClosed } = require('../src/logging/bidLogger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store });
  const ts = Date.now();

  // armed -> an open record with the load meta + pricing
  await logger.handle({ type: 'armed', auctionId: 'A1', ts, lane: { origin: 'X', destination: 'Y' }, equipment: 'Trailer', units: 1, companyName: 'Syngenta', cost: 80000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [90080, 85760, 85040], floor: 85040 });
  let rec = await store.getDoc('closedBids', 'A1');
  ok(rec && rec.status === 'open', 'armed -> open closedBids record');
  ok(rec.shipper === 'Syngenta' && rec.cost === 80000, 'armed -> meta captured (shipper, cost)');
  ok(Array.isArray(rec.ourBids) && rec.ourBids.length === 0, 'armed -> empty ourBids');

  // two real placed bids accumulate (every logged bid is real - no dry-run)
  await logger.handle({ type: 'bid_placed', auctionId: 'A1', ts: ts + 1000, price: 90080, rungIndex: 0, rank: 2, latencyMs: 210 });
  await logger.handle({ type: 'bid_placed', auctionId: 'A1', ts: ts + 2000, price: 85040, rungIndex: 2, rank: 1 });
  rec = await store.getDoc('closedBids', 'A1');
  ok(rec.ourBids.length === 2, 'two bids accumulated');
  ok(rec.lastBidPrice === 85040, 'lastBidPrice tracks the latest bid');
  ok(rec.ourBids[0].latencyMs === 210, 'latency captured on a placed bid');

  // result -> closed/won
  await logger.handle({ type: 'auction_result', auctionId: 'A1', ts: ts + 3000, won: true, finalRank: 1, closeModel: 'hard' });
  rec = await store.getDoc('closedBids', 'A1');
  ok(rec.status === 'closed' && rec.won === true && rec.finalRank === 1, 'auction_result -> closed/won/rank');
  ok(rec.closeModel === 'hard', 'closeModel captured on close');

  // a bid after close is ignored (no resurrection of a finalized record)
  await logger.handle({ type: 'bid_placed', auctionId: 'A1', ts: ts + 4000, price: 1, rungIndex: 0, rank: 9 });
  rec = await store.getDoc('closedBids', 'A1');
  ok(rec.ourBids.length === 2 && rec.status === 'closed', 'post-close bid ignored');

  // a second auction, NO-BID - armed and closed, but the engine never placed a bid (ourBids stays
  // empty). It is deliberately NOT a loss: we never entered the auction. The routeHistory block
  // further down also relies on A2 having no placed bid, so do not give it one.
  await logger.handle({ type: 'armed', auctionId: 'A2', ts, lane: { origin: 'P', destination: 'Q' }, equipment: 'Open', units: 1, companyName: 'Renewsys', cost: 50000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [56300, 53600, 53150], floor: 53150 });
  await logger.handle({ type: 'auction_result', auctionId: 'A2', ts: ts + 3000, won: false, finalRank: 3, closeModel: 'hard' });

  // a third auction, genuinely LOST - we bid and were beaten. Its own lane (G->H), so it stays out
  // of the routeHistory fixtures below. Keeping a real loss and a real no-bid apart is the whole
  // point: conflating them is the defect summarizeClosed was fixed for.
  await logger.handle({ type: 'armed', auctionId: 'A4', ts, lane: { origin: 'G', destination: 'H' }, equipment: 'Open', units: 1, companyName: 'Renewsys', cost: 40000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [45040, 43000, 42520], floor: 42520 });
  await logger.handle({ type: 'bid_placed', auctionId: 'A4', ts: ts + 1000, price: 45040, rungIndex: 0, rank: 4 });
  await logger.handle({ type: 'auction_result', auctionId: 'A4', ts: ts + 3000, won: false, finalRank: 4, closeModel: 'hard' });

  // listClosed + summary
  const list = await logger.listClosed();
  ok(list.length === 3, `listClosed returns 3 closed (got ${list.length})`);
  ok(list.every((r) => r.status === 'closed'), 'listClosed only closed');
  const sum = summarizeClosed(list);
  ok(sum.total === 3, `summarizeClosed counts every closed auction (got ${sum.total})`);
  ok(sum.won === 1 && sum.lost === 1 && sum.noBid === 1, `summarizeClosed splits won/lost/no-bid (got ${sum.won}/${sum.lost}/${sum.noBid})`);
  // The regression this pins: with no-bid folded into lost the rate was 1/3 = 33%. It is 1/2 = 50%
  // over DECIDED auctions, because A2 was never contested and cannot count as a loss.
  ok(sum.winRate === 50, `winRate is over decided auctions only (got ${sum.winRate})`);

  // the our-side audit stream is appended (no competitor ladder fields)
  const events = await store.readEvents('bids');
  ok(events.length >= 3, `bids stream has events (got ${events.length})`);
  ok(
    events.some((e) => e.kind === 'bid_placed') && events.some((e) => e.kind === 'auction_result'),
    'bids stream carries placed + result kinds',
  );
  ok(!events.some((e) => e.kind === 'would_bid'), 'bids stream carries NO would_bid (dry-run removed)');
  ok(!events.some((e) => 'bids' in e || 'ladderFrame' in e || 'competitors' in e), 'base stream carries NO competitor ladder (that is +60k)');

  // ---- routeHistory: recent closed quotes on the SAME lane, our own numbers ----
  // A3 shares A1's lane (X->Y) and closes later, so it should sort ahead of A1.
  await logger.handle({ type: 'armed', auctionId: 'A3', ts, lane: { origin: 'X', destination: 'Y' }, equipment: 'Trailer', units: 1, companyName: 'Syngenta', cost: 82000, marginsPct: [12.6], minMarginPct: 6.3, ladder: [92000, 88000], floor: 88000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'A3', ts: ts + 1000, price: 88000, rungIndex: 1, rank: 2, latencyMs: 190 });
  await logger.handle({ type: 'auction_result', auctionId: 'A3', ts: ts + 5000, won: false, finalRank: 2, closeModel: 'hard' });

  // equipment is a HARD match key (see the M->N block below); A1/A3 are both 'Trailer' so the
  // route-only behaviour (newest-first, self-exclusion, limit) is exercised on same-equipment rows.
  const hist = await logger.routeHistory({ origin: 'X', destination: 'Y' }, { equipment: 'Trailer' });
  ok(hist.length === 2, `routeHistory returns both X->Y closes (got ${hist.length})`);
  ok(hist[0].amount === 88000 && hist[0].rank === 2, 'routeHistory newest-first: A3 (our last bid) leads');
  ok(hist[1].amount === 85040 && hist[1].rank === 1, 'routeHistory second row is A1 (our last bid + final rank)');
  ok(hist[0].at >= hist[1].at, 'routeHistory sorted by close time descending');
  ok(hist[0].equipment === 'Trailer' && hist[0].units === 1, 'routeHistory rows carry equipment + units so each reference is self-describing');
  // entered rate + placed bid are carried separately (in addition to `amount`) so a message can
  // lead with the operator's own number: A3 quoted 82,000 and the bot walked it to 88,000.
  ok(hist[0].rate === 82000 && hist[0].bid === 88000, 'routeHistory carries rate (entered cost) + bid (last placed bid) separately for A3');
  ok(hist[1].rate === 80000 && hist[1].bid === 85040, 'routeHistory carries rate + bid separately for A1');
  ok(hist[0].amount === hist[0].bid, 'amount stays the last placed bid (backward-compatible), distinct from the new rate field');

  const histEx = await logger.routeHistory({ origin: 'X', destination: 'Y' }, { equipment: 'Trailer', excludeLoadId: 'A1' });
  ok(histEx.length === 1 && histEx[0].amount === 88000, 'routeHistory excludes the current load (no self-citation)');

  // a never-bid load contributes its entered cost (P->Q, A2 has no placed bid)
  const histPQ = await logger.routeHistory('P->Q', { equipment: 'Open' });
  ok(histPQ.length === 1 && histPQ[0].amount === 50000 && histPQ[0].rank === 3, 'routeHistory falls back to the entered cost when we never bid');
  ok(histPQ[0].rate === 50000 && histPQ[0].bid === null, 'a never-bid row carries rate = the entered cost and bid = null (so the message collapses to the single number)');

  ok((await logger.routeHistory({ origin: 'Z', destination: 'W' }, { equipment: 'Trailer' })).length === 0, 'routeHistory on an unseen lane -> empty');
  ok((await logger.routeHistory(null, { equipment: 'Trailer' })).length === 0, 'routeHistory on a null lane -> empty');
  ok((await logger.routeHistory({ origin: 'X', destination: 'Y' }, { equipment: 'Trailer', limit: 1 })).length === 1, 'routeHistory respects the limit');

  // ---- routeHistory: equipment is a HARD match key (fail-closed) --------------------
  // Regression for the Director's 2026-07-16 report: Rs 48,692/48,240 quotes from 20ft-container
  // loads surfaced as references on a 32-feet load - same city pair, wrong vehicle. A 20ft-container
  // rate is meaningless when pricing a 32ft trailer, so equipment must match (normalized), never be
  // borrowed across types to pad a thin sample. On lane M->N: E1 is a 20ft container (the offending
  // rate), E2 is 32ft, E3 is 32FT (a casing variant of E2), E4 carries no equipment at all. E1 is
  // the NEWEST close, so route-only matching would surface it first (the exact bug).
  await logger.handle({ type: 'armed', auctionId: 'E2', ts, lane: { origin: 'M', destination: 'N' }, equipment: '32ft', units: 1, companyName: 'Syngenta', cost: 70000, ladder: [72000], floor: 71000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'E2', ts: ts + 1000, price: 72000, rungIndex: 0, rank: 1 });
  await logger.handle({ type: 'auction_result', auctionId: 'E2', ts: ts + 3000, won: true, finalRank: 1, closeModel: 'hard' });
  await logger.handle({ type: 'armed', auctionId: 'E3', ts, lane: { origin: 'M', destination: 'N' }, equipment: '32FT', units: 2, companyName: 'Syngenta', cost: 71000, ladder: [73000], floor: 72000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'E3', ts: ts + 1000, price: 73000, rungIndex: 0, rank: 1 });
  await logger.handle({ type: 'auction_result', auctionId: 'E3', ts: ts + 4000, won: true, finalRank: 1, closeModel: 'hard' });
  // E4: a legacy/backfilled row with no equipment captured at all. Newer than E2/E3, so its
  // exclusion is the fail-closed rule at work, not the limit window.
  await logger.handle({ type: 'armed', auctionId: 'E4', ts, lane: { origin: 'M', destination: 'N' }, equipment: null, units: null, companyName: 'Syngenta', cost: 69000, ladder: [69500], floor: 69000 });
  await logger.handle({ type: 'bid_placed', auctionId: 'E4', ts: ts + 1000, price: 69500, rungIndex: 0, rank: 3 });
  await logger.handle({ type: 'auction_result', auctionId: 'E4', ts: ts + 4500, won: false, finalRank: 3, closeModel: 'hard' });
  // E1: the 20ft-container row, the NEWEST close on this lane.
  await logger.handle({ type: 'armed', auctionId: 'E1', ts, lane: { origin: 'M', destination: 'N' }, equipment: '20ft container', units: 1, companyName: 'Syngenta', cost: 48000, ladder: [48692], floor: 48240 });
  await logger.handle({ type: 'bid_placed', auctionId: 'E1', ts: ts + 1000, price: 48692, rungIndex: 0, rank: 2 });
  await logger.handle({ type: 'auction_result', auctionId: 'E1', ts: ts + 5000, won: false, finalRank: 2, closeModel: 'hard' });

  const hist32 = await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: '32ft' });
  ok(!hist32.some((r) => r.amount === 48692), 'routeHistory EXCLUDES the 20ft-container row on a 32ft load (the reported bug)');
  ok(hist32.some((r) => r.amount === 72000), 'routeHistory includes the same-equipment 32ft row');
  ok(hist32.some((r) => r.amount === 73000), 'routeHistory matches equipment case-insensitively (32FT == 32ft)');
  ok(!hist32.some((r) => r.amount === 69500), 'routeHistory excludes a stored row with no equipment when the load equipment is known (fail-closed)');
  ok(hist32.length === 2, `routeHistory on M->N/32ft returns exactly the two 32ft rows (got ${hist32.length})`);
  ok(hist32[0].equipment === '32FT', 'routeHistory preserves the stored equipment string verbatim on each row (no normalization of the display value)');

  // normalization collapses surrounding/internal whitespace + case, but NEVER fuzzes across sizes/subtypes.
  ok((await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: '  32FT ' })).length === 2, 'routeHistory normalizes trim + case on the incoming equipment');
  const hist20 = await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: '20ft container' });
  ok(hist20.length === 1 && hist20[0].amount === 48692, 'routeHistory on M->N/20ft container returns only the container row, never the 32ft rows');

  // fail-closed on an UNKNOWN incoming equipment: return nothing rather than cross-type rows.
  ok((await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: null })).length === 0, 'routeHistory returns empty when the incoming load equipment is null (fail-closed, no cross-type)');
  ok((await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: '' })).length === 0, 'routeHistory returns empty when the incoming load equipment is empty (fail-closed)');
  ok((await logger.routeHistory({ origin: 'M', destination: 'N' }, { equipment: '   ' })).length === 0, 'routeHistory returns empty when the incoming load equipment is whitespace-only (fail-closed)');
  ok((await logger.routeHistory({ origin: 'M', destination: 'N' })).length === 0, 'routeHistory returns empty when no equipment is provided at all (fail-closed)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
