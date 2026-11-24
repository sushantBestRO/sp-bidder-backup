'use strict';
/**
 * A shipper target rate is judged against the minimum-margin guard, not the lowest band price
 * (owner default OD-4, consistent with ruling 30: a shipper number between the guard and the lowest
 * band price gets one bid at that number).
 *
 * Fixture: cost 1,00,000, band [10, 8, 6], minimum 4. Guard = max(cost, cost x 1.04) = 1,04,000;
 * lowest band price = 1,06,000. Targets 1,04,000 - 1,05,999 sit in the gap and must be sent.
 *
 * The write path is checked through the real GoComet adapter (fake transport), because the
 * decision's `floor` is what placeBid's belt asserts against: a decision that says "bid" while
 * handing the belt the lowest band price would be refused one layer down. The desk flow is checked
 * over HTTP on the real /price route with a GoComet stack registered.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
process.env.GC_TARGET_PRICE = '1';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-target-guard-'));

const http = require('http');
const { decideTargetPrice } = require('../src/gocomet/targetPriceDecision');
const { submitTargetRate } = require('../src/gocomet/targetPriceSubmit');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');

let n = 0, fail = 0;
const ok = (c, m) => { n += 1; if (c) console.log(`  ok  ${n}. ${m}`); else { fail += 1; console.log(`FAIL ${n}. ${m}`); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function quoteAt(price) {
  return {
    id: 'Q1',
    charges_list: { '11_freight_charges': { display_name: 'Freight Charges',
      freight_charges_custom_charge_40fthb: { units: 1, price, unit_name: 'TRUCK', currency: 'INR', taxable: '1',
        tax_id: '0', include_in_rank: true, is_custom_field: false, split_charge: false } } },
    total_charges: { total: { units: 1, quote_units: 1, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
  };
}
async function gcAdapter(standing) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quoteAt(standing)]);
    if (init.method === 'PUT' && String(url).includes('/submit')) return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
    return resp(404, { error: 'no_route' });
  };
  const a = new GoCometAdapter({ token: token(), bidEnabled: true, fetchImpl, sleep: async () => {} });
  await a.login();
  return { a, calls };
}
const sentPrices = (calls) => calls.filter((c) => c.method === 'PUT').map((c) => {
  const g = JSON.parse(c.body).quote.charges_list['11_freight_charges'];
  return g.freight_charges_custom_charge_40fthb.price;
});

function request(method, url, form) {
  const body = form ? new URLSearchParams(form).toString() : '';
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {} },
    (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    r.on('error', reject);
    r.end(body);
  });
}

const COST = 100000;
const BAND = { marginsPct: [10, 8, 6], minMarginPct: 4 };
const GUARD = 104000;

(async () => {
  // ---- the decision ----
  const at = decideTargetPrice({ targetPricePerUnit: GUARD, cost: COST, ...BAND });
  ok(at.action === 'bid' && at.price === GUARD, `a target exactly at the guard (Rs 1,04,000) is met (got ${at.action} ${at.reason || at.price})`);
  const top = decideTargetPrice({ targetPricePerUnit: 105999, cost: COST, ...BAND });
  ok(top.action === 'bid' && top.price === 105999, `a target one rupee under the lowest band price is met (got ${top.action} ${top.reason || top.price})`);
  ok(at.floor === GUARD && top.floor === GUARD,
    `the bound handed to the write path is the guard, 1,04,000 (got ${at.floor}, ${top.floor})`);
  const under = decideTargetPrice({ targetPricePerUnit: GUARD - 1, cost: COST, ...BAND });
  ok(under.action === 'refuse' && under.reason === 'below_floor' && under.floor === GUARD && under.shortfall === 1,
    `one rupee under the guard refuses, naming the guard and a Rs 1 gap (got ${under.reason} floor ${under.floor} shortfall ${under.shortfall})`);
  const loss = decideTargetPrice({ targetPricePerUnit: COST - 1, cost: COST, ...BAND });
  ok(loss.action === 'refuse' && loss.reason === 'below_cost' && loss.floor === GUARD,
    `under cost refuses as below_cost and names the guard as the least we accept (got ${loss.reason} floor ${loss.floor})`);

  // ---- the write: the real adapter's floor and ceiling belts must let a gap target through ----
  {
    const { a, calls } = await gcAdapter(110000);
    const out = await submitTargetRate({ adapter: a, cost: COST, ...BAND,
      request: { loadId: 'GCG1', targetPricePerUnit: 105000, chargeLineCount: 1, targetDeadlineMs: Date.now() + 600000 } });
    ok(out.submitted === true && JSON.stringify(sentPrices(calls)) === '[105000]',
      `a Rs 1,05,000 target goes out through the real adapter at 1,05,000 (submitted ${out.submitted} ${out.reason || ''}, sent ${JSON.stringify(sentPrices(calls))})`);
  }

  // ---- the capture-time preview and the submit agree ----
  {
    const eng = new BidEngine({ capabilities: () => ({ standingPriceVisible: false, minDecrement: 1, revisionLimit: 3, closeModel: 'unknown' }), writeEnabled: true }, {}, {});
    const verdicts = [GUARD - 1, GUARD, 105000, 105999, 106000].map((t) => {
      const pv = eng.planPreview({ id: 'X', rules: { ceilingPrice: t } }, { cost: COST, ...BAND });
      const d = decideTargetPrice({ targetPricePerUnit: t, cost: COST, ...BAND });
      return { t, preview: pv.willNotBid ? 'dead' : 'live', decision: d.action === 'bid' ? 'live' : 'dead' };
    });
    const split = verdicts.filter((v) => v.preview !== v.decision);
    ok(split.length === 0, `the price page's preview and the submit agree on every target (disagree on ${JSON.stringify(split)})`);
  }

  // ---- the desk flow over HTTP ----
  const srv = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const { a, calls } = await gcAdapter(110000);
  srv.stacks.push({ platformKey: 'gocomet', account: { accountId: 'primary' }, tag: null, adapter: a,
    engine: new BidEngine(a, {}, {}), discovery: null });
  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const LOAD = { lane: { origin: 'Bhuj', destination: 'Chennai' }, equipment: '40FTHB', units: 1,
      companyName: 'Waaree Energies Ltd.', closesAt: Date.now() - 45 * 60_000, rules: {} };
    // Rows [12, 9, 8] on this customer's 6.3% minimum: guard 1,06,300, lowest band price 1,08,000.
    const rows = { cost: '100000', use_override: '1', m_0: '12', m_1: '9', m_2: '8' };
    const ask = (id, target) => srv.requests.createForTargetPrice({ ...LOAD, id }, {
      targetPricePerUnit: target, standingPricePerUnit: 110000, targetDeadlineMs: Date.now() + 14 * 60_000,
      negotiationRound: 'r1', chargeLineCount: 1, platformKey: 'gocomet' });

    const gap = await ask('GCG2', 107000);
    const res = await request('POST', `${base}/price/${publicSeg(gap)}`, rows);
    ok(/Sent at the customer rate/.test(res.text) && JSON.stringify(sentPrices(calls)) === '[107000]',
      `a Rs 1,07,000 target between the guard and the lowest band price is sent from the desk page (page ${/Sent at the customer rate/.test(res.text) ? 'sent' : 'not sent'}, wire ${JSON.stringify(sentPrices(calls))})`);

    const low = await ask('GCG3', 106299);
    const wireBefore = sentPrices(calls).length;
    const res2 = await request('POST', `${base}/price/${publicSeg(low)}`, Object.assign({ ceiling_ack: '1' }, rows));
    ok(/Not sent/.test(res2.text) && res2.text.includes('1,06,300') && !res2.text.includes('1,08,000'),
      'a target under the guard is refused and the page names the guard figure, Rs 1,06,300, not the lowest band price');
    ok(sentPrices(calls).length === wireBefore, 'and nothing reached the wire for it');
  } finally {
    server.close();
  }

  console.log(`\n${n - fail}/${n} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
