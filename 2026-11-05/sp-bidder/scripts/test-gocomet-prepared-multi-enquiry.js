'use strict';
/**
 * T2b - MULTI-ENQUIRY. Two enquiries sharing the same close, each prepared at its own 11s middle-band
 * read and fired at its own 6.5s buzzer read, must not cross-contend for GET slots at the buzzer -
 * each fire sends only its own PUT, and no GET is issued between either 6.5s read and its PUT.
 *
 *   node scripts/test-gocomet-prepared-multi-enquiry.js
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

/** Enquiry key out of any vendor-API path. */
function keyOf(url) {
  const m = /\/enquiries\/([^/?]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

function rig({ start = 1_000_000, handler, ...opts } = {}) {
  let t = start;
  const calls = [];
  const now = () => t;
  const sleep = async (ms) => { await new Promise((r) => setImmediate(r)); t += ms; };
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, url, method: (init && init.method) || 'GET', key: keyOf(url) });
    return handler(url, init) || resp(404, {});
  };
  const adapter = new GoCometAdapter(Object.assign({ token: validToken(), bidEnabled: true, fetchImpl, sleep, now }, opts));
  return { adapter, calls, advance: (ms) => { t += ms; } };
}

async function letBackgroundWorkSettle(times = 300) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

(async () => {
  const A = 'ENQ-T2B-7A';
  const B = 'ENQ-T2B-7B';

  {
    const closingIn = { [A]: 11, [B]: 11 };
    const putIds = { [A]: 'QA', [B]: 'QB' };
    const handler = (url, init) => {
      const k = keyOf(url);
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: closingIn[k], vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc(putIds[k], 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();

    // Both enquiries share the same close - both hit their 11s middle-band read together, and both
    // prepares share the one-per-second global GET ceiling, so B's finishes measurably later than
    // A's even though they started together. That shared queue is itself the wall-clock gap to the
    // buzzer here - by the time both are cached, each is still comfortably inside the 5s bound (the
    // slowest of the two, B, is cached at age 0 the instant it lands), which is what the buzzer read
    // finding a fresh, isolated entry per key looks like from the wire's point of view.
    await adapter.getAuctionState(A);
    await adapter.getAuctionState(B);
    await letBackgroundWorkSettle();
    closingIn[A] = 6.5; closingIn[B] = 6.5;

    const before = calls.length;
    const rA = await adapter.placeBid(A, 40000, { floor: 10000 });
    const firedA = calls.slice(before);
    const beforeB = calls.length;
    const rB = await adapter.placeBid(B, 40000, { floor: 10000 });
    const firedB = calls.slice(beforeB);

    ok(rA.accepted === true && rB.accepted === true, 'both buzzer bids are accepted');
    ok(firedA.length === 1 && firedA[0].method === 'PUT',
      `A's fire sends only its own PUT (got ${firedA.length}: ${firedA.map((c) => c.method + '/' + c.key).join(', ') || 'none'})`);
    ok(firedB.length === 1 && firedB[0].method === 'PUT',
      `B's fire sends only its own PUT (got ${firedB.length}: ${firedB.map((c) => c.method + '/' + c.key).join(', ') || 'none'})`);
    ok(!firedA.some((c) => c.method === 'GET') && !firedB.some((c) => c.method === 'GET'),
      'no GET is issued between either buzzer read and its PUT');
  }

  assert.strictEqual(fail, 0, `${fail} T2b multi-enquiry checks failed`);
  const MIN_EXPECTED_CHECKS = 4;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
