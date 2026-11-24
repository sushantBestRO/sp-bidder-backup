'use strict';
/**
 * The target-rate answer path: the rollback switch, a second submit while the first is on the wire,
 * and the refused-outcome sentence.
 *
 * K-2: GC_TARGET_PRICE is the rollback lever for this feature, but it gated only the watch. An ask
 * raised while it was on still went to GoComet after it was switched off and the box restarted. With
 * the switch off nothing goes on the wire, and the page says so and says to accept on the portal by hand.
 *
 * K-3: capture() moves the ask to 'armed' before the single bid is sent, so a second desk POST inside
 * that window took the auction re-price path: setBidOverride wrote the target record's cost and band,
 * arming refused it, and the desk got a 500 carrying raw engine text inviting a retry. A target ask
 * never takes the re-price path: the second POST is refused in plain words and writes nothing.
 *
 * K-6: the refused outcome read "The portal refused it: The portal refused it (<reason>)." One sentence.
 *
 *   node scripts/test-gc-target-price-answer-guards.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
delete process.env.GC_TARGET_PRICE;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-target-answer-'));

const http = require('http');
const config = require('../src/config');
const { renderMessage } = require('../src/notify/waTemplates');
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
const ascii = (t) => String(t).replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim();
const RAW = /TARGET_RATE_NOT_ARMABLE|arming the auction engine|re-arm|cannot be armed|write_disabled|backstop|GC_TARGET_PRICE/i;

(async () => {
  const calls = [];
  let gate = null;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quoteAt(110000)]);
    if (init.method === 'PUT' && String(url).includes('/submit')) {
      if (gate) await gate.promise;
      return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
    }
    return resp(404, {});
  };
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, fetchImpl, sleep: async () => {} });
  await gc.login();
  const puts = () => calls.filter((c) => c.method === 'PUT').length;

  const srv = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const sent = [];
  srv.notifier.alert = async (kind, data) => { sent.push({ kind, data }); };
  const stack = { platformKey: 'gocomet', account: { accountId: 'primary' }, tag: null, adapter: gc, engine: new BidEngine(gc, {}, {}), discovery: null };
  srv.stacks.push(stack);
  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const LOAD = { lane: { origin: 'Bhuj', destination: 'Chennai' }, equipment: '40FTHB', units: 1,
    companyName: 'Waaree Energies Ltd.', closesAt: Date.now() - 45 * 60_000, rules: {} };
  const ask = (id) => srv.requests.createForTargetPrice({ ...LOAD, id }, { targetPricePerUnit: 107000,
    standingPricePerUnit: 110000, targetDeadlineMs: Date.now() + 14 * 60_000, negotiationRound: 'r1',
    chargeLineCount: 1, platformKey: 'gocomet' });
  const rows = { cost: '100000', use_override: '1', m_0: '12', m_1: '9', m_2: '8' };

  try {
    // ---- K-2: the switch is off, so an open ask sends nothing ----
    if (config.gocomet.targetPriceEnabled !== false) throw new Error('setup: GC_TARGET_PRICE must be off here');
    {
      const t = await ask('GCOFF1');
      const page = await request('GET', `${base}/price/${publicSeg(t)}`);
      const pageText = visible(page.text);
      ok(/sending target rates is switched off/i.test(pageText) && /Rs 1,07,000/.test(pageText) && /by hand/i.test(pageText),
        `the ask page says sending target rates is switched off, names Rs 1,07,000 and says to accept by hand`);
      const before = puts();
      const res = await request('POST', `${base}/price/${publicSeg(t)}`, rows);
      const text = visible(res.text);
      ok(puts() === before, `nothing goes on the wire (PUTs added ${puts() - before})`);
      ok(/Not sent/.test(text) && /sending target rates is switched off/i.test(text) && /Rs 1,07,000/.test(text)
        && /by hand/i.test(text) && !RAW.test(text),
        `the outcome page says so plainly and says to accept Rs 1,07,000 on the portal by hand (got "${text.slice(-320)}")`);
      const msg = sent.find((s) => s.data && s.data.targetDone && s.data.loadId === 'GCOFF1');
      const wa = msg ? renderMessage('price_target_done', msg.data) : '';
      ok(/sending target rates is switched off/i.test(wa) && /by hand/i.test(wa) && !RAW.test(wa),
        `the WhatsApp outcome says the same (got "${ascii(wa)}")`);
    }

    config.gocomet.targetPriceEnabled = true;

    // ---- K-3: a second POST while the first answer is on the wire ----
    {
      const t = await ask('GCDBL1');
      const d = {}; d.promise = new Promise((r) => { d.release = r; }); gate = d;
      const before = puts();
      const first = request('POST', `${base}/price/${publicSeg(t)}`, rows);
      for (let i = 0; i < 200 && puts() === before; i++) await new Promise((r) => setTimeout(r, 5));
      if (puts() !== before + 1) throw new Error('setup: the first answer never reached the wire');
      const mid = await srv.requests.getByToken(t.id);
      const second = await request('POST', `${base}/price/${publicSeg(t)}`, { ...rows, cost: '99000' });
      const after = await srv.requests.getByToken(t.id);
      d.release(); gate = null;
      const r1 = await first;
      const text2 = visible(second.text);
      ok(second.status !== 500 && !RAW.test(text2) && /already/i.test(text2) && /Rs 1,07,000/.test(text2),
        `the second submit is refused in plain words, never a 500 with engine text (status ${second.status}: "${text2.slice(-300)}")`);
      ok(JSON.stringify(after.price) === JSON.stringify(mid.price) && JSON.stringify(after.marginsPct) === JSON.stringify(mid.marginsPct)
        && after.status === mid.status,
        `and writes nothing: cost ${after.price && after.price.cost}, band ${JSON.stringify(after.marginsPct)} as the first submit left them`);
      ok(/Sent at the customer rate/.test(r1.text) && puts() === before + 1,
        `the first answer completes and exactly one write went out (PUTs ${puts() - before})`);
    }

    // ---- K-6: the refused outcome is one sentence ----
    {
      stack.adapter = { placeBid: async () => ({ accepted: false, rejectReason: 'quote window closed' }) };
      const t = await ask('GCREJ1');
      const res = await request('POST', `${base}/price/${publicSeg(t)}`, rows);
      const text = visible(res.text);
      const count = (text.match(/portal refused it/gi) || []).length;
      ok(count === 1 && /The portal refused it \(quote window closed\)\. Enter it on the portal by hand/.test(text),
        `the page says it once: "The portal refused it (quote window closed). Enter it on the portal by hand ..." (got ${count}: "${text.slice(-260)}")`);
      stack.adapter = gc;
    }
  } finally {
    server.close();
  }

  const EXPECTED = 8;
  console.log(`\n${n - fail}/${n} checks passed`);
  if (n !== EXPECTED) { console.log(`FAIL - expected ${EXPECTED} checks to run, got ${n}`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
