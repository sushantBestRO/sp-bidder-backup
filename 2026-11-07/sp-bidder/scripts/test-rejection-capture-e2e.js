'use strict';
/**
 * End-to-end capture wiring (Gap 6): a rejected bid must flow adapter -> engine emit ->
 * BidLogger persistence carrying the platform's httpStatus, the raw body, AND the carrier we
 * actually sent. The adapter-level test (test-logging-capture) and the logger-level test
 * (test-bid-rejected-log) each pin ONE end; this pins the SEAM between them - bidEngine's
 * `bid_rejected` emit - which no other test drives. A mutant that dropped `body`, `status`, or
 * `carrierSent` from that emit would pass both unit suites but must fail here.
 *
 *   node scripts/test-rejection-capture-e2e.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAND = [12.6, 7.2, 6.3];
// A representative plaintext body of the kind SuperProcure answers a rejected bid with.
const REJECT_BODY = 'Load is under approval for allotment. Bidding is not allowed.';
const CARRIER = 2667; // the carrier the adapter actually sent - captured so a rejection is legible

(async () => {
  const f = path.join(os.tmpdir(), `rejcap-${process.pid}.json`);
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store });
  const pending = [];   // every logger.handle() promise, so the asserts can await all writes
  const placed = [];
  const closesAt = Date.now() + 3_000;

  // A mock adapter that rejects EVERY bid the way the real SuperProcure 400 does: an HTTP
  // status, a plaintext body, and the carrier the adapter actually sent (carrierSent). This is
  // exactly the shape realAdapter.placeBid now returns on a rejection.
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 6, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    async getAuctionState() {
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 2,
        standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionLimit: 6, revisionsLeft: null,
        closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) {
      placed.push(price);
      return { accepted: false, status: 400, text: REJECT_BODY, carrierSent: CARRIER,
        reason: REJECT_BODY, latencyMs: 30 };
    },
  };

  // Wire the logger to the engine's event stream exactly as the composition root (server.js)
  // does - via the onEvent hook - and collect each handle() promise so the assertions await
  // every persistence write deterministically (handle() enqueues in emit order).
  const eng = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true,
    onEvent: (evt) => { pending.push(logger.handle(evt)); },
  });
  eng.arm({ id: '77', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt }, { cost: 50_000, marginsPct: BAND });
  await sleep(3_300);
  eng.kill();
  await Promise.allSettled(pending);

  assert.ok(placed.length >= 1, 'the engine actually fired at least one bid');

  // (1) the un-backfillable jsonl stream carries a self-documenting rejection line, sourced
  //     end-to-end: adapter return -> engine bid_rejected emit -> BidLogger.
  const events = await store.readEvents('bids');
  const rejects = events.filter((e) => e.kind === 'bid_rejected' && String(e.auctionId) === '77');
  assert.ok(rejects.length >= 1, 'a bid_rejected line was persisted to the bids jsonl stream');
  const r = rejects[0];
  assert.strictEqual(r.httpStatus, 400, 'jsonl carries the HTTP status end-to-end (engine emit -> status)');
  assert.strictEqual(r.body, REJECT_BODY, 'jsonl carries the raw platform body end-to-end (engine emit -> body from res.text)');
  assert.strictEqual(r.carrierSent, CARRIER, 'jsonl carries the carrier actually sent end-to-end (engine emit -> carrierSent)');
  ok('rejection flows adapter -> engine emit -> jsonl with status + body + carrierSent');

  // (2) the closedBids doc records the rejection, so this fired-and-rejected load is no longer
  //     byte-identical to a never-fired one - and a rejection never pollutes ourBids.
  const rec = await store.getDoc('closedBids', '77');
  assert.ok(rec && Array.isArray(rec.rejectedBids) && rec.rejectedBids.length >= 1,
    'the closedBids doc has a rejectedBids[] entry (fired-and-rejected is distinguishable)');
  const rb = rec.rejectedBids[0];
  assert.strictEqual(rb.httpStatus, 400, 'doc rejection carries the HTTP status');
  assert.strictEqual(rb.body, REJECT_BODY, 'doc rejection carries the raw body');
  assert.strictEqual(rb.carrierSent, CARRIER, 'doc rejection carries the carrier actually sent');
  assert.deepStrictEqual(rec.ourBids, [], 'a rejected bid never pollutes ourBids');
  ok('rejection recorded on the closedBids doc with status + body + carrierSent, ourBids untouched');

  try { fs.unlinkSync(f); } catch (_) {}
  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
