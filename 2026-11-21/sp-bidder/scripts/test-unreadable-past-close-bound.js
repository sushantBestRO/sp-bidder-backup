'use strict';
/**
 * A monitor whose reads never come back must not poll forever.
 *
 * THE DEFECT. _tick's `!state.ok` branch counted failures, fired ONE alert at exactly the fifth,
 * and then rescheduled - unconditionally, with no terminal condition anywhere on the path. A load
 * the portal stopped answering for therefore kept a live timer and an intent at 'bidding' for the
 * lifetime of the process, and after that fifth alert it did so in total silence. The auction was
 * over; nothing said so, and nothing ever would.
 *
 * The bound is AGE PAST THE CLOSE, not a failure count. Failures accrue at whatever rate the retry
 * happens to run at, so a count is a statement about the poll cadence rather than about the auction;
 * only elapsed time past the close says the thing that matters, which is that this load cannot still
 * be running. Retirement lands in the SAME closedWhileDown shape the restart sweep uses, because it
 * is the same fact: the end of this auction was never seen.
 *
 *   A. reads failing well past the close -> retired closedWhileDown, LOUDLY, with won/rank unknown.
 *   B. reads failing BEFORE the close -> never retired. A read can fail for minutes while an auction
 *      is genuinely still live, and retiring then would forfeit a load we could still bid.
 *   C. an UNKNOWN close time -> bounded by the OUTAGE instead. There is no close to measure against,
 *      but there is still a clock (how long this load has been continuously unreadable), and leaving
 *      the branch unbounded left a silent-forever path in the change that exists to remove them.
 *   D. reads that RECOVER past the close -> never retired. The bound is armed by unreadability, and
 *      a load we can read is settled by the ordinary finalize path, not by this one.
 *   E. ONE OUTAGE, ONE MESSAGE. Every load armed across a read outage retires a bound past its own
 *      close, so an ungated emit sends one error-class WhatsApp per stranded load about a single
 *      fault. The gate is on the message only, the count folded into a quiet window rides the next
 *      one, and the clock is the engine's own - the auth latch it used to borrow does not exist on
 *      the GoComet adapter this path was written for.
 *
 *   node scripts/test-unreadable-past-close-bound.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine, DEFAULTS } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAND = [12.6, 7.2, 6.3];
const tmp = (tag) => path.join(os.tmpdir(), `unread-${tag}-${process.pid}.json`);

// Short enough to run, long enough that the retry cadence (<=1s) genuinely gets several failures in
// before the bound trips - so the test is exercising the age rule and not a race with the first tick.
const RETIRE_MS = 1_500;
const cfg = { openAtMs: 15_000, floorWindowMs: 2_500, unreadableRetireMs: RETIRE_MS };

/** An adapter whose reads fail on demand. `ok` flips to model a portal that comes back. */
function stub(ctrl) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    writeEnabled: false,
    async getAuctionState() {
      if (!ctrl.ok) return { ok: false, error: 'ECONNRESET' };
      return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
        closesInMs: ctrl.closesInMs, closeModel: 'soft', extendMs: 0, revisionsLeft: 3, measuredRttMs: 20 };
    },
    async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 }; },
  };
}

function engineOn(file, ctrl, alerts) {
  return new BidEngine(stub(ctrl), new DurableScheduler(file), {
    config: cfg,
    onEvent: (e) => { if (e.type === 'alert' || e.type === 'closed_while_down') alerts.push(e); },
  });
}

function cleanup(eng, file) {
  try { eng.kill(); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
}

(async () => {
  // ---- 0. the SHIPPED bound, which every block below deliberately overrides ----
  // Those blocks substitute a 1.5s bound so the suite can run in seconds, which means none of them
  // can notice the production value being cut. The shipped number is the one that decides whether a
  // still-running auction survives a read outage, so it is pinned here on its own.
  ok(DEFAULTS.unreadableRetireMs === 7_200_000,
    `0: DEFAULTS.unreadableRetireMs must be 2h = 7,200,000ms (got ${DEFAULTS.unreadableRetireMs}). `
    + 'Sized above the measured worst case: the worst GoComet load on record self-extended 22 rounds '
    + 'at ~299s, and 22 x 299s = 6578s = 1h50m; 2h clears it by ~10min. One hour does NOT clear it - '
    + 'it is barely over half - and the bound is measured against believedCloseAt, which only advances '
    + 'on reads that SUCCEED, so during the outage this feature triggers on the belief is frozen while '
    + 'a live auction keeps extending. Retirement is permanent; a short bound forfeits a priced load.');

  // ---- A. unreadable past the close -> retired loudly ----
  {
    const f = tmp('past');
    const alerts = [];
    const ctrl = { ok: false, closesInMs: 0 };
    const eng = engineOn(f, ctrl, alerts);
    // Armed with a close that has ALREADY passed by more than the bound, so the very first failing
    // read is past it. This is the box's real shape: the process came back to a load it can no
    // longer read, long after that load was due to end.
    eng.arm({ id: 'U1', lane: { origin: 'A', destination: 'B' }, units: 1,
      closesAt: Date.now() - (RETIRE_MS + 5_000) }, { cost: 50_000, marginsPct: BAND });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && eng.scheduler.get('U1').status !== 'closed') await sleep(100);

    const it = eng.scheduler.get('U1');
    ok(it.status === 'closed',
      `A: an unreadable load past its close is retired instead of retrying forever (got '${it.status}')`);
    ok(it.closedWhileDown === true,
      'A: retired into the SAME closedWhileDown shape the restart sweep uses - the bot does not know how it ended');
    ok(it.won !== false, 'A: won is not false - no phantom loss is booked');
    ok(it.finalRank == null, 'A: and no final rank is invented');
    ok(!eng.monitors.has('U1') || eng.monitors.get('U1').finalized === true,
      'A: the monitor is finalized - the timer is gone, not merely ignored');

    // LOUD, per the price-page gate: a runtime-only surprise gets a desk-visible error, never a log
    // line alone. This is the alert that replaces the silence after the fifth read failure.
    const loud = alerts.find((e) => e.kind === 'unreadable_past_close_retired' && e.auctionId === 'U1');
    ok(!!loud, 'A: it raises unreadable_past_close_retired - the desk is told, not just the log file');
    ok(!!loud && loud.level === 'error', 'A: at error level');
    ok(!!loud && typeof loud.detail === 'string' && loud.detail.length > 0,
      'A: with plain-language detail a director can act on');
    ok(!!loud && !/[–—]/.test(loud.detail), 'A: and no em dash in it - this reaches WhatsApp');
    ok(!!loud && !/\d{4,}/.test(loud.detail),
      'A: and no rupee figures - this channel reaches the client, our ladder prices do not go on it');
    // 2026-09-16 length trim: the client flagged this alert as too long and asked it to read as
    // the load having disappeared from the portal.
    ok(!!loud && /stopped showing on the portal/i.test(loud.detail),
      'A: reads as the load having disappeared from the portal');
    ok(!!loud && !/we could not read this load from the portal for a long time/i.test(loud.detail),
      'A: and drops the old wordier mechanics-first phrasing');
    cleanup(eng, f);
  }

  // ---- B. unreadable BEFORE the close -> never retired ----
  {
    const f = tmp('before');
    const alerts = [];
    const ctrl = { ok: false, closesInMs: 60_000 };
    const eng = engineOn(f, ctrl, alerts);
    eng.arm({ id: 'U2', lane: { origin: 'A', destination: 'B' }, units: 1,
      closesAt: Date.now() + 60_000 }, { cost: 50_000, marginsPct: BAND });
    await sleep(RETIRE_MS * 3); // comfortably longer than the bound, but the close has not passed
    const it = eng.scheduler.get('U2');
    ok(it.status !== 'closed',
      `B: a load still BEFORE its close is never retired on read failures (got '${it.status}') - it may still be bid`);
    ok(!alerts.some((e) => e.kind === 'unreadable_past_close_retired'),
      'B: and no retirement alert fires for it');
    cleanup(eng, f);
  }

  // ---- C. unknown close time -> bounded by the OUTAGE instead, never left silent ----
  // There is no close to measure age past, but there is still a clock: how long the load has been
  // continuously unreadable. Returning false outright here left one silent-forever path in the very
  // change that exists to remove them, which the project's price-page gate calls unacceptable.
  {
    const f = tmp('noclose');
    const alerts = [];
    const eng = engineOn(f, { ok: false, closesInMs: 0 }, alerts);
    eng.arm({ id: 'U3', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: null },
      { cost: 50_000, marginsPct: BAND });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && eng.scheduler.get('U3').status !== 'closed') await sleep(100);
    const it = eng.scheduler.get('U3');
    ok(it.status === 'closed',
      `C: a load with NO known close, unreadable for longer than the bound, is still retired (got '${it.status}') - silence is not an option here either`);
    ok(it.closedWhileDown === true, 'C: into the same unknown shape');
    ok(alerts.some((e) => e.kind === 'unreadable_past_close_retired'),
      'C: and it is announced - the price-page gate forbids a currently-silent failure mode');
    cleanup(eng, f);
  }

  // The WRITE GATE that keeps a writes-off portal from re-arming lives one layer up, in
  // rehydrateGoCometStack (src/web/server.js), because the engine's capability reads are a pinned
  // seam. Its coverage is in scripts/test-gocomet-restart-rehydrate.js, scenario writes-off.

  // ---- D. reads that recover are settled by the ordinary path ----
  {
    const f = tmp('recover');
    const alerts = [];
    const ctrl = { ok: false, closesInMs: 30_000 };
    const eng = engineOn(f, ctrl, alerts);
    eng.arm({ id: 'U4', lane: { origin: 'A', destination: 'B' }, units: 1,
      closesAt: Date.now() - (RETIRE_MS + 5_000) }, { cost: 50_000, marginsPct: BAND });
    ctrl.ok = true; // the portal answers again before the bound could trip
    await sleep(RETIRE_MS * 3);
    ok(!alerts.some((e) => e.kind === 'unreadable_past_close_retired'),
      'D: a load the bot CAN read is never retired by the unreadable bound, however late it is');
    ok(eng.scheduler.get('U4').closedWhileDown !== true,
      'D: ...so nothing stamps closedWhileDown on a load whose state we can actually see');
    cleanup(eng, f);
  }

  // ---- E. one outage, one message ----
  {
    const f = tmp('fanout');
    const alerts = [];
    const ANNOUNCE_MS = 60_000;
    const eng = new BidEngine(stub({ ok: false, closesInMs: 0 }), new DurableScheduler(f), {
      config: Object.assign({}, cfg, { unreadableAnnounceWindowMs: ANNOUNCE_MS }),
      onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
    });
    const armPastClose = (id) => eng.arm(
      { id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() - (RETIRE_MS + 5_000) },
      { cost: 50_000, marginsPct: BAND });
    const retired = (ids) => ids.every((id) => (eng.scheduler.get(id) || {}).status === 'closed');
    const retireAlerts = () => alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    const settle = async (ids) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !retired(ids)) await sleep(100);
    };

    const batch = ['F1', 'F2', 'F3'];
    for (const id of batch) armPastClose(id);
    await settle(batch);

    ok(batch.every((id) => eng.scheduler.get(id).closedWhileDown === true),
      'E: every stranded load is still retired - the gate is on the message, never on the retirement');
    ok(retireAlerts().length === 1,
      `E: three loads stranded by ONE outage produce one error-class message, not three (got ${retireAlerts().length})`);

    // The window elapsing, without a real 60-second sleep in a suite that runs in seconds.
    eng._unreadableAnnouncedAt = Date.now() - (ANNOUNCE_MS + 1);
    armPastClose('F4');
    await settle(['F4']);

    const spoken = retireAlerts();
    ok(spoken.length === 2, `E: past the window the next retirement speaks again (got ${spoken.length})`);
    ok(/2 more were stopped the same way/.test(spoken[1].detail),
      `E: and it carries the two folded into the quiet window - a consolidation, not a discard (got "${spoken[1].detail}")`);
    // A COUNT IS NOT AN INSTRUCTION. The alert's own remedy is "check the portal", and engineAlerts
    // dedupes this kind per auctionId, so a bare "(2 more)" left the desk with no way to reconstruct
    // WHICH two loads it was being asked to check - nothing downstream carries them either.
    ok(/F2/.test(spoken[1].detail) && /F3/.test(spoken[1].detail),
      `E: naming the folded loads, not only counting them (got "${spoken[1].detail}")`);
    // The blanket "no 4-digit run" guard would now forbid a real GoComet load id, and an id is not
    // money - it is the one value the desk needs to act. The constraint is rupee figures, so that is
    // what is asserted.
    ok(!/[–—]/.test(spoken[1].detail) && !/(?:Rs|₹)\s*\d/i.test(spoken[1].detail),
      'E: the rolled-up detail keeps the channel rules - no em dash, no rupee figures');
    cleanup(eng, f);
  }

  // ---- F. the window DRAINS: a folded retirement is never left unspoken ----
  // The window consolidated by making the count ride the NEXT message, which works only while a next
  // message exists. At the tail of an outage it does not - the last loads abandoned are precisely the
  // ones with no successor - so their retirement was announced nowhere. Two drains close it.
  {
    // F1: the portal starts answering again. The outage is over, so no successor is coming.
    const f = tmp('drain-recover');
    const alerts = [];
    const ctrl = { ok: false, closesInMs: 0 };
    const eng = new BidEngine(stub(ctrl), new DurableScheduler(f), {
      config: Object.assign({}, cfg, { unreadableAnnounceWindowMs: 60_000 }),
      onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
    });
    const retireAlerts = () => alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    const armPastClose = (id) => eng.arm(
      { id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() - (RETIRE_MS + 5_000) },
      { cost: 50_000, marginsPct: BAND });
    const settle = async (id) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (eng.scheduler.get(id) || {}).status !== 'closed') await sleep(100);
    };

    armPastClose('D1'); await settle('D1');
    armPastClose('D2'); await settle('D2');
    ok(retireAlerts().length === 1, `F1: fixture - D2 is folded into D1's window (got ${retireAlerts().length})`);

    // A read that succeeds anywhere on this engine is the outage clearing - the same instant
    // monitor._firstReadFailAt is reset, which used to drop the outage clock and leave the fold count.
    ctrl.ok = true;
    ctrl.closesInMs = 600_000;
    eng.arm({ id: 'D3', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 600_000 },
      { cost: 50_000, marginsPct: BAND });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && retireAlerts().length < 2) await sleep(100);

    const drained = retireAlerts();
    ok(drained.length === 2, `F1: the folded retirement is spoken when the portal answers again (got ${drained.length})`);
    ok(drained.length > 1 && /D2/.test(drained[1].detail),
      `F1: ...naming the load it is asking the desk to check (got "${drained.length > 1 && drained[1].detail}")`);
    ok(drained.length > 1 && drained[1].level === 'error',
      'F1: at the same error level as the retirement it stands for');
    ok(eng._unreadableFolded === 0, 'F1: and the fold count is cleared, so it cannot be spoken twice');
    cleanup(eng, f);
  }

  {
    // F2: the outage does NOT clear. A one-shot timer one window long speaks anyway, because the
    // desk waiting for a portal to recover is exactly the case that has no successor.
    const f = tmp('drain-timer');
    const alerts = [];
    const ANNOUNCE_MS = 1_200;
    const eng = new BidEngine(stub({ ok: false, closesInMs: 0 }), new DurableScheduler(f), {
      config: Object.assign({}, cfg, { unreadableAnnounceWindowMs: ANNOUNCE_MS }),
      onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
    });
    const retireAlerts = () => alerts.filter((e) => e.kind === 'unreadable_past_close_retired');
    const armPastClose = (id) => eng.arm(
      { id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() - (RETIRE_MS + 5_000) },
      { cost: 50_000, marginsPct: BAND });
    const settle = async (id) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (eng.scheduler.get(id) || {}).status !== 'closed') await sleep(100);
    };

    armPastClose('T1'); await settle('T1');
    armPastClose('T2'); await settle('T2');
    ok(retireAlerts().length === 1, `F2: fixture - T2 is folded (got ${retireAlerts().length})`);

    const deadline = Date.now() + ANNOUNCE_MS * 5;
    while (Date.now() < deadline && retireAlerts().length < 2) await sleep(100);
    const spoken = retireAlerts();
    ok(spoken.length === 2,
      `F2: with no successor and no recovery, the timer speaks the folded retirement (got ${spoken.length})`);
    ok(spoken.length > 1 && /T2/.test(spoken[1].detail),
      `F2: ...naming it (got "${spoken.length > 1 && spoken[1].detail}")`);
    // Guards the guard: a timer that re-fires would put the fan-out back through a new door.
    await sleep(ANNOUNCE_MS * 2);
    ok(retireAlerts().length === 2,
      `F2: and it fires ONCE - a repeating drain would be the fan-out this window exists to stop (got ${retireAlerts().length})`);
    cleanup(eng, f);
  }

  const EXPECTED_CHECKS = 35;
  assert.strictEqual(fail, 0, `${fail} unreadable-past-close checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
