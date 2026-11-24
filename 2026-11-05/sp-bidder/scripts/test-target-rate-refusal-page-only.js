'use strict';
/**
 * A customer target-rate answer that Bid Command itself refuses is told on the price page only (owner
 * ruling 26 Sep: price page errors are responsible for Bid Command's own rejections, WhatsApp does
 * not repeat them).
 *
 * The refusals decided here, on the desk's own number, before anything reaches the portal: the rate
 * is below cost, below the lowest price we accept, not below our standing quote, spans several
 * vehicle types, or arrived after the offer lapsed. The page's "Not sent" states each of them.
 *
 * What still goes to WhatsApp: the sent receipt, the portal's own refusal, and the send failures
 * (sending switched off, a failed or unconfirmed submit), which are not verdicts on the desk's number.
 *
 * @requires-summary-line
 *
 *   node scripts/test-target-rate-refusal-page-only.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
delete process.env.GC_TARGET_PRICE;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-page-only-'));

const http = require('http');
const config = require('../src/config');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');

const EXPECTED = 10;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL - ' + m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
function quoteAt(price) {
  return { id: 'Q1', charges_list: { '11_freight_charges': { display_name: 'Freight Charges',
    freight_charges_custom_charge_40fthb: { units: 1, price, unit_name: 'TRUCK', currency: 'INR', taxable: '1', tax_id: '0',
      include_in_rank: true, is_custom_field: false, split_charge: false } } },
  total_charges: { total: { units: 1, quote_units: 1, unit_name: 'TRUCK', total: 0, currency: 'INR' } } };
}
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
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

(async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quoteAt(110000)]);
    if (init.method === 'PUT' && String(url).includes('/submit')) return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
    return resp(404, {});
  };
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, fetchImpl, sleep: async () => {} });
  await gc.login();

  const srv = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const sent = [];
  srv.notifier.alert = async (kind, data) => { sent.push({ kind, data }); return true; };
  const stack = { platformKey: 'gocomet', account: { accountId: 'primary' }, tag: null, adapter: gc, engine: new BidEngine(gc, {}, {}), discovery: null };
  srv.stacks.push(stack);
  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const LOAD = { lane: { origin: 'Bhuj', destination: 'Chennai' }, equipment: '40FTHB', units: 1,
    companyName: 'Waaree Energies Ltd.', closesAt: Date.now() - 45 * 60_000, rules: {} };
  const ask = (id, over) => srv.requests.createForTargetPrice({ ...LOAD, id }, Object.assign({ targetPricePerUnit: 107000,
    standingPricePerUnit: 110000, targetDeadlineMs: Date.now() + 14 * 60_000, negotiationRound: 'r1',
    chargeLineCount: 1, platformKey: 'gocomet' }, over || {}));
  const rows = { use_override: '1', m_0: '12', m_1: '9', m_2: '8' };
  const outcomeWa = (id) => sent.filter((s) => s.data && s.data.targetDone && s.data.loadId === id);
  const answer = async (id, cost, over, extra) => {
    const t = await ask(id, over);
    const res = await request('POST', `${base}/price/${publicSeg(t)}`, { ...rows, cost: String(cost), ...(extra || {}) });
    return { text: visible(res.text), wa: outcomeWa(id), settled: (await srv.requests.getByToken(t.id)) };
  };

  config.gocomet.targetPriceEnabled = true;
  try {
    console.log('\n1. Bid Command refuses the desk\'s number: the page says so, WhatsApp does not');
    {
      const r = await answer('TGT-COST', 110000, null, { ceiling_ack: '1' });
      ok(/Not sent/.test(r.text) && /below what this load costs us/.test(r.text), 'below cost, pushed past the max-bid warning: the page says Not sent, and why');
      ok(r.wa.length === 0, `and no outcome message goes to WhatsApp (sent ${r.wa.length})`);
    }
    {
      const r = await answer('TGT-QUOTE', 100000, { standingPricePerUnit: 105000 });
      ok(/Not sent/.test(r.text) && /nothing to send/.test(r.text), 'our quote already under theirs: the page says Not sent, and why');
      ok(r.wa.length === 0, `and no outcome message goes to WhatsApp (sent ${r.wa.length})`);
    }
    {
      const r = await answer('TGT-LINES', 100000, { chargeLineCount: 2 });
      ok(/Not sent/.test(r.text) && /vehicle types/.test(r.text), 'several vehicle types: the page says Not sent, and why');
      ok(r.wa.length === 0, `and no outcome message goes to WhatsApp (sent ${r.wa.length})`);
    }

    console.log('\n2. what still sends');
    {
      const r = await answer('TGT-SENT', 100000);
      ok(/Sent at the customer rate/.test(r.text), 'a rate we can meet is sent');
      ok(r.wa.length === 1 && r.wa[0].data.targetSubmitted === true, `and its receipt still goes out (sent ${r.wa.length})`);
    }
    {
      stack.adapter = { placeBid: async () => ({ accepted: false, rejectReason: 'quote window closed' }) };
      const r = await answer('TGT-PORTAL', 100000);
      stack.adapter = gc;
      ok(/The portal refused it/.test(r.text), 'the portal refusing it is shown on the page');
      ok(r.wa.length === 1 && r.wa[0].data.targetReason === 'rejected', `and still goes to WhatsApp - it is the portal's refusal, not ours (sent ${r.wa.length})`);
    }
  } finally {
    server.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail || pass !== EXPECTED) {
    console.log(`FAIL - ${fail} failed, ${pass} passed, expected ${EXPECTED}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
