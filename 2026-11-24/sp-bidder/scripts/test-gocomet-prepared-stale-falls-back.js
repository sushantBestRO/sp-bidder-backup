'use strict';
/**
 * T2b - POSITIVE PINS. A prepared quote is only ever used inside the bound ruling 61 sets: at most
 * 5s old, or, while a 429 read cooldown is open, prepared under the current arm (the believed close
 * it was prepared for). Everything else - a stale quote with no cooldown open, or one prepared for a
 * close that has since moved - takes today's path byte for byte, and every belt still throws
 * `placed:false` before a PUT regardless of which path supplied the quote.
 *
 *   node scripts/test-gocomet-prepared-stale-falls-back.js
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
  const KEY = 'ENQ-T2B-4';

  // ---- 1. STALE, NO COOLDOWN: a prepared quote older than 5s with no cooldown open takes the cold
  //    path byte for byte - the same GET, GET, PUT shape as before T2b. ------------------------------
  {
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls, advance } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();
    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;

    advance(6000); // older than the 5s bound, and no cooldown is open

    const before = calls.length;
    const r = await adapter.placeBid(KEY, 40000, { floor: 10000 });
    const fired = calls.slice(before);
    ok(r.accepted === true, 'the bid still goes out on the cold path');
    ok(fired.length === 3 && fired.filter((c) => c.method === 'GET').length === 2 && fired.filter((c) => c.method === 'PUT').length === 1,
      `a stale prepared quote with no cooldown open falls back to GET, GET, PUT (got ${fired.map((c) => c.method).join(', ') || 'none'})`);
  }

  // ---- 2. PREVIOUS ARM: a quote prepared for a close that has since moved is never used, even while
  //    a cooldown is open - the cooldown-arm exception is scoped to the SAME believed close. --------
  {
    let throttleOther = false;
    const OTHER = 'ENQ-OTHER-4';
    const handler = (url, init) => {
      if (url.includes(OTHER) && throttleOther) return resp(429, '');
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const { adapter, calls, advance } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500, rateLimitBackoffMs: 60_000 });
    await adapter.login();
    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;
    advance(6000); // older than the 5s bound - only a matching arm can still make it usable

    // Simulate an extension: the believed close for KEY moves forward, without a refreshed prepare
    // (a real extension is observed only through a successful read, which a cooldown blocks - this
    // pokes the adapter's own close-tracking map directly to isolate the arm comparison from that
    // sequencing constraint).
    const moved = adapter._lastCloseAt.get(KEY).closeAt + 999_000;
    adapter._lastCloseAt.set(KEY, { at: adapter.now(), closeAt: moved });

    throttleOther = true;
    await adapter.getAuctionState(OTHER);
    ok(adapter.now() < adapter._cooldownUntil, 'precondition: the cooldown is open going into the bid');

    const before = calls.length;
    let err = null;
    try { await adapter.placeBid(KEY, 40000, { floor: 10000 }); } catch (e) { err = e; }
    const fired = calls.slice(before);
    ok(err && err.code === 'RATE_LIMITED', `a quote prepared for a superseded close is refused like any other stale read during cooldown (got ${err && err.code})`);
    ok(!fired.some((c) => c.method === 'PUT'), 'and nothing is submitted on the superseded quote');
  }

  // ---- 3. Belts and response fields still hold on the prepared path. ------------------------------
  {
    const handler = (url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc('Q1', 40000)]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true, bid_closing_in: 471 } });
      return resp(404, {});
    };
    const { adapter, calls } = rig({ handler, minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
    await adapter.login();
    await adapter.getAuctionState(KEY);
    if (adapter._pendingPrepare) await adapter._pendingPrepare;

    // 3a. the floor belt still throws before any PUT, even with a usable prepared quote in hand.
    const beforeFloor = calls.length;
    let floorErr = null;
    try { await adapter.placeBid(KEY, 100, { floor: 10000 }); } catch (e) { floorErr = e; }
    const firedFloor = calls.slice(beforeFloor);
    ok(floorErr && floorErr.code === 'FLOOR' && floorErr.placed === false,
      `a sub-floor amount is refused before any PUT, prepared quote or not (got ${floorErr && floorErr.code}, placed=${floorErr && floorErr.placed})`);
    ok(!firedFloor.some((c) => c.method === 'PUT'), 'and no PUT reaches the wire');

    // 3b. a valid prepared bid still carries INR, bidClosingInMs and canSubmitAgain.
    const r = await adapter.placeBid(KEY, 40000, { floor: 10000 });
    const put = calls.filter((c) => c.method === 'PUT').pop();
    ok(r.accepted === true, 'the prepared bid is accepted');
    ok(r.bidClosingInMs === 471000, `bid_closing_in still rides the response on the prepared path (got ${r.bidClosingInMs})`);
    ok(r.canSubmitAgain === true, `can_submit_quote still rides the response on the prepared path (got ${r.canSubmitAgain})`);
  }

  assert.strictEqual(fail, 0, `${fail} T2b prepared-stale-falls-back checks failed`);
  const MIN_EXPECTED_CHECKS = 8;
  assert.ok(pass >= MIN_EXPECTED_CHECKS, `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
