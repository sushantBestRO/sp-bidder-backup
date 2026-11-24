'use strict';
/**
 * T2b - SINGLE-FLIGHT. A bid issued while this enquiry's quote is already being prepared must join
 * that prepare rather than race it with its own cold-path reads.
 *
 * RED (before this fix): placeBid has no idea a prepare is in flight, finds nothing usable yet, and
 * issues its own quote GET + confirming GET while the prepare's two GETs are still in flight - four
 * GETs contending for the one-per-second global budget instead of two, right at the buzzer ruling 51
 * exists to protect.
 * GREEN (after the fix): placeBid waits on the in-flight prepare and reuses its result - the wire
 * sees the prepare's two GETs and one PUT, never a duplicate cold-path pair.
 *
 *   node scripts/test-gocomet-prepared-single-flight.js
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
  return { adapter, calls };
}

(async () => {
  const KEY = 'ENQ-T2B-5';

  {
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();

    // 5s out is inside the decisive horizon - this starts a background prepare, deliberately NOT
    // awaited, so the bid below lands while it is still in flight and nothing is cached yet.
    await adapter.getAuctionState(KEY);

    const before = calls.length;
    const r = await adapter.placeBid(KEY, 40000, { floor: 10000 });
    const fired = calls.slice(before);
    const gets = fired.filter((c) => c.method === 'GET').length;
    const puts = fired.filter((c) => c.method === 'PUT').length;

    ok(r.accepted === true, 'the bid is accepted');
    ok(gets <= 2, `no more than the prepare's own two GETs reach the wire while it is in flight (got ${gets})`);
    ok(puts === 1, `exactly one PUT (got ${puts})`);
    ok(fired.length <= 3, `at most 3 total requests - the prepare's two GETs plus one PUT, never a racing cold-path pair (got ${fired.length}: ${fired.map((c) => c.method).join(', ') || 'none'})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b single-flight checks failed`);
  const MIN_EXPECTED_CHECKS = 4;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
