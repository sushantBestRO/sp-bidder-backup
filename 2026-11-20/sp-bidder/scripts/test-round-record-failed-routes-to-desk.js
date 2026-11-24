'use strict';
/**
 * A failed round-record write reaches the error channel, once per episode.
 *
 * The round tracker (ruling 56) persists its round count on the intent, and a failed write raises
 * round_record_failed through _recordWriteFailed (ruling 18). engineAlerts routes only the kinds it
 * lists, so a kind missing from the error set is dropped in silence: the desk would never hear that a
 * restart could misjudge the final round.
 *
 *   1. the engine's round_record_failed alert, driven through _tick with the disk failing, becomes an
 *      error-channel notification carrying the engine's own copy.
 *   2. its dedupe key carries the episode, like bid_record_failed, so a later episode on the same load
 *      is not swallowed by the mark an earlier one left.
 *
 *   node scripts/test-round-record-failed-routes-to-desk.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

const EXPECTED_CHECKS = 2;
let pass = 0;
const file = path.join(os.tmpdir(), `round-record-routes-${process.pid}.json`);
let eng = null;
process.on('exit', () => {
  try { if (eng) eng.kill(); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
  try { fs.unlinkSync(`${file}.tmp`); } catch (_) {}
  if (pass !== EXPECTED_CHECKS) { console.log(`FAIL: ${pass}/${EXPECTED_CHECKS} checks passed`); process.exitCode = 1; }
  else console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
});

(async () => {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  const close = vnow + 300_000;
  let frameClose = close;
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 10, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: frameClose,
      closesInMs: frameClose - Date.now(), extendMs: 120_000, extendCount: 3, triggerWindowMs: 100_000, myRank: 1,
      totalBidders: 4, standingL1Price: null, revisionLimit: 10, revisionsLeft: null, minDecrement: 100 }),
    placeBid: async () => { throw new Error('no wire write may happen in this test'); },
  };
  const sched = new DurableScheduler(file);
  eng = new BidEngine(adapter, sched, {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, cadenceJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: (e) => events.push(e),
  });
  const m = eng.arm({ id: 'RRF-1', lane: { origin: 'NAGPUR', destination: 'Raipur' }, units: 1,
    companyName: 'Transrail Lighting Ltd', closesAt: close }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  const tick = async () => { await eng._tick(m); if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  const persist = sched._persist.bind(sched);
  sched._persist = () => { throw new Error('EIO: simulated disk fault'); };
  vnow = close - 30_000;
  frameClose = close + 120_000;
  await tick();
  sched._persist = persist;
  Date.now = REAL_NOW;

  const raised = events.filter((e) => e.type === 'alert' && e.kind === 'round_record_failed');
  assert.strictEqual(raised.length, 1, `FIXTURE: ${raised.length} round_record_failed alerts, expected the one for this write`);
  const n = toNotification(raised[0]);
  assert.ok(n && n.kind === 'error',
    `round_record_failed routed as ${n ? n.kind : 'nothing'} - a failed round-record write reaches nobody`);
  assert.strictEqual(n.data.detail, raised[0].detail, 'the notification does not carry the engine\'s own copy');
  console.log('  ok  1. round_record_failed reaches the error channel with the engine\'s copy');
  pass++;

  assert.ok(n.dedupeKey.endsWith(`_${raised[0].episode}`),
    `dedupe key ${n.dedupeKey} does not carry the episode ${raised[0].episode}`);
  console.log('  ok  2. its dedupe key carries the episode');
  pass++;
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exitCode = 1; });
