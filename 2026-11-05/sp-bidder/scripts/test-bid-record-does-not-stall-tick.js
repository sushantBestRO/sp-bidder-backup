'use strict';
/**
 * A CLOSED-BIDS WRITE MUST NOT STALL THE HOT TICKS.
 *
 * Regression target: the ~1.1s blind spot after every accepted bid. Production box logs
 * (24 Sep 2026): the hot-phase tick gap around a bid ran p50 1,103ms against 201ms everywhere else
 * (n=378 vs 17,521), where the engine's own hot cadence is pollHotMs = 200ms.
 *
 * The mechanism, in plain words. The engine emits an event (bid_placed, bid_rejected, armed), the
 * server hands every engine event to the bid logger, and the logger reads the closed-bids record and
 * writes it back. The file store behind that re-reads and parses the WHOLE closed-bids collection on
 * every read and pretty-prints and rewrites the whole file on every write, on the same thread as
 * every monitor's tick timer. The collection only grows, so the stall grows with it: on the box it is
 * a 12.5MB file and the snipe window goes dark for about a second - right after we bid, right after
 * a refusal when the next decision matters most, and on every other armed load too.
 *
 * Three scenarios, each a real BidEngine on its real timer against a fake adapter, with a real
 * BidLogger on a real FileStore holding a large synthetic closed-bids collection, wired the way the
 * server wires onEvent:
 *   accepted    - tick TRIGGER_TICK fires the opening rung and the adapter accepts it.
 *   rejected    - the same write is refused with a price-class answer (logged as bid_rejected; the
 *                 load is not stood down).
 *   cross_load  - load A sits in its hot window without bidding; at A's tick TRIGGER_TICK a second
 *                 load B arms, and B's `armed` record goes through the logger.
 * In each, none of the intervals between the AFTER_TRIGGER_TICKS hot ticks that follow the trigger may
 * stall. Ten ticks rather than one, because moving the same work a tick later still blinds the snipe
 * window.
 *
 * A stall is an interval that is BOTH late on the wall clock (longer than pollHotMs + SLACK_MS) AND
 * one in which this process's event-loop thread was busy for more than SLACK_MS (event-loop
 * utilization: time not spent waiting in the poll). The defect holds the thread for ~1s, so it is
 * both. A loaded machine that simply does not schedule the process makes an interval late while the
 * thread sat idle waiting for its timer; that is the machine, not the store, and a wall-clock-only
 * bound failed on it (500ms under the full suite, 314-3742ms on the tiny-store control beside 32
 * busy loops). The work a stall is made of costs the same thread time however loaded the machine is.
 * A design that keeps the thread busy but the ticks on time is not constrained.
 *
 * SLACK_MS is 100ms, from the production target (gap <= pollHotMs + 100). The collection is scaled so
 * the local stall is at least the box's (~1.1s), so the box target applies here unchanged.
 *
 * Controls, all asserted: the busy meter counts a known 150ms hold and not a 150ms wait; the three
 * scenarios on a tiny store do not stall on the current code (the stall scales with the collection
 * and is not engine work); and a hot tick with no write does not stall on the large store.
 *
 * WHAT MUST NOT MOVE:
 *   - the trigger really happens before any gap is judged: exactly the opening rung reaches the
 *     adapter and the engine emits bid_placed (accepted) or bid_rejected (rejected) for it; load B
 *     emits armed and nothing goes on the wire (cross_load).
 *   - nothing here constrains HOW the record is kept (cache, async, another format); only that the
 *     ticks run on schedule.
 *
 * Offline: fake adapter, synthetic records only, temp store under os.tmpdir() removed at the end.
 * The engine's timer is the unit under test, so it runs for real; nothing else sleeps.
 *
 *   node scripts/test-bid-record-does-not-stall-tick.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp collection file), not app state
const path = require('path');
const assert = require('assert');
const { performance } = require('perf_hooks');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { FileStore } = require('../src/store/fileStore');

const EXPECTED_CHECKS = 13;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const SLACK_MS = 100;
const METER_MS = 150;
const BIG_RECORDS = 40_000;
const TINY_RECORDS = 5;
const COST = 100_000;
const BAND = [9, 5, 1];
const OPENING = 109_000;
const OPEN_AT_MS = 8_000;
const WAIT_REMAINING_MS = 9_000;
const BID_REMAINING_MS = 7_900;
const FAR_REMAINING_MS = 30 * 60 * 1000;
const TRIGGER_TICK = 3;
const AFTER_TRIGGER_TICKS = 10;
const RUN_GUARD_MS = 20_000;
const REFUSAL = 'Invalid quote amount.';
const SCENARIOS = ['accepted', 'rejected', 'cross_load'];

const DIRS = [];
const cleanup = () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };

const CITIES = [
  ['Palghar', 'Maharashtra 401404'], ['Jaipur', 'Rajasthan 302013'], ['Kakinada', 'Andhra Pradesh 533003'],
  ['Chikhli', 'Gujarat 396521'], ['Haridwar', 'Uttarakhand 249403'], ['Kottayam', 'Kerala 686122'],
  ['Neemrana', 'Rajasthan 301705'], ['Hosur', 'Tamil Nadu 635126'], ['Sanand', 'Gujarat 382110'],
];
const SHIPPERS = ['Waaree Energies Ltd.', 'Havells India Ltd', 'Kingspan Jindal Pvt Ltd', 'Parijat Industries', 'KEI Industries'];
const EQUIPMENT = ['32 ft MXL', '20 ft SXL', '40 ft Trailer', '19 ft Open', '24 ft Container'];

function syntheticRecord(i, t0) {
  const [oc, os_] = CITIES[i % CITIES.length];
  const [dc, ds] = CITIES[(i * 7 + 3) % CITIES.length];
  const cost = 20_000 + (i % 97) * 1_000;
  const ladder = BAND.map((m) => Math.round(cost * (1 + m / 100)));
  const closedAt = t0 - (i + 1) * 600_000;
  const armedAt = closedAt - 1_800_000;
  const ourBids = ladder.map((price, r) => ({
    price, rungIndex: r, rank: null, ts: closedAt - (3 - r) * 4_000,
    socketRank: 2 + ((i + r) % 4), latencyMs: 40 + ((i + r) % 60),
    bidTimeCost: cost, bidTimeMinMarginPct: 1, closesInMs: (3 - r) * 4_000,
    extendsObserved: 0, believedCloseAt: closedAt, closeModel: 'hard', engineRevisionsLeft: 3 - r,
  }));
  return {
    auctionId: `SYN${String(i).padStart(7, '0')}`,
    account: null,
    lane: { origin: oc, destination: dc },
    points: [
      { kind: 'pickup', address: `Plot ${100 + (i % 800)}, MIDC Industrial Area, ${oc}, ${os_}, IN` },
      { kind: 'drop', address: `${SHIPPERS[i % SHIPPERS.length]} Warehouse ${i % 40}, NH 48 Service Road, ${dc}, ${ds}, IN` },
    ],
    equipment: EQUIPMENT[i % EQUIPMENT.length],
    units: 1 + (i % 3),
    shipper: SHIPPERS[i % SHIPPERS.length],
    platformKey: null,
    cost,
    costFloor: cost,
    floor: ladder[ladder.length - 1],
    ladder,
    laneFreight: { ftl: cost + 5_000, pmt: null, freightRate: cost + 4_500 },
    marginsPct: BAND.slice(),
    minMarginPct: 1,
    armedAt,
    ourBids,
    lastBidPrice: ladder[ladder.length - 1],
    finalRank: 1 + (i % 5),
    won: i % 5 === 0,
    closeModel: 'hard',
    closedAt,
    status: 'closed',
    finalCloseAt: closedAt - 3_000,
    closedWhileDown: false,
  };
}

function seedStore(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-stall-'));
  DIRS.push(dir);
  const t0 = Date.now();
  const map = {};
  for (let i = 0; i < records; i++) { const r = syntheticRecord(i, t0); map[r.auctionId] = r; }
  const body = JSON.stringify(map, null, 2);
  fs.writeFileSync(path.join(dir, 'closedBids.json'), body);
  return { dir, bytes: Buffer.byteLength(body) };
}

const mkLoad = (id, remainingMs) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: '32 ft MXL',
  units: 1, companyName: 'Waaree Energies Ltd.', closesAt: Date.now() + remainingMs, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

// Load A is the monitor whose ticks are timed. The adapter holds it above the establish mark until
// TRIGGER_TICK; in the bidding scenarios it then drops under the mark so exactly that tick fires the
// opening rung, and once a write has gone out it reports us L1 so the engine holds and nothing else
// goes on the wire. In cross_load A never bids, and the test arms load B the moment A's trigger tick
// has read. Every read of A stamps the tick's start time; the gaps are measured from those stamps.
async function runScenario(dir, kind) {
  const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
  const logger = new BidLogger({ store });
  const idA = `${kind.toUpperCase()}_A`;
  const idB = `${kind.toUpperCase()}_B`;
  const events = [];
  const ticks = [];
  const busyAt = [];
  const placed = [];
  const writeTicks = [];
  const atTick = [];
  const want = TRIGGER_TICK + AFTER_TRIGGER_TICKS;
  const bids = kind !== 'cross_load';
  const count = (type, id) => events.filter((e) => e.type === type && (!id || String(e.auctionId) === id)).length;
  let onTrigger = null;
  let onDone = null;

  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async (auctionId) => {
      if (String(auctionId) !== idA) {
        return { ok: true, status: 'live', myRank: null, totalBidders: 0, standingL1Price: null,
          closesInMs: FAR_REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
      }
      ticks.push(performance.now());
      busyAt.push(performance.eventLoopUtilization().active);
      atTick.push({ placed: placed.slice(), bidPlaced: count('bid_placed'), bidRejected: count('bid_rejected'),
        armedB: count('armed', idB) });
      const n = ticks.length;
      if (n === TRIGGER_TICK && onTrigger) Promise.resolve().then(onTrigger);
      if (n >= want && onDone) { const d = onDone; onDone = null; d(); }
      return { ok: true, status: 'live', myRank: placed.length ? 1 : 2, totalBidders: 3, standingL1Price: null,
        closesInMs: bids && n >= TRIGGER_TICK ? BID_REMAINING_MS : WAIT_REMAINING_MS,
        revisionsLeft: 3 - placed.length, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
    },
    placeBid: async (auctionId, price) => {
      placed.push({ auctionId: String(auctionId), price });
      writeTicks.push(ticks.length);
      if (kind === 'rejected') return { accepted: false, status: 400, text: REFUSAL, reason: REFUSAL, latencyMs: 30 };
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };

  // The scheduler's own intents write is a separate synchronous write of a ~1KB file. On this OS its
  // latency is set by the on-access file scanner (seen 26-280ms with the machine otherwise idle), so
  // its time is timed and taken out of the thread-busy figure: it is not the closed-bids record.
  const scheduler = new DurableScheduler(path.join(dir, `intents-${kind}.json`));
  const persist = scheduler._persist.bind(scheduler);
  const persists = [];
  scheduler._persist = () => {
    const s = performance.now();
    try { persist(); } finally { persists.push({ tick: ticks.length, ms: performance.now() - s }); }
  };
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: OPEN_AT_MS, openJitterMs: 0 },
    onEvent: (e) => { events.push(e); logger.handle(e); },
    onSample: (s) => logger.sampleRank(s),
  });
  if (kind === 'cross_load') {
    onTrigger = () => engine.arm(mkLoad(idB, FAR_REMAINING_MS), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
  }

  let guard;
  const reached = new Promise((resolve, reject) => {
    onDone = resolve;
    guard = setTimeout(() => reject(new Error(`harness: ${kind} reached only ${ticks.length} of ${want} ticks in ${RUN_GUARD_MS}ms`)), RUN_GUARD_MS);
  });
  engine.arm(mkLoad(idA, WAIT_REMAINING_MS), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
  try {
    await reached;
  } finally {
    clearTimeout(guard);
    engine.kill('test done');
  }
  await logger.handle({ type: 'noop' });
  const t = TRIGGER_TICK - 1;
  const schedulerMs = (i) => persists.filter((p) => p.tick === i).reduce((sum, p) => sum + p.ms, 0);
  const busyIn = (i) => busyAt[i] - busyAt[i - 1] - schedulerMs(i);
  const gaps = [];
  const busy = [];
  for (let i = t + 1; i < want; i++) { gaps.push(ticks[i] - ticks[i - 1]); busy.push(busyIn(i)); }
  return {
    kind, idA, pollHotMs: engine.cfg.pollHotMs,
    noWrite: { gap: ticks[t] - ticks[t - 1], busy: busyIn(t) },
    gaps, busy, schedulerWrites: persists.length,
    schedulerMsAfterTrigger: persists.filter((p) => p.tick > t && p.tick < want).reduce((sum, p) => sum + p.ms, 0),
    atTrigger: atTick[t], atNext: atTick[t + 1], placedTotal: placed.slice(), writeTicks: writeTicks.slice(),
    bidPlacedTotal: count('bid_placed'), bidRejectedTotal: count('bid_rejected'), armedBTotal: count('armed', idB),
  };
}

async function runAll(records) {
  const { dir, bytes } = seedStore(records);
  const out = { bytes };
  for (const kind of SCENARIOS) out[kind] = await runScenario(dir, kind);
  return out;
}

function assertTriggerHappened(r, label) {
  const one = [{ auctionId: r.idA, price: OPENING }];
  assert.strictEqual(r.atTrigger.placed.length, 0, `${label} ${r.kind}: nothing on the wire before the trigger tick`);
  if (r.kind === 'cross_load') {
    assert.strictEqual(r.atNext.armedB, 1, `${label} cross_load: load B emitted armed before A's next tick`);
    assert.strictEqual(r.armedBTotal, 1, `${label} cross_load: load B armed exactly once`);
    assert.deepStrictEqual(r.placedTotal, [], `${label} cross_load: nothing went on the wire`);
    return;
  }
  assert.deepStrictEqual(r.atNext.placed, one, `${label} ${r.kind}: the adapter saw exactly the opening rung before the next tick`);
  if (r.kind === 'accepted') {
    assert.strictEqual(r.atNext.bidPlaced, 1, `${label} accepted: bid_placed emitted before the next tick`);
    assert.deepStrictEqual(r.placedTotal, one, `${label} accepted: no further write went on the wire in the measured window`);
    assert.strictEqual(r.bidRejectedTotal, 0, `${label} accepted: no bid_rejected`);
  } else {
    // A price-class refusal walks the ladder, so the next rung may go out inside the window. It is
    // refused the same way; what matters is that every write was a refusal and each was emitted.
    assert.strictEqual(r.atNext.bidRejected, 1, `${label} rejected: bid_rejected emitted before the next tick`);
    assert.strictEqual(r.bidPlacedTotal, 0, `${label} rejected: no bid_placed`);
    assert.strictEqual(r.bidRejectedTotal, r.placedTotal.length, `${label} rejected: every write in the window was refused and emitted as bid_rejected`);
  }
}

const fmt = (ms) => '[' + ms.map((g) => g.toFixed(0)).join(', ') + ']';
const show = (label, r) => console.log(`  ${label} ${r.kind}: no-write gap ${r.noWrite.gap.toFixed(1)}ms (busy ${r.noWrite.busy.toFixed(1)}ms), gaps after the trigger ${fmt(r.gaps)}ms, thread busy in each ${fmt(r.busy)}ms (scheduler writes taken out: ${r.schedulerMsAfterTrigger.toFixed(0)}ms), writes ${JSON.stringify(r.placedTotal.map((p, i) => [p.price, 'tick ' + r.writeTicks[i]]))}`);

const isStall = (s, bound) => s.gap > bound && s.busy > SLACK_MS;
const stallsOf = (r, bound) => r.gaps.map((gap, i) => ({ at: i + 1, gap, busy: r.busy[i] })).filter((s) => isStall(s, bound));
const said = (s) => `hot tick ${s.at} after the trigger came ${s.gap.toFixed(1)}ms after the one before it, the thread busy for ${s.busy.toFixed(1)}ms of that`;

async function meterReads() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(10);
  const a = performance.eventLoopUtilization().active;
  await wait(METER_MS);
  const b = performance.eventLoopUtilization().active;
  const t = performance.now();
  while (performance.now() - t < METER_MS) {}
  const c = performance.eventLoopUtilization().active;
  return { wait: b - a, hold: c - b };
}

const WHY = {
  accepted: 'recording the accepted bid',
  rejected: 'recording the refused bid',
  cross_load: "recording another load's armed event",
};

(async () => {
  const t0 = Date.now();

  const meter = await meterReads();
  const tiny = await runAll(TINY_RECORDS);
  assert.strictEqual(tiny.accepted.pollHotMs, 200, 'precondition: the engine hot cadence is 200ms');
  const BOUND_MS = tiny.accepted.pollHotMs + SLACK_MS;
  console.log(`  busy meter: a ${METER_MS}ms wait read ${meter.wait.toFixed(1)}ms busy, a ${METER_MS}ms hold read ${meter.hold.toFixed(1)}ms busy`);
  assert.ok(meter.hold >= METER_MS - 1 && meter.wait <= SLACK_MS,
    `precondition: the busy meter must count a ${METER_MS}ms hold of the thread (read ${meter.hold.toFixed(1)}ms) and not a ${METER_MS}ms wait (read ${meter.wait.toFixed(1)}ms), or no interval can be judged`);
  for (const k of SCENARIOS) assert.ok(tiny[k].schedulerWrites > 0, `precondition: tiny ${k} - the scheduler's intents write was never timed, so its time is not being taken out`);
  console.log(`  tiny store: ${TINY_RECORDS} records, ${tiny.bytes} bytes; a stall is a gap over ${BOUND_MS}ms with the thread busy over ${SLACK_MS}ms`);
  for (const k of SCENARIOS) show('tiny', tiny[k]);
  ok("1. hot cadence is pollHotMs = 200ms; the busy meter counts a hold of the thread, not a wait, and sees the scheduler's writes");

  assertTriggerHappened(tiny.accepted, 'tiny');
  ok('2. tiny accepted: exactly the opening rung went out and bid_placed was emitted, on the trigger tick');
  assertTriggerHappened(tiny.rejected, 'tiny');
  ok('3. tiny rejected: the opening rung went out first and was refused, and every write was emitted as bid_rejected');
  assertTriggerHappened(tiny.cross_load, 'tiny');
  ok('4. tiny cross_load: load B armed on A\'s trigger tick and nothing went on the wire');

  for (const k of SCENARIOS) {
    const s = stallsOf(tiny[k], BOUND_MS);
    if (s.length) assert.fail(`control: tiny store ${k} - ${said(s[0])} - engine work alone stalls the ticks, so this harness cannot judge the store`);
  }
  ok('5. control: on a tiny store no hot tick after each trigger stalls');

  const big = await runAll(BIG_RECORDS);
  console.log(`  big store: ${BIG_RECORDS} records, ${big.bytes} bytes (pretty)`);
  for (const k of SCENARIOS) show('big', big[k]);

  assertTriggerHappened(big.accepted, 'big');
  ok('6. big accepted: exactly the opening rung went out and bid_placed was emitted, on the trigger tick');
  assertTriggerHappened(big.rejected, 'big');
  ok('7. big rejected: the opening rung went out first and was refused, and every write was emitted as bid_rejected');
  assertTriggerHappened(big.cross_load, 'big');
  ok('8. big cross_load: load B armed on A\'s trigger tick and nothing went on the wire');

  for (const k of SCENARIOS) {
    const nw = Object.assign({ at: 0 }, big[k].noWrite);
    assert.ok(!isStall(nw, BOUND_MS),
      `control: big store ${k} - two hot ticks with no write came ${nw.gap.toFixed(1)}ms apart with the thread busy for ${nw.busy.toFixed(1)}ms - the harness itself stalls the ticks`);
  }
  ok('9. control: on the big store a hot tick with no write does not stall');

  assert.ok(big.bytes > 60 * 1024 * 1024, `precondition: the synthetic collection is well above production size (${big.bytes} bytes)`);
  ok('10. the synthetic closed-bids collection is well above production size');

  const stalled = [];
  SCENARIOS.forEach((k, i) => {
    const s = stallsOf(big[k], BOUND_MS);
    if (!s.length) { ok(`${11 + i}. ${k}: no hot tick after the trigger stalls against a large closed-bids collection`); return; }
    stalled.push({ k, text: `${k} - ${said(s.reduce((m, x) => (x.busy > m.busy ? x : m)))}` });
  });
  if (stalled.length) {
    throw new assert.AssertionError({ message: `${stalled.length} of ${SCENARIOS.length} scenarios stalled (gap over ${BOUND_MS}ms = pollHotMs + ${SLACK_MS} with the thread busy over ${SLACK_MS}ms): ${stalled.map((s) => s.text).join('; ')}. `
      + `${stalled.map((s) => WHY[s.k]).join(', ')}: each stalls the engine thread - the whole closed-bids collection is re-read, re-parsed and rewritten on the tick thread, so every hot monitor goes blind` });
  }

  assert.strictEqual(pass, EXPECTED_CHECKS, `ran ${pass} of ${EXPECTED_CHECKS} checks`);
  console.log(`\nPASS test-bid-record-does-not-stall-tick: ${pass}/${EXPECTED_CHECKS} checks (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  cleanup();
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL test-bid-record-does-not-stall-tick (check ${pass + 1}): ${e && e.message}`);
  process.exit(1);
});
