'use strict';
/**
 * AFTER A FAILED DURABLE WRITE, THE ENGINE CARRIES ON EXACTLY AS A HEALTHY WRITE WOULD.
 *
 * Regression target: T5 F4 (accepted path in _maybeBid), T5 F5 (the uncertain-outcome handler),
 * T7 E6 (_finalize) and the retired-load banker _recordLandedAfterRetire. Each wraps its
 * scheduler.update; on failure it logs, emits one error-level alert naming the load, and then must
 * run the rest of its body unchanged. The four sibling files pin that the failure is contained and
 * reported:
 *   scripts/test-accepted-bid-persist-fault-books-once.js
 *   scripts/test-uncertain-outcome-persist-fault-contained.js
 *   scripts/test-finalize-persist-fault-still-emits-result.js
 *   scripts/test-retired-accept-persist-fault-contained.js
 * This file pins what happens AFTER the catch, which none of them observes:
 *
 *   1-2. The in-memory booking (landedBids, revisionsLeft, currentRungIndex, firedRungs,
 *        lastBidPrice, quantityRefused) equals the healthy run on the accepted path and in the
 *        handler. Un-banking the rung re-fires a bid that may be on the board; forgetting
 *        lastBidPrice lets the engine re-offer above its own standing bid.
 *   3.   A retired load whose successor was re-armed mid-submit still hands the landed bid to the
 *        successor. Skipping that leaves the successor believing it has never bid.
 *   4.   The handler still clears a quantity stand-down and sends the vehicle-count notice.
 *   5.   No filesystem path, file name, data dir or errno reaches ANY string of ANY emitted event
 *        or its notification, on any of the four sites. `context` and extra event fields reach
 *        the desk and the console feed, so scanning `detail` alone is not enough.
 *   6.   A failed bid write and a failed close write on the same load are two desk messages with
 *        distinct dedupe keys. The notifier's dedupe is persistent, so a shared key swallows the
 *        close alert for good.
 *   7.   A lost close with nothing landed still emits auction_result and never_bid_before_close.
 *
 * WHAT MUST NOT MOVE:
 *   - every check compares against an in-file healthy-disk control run of the same scenario, and
 *     every fault run asserts its fault actually fired, so a harness that stops faulting goes red.
 *   - error-channel alert counts are exact: the control's alerts plus one per failed write site.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on temp files
 * whose persist throws EACCES once the fault is on, no network, no sleeps. Date.now is frozen
 * around the clamped multi-vehicle tick.
 *
 *   node scripts/test-durable-write-fault-carry-on.js
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-fault-carry-on-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;
const tmp = () => path.join(DATA_DIR, `carry-on-intents-${process.pid}-${seq++}.json`);

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const silent = { debug() {}, info() {}, warn() {}, error() {} };
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

function mkScheduler(file) {
  const s = new DurableScheduler(file);
  const realPersist = s._persist.bind(s);
  s.faulting = false;
  s.faultHits = 0;
  s._persist = () => {
    if (s.faulting) {
      s.faultHits++;
      const e = new Error(`EACCES: permission denied, open '${file}.tmp'`);
      e.code = 'EACCES'; e.errno = -13; e.syscall = 'open'; e.path = `${file}.tmp`;
      throw e;
    }
    return realPersist();
  };
  return s;
}

const disarm = (m) => { if (m.timer) clearTimeout(m.timer); m.timer = null; };
const BOOK = ['landedBids', 'revisionsLeft', 'currentRungIndex', 'firedRungs', 'lastBidPrice', 'quantityRefused'];
const book = (engine, id) => {
  const r = engine.snapshot().find((x) => x.auctionId === id);
  const o = {};
  for (const k of BOOK) o[k] = r ? r[k] : '(gone)';
  return o;
};
const errorChannel = (events) => events.filter((e) => { const n = toNotification(e); return !!n && n.kind === 'error'; });
const errorKinds = (events) => errorChannel(events).map((e) => e.kind).sort();
const alertKinds = (events) => events.filter((e) => e.type === 'alert').map((e) => e.kind).sort();
const plus = (base, ...extra) => [...base, ...extra].sort();

function allStrings(v, out = [], seen = new Set()) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && !seen.has(v)) {
    seen.add(v);
    for (const k of Object.keys(v)) { out.push(k); allStrings(v[k], out, seen); }
  }
  return out;
}

// Substring checks on the raw strings: JSON.stringify doubles Windows backslashes, so a full-path
// needle would never match a serialised payload.
function assertNoLeak(label, file, events) {
  const needles = [file, `${file}.tmp`, path.basename(file), DATA_DIR, path.basename(DATA_DIR), os.tmpdir(), 'EACCES'];
  for (const e of events) {
    for (const s of allStrings([e, toNotification(e)])) {
      for (const p of needles) {
        assert.ok(!s.includes(p),
          `${label}: a ${e.type}/${e.kind || '-'} event or its notification carries "${p}" in ${JSON.stringify(s)}`);
      }
    }
  }
}

// One armed single-truck load, one bid, then _finalize on the same load. `fault` switches the disk
// fault on inside placeBid and leaves it on through the close.
async function bidThenClose({ outcome, fault, id }) {
  const file = tmp();
  const scheduler = mkScheduler(file);
  const events = [];
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      scheduler.faulting = fault;
      if (outcome === 'network') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true, onEvent: (e) => events.push(e), log: silent });
  const m = engine.arm(META(id), PRICING);
  disarm(m);
  let escaped = null;
  try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = e; }
  const afterBid = { book: book(engine, id), events: events.slice(), faultHits: scheduler.faultHits };
  try { await engine._finalize(m, liveState()); } catch (e) { escaped = escaped || e; }
  scheduler.faulting = false;
  const out = { file, escaped, afterBid, events: events.slice(), faultHits: scheduler.faultHits };
  engine.kill('done');
  return out;
}

// Retired-load door: inside placeBid the load is stopped and a successor re-armed with the same
// meta and pricing, and only then does the disk fault start, so arm()'s own write succeeds.
async function retiredReArm(fault) {
  const id = 'CO-RET1';
  const file = tmp();
  const scheduler = mkScheduler(file);
  const events = [];
  let engine = null;
  let successor = null;
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      engine.stop(id);
      successor = engine.arm(META(id), PRICING);
      disarm(successor);
      scheduler.faulting = fault;
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
  engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true, onEvent: (e) => events.push(e), log: silent });
  const m = engine.arm(META(id), PRICING);
  disarm(m);
  let escaped = null;
  try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = e; }
  scheduler.faulting = false;
  const live = engine.monitors.get(id);
  const out = {
    file, escaped, events: events.slice(), faultHits: scheduler.faultHits,
    isSuccessor: !!successor && live === successor,
    successor: live ? { landedBids: live.landedBids, lastBidPrice: live.lastBidPrice, revisionsLeft: live.revisionsLeft } : null,
  };
  engine.kill('done');
  return out;
}

// Multi-vehicle load in a quantity stand-down engaged at 5; this tick clamps to 2, so it may fire.
// The submit throws on the transport leg, which routes into the uncertain-outcome handler.
async function clampedHandler(fault) {
  const id = 'CO-QTY1';
  const file = tmp();
  const scheduler = mkScheduler(file);
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { scheduler.faulting = fault; throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' }); },
  };
  const engine = new BidEngine(adapter, scheduler, { config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    onEvent: (e) => events.push(e), log: silent });
  const m = engine.arm({ id, lane: { origin: 'Indi', destination: 'Maharashtra' }, units: 5, quoteType: 'FTL',
    bidVehicleCount: null, equipment: 'Trailer Flat Bed (FBT)', companyName: 'KEI Industries Ltd',
    branchName: 'Chopanki', closesAt: Date.now() + 600_000 }, { cost: 106_000, marginsPct: [12.6, 7.2, 7] });
  disarm(m);
  m.ladder = [119356, 113632, 113420]; m.floor = 113420; m.closeModel = 'hard'; m.revisionsLeft = 3;
  m.quantityRefused = true; m.quantityRefusedAtVcq = 5;
  const REAL_NOW = Date.now;
  const frozen = REAL_NOW();
  Date.now = () => frozen;
  let escaped = null;
  try {
    await engine._maybeBid(m, { closesInMs: 20_000, myRank: null, minDecrement: 100, standingL1Price: null,
      measuredRttMs: 50, remainingQuantity: 2 });
  } catch (e) { escaped = e; } finally { Date.now = REAL_NOW; }
  scheduler.faulting = false;
  const out = { file, escaped, events: events.slice(), faultHits: scheduler.faultHits,
    landedBids: m.landedBids, quantityRefused: m.quantityRefused };
  engine.kill('done');
  return out;
}

// A LOST close with nothing ever bid: final rank 3, the fault on for the close write only.
async function lostZeroLandedClose(fault) {
  const id = 'CO-LOST1';
  const file = tmp();
  const scheduler = mkScheduler(file);
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'closed', myRank: 3, totalBidders: 3, closesInMs: 0,
      revisionLimit: 3, revisionsLeft: null }),
    placeBid: async () => { throw new Error('this scenario never bids'); },
  };
  const engine = new BidEngine(adapter, scheduler, { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    onEvent: (e) => events.push(e), log: silent });
  const m = engine.arm({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Waaree Energies', closesAt: Date.now() + 600_000, startsAt: Date.now() - 1_000 },
  { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
  disarm(m);
  scheduler.faulting = fault;
  let escaped = null;
  try { await engine._finalize(m, { myRank: 3 }); } catch (e) { escaped = e; }
  scheduler.faulting = false;
  const results = events.filter((e) => e.type === 'auction_result')
    .map((e) => ({ won: e.won, finalRank: e.finalRank, landedBids: e.landedBids, routedAs: (toNotification(e) || {}).kind }));
  const out = { file, escaped, events: events.slice(), faultHits: scheduler.faultHits, results };
  engine.kill('done');
  return out;
}

(async () => {
  const runs = {};
  for (const outcome of ['accept', 'network']) {
    runs[outcome] = {
      control: await bidThenClose({ outcome, fault: false, id: `CO-${outcome}` }),
      fault: await bidThenClose({ outcome, fault: true, id: `CO-${outcome}` }),
    };
  }
  const label = { accept: 'accepted path', network: 'uncertain-outcome handler' };

  let n = 1;
  for (const outcome of ['accept', 'network']) {
    const { control: c, fault: f } = runs[outcome];
    assert.strictEqual(c.escaped, null, `${label[outcome]} control: escaped ${c.escaped && c.escaped.message}`);
    assert.strictEqual(c.afterBid.book.landedBids, 1, `${label[outcome]} control: landedBids ${c.afterBid.book.landedBids}`);
    assert.ok(f.afterBid.faultHits > 0, `${label[outcome]}: precondition - the bid write never hit the fault`);
    assert.strictEqual(f.escaped, null, `${label[outcome]}: a failed write escaped: ${f.escaped && f.escaped.message}`);
    assert.deepStrictEqual(f.afterBid.book, c.afterBid.book,
      `${label[outcome]}: booking under the write fault ${JSON.stringify(f.afterBid.book)} differs from healthy ${JSON.stringify(c.afterBid.book)}`);
    assert.deepStrictEqual(errorKinds(f.afterBid.events), plus(errorKinds(c.afterBid.events), 'bid_record_failed'),
      `${label[outcome]}: error channel after the bid is not the healthy set plus exactly one bid_record_failed`);
    ok(n++, `${label[outcome]}: booking under the write fault equals healthy ${JSON.stringify(c.afterBid.book)}, one bid_record_failed`);
  }

  const rc = await retiredReArm(false);
  const rf = await retiredReArm(true);
  assert.strictEqual(rc.isSuccessor, true, 'retired control: precondition - the re-armed successor is the live monitor');
  assert.strictEqual(rc.successor.landedBids, 1, `retired control: successor landedBids ${rc.successor.landedBids}`);
  assert.deepStrictEqual(errorKinds(rc.events), [], `retired control: error channel ${errorKinds(rc.events)}`);
  assert.ok(rf.faultHits > 0, 'retired: precondition - the retired-load write never hit the fault');
  assert.strictEqual(rf.escaped, null, `retired: a failed write escaped: ${rf.escaped && rf.escaped.message}`);
  assert.strictEqual(rf.isSuccessor, true, 'retired: the live monitor is not the re-armed successor');
  assert.deepStrictEqual(rf.successor, rc.successor,
    `retired: successor after a failed write ${JSON.stringify(rf.successor)} vs healthy ${JSON.stringify(rc.successor)}`);
  assert.deepStrictEqual(errorKinds(rf.events), ['bid_record_failed'], `retired: error channel ${errorKinds(rf.events)}`);
  ok(n++, `retired load: successor inherits the landed bid after the failed write ${JSON.stringify(rf.successor)}`);

  const qc = await clampedHandler(false);
  const qf = await clampedHandler(true);
  assert.strictEqual(qc.escaped, null, `clamp control: escaped ${qc.escaped && qc.escaped.message}`);
  assert.strictEqual(qc.landedBids, 1, `clamp control: landedBids ${qc.landedBids}`);
  assert.strictEqual(qc.quantityRefused, false, 'clamp control: stand-down not cleared');
  assert.deepStrictEqual(alertKinds(qc.events), ['bid_submit_error', 'vehicle_count_clamped'],
    `clamp control: alerts ${alertKinds(qc.events)}`);
  assert.ok(qf.faultHits > 0, 'clamp: precondition - the handler write never hit the fault');
  assert.strictEqual(qf.escaped, null, `clamp: a failed write escaped: ${qf.escaped && qf.escaped.message}`);
  assert.strictEqual(qf.quantityRefused, false,
    'handler under the write fault left the quantity stand-down engaged on a load it counted a bid for');
  assert.deepStrictEqual(alertKinds(qf.events), plus(alertKinds(qc.events), 'bid_record_failed'),
    `handler under the write fault: alerts ${alertKinds(qf.events)} vs healthy ${alertKinds(qc.events)} plus bid_record_failed`);
  ok(n++, `handler tail runs after the failed write: stand-down cleared, alerts ${alertKinds(qf.events).join(', ')}`);

  const lc = await lostZeroLandedClose(false);
  const lf = await lostZeroLandedClose(true);

  for (const outcome of ['accept', 'network']) {
    const f = runs[outcome].fault;
    assertNoLeak(`${label[outcome]} + close`, f.file, f.events);
  }
  assertNoLeak('retired load', rf.file, rf.events);
  assertNoLeak('clamped handler', qf.file, qf.events);
  assertNoLeak('lost close', lf.file, lf.events);
  ok(n++, 'no path, file name, data dir or errno in any event or notification on all four write sites');

  for (const outcome of ['accept', 'network']) {
    const { control: c, fault: f } = runs[outcome];
    assert.ok(f.faultHits > f.afterBid.faultHits, `${label[outcome]}: precondition - the close write never hit the fault`);
    const keys = errorChannel(f.events).map((e) => toNotification(e).dedupeKey);
    assert.strictEqual(new Set(keys).size, keys.length,
      `${label[outcome]}: two error alerts on one load share a dedupeKey: ${keys.join(', ')}`);
    assert.strictEqual(keys.length, errorChannel(c.events).length + 2,
      `${label[outcome]}: expected the healthy error alerts plus one bid-write and one close-write alert, got ${keys.join(', ')}`);
  }
  ok(n++, 'a failed bid write and a failed close write on one load reach the desk under distinct dedupe keys');

  assert.strictEqual(lc.escaped, null, `lost control: escaped ${lc.escaped && lc.escaped.message}`);
  assert.strictEqual(lc.results.length, 1, `lost control: ${lc.results.length} auction_result`);
  assert.ok(alertKinds(lc.events).includes('never_bid_before_close'), `lost control: alerts ${alertKinds(lc.events)}`);
  assert.ok(lf.faultHits > 0, 'lost close: precondition - the close write never hit the fault');
  assert.strictEqual(lf.escaped, null, `lost close: a failed write escaped: ${lf.escaped && lf.escaped.message}`);
  assert.deepStrictEqual(lf.results, lc.results,
    `lost close under the write fault: auction_result ${JSON.stringify(lf.results)} vs healthy ${JSON.stringify(lc.results)}`);
  assert.deepStrictEqual(alertKinds(lf.events), plus(alertKinds(lc.events), 'close_record_failed'),
    `lost close under the write fault: alerts ${alertKinds(lf.events)} vs healthy ${alertKinds(lc.events)} plus close_record_failed`);
  ok(n++, `lost zero-landed close under the write fault: same auction_result, alerts ${alertKinds(lf.events).join(', ')}`);

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(unhandled, 0, `${unhandled} unhandled rejection(s)`);

  console.log(`\nPASS - ${pass} checks`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e && e.message ? e.message : e); process.exit(1); });
