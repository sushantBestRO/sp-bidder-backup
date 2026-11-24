'use strict';
/**
 * T2b - a prepared quote survives a 429 read cooldown that opens after it (ruling 61): "for the
 * life of the current arm" - the cooldown does not invalidate a quote already prepared for the same
 * believed close, even once it is older than the normal 5s freshness bound.
 *
 * RED (before the fix): _fetchQuoteForWrite synthesises RATE_LIMITED with no request issued while
 * the cooldown is open, so placeBid throws and nothing goes out.
 * GREEN (after the fix): the prepared quote is reused, the PUT goes and is accepted.
 *
 *   node scripts/test-gocomet-put-during-read-cooldown.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

const FREIGHT = 'freight_charges_custom_charge_40ft';
function quoteDoc(id, price) {
  return {
    id,
    charges_list: { '11_freight_charges': { [FREIGHT]: { units: 1, unit_name: 'TRUCK', price } } },
    total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: price } },
  };
}

function rig({ start = 1_000_000, handler, ...opts } = {}) {
  let t = start;
  const calls = [];
  const now = () => t;
  const sleep = async (ms) => { await new Promise((r) => setImmediate(r)); t += ms; };
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, url, method: (init && init.method) || 'GET' });
    return handler(url, init) || resp(404, {});
  };
  const adapter = new GoCometAdapter(Object.assign({ token: validToken(), bidEnabled: true, fetchImpl, sleep, now }, opts));
  return { adapter, calls, advance: (ms) => { t += ms; } };
}

(async () => {
  const KEY = 'ENQ-T2B-2';
  const OTHER = 'ENQ-OTHER';

  {
    let throttleOther = false;
    const handler = (url, init) => {
      if (url.includes(encodeURIComponent(OTHER)) && throttleOther) return resp(429, '');
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls, advance } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500, rateLimitBackoffMs: 60_000 });
    await adapter.login();

    // Prepare the quote for KEY while it is inside the decisive horizon.
    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;

    // Age the prepared quote past the normal 5s freshness bound - only the cooldown-arm rule can
    // still make it usable from here.
    advance(6000);

    // An UNRELATED read (a different enquiry's poll) trips a 429 and opens the adapter-wide cooldown.
    throttleOther = true;
    await adapter.getAuctionState(OTHER);
    ok(adapter.now() < adapter._cooldownUntil, 'precondition: the cooldown is open going into the bid');

    const beforeFire = calls.length;
    let r = null, err = null;
    try { r = await adapter.placeBid(KEY, 40000, { floor: 10000 }); } catch (e) { err = e; }
    const fired = calls.slice(beforeFire);

    ok(r && r.accepted === true, `the bid is accepted during the cooldown, not refused RATE_LIMITED (got accepted=${r && r.accepted}, err=${err && err.code})`);
    ok(fired.length === 1 && fired[0] && fired[0].method === 'PUT',
      `exactly one request at fire, the PUT (got ${fired.length}: ${fired.map((c) => c.method + ' ' + c.url).join(', ') || 'none'})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b put-during-read-cooldown checks failed`);
  const MIN_EXPECTED_CHECKS = 3;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
