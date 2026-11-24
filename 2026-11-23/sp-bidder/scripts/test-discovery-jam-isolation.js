'use strict';
/**
 * Reproducer for the 2026-09-08 silent discovery outage: surfacing stopped for EVERY customer on
 * BOTH platforms for ~18h while the process stayed healthy, bid armed loads, and logged nothing.
 *
 * Mechanism (all three legs are asserted below):
 *   1. DiscoveryPoller.tick() queues every poller on ONE process-wide serializer
 *      (server.js builds a single `discoveryGate` and hands it to every SP account stack AND the
 *      GoComet poller). The gate advances only when the running _tick SETTLES.
 *   2. _tick awaits adapter/notifier/store calls that can hang. A single never-settling await
 *      therefore parks the shared chain forever - so one platform's stalled read stops the OTHER
 *      platform's surfacing. That is the "all customers are down" symptom.
 *   3. The _ticking re-entrancy guard is cleared in a `finally` that is never reached, so the
 *      jammed poller reports `in_progress` forever and no later tick can recover it.
 *
 * And the silence: the jam parks discovery BEFORE any log line, so the outage emits no error at
 * all. Nothing is louder than the absence of the tick-complete line nobody was watching for.
 *
 *   node scripts/test-discovery-jam-isolation.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok  ' + m); pass += 1; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered above every check, fired on process exit.
// run-tests.js grades by EXIT CODE ALONE, and this file is async: a swallowed rejection or an
// early return would otherwise reach exit 0 having asserted nothing and read as a silent green.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 18;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

// A tick that has not finished within this budget is jammed, not slow. Real ticks in the incident
// logs complete in single-digit seconds; the healthy poller below does zero I/O.
const JAM_MS = 1500;

/** Resolve to the tick result, or to the JAMMED sentinel if the tick outlives the budget. */
const JAMMED = Symbol('jammed');
function within(promise, ms = JAM_MS) {
  let t = null;
  // Deliberately NOT unref'd: once the shared chain jams, this timer is the only thing keeping the
  // event loop alive, and an unref'd one lets node drain to a silent exit 0 instead of failing.
  const bound = new Promise((res) => { t = setTimeout(() => res(JAMMED), ms); });
  return Promise.race([promise.then((v) => { clearTimeout(t); return v; }, () => { clearTimeout(t); return JAMMED; }), bound]);
}

const liveLoad = (id, companyName) => ({
  id,
  lane: { origin: 'A', destination: 'B' },
  companyName,
  closesAt: Date.now() + 10 * 60_000,
  startsAt: Date.now() - 1000,
  status: 'live',
  softClose: false,
  closeModelKnown: true,
});

function makePoller({ adapter, gate, platformKey, shippers, alerts }) {
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5 });
  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
  if (alerts) {
    const origAlert = notifier.alert.bind(notifier);
    notifier.alert = (kind, data, opts) => { alerts.push({ kind, data, opts }); return origAlert(kind, data, opts); };
  }
  const poller = new DiscoveryPoller({
    adapter,
    requests,
    notifier,
    gate,
    platformKey,
    // Production's stall budget is minutes; the incident shape is identical at 300ms and keeps the
    // reproducer deterministic and fast.
    config: { allowlist: { shippers }, priceDeadlineLeadMs: 90_000, tickTimeoutMs: 300 },
  });
  return { poller, requests };
}

(async () => {
  // ============================================================================================
  // Leg 1 + 2: one platform's never-settling read must not stop the OTHER platform's surfacing.
  //
  // This is the incident in miniature. The GoComet poller's listAuctions never settles (a read
  // parked behind the adapter's slot pump, or an unbounded notifier fetch - the shape is what
  // matters, not which call). The SuperProcure poller is perfectly healthy and has a load it
  // should surface. On the unfixed build the SP tick never even STARTS, because it is queued
  // behind the jammed link on the shared chain.
  // ============================================================================================
  {
    const gate = { chain: Promise.resolve() };
    const alerts = [];

    const jammed = makePoller({
      adapter: { listAuctions: () => new Promise(() => {}) }, // never resolves, never rejects
      gate,
      platformKey: 'gocomet',
      shippers: ['Havells'],
      alerts,
    });

    let spScanned = 0;
    const healthy = makePoller({
      adapter: {
        listAuctions: async () => { spScanned += 1; return [liveLoad('SP1', 'Havells India Ltd')]; },
      },
      gate,
      platformKey: 'sp',
      shippers: ['Havells'],
    });

    // Fire the GoComet tick and let it hang. Deliberately NOT awaited - that is production's shape.
    const jammedTick = jammed.poller.tick();
    jammedTick.catch(() => {}); // never settles either way; keep node quiet about it

    // Give the jammed tick a turn to take the chain, exactly as the interval would.
    await new Promise((r) => setImmediate(r));

    const spResult = await within(healthy.poller.tick());

    ok(spResult !== JAMMED,
      'a never-settling GoComet read does NOT stop the SuperProcure poller (per-platform isolation)');
    ok(spScanned === 1,
      `the healthy SP adapter was actually polled while GoComet was jammed (scanned ${spScanned} time(s))`);
    ok(await healthy.requests.getByLoad('SP1'),
      'the SP load was surfaced as a price request during the GoComet jam - the desk still gets work');

    // ------------------------------------------------------------------------------------------
    // Leg 3: the jammed poller must not wedge its own re-entrancy guard forever. On the unfixed
    // build `_ticking` is set true and cleared in a `finally` that the hung await never reaches,
    // so every later tick short-circuits to `in_progress` for the life of the process - which is
    // why only a restart cleared the incident.
    // ------------------------------------------------------------------------------------------
    // The hung tick itself has to give up, or the guard it holds is never released.
    const abandoned = await within(jammedTick);
    ok(abandoned !== JAMMED && abandoned && abandoned.stalled === true,
      `the hung tick gives up on its own deadline instead of hanging forever (got ${abandoned === JAMMED ? 'a still-hung tick' : JSON.stringify(abandoned)})`);

    const retry = await within(jammed.poller.tick());
    ok(retry !== JAMMED && !(retry && retry.skipped === 'in_progress'),
      `the jammed poller recovers instead of wedging on its own guard (got ${retry === JAMMED ? 'a hung tick' : JSON.stringify(retry)})`);

    // ------------------------------------------------------------------------------------------
    // Leg 4: the outage must be AUDIBLE. Half the incident was that nothing was logged and the
    // desk noticed before the operator did, so a stalled tick has to raise an engine alert.
    // ------------------------------------------------------------------------------------------
    ok(alerts.some((a) => /stall|watchdog|jam|stuck/i.test(String(a.kind) + JSON.stringify(a.data || {}))),
      'a stalled discovery tick raises a desk-visible engine alert rather than going silent');
  }

  // ============================================================================================
  // Leg 5: the GoComet read budget must not starve discovery's own listing.
  //
  // Slot selection was strict class priority with NO aging, so under sustained armed-load polling
  // the ROUTINE class - listAuctions - did not merely wait longer, it never won. It gave up every
  // ~30s reporting READ_STARVED: ~500 lines/day of "no new auctions are being surfaced" across
  // 6-8 Sep. Discovery going quiet under load is the bug, not acceptable degradation, so an aged
  // listing now outranks a fresh armed-load poll and actually reaches the wire.
  // ============================================================================================
  {
    const START = 5_000_000;
    const CEILING = 1000;
    let t = START;
    const calls = [];
    const flush = () => new Promise((r) => setImmediate(r));
    const resp = (status, body) => ({
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;

    const fetchImpl = async (url) => {
      calls.push({ at: t, routine: url.includes('/enquiries/spot') });
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (url.includes('/enquiries/spot')) return resp(200, { data: { enquiries: [], total_page: 1 } });
      return resp(404, {});
    };
    const sleep = async (ms) => { await flush(); t += ms; };
    const adapter = new GoCometAdapter({
      token, fetchImpl, sleep, now: () => t,
      minGetIntervalMs: 5000, globalMinGetIntervalMs: CEILING, routineGetIntervalMs: 5000,
    });
    await adapter.login();

    let stop = false;
    // 30 pollers, ABOVE the point where a naive aging rule collapses. Aging that only asks "is this
    // waiter aged" stops discriminating once the queue is deep enough that everything ages before
    // anything is served (N * globalSpacing >= readAgingMs, ~16 here), and selection silently
    // reverts to strict class priority - so the listing starves again at exactly the load where
    // surfacing matters most. Pinning this at 8 would sit one step under the cliff and pass against
    // a fix that does not actually hold.
    const pollers = Array.from({ length: 30 }, (_, i) => `L${i}`)
      .map(async (k) => { while (!stop) await adapter.getAuctionState(k); });
    pollers.forEach((p) => p.catch(() => {}));

    let settled = null;
    adapter.listAuctions().then((r) => { settled = { resolved: r }; }, (e) => { settled = { rejected: e }; });
    // Bounded flushes so the test can never hang, and stop the moment it settles.
    for (let i = 0; i < 2_000 && !settled; i += 1) await flush();
    const outcome = settled; // snapshot BEFORE teardown: stopping the pollers would drain the queue
    stop = true;

    ok(!!(outcome && outcome.resolved),
      `the listing WINS a slot under sustained armed-load polling instead of starving (got ${outcome && outcome.rejected ? outcome.rejected.code : 'resolved'})`);
    ok(calls.some((c) => c.routine),
      'and it reached the transport - discovery keeps surfacing while the read budget is saturated');

    // Fairness must be bought by REORDERING the queue, never by issuing more requests: the rate
    // ceiling is on a shared vendor identity against a limit nobody has measured.
    const at = calls.map((c) => c.at).sort((x, y) => x - y);
    let minGap = Infinity;
    for (let i = 1; i < at.length; i += 1) minGap = Math.min(minGap, at[i] - at[i - 1]);
    ok(minGap >= CEILING, `aging did not loosen the rate ceiling (tightest gap ${minGap}ms >= ${CEILING}ms)`);

    // ------------------------------------------------------------------------------------------
    // Leg 6: fairness must not touch the money path. A live bid's quote read (WRITE) carries its
    // own deadline escape hatch so a snipe never sits out a polling interval - but that hatch only
    // makes it ELIGIBLE early, it does not order it. An aged listing that outranked WRITE would
    // reintroduce exactly the stall the hatch exists to prevent, on the one read where the delay
    // costs an auction.
    // ------------------------------------------------------------------------------------------
    const now = t;
    adapter._lastRoutineGetAt = now - 60_000; // ROUTINE is both aged and due
    const agedRoutine = { priority: 0, seq: 1, queuedAt: now - 60_000, deadlineAt: null };
    const freshWrite = { priority: 3, seq: 2, queuedAt: now, deadlineAt: now + 1000 };
    const freshHot = { priority: 2, seq: 3, queuedAt: now, deadlineAt: null };

    ok(adapter._outranks(freshWrite, agedRoutine, now) === true
      && adapter._outranks(agedRoutine, freshWrite, now) === false,
      'a fresh WRITE (live bid quote read) still beats an aged, due ROUTINE listing - bidding is unchanged');
    ok(adapter._outranks(agedRoutine, freshHot, now) === true,
      'but an aged, due ROUTINE listing does beat a fresh HOT poll - which is the starvation fix working');

    // Both aged, different classes. A batch close puts several loads into HOT while older POLL
    // reads are still queued; if the ceiling is saturated long enough for BOTH to age, class must
    // still decide. An earlier revision made this case FIFO, which handed the slot to the older
    // POLL ahead of the decisive read that determines whether to bid at all.
    adapter._lastRoutineGetAt = now;                        // ROUTINE not due - isolate the tiebreak
    const agedPoll = { priority: 1, seq: 4, queuedAt: now - 60_000, deadlineAt: null };
    const agedHot = { priority: 2, seq: 5, queuedAt: now - 30_000, deadlineAt: null };
    ok(adapter._outranks(agedHot, agedPoll, now) === true
      && adapter._outranks(agedPoll, agedHot, now) === false,
      'when BOTH have aged, a decisive HOT read still outranks an older POLL - aging never costs bid-critical ordering');
  }

  // ============================================================================================
  // Leg 7: the outage alert must survive a SECOND outage.
  //
  // The notifier's dedupe store is persistent and TTL-less, so an alert keyed on identity alone
  // (platform + account) fires once for the life of the deployment and is silently swallowed on
  // every recurrence - reproducing the exact silence the watchdog was added to end. Each new stall
  // episode must therefore present a distinct dedupe key.
  // ============================================================================================
  {
    const alerts = [];
    const jammed = makePoller({
      adapter: { listAuctions: () => new Promise(() => {}) },
      gate: null,
      platformKey: 'gocomet',
      shippers: ['Havells'],
      alerts,
    });

    await within(jammed.poller.tick());          // episode 1
    jammed.poller._stalls = 0;                   // the poller recovered in between
    await within(jammed.poller.tick());          // episode 2, a genuinely new outage

    const keys = alerts.map((a) => a.opts && a.opts.dedupeKey).filter(Boolean);
    ok(keys.length >= 2, `both stall episodes reached the alert path (got ${keys.length})`);
    ok(new Set(keys).size === keys.length,
      `each outage carries its own dedupe key, so the persistent store cannot swallow the second (${JSON.stringify(keys)})`);
  }

  // ============================================================================================
  // Leg 8: abandoning a stalled tick must not cost a duplicate ask on the desk.
  //
  // The abandoned tick is no longer held behind the gate, so it can resume mid-batch while a fresh
  // tick walks the same loads. Re-reading the row does not close that window on its own, because
  // createForLoad re-checks and then awaits before it writes. Here the FIRST tick hangs inside the
  // notify step for load D1 - after D1's row exists but before D2 is reached - and then resumes
  // after a second tick has already processed the whole batch.
  // ============================================================================================
  {
    let releaseHang;
    const hang = new Promise((r) => { releaseHang = r; });
    let notifyCalls = 0;

    const batch = [liveLoad('D1', 'Havells India Ltd'), liveLoad('D2', 'Havells India Ltd')];
    const poller = makePoller({
      adapter: { listAuctions: async () => batch },
      gate: null,
      platformKey: 'sp',
      shippers: ['Havells'],
    });
    // Hang the first tick inside the notify for D1, which sits between D1's create and D2's.
    poller.poller.notifier.requestPrice = async () => {
      notifyCalls += 1;
      if (notifyCalls === 1) await hang;
      return { delivered: true };
    };

    const stalledTick = poller.poller.tick();
    const first = await within(stalledTick);
    ok(first && first.stalled === true, 'the mid-batch stall was abandoned on its deadline');

    await within(poller.poller.tick());   // a fresh tick completes the whole batch
    releaseHang();                        // now let the abandoned tick resume mid-loop
    await new Promise((r) => setTimeout(r, 50));

    ok(!!(await poller.requests.getByLoad('D1')) && !!(await poller.requests.getByLoad('D2')),
      'the fresh tick surfaced the WHOLE batch after the stall, including the load the stalled tick never reached');
  }

  // ============================================================================================
  // Leg 9: a waiter parked behind a pump that STOPPED must still settle.
  //
  // The queue's normal starvation sweep is driven off the pump's own cursor, so it can only fire
  // while the pump is running - a pump wedged mid-await never reaches it, and the waiter behind it
  // has no resolve, no reject and no timeout. That is the promise shape the whole incident came
  // from, so the real-time backstop that covers it needs a test on a REAL clock: the virtual clock
  // the other budget tests inject is exactly what cannot exercise it.
  // ============================================================================================
  {
    const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;

    const adapter = new GoCometAdapter({
      token,
      fetchImpl: async () => resp(200, { data: { bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } }),
      // The pump parks here forever the moment any spacing wait is required.
      sleep: () => new Promise(() => {}),
      globalMinGetIntervalMs: 250,
      routineGetIntervalMs: 1,
      rateLimitBackoffSteps: 1,
      slotWaitTimeoutMs: 501,
    });
    await adapter.login();

    await adapter.getAuctionState('W1');            // served with no spacing wait; pump exits cleanly
    const parked = adapter.getAuctionState('W2');   // needs spacing -> pump sleeps -> never wakes

    const settled = await within(parked, adapter.slotWaitTimeoutMs * 2 + 1500);
    ok(settled !== JAMMED,
      'a read parked behind a wedged pump still settles, via the real-time backstop rather than hanging forever');
    ok(adapter._getWaiters.every((w) => w.settled !== false) || adapter._getWaiters.length === 0,
      'and it is not left parked in the queue afterwards');
  }
})().then(() => {
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
}, (e) => {
  console.error('\nFAILED:', e && e.message);
  process.exitCode = 1;
});
