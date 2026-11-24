'use strict';
/**
 * Regression for review Finding 1: the soft-close finalize debounce was dead on the
 * real adapter (status derived from closesInMs<=0 finalized on the first transient zero).
 * The stub here derives status the same way, so it would have caught the bug.
 *   A. soft close: a transient zero followed by an extension does NOT finalize.
 *   B. soft close: a sustained zero past the extend window DOES finalize.
 *   C. hard close: finalizes at the authoritative zero without waiting the debounce.
 *
 *   node scripts/test-finalize-softclose.js
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
const BAND = [12.6, 7.2, 6.3];
const tmp = (tag) => path.join(os.tmpdir(), `fin-${tag}-${process.pid}.json`);
const armMeta = (ms) => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + ms });

// status is derived from closesInMs<=0 exactly like RealSuperProcureAdapter.
function stub(ctrl) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: ctrl.closeModel }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const cz = ctrl.closesInMs;
      return { ok: true, status: cz <= 0 ? 'closed' : 'live', myRank: 2, totalBidders: 2,
        standingL1Price: null, closesInMs: cz, revisionLimit: 3, revisionsLeft: null,
        closeModel: ctrl.closeModel, extendMs: ctrl.extendMs, measuredRttMs: 50 };
    },
    async placeBid() { return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 }; },
  };
}

(async () => {
  // A. soft: transient zero + extension -> not finalized (debounce = extendMs + base)
  {
    const f = tmp('soft-transient');
    const ctrl = { closesInMs: 6_000, closeModel: 'soft', extendMs: 400 };
    const eng = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: { finalizeDebounceMs: 200, openAtMs: 15_000, floorWindowMs: 2_500 } });
    eng.arm(armMeta(6_000), { cost: 50_000, marginsPct: BAND });
    await sleep(250);
    ctrl.closesInMs = 0;          // countdown momentarily lapses
    await sleep(300);             // < 600 (extendMs 400 + base 200)
    const m = eng.monitors.get('1');
    assert.strictEqual(m.finalized, false, 'transient zero must not finalize a soft close');
    ctrl.closesInMs = 5_000;      // anti-snipe extension arrives
    await sleep(300);
    assert.strictEqual(m.finalized, false, 'extension resumed; still not finalized');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('soft close: transient zero + extension does not finalize');
  }

  // B. soft: sustained zero past the extend window -> finalizes
  {
    const f = tmp('soft-sustained');
    const ctrl = { closesInMs: 0, closeModel: 'soft', extendMs: 100 };
    const eng = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: { finalizeDebounceMs: 150, openAtMs: 15_000, floorWindowMs: 2_500 } });
    eng.arm(armMeta(0), { cost: 50_000, marginsPct: BAND });
    await sleep(600);             // > 250 (extendMs 100 + base 150)
    assert.strictEqual(eng.monitors.get('1').finalized, true, 'sustained zero past the window finalizes');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('soft close: sustained zero past the extend window finalizes');
  }

  // C. hard: finalizes at the zero without waiting the (huge) debounce
  {
    const f = tmp('hard');
    const ctrl = { closesInMs: 0, closeModel: 'hard', extendMs: null };
    const eng = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: { finalizeDebounceMs: 5_000, openAtMs: 15_000, floorWindowMs: 2_500 } });
    eng.arm(armMeta(0), { cost: 50_000, marginsPct: BAND });
    await sleep(250);
    assert.strictEqual(eng.monitors.get('1').finalized, true, 'hard close finalizes immediately, no debounce wait');
    eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('hard close: finalizes at the authoritative zero (no debounce wait)');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
