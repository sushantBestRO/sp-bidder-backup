'use strict';
/**
 * A TICK FAULT AFTER THE MONITOR IS FINALIZED - no retry and no hand-off can follow, so none may be
 * promised.
 *
 * Regression target: the first-fault alert from _tickFaulted ("We are still watching it and will check
 * again shortly. If 3 checks in a row fail, we will stop bidding it and ask the desk to bid it by
 * hand") went out even when the monitor was already finalized. _schedule no-ops on a finalized
 * monitor, so the promised re-check never ran and the promised hand-off could never fire: the desk
 * was told the load was covered while nothing watched it.
 *
 * Two ways a tick faults on a finalized monitor:
 *   (a) _finalize sets monitor.finalized, then its scheduler.update(... status 'closed' ...) throws -
 *       DurableScheduler.update rolls back and rethrows on a failed persist. The monitor is still
 *       registered in engine.monitors, so ops must hear once, at error level, that the close could not
 *       be recorded and the result must be checked on the portal - with no promise of a retry.
 *   (b) an operator engine.stop(id) lands while the tick is parked on its platform read, and the
 *       continuation then throws. stop() removed the monitor; the load is someone else's now, and no
 *       tick-fault alert of any kind may go out for it.
 *
 * Fault sites: (a) the scheduler's _persist, failing only when the intent being written is 'closed',
 * so the real update() rollback-and-rethrow is what escapes _finalize; (b) _detectForeignBids, stubbed
 * on the instance, the first unconditional call after the read.
 *
 * Named re-pins (W1-1, W1-2): W1-1 now contains the failed close write inside _finalize (it reaches the
 * desk as close_record_failed), and W1-2 re-checks the monitor right after the tick's platform read, so
 * neither route above reaches _tickFaulted any more. Checks 1 and 2 keep each route and pin what now
 * happens on it, and reach the same mechanism through the fault each change leaves open: (a) a throw
 * in _finalize past its contained close write (_refusalAtClose, stubbed on the instance); (b) the stop
 * landing during the session re-check an auth-failed read awaits, which W1-2's re-check does not cover,
 * then a throw at _unreadablePastBound, stubbed on the instance, the first call after that await.
 *
 * WHAT MUST NOT MOVE:
 *   - a fault on a live monitor still sends the first-fault "still watching" alert once and plants
 *     its retry (check 3, control). It is also what keeps check 1's copy assertion from passing
 *     vacuously on a reworded alert.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), rand pinned, no
 * network, no sleeps. setTimeout/clearTimeout are faked while the engine runs so each tick is fired by
 * hand; settling uses setImmediate turns only.
 *
 *   node scripts/test-tick-fault-after-finalize.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp scheduler store), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const failures = [];
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-after-finalize-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Set();
const fakeTimers = () => {
  global.setTimeout = (fn, ms, ...args) => {
    const h = { fn, ms, args, unref() { return h; }, ref() { return h; }, hasRef() { return false; } };
    pending.add(h);
    return h;
  };
  global.clearTimeout = (h) => { if (pending.has(h)) pending.delete(h); else realClearTimeout(h); };
};
const realTimers = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const step = async () => {
  const due = [...pending];
  pending.clear();
  for (const h of due) h.fn(...h.args);
  await settle();
  return due.length;
};

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
const CLOSED_STATE = { ...LIVE_STATE, status: 'closed', closesInMs: 0 };
// named re-pin: W1-2, post-await re-check - an auth-failed read, whose session re-check is an await the
// re-check after the platform read does not cover.
const AUTH_FAILED_STATE = { ok: false, authError: true, error: 'session expired' };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 1000, closesAt: Date.now() + LIVE_STATE.closesInMs,
});

function arm(id, readState) {
  pending.clear();
  const events = [];
  const adapter = {
    writeEnabled: true, placed: [], reads: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => { adapter.reads += 1; return readState(); },
    placeBid: async (auctionId, price) => { adapter.placed.push(price); return { accepted: true, myRank: 1 }; },
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });
  const mon = eng.arm(mkLoad(id), INPUTS);
  setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${id}`);
  return { eng, adapter, events, mon, id };
}

const errorAlerts = (events, id) => events.filter((e) => {
  if (e.type !== 'alert' || e.auctionId !== id) return false;
  const n = toNotification(e);
  return !!n && n.kind === 'error';
});
const ofKind = (events, id, ...kinds) => events.filter((e) => e.type === 'alert' && e.auctionId === id && kinds.includes(e.kind));
const PROMISES = [/still watching/i, /check again/i, /stop bidding it/i];

async function check(n, name, fn) {
  const before = rejections.length;
  try {
    await fn();
    assert.strictEqual(rejections.length, before,
      `a rejection escaped the tick timer during check ${n}: ${rejections[before] && rejections[before].message}`);
    console.log(`  ok  ${n}. ${name}`);
    pass += 1;
  } catch (e) {
    if (e instanceof SetupError) throw e;
    console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
    failures.push(n);
  }
}

(async () => {
  fakeTimers();

  await check(1, 'finalize cannot persist the close: one error alert, no retry promised, no hand-off, no timer', async () => {
    const h = arm('FINAL-persist', () => CLOSED_STATE);
    const sched = h.eng.scheduler;
    const persist = sched._persist.bind(sched);
    let closeWrites = 0;
    sched._persist = () => {
      const it = sched.get(h.id);
      if (it && it.status === 'closed') { closeWrites += 1; throw new Error('injected persist failure'); }
      return persist();
    };
    await step();
    setup(closeWrites === 1, `the tick must reach _finalize's close write (${closeWrites} close write(s))`);
    setup(h.mon.finalized && h.eng.monitors.get(h.id) === h.mon,
      'the finalized monitor must still be registered - that is trigger (a)');

    // named re-pin: W1-1, contained close write - _finalize now runs to its end, so this fixture's own
    // no-bid close alert (the load closes at its first read with nothing bid) fires as on a healthy disk.
    const alerts = errorAlerts(h.events, h.id).filter((e) => e.kind !== 'never_bid_before_close');
    assert.strictEqual(alerts.length, 1,
      `exactly one error-routable alert for a close that could not be recorded (got ${alerts.length}: `
      + `${JSON.stringify(alerts.map((e) => e.kind))})`);
    assert.strictEqual(alerts[0].kind, 'close_record_failed',
      'named re-pin: W1-1, contained close write - the failed close write must be caught in _finalize and '
      + `reach the desk as close_record_failed, not escape as a tick fault (got ${alerts[0].kind})`);
    const detail = String(alerts[0].detail || '');
    const promised = PROMISES.filter((re) => re.test(detail));
    assert.deepStrictEqual(promised, [],
      '_tickFaulted sent the first-fault copy on a finalized monitor: it promises a re-check and a desk '
      + 'hand-off, but _schedule no-ops once monitor.finalized is set, so neither can ever happen. '
      + `Detail sent: ${JSON.stringify(detail)}`);
    assert.deepStrictEqual(ofKind(h.events, h.id, 'tick_fault_handoff'), [], 'no desk hand-off for a finalized monitor');
    assert.strictEqual(pending.size, 0, `no timer may be planted after the fault (${pending.size} pending)`);
    h.eng.kill('done');

    // named re-pin: W1-1, contained close write - the same trigger (a) through the fault W1-1 leaves open:
    // _finalize throws past its close write, after it set monitor.finalized, with the monitor registered.
    const g = arm('FINAL-after-close', () => CLOSED_STATE);
    let lateThrows = 0;
    g.eng._refusalAtClose = () => { lateThrows += 1; throw new Error('injected fault past the close write'); };
    await step();
    setup(lateThrows === 1, `the tick must reach _finalize past its close write (${lateThrows} call(s))`);
    setup(g.mon.finalized && g.eng.monitors.get(g.id) === g.mon,
      'the finalized monitor must still be registered - that is trigger (a)');
    const late = errorAlerts(g.events, g.id);
    assert.strictEqual(late.length, 1,
      `exactly one error-routable alert for a close whose result could not be recorded (got ${late.length}: `
      + `${JSON.stringify(late.map((e) => e.kind))})`);
    const lateDetail = String(late[0].detail || '');
    const latePromised = PROMISES.filter((re) => re.test(lateDetail));
    assert.deepStrictEqual(latePromised, [],
      '_tickFaulted sent the first-fault copy on a finalized monitor: it promises a re-check and a desk '
      + 'hand-off, but _schedule no-ops once monitor.finalized is set, so neither can ever happen. '
      + `Detail sent: ${JSON.stringify(lateDetail)}`);
    assert.deepStrictEqual(ofKind(g.events, g.id, 'tick_fault_handoff'), [], 'no desk hand-off for a finalized monitor');
    assert.strictEqual(pending.size, 0, `no timer may be planted after the fault (${pending.size} pending)`);
    g.eng.kill('done');
  });

  await check(2, 'operator stop lands mid-read and the continuation throws: no tick-fault alert at all', async () => {
    let release;
    const parked = new Promise((r) => { release = r; });
    const h = arm('FINAL-stopped', () => parked);
    await step();
    setup(h.adapter.reads === 1, 'the tick must be parked on its platform read');
    h.eng.stop(h.id);
    setup(!h.eng.monitors.has(h.id) && h.mon.finalized, 'stop() must have finalized and removed the monitor');
    let thrown = 0;
    h.eng._detectForeignBids = () => { thrown += 1; throw new Error('injected post-read fault'); };
    release(LIVE_STATE);
    await settle();
    assert.strictEqual(thrown, 0,
      'named re-pin: W1-2, post-await re-check - the continuation of a read parked across an operator stop '
      + `must return at the re-check before any post-read code runs (reached it ${thrown} time(s))`);

    const faultAlerts = ofKind(h.events, h.id, 'tick_fault', 'tick_fault_handoff');
    assert.deepStrictEqual(faultAlerts.map((e) => e.kind), [],
      'a tick that faulted after an operator stop() still alerted: _tickFaulted does not check '
      + 'monitor.finalized, so it tells the desk the load is still watched although stop() removed it. '
      + `Detail sent: ${JSON.stringify(faultAlerts[0] && faultAlerts[0].detail)}`);
    assert.strictEqual(pending.size, 0, `no timer may be planted for a stopped load (${pending.size} pending)`);
    h.eng.kill('done');

    // named re-pin: W1-2, post-await re-check - the same trigger (b) through the await W1-2 leaves open:
    // the stop lands while the tick is parked on the session re-check after an auth-failed read.
    let resume;
    const sessionParked = new Promise((r) => { resume = r; });
    const g = arm('FINAL-stopped-auth', () => AUTH_FAILED_STATE);
    let sessionChecks = 0;
    g.adapter.ensureSession = () => { sessionChecks += 1; return sessionParked; };
    await step();
    setup(g.adapter.reads === 1 && sessionChecks === 1, 'the tick must be parked on its session re-check');
    g.eng.stop(g.id);
    setup(!g.eng.monitors.has(g.id) && g.mon.finalized, 'stop() must have finalized and removed the monitor');
    let thrownAfterSession = 0;
    g.eng._unreadablePastBound = () => { thrownAfterSession += 1; throw new Error('injected post-session fault'); };
    resume({});
    await settle();
    setup(thrownAfterSession === 1, `the continuation must reach the post-session fault (${thrownAfterSession} call(s))`);

    const sessionFaultAlerts = ofKind(g.events, g.id, 'tick_fault', 'tick_fault_handoff');
    assert.deepStrictEqual(sessionFaultAlerts.map((e) => e.kind), [],
      'a tick that faulted after an operator stop() still alerted: _tickFaulted does not check '
      + 'monitor.finalized, so it tells the desk the load is still watched although stop() removed it. '
      + `Detail sent: ${JSON.stringify(sessionFaultAlerts[0] && sessionFaultAlerts[0].detail)}`);
    assert.strictEqual(pending.size, 0, `no timer may be planted for a stopped load (${pending.size} pending)`);
    g.eng.kill('done');
  });

  await check(3, 'control: a fault on a live monitor sends the still-watching alert once and plants a retry', async () => {
    const h = arm('FINAL-control', () => LIVE_STATE);
    let calls = 0;
    h.eng._checkDelisted = () => { calls += 1; throw new Error('injected tick fault'); };
    await step();
    setup(calls === 1, 'the tick must reach the injected fault');
    const faults = ofKind(h.events, h.id, 'tick_fault');
    assert.strictEqual(faults.length, 1, `one tick_fault alert on a live monitor (got ${faults.length})`);
    assert.ok(/still watching/i.test(String(faults[0].detail || '')),
      `the live-monitor alert still promises the re-check: ${JSON.stringify(faults[0].detail)}`);
    assert.strictEqual(errorAlerts(h.events, h.id).length, 1, 'and it routes to the error channel');
    assert.ok(pending.size === 1 && h.eng.monitors.get(h.id) === h.mon && !h.mon.finalized,
      `the live monitor stays registered with its retry planted (${pending.size} pending)`);
    h.eng.kill('done');
  });

  realTimers();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/3 passed)`);
    process.exit(1);
  }
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realTimers(); cleanup(); console.error(e); process.exit(1); });
