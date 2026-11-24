'use strict';
/**
 * Re-price fired-rung remap. When an operator re-prices a load the bot is already armed on, the
 * ladder is rebuilt from the new band. firedRungs are INDICES into the OLD ladder; carrying them
 * onto a SHORTER new ladder verbatim let a stale mid-rung index collide with the new ladder's floor
 * index, so _decide's final-snipe gate read the floor as already-fired and never bid it - the bot
 * went dark on a live, winnable auction (setBidOverride + clearBidOverride both reached this).
 * arm() now remaps fired rungs by PRICE (integer ladder prices, exact match); an unchanged ladder
 * (restart/rehydrate re-arm) is preserved index-for-index. This pins both.
 *
 * Exercises the real composition: requests.capture/setBidOverride (priceRequests.js) -> the
 * /margin endpoint's reArmWithNewBand == engine.stop + armFromRequest -> _decide snipe gate.
 *   node scripts/test-reprice-firedrungs.js
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
// A per-run directory, not a pid-named file in the shared tmpdir: the engine rewrites the intent
// file after the unlink below, and Windows reuses pids, so a later run could load an earlier run's
// SHORT intent - landed bid and all - and the belt would then refuse the floor this file expects.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprice-fr-'));
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const tmp = (tag) => path.join(TMP_DIR, `${tag}.json`);
const OLD_BAND = [12, 10, 8, 7, 6.3];  // 5-rung ladder
const NEW_BAND = [10, 8, 6.3];         // 3-rung ladder (shorter); floor at index 2
const COST = 45_000;
const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };

function mockAdapter() {
  const a = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    // benign default so any stray auto-tick holds (rank 1, far from close) and places nothing
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 1, totalBidders: 3, standingL1Price: null,
      closesInMs: 60_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) {
      if (!a.writeEnabled) throw new Error('write disabled');
      a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    },
  };
  return a;
}
function mkLoad(id) {
  return { id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: Date.now() + 8_000, startsAt: Date.now() - 1000,
    status: 'live', softClose: false };
}
// snipe-window state: inside floorWindowMs, outranked (rank 2) -> the floor rung is the only rung left
const snipeState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 1_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 });

// arm on OLD_BAND, mark indices 0,1,2 fired (exactly as the live accept-path persists), then
// re-price to `newBand` via the real setBidOverride + stop + armFromRequest composition.
async function armAndReprice(loadId, newBand) {
  const f = tmp(loadId);
  const adapter = mockAdapter();
  const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG, live: true });
  const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: OLD_BAND, minMarginPct: 6.3 });

  // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
  // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
  // a request production cannot create (discovery refuses to open one inside the lead) and which
  // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
  // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
  const created = await requests.createForLoad(mkLoad(loadId), { deadlineAt: Date.now() + 60_000 });
  const capt = await requests.capture(created.id, { cost: COST });
  const m1 = armFromRequest(engine, capt);
  if (m1 && m1.timer) clearTimeout(m1.timer); // isolate: no auto-ticks
  engine.scheduler.update(loadId, { status: 'bidding', firedRungs: [0, 1, 2] }); // establish + 2 step-downs fired

  const updated = await requests.setBidOverride(created.id, { marginsPct: newBand, minMarginPct: 6.3 }, { setBy: 'operator' });
  engine.stop(loadId);
  const m2 = armFromRequest(engine, updated);
  if (m2 && m2.timer) clearTimeout(m2.timer);
  try { fs.unlinkSync(f); } catch (_) {}
  return { engine, adapter, monitor: m2 };
}

(async () => {
  // 1) re-price to a SHORTER band: fired rungs remapped by price, new floor NOT falsely gated
  const short = await armAndReprice('SHORT', NEW_BAND);
  const floorIdx = short.monitor.ladder.length - 1;
  const floorPrice = short.monitor.ladder[floorIdx];
  assert.ok(!short.monitor.firedRungs.has(floorIdx),
    `new floor index ${floorIdx} (price ${floorPrice}, never bid) must not be gated by a stale old-ladder index; firedRungs=${JSON.stringify([...short.monitor.firedRungs])}`);
  ok('re-price to shorter band: new floor rung is not falsely marked fired');

  await short.engine._maybeBid(short.monitor, snipeState());
  assert.ok(short.adapter.placed.includes(floorPrice),
    `new floor ${floorPrice} must fire in the snipe window after re-price (bot must not go dark); placed=${JSON.stringify(short.adapter.placed)}`);
  ok('re-price to shorter band: floor rung fires in the snipe window (bot does not go dark)');
  short.engine.kill();

  // 2) same-band re-arm (restart/rehydrate identity path): fired indices preserved exactly
  const same = await armAndReprice('SAME', OLD_BAND);
  assert.deepStrictEqual([...same.monitor.firedRungs].sort((a, b) => a - b), [0, 1, 2],
    'a same-ladder re-arm must preserve fired indices index-for-index (restart safety / duplicate-price ladders untouched)');
  ok('same-band re-arm: fired indices preserved exactly (restart safety intact)');
  same.engine.kill();

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
