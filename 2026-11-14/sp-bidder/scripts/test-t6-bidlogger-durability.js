'use strict';
/**
 * Pins the T6 bug-hunt durability defects (owner "final push", 26 Sep). Evidence:
 * .build/cache/python-port/sanity-5.yaml ("T6 RECOVERY" section), docs/bug-hunts/2026-09-16_bidcmd-T6-*.
 *
 *   5. STATE-3: a SECOND closed_while_down event could re-stamp (and blank) won/finalRank on a
 *      record this same mechanism had already closed once - the old guard
 *      (`status==='closed' && closedWhileDown!==true`) only protected a REAL settled result, not
 *      its own prior sweep.
 *   6. STATE-4: bid_placed carried no idempotency key, so a re-emitted event double-logged the
 *      same bid onto ourBids.
 *
 * @requires-summary-line
 *   node scripts/test-t6-bidlogger-durability.js
 */
const assert = require('assert');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // ---- 5. a second closed_while_down sweep never overwrites the first one's won/finalRank ----
  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'L1' });
    await logger.handle({ type: 'closed_while_down', auctionId: 'L1', won: true, finalRank: 1 });
    const afterFirst = await store.getDoc('closedBids', 'L1');
    assert.strictEqual(afterFirst.won, true, 'precondition: the first sweep recorded a real result');
    assert.strictEqual(afterFirst.finalRank, 1, 'precondition: the first sweep recorded a rank');

    // A replayed/duplicate sweep for the same load, carrying LESS information (a restart re-running
    // the boot sweep, an overlapping late-detection).
    await logger.handle({ type: 'closed_while_down', auctionId: 'L1', won: null, finalRank: null });
    const afterSecond = await store.getDoc('closedBids', 'L1');
    assert.strictEqual(afterSecond.won, true, 'T6 item 5: a second closed_while_down sweep does not blank an already-recorded won flag');
    assert.strictEqual(afterSecond.finalRank, 1, 'T6 item 5: a second closed_while_down sweep does not blank an already-recorded finalRank');
    ok('T6 item 5: a closedWhileDown re-sweep no longer overwrites its own prior close');
  }

  // ---- 5 control: a genuinely first closed_while_down sweep still records normally ----
  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'L2' });
    await logger.handle({ type: 'closed_while_down', auctionId: 'L2', won: false, finalRank: 3 });
    const rec = await store.getDoc('closedBids', 'L2');
    assert.strictEqual(rec.status, 'closed', 'control: a fresh closedWhileDown sweep still closes the record');
    assert.strictEqual(rec.won, false, 'control: a fresh closedWhileDown sweep still records won');
    assert.strictEqual(rec.finalRank, 3, 'control: a fresh closedWhileDown sweep still records finalRank');
    ok('control: a genuinely first closedWhileDown sweep is unaffected');
  }

  // ---- 6. a re-emitted bid_placed (same decidedAt) does not double-log ----
  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'L3' });
    const bid = { type: 'bid_placed', auctionId: 'L3', price: 40000, rungIndex: 0, decidedAt: 1000, ts: 1010 };
    await logger.handle(bid);
    await logger.handle(Object.assign({}, bid)); // exact re-emit, same decidedAt
    const rec = await store.getDoc('closedBids', 'L3');
    assert.strictEqual(rec.ourBids.length, 1, `T6 item 6: a re-emitted bid_placed (same decidedAt) is not double-logged, got ${rec.ourBids.length} entries`);
    ok('T6 item 6: bid_placed is idempotent on decidedAt - a re-emitted event does not double-log');
  }

  // ---- 6 control: two GENUINELY different bids (different decidedAt) both record ----
  {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'L4' });
    await logger.handle({ type: 'bid_placed', auctionId: 'L4', price: 40000, rungIndex: 0, decidedAt: 1000, ts: 1010 });
    await logger.handle({ type: 'bid_placed', auctionId: 'L4', price: 39000, rungIndex: 1, decidedAt: 2000, ts: 2010 });
    const rec = await store.getDoc('closedBids', 'L4');
    assert.strictEqual(rec.ourBids.length, 2, 'control: two genuinely distinct bids (different decidedAt) both record');
    ok('control: two genuinely different bids still both log (the dedupe is exact-match only)');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
