'use strict';
/**
 * GoComet READ-SLOT GUARDS (src/platform/gocometAdapter.js) - the two ways the GET budget could
 * hurt the account or go blind, both of them silent.
 *
 * 1. THE COOLDOWN WAS OBSERVED ONLY IN FRONT OF THE QUEUE. `_request` tested `_cooldownUntil`
 *    before waiting for a slot and never again after, while any concurrent read can open a
 *    cooldown on a 429. So every GET already parked when a burst was throttled came out the far
 *    side and fired into the cooldown that burst had just opened - one per ceiling slot. The
 *    backoff ran backwards for exactly the set a burst produces, against a vendor identity shared
 *    with BRL's own autopilot, where escalating a soft throttle into a ban takes the only GoComet
 *    account offline.
 *
 * 2. THE WAIT FOR A SLOT WAS THE ONE AWAIT NO TIMEOUT COVERED. The request timeout is armed after
 *    the slot is granted. Selection is strict class priority with no aging, so under saturation the
 *    ROUTINE class (discovery's listing) never wins - and with an unbounded wait it never resolved,
 *    never rejected, never logged. The adapter kept polling known loads while surfacing no new one,
 *    and every surface read healthy. The bound does not make the budget fair; it makes the limit
 *    say so, and stops an unheard listing from returning as "no auctions".
 *
 * Everything here runs on a virtual clock with an injected sleep and a fake transport - these are
 * timing defects, and a flaky test on this path is worse than none.
 */
// Hermetic config read: strip every GC_* var BEFORE the adapter is loaded, so the knob assertions
// measure the committed defaults and not this shell's environment.
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok ', m); } else { fail++; console.error('  FAIL -', m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;

function resp(status, body, headers = {}) {
  const hdr = {};
  for (const k of Object.keys(headers)) hdr[k.toLowerCase()] = headers[k];
  return {
    status,
    headers: { get: (h) => (hdr[String(h).toLowerCase()] != null ? hdr[String(h).toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
const keyOf = (url) => { const m = /\/enquiries\/([^/?]+)/.exec(url); return m ? decodeURIComponent(m[1]) : null; };
const liveState = (secs) => resp(200, { data: { bid_closing_in: secs, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });

/** Recording logger + notifier, so the visibility assertions read the real surfaces. */
function recorders() {
  const lines = [];
  const alerts = [];
  const log = {};
  for (const lvl of ['debug', 'info', 'warn', 'error']) log[lvl] = (msg, meta) => lines.push({ lvl, msg, meta });
  const notifier = { alert: async (kind, payload, opts) => { alerts.push({ kind, payload, opts }); } };
  return { lines, alerts, log, notifier };
}

/** Drain the microtask queue without letting a macrotask (the pump's sleep) run. */
const drainMicro = async (n = 50) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. A 429 that lands while other GETs are queued must not release them into its own cooldown.
  //
  // The schedule is pinned rather than raced: A's 429 is held on a deferred and released inside the
  // microtask window while the pump is parked on its macrotask, so the cooldown is always open
  // before any queued waiter can be picked.
  // ---------------------------------------------------------------------------------------------
  {
    const START = 1_000_000;
    const COOLDOWN_MS = 60_000;
    let t = START;
    const calls = [];
    let releaseThrottled;
    const throttledHeld = new Promise((r) => { releaseThrottled = r; });

    const fetchImpl = async (url, init) => {
      calls.push({ at: t, url, key: keyOf(url), method: init.method });
      if (url.includes('/enquiries/A/bidding-data')) { await throttledHeld; return resp(429, 'Too Many Requests'); }
      if (url.includes('/bidding-data')) return liveState(600);
      return resp(404, {});
    };
    const sleep = async (ms) => { await flush(); t += ms; };
    const adapter = new GoCometAdapter({
      token: validToken(), fetchImpl, sleep, now: () => t,
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000,
      rateLimitBackoffMs: COOLDOWN_MS, maxRateLimitBackoffMs: 120_000,
    });
    await adapter.login();

    const pA = adapter.getAuctionState('A');            // goes out immediately, parks on the held 429
    await drainMicro();
    ok(calls.length === 1, 'setup: one GET (A) is on the wire and holding');

    const queued = ['B', 'C', 'D'].map((k) => adapter.getAuctionState(k));
    await drainMicro();
    ok(calls.length === 1, 'setup: B/C/D passed the pre-queue cooldown check and are waiting for a slot');

    releaseThrottled();
    await drainMicro();
    const cooldownUntil = adapter._cooldownUntil;
    ok(cooldownUntil >= START + COOLDOWN_MS, `setup: the 429 opened a cooldown until ${cooldownUntil}`);
    const rA = await pA;
    ok(rA.ok === false, 'setup: the throttled read itself reported ok:false');

    const results = await Promise.all(queued);
    const insideCooldown = calls.filter((c) => c.key !== 'A' && c.at < cooldownUntil);
    ok(insideCooldown.length === 0,
      `no GET that was already queued when the 429 landed reached the wire inside the cooldown (got ${JSON.stringify(insideCooldown.map((c) => `${c.key}@+${c.at - START}ms`))})`);
    ok(results.every((r) => r.ok === false),
      'and each of them reported ok:false - the cooldown is surfaced to the caller, never fabricated into a read');

    const before = calls.length;
    await adapter.getAuctionState('E');
    ok(calls.length === before,
      'control: a read requested AFTER the cooldown opened is still refused in front of the queue - the defect was the missing SECOND observation, not the first');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Saturated budget: discovery still loses (that is the budget's shape, not a bug fixed here),
  //    but it now gives up, says so on both surfaces, and never reports an empty board.
  // ---------------------------------------------------------------------------------------------
  {
    const START = 5_000_000;
    const CEILING = 1000;
    const KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
    let t = START;
    const calls = [];
    const { lines, alerts, log, notifier } = recorders();

    const fetchImpl = async (url) => {
      calls.push({ at: t, url, routine: url.includes('/enquiries/spot') });
      if (url.includes('/bidding-data')) return liveState(600);   // far from close: POLL, never HOT
      if (url.includes('/enquiries/spot')) return resp(200, { data: { enquiries: [], total_page: 1 } });
      return resp(404, {});
    };
    const sleep = async (ms) => { await flush(); t += ms; };
    const adapter = new GoCometAdapter({
      token: validToken(), fetchImpl, sleep, now: () => t, log, notifier, platformKey: 'gocomet',
      minGetIntervalMs: 5000, globalMinGetIntervalMs: CEILING, routineGetIntervalMs: 5000,
      // AGING OFF FOR THIS SCENARIO, deliberately. Aging (added after the 2026-09-08 outage) now
      // promotes an aged ROUTINE read, so under the default it wins a slot and is never starved -
      // that guarantee is pinned in test-discovery-jam-isolation.js's sibling fairness case. What
      // THIS block still has to prove is the give-up path itself: that a read which genuinely
      // cannot be served settles, reports and costs the budget nothing. Disabling aging is the
      // only way to reach that path on purpose.
      readAgingMs: 3_600_000,
    });
    await adapter.login();

    let stop = false;
    const pollers = KEYS.map(async (key) => { while (!stop) await adapter.getAuctionState(key); });
    pollers.forEach((p) => p.catch(() => {}));

    let settled = null;
    const listP = adapter.listAuctions()
      .then((r) => { settled = { resolved: r }; })
      .catch((e) => { settled = { rejected: e }; });

    // Bounded macrotask flushes so the test itself can never hang, and stop the moment it settles.
    // 2,000 is ~30x the schedule the bound needs and still nowhere near enough for the unbounded
    // wait: with the expiry removed this listing first reached the transport after ~40,000 granted
    // slots, roughly ELEVEN simulated hours, which is what "starves indefinitely" looks like when
    // something eventually jitters it through.
    for (let i = 0; i < 2_000 && !settled; i += 1) await flush();

    // SNAPSHOT BEFORE TEARDOWN, and this is load-bearing. Stopping the pollers drains the queue and
    // lets the listing through, so anything read after `stop` describes an idle adapter rather than
    // a saturated one - awaiting the listing here instead of snapshotting made the unbounded wait
    // look like it had settled all along.
    const outcome = settled;
    stop = true;

    const timeout = adapter.slotWaitTimeoutMs;
    ok(calls.length >= 20, `setup: the armed loads saturated the ceiling (${calls.length} GETs over ${t - START}ms)`);
    ok(!!outcome, 'listAuctions settled - the wait for a slot is no longer unbounded');
    ok(!!(outcome && outcome.rejected),
      'and it settled by REJECTING, not by resolving to an empty list that reads identically to a quiet board');
    ok(!!(outcome && outcome.rejected && outcome.rejected.code === 'READ_STARVED'),
      `the rejection carries a real code (${outcome && outcome.rejected && outcome.rejected.code})`);
    ok(calls.filter((c) => c.routine).length === 0,
      'the listing never reached the transport - with aging off it is starved by class priority alone');

    const starveLine = lines.find((l) => l.lvl === 'warn' && /read budget is saturated/.test(l.msg));
    ok(!!starveLine, 'the operator log names the saturation at warn level');
    ok(!!(starveLine && starveLine.meta && starveLine.meta.readClass === 'ROUTINE'),
      `the log line names the starved class (${starveLine && starveLine.meta && starveLine.meta.readClass})`);
    ok(!!(starveLine && starveLine.meta && starveLine.meta.waitedMs >= timeout && starveLine.meta.waitedMs < timeout * 2),
      `the wait was bounded at slotWaitTimeoutMs (waited ${starveLine && starveLine.meta && starveLine.meta.waitedMs}ms against ${timeout}ms)`);

    const alert = alerts.find((a) => a.payload && a.payload.context === 'gocomet');
    ok(!!alert, 'an alert went out - a log line alone is what let this run unnoticed');
    ok(!!(alert && alert.payload.platformKey === 'gocomet'),
      'the alert is tagged to GoComet, so it routes to the console rather than a customer group');
    ok(!!(alert && /not being surfaced/i.test(alert.payload.detail)),
      'and it says in plain terms that new auctions are not being surfaced');
    ok(adapter._getWaiters.filter((w) => w.priority === 0).length === 0,
      'no ROUTINE waiter is left parked in the queue after it gave up');

    // THE RATE CEILING IS UNTOUCHED. A fairness or timeout change that bought progress by issuing
    // more requests would be the one unacceptable fix on a shared, unmeasured vendor limit.
    const at = calls.map((c) => c.at).sort((x, y) => x - y);
    let minGap = Infinity;
    for (let i = 1; i < at.length; i += 1) minGap = Math.min(minGap, at[i] - at[i - 1]);
    ok(minGap >= CEILING, `no two GETs landed closer than the ceiling (tightest gap ${minGap}ms >= ${CEILING}ms)`);
    ok(calls.every((c) => !c.routine),
      'and the starved waiter consumed no slot of its own - giving up costs the budget nothing');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. The bound must never fire on a legitimate wait, and it scales with the configured budget.
  // ---------------------------------------------------------------------------------------------
  {
    const bare = new GoCometAdapter({ token: validToken() });
    ok(bare.slotWaitTimeoutMs === 30_000, `default slot-wait bound is 30,000ms (got ${bare.slotWaitTimeoutMs})`);

    const set = (v, opts = {}) => new GoCometAdapter(Object.assign({ token: validToken(), slotWaitTimeoutMs: v }, opts)).slotWaitTimeoutMs;
    ok(set(5) === 30_000,
      'a bound below the widest legitimate wait resolves to the default - it can never be tightened into false alarms');
    ok(set(90_000) === 90_000, 'a LOOSER bound is honoured - waiting longer before declaring starvation is the safe direction');

    const loose = new GoCometAdapter({ token: validToken(), minGetIntervalMs: 60_000 });
    ok(loose.slotWaitTimeoutMs === (60_000 + 8000) * 2,
      `a loosened read budget raises the derived bound with it (got ${loose.slotWaitTimeoutMs}, expected ${(60_000 + 8000) * 2})`);

    // A routine listing that merely loses ONE contested slot to a decisive read is not starvation.
    let t = 2_000_000;
    const calls = [];
    const sleep = async (ms) => { await flush(); t += ms; };
    const adapter = new GoCometAdapter({
      token: validToken(), now: () => t, sleep,
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 3000,
      fetchImpl: async (url) => {
        calls.push({ at: t, url });
        if (url.includes('/bidding-data')) return liveState(3);
        if (url.includes('/enquiries/spot')) return resp(200, { data: { enquiries: [], total_page: 1 } });
        return resp(404, {});
      },
    });
    await adapter.login();
    await adapter.getAuctionState('HOT');            // establishes the close, so the next read is decisive
    const listing = adapter.listAuctions();          // asked for first, loses the contested slot
    const hot = adapter.getAuctionState('HOT');
    const [loads] = await Promise.all([listing, hot]);
    ok(Array.isArray(loads), 'a listing deferred behind a decisive read still resolves normally');
    ok(calls.some((c) => c.url.includes('/enquiries/spot')),
      'and it reached the transport one ceiling slot later - deferral is not starvation');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  // Completion sentinel: the runner grades by exit code alone, so a file that exits 0 after an
  // early return would score as a silent green with zero assertions.
  const MIN_EXPECTED_CHECKS = 23;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early`);
  // The saturation case leaves eight pollers mid-flight by design; exit rather than wait them out.
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
