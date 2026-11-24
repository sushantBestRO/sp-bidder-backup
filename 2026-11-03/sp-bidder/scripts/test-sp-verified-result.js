'use strict';
/**
 * CW-269 regression: a SuperProcure load we participated in must use the closed portal result,
 * rather than declaring a cached live rank 1 a win. The first two closed-tab passes may not contain
 * the load; HISTORY then returns our matching PMT rank 2. The outcome must persist and render as a
 * loss, never a false WON. An observed rank 1 without an allotment is a rank, not a WON result.
 *
 * node scripts/test-sp-verified-result.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');
const { toNotification, outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

const LOAD_ID = 'CW-269-L2';
const BID = 110000;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const realNow = Date.now;
Date.now = () => NOW;

class InMemoryScheduler {
  constructor() { this.docs = new Map(); }
  update(id, patch) {
    const current = this.docs.get(String(id)) || { auctionId: String(id) };
    this.docs.set(String(id), Object.assign({}, current, patch));
  }
  get(id) { return this.docs.get(String(id)) || null; }
}

function response(data, status = 200) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(data) };
}

function closedRow({ rank, amount, amountPMT, bidRate, bidAllottedVehicleCount = 0, bidCarrierId = 2667, isActive = 1 }) {
  return {
    load: LOAD_ID, bidCarrierId, isActive, rank, amount,
    ...(amountPMT != null ? { amountPMT } : {}),
    ...(bidRate != null ? { bidRate } : {}),
    bidAllottedVehicleCount,
  };
}

function closedPage(bidDetails, load = {}) {
  return {
    loadDetails: [Object.assign({ id: LOAD_ID, branchCarrierCarrierId: 2667, biddingOn: 0 }, load)],
    bidDetails: Array.isArray(bidDetails) ? bidDetails : [bidDetails],
  };
}

const emptyPage = () => ({ loadDetails: [], bidDetails: [] });

async function finalizeSuperProcure({ pages, rules = { pricingMode: 'per_tonne' }, liveRank = 1,
  landedBids = 1, everBid = true, lastBidPrice = BID }) {
  const calls = [];
  const sleeps = [];
  const adapter = new RealSuperProcureAdapter({
    token: 'test-only',
    authProbeEnabled: false,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const source = pages[body.baseFilter.tab];
      const page = source == null ? response({ loadDetails: [], bidDetails: [] })
        : (typeof source === 'function' ? source(body, calls) : source);
      return page;
    },
  });
  adapter.account = { carrierId: 2667, branchIds: [99] };
  adapter.ensureSession = async () => adapter.account;
  adapter.getAuctionState = async () => ({ ok: true, status: 'closed', myRank: liveRank, revisionsLeft: null });

  const scheduler = new InMemoryScheduler();
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  const events = [];
  const engine = new BidEngine(adapter, scheduler, {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: (event) => { events.push(event); logger.handle(event); },
  });
  const meta = {
    id: LOAD_ID,
    lane: { origin: 'Mumbai', destination: 'Pune' },
    equipment: '32 SXL',
    units: 1,
    quoteType: 'FTL',
    companyName: 'CW-269 Shipper',
    closesAt: NOW,
    rules: Object.assign({ revisionLimit: 3, minDecrement: 100 }, rules),
  };
  await logger.handle({ type: 'armed', auctionId: LOAD_ID, ts: NOW - 60_000, lane: meta.lane,
    equipment: meta.equipment, units: 1, companyName: meta.companyName, cost: 100000,
    marginsPct: [8, 6, 5], minMarginPct: 5, ladder: [BID], floor: BID });
  if (landedBids > 0) {
    await logger.handle({ type: 'bid_placed', auctionId: LOAD_ID, ts: NOW - 1_000,
      price: lastBidPrice, rungIndex: 0, rank: liveRank });
  }

  const monitor = {
    auctionId: LOAD_ID, meta, finalized: false, landedBids, everBid,
    lastBidPrice, closeModel: 'hard', believedCloseAt: NOW,
    _lastLiveRead: { closesInMs: 0 }, _round: null,
  };

  // Act
  await engine._finalize(monitor, { myRank: liveRank, revisionsLeft: null });
  await logger._tail;
  const result = events.find((event) => event.type === 'auction_result');
  const record = await store.getDoc('closedBids', LOAD_ID);
  const notification = toNotification(result);
  Object.assign(notification.data, outcomeEnrichment(record));
  const receipt = renderMessage(templateFor(notification.kind, notification.data), notification.data) || '';

  return { calls, sleeps, result, record, notification, receipt, capabilities: adapter.capabilities() };
}

async function should_book_only_the_verified_closed_portal_result_for_cw_269() {
  let scenarios = 0;
  // Arrange / Act: the per-tonne bid is ₹110,000, but SuperProcure's aggregate `amount` is ₹220,000.
  // Its unique closed row matches on amountPMT/bidRate, not the aggregate amount.
  let historyReads = 0;
  const delayed = await finalizeSuperProcure({
    pages: {
      PENDING: response({ loadDetails: [], bidDetails: [] }),
      CONFIRMED: response({ loadDetails: [], bidDetails: [] }),
      HISTORY: () => response(++historyReads < 3 ? { loadDetails: [], bidDetails: [] } : closedPage(
        closedRow({ rank: 2, amount: BID * 2, amountPMT: BID, bidRate: BID }), { biddingOn: false },
      )),
    },
  });
  scenarios++;

  // Assert: the delayed, matching HISTORY result replaces the cached live rank.
  assert.strictEqual(delayed.capabilities.settledOutcomeRequiresOwnPosition, true,
    'SuperProcure declares the owned-position verification policy');
  assert.ok(delayed.calls.some((body) => body.baseFilter.tab === 'PENDING'), 'closed result lookup starts in PENDING');
  assert.ok(delayed.calls.some((body) => body.baseFilter.tab === 'HISTORY'
    && body.baseFilter.loadId === LOAD_ID), 'HISTORY lookup is targeted to the participated load');
  assert.deepStrictEqual(delayed.sleeps, [1000, 2000], 'closed result lookup uses the bounded retry schedule');
  assert.deepStrictEqual(delayed.calls.map((body) => body.baseFilter.tab),
    ['PENDING', 'CONFIRMED', 'HISTORY', 'PENDING', 'CONFIRMED', 'HISTORY', 'PENDING', 'CONFIRMED', 'HISTORY'],
    'the three bounded passes preserve the PENDING -> CONFIRMED -> HISTORY order');
  assert.ok(delayed.calls.every((body) => body.baseFilter.loadId === LOAD_ID),
    'every closed result lookup is targeted to this load');
  assert.deepStrictEqual([delayed.result.won, delayed.result.finalRank], [false, 2],
    'verified PMT rank 2 replaces stale cached rank 1');
  assert.deepStrictEqual([delayed.record.won, delayed.record.finalRank], [false, 2],
    'closed record stores the verified loss');
  assert.strictEqual(delayed.record.resultBasis, 'verified_closed_portal_rank');
  assert.strictEqual(delayed.record.resultTab, 'HISTORY');
  assert.strictEqual(delayed.record.resultVerifiedAt, NOW);
  assert.strictEqual(delayed.record.resultObservedRank, 1);
  assert.strictEqual(delayed.record.awardConfirmed, false);
  assert.deepStrictEqual({ basis: delayed.notification.data.resultBasis, tab: delayed.notification.data.resultTab,
    verifiedAt: delayed.notification.data.resultVerifiedAt, award: delayed.notification.data.awardConfirmed },
  { basis: 'verified_closed_portal_rank', tab: 'HISTORY', verifiedAt: NOW, award: false },
  'notification carries the record verification metadata');
  assert.match(delayed.receipt, /LOST/);
  assert.doesNotMatch(delayed.receipt, /WON|Complete the allotment/);

  let closingReads = 0;
  const closingLag = await finalizeSuperProcure({ pages: {
    PENDING: () => response(closedPage(closedRow({ rank: 2, amount: BID * 2,
      amountPMT: BID, bidRate: BID }), { biddingOn: ++closingReads === 1 ? 1 : 0 })),
  } });
  scenarios++;
  assert.deepStrictEqual([closingLag.result.won, closingLag.result.finalRank], [false, 2],
    'a portal row that closes on the next pass replaces the cached rank');
  assert.deepStrictEqual(closingLag.sleeps, [1000], 'an open row is retried after the first bounded delay');
  assert.deepStrictEqual(closingLag.calls.map(body => body.baseFilter.tab), ['PENDING', 'PENDING'],
    'an observed open row waits for a later pass instead of accepting a contradictory tab');

  async function unknown(label, pages, opts = {}, expectedCalls = null) {
    scenarios++;
    const unknown = await finalizeSuperProcure({ pages, ...opts });
    assert.strictEqual(unknown.result.won, null, `${label} must not issue a verdict`);
    assert.strictEqual(unknown.result.finalRank, null, `${label} clears an unverified final rank`);
    assert.strictEqual(unknown.record.won, null, `${label} stores no verdict`);
    assert.strictEqual(unknown.record.finalRank, null, `${label} stores no final rank`);
    assert.doesNotMatch(unknown.receipt, /WON|LOST|Complete the allotment/, `${label} must not claim WON or LOST`);
    assert.strictEqual(unknown.record.resultBasis, 'socket_rank_unverified', `${label} preserves its unverified basis`);
    assert.strictEqual(unknown.record.resultObservedRank, opts.liveRank === undefined ? 1 : opts.liveRank,
      `${label} preserves the observed rank separately`);
    assert.deepStrictEqual({ tab: unknown.record.resultTab, verifiedAt: unknown.record.resultVerifiedAt,
      award: unknown.record.awardConfirmed }, { tab: null, verifiedAt: null, award: null },
    `${label} stores no verification metadata`);
    if (expectedCalls != null) assert.strictEqual(unknown.calls.length, expectedCalls, `${label} fails closed on its first read`);
    return unknown;
  }

  // A portal error, invalid rank/ownership/closed facts, and a mismatched amount have no verdict.
  await unknown('read error', { PENDING: response({ error: 'down' }, 503) });
  await unknown('amount mismatch', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID - 1, bidRate: BID - 1 }))) });
  await unknown('flat amount mismatch', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID + 1 }))) },
    { rules: { pricingMode: 'flat' } });
  await unknown('absent result', { PENDING: response(emptyPage()), CONFIRMED: response(emptyPage()), HISTORY: response(emptyPage()) });
  await unknown('still open', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID }), { biddingOn: 1 })) });
  await unknown('closure missing', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID }), { biddingOn: undefined })) });
  await unknown('ambiguous own rows', { PENDING: response(closedPage([
    closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID }),
    closedRow({ rank: 2, amount: BID * 2, amountPMT: BID, bidRate: BID }),
  ])) });
  for (const rank of [0, -1, 1.5]) {
    await unknown(`invalid rank ${rank}`, { PENDING: response(closedPage(closedRow({ rank, amount: BID * 2, amountPMT: BID, bidRate: BID }))) });
  }
  await unknown('PMT amountPMT missing', { PENDING: response(closedPage(closedRow({ rank: 2, amount: BID * 2, bidRate: BID }))) });
  await unknown('PMT bidRate missing', { PENDING: response(closedPage(closedRow({ rank: 2, amount: BID * 2, amountPMT: BID }))) });
  await unknown('PMT echoes conflict', { PENDING: response(closedPage(closedRow({ rank: 2, amount: BID * 2, amountPMT: BID, bidRate: BID + 1 }))) });
  await unknown('cancelled load', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID }), { loadCancelReason: 'cancelled' })) });
  await unknown('inactive bid row', { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID, isActive: 0 }))) });
  await unknown('rank-two allotment contradiction', { PENDING: response(closedPage(closedRow({ rank: 2, amount: BID * 2, amountPMT: BID, bidRate: BID, bidAllottedVehicleCount: 1 }))) });
  await unknown('authentication rejection', { PENDING: response({ error: 'auth' }, 401) }, {}, 1);
  await unknown('rate limit', { PENDING: response({ error: 'busy' }, 429) }, {}, 1);

  // A confirmed closed rank 1 without an allotment remains a rank, not an award.
  const rankOne = await finalizeSuperProcure({
    pages: { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID,
      bidAllottedVehicleCount: 0 }))) },
  });
  scenarios++;
  assert.strictEqual(rankOne.result.won, true, 'rank 1 remains the internal settled-rank result');
  assert.strictEqual(rankOne.record.awardConfirmed, false, 'rank 1 with no allotment is not an award');
  assert.match(rankOne.receipt, /RANK 1/i);
  assert.match(rankOne.receipt, /Award not confirmed yet/i);
  assert.doesNotMatch(rankOne.receipt, /WON|Complete the allotment/);

  // An actual allotment is the authority to declare a SuperProcure win.
  const allotted = await finalizeSuperProcure({
    pages: { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID,
      bidAllottedVehicleCount: 1 }))) },
  });
  scenarios++;
  assert.strictEqual(allotted.result.won, true, 'allotted rank 1 is a WON result');
  assert.match(allotted.receipt, /WON/);
  assert.match(allotted.receipt, /Allotment confirmed on SuperProcure/);
  assert.doesNotMatch(allotted.receipt, /Complete the allotment/);

  // A shared-login/manual position has no bot price to compare, but its observed rank is still verified.
  const manual = await finalizeSuperProcure({
    landedBids: 0, everBid: false, liveRank: 1, lastBidPrice: BID,
    rules: { pricingMode: 'flat' },
    pages: { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID + 777,
      bidAllottedVehicleCount: 0 }))) },
  });
  scenarios++;
  assert.deepStrictEqual([manual.result.won, manual.result.finalRank], [true, 1], 'verified shared-login rank is retained');
  assert.strictEqual(manual.record.resultBasis, 'verified_closed_portal_rank');
  assert.strictEqual(manual.record.awardConfirmed, false);
  assert.strictEqual(manual.record.ourBids.length, 0, 'manual position does not invent a bot bid');
  assert.match(manual.receipt, /bid placed by hand from this login/i);
  assert.match(manual.receipt, /RANK 1/i);
  assert.strictEqual(manual.notification.data.marketRate, '1,00,000', 'Your Rate remains the entered desk cost');
  assert.match(manual.receipt, /\*Your Rate\* - [^\n]*1,00,000(?:\n|$)/);
  assert.doesNotMatch(manual.receipt, /1,10,777/, 'the manual portal quote is not presented as the desk cost');
  assert.doesNotMatch(manual.receipt, /Won Rate|Margin/i);

  const manualUnknown = await unknown('shared-login rank not verified', {
    PENDING: response(emptyPage()), CONFIRMED: response(emptyPage()), HISTORY: response(emptyPage()),
  }, { landedBids: 0, everBid: false, liveRank: 1 });
  assert.strictEqual(manualUnknown.record.resultObservedRank, 1, 'unverified shared-login rank survives as an observation');
  assert.match(manualUnknown.receipt, /Bid Command placed no bid|shared login/i);
  assert.match(manualUnknown.receipt, /RANK 1/i);

  // A load with neither a bot bid nor a shared-login rank remains ordinary no-bid and does no portal lookup.
  const noPosition = await finalizeSuperProcure({
    landedBids: 0, everBid: false, liveRank: null,
    pages: { PENDING: response(closedPage(closedRow({ rank: 1, amount: BID * 2, amountPMT: BID, bidRate: BID }))) },
  });
  scenarios++;
  assert.strictEqual(noPosition.calls.length, 0, 'no bot bid and no observed position performs no result lookup');
  assert.match(noPosition.receipt, /NO BID PLACED/i);

  // A wire-attempt marker also earns verification when the acceptance write was not logged as landed.
  const attempted = await finalizeSuperProcure({
    landedBids: 0, everBid: true, liveRank: null,
    pages: { PENDING: response(closedPage(closedRow({ rank: 2, amount: BID * 2, amountPMT: BID, bidRate: BID }))) },
  });
  scenarios++;
  assert.deepStrictEqual([attempted.result.won, attempted.result.finalRank], [false, 2], 'everBid triggers verification');
  assert.strictEqual(attempted.calls.length, 1, 'everBid verifies the first closed tab');

  // GoComet's settled-result contract remains its own: do not route it through SuperProcure lookup.
  const gcStore = new MemoryStore();
  const gcLogger = new BidLogger({ store: gcStore, log: () => {} });
  const gcEvents = [];
  let goCometResultReads = 0;
  const gcAdapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'soft', platformLabel: 'GoComet' }),
    getAuctionState: async () => ({ ok: true, status: 'closed', myRank: 1, revisionsLeft: 0 }),
    readSettledOutcome: async () => { goCometResultReads++; return { settled: true, rank: 1 }; },
  };
  const gcEngine = new BidEngine(gcAdapter, new InMemoryScheduler(), {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: (event) => { gcEvents.push(event); gcLogger.handle(event); },
  });
  const gcMeta = { id: 'CW-269-GC', lane: { origin: 'Surat', destination: 'Bharuch' }, equipment: '32 SXL', units: 1,
    quoteType: 'FTL', companyName: 'GoComet control', closesAt: NOW, rules: { revisionLimit: 3, minDecrement: 100 } };
  await gcLogger.handle({ type: 'armed', auctionId: gcMeta.id, ts: NOW - 60_000, lane: gcMeta.lane,
    equipment: gcMeta.equipment, units: 1, companyName: gcMeta.companyName, cost: 100000,
    marginsPct: [8, 6, 5], minMarginPct: 5, ladder: [BID], floor: BID });
  await gcLogger.handle({ type: 'bid_placed', auctionId: gcMeta.id, ts: NOW - 1_000, price: BID, rungIndex: 0, rank: 1 });
  await gcEngine._finalize({ auctionId: gcMeta.id, meta: gcMeta, finalized: false, landedBids: 1, everBid: true,
    lastBidPrice: BID, closeModel: 'soft', believedCloseAt: NOW, _lastLiveRead: { closesInMs: 0 }, _round: null },
  { myRank: 1, revisionsLeft: 0 });
  await gcLogger._tail;
  scenarios++;
  assert.strictEqual(gcEvents.find((event) => event.type === 'auction_result').won, true,
    'GoComet rank 1 remains its existing win contract');
  assert.strictEqual(goCometResultReads, 1, 'GoComet retains its existing fresh settled-result read');
  return scenarios;
}

(async () => {
  try {
    const scenarios = await should_book_only_the_verified_closed_portal_result_for_cw_269();
    console.log(`PASS: CW-269 verified portal result contract (${scenarios} scenarios)`);
  } catch (error) {
    console.error('FAIL: CW-269 verified portal result replaces stale cached rank');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    Date.now = realNow;
  }
})();
