'use strict';
/**
 * Regression: T7 E9 (kill half only) - a killed engine still speaks up to two hours later.
 *
 * kill() clears every monitor timer and every scheduled wake, but never touches
 * `_unreadableFlushTimer` - the one-shot, unref'd timer that speaks a folded
 * unreadable-past-close retirement when no successor retirement arrives to carry it.
 * `_flushUnreadableFolded` carries no `this.killed` guard and emits unconditionally, so an
 * operator who hits the kill switch mid-outage can still get an error-class WhatsApp naming
 * loads from an engine they just stopped, up to `unreadableAnnounceWindowMs` (2h by default)
 * later.
 *
 * Scope: only the kill half. server.js's teardownStack leaks the same handle on the
 * account-reconnect path and is explicitly out of scope here (staged for later).
 *
 * WHAT MUST NOT MOVE: without a kill, the same armed timer still speaks the folded
 * retirement when it fires (check 2, the control - a green mechanism check next to a harness
 * that never actually arms the timer is not evidence of anything).
 *
 * Mock policy: none needed. The fold state and the timer are engine-internal fields set
 * directly, and the timer is driven by advancing real time (it is short and unref'd, so no
 * network, no adapter, no scheduler I/O is required).
 *
 *   node scripts/test-kill-clears-unreadable-flush-timer.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 4;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-kill-flush-'));
const tmp = (n) => path.join(TMPDIR, `intent-${n}.json`);
const cleanupDir = () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} };

function mkEngine(alerts) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp(pass)), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500 },
    onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
  });
}

// Arms the fold exactly as _retireUnreadable's fold branch does, without needing a real outage:
// a nonzero _unreadableFolded plus the one-shot flush timer.
function armFold(eng, ms) {
  eng._unreadableFolded = 2;
  eng._unreadableFoldedIds = ['LOAD-A', 'LOAD-B'];
  eng._armUnreadableFlushTimer(ms);
}

(async () => {
  // ============================================================================================
  // 1. MECHANISM: kill() must release the fold's flush timer - no live handle left behind.
  // ============================================================================================
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);
    assert.ok(eng._unreadableFlushTimer, 'precondition: the flush timer is armed');

    eng.kill('manual');
    assert.strictEqual(eng._unreadableFlushTimer, null,
      'kill() must clear the unreadable-flush timer handle, exactly like every other timer class it releases');
    ok('kill() clears the unreadable-flush timer handle');
  }

  // ============================================================================================
  // 2. MECHANISM: after a kill, the timer must never fire and speak - zero alerts, whatever the
  //    process does afterward (advancing well past the armed delay).
  // ============================================================================================
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);
    eng.kill('manual');

    await sleep(200); // comfortably longer than the armed delay
    const spoken = alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    assert.strictEqual(spoken.length, 0,
      `a killed engine spoke ${spoken.length} unreadable_past_close_retired alert(s) - a fold armed before the kill must never reach the desk after it`);
    ok('a killed engine never speaks the folded retirement, however long the process runs afterward');
  }

  // ============================================================================================
  // 3. CONTROL: the identical armed fold, WITHOUT a kill, still speaks when the timer fires -
  //    proves the harness genuinely arms a live timer rather than a no-op.
  // ============================================================================================
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);

    await sleep(200);
    const spoken = alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    assert.strictEqual(spoken.length, 1, `CONTROL: without a kill the armed fold must still speak once (got ${spoken.length}) - harness is dead otherwise`);
    assert.ok(/LOAD-A|LOAD-B/.test(spoken[0].detail), 'CONTROL: the spoken alert names the folded loads');
    eng.kill('manual'); // tidy shutdown, no further assertion
    ok('CONTROL: the same armed fold speaks when no kill intervenes');
  }

  // ============================================================================================
  // 4. Scope guard: this fix touches kill() only. resume() after a kill must not re-arm or
  //    resurrect the cleared fold - the count itself is unaffected by kill/resume either way.
  // ============================================================================================
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);
    eng.kill('manual');
    eng.resume();

    await sleep(200);
    const spoken = alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    assert.strictEqual(spoken.length, 0,
      `resume() after a kill must not resurrect the cleared flush timer (got ${spoken.length} alert(s))`);
    ok('resume() after a kill does not resurrect the cleared flush timer');
  }

  cleanupDir();
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => { cleanupDir(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
