'use strict';
/**
 * A RE-PRICE ROUTED TO schedule() MUST NOT ERASE SPEND OR UN-ARM A LOAD THAT HAS ALREADY BID.
 *
 * Regression target: T2 D5.
 *
 * The desk re-prices an armed load through reArmWithNewBand (server.js): engine.stop(id), then
 * armFromRequest on the updated request. armFromRequest decides "live or not yet" off the FROZEN
 * load snapshot taken at discovery, so a load that has already bid can still read "starts later"
 * and be routed to engine.schedule(). schedule() writes `status:'scheduled', firedRungs:[],
 * finalRank:null, won:null` through scheduler.upsert(), whose Object.assign merge lets those
 * literals overwrite the existing durable record. Its only re-entry guard is the in-memory
 * monitors map, which stop() has just emptied - and which a restarted engine never had. One
 * re-price therefore forgets WHICH rung prices were spent (the only input remapFiredRungs has on
 * the next arm) and regresses a bidding load to 'scheduled'.
 *
 * The contract, in the code's own words: reArmWithNewBand says "the intent (firedRungs) survives"
 * and "restore fired rungs"; arm() carries spend across a rebuilt ladder BY PRICE
 * (remapFiredRungs). Expected values here are derived from that: the prices spent before the
 * re-price must still be recorded as spent, on whatever ladder the re-price built.
 *
 * WHAT MUST NOT MOVE:
 *   - everBid / landedBids / landedBidPrice already survive the re-price (check 3).
 *   - a FIRST-TIME schedule() of a load with no record still writes 'scheduled' and [] (check 7).
 *   - a re-priced load that has already bid is WATCHED AGAIN within a bounded time (check 4). The
 *     scheduled wake arms only a still-'scheduled' intent, so a fix that merely keeps the
 *     'bidding' status on the record turns checks 1, 2, 5, 6 green while the wake stands down and the
 *     live load is never re-armed. Check 4 is the guard against that incomplete fix.
 *
 * Whether the re-armed monitor re-fires a spent rung is a different defect and is not asserted here.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, in-memory price-request store, no
 * network. The first arm and the check-4 re-arm go through the engine's own scheduled wake, so
 * those waits are short real polls with a hard cap.
 *
 *   node scripts/test-schedule-keeps-spent-rungs.js
 */
process.env.LOG_LEVEL = 'silent';
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };
const OLD_BAND = [12, 10, 8, 7, 6.3];
const NEW_BAND = [12, 9, 6.3];   // same top margin, so the spent opening price is still on the new ladder
const COST = 45_000;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `sched-keeps-spend-${process.pid}-`));
let seq = 0;
const tmp = () => path.join(DIR, `intents-${seq++}.json`);
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill('test-cleanup'); } catch (_) {} }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, capMs) {
  const end = Date.now() + capMs;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}

// Outranked until our first bid lands, then rank 1 so the monitor holds and spends nothing more.
function mockAdapter() {
  const a = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: a.placed.length ? 1 : 2, totalBidders: 3,
      standingL1Price: null, closesInMs: 12_000, revisionLimit: 3, revisionsLeft: null,
      closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) {
      if (!a.writeEnabled) throw new Error('write disabled');
      a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
  return a;
}
function newEngine(adapter, file) {
  const e = new BidEngine(adapter, new DurableScheduler(file), { config: CFG, live: true });
  ENGINES.push(e);
  return e;
}
const newRequests = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: OLD_BAND, minMarginPct: 6.3 });

// The frozen snapshot: not 'live', startsAt still ahead. startsAt inside armLeadMs, so the first
// capture's scheduled wake arms it almost at once and it bids while the snapshot still says "later".
function mkLoad(id, startsInMs) {
  return { id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: Date.now() + 60_000, startsAt: Date.now() + startsInMs,
    status: 'upcoming', softClose: false };
}

// capture -> armFromRequest -> schedule -> wake -> arm -> a rung really lands and persists.
async function armAndSpend(loadId, engine, requests) {
  const created = await requests.createForLoad(mkLoad(loadId, engine.cfg.armLeadMs + 300), { deadlineAt: Date.now() + 60_000 });
  const capt = await requests.capture(created.id, { cost: COST });
  armFromRequest(engine, capt, { requests });
  const spent = await until(() => {
    const it = engine.scheduler.get(loadId);
    return !!(it && it.status === 'bidding' && Array.isArray(it.firedRungs) && it.firedRungs.length);
  }, 4_000);
  assert.ok(spent, `setup: load ${loadId} never landed a bid; record=${JSON.stringify(engine.scheduler.get(loadId))}`);
  const before = JSON.parse(JSON.stringify(engine.scheduler.get(loadId)));
  assert.ok(Date.now() < capt.load.startsAt, 'setup: the frozen snapshot must still read "starts later" at re-price time');
  return { created, before };
}

// reArmWithNewBand's composition, verbatim.
async function reprice(engine, requests, created) {
  const updated = await requests.setBidOverride(created.id, { marginsPct: NEW_BAND, minMarginPct: 6.3 }, { setBy: 'operator' });
  engine.stop(String(updated.loadId));
  armFromRequest(engine, updated, { requests });
  return JSON.parse(JSON.stringify(engine.scheduler.get(String(updated.loadId))));
}

const spentPrices = (it) => (it.firedRungs || []).map((i) => it.ladder[i]);
const ACTIVE = ['armed', 'bidding'];

let pass = 0;
const failures = [];
function check(n, name, fn) {
  try { fn(); console.log(`  ok  ${n}. ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${n}. ${name}\n       ${e.message}`); failures.push(n); }
}

(async () => {
  // In-process re-price of a load that has bid (checks 1-4).
  const aAdapter = mockAdapter();
  const aEngine = newEngine(aAdapter, tmp());
  const aReq = newRequests();
  const A = await armAndSpend('D5-INPROC', aEngine, aReq);
  const aAfter = await reprice(aEngine, aReq, A.created);
  const aPrices = spentPrices(A.before);
  assert.ok(aPrices.every((p) => aAfter.ladder.includes(p)),
    `setup: the re-priced ladder ${JSON.stringify(aAfter.ladder)} must still carry the spent prices ${JSON.stringify(aPrices)}`);

  check(1, 'in-process re-price keeps the spent rung(s) by price on the durable record', () => {
    const after = spentPrices(aAfter);
    assert.ok(aPrices.every((p) => after.includes(p)),
      `schedule() overwrote durable firedRungs on a re-price: spent prices ${JSON.stringify(aPrices)} `
      + `(firedRungs ${JSON.stringify(A.before.firedRungs)}, on the wire ${JSON.stringify(aAdapter.placed)}) `
      + `now read firedRungs ${JSON.stringify(aAfter.firedRungs)} on ladder ${JSON.stringify(aAfter.ladder)}`);
  });
  check(2, 'in-process re-price does not regress a bidding load to scheduled', () => {
    assert.ok(ACTIVE.includes(aAfter.status),
      `schedule() regressed the durable status '${A.before.status}' -> '${aAfter.status}' on a load that has already bid`);
  });
  check(3, 'control: everBid / landedBids / landedBidPrice survive the re-price', () => {
    assert.ok(A.before.everBid === true && A.before.landedBids >= 1 && A.before.landedBidPrice > 0,
      `fixture: the landed bid did not record its participation fields: ${JSON.stringify(A.before)}`);
    assert.deepStrictEqual(
      { everBid: aAfter.everBid, landedBids: aAfter.landedBids, landedBidPrice: aAfter.landedBidPrice },
      { everBid: A.before.everBid, landedBids: A.before.landedBids, landedBidPrice: A.before.landedBidPrice });
  });
  const watched = await until(() => aEngine.monitors.has('D5-INPROC'), 2_000);
  check(4, 'positive pin: the re-priced load that has already bid is watched again within 2s', () => {
    assert.ok(watched,
      `the re-priced load was never re-armed: monitors.has=false, durable status '${(aEngine.scheduler.get('D5-INPROC') || {}).status}' `
      + '- the scheduled wake arms only a still-scheduled intent, so this live load is stranded');
  });
  aEngine.kill('test-done');

  // Re-price after a restart: a fresh engine over the same intents file, rehydrate not yet run.
  const bFile = tmp();
  const b1 = newEngine(mockAdapter(), bFile);
  const bReq = newRequests();
  const B = await armAndSpend('D5-RESTART', b1, bReq);
  b1.kill('restart');
  const b2 = newEngine(mockAdapter(), bFile);
  assert.ok(b2.monitors.size === 0, 'setup: a fresh engine must start with no monitors');
  assert.deepStrictEqual(b2.scheduler.get('D5-RESTART').firedRungs, B.before.firedRungs,
    'setup: the restarted engine must read the spend back off disk');
  const bAfter = await reprice(b2, bReq, B.created);
  const bPrices = spentPrices(B.before);
  assert.ok(bPrices.every((p) => bAfter.ladder.includes(p)),
    `setup: the re-priced ladder ${JSON.stringify(bAfter.ladder)} must still carry the spent prices ${JSON.stringify(bPrices)}`);

  check(5, 'post-restart re-price keeps the spent rung(s) by price on the durable record', () => {
    const after = spentPrices(bAfter);
    assert.ok(bPrices.every((p) => after.includes(p)),
      `schedule() on a restarted engine overwrote durable firedRungs: spent prices ${JSON.stringify(bPrices)} `
      + `(firedRungs ${JSON.stringify(B.before.firedRungs)}) now read firedRungs ${JSON.stringify(bAfter.firedRungs)} `
      + `on ladder ${JSON.stringify(bAfter.ladder)} - the spend a rehydrate would have restored is gone`);
  });
  check(6, 'post-restart re-price does not regress a bidding load to scheduled', () => {
    assert.ok(ACTIVE.includes(bAfter.status),
      `schedule() on a restarted engine regressed the durable status '${B.before.status}' -> '${bAfter.status}'`);
  });
  b2.kill('test-done');

  // First-time schedule of a load with no record: the pre-arm initialisation is correct here.
  const cEngine = newEngine(mockAdapter(), tmp());
  const cReq = newRequests();
  const cCreated = await cReq.createForLoad(mkLoad('D5-FRESH', 3_600_000), { deadlineAt: Date.now() + 60_000 });
  assert.ok(!cEngine.scheduler.get('D5-FRESH'), 'setup: the fresh load must have no prior record');
  armFromRequest(cEngine, await cReq.capture(cCreated.id, { cost: COST }), { requests: cReq });
  const cIt = cEngine.scheduler.get('D5-FRESH');
  check(7, 'control: a first-time schedule() still writes status scheduled and firedRungs []', () => {
    assert.ok(cIt, 'schedule() wrote no durable record for a first-time load');
    assert.strictEqual(cIt.status, 'scheduled');
    assert.deepStrictEqual(cIt.firedRungs, []);
    assert.ok(!cEngine.monitors.has('D5-FRESH'), 'a first-time schedule() must not create a monitor');
  });
  cEngine.kill('test-done');

  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks ${failures.join(', ')} of 7: a re-price routed to schedule() by the frozen `
      + 'snapshot overwrote the durable record of a load that has already bid (spent rungs / active status), '
      + 'or left that load un-watched');
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/7 checks`);
  process.exit(0);
})().catch((e) => { console.error('\nHARNESS ERROR:', e && e.stack || e); cleanup(); process.exit(1); });
