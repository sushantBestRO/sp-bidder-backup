'use strict';
/**
 * TWO DIFFERENT BIDS DECIDED IN THE SAME MILLISECOND ARE BOTH RECORDED.
 *
 * Regression target: the T6 STATE-4 bid_placed dedupe keyed on decidedAt alone. decidedAt is a
 * millisecond wall-clock stamp, not a fire identity, so a second genuine bid decided in the same
 * millisecond as an earlier one was dropped as a "re-emitted event" and the closed record lost a
 * landed write (the 26091792T2 shape: 3 landed, 2 recorded). Seen intermittently in
 * test-uncertain-write-recorded.js check 4.
 *
 *   1. logger: two bid_placed with the same decidedAt but a different price and rung -> 2 ourBids.
 *   2. real engine + logger, clock frozen so every decision shares one millisecond: three landed
 *      writes (the third transport-thrown) -> 3 ourBids.
 *   3. control: an exact re-emit of one bid_placed is still recorded once.
 *
 * @requires-summary-line
 *   node scripts/test-bidlog-same-ms-bids-recorded.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore, MemoryStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let passed = 0;
let failed = 0;
function ok(n, cond, msg) {
  if (cond) { passed++; console.log(`  ok  ${n}. ${msg}`); } else { failed++; console.log(`  FAIL ${n}. ${msg}`); }
}

const tmpFile = path.join(os.tmpdir(), `bidlog-same-ms-${process.pid}.json`);
process.on('exit', () => { for (const f of [tmpFile, tmpFile + '.tmp']) { try { fs.unlinkSync(f); } catch (_) {} } });

const REMAINING_MS = 114 * 60 * 1000;

function mkAdapter() {
  const wire = [];
  const caps = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' };
  return {
    wire,
    writeEnabled: true,
    capabilities: () => caps,
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 }),
    placeBid: async (_id, price) => {
      wire.push(price);
      if (wire.length === 3) throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

(async () => {
  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'S1' });
    await logger.handle({ type: 'bid_placed', auctionId: 'S1', price: 31610, rungIndex: 0, decidedAt: 5000, writeLandedAt: 5000, ts: 5000 });
    await logger.handle({ type: 'bid_placed', auctionId: 'S1', price: 30450, rungIndex: 1, decidedAt: 5000, writeLandedAt: 5000, ts: 5000 });
    const rec = await store.getDoc('closedBids', 'S1');
    const prices = (rec.ourBids || []).map((b) => b.price);
    ok(1, prices.length === 2, `two different bids decided in the same millisecond leave ${prices.length} ourBids ${JSON.stringify(prices)}, expected 2`);
  }

  {
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    let recorded = -1;
    let wire = [];
    try {
      const store = createStore({ backend: 'memory' });
      const logger = new BidLogger({ store });
      const adapter = mkAdapter();
      const pending = [];
      const engine = new BidEngine(adapter, new DurableScheduler(tmpFile), {
        config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
        live: true, onEvent: (e) => pending.push(logger.handle(e)), log: { debug() {}, info() {}, warn() {}, error() {} },
      });
      const m = engine.arm({
        id: 'S2', lane: { origin: 'Khopoli', destination: 'Gajsinghpur' }, equipment: 'Trailer 40', units: 1,
        companyName: 'Renewsys', closesAt: frozen + REMAINING_MS, startsAt: frozen - 1_000, status: 'live', softClose: false,
      }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
      if (m.timer) clearTimeout(m.timer);
      m.timer = null;
      for (const closesInMs of [REMAINING_MS, 60 * 60 * 1000, 2_000]) {
        await engine._maybeBid(m, Object.assign(await adapter.getAuctionState(), { closesInMs }));
      }
      await Promise.all(pending);
      wire = adapter.wire.slice();
      const rec = await store.getDoc('closedBids', m.auctionId);
      recorded = rec && Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean).length : 0;
      engine.kill('done');
    } finally {
      Date.now = realNow;
    }
    if (wire.length !== 3) throw new Error(`setup: expected 3 writes on the wire, saw ${JSON.stringify(wire)}`);
    ok(2, recorded === 3, `three landed writes decided in one millisecond leave ${recorded} ourBids on the closed record, expected 3`);
  }

  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'S3' });
    const bid = { type: 'bid_placed', auctionId: 'S3', price: 40000, rungIndex: 0, decidedAt: 1000, writeLandedAt: 1030, ts: 1030 };
    await logger.handle(bid);
    await logger.handle(Object.assign({}, bid));
    const rec = await store.getDoc('closedBids', 'S3');
    ok(3, rec.ourBids.length === 1, `an exact re-emit of one bid_placed leaves ${rec.ourBids.length} ourBids, expected 1`);
  }

  console.log(`${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
})().catch((e) => { console.log(`FAIL - harness: ${e && e.stack}`); process.exit(1); });
