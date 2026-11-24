'use strict';
/**
 * AN UNKNOWN CLOSE TIME IS NOT A CLOSE TIME - the engine's three terminal close-time reads.
 *
 * One coercion, three live defects, and every one of them ends a priced auction. `Number(null)` is
 * a FINITE 0, so a `Number.isFinite` guard cannot tell "the platform did not send this field" from
 * "the platform sent zero" - and on a close time, zero means both "already expired" and "1 Jan
 * 1970". This repo has the class documented (the year-2100 placeholder is its sibling: a value that
 * is equally valid as a number and equally false as a time), and both shipped adapters code around
 * this engine rather than the engine holding the invariant - realAdapter returns ok:false rather
 * than a null countdown, gocometAdapter omits closesAtMs rather than nulling it and says why in a
 * docblock. getAuctionState's own JSDoc at the seam does not even list closesAtMs or extendMs, so
 * OMITTING them is conforming behaviour and the next adapter is one field away from all three.
 *
 * WHAT THE ENGINE DOES INSTEAD, and it is the same answer at all three sites: refuse to act on an
 * unknown. Never retire on it, never adopt it as a time, never let it stand in for a verdict. The
 * load keeps the close it was already working to and stays alive for a later read to settle - the
 * fail direction _planWake's own docblock already commits to for a read that fails outright,
 * because arming and polling is recoverable and not arming is not.
 *
 *   1. THE SCHEDULED-WAKE DEATH TEST. `closesInMs: null` satisfied "already expired", so a priced
 *      load ten minutes from close was retired WITHOUT ever arming - and that branch writes
 *      status:'closed' to the durable intent, so nothing re-arms it - while telling the desk, in
 *      fixed prose, that the auction had already closed.
 *   2. THE LIVE CLOSE ADOPTED AT THE WAKE. `closesAtMs: null` read as a KNOWN close of 0, which
 *      warned the desk that the platform had moved the load's close to 1970 and then armed the
 *      monitor at epoch - persisting that epoch onto the intent. A year-2100 placeholder is the
 *      same fault in the other direction and is bounded here too.
 *   3. THE DURABLE CLOSE THAT NEVER MOVED. The intent's closesAt is written once at arm(); the
 *      believed close advances on every confirmed anti-snipe extension, in memory only. A restart
 *      between the two - `sh scripts/deploy.sh` restarts pm2 - retired a still-live auction and
 *      stamped closedWhileDown, so it read as an ordinary close on every surface. The engine knew
 *      better at that exact moment: its own believed close was ~4.9s in the future.
 *
 * WHAT MUST NOT MOVE: a genuinely expired countdown (0) still retires at the wake; a genuinely
 * closed auction still retires at rehydrate; a real published close is still adopted and a real
 * backward move still warns.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, no network.
 *
 *   node scripts/test-engine-unknown-close-time.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// COMPLETION SENTINEL, registered HERE - before a single check runs - and fired on process exit.
// run-tests.js grades a file by EXIT CODE ALONE and this file is async, so a return above the
// checks, a swallowed rejection or a require resolving to a stub all reach exit 0 as a silent green
// zero-assertion run. An assert at the BOTTOM does not close that hole: it sits downstream of
// everything it guards. Registration order is the fix.
const EXPECTED_CHECKS = 14;
process.on('exit', (code) => {
  if (pass === EXPECTED_CHECKS) {
    if (code === 0) console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: only ${pass} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `unknown-close-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };
const LANE = { origin: 'Bhiwandi', destination: 'Alwar' };

function mkEngine(state, file) {
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => state,
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file || tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, openJitterMs: 0 },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

const alertKinds = (eng) => eng._events.filter((e) => e.type === 'alert').map((e) => e.kind);

// A not-yet-started load, exactly the shape armFromRequest hands to schedule(). startsAt is now, so
// the wake fires on the next tick of the event loop rather than on a real sleep.
const scheduledMeta = (id, windowMs = 600_000) => ({
  id, lane: LANE, equipment: '32ft', units: 1, companyName: 'Syngenta', branchName: 'Bhiwandi',
  startsAt: Date.now(), closesAt: Date.now() + windowMs,
});

// The live read the wake performs. `closesInMs` / `closesAtMs` are the two fields under test.
const wakeState = (over) => Object.assign({
  ok: true, status: 'live', myRank: null, totalBidders: 2, standingL1Price: null,
  closesInMs: 600_000, closesAtMs: Date.now() + 600_000, closeModel: 'hard', extendMs: null,
  minDecrement: 100, revisionsLeft: null, measuredRttMs: 50,
}, over);

// Let the scheduled wake fire and settle, then stop every timer this engine owns so a later check
// cannot be perturbed by a stray tick.
async function settle(eng) {
  for (let i = 0; i < 20; i++) await sleep(5);
  for (const t of eng.scheduledTimers.values()) clearTimeout(t);
  for (const m of eng.monitors.values()) { if (m.timer) clearTimeout(m.timer); }
}

(async () => {
  // =============================================================================================
  // 1. THE SCHEDULED-WAKE DEATH TEST - an unknown countdown is not an expired one
  // =============================================================================================
  {
    const eng = mkEngine(wakeState({ closesInMs: 600_000 }));
    eng.schedule(scheduledMeta('W-live'), INPUTS);
    await settle(eng);
    assert.ok(eng.monitors.has('W-live'), 'a known, healthy countdown must arm the load');
    assert.ok(!alertKinds(eng).includes('armed_into_closed_auction'), 'and raise no dead-auction alert');
    eng.kill('done');
    ok('control: a known countdown still arms the load at the wake');
  }

  {
    const eng = mkEngine(wakeState({ closesInMs: 0 }));
    eng.schedule(scheduledMeta('W-expired'), INPUTS);
    await settle(eng);
    assert.ok(!eng.monitors.has('W-expired'), 'a countdown of 0 is a genuinely expired auction - still retired');
    assert.strictEqual(eng.scheduler.get('W-expired').status, 'closed', 'and still retired on the durable intent');
    assert.ok(alertKinds(eng).includes('armed_into_closed_auction'), 'and still tells the desk why');
    eng.kill('done');
    ok('control: a countdown of exactly 0 is still terminal (the real expiry case is untouched)');
  }

  for (const [label, unknown] of [['null', null], ['undefined', undefined], ['blank string', '']]) {
    const eng = mkEngine(wakeState({ closesInMs: unknown }));
    eng.schedule(scheduledMeta(`W-${label}`), INPUTS);
    await settle(eng);
    assert.ok(eng.monitors.has(`W-${label}`),
      `an UNKNOWN countdown (${label}) must not retire a priced load that is ten minutes from close - `
      + 'the load keeps its captured close and stays alive for a later read');
    assert.ok(eng._events.some((e) => e.type === 'armed' && e.auctionId === `W-${label}`),
      `an UNKNOWN countdown (${label}) must reach the arm path, not the terminal retire branch`);
    assert.ok(!alertKinds(eng).includes('armed_into_closed_auction'),
      `an UNKNOWN countdown (${label}) must not tell the desk the auction had already closed`);
    // The durable intent's STATUS is deliberately not asserted: _tick's own `state.closesInMs <= 0`
    // is the same coercion at a different site and still closes the load once it has armed, so that
    // field cannot discriminate between the two. What is pinned here is that the wake ARMED rather
    // than retiring terminally without ever creating a monitor.
    eng.kill('done');
    ok(`an unknown countdown (${label}) arms the load instead of retiring it terminally`);
  }

  // =============================================================================================
  // 2. THE LIVE CLOSE ADOPTED AT THE WAKE - unknown is not epoch 0, and a placeholder is not a close
  // =============================================================================================
  {
    // A REAL backward move is the case this read exists for: adopt it, and warn.
    const moved = Date.now() + 120_000;
    const eng = mkEngine(wakeState({ closesInMs: 120_000, closesAtMs: moved }));
    eng.schedule(scheduledMeta('W-moved'), INPUTS);
    await settle(eng);
    assert.strictEqual(eng.monitors.get('W-moved').meta.closesAt, moved,
      'a plausible published close is still adopted over the captured one');
    assert.ok(alertKinds(eng).includes('close_time_moved_earlier'), 'and a real backward move still warns the desk');
    eng.kill('done');
    ok('control: a real, plausible close-time move is still adopted and still warns');
  }

  for (const [label, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['a year-2100 placeholder', Date.parse('2100-05-24T19:53:25.000Z')],
  ]) {
    const meta = scheduledMeta(`C-${label}`);
    const eng = mkEngine(wakeState({ closesInMs: 300_000, closesAtMs: bad }));
    eng.schedule(meta, INPUTS);
    await settle(eng);
    const armed = eng.monitors.get(`C-${label}`);
    assert.ok(armed, `${label}: the load must still arm - an unusable close time is not a reason to forfeit it`);
    assert.strictEqual(armed.meta.closesAt, meta.closesAt,
      `${label}: an unusable published close must leave the captured close alone, not replace it `
      + `(armed with ${armed.meta.closesAt})`);
    assert.strictEqual(eng.scheduler.get(`C-${label}`).closesAt, meta.closesAt,
      `${label}: and must not be persisted onto the durable intent`);
    assert.ok(!alertKinds(eng).includes('close_time_moved_earlier'),
      `${label}: and must not warn the desk that the platform moved this load's close`);
    eng.kill('done');
    ok(`an unusable published close (${label}) is ignored, not armed on`);
  }

  // =============================================================================================
  // 3. THE DURABLE CLOSE THAT NEVER MOVED - a restart may not abandon a live auction
  // =============================================================================================
  {
    // 3a. A confirmed extension has to reach DISK, not just the monitor. This is the root cause:
    // without it the durable close stays at its arm-time value for the whole life of a soft auction.
    const armClose = Date.now() + 200_000;
    const eng = mkEngine(wakeState({}));
    const m = eng.arm({ id: 'X-persist', lane: LANE, units: 1, companyName: 'Havells', closesAt: armClose }, INPUTS);
    if (m.timer) clearTimeout(m.timer);
    m.closeModel = 'soft'; m.softStrategy = 'live'; m.believedCloseAt = armClose;
    assert.strictEqual(eng.scheduler.get('X-persist').closesAt, armClose, 'arm() writes the close once');

    const extended = armClose + 180_000;
    const counted = eng._observeExtension(m, { closesAtMs: extended, closesInMs: 180_000,
      extendMs: 180_000, extendCount: 3 });
    assert.strictEqual(counted, true, 'a full-interval forward jump is a confirmed extension');
    assert.strictEqual(m.believedCloseAt, extended, 'the monitor advances its belief');
    assert.strictEqual(eng.scheduler.get('X-persist').closesAt, extended,
      'and the DURABLE intent advances with it - the boot supervisor retires on this field');

    // FORWARD-ONLY on disk as well as in memory: a lower read may never pull the durable close back
    // into the retire window.
    eng._observeExtension(m, { closesAtMs: armClose, closesInMs: 10_000, extendMs: 180_000, extendCount: 3 });
    assert.strictEqual(eng.scheduler.get('X-persist').closesAt, extended,
      'a later, EARLIER close must not move the durable close backwards');
    eng.kill('done');
    ok('a confirmed extension advances the durable intent, forward-only (was memory-only)');
  }

  {
    // 3b. The whole sequence, through a real restart: arm a soft load, take an extension, then boot
    // a fresh engine against the same intents file at a moment PAST the arm-time close and BEFORE
    // the extended one. The auction is live; the restart must not end it.
    const file = tmp();
    const armClose = Date.now() + 400;
    {
      const eng = mkEngine(wakeState({}), file);
      const m = eng.arm({ id: 'R-live', lane: LANE, units: 1, companyName: 'Havells', closesAt: armClose }, INPUTS);
      if (m.timer) clearTimeout(m.timer);
      m.closeModel = 'soft'; m.softStrategy = 'live'; m.believedCloseAt = armClose;
      eng._observeExtension(m, { closesAtMs: armClose + 180_000, closesInMs: 180_000,
        extendMs: 180_000, extendCount: 3 });
      eng.kill('crash');
    }
    await sleep(600); // now past the arm-time close, ~179s short of the real one

    const eng2 = mkEngine(wakeState({ closesInMs: 179_000, closeModel: 'soft' }), file);
    await eng2.rehydrate();
    const it = eng2.scheduler.get('R-live');
    assert.ok(eng2.monitors.has('R-live'),
      'a restart between the arm-time close and the EXTENDED close must re-arm the live auction, not abandon it');
    assert.notStrictEqual(it.status, 'closed', 'and must not retire the intent');
    assert.notStrictEqual(it.closedWhileDown, true,
      'and must never stamp closedWhileDown on an auction that was still live - that reads as an ordinary close');
    eng2.kill('done');
    ok('a restart inside an extension re-arms the live auction (was permanently abandoned)');
  }

  {
    // 3c. The residual the persist cannot repair: on the sustained-zero inference the engine
    // deliberately does NOT advance its belief (it learns that a round happened, not when it now
    // ends), so the durable close can be minutes stale on a live load. Inside the grace, with no
    // outcome on the record, the platform settles it - not the timestamp.
    const file = tmp();
    {
      const eng = mkEngine(wakeState({}), file);
      const m = eng.arm({ id: 'R-grace', lane: LANE, units: 1, companyName: 'Havells',
        closesAt: Date.now() + 60_000 }, INPUTS);
      if (m.timer) clearTimeout(m.timer);
      eng.kill('crash');
    }
    const sched = new DurableScheduler(file);
    sched.update('R-grace', { closesAt: Date.now() - 300_000 }); // 5 min past, outcome unknown
    const eng2 = mkEngine(wakeState({ closesInMs: 120_000, closeModel: 'soft' }), file);
    eng2.scheduler = sched;
    await eng2.rehydrate();
    assert.ok(eng2.monitors.has('R-grace'),
      'a close that passed inside rehydrateGraceMs with NO recorded outcome must be re-armed so a live read settles it');
    assert.notStrictEqual(sched.get('R-grace').closedWhileDown, true,
      'and must not be stamped closedWhileDown on the strength of a stale timestamp');
    eng2.kill('done');
    ok('an outcome-less close inside the grace window is re-armed, not retired on a stale timestamp');
  }

  {
    // 3d. The other side of the same rule, and the behaviour that must not move: an auction that
    // really did end while the process was down is still retired, still not booked as a phantom
    // loss, and still flagged so reporting can treat the outcome as unknown.
    const file = tmp();
    {
      const eng = mkEngine(wakeState({}), file);
      const m = eng.arm({ id: 'R-dead', lane: LANE, units: 1, companyName: 'Havells',
        closesAt: Date.now() + 60_000 }, INPUTS);
      if (m.timer) clearTimeout(m.timer);
      eng.kill('crash');
    }
    const sched = new DurableScheduler(file);
    sched.update('R-dead', { closesAt: Date.now() - 3_600_000 }); // an hour past - well clear of the grace
    const eng2 = mkEngine(wakeState({ closesInMs: 0 }), file);
    eng2.scheduler = sched;
    await eng2.rehydrate();
    const it = sched.get('R-dead');
    assert.ok(!eng2.monitors.has('R-dead'), 'a long-closed auction is not re-armed');
    assert.strictEqual(it.status, 'closed', 'it is retired');
    assert.notStrictEqual(it.won, false, 'and NOT booked as a phantom loss');
    assert.strictEqual(it.closedWhileDown, true, 'closedWhileDown still means what it says');
    eng2.kill('done');
    ok('an auction that really closed while down is still retired and still flagged (no regression)');
  }

  {
    // 3e. An outcome already on the record is proof the auction ended, so the grace does not apply
    // and a recently-closed load with a known result is retired immediately.
    const file = tmp();
    {
      const eng = mkEngine(wakeState({}), file);
      const m = eng.arm({ id: 'R-known', lane: LANE, units: 1, companyName: 'Havells',
        closesAt: Date.now() + 60_000 }, INPUTS);
      if (m.timer) clearTimeout(m.timer);
      eng.kill('crash');
    }
    const sched = new DurableScheduler(file);
    sched.update('R-known', { closesAt: Date.now() - 30_000, won: true, finalRank: 1 });
    const eng2 = mkEngine(wakeState({ closesInMs: 0 }), file);
    eng2.scheduler = sched;
    await eng2.rehydrate();
    const it = sched.get('R-known');
    assert.ok(!eng2.monitors.has('R-known'), 'a load whose outcome is already recorded is not re-armed');
    assert.strictEqual(it.status, 'closed', 'it is retired on the spot');
    assert.strictEqual(it.won, true, 'with the recorded outcome intact');
    assert.notStrictEqual(it.closedWhileDown, true, 'and closedWhileDown is not stamped on a known result');
    eng2.kill('done');
    ok('a recently-closed load with a recorded outcome is retired immediately (the grace is for doubt only)');
  }

  cleanup();
})().catch((e) => { cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
