'use strict';
/**
 * When the spent attempt of a write the portal never showed cannot be saved, the desk is told.
 *
 * A write whose transport failed and whose read-back never showed our price is not booked. Its
 * revision stays spent in memory, and is saved to the intent so a restart keeps it spent. A failed
 * save of that count was swallowed, so a restart would restore one attempt too many, and nobody would
 * know. Every other failed save on this path raises bid_record_failed; this one must too. Price-page
 * gate, bucket 2.
 *
 *   node scripts/test-disproved-write-revision-save-failure-alerts.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const file = path.join(os.tmpdir(), `disproved-rev-save-${process.pid}.json`);
process.on('exit', () => { for (const f of [file, file + '.tmp']) { try { fs.unlinkSync(f); } catch (_) {} } });

const REMAINING_MS = 114 * 60 * 1000;

(async () => {
  const wire = [];
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3,
      closeModel: 'hard', ownBidAmountVisible: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3, closeModel: 'hard', measuredRttMs: 50,
      minDecrement: 100, myAmount: null }),
    placeBid: async (_id, price) => {
      wire.push(price);
      throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
    },
  };
  const scheduler = new DurableScheduler(file);
  const events = [];
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: silent,
  });
  const m = engine.arm({ id: 'DRS1', lane: { origin: 'Khopoli', destination: 'Gajsinghpur' }, equipment: 'Trailer 40',
    units: 1, companyName: 'Renewsys', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
    status: 'live', softClose: false }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;

  const update = scheduler.update.bind(scheduler);
  scheduler.update = (id, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'revisionsLeft')) throw new Error('EIO: disk full');
    return update(id, patch);
  };
  try {
    await engine._maybeBid(m, await adapter.getAuctionState());
    assert.strictEqual(wire.length, 1, `setup: expected one write, got ${wire.length}`);
    assert.strictEqual(m.landedBids, 0, 'setup: the disproved write was booked');
    const alert = events.find((e) => e.type === 'alert' && e.level === 'error' && e.kind === 'bid_record_failed');
    assert.ok(alert, `the failed save of the spent attempt raised nothing; alerts: ${JSON.stringify(events.filter((e) => e.type === 'alert').map((e) => e.kind))}`);
    console.log('  ok  1. a failed save of the spent attempt raises bid_record_failed');
    console.log('\n1/1 checks passed');
  } finally { engine.kill('done'); }
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
