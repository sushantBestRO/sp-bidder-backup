'use strict';
/**
 * Regression: a DRY-RUN shadow must not suppress the real bid once the operator goes live.
 * The shadow advances the ladder (firedRungs) for a faithful preview, but that Set also GATES
 * real bids - if persisted/carried, a shadow walked to the floor leaves a live load bidding
 * NOTHING. Drives a shadow to the floor, goes live, asserts real bids fire. Syngenta HARD-close.
 *
 *   node scripts/test-golive-shadow.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => path.join(os.tmpdir(), `golive-${t}-${process.pid}.json`);

// scripted outranked (rank 2) hard-close state, countdown supplied per tick
function adapterFor(placed) {
  let closesInMs = 20000;
  const a = {
    setClose: (ms) => { closesInMs = ms; },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: false,
    async getAuctionState() {
      return { ok: true, status: closesInMs <= 0 ? 'closed' : 'live', myRank: 2, totalBidders: 2,
        standingL1Price: null, closesInMs, revisionLimit: 3, revisionsLeft: null, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
  };
  return a;
}

(async () => {
  const f = tmp('shadow');
  const placed = [];
  const adapter = adapterFor(placed);
  const scheduler = new DurableScheduler(f);
  // DRY-RUN (live:false) - real mode boots this way
  const eng = new BidEngine(adapter, scheduler, { config: { openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, live: false, rand: () => 0 });
  const closesAt = Date.now() + 20000;
  const m = eng.arm({ id: '22365292', lane: { origin: 'PUN', destination: 'BLR' }, units: 1, closesAt, companyName: 'Syngenta' },
    { cost: 50000, marginsPct: [12.6, 7.2, 6.3] });

  // shadow-walk the ladder into the floor window (no real bids placed)
  adapter.setClose(12000); await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  adapter.setClose(1500);  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  const shadowFired = [...m.firedRungs];
  assert.strictEqual(placed.length, 0, 'DRY-RUN placed no real bid');
  assert.ok(shadowFired.length > 0, 'shadow advanced the ladder in-memory (faithful preview)');
  const persisted = scheduler.get('22365292');
  assert.deepStrictEqual(persisted.firedRungs, [], 'shadow firedRungs are NOT persisted to the durable intent');
  ok('DRY-RUN shadow previews the ladder without persisting the real-bid gate');

  // operator goes live mid-auction
  eng.goLive();
  assert.deepStrictEqual([...m.firedRungs], [], 'goLive() discarded the shadow firedRungs');
  assert.strictEqual(m.currentRungIndex, -1, 'goLive() reset the ladder index for real bidding');

  // run to close and confirm the engine actually bids for real (not suppressed)
  adapter.setClose(1400); await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  adapter.setClose(1000); await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  adapter.setClose(400);  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  const floor = m.ladder[m.ladder.length - 1];
  assert.ok(placed.length > 0, 'engine placed REAL bids after goLive (was suppressed by the shadow before the fix)');
  assert.ok(placed.includes(floor), `engine reached the real floor snipe ${floor} (placed: ${placed})`);
  ok('after goLive the real floor bid fires - the shadow no longer suppresses it');

  try { fs.unlinkSync(f); } catch (_) {}
  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
