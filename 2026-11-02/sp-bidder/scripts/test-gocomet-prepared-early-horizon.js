'use strict';
/**
 * T2b - PREPARE EARLY ENOUGH TO MATTER. The buzzer and the HOT read horizon stay at 6,500ms
 * (ruling 51(b)) - unchanged here. But if preparation only starts AT the buzzer read, it is still
 * mid-flight when the buzzer fires, which is exactly the single-flight case. The prepare trigger has
 * to fire on an EARLIER read - the engine's own middle-band poll around 11s out - so that by the
 * 6.5s buzzer read a quote is already cached and still inside the 5s freshness bound.
 *
 * RED (before this fix): nothing prepares at 11s (the trigger is gated on the 6.5s decisive horizon
 * alone), so the 6.5s buzzer read starts the FIRST prepare, and the bid racing it sends the four-GET
 * shape test-gocomet-prepared-single-flight.js pins - never the PUT alone.
 * GREEN (after the fix): the 11s read starts preparing; by the 6.5s read a fresh quote is cached, and
 * the bid at the buzzer sends exactly one request, the PUT.
 *
 *   node scripts/test-gocomet-prepared-early-horizon.js
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

/** Yield to the real event loop enough times for an in-flight prepare's chained awaits to settle,
 * without touching any internal handle - this mimics the wall-clock gap a real engine poll leaves
 * between reads, not a hook into the prepare's own promise. */
async function letBackgroundWorkSettle(times = 40) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

(async () => {
  const KEY = 'ENQ-T2B-6';

  {
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: seq.closingIn, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const seq = { closingIn: 11 };
    const { adapter, calls, advance } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();

    // The engine's middle-band poll, 11s out - inside the widened prepare trigger, outside the
    // buzzer's own 6.5s decisive horizon (unchanged).
    await adapter.getAuctionState(KEY);
    await letBackgroundWorkSettle();

    // The wall-clock gap to the buzzer read: 11s -> 6.5s is 4,500ms.
    advance(4500);
    seq.closingIn = 6.5;

    // The buzzer read itself - the same read that would trigger the DECISIVE (HOT) class today,
    // unchanged (still governed by the 6.5s decisive horizon, never touched by this package).
    await adapter.getAuctionState(KEY);

    const before = calls.length;
    const r = await adapter.placeBid(KEY, 40000, { floor: 10000 });
    const fired = calls.slice(before);

    ok(r.accepted === true, 'the buzzer bid is accepted');
    ok(fired.length === 1 && fired[0] && fired[0].method === 'PUT',
      `the buzzer bid sends exactly one request, the PUT (got ${fired.length}: ${fired.map((c) => c.method).join(', ') || 'none'})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b early-horizon checks failed`);
  const MIN_EXPECTED_CHECKS = 2;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
