'use strict';
/**
 * The "not bidding this load: closing time missing" alert names the load's lane, customer and branch.
 *
 * The desk reads this alert to bid the load by hand, so it has to say which load it is. The alert was
 * pinned for its text but not for the fields that identify the load (mutation critique, PR-1).
 *
 *   node scripts/test-close-unknown-alert-names-load.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const file = path.join(os.tmpdir(), `close-unknown-${process.pid}.json`);
let eng = null;
process.on('exit', () => {
  try { if (eng) eng.kill(); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
});

(async () => {
  const events = [];
  eng = new BidEngine({
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must never be reached here'); },
  }, new DurableScheduler(file), { config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 }, onEvent: (e) => events.push(e) });

  const lane = { origin: 'PUNE', destination: 'NAGPUR' };
  eng._holdUnknownClose({ auctionId: 'CU1', status: 'scheduled', closesAt: null, lane, companyName: 'Tata Steel', branchName: 'PUNE' });
  const a = events.find((e) => e.kind === 'close_unknown_held');
  assert.ok(a, `no close_unknown_held alert, events: ${JSON.stringify(events)}`);
  assert.deepStrictEqual({ lane: a.lane, companyName: a.companyName, branchName: a.branchName },
    { lane, companyName: 'Tata Steel', branchName: 'PUNE' }, `the alert does not name the load: ${JSON.stringify(a)}`);
  console.log('  ok  1. the close-unknown alert carries the lane, customer and branch');
  console.log('\n1/1 checks passed');
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exitCode = 1; });
