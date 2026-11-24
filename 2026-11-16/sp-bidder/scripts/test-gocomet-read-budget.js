'use strict';
/**
 * GoComet per-load READ BUDGET (src/platform/gocometAdapter.js).
 *
 * The adapter used to gate every GET on ONE shared timestamp, so reads for distinct enquiries
 * starved each other: N armed loads plus discovery paging gave each load an effective interval of
 * roughly minGetIntervalMs x (N + overhead), and the engine's 200ms hot poll inside a 2,500ms
 * decisive window could not reliably land at all. These tests pin the replacement's BEHAVIOUR, via
 * the injected clock and the observed network calls - never the internal bookkeeping, because a
 * test that asserts on private counters passes while the timing regresses.
 *
 * Everything here runs on a virtual clock. `sleep` yields a macrotask BEFORE advancing it, so a
 * released caller records its own release time rather than a later one.
 */
// Hermetic config read: strip every GC_* var BEFORE src/config.js is loaded, so the default-parity
// case below measures the committed defaults and not this shell's environment. config.js reads
// process.env once at require time, which is why the order matters.
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const assert = require('assert');
const { GoCometAdapter, parseRetryAfterMs } = require('../src/platform/gocometAdapter');
const config = require('../src/config');

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

/** Enquiry key out of any vendor-API path, so a recorded call can be attributed to a load. */
function keyOf(url) {
  const m = /\/enquiries\/([^/?]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Virtual clock + recording transport. `calls` holds { at, url, key } in release order, which is
 * the only thing these tests assert on.
 */
function rig({ start = 1_000_000, handler, ...opts } = {}) {
  let t = start;
  const calls = [];
  const now = () => t;
  const sleep = async (ms) => { await new Promise((r) => setImmediate(r)); t += ms; };
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, url, key: keyOf(url), method: init.method });
    return handler(url, init) || resp(404, {});
  };
  const adapter = new GoCometAdapter(Object.assign({ token: validToken(), fetchImpl, sleep, now }, opts));
  return { adapter, calls, now, advance: (ms) => { t += ms; }, at: () => t };
}

/** bidding-data for a load closing in `secs` seconds. */
const liveState = (secs) => resp(200, { data: { bid_closing_in: secs, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });

/** Release times of every recorded call for one enquiry key. */
const timesFor = (calls, key) => calls.filter((c) => c.key === key).map((c) => c.at);

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. N armed loads do not get an N-multiplied per-load interval.
  //
  // Under the old single global gate, four loads polled round-robin gave each a 4 x 5,000ms gap.
  // The bound now is minGetIntervalMs + (N-1) x the global ceiling, because siblings only cost each
  // other a ceiling slot rather than a whole per-load interval.
  // ---------------------------------------------------------------------------------------------
  {
    const KEYS = ['A', 'B', 'C', 'D'];
    const { adapter, calls } = rig({
      handler: (url) => (url.includes('/bidding-data') ? liveState(600) : resp(404, {})),
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000,
    });
    await adapter.login();
    await Promise.all(KEYS.map((k) => adapter.getAuctionState(k)));
    await Promise.all(KEYS.map((k) => adapter.getAuctionState(k)));

    const N = KEYS.length;
    const bound = 5000 + (N - 1) * 1000;      // 8,000ms
    const oldBehaviour = N * 5000;            // 20,000ms - what one shared gate produced
    const gaps = KEYS.map((k) => { const ts = timesFor(calls, k); return { k, ts, gap: ts[1] - ts[0] }; });
    ok(gaps.every((g) => g.ts.length === 2), 'every armed load was read twice');
    ok(gaps.every((g) => g.gap <= bound),
      `each load's own poll interval stays within minGetIntervalMs + (N-1) ceiling slots (gaps=${JSON.stringify(gaps.map((g) => g.gap))}, bound=${bound})`);
    ok(gaps.every((g) => g.gap < oldBehaviour),
      `no load is pushed out to the N-multiplied interval the shared gate produced (${oldBehaviour}ms)`);
    ok(gaps.every((g) => g.gap >= 5000),
      'and no load is read FASTER than its own per-enquiry interval - fairness is not a licence to poll harder');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The global ceiling holds. Per-load fairness must not multiply into the limiter: whatever is
  //    armed, two consecutive GETs are never closer together than the ceiling.
  // ---------------------------------------------------------------------------------------------
  {
    const KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
    const CEILING = 1000;
    const { adapter, calls, at } = rig({
      handler: (url) => (url.includes('/bidding-data') ? liveState(600) : resp(404, {})),
      minGetIntervalMs: 5000, globalMinGetIntervalMs: CEILING,
    });
    await adapter.login();
    const t0 = at();
    await Promise.all(KEYS.map((k) => adapter.getAuctionState(k)));
    await Promise.all(KEYS.map((k) => adapter.getAuctionState(k)));

    ok(calls.length === 16, `every read was issued (${calls.length}/16) - the ceiling delays, it never drops a read`);
    const ordered = calls.map((c) => c.at).sort((x, y) => x - y);
    let minGap = Infinity;
    for (let i = 1; i < ordered.length; i += 1) minGap = Math.min(minGap, ordered[i] - ordered[i - 1]);
    ok(minGap >= CEILING, `no two GETs land closer than the ceiling (tightest gap ${minGap}ms >= ${CEILING}ms)`);
    ok((at() - t0) >= (calls.length - 1) * CEILING,
      `16 reads across 8 loads take at least 15 ceiling slots of wall time (${at() - t0}ms) - the aggregate rate is capped, not just the per-load one`);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. A 429 backs off and then RECOVERS. Latching at the conservative default is the failure this
  //    guards: the ceiling should discover a workable rate, not sit permanently at the safest one.
  // ---------------------------------------------------------------------------------------------
  {
    let throttleNext = true;
    const { adapter, calls, advance } = rig({
      handler: (url) => {
        if (!url.includes('/bidding-data')) return resp(404, {});
        if (throttleNext) { throttleNext = false; return resp(429, 'Too Many Requests'); }
        return liveState(600);
      },
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000,
      rateLimitBackoffMs: 60_000, rateLimitRecoveryReads: 3,
    });
    await adapter.login();
    await adapter.getAuctionState('T1');       // the 429
    advance(61_000);                           // wait out the hard cooldown

    await adapter.getAuctionState('X');        // clean 1
    await adapter.getAuctionState('Y');        // clean 2
    const backedOff = timesFor(calls, 'Y')[0] - timesFor(calls, 'X')[0];
    ok(backedOff === 2000, `after a 429 the ceiling doubles - two reads on distinct loads sit ${backedOff}ms apart (expected 2000)`);

    await adapter.getAuctionState('Z');        // clean 3 -> one step of recovery
    await adapter.getAuctionState('W');
    await adapter.getAuctionState('V');
    const recovered = timesFor(calls, 'V')[0] - timesFor(calls, 'W')[0];
    ok(recovered === 1000, `sustained clean reads walk the ceiling back to its floor (${recovered}ms, expected 1000) - the backoff does not latch`);
    ok(recovered < backedOff, 'recovery is a real return to the floor, not a smaller permanent penalty');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. A hot-path read is not starved by routine polling. Discovery paging is the lowest class, so
  //    an enquiry inside its decisive window takes the contested slot even when discovery asked
  //    for it first.
  // ---------------------------------------------------------------------------------------------
  {
    const { adapter, calls } = rig({
      handler: (url) => {
        if (url.includes('/bidding-data')) return liveState(3);          // 3s out: decisive
        if (url.includes('/enquiries/spot')) return resp(200, { data: { enquiries: [], total_page: 1 } });
        return resp(404, {});
      },
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 3000,
    });
    await adapter.login();
    await adapter.getAuctionState('HOT');   // establishes the close, so the NEXT read is decisive

    const routine = adapter.listAuctions();  // asked for first
    const hot = adapter.getAuctionState('HOT');
    await Promise.all([routine, hot]);

    const contested = calls.filter((c) => c.at > calls[0].at);
    ok(contested.length === 2, `both reads went out (${contested.length}) - priority reorders, it never drops`);
    ok(contested[0].url.includes('/bidding-data'),
      'the decisive read takes the contested slot ahead of the discovery page that requested it first');
    ok(contested[1].url.includes('/enquiries/spot'),
      'and the routine page still goes out, one ceiling slot later - it is deferred, not starved');
  }

  // ---------------------------------------------------------------------------------------------
  // 5. snipeBudgetMs is the INPUT to that decision, not a hardcoded window. The capability was
  //    declared and read by nobody (MULTI_PLATFORM_ARCHITECTURE.md invariant 8, published-with-no-
  //    consumer direction). Same load, same countdown, different declared budget -> different
  //    class, which is what proves the declaration is actually consumed.
  // ---------------------------------------------------------------------------------------------
  {
    const mk = (snipeBudgetMs, secs = 3) => rig({
      handler: (url) => (url.includes('/bidding-data') ? liveState(secs) : resp(404, {})),
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs,
    });

    const withBudget = mk(3000);
    await withBudget.adapter.login();
    await withBudget.adapter.getAuctionState('K');
    await withBudget.adapter.getAuctionState('K');
    const hotGap = timesFor(withBudget.calls, 'K')[1] - timesFor(withBudget.calls, 'K')[0];

    // 4 s out, so with no budget (a 2 s horizon) the load is POLL for 2 s before it crosses in.
    const noBudget = mk(0, 4);
    await noBudget.adapter.login();
    await noBudget.adapter.getAuctionState('K');
    await noBudget.adapter.getAuctionState('K');
    const coldGap = timesFor(noBudget.calls, 'K')[1] - timesFor(noBudget.calls, 'K')[0];

    ok(hotGap === 1000, `a load 3s from close, with a 3s declared snipe budget, re-reads at the ceiling (${hotGap}ms)`);
    // Reversal (2026-09-26, Waaree 260925RP1C): a POLL read used to sit out the whole 5 s spacing
    // even as its load crossed into its horizon, which put the read after the close. It now goes at
    // the crossing, so the declared budget still decides when the load turns decisive.
    ok(coldGap === 2000, `with snipeBudgetMs 0 the load 4s out waits for its own 2s horizon (${coldGap}ms), not the 1s ceiling - the declared budget is what moved it`);

    // A load far from close is never decisive, whatever the budget says.
    const far = rig({
      handler: (url) => (url.includes('/bidding-data') ? liveState(600) : resp(404, {})),
      minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 3000,
    });
    await far.adapter.login();
    await far.adapter.getAuctionState('F');
    await far.adapter.getAuctionState('F');
    const farGap = timesFor(far.calls, 'F')[1] - timesFor(far.calls, 'F')[0];
    ok(farGap === 5000, `a load 10 minutes from close keeps the routine interval (${farGap}ms) - the hot class is a window, not a default`);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Retry-After is OBEYED but BOUNDED. Ignoring it is how an account gets banned; honouring an
  //    absurd one strands every armed load for the life of the process.
  // ---------------------------------------------------------------------------------------------
  {
    const { adapter, calls, advance } = rig({
      handler: (url) => (url.includes('/bidding-data')
        ? resp(429, 'slow down', { 'retry-after': '100000' })   // 100,000s ~ 27.7 hours
        : resp(404, {})),
      rateLimitBackoffMs: 60_000, maxRateLimitBackoffMs: 120_000,
    });
    await adapter.login();
    await adapter.getAuctionState('R');
    ok(calls.length === 1, 'the throttled read was issued once');

    advance(119_000);
    await adapter.getAuctionState('R');
    ok(calls.length === 1, 'inside the bounded cooldown no further request is issued - the server is still obeyed');

    advance(2_000);
    const after = await adapter.getAuctionState('R');
    ok(calls.length === 2, 'past the bound the adapter resumes reading, rather than honouring a 27-hour header forever');
    ok(after.ok === false, 'and the resumed read still reports honestly (this stub keeps throttling)');

    ok(parseRetryAfterMs('120', 0) === 120_000,
      'the PARSER stays unclamped - the bound is applied to our cooldown, never to what we report the server said');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The write path's spacing cap may skip the per-enquiry gate but never the ceiling.
  // ---------------------------------------------------------------------------------------------
  {
    const quote = {
      id: 'QT',
      charges_list: { '11_freight_charges': { freight_charges_custom_charge_x: { units: 1, unit_name: 'TRUCK', price: 1 } } },
      total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } },
    };
    const { adapter, calls } = rig({
      handler: (url, init) => {
        if (url.includes('/bidding-data')) return liveState(600);
        if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quote]);
        if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1 } });
        return resp(404, {});
      },
      bidEnabled: true, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, writeGetSpacingCapMs: 1000,
    });
    await adapter.login();
    await adapter.getAuctionState('B1');
    const r = await adapter.placeBid('B1', 50_000, { floor: 1000 });
    ok(r.accepted === true, 'the bid still goes out');
    const quoteGet = calls.find((c) => c.method === 'GET' && c.url.includes('/quotes'));
    const gap = quoteGet.at - calls[0].at;
    ok(gap < 5000, `the quote fetch skips the 5s per-enquiry gate (waited ${gap}ms)`);
    ok(gap >= 1000, `but it still honours the ceiling (waited ${gap}ms >= 1000ms) - the cap is a floor-relief, not a bypass`);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. CONFIG PARITY. A box with none of the new env vars set must behave exactly as the adapter
  //    did before any of them existed. This is the assertion that makes the wiring safe to deploy:
  //    the knobs are new, the behaviour is not.
  // ---------------------------------------------------------------------------------------------
  {
    const bare = new GoCometAdapter({ token: validToken() });
    ok(bare.minGetIntervalMs === 5000, 'default per-enquiry interval is 5,000ms');
    ok(bare.globalMinGetIntervalMs === 1000, 'default ceiling is 1,000ms');
    ok(bare.routineGetIntervalMs === 5000, 'default routine-class interval tracks the per-enquiry one');
    ok(bare.rateLimitBackoffMs === 60_000, 'default cooldown is 60,000ms');
    ok(bare.maxRateLimitBackoffMs === 120_000, 'default Retry-After clamp is 120,000ms');
    ok(bare.rateLimitBackoffSteps === 3 && bare.rateLimitRecoveryReads === 20, 'default adaptation is 3 steps / 20 clean reads');

    // The wired path, with no GC_* set, must resolve to exactly those same values. config.js passes
    // null for an unset knob precisely so the adapter's default is the only one in play.
    const gc = config.gocomet;
    const wired = new GoCometAdapter({
      token: validToken(),
      minGetIntervalMs: gc.minGetIntervalMs,
      rateLimitBackoffMs: gc.rateLimitBackoffMs,
      globalMinGetIntervalMs: gc.globalMinGetIntervalMs,
      routineGetIntervalMs: gc.routineGetIntervalMs,
      maxRateLimitBackoffMs: gc.maxRateLimitBackoffMs,
      rateLimitBackoffSteps: gc.rateLimitBackoffSteps,
      rateLimitRecoveryReads: gc.rateLimitRecoveryReads,
    });
    const KNOBS = ['minGetIntervalMs', 'globalMinGetIntervalMs', 'routineGetIntervalMs',
      'rateLimitBackoffMs', 'maxRateLimitBackoffMs', 'rateLimitBackoffSteps', 'rateLimitRecoveryReads'];
    const drift = KNOBS.filter((k) => wired[k] !== bare[k]);
    ok(drift.length === 0, `an unconfigured box resolves every knob to the adapter default (drift: ${JSON.stringify(drift)})`);
    ok(gc.globalMinGetIntervalMs === null && gc.rateLimitBackoffSteps === null,
      'config passes null for an unset knob rather than restating the number - one home per default');
  }

  // ---------------------------------------------------------------------------------------------
  // 9. A BAD ENV VALUE NEVER BUYS A MORE AGGRESSIVE RATE. Garbage resolves to the default, not to
  //    "unbounded" - which is what a bare Number() would have handed back for GC_..._MS=0.
  // ---------------------------------------------------------------------------------------------
  {
    const ceiling = (v) => new GoCometAdapter({ token: validToken(), globalMinGetIntervalMs: v }).globalMinGetIntervalMs;
    ok(ceiling(0) === 1000, 'ceiling of 0 (would be no ceiling at all) resolves to the default');
    ok(ceiling(-1) === 1000, 'a negative ceiling resolves to the default');
    ok(ceiling(Number('fast')) === 1000, 'a non-numeric ceiling (NaN) resolves to the default');
    ok(ceiling(100) === 1000, 'a ceiling below the 250ms credible floor is refused - 200ms is the rate that logged 2,629 429s');
    ok(ceiling(2000) === 2000, 'a LOOSER ceiling than the default is honoured - the safe direction is always allowed');

    // Lowering the per-enquiry knob must not silently drag the derived ceiling into that same zone.
    const derived = new GoCometAdapter({ token: validToken(), minGetIntervalMs: 100 });
    ok(derived.globalMinGetIntervalMs === 250,
      `a 100ms per-enquiry interval still floors the derived ceiling at 250ms (got ${derived.globalMinGetIntervalMs})`);

    const clamp = (v) => new GoCometAdapter({ token: validToken(), maxRateLimitBackoffMs: v }).maxRateLimitBackoffMs;
    ok(clamp(0) === 120_000, 'a zero Retry-After clamp (would ignore the server outright) resolves to the default');
    ok(clamp(1000) === 120_000, 'a clamp below the base cooldown could never bind, so it resolves to the default');
    ok(clamp(300_000) === 300_000, 'a clamp ABOVE the default is honoured - obeying the server longer is the safe direction');

    const steps = (v) => new GoCometAdapter({ token: validToken(), rateLimitBackoffSteps: v }).rateLimitBackoffSteps;
    ok(steps(0) === 3, 'a 0 step count resolves to the default - adaptation cannot be switched off, deliberately unlike the house 0-is-disable convention');
    ok(steps(-2) === 3, 'a negative step count resolves to the default');
    ok(steps(1) === 1, 'the minimum real setting is still reachable - one doubling, for an operator who wants the gentlest backoff');
    ok(steps(50) === 10, 'an absurd step count clamps to 10 rather than producing a spacing that never returns');
    ok(steps(2.7) === 2, 'a fractional step count floors rather than producing a fractional doubling');

    const recovery = (v) => new GoCometAdapter({ token: validToken(), rateLimitRecoveryReads: v }).rateLimitRecoveryReads;
    ok(recovery(0) === 20, 'zero recovery reads (would recover on every read, i.e. no backoff) resolves to the default');
    ok(recovery(5) === 5, 'a faster-but-sane recovery is honoured');

    // The knobs are bounded at the SEAM, so a direct constructor caller is protected too, not just
    // the config path - which is what makes the bound a safety property rather than a parse detail.
    const junk = new GoCometAdapter({
      token: validToken(), minGetIntervalMs: 0, globalMinGetIntervalMs: 0,
      routineGetIntervalMs: -5, rateLimitBackoffMs: 0,
    });
    ok(junk.minGetIntervalMs === 5000 && junk.globalMinGetIntervalMs === 1000
      && junk.routineGetIntervalMs === 5000 && junk.rateLimitBackoffMs === 60_000,
      'an all-zeros construction resolves to the full default budget, not to an ungated adapter');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  // Completion sentinel: the runner grades by exit code alone, so a file that exits 0 after an
  // early return would score as a silent green with zero assertions.
  const MIN_EXPECTED_CHECKS = 45;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
