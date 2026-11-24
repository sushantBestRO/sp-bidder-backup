'use strict';
/**
 * Regression: `_planWake`'s wake-time dead branch blames the wrong close.
 *
 * A scheduled intent whose CAPTURED close has already passed, but still within
 * rehydrateGraceMs, is not retired at plan time (_closedPastGrace holds it). The wake then fires,
 * re-reads the platform, and finds the auction dead - and today that ALWAYS retires as
 * `armed_into_closed_auction`, whose fixed detail says "the closing time captured when it was
 * priced was later than the platform's". That is backwards when the captured close was itself
 * already in the past: nothing "moved" and nothing was "later" - the load was simply never armed
 * before its own already-passed close, which is exactly the case `wake_retired_past_close`
 * exists to name (the OTHER _planWake retire branch, one check earlier in the same function).
 *
 * WHAT MUST NOT MOVE: a captured close that was genuinely still AHEAD when the platform reported
 * the auction dead keeps `armed_into_closed_auction` - that IS a close that moved/closed early,
 * and the existing alert correctly names it (check 2, the control).
 *
 * Mock policy: only the platform adapter's getAuctionState is mocked, driving the wake's re-read.
 * schedule()/_planWake/the wake timer are all real; the timer is real too, driven with a short
 * bounded poll (armLeadMs and rehydrateGraceMs are both shrunk so the wake fires immediately).
 *
 *   node scripts/test-wake-dead-blames-right-close.js
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
// Polls instead of a fixed sleep, so a loaded machine only makes the test slower, never red.
async function waitFor(pred, ms = 10_000) {
  const until = Date.now() + ms;
  while (!pred()) { if (Date.now() > until) return false; await sleep(10); }
  return true;
}
const DEAD = ['armed_into_closed_auction', 'wake_retired_past_close'];
const anyDead = (eng) => () => eng._events.some((e) => e.type === 'alert' && DEAD.includes(e.kind));

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-wake-blame-'));
let seq = 0;
const tmp = () => path.join(TMPDIR, `intent-${seq++}.json`);
const cleanupDir = () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} };

const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };
const mkMeta = (id, closesAt, startsAt) => ({ id, lane: { origin: 'Bhiwandi', destination: 'Alwar' },
  equipment: '32ft', units: 1, companyName: 'BG', branchName: 'Bhiwandi', startsAt, closesAt });

function mkEngine(deadState) {
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => deadState,
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    // Shrunk so a captured close 90s past is INSIDE the grace (must not retire at plan time), and
    // armLeadMs shrunk so a startsAt already in the past fires the wake on the next tick.
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, armLeadMs: 10, rehydrateGraceMs: 300_000 },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

const kinds = (eng) => eng._events.filter((e) => e.type === 'alert').map((e) => e.kind);
const alertOf = (eng, kind) => eng._events.find((e) => e.type === 'alert' && e.kind === kind);

(async () => {
  // ============================================================================================
  // 1. MECHANISM: a captured close already in the past (but inside the grace) that the wake finds
  //    dead must retire as wake_retired_past_close, not armed_into_closed_auction.
  // ============================================================================================
  {
    const closesAt = Date.now() - 90_000;   // captured close: 90s ago - already past when scheduled
    const startsAt = Date.now() - 5_000;    // already started - the wake fires almost immediately
    const eng = mkEngine({ ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 30_000 });
    eng.schedule(mkMeta('DEAD-PAST', closesAt, startsAt), INPUTS);

    assert.ok(await waitFor(anyDead(eng)), 'precondition: the wake ran and retired the load');
    assert.ok(!eng.monitors.has('DEAD-PAST'), 'must not arm - the platform says the auction is closed');
    assert.ok(alertOf(eng, 'wake_retired_past_close'),
      `a captured close already in the past must retire as wake_retired_past_close (got kinds: ${JSON.stringify(kinds(eng))})`);
    assert.ok(!alertOf(eng, 'armed_into_closed_auction'),
      'must NOT blame armed_into_closed_auction - the captured close never "moved", it was already past');
    eng.kill('done');
    ok('a captured close already past retires as wake_retired_past_close, not armed_into_closed_auction');
  }

  // ============================================================================================
  // 2. Same alert names its branch 'wake', matching the other _planWake retire door, and the
  //    intent is still retired on disk either way.
  // ============================================================================================
  {
    const closesAt = Date.now() - 90_000;
    const startsAt = Date.now() - 5_000;
    const eng = mkEngine({ ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 30_000 });
    eng.schedule(mkMeta('DEAD-PAST-2', closesAt, startsAt), INPUTS);

    assert.ok(await waitFor(anyDead(eng)), 'precondition: the wake ran and retired the load');
    const a = alertOf(eng, 'wake_retired_past_close');
    assert.ok(a, 'precondition: the alert fired');
    assert.strictEqual(a.branch, 'wake', 'the branch must read "wake" - this is the wake-time retire, not the plan-time one');
    assert.strictEqual(eng.scheduler.get('DEAD-PAST-2').status, 'closed', 'the intent is still retired on disk');
    eng.kill('done');
    ok('the re-routed alert names its branch and the intent still retires');
  }

  // ============================================================================================
  // 3. CONTROL: a captured close that was still AHEAD when the platform reported the auction
  //    dead keeps armed_into_closed_auction - a real close-moved-or-closed-early case.
  // ============================================================================================
  {
    const closesAt = Date.now() + 900_000;  // captured close: still 15 minutes away
    const startsAt = Date.now() + 400;      // starts shortly - the wake fires on schedule
    const eng = mkEngine({ ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 60_000 });
    eng.schedule(mkMeta('DEAD-AHEAD', closesAt, startsAt), INPUTS);

    assert.ok(await waitFor(anyDead(eng)), 'CONTROL precondition: the wake ran and retired the load');
    assert.ok(!eng.monitors.has('DEAD-AHEAD'), 'CONTROL: must not arm - the platform says the auction is closed');
    assert.ok(alertOf(eng, 'armed_into_closed_auction'),
      `CONTROL: a captured close that was still ahead must keep armed_into_closed_auction (got kinds: ${JSON.stringify(kinds(eng))})`);
    assert.ok(!alertOf(eng, 'wake_retired_past_close'),
      'CONTROL: must not be re-routed - this is the case the existing alert correctly names');
    eng.kill('done');
    ok('CONTROL: a captured close that was still ahead keeps armed_into_closed_auction');
  }

  // ============================================================================================
  // 4. CONTROL: an ordinary healthy load (captured close ahead, platform still live) is untouched.
  // ============================================================================================
  {
    const closesAt = Date.now() + 900_000;
    const startsAt = Date.now() + 400;
    const eng = mkEngine({ ok: true, status: 'live', closesInMs: 890_000, closesAtMs: closesAt });
    eng.schedule(mkMeta('HEALTHY', closesAt, startsAt), INPUTS);

    await waitFor(() => eng.monitors.has('HEALTHY'));
    assert.ok(eng.monitors.has('HEALTHY'), 'CONTROL: a healthy load must still arm');
    assert.strictEqual(kinds(eng).filter((k) => k === 'armed_into_closed_auction' || k === 'wake_retired_past_close').length, 0,
      'CONTROL: no dead-auction alert of either kind fires for a healthy load');
    eng.kill('done');
    ok('CONTROL: a healthy scheduled load still arms with no dead-auction alert');
  }

  cleanupDir();
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => { cleanupDir(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
