'use strict';
/**
 * THE DEFERRED-ARM PATH - waking into an auction that is already over.
 *
 * Regression target: BG loads 23569213 and 23679922 (2026-08-05 forensic trace).
 *
 * A load whose snapshot says "not started yet" does not arm when the desk enters a rate.
 * armFromRequest routes it to schedule(), which sleeps until the snapshot's start time. Two faults
 * lived on that path, and together they produced a silent zero bid on a load a human had priced.
 *
 * 1. IT WAS INVISIBLE. Nothing logged when the wake was planned, and `type:'scheduled'` falls
 *    through bidLogger's default, so the bid stream held no record at all until the wake fired. On
 *    BG load 23679922 the gap between capture and the engine's single poll was 2,922,676 ms -
 *    48.7 minutes - and nothing in the record explained it. `armedAt` landed 9,976 ms before the
 *    snapshot's startsAt, i.e. exactly armLeadMs, which is what identified the path.
 *
 * 2. EVERY CLOSE CHECK READ THE FROZEN SNAPSHOT. The price-request load object is written once at
 *    first discovery and never refreshed (discovery skips a load it has already seen). If
 *    SuperProcure moved the window, the snapshot still said "opens later" while the auction was
 *    over. The wake armed into a dead auction, the first poll read remainingMs 0, and the load
 *    closed having placed nothing. Same signature on KEI 23794211: armed against a captured close
 *    of 11:45 IST when the real close was 11:29.
 *
 * Both loads are units=1, so this is unrelated to the multi-vehicle quantity defect - though both
 * are downstream of the same write-once snapshot.
 *
 * Making the wake async then opened a window of its own, and checks 8-10 pin what has to survive it:
 * nothing captured before the platform read may be reused after it, and a wake that throws may not
 * leave the load un-armed and un-retired.
 *
 * WHAT MUST NOT MOVE:
 *   - a bad or absent platform read still ARMS (check 5). Not arming on a transient blip would turn
 *     this fix into the very silent forfeit it exists to prevent.
 *   - a normal scheduled load still arms exactly as before (check 1).
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, no network. The engine's own timer
 * is driven with short real sleeps because _planWake's setTimeout is the unit under test.
 *
 *   node scripts/test-wake-into-dead-auction.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `wake-dead-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `state` is what getAuctionState returns at wake time - the LIVE platform view, deliberately
// independent of the intent's frozen closesAt so the two can be made to disagree. `hooks.onRead` is
// awaited INSIDE that read, which is the only way to land a stop or a re-price in the window the
// await actually opens. ONE-SHOT: the armed monitor polls through the same adapter, so a hook that
// re-fired on those ticks would keep re-applying its mutation and a load that DID wrongly arm would
// be quietly stopped again before the assertion ran - the test would then pass on the bug.
function mkEngine({ state = null, throws = false } = {}) {
  const events = [];
  const logs = [];
  const hooks = { onRead: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      if (hooks.onRead) { const fire = hooks.onRead; hooks.onRead = null; await fire(); }
      if (throws) throw new Error('read blew up');
      return state;
    },
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  };
  const log = {
    debug: (m, f) => logs.push({ level: 'debug', m, f }),
    info: (m, f) => logs.push({ level: 'info', m, f }),
    warn: (m, f) => logs.push({ level: 'warn', m, f }),
    error: (m, f) => logs.push({ level: 'error', m, f }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    onEvent: (e) => events.push(e), log,
  });
  eng._events = events;
  eng._logs = logs;
  eng._hooks = hooks;
  return eng;
}

// A scheduled (not-yet-started) load, exactly the shape armFromRequest hands to schedule().
const mkMeta = (id, { startsIn = 400, windowMs = 900_000 } = {}) => ({
  id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
  companyName: 'BG', branchName: 'Bhiwandi',
  startsAt: Date.now() + startsIn,
  closesAt: Date.now() + startsIn + windowMs,
});
const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };

const kinds = (eng) => eng._events.filter((e) => e.type === 'alert').map((e) => e.kind);
const alertOf = (eng, k) => eng._events.find((e) => e.type === 'alert' && e.kind === k);

(async () => {
  // ------------------------------------------------------- 1. the happy path is unchanged
  {
    // A live, open auction at wake time must arm exactly as before. This is the no-regression pin:
    // everything else here changes what happens when the platform DISAGREES with the snapshot, and
    // none of it may disturb the case where they agree.
    const closesAt = Date.now() + 900_000;
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000, closesAtMs: closesAt } });
    eng.schedule(mkMeta('W-ok'), INPUTS);
    assert.strictEqual(eng.scheduler.get('W-ok').status, 'scheduled', 'a not-yet-started load is scheduled, not armed');
    await sleep(700);
    assert.ok(eng.monitors.has('W-ok'), 'the wake must arm a genuinely open auction');
    assert.ok(eng._events.some((e) => e.type === 'armed'), 'and emit armed');
    assert.ok(!kinds(eng).includes('armed_into_closed_auction'), 'no false dead-auction alert');
    eng.kill('done');
    ok('a normal scheduled load still arms at the wake (no regression)');
  }

  // ------------------------------------------------------- 2. the deferral is now visible
  {
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000 } });
    eng.schedule(mkMeta('W-log'), INPUTS);
    const line = eng._logs.find((l) => /arm deferred to a scheduled wake/.test(l.m));
    assert.ok(line, 'planning a wake must log - this is the line that would have explained 23679922');
    assert.strictEqual(line.f.auctionId, 'W-log');
    assert.ok(Number.isFinite(line.f.delayMs), 'the log must carry how long we are about to sleep');
    assert.ok(Number.isFinite(line.f.windowMs), 'and the auction window the snapshot claims');
    eng.kill('done');
    ok('planning a deferred arm is logged with the delay and the claimed window (was silent)');
  }

  // ------------------------------------------------------- 3. THE DEFECT: wake into a dead auction
  {
    // The snapshot says the window has not opened yet; the platform says it is over. Before this
    // fix the engine armed, polled once at remainingMs 0, and closed with a zero-bid record and no
    // explanation. Now it retires WITHOUT arming and says so.
    const realClose = Date.now() - 60_000; // closed a minute ago, per the platform
    const eng = mkEngine({ state: { ok: true, status: 'closed', closesInMs: 0, closesAtMs: realClose } });
    eng.schedule(mkMeta('W-dead'), INPUTS);
    await sleep(700);
    assert.ok(!eng.monitors.has('W-dead'), 'must NOT arm into an auction the platform says is closed');
    const a = alertOf(eng, 'armed_into_closed_auction');
    assert.ok(a, 'the silent zero-bid is now a named alert');
    assert.strictEqual(a.platformCloseAt, realClose, 'carrying the platform close');
    assert.ok(a.capturedCloseAt > realClose, 'and the captured close it disagreed with');
    assert.strictEqual(a.companyName, 'BG', 'scope keys ride the alert');
    assert.strictEqual(eng.scheduler.get('W-dead').status, 'closed', 'the intent is retired, not left dangling');
    eng.kill('done');
    ok('a wake that lands on a closed auction retires WITHOUT arming, and alerts');
  }

  // ------------------------------------------------------- 4. the close moved, but there is time
  {
    // The KEI 23794211 shape short of fatal: the platform close is EARLIER than the captured one but
    // still in the future. The load must arm - and arm on the LIVE close, or every cadence, phase
    // and snipe decision is computed against a close that has moved.
    const meta = mkMeta('W-moved', { windowMs: 900_000 });
    const movedTo = meta.closesAt - 300_000; // 5 minutes earlier, still open
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: movedTo - Date.now(), closesAtMs: movedTo } });
    eng.schedule(meta, INPUTS);
    await sleep(700);
    assert.ok(eng.monitors.has('W-moved'), 'still arms - there is time left');
    const a = alertOf(eng, 'close_time_moved_earlier');
    assert.ok(a, 'the one fact this system previously could not report');
    assert.strictEqual(a.platformCloseAt, movedTo);
    assert.ok(a.deltaMs < 0, 'reported as a BACKWARD move');
    assert.strictEqual(eng.monitors.get('W-moved').meta.closesAt, movedTo,
      'the monitor must arm on the LIVE close, not the captured one');
    eng.kill('done');
    ok('an earlier platform close is reported AND the monitor arms on the live close');
  }
  {
    // A forward move is a soft-close extension and already has extension_observed - it must not
    // fire this alert, or every soft-close load would raise one on arrival.
    const meta = mkMeta('W-fwd');
    const later = meta.closesAt + 300_000;
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: later - Date.now(), closesAtMs: later } });
    eng.schedule(meta, INPUTS);
    await sleep(700);
    assert.ok(eng.monitors.has('W-fwd'), 'arms normally');
    assert.ok(!kinds(eng).includes('close_time_moved_earlier'), 'a LATER close is not a backward move');
    eng.kill('done');
    ok('a forward close move (a soft-close extension) raises no backward-move alert');
  }

  // ------------------------------------------------------- 5. fail direction: a bad read still arms
  {
    // The two realistic failure modes. A getAuctionState that returns null outright is NOT one:
    // the adapter contract is an object, and the engine's own _tick dereferences it unconditionally,
    // so a null-returning adapter is broken well before this path sees it.
    for (const [label, opts] of [
      ['a throwing read', { throws: true }],
      ['an ok:false read', { state: { ok: false } }],
    ]) {
      const eng = mkEngine(opts);
      eng.schedule(mkMeta(`W-badread-${label.replace(/\W/g, '')}`), INPUTS);
      await sleep(700);
      const id = `W-badread-${label.replace(/\W/g, '')}`;
      assert.ok(eng.monitors.has(id), `${label} must still ARM - never silently forfeit on a blip`);
      assert.ok(!kinds(eng).includes('armed_into_closed_auction'), `${label} must not be read as a dead auction`);
      eng.kill('done');
    }
    ok('a throwing / failed / absent platform read still ARMS (the fail direction is deliberate)');
  }

  // ------------------------------------------------------- 6. the silent retire branches speak
  {
    // The intent's own captured close has already passed at wake time. This branch existed and was
    // completely silent: a human had entered a rate and the load simply vanished.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 500_000 } });
    // Timed so the close passes BETWEEN planning and waking - the only way to reach the wake-side
    // retire branch rather than the plan-side one. The wake fires at startsAt - armLeadMs (10s), so
    // startsAt is set 10.4s out to buy a ~400ms sleep, and the captured close falls 200ms in. A close
    // inside rehydrateGraceMs with no outcome is NOT retired (the platform decides), so the grace is
    // shrunk here to put the wake past it.
    eng.cfg.rehydrateGraceMs = 100;
    const meta = mkMeta('W-past');
    meta.startsAt = Date.now() + 10_400;
    meta.closesAt = Date.now() + 200;
    eng.schedule(meta, INPUTS);
    await sleep(800);
    assert.ok(!eng.monitors.has('W-past'), 'a load whose captured close has passed does not arm');
    const a = alertOf(eng, 'wake_retired_past_close');
    assert.ok(a, 'and the desk is no longer left with nothing');
    assert.strictEqual(a.branch, 'wake', 'the branch is named so the two retire paths stay distinguishable');
    eng.kill('done');
    ok('a load retired at the wake for a past close now alerts instead of vanishing');
  }
  {
    // The OTHER retire branch: already past close when the wake is PLANNED.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 500_000 } });
    const meta = mkMeta('W-planpast');
    meta.closesAt = Date.now() - (eng.cfg.rehydrateGraceMs + 60_000); // over, and past the grace, before we even plan
    eng.schedule(meta, INPUTS);
    await sleep(120);
    const a = alertOf(eng, 'wake_retired_past_close');
    assert.ok(a, 'the plan-time retire branch alerts too');
    assert.strictEqual(a.branch, 'plan');
    assert.ok(!eng.monitors.has('W-planpast'), 'and nothing is armed');
    eng.kill('done');
    ok('the plan-time retire branch alerts as well, and names itself distinctly');
  }

  // ------------------------------------------------------- 7. the setTimeout overflow clamp
  {
    // Node fires setTimeout IMMEDIATELY above 2**31-1 ms rather than sleeping. boundedParse admits a
    // startsAt up to 30 days out, so the 24.86-30 day band was reachable from real platform data and
    // produced an INSTANT wake on a load that had not opened. The clamp must sleep and re-plan.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000 } });
    const meta = mkMeta('W-overflow');
    meta.startsAt = Date.now() + 29 * 86_400_000;      // 29 days - past TIMER_MAX, inside the bound
    meta.closesAt = meta.startsAt + 900_000;
    eng.schedule(meta, INPUTS);
    const line = eng._logs.find((l) => /arm deferred/.test(l.m) && l.f.auctionId === 'W-overflow');
    assert.ok(line, 'the deferral is logged');
    assert.ok(line.f.delayMs <= 2_147_483_647, 'the delay must be clamped below Node TIMER_MAX');
    assert.ok(line.f.clampedFrom > line.f.delayMs, 'and the log records what it was clamped from');
    await sleep(200);
    assert.ok(!eng.monitors.has('W-overflow'),
      'a 29-day-out load must NOT arm immediately - that is the overflow bug');
    assert.strictEqual(eng.scheduler.get('W-overflow').status, 'scheduled', 'it stays scheduled');
    eng.kill('done');
    ok('a delay past Node TIMER_MAX is clamped and re-planned, not fired immediately');
  }

  // ------------------------------------------------------- 8. a stop lands during the platform read
  {
    // The window the await opened. stop() cancels a pending timer and a live monitor, and at this
    // instant there is neither - the wake deleted its own timer before doing any work and arm()
    // has not run. The ONLY record of the stop is the durable intent, so the wake has to re-read it.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000 } });
    eng._hooks.onRead = async () => {         // exactly what POST /api/auctions/:loadId/stop does
      eng.stop('W-stop');
      eng.scheduler.update('W-stop', { status: 'stopped' });
    };
    eng.schedule(mkMeta('W-stop'), INPUTS);
    await sleep(700);
    assert.ok(!eng.monitors.has('W-stop'), 'a stop landing during the read must prevent the arm');
    assert.strictEqual(eng.scheduler.get('W-stop').status, 'stopped',
      'and must not be overwritten back to armed - rehydrate() would then resurrect a stopped load');
    assert.ok(!eng._events.some((e) => e.type === 'armed'), 'nothing was armed, so nothing bids');
    eng.kill('done');
    ok('an operator stop that lands during the platform read is honoured, not overwritten');
  }

  // ------------------------------------------------------- 9. a re-price lands during the read
  {
    // Same window, the other mutator. The intent carries the money, so arming from the pre-await
    // copy bids the superseded cost. upsert() is the operation a re-price performs and it REPLACES
    // the stored object rather than mutating it, which is exactly why a captured reference goes
    // stale where a status flip written by update() would still have been visible through it.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000 } });
    eng._hooks.onRead = async () => { eng.scheduler.upsert({ auctionId: 'W-reprice', cost: 30_000 }); };
    eng.schedule(mkMeta('W-reprice'), INPUTS); // priced at 15,000
    await sleep(700);
    assert.ok(eng.monitors.has('W-reprice'), 'a re-price does not stop the load arming');
    assert.strictEqual(eng.scheduler.get('W-reprice').cost, 30_000, 'the re-priced cost survives');
    assert.ok(eng.monitors.get('W-reprice').floor >= 30_000,
      'and the ladder is built from it - a floor at the old cost means it armed off the stale copy');
    eng.kill('done');
    ok('a re-price landing during the platform read is what the wake arms on, not the stale copy');
  }

  // ------------------------------------------------------- 10. arm() throws inside the wake
  {
    // arm() genuinely throws (a ceiling cap that alters the floor rung raises a FLOOR error), and an
    // async wake() catches it, so nothing crashes and nothing retries. A priced load left un-armed
    // and un-retired is the same silent forfeit this file exists to close, reached by the error path.
    const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000, closesAtMs: Date.now() + 890_000 } });
    eng.arm = () => { const e = new Error('ceiling cap altered the floor rung (14200 != 13800)'); e.code = 'FLOOR'; throw e; };
    eng.schedule(mkMeta('W-armthrow'), INPUTS);
    await sleep(700);
    assert.ok(!eng.monitors.has('W-armthrow'), 'nothing is watching this load');
    const a = alertOf(eng, 'wake_arm_failed');
    assert.ok(a, 'so a human has to be told, at the moment it happens');
    assert.strictEqual(eng.scheduler.get('W-armthrow').status, 'closed',
      'and the intent is retired - left at scheduled it has no timer, no monitor and no way back');
    // THE LEAK CHECK. Every reachable arm() throw embeds rupee figures, and this kind routes to the
    // WhatsApp error channel the client's Director subscribes to. The cause goes to the log only.
    assert.ok(!/14200|13800|ceiling cap/.test(a.detail),
      'the recipient-facing detail must NEVER carry the error text - it names our own margin figures');
    assert.ok(a.detail && a.detail !== a.kind && /\s/.test(a.detail),
      'and must still be prose, not the raw kind (engineAlerts falls through to detail: evt.kind)');
    const line = eng._logs.find((l) => l.level === 'error' && /scheduled wake failed/.test(l.m));
    assert.ok(line && /ceiling cap altered the floor rung/.test(line.f.err),
      'the actual cause is not lost - it is on the log line, which no recipient receives');
    eng.kill('done');
    ok('a throwing arm() alerts and retires the load, with the cause in the log and never in the alert');
  }

  // ------------------------------------------------- 11. every new alert renders as a sentence
  {
    // engineAlerts falls through to `detail: evt.detail || evt.reason || evt.kind`, and waTemplates
    // renders that string, so an emit without a detail puts the raw enum in a human's WhatsApp. The
    // Director's subscription list is ["error","won","lost"], which is exactly what these route as.
    //
    // Asserted STRUCTURALLY rather than against fixed strings: the copy should be free to improve,
    // but it must never be the kind, and it must never carry the raw error text - both reachable
    // arm() throws embed rupee figures, so an interpolated message is a margin leak to the desk.
    const seen = [];
    // dead auction at the wake -> armed_into_closed_auction
    {
      const eng = mkEngine({ state: { ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 60_000 } });
      eng.schedule(mkMeta('D-dead'), INPUTS);
      await sleep(700);
      seen.push(alertOf(eng, 'armed_into_closed_auction'));
      eng.kill('done');
    }
    // an earlier-but-still-open close -> close_time_moved_earlier
    {
      const meta = mkMeta('D-moved');
      const movedTo = meta.closesAt - 300_000;
      const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: movedTo - Date.now(), closesAtMs: movedTo } });
      eng.schedule(meta, INPUTS);
      await sleep(700);
      seen.push(alertOf(eng, 'close_time_moved_earlier'));
      eng.kill('done');
    }
    // captured close already past at wake time -> wake_retired_past_close
    {
      const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 500_000 } });
      eng.cfg.rehydrateGraceMs = 100; // past the grace at the wake, as in check 6
      const meta = mkMeta('D-past');
      meta.startsAt = Date.now() + 10_400;
      meta.closesAt = Date.now() + 200;
      eng.schedule(meta, INPUTS);
      await sleep(800);
      seen.push(alertOf(eng, 'wake_retired_past_close'));
      eng.kill('done');
    }
    // arm() throwing inside the wake -> wake_arm_failed
    {
      const eng = mkEngine({ state: { ok: true, status: 'live', closesInMs: 890_000 } });
      eng.arm = () => { const e = new Error('operating floor 31,890 exceeds the shipper ceiling 25,610'); e.code = 'FLOOR'; throw e; };
      eng.schedule(mkMeta('D-throw'), INPUTS);
      await sleep(700);
      seen.push(alertOf(eng, 'wake_arm_failed'));
      eng.kill('done');
    }
    assert.strictEqual(seen.filter(Boolean).length, 4, 'all four alerts must have fired');
    for (const a of seen) {
      assert.ok(a.detail, `${a.kind}: must carry a detail`);
      assert.notStrictEqual(a.detail, a.kind, `${a.kind}: detail must not be the raw kind`);
      assert.ok(/\s/.test(a.detail), `${a.kind}: detail must be prose`);
      // The margin-leak guard: no digit group that could be a rupee figure from an error message.
      assert.ok(!/\d{3}/.test(a.detail), `${a.kind}: detail must not carry numeric amounts:\n${a.detail}`);
    }
    ok('all four wake-path alerts carry prose detail, and none leaks a numeric amount');
  }

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 13;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
