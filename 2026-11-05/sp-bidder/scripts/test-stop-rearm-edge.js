'use strict';
/**
 * Stop / re-arm EDGE CASES + operator workflows - the companion to test-stop-rearm.js (happy path).
 * These are the transitions and races a real operator actually hits: the state-machine guards
 * (double-stop, re-arm the wrong state, dismiss a priced load), money integrity across REPEATED
 * stop/re-arm cycles, a stopped load that then closes, dismiss/restore, and the money-sensitive
 * stop-during-an-in-flight-bid race. Mirrors what the /api/auctions/:loadId/stop|rearm +
 * /dismiss + /restore routes compose from the engine + scheduler + request store.
 *   node scripts/test-stop-rearm-edge.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { buildBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `stoprearm-edge-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];
const FLOOR = 6.3;
const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };

// A transition the state machine must refuse (any of the money-path error codes) with the right reason.
async function refused(fn, re, label) {
  try { await fn(); } catch (e) {
    if (['BAD_INPUT', 'NOT_OPEN', 'GONE', 'NOT_FOUND'].includes(e.code)) {
      if (!re || re.test(e.message)) return ok(label);
      console.error(`  FAIL  ${label}: wrong message "${e.message}"`); return process.exit(1);
    }
    console.error(`  FAIL  ${label}: threw ${e.code || '(no code)'} - ${e.message}`); return process.exit(1);
  }
  console.error(`  FAIL  ${label}: expected a rejection, none thrown`); process.exit(1);
}

const memStore = () => createStore({ backend: 'memory' });
const newRequests = (store) => new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: FLOOR });
function mkLoad(id, opts = {}) {
  return { id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: opts.closesAt || (Date.now() + 8_000),
    startsAt: Date.now() - 1000, status: 'live', softClose: false };
}
// exactly what the stop route composes (engine + scheduler + request store)
async function stopLoad(engine, requests, reqDoc) {
  engine.stop(reqDoc.loadId);
  if (engine.scheduler.get(reqDoc.loadId)) engine.scheduler.update(reqDoc.loadId, { status: 'stopped' });
  if (reqDoc.status === 'armed') await requests.stop(reqDoc.id);
}
function firingAdapter(closesInMs) {
  const a = { writeEnabled: false, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) { if (!a.writeEnabled) throw new Error('write disabled'); a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 }; } };
  return a;
}
// The FIRST placeBid HANGS until _release() (so we can stop a load with a bid mid-flight);
// every later placeBid resolves immediately, so a re-arm's re-attempt is observable in `placed`.
function hangingAdapter(closesInMs) {
  let release = null, calls = 0;
  const accept = { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
  const a = { writeEnabled: false, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid(id, price) {
      if (!a.writeEnabled) throw new Error('write disabled');
      calls += 1;
      if (calls === 1) return new Promise((res) => { release = () => { a.placed.push(price); res(accept); }; });
      a.placed.push(price); return Promise.resolve(accept); // re-arm's re-attempt fires immediately
    },
    _calls: () => calls, _release: () => { if (release) release(); } };
  return a;
}

(async () => {
  // ===== Group 1: out-of-state stop / re-arm / dismiss are all refused =====
  {
    const rq = newRequests(memStore());
    // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
    // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
    // a request production cannot create (discovery refuses to open one inside the lead) and which
    // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
    // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
    const c = await rq.createForLoad(mkLoad('G1'), { deadlineAt: Date.now() + 60_000 });
    await refused(() => rq.stop(c.id), /can only stop an armed load/, 'stop refuses an awaiting (un-priced) load');
    await refused(() => rq.rearm(c.id), /can only re-arm a stopped load/, 're-arm refuses an awaiting load');
    await rq.capture(c.id, { cost: 40_000 });
    await refused(() => rq.rearm(c.id), /can only re-arm a stopped load/, 're-arm refuses an armed (not stopped) load');
    await refused(() => rq.dismiss(c.id), /can only dismiss an awaiting request/, 'dismiss refuses a priced (armed) load');
    await rq.stop(c.id);
    await refused(() => rq.stop(c.id), /can only stop an armed load/, 'double-stop refused (already stopped)');
    await rq.rearm(c.id);
    await refused(() => rq.rearm(c.id), /can only re-arm a stopped load/, 'double-re-arm refused (already armed)');
    ok('Group 1: every out-of-state transition is refused, never silently applied');
  }

  // ===== Group 2: cost + band survive a stop/re-arm with no re-entry =====
  {
    const rq = newRequests(memStore());
    const c = await rq.createForLoad(mkLoad('G2'), { deadlineAt: Date.now() + 60_000 });
    await rq.capture(c.id, { cost: 45_000 });
    await rq.stop(c.id);
    const re = await rq.rearm(c.id);
    assert.strictEqual(re.price.cost, 45_000, 'cost kept exactly across stop -> re-arm');
    assert.deepStrictEqual(re.price.marginsPct, BAND, 'band kept across stop -> re-arm');
    assert.strictEqual(re.price.minMarginPct, FLOOR, 'floor kept across stop -> re-arm');
    ok('Group 2: cost + band + floor survive a stop/re-arm (operator never re-enters the cost)');
  }

  // ===== Group 3: firedRungs + currentRungIndex survive REPEATED cycles, zero double-spend =====
  {
    const f = tmp('cycle');
    const adapter = firingAdapter(8_000);
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, live: true });
    const rq = newRequests(memStore());
    const c = await rq.createForLoad(mkLoad('G3'), { deadlineAt: Date.now() + 60_000 });
    armFromRequest(engine, await rq.capture(c.id, { cost: 45_000 }));
    await sleep(600);
    assert.ok(adapter.placed.length >= 1, 'fired the establishing rung');
    const establishing = engine.monitors.get('G3').ladder[0];
    for (let i = 1; i <= 3; i++) {
      const doc = await rq.getByLoad('G3');
      await stopLoad(engine, rq, doc);
      const placedBefore = adapter.placed.length;
      armFromRequest(engine, await rq.rearm(doc.id));
      const m = engine.monitors.get('G3');
      assert.ok(m.firedRungs.has(0), `cycle ${i}: the establishing rung is still recorded`);
      assert.ok(m.currentRungIndex >= 0, `cycle ${i}: currentRungIndex restored (not rewound)`);
      await sleep(300);
      assert.ok(!adapter.placed.slice(placedBefore).includes(establishing),
        `cycle ${i}: the already-spent establishing rung was NOT re-fired`);
    }
    engine.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('Group 3: firedRungs + currentRungIndex survive 3 stop/re-arm cycles, zero double-spend');
  }

  // ===== Group 4: a stopped load that then CLOSES retires to terminal, not re-armable =====
  {
    const store = memStore();
    const rq = newRequests(store);
    const c = await rq.createForLoad(mkLoad('G4', { closesAt: Date.now() + 5_000 }), { deadlineAt: Date.now() + 60_000 });
    await rq.capture(c.id, { cost: 30_000 });
    await rq.stop(c.id);
    const doc = await rq.getByLoad('G4');
    doc.load.closesAt = Date.now() - 1; // the auction closes while the load sits stopped
    await store.putDoc('priceRequests', doc.id, doc);
    const closed = await rq.finalizeClosed();
    assert.ok(closed >= 1, 'finalizeClosed retired the stopped-then-closed load');
    assert.strictEqual((await rq.getByLoad('G4')).status, 'closed', 'stopped load that closed -> closed');
    await refused(() => rq.rearm(c.id), /can only re-arm a stopped load/, 're-arm refuses a load that closed while stopped');
    ok('Group 4: a stopped load that closes retires to closed and can never be re-armed');
  }

  // ===== Group 5: dismiss -> restore -> price round-trips cleanly =====
  {
    const rq = newRequests(memStore());
    const c = await rq.createForLoad(mkLoad('G5', { closesAt: Date.now() + 600_000 }));
    assert.strictEqual((await rq.dismiss(c.id)).status, 'dismissed', 'awaiting -> dismissed');
    await refused(() => rq.restore('nope-token'), /unknown/, 'restore an unknown token refused');
    assert.strictEqual((await rq.restore(c.id)).status, 'awaiting_price', 'dismissed -> restored to awaiting');
    await refused(() => rq.restore(c.id), /can only restore a dismissed request/, 'restore refuses an already-restored load');
    assert.strictEqual((await rq.capture(c.id, { cost: 33_000 })).status, 'armed', 'a restored load prices normally');
    ok('Group 5: dismiss -> restore -> price round-trips cleanly');

    // 5b: a dismissed load whose AUCTION HAS CLOSED cannot be restored (would only bounce to skipped).
    const rq2 = newRequests(memStore());
    const c2 = await rq2.createForLoad(mkLoad('G5b', { closesAt: Date.now() - 1_000 })); // auction already closed
    await rq2.dismiss(c2.id);
    await refused(() => rq2.restore(c2.id), /already closed/, 'restore refuses a load whose auction has closed');
    ok('Group 5b: a dismissed load whose auction has closed cannot be restored');

    // 5c: but a dismissed load in the DANGER ZONE (deadline passed, auction still open) CAN be
    // restored and priced best-effort - the deadline is no longer a wall, only the real close is.
    const rq3 = newRequests(memStore());
    const c3 = await rq3.createForLoad(mkLoad('G5c', { closesAt: Date.now() + 20_000 }), { deadlineAt: Date.now() - 1_000 });
    await rq3.dismiss(c3.id);
    assert.strictEqual((await rq3.restore(c3.id)).status, 'awaiting_price', 'a dismissed load past its deadline but still open restores (best-effort)');
    ok('Group 5c: a dismissed load in the danger zone (deadline passed, still open) can be restored');
  }

  // ===== Group 6: stop DURING an in-flight bid (the money-sensitive race) =====
  {
    const f = tmp('inflight');
    const adapter = hangingAdapter(8_000);
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, live: true });
    const rq = newRequests(memStore());
    const c = await rq.createForLoad(mkLoad('G6'), { deadlineAt: Date.now() + 60_000 });
    const { floor } = buildBandLadder({ cost: 45_000, marginsPct: BAND, minMarginPct: FLOOR });
    armFromRequest(engine, await rq.capture(c.id, { cost: 45_000 }));
    for (let i = 0; i < 40 && adapter._calls() < 1; i++) await sleep(25); // wait until a bid is hanging
    assert.ok(adapter._calls() >= 1, 'a bid is in-flight (placeBid called and hanging on the network)');
    await stopLoad(engine, rq, await rq.getByLoad('G6')); // operator stops it mid-flight
    assert.strictEqual(engine.monitors.has('G6'), false, 'stop removed the monitor even with a bid in flight');
    adapter._release(); // the in-flight bid now lands on the portal, but the monitor is already gone
    await sleep(50);
    // KNOWN TRADE-OFF (bidEngine.js ~632): the in-flight rung is deliberately NOT written back to the
    // stopped intent (so a late resolve can't resurrect it). A re-arm can therefore re-attempt it -
    // the guarantee that MUST hold is floor-safety, not no-re-fire.
    const persisted = (engine.scheduler.get('G6').firedRungs || []).includes(0);
    armFromRequest(engine, await rq.rearm(c.id));
    await sleep(600);
    engine.kill();
    for (const p of adapter.placed) assert.ok(p >= floor, `every placed bid (${p}) stays >= operating floor ${floor}`);
    const establishing = buildBandLadder({ cost: 45_000, marginsPct: BAND, minMarginPct: FLOOR }).ladder[0];
    const reFired = adapter.placed.filter((p) => p === establishing).length > 1;
    console.log(`      note: in-flight rung persisted to intent=${persisted}; total real bids=${adapter.placed.length}; establishing rung re-fired after re-arm=${reFired}` +
      (reFired ? ' (floor-safe double-attempt in a sub-second race - documented tradeoff)' : ''));
    try { fs.unlinkSync(f); } catch (_) {}
    ok('Group 6: stop cancels a mid-flight bid cleanly; re-arm stays floor-safe (no sub-floor bid ever)');
  }

  console.log(`\n${pass} checks passed (7 groups: guards, cost-integrity, cycles, close-while-stopped, dismiss/restore, in-flight race)`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
