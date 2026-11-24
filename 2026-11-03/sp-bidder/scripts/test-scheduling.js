'use strict';
/**
 * Offline check for gap A4: per-auction scheduling. No token, no network.
 *   A. schedule() persists a 'scheduled' intent and wakes to arm it at
 *      startsAt - armLeadMs.
 *   B. a start time already in the past -> arms immediately.
 *   C. durable: a scheduled intent survives a "restart" (fresh engine + rehydrate
 *      re-plans the wake and arms on time).
 *   D. kill() cancels the pending wake; resume() re-plans it.
 *
 *   node scripts/test-scheduling.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const BAND = [12.6, 7.2, 6.3];
const tmp = (tag) => path.join(os.tmpdir(), `a4-${tag}-${process.pid}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = { armLeadMs: 300, openAtMs: 15_000, floorWindowMs: 2_500 };

// minimal far-from-close adapter (arming is what we test, not bidding)
function quietAdapter() {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState(id) {
      return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
        closesInMs: 30_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid() { return { accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 50 }; },
  };
}
const meta = (startsAt) => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, startsAt, closesAt: Date.now() + 30_000 });

(async () => {
  // ---- A. wake arms at startsAt - armLeadMs ----
  {
    const f = tmp('wake'); const eng = new BidEngine(quietAdapter(), new DurableScheduler(f), { config: CFG });
    eng.schedule(meta(Date.now() + 800), { cost: 50_000, marginsPct: BAND }); // wake at +500ms
    assert.strictEqual(eng.monitors.has('1'), false, 'not armed yet (scheduled only)');
    assert.strictEqual(eng.scheduler.get('1').status, 'scheduled', 'intent persisted as scheduled');
    await sleep(950);
    assert.strictEqual(eng.monitors.has('1'), true, 'armed once the start time arrived');
    assert.strictEqual(eng.scheduler.get('1').status, 'armed', 'intent transitioned scheduled -> armed');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('schedule(): wakes and arms at startsAt - armLeadMs');
  }

  // ---- B. already-started -> arm immediately ----
  {
    const f = tmp('past'); const eng = new BidEngine(quietAdapter(), new DurableScheduler(f), { config: CFG });
    eng.schedule(meta(Date.now() - 5_000), { cost: 50_000, marginsPct: BAND });
    await sleep(150);
    assert.strictEqual(eng.monitors.has('1'), true, 'past start time -> armed right away');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('schedule(): already-started auction arms immediately');
  }

  // ---- C. durable across a restart ----
  {
    const f = tmp('restart');
    // session 1: schedule, then simulate the process dying (stop clears the timer; intent stays on disk)
    {
      const eng1 = new BidEngine(quietAdapter(), new DurableScheduler(f), { config: CFG });
      eng1.schedule(meta(Date.now() + 1_500), { cost: 50_000, marginsPct: BAND });
      eng1.stop('1'); // cancel session-1's in-memory wake; disk intent remains 'scheduled'
      assert.strictEqual(eng1.scheduler.get('1').status, 'scheduled', 'still scheduled on disk after stop');
    }
    // session 2: fresh engine reads the file and re-plans the wake
    const eng2 = new BidEngine(quietAdapter(), new DurableScheduler(f), { config: CFG });
    await eng2.rehydrate();
    assert.strictEqual(eng2.monitors.has('1'), false, 'rehydrate re-planned the wake, not armed yet');
    await sleep(1_500);
    assert.strictEqual(eng2.monitors.has('1'), true, 'armed on time after restart');
    eng2.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('durable: scheduled intent survives restart, arms on time');
  }

  // ---- D. kill cancels the wake; resume re-plans ----
  {
    const f = tmp('killwake'); const eng = new BidEngine(quietAdapter(), new DurableScheduler(f), { config: CFG });
    eng.schedule(meta(Date.now() + 1_500), { cost: 50_000, marginsPct: BAND });
    eng.kill('panic');
    await sleep(1_600);
    assert.strictEqual(eng.monitors.has('1'), false, 'kill cancelled the pending wake (no arm)');
    eng.resume(); // start time already passed -> re-plan fires immediately
    await sleep(200);
    assert.strictEqual(eng.monitors.has('1'), true, 'resume re-planned the wake and armed');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('kill cancels the wake; resume re-plans it');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
