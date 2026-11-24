'use strict';
/**
 * Regression: loads armed via the price-request path must carry the SHIPPER
 * (companyName) all the way to the closedBids History record and the won/lost
 * alert payload - including across the two paths that round-trip through the
 * durable intent and used to drop it (verified on 22918820:
 * shipper null in closedBids, "" in the lost alert):
 *   A. capture -> armFromRequest -> armed -> bid_placed -> auction_result -> closedBids
 *   B. scheduled load: schedule() persists companyName on the intent; the wake arms with it
 *   C. restart: rehydrate() re-arms from the intent with companyName intact
 *      (fresh store = the cleared-History worst case)
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `shipper-reg-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];
const CFG = { armLeadMs: 300 };
const SHIPPER = 'Syngenta India';
const POINTS = [
  { kind: 'pickup', address: 'Khopoli, Maharashtra 410203, India' },
  { kind: 'drop', address: 'Keeranur, Tamil Nadu 622507, India' },
];

// rank-only adapter with a flippable state: open (rank 2, hot window) -> closed
function flippableAdapter() {
  const a = {
    st: { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 8_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ...a.st }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 40 }),
    close: (rank) => { a.st = { ...a.st, status: 'closed', myRank: rank, closesInMs: 0 }; },
  };
  return a;
}

function mkLoad(id, { startsAt, status }) {
  return {
    id, lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1,
    companyName: SHIPPER, points: POINTS, closesAt: Date.now() + 8_000, startsAt, status, softClose: false,
  };
}

function rig(adapter, intentsFile) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: (m) => console.error(m) });
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), {
    config: CFG,
    onEvent: (e) => { events.push(e); logger.handle(e); },
  });
  return { store, logger, events, engine };
}

(async () => {
  // ---- A. live-load path: armed -> would_bid -> auction_result -> closedBids names the shipper ----
  {
    const f = tmp('live');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });
    // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
    // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
    // a request production cannot create (discovery refuses to open one inside the lead) and which
    // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
    // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
    const created = await rq.createForLoad(mkLoad('SH1', { startsAt: Date.now() - 1000, status: 'live' }), { deadlineAt: Date.now() + 60_000 });
    const capt = await rq.capture(created.id, { cost: 80_000 });
    armFromRequest(engine, capt);

    const armed = events.find((e) => e.type === 'armed');
    assert.ok(armed, 'armed event emitted');
    assert.strictEqual(armed.companyName, SHIPPER, 'armed event names the shipper');
    ok('armFromRequest -> armed event carries companyName');

    await sleep(600); // engine is live -> places the establishing bid for real
    assert.ok(events.some((e) => e.type === 'bid_placed'), 'bid_placed (real) emitted');
    adapter.close(2); // auction ends, we did not win
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.ok(result, 'auction_result emitted');
    assert.strictEqual(result.companyName, SHIPPER, 'auction_result names the shipper');
    ok('armed -> bid_placed -> auction_result all fired, result carries companyName');

    const n = toNotification(result);
    assert.strictEqual(n.kind, 'lost', 'lost alert produced');
    assert.strictEqual(n.data.shipper, SHIPPER, 'lost alert payload names the shipper');
    ok('won/lost alert payload names the shipper');

    await sleep(100); // let the logger tail drain
    const rec = await store.getDoc('closedBids', 'SH1');
    assert.ok(rec && rec.status === 'closed', 'closedBids record finalized');
    assert.strictEqual(rec.shipper, SHIPPER, 'closedBids record names the shipper');
    assert.ok(Array.isArray(rec.points) && rec.points.length === 2, 'closedBids record keeps the point addresses');
    assert.ok(rec.ourBids.length >= 1, 'closedBids record holds a real bid');
    ok('closedBids History row carries shipper + points end-to-end');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- B. scheduled-load path: the intent persists companyName; the wake arms with it ----
  {
    const f = tmp('sched');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });
    const created = await rq.createForLoad(mkLoad('SH2', { startsAt: Date.now() + 700, status: 'scheduled' }), { deadlineAt: Date.now() + 60_000 });
    const capt = await rq.capture(created.id, { cost: 80_000 });
    armFromRequest(engine, capt);

    assert.strictEqual(engine.scheduler.get('SH2').status, 'scheduled', 'not-yet-started load -> scheduled intent');
    assert.strictEqual(engine.scheduler.get('SH2').companyName, SHIPPER, 'scheduled intent persists companyName');
    ok('schedule() persists companyName on the durable intent');

    await sleep(900); // wake fires at startsAt - armLeadMs
    const armed = events.find((e) => e.type === 'armed');
    assert.ok(armed, 'wake armed the load');
    assert.strictEqual(armed.companyName, SHIPPER, 'wake-armed event still names the shipper');
    adapter.close(1);
    await sleep(800);
    const rec = await store.getDoc('closedBids', 'SH2');
    assert.strictEqual(rec && rec.shipper, SHIPPER, 'closedBids names the shipper on the schedule-wake path');
    ok('schedule -> wake -> arm keeps the shipper through the intent round-trip');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- C. restart path: rehydrate re-arms with companyName even over a FRESH store ----
  {
    const f = tmp('restart');
    const adapter = flippableAdapter();
    // session 1: arm via the price-request path, then "crash"
    {
      const { store, engine } = rig(adapter, f);
      const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });
      const created = await rq.createForLoad(mkLoad('SH3', { startsAt: Date.now() - 1000, status: 'live' }), { deadlineAt: Date.now() + 60_000 });
      armFromRequest(engine, await rq.capture(created.id, { cost: 80_000 }));
      assert.strictEqual(engine.scheduler.get('SH3').companyName, SHIPPER, 'armed intent persists companyName');
      engine.kill('simulated crash');
    }
    // session 2: fresh engine + EMPTY store (cleared-History worst case) rehydrates from disk
    const { store: store2, events: events2, engine: engine2 } = rig(adapter, f);
    await engine2.rehydrate();
    const armed = events2.find((e) => e.type === 'armed');
    assert.ok(armed, 'rehydrate re-armed the load');
    assert.strictEqual(armed.companyName, SHIPPER, 'rehydrated armed event names the shipper');
    adapter.close(2);
    await sleep(800);
    const rec = await store2.getDoc('closedBids', 'SH3');
    assert.strictEqual(rec && rec.shipper, SHIPPER, 'closedBids names the shipper after a restart (fresh store)');
    assert.ok(Array.isArray(rec.points) && rec.points.length === 2, 'points survive the restart too');
    ok('restart/rehydrate keeps the shipper (the 22918820 failure mode)');
    engine2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
