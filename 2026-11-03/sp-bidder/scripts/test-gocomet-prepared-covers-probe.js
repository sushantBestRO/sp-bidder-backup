'use strict';
/**
 * Round tracker piece C x T2b: the prepared quote covers the pre-final probe shot (rulings 40, 56, 61).
 *
 * The engine's pre-final GoComet shot now goes in the 12 s middle band (ruling 56: GoComet probe lead
 * 12 s), so the prepare that T2b starts at the decisive horizon plus the 5 s freshness bound (~11.5 s)
 * starts on the probe's own read or after it. The probe then races its own prepare: GET, GET, PUT at the
 * shot that most needs the PUT alone. The prepare trigger must open at or below 12 s + 5 s.
 *
 * RED (before the fix): a read at 15 s prepares nothing, so the probe read at 11 s starts the first
 * prepare and the probe bid sends the prepare's two GETs before its PUT.
 * GREEN: the 15 s read prepares; the probe bid at 11 s sends the PUT alone, and the buzzer bid at 6.5 s,
 * on the quote the probe's accepted submit refreshed, sends the PUT alone too. The buzzer and the HOT
 * read horizon stay at 6.5 s (ruling 51(b)); test-gocomet-prepared-early-horizon.js pins that.
 *
 *   node scripts/test-gocomet-prepared-covers-probe.js
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

async function letBackgroundWorkSettle(times = 40) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

(async () => {
  const KEY = 'ENQ-PROBE-1';
  let t = 1_000_000;
  const calls = [];
  const seq = { closingIn: 15, putPrice: 41000 };
  const handler = (url, init) => {
    if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: seq.closingIn, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
    if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 42000)]);
    if (init.method === 'PUT') return resp(200, { data: quoteDoc('Q1', seq.putPrice) });
    return resp(404, {});
  };
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, url, method: (init && init.method) || 'GET' });
    return handler(url, init) || resp(404, {});
  };
  const adapter = new GoCometAdapter({ token: validToken(), bidEnabled: true, now: () => t,
    sleep: async (ms) => { await new Promise((r) => setImmediate(r)); t += ms; }, fetchImpl,
    minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
  await adapter.login();

  // A poll 15 s out: inside 12 s + 5 s, outside the old ~11.5 s trigger.
  await adapter.getAuctionState(KEY);
  await letBackgroundWorkSettle();

  // The engine's middle-band read at 11 s, and the probe shot decided on it.
  t += 4000;
  seq.closingIn = 11;
  await adapter.getAuctionState(KEY);
  const beforeProbe = calls.length;
  const probe = await adapter.placeBid(KEY, 41000, { floor: 10000 });
  const probeFired = calls.slice(beforeProbe);
  ok(probe.accepted === true, 'the probe bid is accepted');
  ok(probeFired.length === 1 && probeFired[0].method === 'PUT',
    `the probe bid at 11 s sends exactly one request, the PUT (got ${probeFired.length}: ${probeFired.map((c) => c.method).join(', ') || 'none'})`
    + ' - the prepare did not start before the probe read, so the probe raced its own GET, GET');

  // The buzzer read at 6.5 s and the shot decided on it.
  t += 4500;
  seq.closingIn = 6.5;
  seq.putPrice = 40500;
  await adapter.getAuctionState(KEY);
  const beforeBuzzer = calls.length;
  const buzzer = await adapter.placeBid(KEY, 40500, { floor: 10000 });
  const buzzerFired = calls.slice(beforeBuzzer);
  ok(buzzer.accepted === true, 'the buzzer bid is accepted');
  ok(buzzerFired.length === 1 && buzzerFired[0].method === 'PUT',
    `the buzzer bid at 6.5 s sends exactly one request, the PUT (got ${buzzerFired.length}: ${buzzerFired.map((c) => c.method).join(', ') || 'none'})`);

  assert.strictEqual(fail, 0, `${fail} prepared-covers-probe checks failed`);
  const MIN_EXPECTED_CHECKS = 4;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
