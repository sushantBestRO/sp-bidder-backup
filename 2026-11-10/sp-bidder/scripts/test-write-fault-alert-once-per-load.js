'use strict';
/**
 * A SUSTAINED DURABLE-WRITE FAULT TELLS THE DESK ONCE PER LOAD, NOT ONCE PER FAILED WRITE.
 *
 * Regression target: the persist-failure alerts added for T5 F4, T5 F5 and T7 E6
 * (bid_record_failed on the three bid sites, close_record_failed at close). Their only repeat
 * guard used to be the notifier's dedupe mark, and that mark is written to the same data volume
 * whose failure raised the alert. On a full or read-only disk the mark never lands, so every
 * further failed bid write on the load sent the Director another identical message.
 *
 * WHAT MUST NOT MOVE:
 *   - every failed write is still logged with its raw error, once per write.
 *   - a failed close write after failed bid writes is still reported: it is a different kind.
 *   - the guard is per load: a second load hitting the same fault gets its own alert.
 *   - on a healthy disk nothing reaches the error channel.
 *
 *   node scripts/test-write-fault-alert-once-per-load.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-fault-once-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

const REMAINING_MS = 114 * 60 * 1000;
const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});
const META = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });
const PRICING = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 };
const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 3, closeModel: 'hard' });

function mkScheduler() {
  const file = path.join(DATA_DIR, `once-intents-${process.pid}-${seq++}.json`);
  const s = new DurableScheduler(file);
  const realPersist = s._persist.bind(s);
  s.faulting = false;
  s.faultHits = 0;
  s._persist = () => {
    if (s.faulting) {
      s.faultHits++;
      const e = new Error(`EACCES: permission denied, open '${file}.tmp'`);
      e.code = 'EACCES';
      throw e;
    }
    return realPersist();
  };
  return s;
}

const errorAlerts = (events, id) => events.filter((e) => {
  const n = toNotification(e);
  return !!n && n.kind === 'error' && e.auctionId === id;
}).map((e) => e.kind).sort();

// `outcomes` is the submit result per bid, in order: 'accept' or 'network' (the transport throw
// that routes into the uncertain-outcome handler). The fault turns on at the first submit and
// stays on. Two loads share the engine when `ids` has two entries; they bid alternately.
async function run({ fault, outcomes, ids = ['ONCE-1'], close = false }) {
  const scheduler = mkScheduler();
  const events = [];
  const writeFailLogs = [];
  let calls = 0;
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      const outcome = outcomes[calls++];
      if (fault) scheduler.faulting = true;
      if (outcome === 'network') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 };
    },
  };
  const log = {
    debug() {}, info() {}, warn() {},
    error(msg, facts) { if (msg === 'a durable write for this load failed') writeFailLogs.push(facts); },
  };
  const engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true, onEvent: (e) => events.push(e), log });
  const monitors = ids.map((id) => {
    const m = engine.arm(META(id), PRICING);
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    return m;
  });
  let escaped = null;
  for (let i = 0; i < outcomes.length; i++) {
    const m = monitors[i % monitors.length];
    try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = escaped || e; }
  }
  if (close) {
    for (const m of monitors) {
      try { await engine._finalize(m, liveState()); } catch (e) { escaped = escaped || e; }
    }
  }
  const landed = monitors.map((m) => m.landedBids);
  scheduler.faulting = false;
  engine.kill('done');
  return { events, writeFailLogs, calls, faultHits: scheduler.faultHits, escaped, landed };
}

(async () => {
  console.log('\nA sustained write fault reaches the desk once per load and kind\n');

  const healthy = await run({ fault: false, outcomes: ['accept', 'accept'], close: true });
  assert.strictEqual(healthy.calls, 2, `harness: the healthy run placed ${healthy.calls} bids, expected 2`);
  assert.deepStrictEqual(healthy.landed, [2], `harness: healthy landed ${JSON.stringify(healthy.landed)}`);
  assert.deepStrictEqual(errorAlerts(healthy.events, 'ONCE-1'), [],
    `a healthy disk put ${JSON.stringify(errorAlerts(healthy.events, 'ONCE-1'))} on the error channel`);
  ok(1, 'control: two bids and a close on a healthy disk, nothing on the error channel');

  const acc = await run({ fault: true, outcomes: ['accept', 'accept'] });
  assert.strictEqual(acc.escaped, null, `accepted path: a failed write escaped: ${acc.escaped && acc.escaped.message}`);
  assert.strictEqual(acc.faultHits, 2, `harness: expected 2 failed writes, got ${acc.faultHits}`);
  assert.deepStrictEqual(acc.landed, [2], `accepted path: landed ${JSON.stringify(acc.landed)}, expected [2]`);
  assert.deepStrictEqual(errorAlerts(acc.events, 'ONCE-1'), ['bid_record_failed'],
    `accepted path: two failed bid writes on one load sent ${JSON.stringify(errorAlerts(acc.events, 'ONCE-1'))} to the desk; the notifier's dedupe mark cannot land on the failing disk, so the engine must send it once`);
  ok(2, 'accepted path: two failed bid writes on one load, one desk alert');

  assert.strictEqual(acc.writeFailLogs.length, 2,
    `every failed write must still be logged: ${acc.writeFailLogs.length} log lines for 2 failed writes`);
  assert.ok(acc.writeFailLogs.every((f) => f && /EACCES/.test(f.err)), 'the log line must carry the raw error');
  ok(3, 'each failed write is still logged with its raw error');

  const hnd = await run({ fault: true, outcomes: ['network', 'network'] });
  assert.strictEqual(hnd.escaped, null, `handler: a failed write escaped: ${hnd.escaped && hnd.escaped.message}`);
  assert.strictEqual(hnd.faultHits, 2, `harness: expected 2 failed writes, got ${hnd.faultHits}`);
  assert.deepStrictEqual(errorAlerts(hnd.events, 'ONCE-1'), ['bid_record_failed'],
    `uncertain-outcome handler: two failed bid writes on one load sent ${JSON.stringify(errorAlerts(hnd.events, 'ONCE-1'))} to the desk`);
  ok(4, 'uncertain-outcome handler: two failed bid writes on one load, one desk alert');

  const mixed = await run({ fault: true, outcomes: ['accept', 'network'], close: true });
  assert.strictEqual(mixed.escaped, null, `mixed: a failed write escaped: ${mixed.escaped && mixed.escaped.message}`);
  assert.strictEqual(mixed.faultHits, 3, `harness: expected 3 failed writes (two bids, one close), got ${mixed.faultHits}`);
  assert.deepStrictEqual(errorAlerts(mixed.events, 'ONCE-1'), ['bid_record_failed', 'close_record_failed'],
    `accepted then handler then close on one load sent ${JSON.stringify(errorAlerts(mixed.events, 'ONCE-1'))}; expected one bid alert and the close alert`);
  ok(5, 'bid writes across both sites alert once, and the failed close write is still reported');

  const two = await run({ fault: true, outcomes: ['accept', 'accept', 'accept', 'accept'], ids: ['ONCE-A', 'ONCE-B'] });
  assert.strictEqual(two.escaped, null, `two loads: a failed write escaped: ${two.escaped && two.escaped.message}`);
  assert.strictEqual(two.faultHits, 4, `harness: expected 4 failed writes, got ${two.faultHits}`);
  assert.deepStrictEqual(errorAlerts(two.events, 'ONCE-A'), ['bid_record_failed'],
    `load A sent ${JSON.stringify(errorAlerts(two.events, 'ONCE-A'))}`);
  assert.deepStrictEqual(errorAlerts(two.events, 'ONCE-B'), ['bid_record_failed'],
    `load B sent ${JSON.stringify(errorAlerts(two.events, 'ONCE-B'))}: the guard must be per load, not engine-wide`);
  ok(6, 'two loads under the same fault each get their own single alert');

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', e.message);
  process.exit(1);
});
