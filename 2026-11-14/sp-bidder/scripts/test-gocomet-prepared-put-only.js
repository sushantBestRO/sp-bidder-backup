'use strict';
/**
 * T2b - GoComet quote pre-fetch (ruling 61). The adapter prepares a quote (read, validate, confirm)
 * while an enquiry is inside the decisive horizon, so a bid at fire sends the PUT alone.
 *
 * RED (before the fix): placeBid always re-fetches and re-confirms at fire, so a load already
 * driven into the prepare horizon still sends GET, GET, PUT - 3 requests, 2 slot waits.
 * GREEN (after the fix): with a quote already prepared, the same call sends exactly 1 request.
 *
 *   node scripts/test-gocomet-prepared-put-only.js
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

/** Virtual clock + recording transport - the house pattern from test-gocomet-read-budget.js. */
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
  const KEY = 'ENQ-T2B-1';

  // ---- drive the state reads into the prepare horizon, then fire --------------------------------
  {
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();

    // A load 5s from close is inside the decisive horizon (4500 + 2*1000 = 6500ms) - this read
    // must start a background prepare.
    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;

    const beforeFire = calls.length;
    const r = await adapter.placeBid(KEY, 40000, { floor: 10000 });
    const fired = calls.slice(beforeFire);

    ok(r.accepted === true, 'the prepared bid is accepted');
    ok(fired.length === 1, `exactly one request at fire (got ${fired.length}: ${fired.map((c) => c.method + ' ' + c.url).join(', ') || 'none'})`);
    ok(fired[0] && fired[0].method === 'PUT', `the one request at fire is the PUT (got ${fired[0] && fired[0].method})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b prepared-put-only checks failed`);
  const MIN_EXPECTED_CHECKS = 3;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
