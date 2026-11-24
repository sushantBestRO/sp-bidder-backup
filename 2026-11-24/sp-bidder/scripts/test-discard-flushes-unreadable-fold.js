'use strict';
/**
 * E9, the teardown half. kill() releases the unreadable-flush timer and speaks any fold it was
 * holding (test-kill-clears-unreadable-flush-timer.js). discard() - the path teardownStack takes
 * when a stack is thrown away, e.g. on an account rebuild - used to only set this.discarded = true.
 * The timer survived it, unreleased and still pointed at an engine nobody holds a reference to any
 * more, and _flushUnreadableFolded carries no discarded guard and speaks unconditionally - so a fold
 * armed just before teardown could still reach the desk up to unreadableAnnounceWindowMs (2h
 * default) after the stack was torn down, naming loads a replacement engine may already be watching.
 *
 * MUST NOT MOVE: a discard with nothing folded raises nothing and leaves no timer behind either
 * (check 3, the control).
 *
 * Mock policy: none needed. The fold state and its timer are engine-internal fields set directly,
 * matching the fold branch in _retireUnreadable; the timer itself is real and short (advanced by
 * waiting past its delay), so no adapter, network or scheduler I/O is required.
 *
 * Run: node scripts/test-discard-flushes-unreadable-fold.js
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'discard-flush-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

function mkEngine(alerts) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('no bid expected in this scenario'); },
  };
  return new BidEngine(adapter, new DurableScheduler(path.join(ROOT, `intent-${seq++}.json`)), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500 },
    onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
  });
}

// The exact shape _retireUnreadable's fold branch leaves behind: a nonzero count plus the one-shot
// flush timer, without needing a real portal outage to reach it.
function armFold(eng, ms) {
  eng._unreadableFolded = 2;
  eng._unreadableFoldedIds = ['LOAD-A', 'LOAD-B'];
  eng._armUnreadableFlushTimer(ms);
}

(async () => {
  // ---- control first: nothing folded, so discard must raise nothing and leave no timer ----
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    assert.strictEqual(eng._unreadableFlushTimer, null, 'precondition: no fold, no timer');
    eng.discard();
    assert.strictEqual(alerts.length, 0, 'control: a discard with nothing folded must raise nothing');
    assert.strictEqual(eng._unreadableFlushTimer, null, 'control: still no timer after a no-op discard');
    ok('1. control: discard with nothing folded emits nothing');
  }

  // ---- the mechanism: a fold pending at discard time must be spoken immediately ----
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);
    assert.ok(eng._unreadableFlushTimer, 'precondition: the flush timer is armed');

    eng.discard();
    const spoken = alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    assert.strictEqual(spoken.length, 1,
      `discard() must speak a pending fold immediately, not leave it for the timer; saw ${spoken.length}`);
    assert.ok(/LOAD-A/.test(spoken[0].detail) && /LOAD-B/.test(spoken[0].detail),
      `the spoken alert must name the folded loads; detail was ${JSON.stringify(spoken[0].detail)}`);
    assert.strictEqual(eng._unreadableFlushTimer, null,
      'discard() must release the flush timer handle - no live handle left pointed at a torn-down engine');
    ok('2. discard() speaks a pending fold at once and releases the flush timer');
  }

  // ---- and it must not ALSO speak again later, whatever the process does afterward ----
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    armFold(eng, 50);
    eng.discard();

    await sleep(200); // comfortably longer than the timer's original delay
    const spoken = alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    assert.strictEqual(spoken.length, 1,
      `a discarded engine must speak its fold exactly once, at discard - saw ${spoken.length} total after waiting past the original delay`);
    ok('3. nothing speaks again after discard, however long the process runs afterward');
  }

  console.log(`\nPASS ${pass}/3 checks passed`);
})().catch((e) => {
  console.error('FAIL: discard() unreadable-fold flush: ' + (e && e.stack));
  process.exit(1);
});
