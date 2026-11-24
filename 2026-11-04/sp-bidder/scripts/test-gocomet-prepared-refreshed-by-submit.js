'use strict';
/**
 * T2b - every accepted submit refreshes the prepared quote (ruling 61), so a second bid on the same
 * enquiry inside the bound also sends the PUT alone, rather than falling back to GET, GET, PUT.
 *
 * RED (before the fix): there is no prepared-quote cache to refresh, so a second placeBid re-fetches
 * and re-confirms - 3 requests, same as the first.
 * GREEN (after the fix): the second placeBid makes exactly 1 request.
 *
 *   node scripts/test-gocomet-prepared-refreshed-by-submit.js
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
  const KEY = 'ENQ-T2B-3';

  {
    let nextPutPrice = 41000;
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      // The accept response carries the server's own quote object - a real, cacheable document -
      // which is what T2b's refresh reads from.
      if (init.method === 'PUT') return resp(200, { data: quoteDoc('Q1', nextPutPrice) });
      return resp(404, {});
    };
    const { adapter, calls } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();

    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;

    const beforeFirst = calls.length;
    const r1 = await adapter.placeBid(KEY, 41000, { floor: 10000 });
    const firstFired = calls.slice(beforeFirst);
    ok(r1.accepted === true, 'the first bid is accepted');
    ok(firstFired.length === 1 && firstFired[0].method === 'PUT', `the first bid sends exactly one request (got ${firstFired.length})`);

    // A second bid, inside the 5s bound, immediately after the first accepted PUT.
    nextPutPrice = 40500;
    const beforeSecond = calls.length;
    const r2 = await adapter.placeBid(KEY, 40500, { floor: 10000 });
    const secondFired = calls.slice(beforeSecond);
    ok(r2.accepted === true, 'the second bid is accepted');
    ok(secondFired.length === 1 && secondFired[0].method === 'PUT',
      `the second bid also sends exactly one request, not the cold path's three (got ${secondFired.length}: ${secondFired.map((c) => c.method).join(', ') || 'none'})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b prepared-refreshed-by-submit checks failed`);
  const MIN_EXPECTED_CHECKS = 4;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
