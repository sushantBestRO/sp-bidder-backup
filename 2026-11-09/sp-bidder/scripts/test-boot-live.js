'use strict';
/**
 * Boot-live (SP_BOOT_LIVE): a real-mode engine can start LIVE instead of DRY-RUN.
 * Booting live must ALSO lift the adapter's writeEnabled backstop (placeBid throws
 * without it), so a boot-live engine actually places bids, while the default engine
 * (dry-run) only shadows. The safe default (no live opt) stays dry-run.
 *   node scripts/test-boot-live.js
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
const tmp = (tag) => path.join(os.tmpdir(), `bootlive-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];
const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };
const armMeta = () => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 8_000 });

// adapter whose placeBid is GATED on writeEnabled, exactly like the real one.
function gatedAdapter(closesInMs) {
  const a = {
    writeEnabled: false, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    async placeBid(id, price) {
      if (!a.writeEnabled) throw Object.assign(new Error('write disabled'), { code: 'WRITE_DISABLED' });
      a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 };
    },
  };
  return a;
}

(async () => {
  // ---- A. constructor flags: live opt sets engine.live AND lifts the adapter backstop ----
  {
    const a1 = gatedAdapter(30_000);
    const e1 = new BidEngine(a1, new DurableScheduler(tmp('live')), { live: true });
    assert.strictEqual(e1.live, true, 'boot live -> engine.live true');
    assert.strictEqual(a1.writeEnabled, true, 'boot live lifts the adapter writeEnabled backstop');
    e1.kill();

    const a2 = gatedAdapter(30_000);
    const e2 = new BidEngine(a2, new DurableScheduler(tmp('dry')), { live: false });
    assert.strictEqual(e2.live, false, 'boot dry -> engine.live false');
    assert.strictEqual(a2.writeEnabled, false, 'boot dry leaves writeEnabled down');
    e2.kill();

    const a3 = gatedAdapter(30_000);
    const e3 = new BidEngine(a3, new DurableScheduler(tmp('def')), {});
    assert.strictEqual(e3.live, false, 'no live opt -> defaults to dry-run (safe default)');
    assert.strictEqual(a3.writeEnabled, false, 'default keeps writeEnabled down');
    e3.kill();
    ok('constructor: live opt sets engine.live AND lifts adapter writeEnabled; default stays dry');
  }

  // ---- B. an adapter with no writeEnabled field: booting live must not throw ----
  {
    const bare = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, closesInMs: 30_000 }),
      placeBid: async () => ({ accepted: true, myRank: 1 }),
    };
    const e = new BidEngine(bare, new DurableScheduler(tmp('bare')), { live: true });
    assert.strictEqual(e.live, true, 'live boot on a writeEnabled-less adapter still sets live');
    e.kill();
    ok('constructor: boot-live is safe on an adapter that has no writeEnabled field');
  }

  // ---- C. behaviour: boot-live places a REAL bid; boot-dry only shadows ----
  {
    const fL = tmp('behav-live');
    const aL = gatedAdapter(8_000); // inside the snipe window so the establishing rung fires
    const evL = [];
    const eL = new BidEngine(aL, new DurableScheduler(fL), { config: CFG, live: true, onEvent: (e) => evL.push(e) });
    eL.arm(armMeta(), { cost: 50_000, marginsPct: BAND });
    await sleep(600);
    assert.ok(aL.placed.length >= 1, 'boot-live engine placed a real bid');
    assert.ok(evL.some((e) => e.type === 'bid_placed'), 'boot-live emitted bid_placed (not would_bid)');
    eL.kill(); try { fs.unlinkSync(fL); } catch (_) {}

    const fD = tmp('behav-dry');
    const aD = gatedAdapter(8_000);
    const evD = [];
    const eD = new BidEngine(aD, new DurableScheduler(fD), { config: CFG, live: false, onEvent: (e) => evD.push(e) });
    eD.arm(armMeta(), { cost: 50_000, marginsPct: BAND });
    await sleep(600);
    assert.strictEqual(aD.placed.length, 0, 'boot-dry engine placed NOTHING (shadow only)');
    assert.ok(evD.some((e) => e.type === 'would_bid' && e.dryRun), 'boot-dry emitted would_bid (shadow)');
    eD.kill(); try { fs.unlinkSync(fD); } catch (_) {}
    ok('behaviour: boot-live places a real bid; boot-dry shadows without placing');
  }

  for (const t of ['live', 'dry', 'def', 'bare']) { try { fs.unlinkSync(tmp(t)); } catch (_) {} }
  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
