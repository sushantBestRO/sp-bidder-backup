'use strict';
/**
 * Regression for review Findings 3 + gaps-1 (restart safety). The engine always
 * places real bids; a restart re-arms live:
 *   A. persisted firedRungs survive repeated restarts — arm() must not reset them to []
 *      on rehydrate, or a second restart could re-fire a spent rung.
 *   B. revisionsLeft survives a restart — it must not re-seed to the static cap, or the engine
 *      would attempt more bids than the platform allows after a mid-auction restart.
 *   C. an auction that closed while we were down is NOT booked as a phantom loss (won stays
 *      unknown/null, not false), so win/loss reporting isn't corrupted.
 *   D. a corrupt intents file raises a loud alert on rehydrate (not silent total amnesia).
 *   E. landedBids - the close-time PARTICIPATION fact - survives a restart. _finalize reads it to
 *      decide between the desk's "LOST" and "NO BID PLACED" receipts and whether to raise the
 *      zero-bid alarm, so a per-process counter would report a load carrying real bids as one that
 *      never bid, every time a deploy restarted pm2 inside a live auction window. The full
 *      close-and-render consequence is pinned in scripts/test-no-bid-outcome.js (case F); this is
 *      the restart invariant itself, alongside the other three it travels with.
 *
 *   node scripts/test-restart-safety.js
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
const tmp = (tag) => path.join(os.tmpdir(), `rst-${tag}-${process.pid}.json`);
const armMeta = (ms) => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + ms });

function stub(ctrl) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: false,
    async getAuctionState() {
      return { ok: true, status: 'live', myRank: ctrl.placed.length ? 1 : 2, totalBidders: 2,
        standingL1Price: null, closesInMs: ctrl.closesInMs, revisionLimit: 3, revisionsLeft: null,
        closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) { ctrl.placed.push(price); return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 }; },
  };
}
const cfg = { openAtMs: 15_000, floorWindowMs: 2_500 };

(async () => {
  // A. firedRungs survive two restarts
  {
    const f = tmp('firedrungs');
    const ctrl = { closesInMs: 12_000, placed: [] };
    {
      const eng = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: cfg });
      eng.arm(armMeta(12_000), { cost: 50_000, marginsPct: BAND });
      await sleep(400); // engine is live -> fires a real establishing bid, persists rung 0
      eng.stop('1'); // "crash": clear the timer, disk intent stays
      assert.ok(eng.scheduler.get('1').firedRungs.includes(0), 'rung 0 persisted after firing');
    }
    const eng2 = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: cfg });
    await eng2.rehydrate();
    assert.ok(eng2.scheduler.get('1').firedRungs.includes(0), 'firedRungs preserved on disk after first restart (not wiped to [])');
    assert.ok(eng2.monitors.get('1').firedRungs.has(0), 'in-memory monitor restored rung 0');
    eng2.stop('1');
    const eng3 = new BidEngine(stub(ctrl), new DurableScheduler(f), { config: cfg });
    await eng3.rehydrate();
    assert.ok(eng3.scheduler.get('1').firedRungs.includes(0), 'firedRungs still intact after a SECOND restart');
    eng3.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('restart: persisted firedRungs survive repeated restarts');
  }

  // B. revisionsLeft survives a restart (does not re-seed to the static cap)
  {
    const f = tmp('revs');
    {
      const eng = new BidEngine(stub({ closesInMs: 12_000, placed: [] }), new DurableScheduler(f), { config: cfg });
      const m = eng.arm(armMeta(12_000), { cost: 50_000, marginsPct: BAND });
      await sleep(400); // fires >=1 real bid -> revisionsLeft decrements + persists
      const used = eng.scheduler.get('1').revisionsLeft;
      assert.ok(used != null && used < 3, `revisionsLeft persisted below the cap (got ${used})`);
      eng.stop('1');
    }
    const eng2 = new BidEngine(stub({ closesInMs: 12_000, placed: [] }), new DurableScheduler(f), { config: cfg });
    await eng2.rehydrate();
    assert.ok(eng2.monitors.get('1').revisionsLeft < 3, 'restart restored the DECREMENTED revisionsLeft, not the static cap');
    eng2.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('restart: revisionsLeft restored from disk (not re-seeded to the cap)');
  }

  // C. closed-while-down is not booked as a phantom loss
  {
    const f = tmp('closed');
    {
      const eng = new BidEngine(stub({ closesInMs: 5_000, placed: [] }), new DurableScheduler(f), { config: cfg });
      eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 5_000 }, { cost: 50_000, marginsPct: BAND });
      eng.stop('1'); // crash while armed, won never recorded
    }
    // fast-forward: the intent's closesAt is now UNAMBIGUOUSLY in the past. It has to clear
    // rehydrateGraceMs - inside that window a close with no recorded outcome is re-armed and settled
    // by a live read instead, because a soft auction outlives every close it publishes. This case is
    // about the auction that really did end while the process was down, so the gap is an hour.
    const sched = new DurableScheduler(f);
    sched.update('1', { closesAt: Date.now() - 3_600_000 });
    const eng2 = new BidEngine(stub({ closesInMs: 0, placed: [] }), sched, { config: cfg });
    await eng2.rehydrate();
    const it = eng2.scheduler.get('1');
    assert.strictEqual(it.status, 'closed', 'retired the closed-while-down intent');
    assert.notStrictEqual(it.won, false, 'NOT booked as a phantom loss (won is null/unknown, not false)');
    assert.strictEqual(it.closedWhileDown, true, 'flagged closedWhileDown so reporting can treat it as unknown');
    eng2.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('closed-while-down auction is marked unknown, not a phantom loss');
  }

  // D. a corrupt intents file raises a loud alert on rehydrate
  {
    const f = tmp('corrupt');
    fs.writeFileSync(f, '{ this is not valid json'); // torn/corrupt file
    const alerts = [];
    const eng = new BidEngine(stub({ closesInMs: 0, placed: [] }), new DurableScheduler(f),
      { config: cfg, onEvent: (e) => { if (e.kind === 'intents_file_corrupt') alerts.push(e); } });
    await eng.rehydrate();
    assert.strictEqual(alerts.length, 1, 'corrupt intents file emitted a loud alert (not silent amnesia)');
    assert.strictEqual(alerts[0].level, 'error', 'corruption is an error-level alert');
    eng.kill();
    // the corrupt file was backed up as .corrupt.* and the original removed
    const dir = path.dirname(f); const base = path.basename(f);
    const backedUp = fs.readdirSync(dir).some((n) => n.startsWith(base + '.corrupt.'));
    assert.ok(backedUp, 'corrupt file backed up for inspection');
    for (const n of fs.readdirSync(dir)) { if (n.startsWith(base)) { try { fs.unlinkSync(path.join(dir, n)); } catch (_) {} } }
    ok('corrupt intents file raises a loud alert + is backed up (no silent auction abandonment)');
  }

  // E. landedBids (the close-time participation fact) survives a restart
  {
    const f = tmp('landed');
    {
      const eng = new BidEngine(stub({ closesInMs: 12_000, placed: [] }), new DurableScheduler(f), { config: cfg });
      const m = eng.arm(armMeta(12_000), { cost: 50_000, marginsPct: BAND });
      await sleep(400); // fires >=1 real bid -> accepted -> landedBids persists on the intent
      assert.ok(m.landedBids > 0, 'the accepted bid was counted in-process');
      assert.ok(eng.scheduler.get('1').landedBids > 0, 'landedBids reached DISK, not just the monitor');
      eng.stop('1');
    }
    const eng2 = new BidEngine(stub({ closesInMs: 12_000, placed: [] }), new DurableScheduler(f), { config: cfg });
    await eng2.rehydrate();
    assert.ok(eng2.monitors.get('1').landedBids > 0,
      'restart restored the landed count (a load with bids on the board must never close as "NO BID PLACED")');
    eng2.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('restart: landedBids restored from disk (the close-time participation fact is durable)');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
