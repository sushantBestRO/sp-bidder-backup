'use strict';
/**
 * THE FINAL-WINDOW HELPERS SAY WHEN THEY FAIL.
 *
 * Review of 9b2dd20 (non-blocking 4): three new paths swallowed their failures without a trace.
 *   1. a GoComet shot inside the decisive horizon with no usable prepared quote (so it goes GET, GET,
 *      PUT) logs a warn naming the enquiry.
 *   2. a failed pre-buzzer quote refresh logs a warn naming the enquiry.
 *   3. a failed socket re-read while following our own bid on SuperProcure logs a warn naming the load.
 *   4. control: a shot on a fresh prepared quote logs no such warn.
 *
 *   node scripts/test-final-window-failures-logged.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const FREIGHT = 'freight_charges_custom_charge_40ft';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const quote = (price) => ({ id: 'Q1', charges_list: { '11_freight_charges': { [FREIGHT]: { units: 1, unit_name: 'TRUCK', price } } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: price } } });
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function recorder() {
  const warns = [];
  return { warns, log: { debug() {}, info() {}, error() {}, warn: (msg, meta) => warns.push({ msg, meta: meta || {} }) } };
}

function gcAdapter({ quotesStatus = 200 } = {}) {
  let t = 5_000_000_000_000;
  const rec = recorder();
  const fetchImpl = async (url, init) => {
    if (init.method === 'PUT') return resp(200, { data: { ...quote(40000), quote_rank: 1, can_submit_quote: true, bid_closing_in: 3 } });
    if (url.includes('/quotes')) return quotesStatus === 200 ? resp(200, [quote(42000)]) : resp(quotesStatus, { error: 'x' });
    return resp(404, {});
  };
  const token = `${b64({ alg: 'ES256' })}.${b64({ exp: Math.floor(t / 1000) + 86400, user_id: 'u1' })}.sig`;
  const a = new GoCometAdapter({ token, bidEnabled: true, fetchImpl, sleep: async (ms) => { t += ms; }, now: () => t, log: rec.log });
  a._lastCloseAt.set('ENQ1', { at: t, closeAt: t + 5_000 });
  return { a, warns: rec.warns };
}

const named = (warns, key) => warns.filter((w) => JSON.stringify(w.meta).includes(key));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  await check('1. a cold final-window GoComet shot logs a warn naming the enquiry', async () => {
    const { a, warns } = gcAdapter();
    await a.login();
    const r = await a.placeBid('ENQ1', 40000, { floor: 10000 });
    assert.ok(r.accepted, 'HARNESS: the bid was not accepted');
    assert.ok(named(warns, 'ENQ1').length >= 1, `no warn naming ENQ1 (${JSON.stringify(warns.map((w) => w.msg))})`);
  });

  await check('2. a failed quote refresh logs a warn naming the enquiry', async () => {
    const { a, warns } = gcAdapter({ quotesStatus: 500 });
    await a.login();
    await a._refreshPreparedQuote('ENQ1');
    assert.ok(named(warns, 'ENQ1').some((w) => /refresh/i.test(w.msg)), `no refresh warn naming ENQ1 (${JSON.stringify(warns.map((w) => w.msg))})`);
  });

  await check('3. a failed socket re-read while following our bid logs a warn naming the load', async () => {
    const rec = recorder();
    const file = path.join(os.tmpdir(), `follow-fail-${process.pid}.json`);
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => { throw new Error('socket cache gone'); },
      placeBid: async () => ({ accepted: true, myRank: null, latencyMs: 20 }),
    };
    const engine = new BidEngine(adapter, new DurableScheduler(file), { log: rec.log, onEvent: () => {} });
    const m = engine.arm({ id: 'SP777', lane: { origin: 'A', destination: 'B' }, equipment: '32ft', units: 1, companyName: 'Tata Steel',
      closesAt: Date.now() + 3_600_000, status: 'live' }, { cost: 50_000, marginsPct: [9, 5, 1] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    m._lastOkState = { ok: true, pushFed: true };
    m._pendingRankStamp = { decidedAt: Date.now(), price: 54500 };
    engine._followOwnBid(m);
    await new Promise((r) => setTimeout(r, 150));
    engine.kill('done');
    try { fs.unlinkSync(file); } catch (_) {}
    assert.ok(named(rec.warns, 'SP777').length >= 1, `no warn naming SP777 (${JSON.stringify(rec.warns.map((w) => w.msg))})`);
  });

  await check('4. control: a shot on a fresh prepared quote logs no cold-shot warn', async () => {
    const { a, warns } = gcAdapter();
    await a.login();
    a._cachePreparedQuote('ENQ1', quote(42000));
    await a.placeBid('ENQ1', 40000, { floor: 10000 });
    assert.deepStrictEqual(named(warns, 'ENQ1').map((w) => w.msg), []);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-final-window-failures-logged:', e && e.stack); process.exit(1); });
