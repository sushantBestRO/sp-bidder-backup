'use strict';
/**
 * Regression: T7 E7 - a year-2100 placeholder close disables the unreadable-past-close bound.
 *
 * SuperProcure's year-2100 placeholder is a finite, positive number, so `_unreadablePastBound`'s
 * close-arm test (`closeAt > 0`) always selects it, and `Date.now() - closeAt` stays roughly 74
 * years negative forever. That is precisely what makes the outage-clock fallback below it
 * unreachable: a load that carries the placeholder as its believed close is never retired, no
 * matter how long the portal stops answering, and nothing further is ever said to the desk.
 *
 * WHAT MUST NOT MOVE: an ordinary close that has already passed still retires on the CLOSE arm,
 * not the slower outage-clock fallback (check 2 times this directly - the close arm fires on the
 * very first failing read, the fallback only after the outage bound elapses). A close that is
 * still comfortably ahead must not be retired early either (check 3).
 *
 * Mock policy: only the platform adapter's getAuctionState is mocked, always failing. Every
 * decision comes from the real _tick/_unreadablePastBound/_retireUnreadable. Not fully offline in
 * the sub-millisecond sense - this drives the engine's own timers with short real sleeps, the same
 * shape scripts/test-unreadable-past-close-bound.js uses for the identical mechanism.
 *
 *   node scripts/test-unreadable-bound-y2100-placeholder.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAND = [12.6, 7.2, 6.3];

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-y2100-bound-'));
let seq = 0;
const tmp = () => path.join(TMPDIR, `intent-${seq++}.json`);
const cleanupDir = () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} };

// A superprocure year-2100 placeholder, verbatim shape (a real epoch millisecond well past 30 days out).
const Y2100_CLOSE = Date.parse('2100-01-01T00:00:00Z');

const RETIRE_MS = 1_500;
const cfg = { openAtMs: 15_000, floorWindowMs: 2_500, unreadableRetireMs: RETIRE_MS };

function deadAdapter() {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    writeEnabled: false,
    async getAuctionState() { return { ok: false, error: 'ECONNRESET' }; },
    async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 }; },
  };
}

function engineOn(alerts) {
  return new BidEngine(deadAdapter(), new DurableScheduler(tmp()), {
    config: cfg,
    onEvent: (e) => { if (e.type === 'alert' || e.type === 'closed_while_down') alerts.push(e); },
  });
}

function cleanup(eng) { try { eng.kill(); } catch (_) {} }

(async () => {
  // ============================================================================================
  // 1. MECHANISM: a believed close at a year-2100 placeholder must still retire, via the
  //    outage-clock fallback, once the load has been unreadable past the bound.
  // ============================================================================================
  {
    const alerts = [];
    const eng = engineOn(alerts);
    eng.arm({ id: 'Y2100', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Y2100_CLOSE },
      { cost: 50_000, marginsPct: BAND });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && eng.scheduler.get('Y2100').status !== 'closed') await sleep(100);

    const it = eng.scheduler.get('Y2100');
    ok(it.status === 'closed',
      `a load whose believed close is the year-2100 placeholder must eventually retire (got status '${it.status}')`);
    ok(it.closedWhileDown === true, 'it retires into the same closedWhileDown shape as any other unreadable load');
    ok(alerts.some((e) => e.kind === 'unreadable_past_close_retired'),
      'the desk is told - a placeholder close must not produce a silent-forever monitor');
    cleanup(eng);
  }

  // ============================================================================================
  // 2. CONTROL: an ordinary close ten hours past must still retire on the CLOSE arm - fast,
  //    inside a fraction of the outage bound - not the (slower) outage-clock fallback.
  // ============================================================================================
  {
    const alerts = [];
    const eng = engineOn(alerts);
    const startedAt = Date.now();
    eng.arm({ id: 'ORDINARY', lane: { origin: 'A', destination: 'B' }, units: 1,
      closesAt: Date.now() - (10 * 3_600_000) }, { cost: 50_000, marginsPct: BAND });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && eng.scheduler.get('ORDINARY').status !== 'closed') await sleep(50);
    const elapsed = Date.now() - startedAt;

    const it = eng.scheduler.get('ORDINARY');
    ok(it.status === 'closed', 'CONTROL: an ordinary close ten hours past still retires - the fix must not disable the close arm');
    ok(elapsed < RETIRE_MS,
      `CONTROL: it retires on the CLOSE arm, faster than the ${RETIRE_MS}ms outage bound (took ${elapsed}ms) - `
      + 'a fix that routed every load through the fallback would still pass check 1 but would slow this one down');
    cleanup(eng);
  }

  // ============================================================================================
  // 3. CONTROL: a close comfortably ahead (well inside the 30-day plausibility window, and in the
  //    future) must never be retired while unreadable - the fix must not turn "far future" into
  //    "any future".
  // ============================================================================================
  {
    const alerts = [];
    const eng = engineOn(alerts);
    eng.arm({ id: 'NEARFUTURE', lane: { origin: 'A', destination: 'B' }, units: 1,
      closesAt: Date.now() + 3_600_000 }, { cost: 50_000, marginsPct: BAND });
    await sleep(RETIRE_MS * 3);
    const it = eng.scheduler.get('NEARFUTURE');
    ok(it.status !== 'closed', `CONTROL: a load whose close is genuinely still ahead is never retired (got status '${it.status}')`);
    ok(!alerts.some((e) => e.kind === 'unreadable_past_close_retired'), 'CONTROL: and no retirement alert fires for it');
    cleanup(eng);
  }

  cleanupDir();
  const EXPECTED_CHECKS = 7;
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass}`);
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => { cleanupDir(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
