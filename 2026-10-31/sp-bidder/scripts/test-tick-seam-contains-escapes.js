'use strict';
/**
 * THE TICK SEAM - the monitor's own poll timer holds a promise nobody keeps.
 *
 * Regression target: T2 D6 (= T7 BH-ASYNC-2 / T2 BH-ASYNC-3), upheld_confirmed, deterministic 3/3.
 *   docs/bug-hunts/2026-09-16_bidcmd-T2-verify-async3.md
 *   docs/bug-hunts/2026-09-16_bidcmd-T2-dispositions.md (next-wave table, row T2 D6)
 *   docs/bug-hunts/2026-09-20_bid-command-WAVE-EXECUTION-PLAN.md row W1-5
 *
 * bidEngine.js:2443   monitor.timer = setTimeout(() => this._tick(monitor), delayMs);
 *
 * _tick is async (:2697). That promise is never awaited, never .catch()'d and never retained, so
 * anything that throws from the regions of _tick OUTSIDE its two inner try blocks leaves the engine
 * entirely. The sibling scheduled-wake timer in _planWake (:2007) already attaches a terminal
 * handler; this one attaches nothing.
 *
 * TWO post-try regions are exercised, and that is deliberate. A try/catch wrapped around the single
 * finalize call would satisfy the first and leave the seam uncontained - and it would land in the
 * three lines cluster W1-1 owns, the exact collision the W1-5 row exists to prevent.
 *   :2882  return this._finalize(monitor, state);                       <- read try closed above,
 *                                                                         _maybeBid try opens below
 *   :2926  this._schedule(monitor, this._cadence(monitor.closesInMs, monitor));   <- the tail,
 *                                                                         after every try has closed
 * The repair therefore has to be at the seam itself (:2443), which is what covers both.
 *
 * Where the escape goes: server.js logs the process-level rejection at error level and does not
 * exit, so there is no crash, no pm2 restart, and no desk-visible trace. That is bucket 3 of the
 * project's price-page gate ("currently silent - unacceptable"), and the engine already has the
 * right shape one branch away: _tick's _maybeBid catch emits
 * {type:'alert', level:'error', kind:'tick_error', auctionId} onto the channel the client's
 * Director subscribes to. A throw from the other side of that try reaches nothing.
 *
 * So the contained seam must (a) swallow no rejection at process level and (b) raise a desk-visible
 * error-level alert carrying the auctionId. The verify file's minimal flip routed the escape to
 * this.log.error alone, which the gate does not accept ("never a log line alone").
 *
 * THE KIND IS NOT PINNED, BUT ITS ROUTING IS. engineAlerts routes to the Director by KIND
 * MEMBERSHIP in ERROR_KINDS, not by level, so an error-level alert carrying a freshly minted kind
 * reaches the console ring and never reaches WhatsApp. Check 3 asserts membership only: reuse
 * tick_error, or mint a kind and ADD IT TO ERROR_KINDS, or this check fails.
 *
 * NOT THE PERSIST SITE. Every throw here is injected by stubbing a method on the engine instance,
 * above the durable write. Check 5 pins that the scheduler was never asked to persist this close,
 * so a try/catch landing at the persist site (cluster W1-1) cannot turn this file green.
 *
 * WHAT MUST NOT MOVE:
 *   - a healthy tick raises no error alert and still reschedules itself (check 7). Containing the
 *     seam must not start manufacturing error alerts on ordinary ticks.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, no network, rand pinned. No sleeps -
 * unhandledRejection fires at the end of a loop turn once microtasks drain, so it is flushed with
 * explicit alternating setTimeout(0)/setImmediate turns, never a wall-clock wait.
 *
 *   node scripts/test-tick-seam-contains-escapes.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp scheduler store), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { ERROR_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `tick-seam-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// unhandledRejection lands at the END of a loop turn, after the microtask queue drains, so the
// tick's rejection is only observable once control has left and re-entered the loop.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const settleThrice = async () => { await settle(); await settle(); await settle(); };

function mkEngine(state) {
  const events = [];
  const logs = [];
  const adapter = {
    writeEnabled: true, placed: [], reads: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => { adapter.reads += 1; return state; },
    placeBid: async (id, price) => { adapter.placed.push(price); return { accepted: true, myRank: 1 }; },
  };
  const log = {
    debug: (m, f) => logs.push({ level: 'debug', m, f }),
    info: (m, f) => logs.push({ level: 'info', m, f }),
    warn: (m, f) => logs.push({ level: 'warn', m, f }),
    error: (m, f) => logs.push({ level: 'error', m, f }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log, rand: () => 0,
  });
  eng._events = events;
  eng._logs = logs;
  return eng;
}

const mkLoad = (id, closesInMs) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 1000, closesAt: Date.now() + closesInMs,
});
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };

const errorAlertsFor = (list, id) =>
  list.filter((e) => e.type === 'alert' && e.level === 'error' && e.auctionId === id);

// A hard close whose countdown has run out: _tick takes the finalize branch on its very first tick.
const CLOSED_STATE = { ok: true, status: 'closed', myRank: 1, totalBidders: 3, standingL1Price: null,
  closesInMs: 0, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
// A live auction with time left: the tick runs past the finalize branch, through _maybeBid, and out
// the tail at :2926 - the second post-try region.
const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };

(async () => {
  // ------------------------------------------- scenario A: the finalize branch throws (:2882)
  const A_ID = 'SEAM-throw';
  const engA = mkEngine(CLOSED_STATE);
  const monA = engA.arm(mkLoad(A_ID, 1000), INPUTS);
  assert.ok(monA && monA.timer, 'setup: arm() must plant the tick timer this file is about');
  assert.strictEqual(engA.scheduler.get(A_ID).status, 'armed', 'setup: the intent is armed on disk');

  // The persist spy goes on AFTER arm(), so only what the TICK asks the scheduler to write is counted.
  const persistCalls = [];
  const realUpdate = engA.scheduler.update.bind(engA.scheduler);
  const realUpsert = engA.scheduler.upsert.bind(engA.scheduler);
  engA.scheduler.update = (id, patch) => { persistCalls.push({ op: 'update', id, patch }); return realUpdate(id, patch); };
  engA.scheduler.upsert = (intent) => { persistCalls.push({ op: 'upsert', id: intent && intent.auctionId, patch: intent }); return realUpsert(intent); };

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  // INJECTION SITE 1: _finalize on the instance, reached from `return this._finalize(monitor,
  // state)` at bidEngine.js:2882 - above the durable write, and outside every try block in _tick.
  // Nothing about the data directory, the store file or DurableScheduler's error behaviour is
  // touched, so this cannot be answered by a guard at the persist site.
  let finalizeStubCalls = 0;
  engA._finalize = async () => { finalizeStubCalls += 1; throw new Error('a post-try call in the tick threw'); };

  await settleThrice();
  process.removeListener('unhandledRejection', onRejection);

  assert.strictEqual(finalizeStubCalls, 1,
    'setup: the tick must actually reach the finalize branch - otherwise nothing was injected');

  // ------------------------------------------- scenario C: the tail throws (:2926)
  // A separate engine so it can never disturb A or the control. _cadence is called exactly once in
  // the file, as the argument to _schedule on the LAST line of _tick, after both try blocks have
  // closed - so a try/catch around the finalize call alone cannot contain this one.
  const C_ID = 'SEAM-tail';
  const engC = mkEngine(LIVE_STATE);
  const monC = engC.arm(mkLoad(C_ID, 600_000), INPUTS);
  assert.ok(monC && monC.timer, 'setup: the tail-throw load must arm too');
  const tailRejections = [];
  const onTailRejection = (reason) => tailRejections.push(reason);
  process.on('unhandledRejection', onTailRejection);
  let cadenceStubCalls = 0;
  engC._cadence = () => { cadenceStubCalls += 1; throw new Error('the tick tail threw'); };
  await settleThrice();
  process.removeListener('unhandledRejection', onTailRejection);
  assert.strictEqual(cadenceStubCalls, 1,
    'setup: the tick must reach its tail - a tail that never ran proves nothing about the tail');

  // ------------------------------------------- scenario B (control): an ordinary healthy tick
  const B_ID = 'SEAM-control';
  const engB = mkEngine(LIVE_STATE);
  const monB = engB.arm(mkLoad(B_ID, 600_000), INPUTS);
  assert.ok(monB && monB.timer, 'setup: the control load must arm too');
  const armTimerB = monB.timer;
  const controlRejections = [];
  const onControlRejection = (reason) => controlRejections.push(reason);
  process.on('unhandledRejection', onControlRejection);
  await settleThrice();
  process.removeListener('unhandledRejection', onControlRejection);

  // ------------------------------------------- 1. THE DEFECT: the rejection escapes the timer
  if (rejections.length) {
    console.error('\nUNHANDLED REJECTION ESCAPED THE TICK TIMER:');
    console.error(rejections[0] && rejections[0].stack ? rejections[0].stack : rejections[0]);
  }
  assert.strictEqual(rejections.length, 0,
    'no rejection may escape the monitor tick timer: _schedule plants '
    + 'setTimeout(() => this._tick(monitor), delayMs) (bidEngine.js:2443) with no await, no .catch '
    + 'and no retention, so a throw from the post-try call at `return this._finalize(monitor, state)` '
    + '(bidEngine.js:2882) leaves the engine entirely and surfaces at process level, where server.js '
    + 'logs it and does not exit - no crash, no restart, no desk-visible trace');
  ok('no unhandled rejection escapes the tick timer when a post-try call throws');

  // ------------------------------------------- 2. the desk is told, once, on the alert channel
  const errAlerts = errorAlertsFor(engA._events, A_ID);
  assert.strictEqual(errAlerts.length, 1,
    'a tick that threw must raise exactly ONE error-level alert carrying the auctionId - the same '
    + 'shape _tick already uses one branch away (the _maybeBid catch emits tick_error at level '
    + 'error). Zero means the silence just moved inside the engine; two means the seam and an '
    + 'inner handler are both firing on one throw');
  assert.strictEqual(errAlerts[0].auctionId, A_ID, 'the alert must name the load that threw');
  ok('exactly one desk-visible error-level alert for that auctionId reaches the engine alert channel');

  // ------------------------------------------- 3. the alert is ROUTABLE to the desk
  // engineAlerts routes on kind membership, not on level, so an unregistered kind is desk-invisible
  // however loud its level - which is still bucket 3 of the price-page gate.
  assert.ok(ERROR_KINDS.has(errAlerts[0].kind),
    `the alert kind ${JSON.stringify(errAlerts[0].kind)} is not in engineAlerts' ERROR_KINDS, so it `
    + 'reaches the console ring and never the Director - a new kind must be registered there');
  ok('the alert kind is on the desk error channel (ERROR_KINDS), so it is genuinely routable');

  // ------------------------------------------- 4. the engine survives the throw
  assert.strictEqual(engA.killed, false, 'a throwing tick must not kill the engine');
  assert.ok(engA.monitors.has(A_ID), 'the monitor is not silently dropped from the engine');
  assert.strictEqual(engA.scheduler.get(A_ID).status, 'armed',
    'and the durable intent is left exactly as the throw found it - the close never landed');
  assert.ok(engA.arm(mkLoad('SEAM-after', 600_000), INPUTS) && engA.monitors.has('SEAM-after'),
    'the engine is still usable afterwards');
  engA.kill('done');
  ok('the engine survives the throw, stays usable, and corrupts nothing else about the monitor');

  // ------------------------------------------- 5. this is the seam, not the persist site
  assert.deepStrictEqual(persistCalls.filter((c) => c.id === A_ID), [],
    'the throw was injected ABOVE the durable write, so the scheduler was never asked to persist '
    + 'this close - a try/catch at the persist site (cluster W1-1) cannot make this file green');
  ok('the scheduler was never asked to persist this close (not persist-site coupled)');

  // ------------------------------------------- 6. the OTHER post-try region is contained too
  if (tailRejections.length) {
    console.error('\nUNHANDLED REJECTION ESCAPED FROM THE TICK TAIL:');
    console.error(tailRejections[0] && tailRejections[0].stack ? tailRejections[0].stack : tailRejections[0]);
  }
  assert.strictEqual(tailRejections.length, 0,
    'the tail at bidEngine.js:2926 - this._schedule(monitor, this._cadence(...)) - sits after BOTH '
    + 'try blocks have closed, so a throw there escapes the same seam. A try/catch around the '
    + 'finalize call alone leaves this one uncontained (and lands in the three lines W1-1 owns); '
    + 'the repair has to be at the seam');
  const tailAlerts = errorAlertsFor(engC._events, C_ID);
  assert.strictEqual(tailAlerts.length, 1,
    'and the tail throw must reach the desk on the same channel, once');
  assert.ok(ERROR_KINDS.has(tailAlerts[0].kind),
    'routable to the desk, same as the finalize-branch throw');
  engC.kill('done');
  ok('a throw from the tick TAIL is contained and alerted too (defeats a finalize-only try/catch)');

  // ------------------------------------------- 7. CONTROL: an ordinary tick is unchanged
  assert.strictEqual(controlRejections.length, 0, 'setup: a healthy tick must not reject at all');
  assert.deepStrictEqual(errorAlertsFor(engB._events, B_ID), [],
    'containing the seam must not manufacture error alerts on healthy ticks');
  assert.ok(engB.monitors.has(B_ID), 'the healthy load is still being watched');
  assert.notStrictEqual(monB.timer, armTimerB,
    'and the tick ran to its tail and rescheduled itself onto a fresh handle, exactly as today');
  engB.kill('done');
  ok('an ordinary tick raises no error alert and still reschedules (this is what must not move)');

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 7;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
