'use strict';
/**
 * A synthetic cooldown 429 on the enquiry-detail fetch is booked as a per-enquiry failure.
 *
 * Regression target: PR #154 review, Finding 4 (src/platform/gocometAdapter.js listAuctions loop
 * over `_fetchEnquiryDetail` / `_noteDetailFailure`).
 *
 * `_request` SYNTHESISES a 429 (`_cooldownResult()`) without sending anything while a transport-
 * wide cooldown is open. `_fetchEnquiryDetail` cannot tell that apart from a real 429 and calls
 * `_noteDetailFailure(key, 429)`, which sets a 120s per-enquiry backoff - LONGER than the 60s
 * transport cooldown it was actually caused by. So once the real cooldown clears, the enquiry stays
 * artificially blocked for another 60s on a failure that was never actually attempted, and
 * `listAuctions`'s bounded per-cycle detail-fetch budget is spent on it too.
 *
 * MECHANISM, made observable without peeking at budget internals: enquiry A trips a REAL 429 (a
 * genuine wire response, not synthetic), opening the transport cooldown. Enquiry B, listed right
 * after A in the same cycle, is then only ever offered the SYNTHETIC cooldown 429 - nothing is ever
 * sent for it. Once the clock advances past the 60s transport cooldown (but before A's own 120s
 * backoff has elapsed), B must be immediately eligible for a real detail fetch again; A - which had
 * a genuine failure - must still be respected by its own backoff (CONTROL).
 *
 *   node scripts/test-gocomet-cooldown-not-a-detail-failure.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
function resp(status, body) { return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }

function rig(startAt) {
  let t = startAt;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const calls = [];
  const detailHits = { A: 0, B: 0 };
  const enquiries = [
    { key: 'A', origin: 'X', destination: 'Y', mode: 'FTL', bidding_closed: false,
      bid_close_timestamp: new Date(startAt + 6 * 3600_000).toISOString() },
    { key: 'B', origin: 'X', destination: 'Y', mode: 'FTL', bidding_closed: false,
      bid_close_timestamp: new Date(startAt + 6 * 3600_000).toISOString() },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, url: String(url), method: init.method });
    if (String(url).includes('/enquiries/spot')) {
      return resp(200, { data: { enquiries, total_page: 1 } });
    }
    const m = /\/enquiries\/([^/?]+)$/.exec(String(url));
    const key = m ? decodeURIComponent(m[1]) : null;
    if (key === 'A') { detailHits.A += 1; return resp(429, 'Too Many Requests'); } // a REAL 429
    if (key === 'B') {
      detailHits.B += 1;
      return resp(200, { data: { cargo_quantity: 5, cargo_unit: 'TRUCK', quantity: ['1 x TRUCK'] } });
    }
    return resp(404, {});
  };
  const a = new GoCometAdapter({
    token: validToken(), now, sleep, fetchImpl,
    rateLimitBackoffMs: 60_000, detailFailBackoffMs: 120_000, maxDetailFetchesPerList: 2,
  });
  return { a, calls, detailHits, advance: (ms) => { t += ms; } };
}

(async () => {
  const BASE = 1_700_000_000_000;
  const { a, detailHits, advance } = rig(BASE);
  await a.login();

  // Cycle 1: A's detail fetch gets a genuine 429 (opens the transport cooldown); B is listed right
  // after A in the same cycle and can only ever be offered the synthetic cooldown 429.
  await a.listAuctions({ enrich: true });
  assert.strictEqual(detailHits.A, 1, 'harness: A really was attempted and drew a real 429');
  assert.strictEqual(detailHits.B, 0, 'harness: B never reached the wire in this cycle (blocked by the cooldown A just opened)');

  // 1. MECHANISM: a cooldown-blocked attempt must NOT be booked as a per-enquiry failure - B must
  //    carry no detail-fail backoff at all.
  assert.strictEqual(a._detailFailUntil.has('B'), false,
    'a synthetic cooldown 429 must not be noted as a per-enquiry detail failure for B');
  ok('B, blocked only by the transport cooldown, is not booked with its own detail-fail backoff');

  // 2. CONTROL: A's failure was a REAL response, and it IS noted.
  assert.strictEqual(a._detailFailUntil.has('A'), true, 'a genuine per-enquiry failure IS still noted (control)');
  ok('A, which drew a real 429, is noted with its own backoff (control)');

  // 3. Advance the clock past the 60s TRANSPORT cooldown (but well inside A's own 120s backoff).
  advance(60_001);
  await a.listAuctions({ enrich: true });

  // MECHANISM, behavioural: B must be immediately eligible for a real detail fetch once the
  // transport cooldown that blocked it has cleared - it was never actually the source of a failure.
  assert.strictEqual(detailHits.B, 1, 'B must be re-attempted for real once the transport cooldown clears - it never had its own failure');
  ok('once the transport cooldown clears, B is fetched for real (its budget/backoff were never spent on a no-op)');

  // 4. CONTROL: A's own genuine failure backoff (120s) has NOT elapsed yet (only 60,001ms have
  //    passed) - A must still be skipped. Real per-enquiry backoffs are unaffected by this fix.
  assert.strictEqual(detailHits.A, 1, "A's own 120s backoff has not elapsed - it is still (correctly) skipped");
  ok("A's genuine backoff is still respected - the fix does not weaken real per-enquiry failure handling");

  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
