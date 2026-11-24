'use strict';
/**
 * Pins A091 (fix/ops-alerting-divergences).
 *
 * A monitor finalized by a natural close (_finalize) or an unreadable retirement
 * (_retireUnreadable) was never deleted by either - stop() was the only deletion path, and stop()
 * is reached only from teardown/sim-reset/operator-stop/re-price/tick-fault-handoff, never a
 * normal close. Every closed load's monitor lived in memory for the process's whole life.
 * snapshot() now sweeps finalized monitors past CLOSED_MONITOR_RETENTION_MS (7 days, matching
 * priceRequests.js's own PRUNE_RETENTION_MS) before returning - so the dashboard/receipts that
 * read a recently-closed load keep working, and nothing accumulates forever.
 *
 * @requires-summary-line
 *   node scripts/test-a091-closed-monitor-retention.js
 */
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const fakeAdapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
const tmpScheduler = () => new DurableScheduler(path.join(os.tmpdir(), `a091-${process.pid}-${Math.random()}.json`));
const SEVEN_DAYS = 7 * 86_400_000;

const armReal = (eng, id, closesAt) => eng.arm(
  { id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt },
  { marketRate: 70_000, costFloor: 40_000 },
);

(async () => {
  // ---- a finalized monitor stays retrievable well inside the retention window ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'L1', Date.now() + 60_000);
    m.finalized = true;
    m.finalizedAt = Date.now() - (SEVEN_DAYS - 60_000);
    const snap = eng.snapshot();
    assert.strictEqual(snap.length, 1, 'a finalized monitor just inside the retention window is still returned by snapshot()');
    assert.strictEqual(eng.monitors.has('L1'), true, 'and is still in the underlying map');
    ok('A091: a recently-closed load is still readable well inside the 7-day retention window');
  }

  // ---- a finalized monitor past the retention window is swept on the next snapshot() ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'L2', Date.now() + 60_000);
    m.finalized = true;
    m.finalizedAt = Date.now() - (SEVEN_DAYS + 60_000);
    const snap = eng.snapshot();
    assert.strictEqual(snap.length, 0, 'a finalized monitor past the retention window is no longer returned');
    assert.strictEqual(eng.monitors.has('L2'), false, 'A091: it is actually deleted from the map, not just filtered from the view (bounds memory)');
    ok('A091: a monitor past the 7-day retention window is swept from memory on the next snapshot()');
  }

  // ---- an UNFINALIZED (still-armed) monitor is never swept, however old it looks ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'L3', Date.now() + 60_000);
    assert.strictEqual(m.finalized, false, 'fixture: a freshly-armed monitor starts unfinalized');
    m.finalizedAt = Date.now() - (SEVEN_DAYS + 60_000); // even if this got stamped somehow, finalized=false must win
    const snap = eng.snapshot();
    assert.strictEqual(snap.length, 1, 'a live (unfinalized) monitor is never swept regardless of age');
    ok('control: an unfinalized monitor is never swept (retention only applies to finalized ones)');
  }

  // ---- _finalize() and _retireUnreadable() actually stamp finalizedAt (not left null forever) ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'L4', Date.now() + 60_000);
    await eng._finalize(m, { myRank: 1 }).catch(() => {}); // best-effort: offline adapter, some reads no-op
    assert.strictEqual(m.finalized, true, '_finalize marks the monitor finalized');
    assert.ok(typeof m.finalizedAt === 'number' && m.finalizedAt > 0,
      `A091: _finalize stamps finalizedAt so the retention clock actually starts, got ${m.finalizedAt}`);

    const eng2 = new BidEngine(fakeAdapter, tmpScheduler());
    const m2 = armReal(eng2, 'L5', Date.now() + 60_000);
    eng2._retireUnreadable(m2);
    assert.strictEqual(m2.finalized, true, '_retireUnreadable marks the monitor finalized');
    assert.ok(typeof m2.finalizedAt === 'number' && m2.finalizedAt > 0,
      `A091: _retireUnreadable stamps finalizedAt too, got ${m2.finalizedAt}`);
    ok('A091: both natural-finalize paths (_finalize, _retireUnreadable) stamp finalizedAt');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
