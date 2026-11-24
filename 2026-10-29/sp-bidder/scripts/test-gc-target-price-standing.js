'use strict';
/**
 * A target at or above our standing quote is refused before it reaches GoComet (owner default OD-5).
 *
 * The portal rejects a quote that does not come down ("You have increased the quote price"), so
 * sending one spends a round trip on a number that cannot land and reports a portal refusal the desk
 * could have been told about up front. Both numbers are known when the ask is raised, so the page
 * says it plainly (price-page gate bucket 1) and nothing goes on the wire.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
process.env.GC_TARGET_PRICE = '1';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-target-standing-'));

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

async function gcAdapter(standing) {
  const calls = [];
  const quote = {
    id: 'Q1',
    charges_list: { '11_freight_charges': { display_name: 'Freight Charges',
      freight_charges_custom_charge_40fthb: { units: 1, price: standing, unit_name: 'TRUCK', currency: 'INR', taxable: '1',
        tax_id: '0', include_in_rank: true, is_custom_field: false, split_charge: false } } },
    total_charges: { total: { units: 1, quote_units: 1, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quote]);
    if (init.method === 'PUT' && String(url).includes('/submit')) return resp(422, { error: 'You have increased the quote price' });
    return resp(404, { error: 'no_route' });
  };
  const a = new GoCometAdapter({ token: token(), bidEnabled: true, fetchImpl, sleep: async () => {} });
  await a.login();
  return { a, calls };
}
const puts = (calls) => calls.filter((c) => c.method === 'PUT').length;

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

const BAND = { marginsPct: [12, 9, 6], minMarginPct: 6 };

(async () => {
  // ---- the decision ----
  const above = decideTargetPrice({ targetPricePerUnit: 98000, standingPricePerUnit: 97000, cost: 80000, ...BAND });
  ok(above.action === 'refuse' && above.reason === 'not_below_quote' && above.price == null,
    `a target above our standing quote is refused with nothing to send (got ${above.action} ${above.reason})`);
  const equal = decideTargetPrice({ targetPricePerUnit: 97000, standingPricePerUnit: 97000, cost: 80000, ...BAND });
  ok(equal.action === 'refuse' && equal.reason === 'not_below_quote',
    `a target equal to our standing quote is refused (got ${equal.action} ${equal.reason})`);
  const rounds = decideTargetPrice({ targetPricePerUnit: 97000.6, standingPricePerUnit: 97000, cost: 80000, ...BAND });
  ok(rounds.action === 'refuse' && rounds.reason === 'not_below_quote',
    `a target whose sent amount (rounded down) equals our quote is refused (got ${rounds.action} ${rounds.reason})`);
  const below = decideTargetPrice({ targetPricePerUnit: 96000, standingPricePerUnit: 97000, cost: 80000, ...BAND });
  ok(below.action === 'bid' && below.price === 96000, `a target under our quote is still met (got ${below.action} ${below.price})`);
  const unknown = decideTargetPrice({ targetPricePerUnit: 98000, cost: 80000, ...BAND });
  ok(unknown.action === 'bid', `with no standing quote read, the decision is unchanged (got ${unknown.action})`);

  // ---- the write ----
  {
    const { a, calls } = await gcAdapter(97000);
    const out = await submitTargetRate({ adapter: a, cost: 80000, ...BAND,
      request: { loadId: 'GCS1', targetPricePerUnit: 98000, standingPricePerUnit: 97000, chargeLineCount: 1,
        targetDeadlineMs: Date.now() + 600000 } });
    ok(out.submitted === false && out.reason === 'not_below_quote' && puts(calls) === 0,
      `nothing goes to the portal for a target at or above our quote (reason ${out.reason}, PUTs ${puts(calls)})`);
  }

  // ---- the desk page ----
  const srv = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const { a, calls } = await gcAdapter(97000);
  srv.stacks.push({ platformKey: 'gocomet', account: { accountId: 'primary' }, tag: null, adapter: a,
    engine: new BidEngine(a, {}, {}), discovery: null });
  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const LOAD = { lane: { origin: 'Bhuj', destination: 'Chennai' }, equipment: '40FTHB', units: 1,
      companyName: 'Waaree Energies Ltd.', closesAt: Date.now() - 45 * 60_000, rules: {} };
    const ask = (id, target, standing) => srv.requests.createForTargetPrice({ ...LOAD, id }, {
      targetPricePerUnit: target, standingPricePerUnit: standing, targetDeadlineMs: Date.now() + 14 * 60_000,
      negotiationRound: 'r1', chargeLineCount: 1, platformKey: 'gocomet' });

    const high = await ask('GCS2', 98000, 97000);
    const page = await request('GET', `${base}/price/${publicSeg(high)}`);
    ok(/nothing to send/i.test(page.text) && page.text.includes('97,000') && page.text.includes('98,000'),
      'the ask page says up front that our Rs 97,000 already meets their Rs 98,000 and there is nothing to send');
    ok(!/Customer wants a lower rate/i.test(page.text), 'and does not call their higher rate a lower one');

    const res = await request('POST', `${base}/price/${publicSeg(high)}`,
      { cost: '80000', use_override: '1', m_0: '12', m_1: '9', m_2: '8' });
    ok(/Not sent/.test(res.text) && /nothing to send/i.test(res.text) && res.text.includes('97,000'),
      'a submit on it lands on a plain refusal naming our quote');
    ok(puts(calls) === 0, `and nothing reached the portal (PUTs ${puts(calls)})`);

    const normal = await ask('GCS3', 95000, 97000);
    const npage = await request('GET', `${base}/price/${publicSeg(normal)}`);
    ok(/Customer wants a lower rate/i.test(npage.text) && !/nothing to send/i.test(npage.text),
      'an ordinary lower target keeps its heading and carries no such line');
  } finally {
    server.close();
  }

  console.log(`\n${n - fail}/${n} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
