'use strict';
/**
 * Offline check for the 429/Retry-After + header-fidelity work. No network.
 *   A. parseRetryAfterMs: delta-seconds and HTTP-date, garbage -> null.
 *   B. _backoffMs: Full Jitter bounds (AWS); Retry-After honored + capped.
 *   C. reads retry on 429 honoring Retry-After; the bid WRITE does NOT retry and
 *      surfaces { reason: 'rate_limited' }.
 *   D. header fidelity: Sec-Fetch + Client-Hints present + coherent; captured
 *      override wins but can never replace our live Authorization token.
 *   E. engine: a 429 on the write keeps the rung UNSPENT (same price re-attempted).
 *
 *   node scripts/test-rate-limit.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter, parseRetryAfterMs } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fake fetch returning a scripted sequence of {status, retryAfter?, body?}
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({ url, init });
    return {
      status: r.status,
      headers: { get: (n) => (String(n).toLowerCase() === 'retry-after' && r.retryAfter != null ? String(r.retryAfter) : null) },
      json: async () => (r.body != null ? r.body : {}),
    };
  };
  fn.calls = calls;
  return fn;
}

// ---- A. parseRetryAfterMs ----
{
  assert.strictEqual(parseRetryAfterMs('120', 0), 120_000, 'delta-seconds');
  assert.strictEqual(parseRetryAfterMs('  30 ', 0), 30_000, 'trimmed delta-seconds');
  const base = Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');
  assert.strictEqual(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', base), 60_000, 'HTTP-date -> 60s');
  assert.strictEqual(parseRetryAfterMs('garbage', 0), null, 'garbage -> null');
  assert.strictEqual(parseRetryAfterMs(null, 0), null, 'null -> null');
  ok('parseRetryAfterMs: delta-seconds + HTTP-date + null');
}

// ---- B. Full Jitter bounds + Retry-After cap ----
{
  const a = new RealSuperProcureAdapter({ token: 't', rand: () => 0.5 });
  assert.strictEqual(a._backoffMs(0, null, 4000), Math.floor(0.5 * 250), 'attempt 0: half of base*1');
  assert.strictEqual(a._backoffMs(3, null, 4000), Math.floor(0.5 * 2000), 'attempt 3: half of base*8');
  assert.strictEqual(a._backoffMs(8, null, 4000), Math.floor(0.5 * 4000), 'large attempt capped at cap');
  assert.strictEqual(a._backoffMs(0, 1000, 4000), 1000, 'Retry-After honored');
  assert.strictEqual(a._backoffMs(0, 9000, 4000), 4000, 'Retry-After capped at cap');
  // full-jitter is bounded in [0, bound)
  const a2 = new RealSuperProcureAdapter({ token: 't', rand: () => 0.999 });
  assert.ok(a2._backoffMs(2, null, 4000) < Math.min(4000, 250 * 4), 'jitter strictly under the bound');
  ok('_backoffMs: Full Jitter bounds + Retry-After honored/capped');
}

(async () => {
  // ---- C. reads retry on 429; the write does NOT ----
  {
    const sleeps = [];
    const ff = fakeFetch([{ status: 429, retryAfter: 1 }, { status: 200, body: { ok: true } }]);
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: ff, sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0.5 });
    const res = await a._get('/sp/base/getHeader');
    assert.strictEqual(res.status, 200, 'read retried through the 429 to a 200');
    assert.strictEqual(ff.calls.length, 2, 'read fetched twice (one retry)');
    assert.deepStrictEqual(sleeps, [1000], 'read backed off exactly the Retry-After (1s, under cap)');
    ok('reads retry on 429 honoring Retry-After');
  }
  {
    const sleeps = [];
    const ff = fakeFetch([{ status: 429, retryAfter: 2 }]);
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: ff, sleep: async (ms) => { sleeps.push(ms); } });
    a.account = { carrierId: 5, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    const r = await a.placeBid('123', 50_000);
    assert.strictEqual(r.accepted, false, 'write not accepted under throttle');
    assert.strictEqual(r.reason, 'rate_limited', 'write surfaces rate_limited');
    assert.strictEqual(r.retryAfterMs, 2000, 'write reports the Retry-After (2s)');
    assert.strictEqual(ff.calls.length, 1, 'write did NOT retry (idempotency)');
    assert.deepStrictEqual(sleeps, [], 'write never slept');
    ok('bid write does NOT retry on 429 (surfaces rate_limited)');
  }
  {
    // network error on the write must THROW (engine reads rank back — idempotency oracle)
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl: async () => { throw new Error('econnreset'); } });
    a.account = { carrierId: 5, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    let threw = null;
    try { await a.placeBid('123', 50_000); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'NETWORK', 'write network error throws with NETWORK code');
    ok('bid write network error throws (idempotency read-back preserved)');
  }

  // ---- D. header fidelity + captured override can't replace the token ----
  {
    const a = new RealSuperProcureAdapter({ token: 'tok' });
    const h = a._headers();
    assert.strictEqual(h['sec-fetch-site'], 'same-site', 'same-site (app->api shared eTLD+1)');
    assert.strictEqual(h['sec-fetch-mode'], 'cors', 'cors');
    assert.strictEqual(h['sec-fetch-dest'], 'empty', 'empty (XHR, not navigation)');
    assert.ok(/Chromium";v="126"/.test(h['sec-ch-ua']) && /Chrome\/126/.test(h['user-agent']), 'UA + client-hints coherent on one Chrome major');
    assert.ok(String(h['accept-language']).startsWith('en-US'), 'accept-language present');
    assert.strictEqual(h.authorization, 'Bearer tok', 'live token');
    const a2 = new RealSuperProcureAdapter({ token: 'live', headers: { 'x-real': '1', authorization: 'Bearer STALE' } });
    const h2 = a2._headers();
    assert.strictEqual(h2['x-real'], '1', 'captured header merged in');
    assert.strictEqual(h2.authorization, 'Bearer live', 'captured stale token CANNOT override our live token');
    ok('header fidelity: Sec-Fetch + coherent Client-Hints; captured override safe');
  }

  // ---- E. engine: a 429 on the write keeps the rung unspent ----
  {
    const intents = path.join(os.tmpdir(), 'rl-eng-' + process.pid + '.json');
    let throttleOnce = true;
    const placed = [];
    const closesAt = Date.now() + 5_000;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 2,
          standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) {
        placed.push(price);
        if (throttleOnce) { throttleOnce = false; return { accepted: false, reason: 'rate_limited', retryAfterMs: 50, latencyMs: 30 }; }
        return { accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 30 };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(intents), { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt }, { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    await sleep(1_500);
    eng.kill();
    assert.ok(placed.length >= 2, 'attempted more than once');
    assert.strictEqual(placed[0], placed[1], 'same rung (opening 56300) re-attempted after the 429 — not consumed/skipped');
    assert.strictEqual(placed[0], 56_300, 'opening tier');
    try { fs.unlinkSync(intents); } catch (_) {}
    ok('engine: 429 on the write keeps the rung unspent (re-attempts same price)');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
