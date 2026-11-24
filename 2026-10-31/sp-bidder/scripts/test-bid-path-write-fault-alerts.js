'use strict';
/**
 * Ruling 18: six `this.scheduler.update(...)` writes on the bid path swallow a failed disk write
 * with `catch (_) {}`. Each one is recording something that only matters after a restart - a
 * discounted revision count, an everBid/foreignSlotUncounted flag, a spent-cap latch - and none of
 * them told the desk when the disk refused it, unlike the sibling writes this same file's engine
 * already routes through _recordWriteFailed (bid_record_failed / close_record_failed).
 *
 *   1. _detectForeignBids            - the low-cap foreign-bid discount's revisionsLeft write
 *   2. _recordRefusedAfterRetire     - the everBid / foreignSlotUncounted write
 *   3. _recordRefusedAfterRetire     - the post-retire bid_cap_exhausted revisionsLeft:0 write
 *   4. _maybeBid (live rejection)    - the everBid / foreignSlotUncounted write
 *   5. _maybeBid (live rejection)    - the live bid_cap_exhausted revisionsLeft:0 write
 *   6. _maybeBid (uncertain outcome) - the disproved-on-portal revisionsLeft write
 *
 * Each site is driven twice: once on a healthy disk (no write-fault alert), once with the
 * scheduler's own persist layer failing. MUST NOT MOVE: whatever the engine already decided in
 * memory before the write - the whole point of ruling 18 - stands exactly as it does on a healthy
 * disk; only the alerting differs.
 *
 * Run: node scripts/test-bid-path-write-fault-alerts.js
 */
process.env.LOG_LEVEL = 'silent';
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bidpath-writefault-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

function mkScheduler() {
  const file = path.join(DATA_DIR, `intents-${process.pid}-${seq++}.json`);
  const s = new DurableScheduler(file);
  const realPersist = s._persist.bind(s);
  s.faulting = false; // flipped ON after arm() so the intent itself lands cleanly
  s._persist = () => {
    if (s.faulting) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return realPersist();
  };
  return s;
}

const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 3, closeModel: 'hard' });
const PRICING = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 };
const REMAINING_MS = 114 * 60 * 1000;
const meta = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL',
  units: 1, companyName: 'Acme Test Co', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000 });

function mkEngine(faulting, placeBid) {
  const events = [];
  const writeFailLogs = [];
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: placeBid || (async () => { throw new Error('placeBid not used in this scenario'); }),
  };
  const scheduler = mkScheduler();
  const log = {
    info() {}, warn() {}, debug() {},
    error(msg, facts) { if (msg === 'a durable write for this load failed') writeFailLogs.push(facts); },
  };
  const engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true,
    onEvent: (e) => events.push(e), log });
  const monitor = engine.arm(meta('L-' + seq), PRICING);
  if (monitor.timer) clearTimeout(monitor.timer);
  monitor.timer = null;
  scheduler.faulting = faulting; // the armed intent above always lands on a clean disk
  return { engine, events, writeFailLogs, monitor };
}

const kinds = (events, id) =>
  events.filter((e) => e.type === 'alert' && e.auctionId === id).map((e) => e.kind);
const failCount = (events, id) => kinds(events, id).filter((k) => k === 'bid_record_failed').length;

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3, closeModel: 'hard',
  measuredRttMs: 50, minDecrement: 100 });

(async () => {
  // -------------------------------------------------------------- site 1: _detectForeignBids
  {
    const good = mkEngine(false);
    const gotGood = good.engine._detectForeignBids(good.monitor, { myRank: 2, revisionLimit: 3 });
    assert.ok(gotGood, 'setup: the low-cap discount branch must actually run');
    assert.strictEqual(good.monitor.revisionsLeft, 2, 'setup: the discount applies in memory');
    assert.strictEqual(failCount(good.events, good.monitor.auctionId), 0,
      'control: a healthy write raises no write-fault alert');
    ok('1. control: _detectForeignBids raises no alert on a healthy write');

    const bad = mkEngine(true);
    const gotBad = bad.engine._detectForeignBids(bad.monitor, { myRank: 2, revisionLimit: 3 });
    assert.ok(gotBad, 'setup: the low-cap discount branch must actually run');
    assert.strictEqual(bad.monitor.revisionsLeft, 2,
      'the in-memory discount must stand exactly as it does on a healthy disk');
    assert.strictEqual(failCount(bad.events, bad.monitor.auctionId), 1,
      `a failed revisionsLeft write must reach the desk; saw ${JSON.stringify(kinds(bad.events, bad.monitor.auctionId))}`);
    ok('2. a failed write in _detectForeignBids reaches the desk, in-memory discount unchanged');
  }

  // ---------------------------------------------------- sites 2 + 3: _recordRefusedAfterRetire
  {
    const res = { accepted: false, status: 400, reason: 'Bid limit exceeded' };
    const decision = { price: 28_500, rungIndex: 2 };

    const good = mkEngine(false);
    good.engine._recordRefusedAfterRetire(good.monitor, decision, res, { closesInMs: 60_000 }, {}, 1);
    assert.strictEqual(good.monitor.revisionsLeft, 0, 'setup: bid_cap_exhausted zeros revisionsLeft in memory');
    assert.strictEqual(failCount(good.events, good.monitor.auctionId), 0,
      'control: a healthy write raises no write-fault alert');
    ok('3. control: _recordRefusedAfterRetire raises no write-fault alert on a healthy write');

    const bad = mkEngine(true);
    bad.engine._recordRefusedAfterRetire(bad.monitor, decision, res, { closesInMs: 60_000 }, {}, 1);
    assert.strictEqual(bad.monitor.revisionsLeft, 0,
      'the exhausted-cap latch must stand exactly as it does on a healthy disk');
    assert.strictEqual(bad.writeFailLogs.length, 2,
      `both the everBid write and the cap-exhausted write must actually attempt and fail; saw ${bad.writeFailLogs.length} failed-write log lines`);
    // _recordWriteFailed dedupes the DELIVERED alert by (monitor, kind) within one episode window
    // (see test-write-fault-alert-once-per-load.js) - two failed writes of the same kind on one load
    // in one call reach the desk once, not twice; each is still logged (asserted above).
    assert.strictEqual(failCount(bad.events, bad.monitor.auctionId), 1,
      `both failed writes must reach the desk at least once; saw ${JSON.stringify(kinds(bad.events, bad.monitor.auctionId))}`);
    ok('4. both failed writes in _recordRefusedAfterRetire (everBid, cap-exhausted) reach the desk');
  }

  // ------------------------------------------------------- sites 4 + 5: _maybeBid, live reject
  {
    const rejectCap = async () => ({ accepted: false, status: 400, reason: 'Bid limit exceeded' });

    const good = mkEngine(false, rejectCap);
    await good.engine._maybeBid(good.monitor, liveState());
    assert.strictEqual(good.monitor.revisionsLeft, 0, 'setup: the live cap rejection zeros revisionsLeft in memory');
    assert.strictEqual(failCount(good.events, good.monitor.auctionId), 0,
      'control: a healthy write raises no write-fault alert');
    ok('5. control: a live cap rejection raises no write-fault alert on a healthy write');

    const bad = mkEngine(true, rejectCap);
    await bad.engine._maybeBid(bad.monitor, liveState());
    assert.strictEqual(bad.monitor.revisionsLeft, 0,
      'the exhausted-cap latch must stand exactly as it does on a healthy disk');
    assert.strictEqual(bad.writeFailLogs.length, 2,
      `both the everBid write and the live cap write must actually attempt and fail; saw ${bad.writeFailLogs.length} failed-write log lines`);
    assert.strictEqual(failCount(bad.events, bad.monitor.auctionId), 1,
      `both failed writes must reach the desk at least once; saw ${JSON.stringify(kinds(bad.events, bad.monitor.auctionId))}`);
    ok('6. both failed writes on a live cap rejection (everBid, cap-exhausted) reach the desk');
  }

  // ---------------------------------------------------- site 6: _maybeBid, uncertain outcome
  {
    const throwing = async () => { throw new Error('socket hang up'); };
    const rbNoRevisionsLeft = async () => ({ ok: true, myRank: 2, myAmount: null });

    const good = mkEngine(false, throwing);
    good.engine.adapter.getAuctionState = rbNoRevisionsLeft;
    good.engine._confirmOwnBid = async () => false; // portal answered and never showed our price
    const revBefore = good.monitor.revisionsLeft;
    await good.engine._maybeBid(good.monitor, liveState());
    assert.strictEqual(good.monitor.revisionsLeft, revBefore - 1,
      'setup: a disproved-on-portal write still spends the revision in memory');
    assert.strictEqual(failCount(good.events, good.monitor.auctionId), 0,
      'control: a healthy write raises no write-fault alert');
    ok('7. control: the disproved-on-portal write raises no alert on a healthy write');

    const bad = mkEngine(true, throwing);
    bad.engine.adapter.getAuctionState = rbNoRevisionsLeft;
    bad.engine._confirmOwnBid = async () => false;
    const revBeforeBad = bad.monitor.revisionsLeft;
    await bad.engine._maybeBid(bad.monitor, liveState());
    assert.strictEqual(bad.monitor.revisionsLeft, revBeforeBad - 1,
      'the spent revision must stand exactly as it does on a healthy disk');
    assert.strictEqual(failCount(bad.events, bad.monitor.auctionId), 1,
      `the disproved-on-portal write must reach the desk; saw ${JSON.stringify(kinds(bad.events, bad.monitor.auctionId))}`);
    ok('8. a failed disproved-on-portal write reaches the desk, spent revision unchanged');
  }

  console.log(`\nPASS ${pass}/8 checks passed`);
})().catch((e) => {
  console.error('FAIL: bid-path write-fault alerts: ' + (e && e.stack));
  process.exit(1);
});
