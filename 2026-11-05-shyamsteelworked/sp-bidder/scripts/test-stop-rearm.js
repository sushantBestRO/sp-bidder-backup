'use strict';
/**
 * Stop + re-arm (operator control). Stopping a load halts its bidding and marks the durable
 * intent so a restart won't resurrect it, but keeps the cost + already-fired rungs so a re-arm
 * resumes where it left off and never re-spends a paid rung. This mirrors what the
 * /api/auctions/:loadId/stop|rearm routes compose from the engine + scheduler + request store.
 *   node scripts/test-stop-rearm.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `stoprearm-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];
const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };

function gatedAdapter(closesInMs) {
  const a = {
    writeEnabled: false, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) { if (!a.writeEnabled) throw new Error('write disabled'); a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 }; },
  };
  return a;
}
function mkLoad(id) {
  return { id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: Date.now() + 8_000, startsAt: Date.now() - 1000, status: 'live', softClose: false };
}

// exactly what the stop route composes (engine + scheduler + request store)
async function stopLoad(engine, requests, reqDoc) {
  engine.stop(reqDoc.loadId);
  if (engine.scheduler.get(reqDoc.loadId)) engine.scheduler.update(reqDoc.loadId, { status: 'stopped' });
  if (reqDoc.status === 'armed') await requests.stop(reqDoc.id);
}

(async () => {
  const f = tmp('main');
  const adapter = gatedAdapter(8_000);
  const store = createStore({ backend: 'memory' });
  const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, live: true });
  const requests = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });

  // arm live + fire the establishing rung
  // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
  // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
  // a request production cannot create (discovery refuses to open one inside the lead) and which
  // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
  // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
  const created = await requests.createForLoad(mkLoad('L1'), { deadlineAt: Date.now() + 60_000 });
  const capt = await requests.capture(created.id, { cost: 45_000 });
  armFromRequest(engine, capt);
  await sleep(600);
  assert.ok(adapter.placed.length >= 1, 'live engine placed a real bid before stop');
  assert.ok(engine.scheduler.get('L1').firedRungs.includes(0), 'rung 0 recorded on the durable intent');
  ok('armed live + fired the establishing rung');

  // stop (route logic)
  const reqDoc = await requests.getByLoad('L1');
  await stopLoad(engine, requests, reqDoc);
  assert.strictEqual(engine.monitors.has('L1'), false, 'stop removed the live monitor');
  assert.strictEqual(engine.scheduler.get('L1').status, 'stopped', 'durable intent marked stopped');
  assert.strictEqual((await requests.getByLoad('L1')).status, 'stopped', 'price request marked stopped');
  assert.ok(!engine.scheduler.activeIntents().some((i) => i.auctionId === 'L1'), 'stopped intent excluded from activeIntents');
  ok('stop: monitor gone, intent + request stopped, excluded from active');

  // restart -> a stopped load is NOT resurrected
  const engine2 = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, live: true });
  await engine2.rehydrate();
  assert.strictEqual(engine2.monitors.has('L1'), false, 'rehydrate did NOT re-arm the stopped load');
  ok('restart: rehydrate skips a stopped load (no silent resurrection)');
  engine2.kill();

  // re-arm (route logic): request stopped -> armed, engine re-armed, firedRungs preserved
  const placedBefore = adapter.placed.length;
  const updated = await requests.rearm(reqDoc.id);
  assert.strictEqual(updated.status, 'armed', 'rearm flips the request back to armed');
  armFromRequest(engine, updated);
  assert.strictEqual(engine.monitors.has('L1'), true, 'rearm re-created the live monitor');
  assert.ok(engine.monitors.get('L1').firedRungs.has(0), 'rearm restored the already-fired rung into the monitor');
  assert.strictEqual(engine.scheduler.get('L1').status, 'armed', 'intent back to armed after rearm');
  await sleep(600);
  // rung 0 was already spent + we are L1; the resumed monitor must not re-fire rung 0
  assert.ok(!adapter.placed.slice(placedBefore).includes(engine.monitors.get('L1').ladder[0]),
    'resumed monitor did NOT re-fire the already-spent establishing rung (no double-spend)');
  ok('re-arm: monitor restored, fired rung preserved, no double-spend');
  engine.kill(); try { fs.unlinkSync(f); } catch (_) {}

  // guards: cannot stop a non-armed request; cannot re-arm a closed load
  {
    const store2 = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: store2, marginsPct: BAND, minMarginPct: 6.3 });
    const c = await rq.createForLoad(mkLoad('L2'), { deadlineAt: Date.now() + 60_000 }); // awaiting_price
    await assert.rejects(() => rq.stop(c.id), /can only stop an armed load/, 'stop rejects a non-armed request');
    await rq.capture(c.id, { cost: 30_000 });
    await rq.stop(c.id);
    const doc = await rq.getByLoad('L2');
    doc.load.closesAt = Date.now() - 1000; // force the auction closed
    await store2.putDoc('priceRequests', doc.id, doc);
    await assert.rejects(() => rq.rearm(c.id), /already closed/, 'rearm refuses a closed load');
    ok('guards: stop needs an armed load; rearm refuses a closed one');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
