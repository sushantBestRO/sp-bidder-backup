'use strict';
/**
 * T6 D9: a bid the engine banks after the auction_result still reaches the closed-bids ledger.
 *
 * _finalize marks the monitor finalized, then awaits one more platform read before emitting
 * auction_result. A snipe whose write is on the wire across that await resolves into
 * _recordLandedAfterRetire, which emits bid_placed with `establishing: false` AFTER the result.
 * bidLogger._onBid dropped every bid on a closed record, so a WON load ended with ourBids [],
 * lastBidPrice null and no stream line, while the durable intent held the landed price.
 *
 * The general post-close drop stays: only the write the engine itself declares a late bank
 * (establishing: false) is accepted onto a closed record.
 *
 *   node scripts/test-won-load-late-banked-bid-recorded.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents file), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const T0 = 1_757_000_000_000;
const LANE = { origin: 'Palghar', destination: 'Jaipur' };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  console.log('\n1. the real engine: the establishing write resolves after the close was finalized');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-bank-'));
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const events = [];
    let release = null;
    const placed = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: 1, totalBidders: 2, standingL1Price: null, closesInMs: 30_000,
          revisionLimit: 3, revisionsLeft: null, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 };
      },
      placeBid(id, price) {
        placed.push(price);
        return new Promise((r) => { release = () => r({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }); });
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(path.join(dir, 'intents.json')),
      { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0,
        onEvent: (e) => { events.push(e); logger.handle(e); } });
    const m = eng.arm({ id: 'SNIPE-1', lane: LANE, units: 1, companyName: 'Waaree Energies', closesAt: Date.now() + 30_000 },
      { cost: 26_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
    const tick = eng._tick(m);
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
    await eng._finalize(m, { myRank: 1 });
    release();
    await tick;
    if (m.timer) clearTimeout(m.timer);
    await flush();
    await logger.handle({ type: 'noop' });

    const order = events.filter((e) => e.type !== 'alert').map((e) => e.type);
    const rec = await store.getDoc('closedBids', 'SNIPE-1');
    const intent = eng.scheduler.get('SNIPE-1') || {};
    const stream = await store.readEvents('bids');
    ok(placed.length === 1 && order.join(',') === 'armed,auction_result,bid_placed' && intent.landedBidPrice === placed[0],
      `fixture: the write landed after the result and the intent banked it (${order.join(', ')}; intent ${intent.landedBidPrice})`);
    ok(rec.status === 'closed' && rec.won === true, 'the record keeps its WON result');
    ok(JSON.stringify(rec.ourBids.map((b) => b.price)) === JSON.stringify(placed),
      `and its ledger holds the bid the intent holds (ourBids ${JSON.stringify(rec.ourBids.map((b) => b.price))})`);
    ok(rec.lastBidPrice === placed[0], `lastBidPrice is the landed ${placed[0]} (got ${rec.lastBidPrice})`);
    ok(stream.filter((x) => x.kind === 'bid_placed').length === 1, 'the daily bids stream carries the line');
    eng.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n2. a snipe banked after the result, on a load that already had a bid');
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'S2', ts: T0, lane: LANE, equipment: 'SXL', units: 1,
      companyName: 'Waaree Energies', cost: 26_000, ladder: [28_340, 27_300, 26_260], floor: 26_260,
      marginsPct: [9, 5, 1], minMarginPct: 1 });
    await logger.handle({ type: 'bid_placed', auctionId: 'S2', ts: T0 + 1_000, price: 28_340, rungIndex: 0,
      cost: 26_000, minMarginPct: 1 });
    await logger.handle({ type: 'auction_result', auctionId: 'S2', ts: T0 + 600_000, won: true, finalRank: 1, closeModel: 'hard' });
    await logger.handle({ type: 'bid_placed', auctionId: 'S2', ts: T0 + 599_500, price: 27_300, rungIndex: null,
      establishing: false, cost: 26_000, minMarginPct: 1 });
    const rec = await store.getDoc('closedBids', 'S2');
    const stream = await store.readEvents('bids');
    ok(JSON.stringify(rec.ourBids.map((b) => b.price)) === '[28340,27300]' && rec.lastBidPrice === 27_300,
      `the won price is the snipe the portal holds (ourBids ${JSON.stringify(rec.ourBids.map((b) => b.price))}, last ${rec.lastBidPrice})`);
    ok(stream.filter((x) => x.kind === 'bid_placed').length === 2, 'and both writes are on the stream');
  }

  console.log('\n3. any other bid on a closed record is still dropped');
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'S3', ts: T0, lane: LANE, equipment: 'SXL', units: 1,
      companyName: 'Waaree Energies', cost: 26_000, ladder: [28_340, 27_300, 26_260], floor: 26_260 });
    await logger.handle({ type: 'bid_placed', auctionId: 'S3', ts: T0 + 1_000, price: 28_340, rungIndex: 0 });
    await logger.handle({ type: 'auction_result', auctionId: 'S3', ts: T0 + 600_000, won: false, finalRank: 3, closeModel: 'hard' });
    await logger.handle({ type: 'bid_placed', auctionId: 'S3', ts: T0 + 700_000, price: 27_300, rungIndex: 1 });
    const rec = await store.getDoc('closedBids', 'S3');
    ok(rec.ourBids.length === 1 && rec.lastBidPrice === 28_340, 'a post-close bid with no late-bank marker leaves the record alone');
  }

  const EXPECTED_CHECKS = 8;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL -', e && e.stack || e); process.exit(1); });
