'use strict';
/**
 * A LOAD THE ENGINE WILL REFUSE OUTRIGHT IS REFUSED ON THE PRICE PAGE, NOT ARMED.
 *
 * Regression target: A057 review finding 7. The preview already says "No prices can go out" for a
 * load whose pricing mode the fail-closed gate refuses (per tonne while per-tonne bidding is off,
 * including a snapshot recorded as flat on a PMT rate). The capture and re-price submits still
 * accepted a cost for it and armed a monitor that refuses every rung - a failure knowable at submit,
 * which the price-page gate says is refused on the page.
 *
 *   node scripts/test-unsupported-rule-refused-at-submit.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_PMT_BID;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-unsupported-submit-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function call(base, method, url, obj) {
  const body = obj ? JSON.stringify(obj) : null;
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = {};
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json, text: b }); }); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
// Owner wording for the card body and the submit refusal.
const SENTENCE = /^We don't bid loads priced this way yet\. Quote it by hand on the portal\.$/;
const CARD = /We don&#39;t bid loads priced this way yet\. Quote it by hand on the portal\.|We don't bid loads priced this way yet\. Quote it by hand on the portal\./;
const load = (id, rules) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 22, quoteType: 'PMT',
  companyName: 'Vishal Pipes', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules });
const PMT = { pricingMode: 'per_tonne', rateType: 'PMT', unit: 'MT' };
const PMT_STALE = { pricingMode: 'flat', rateType: 'PMT', unit: 'MT' };
const live = (id) => { const m = stacks[0].engine.monitors.get(id); return !!(m && !m.finalized); };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [label, rules, id] of [['per tonne', PMT, 'UR-1'], ['a flat snapshot of a PMT rate', PMT_STALE, 'UR-2']]) {
    console.log(`\ncapture, ${label}, per-tonne bidding off`);
    const r = await requests.createForLoad(load(id, rules));
    const res = await call(base, 'POST', `/price/${r.id}`, { cost: '2240' });
    ok(res.status === 409 && SENTENCE.test((res.json && res.json.error) || ''),
      `refused with the preview's sentence (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(!live(id) && (await requests.getByToken(r.id)).status === 'awaiting_price', 'and nothing is armed or saved');
    const page = await call(base, 'GET', `/price/${r.id}`);
    ok(CARD.test(page.text.replace(/<script>[\s\S]*?<\/script>/g, '')), 'the page says so in its body before a cost is typed');
  }

  console.log('\nre-price of a per-tonne load armed while per-tonne bidding was on, after it went off');
  {
    const r = await requests.createForLoad(load('UR-3', PMT));
    process.env.SP_PMT_BID = '1';
    const cap = await call(base, 'POST', `/price/${r.id}`, { cost: '2240' });
    delete process.env.SP_PMT_BID;
    ok(cap.status === 200 && live('UR-3'), `setup: armed with per-tonne bidding on (HTTP ${cap.status})`);
    const res = await call(base, 'POST', `/price/${r.id}`, { cost: '2300', m_0: '9', m_1: '5', m_2: '1' });
    ok(res.status === 409 && SENTENCE.test((res.json && res.json.error) || ''),
      `the re-price is refused with the same sentence (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok((await requests.getByToken(r.id)).price.cost === 2240, 'and the record is untouched');
  }

  console.log('\nper-tonne bidding ON (the production setting): a per-tonne load is priced and armed normally');
  {
    process.env.SP_PMT_BID = '1';
    try {
      const r = await requests.createForLoad(load('UR-5', PMT));
      const page = await call(base, 'GET', `/price/${r.id}`);
      const body = page.text.replace(/<script>[\s\S]*?<\/script>/g, '');
      ok(!CARD.test(body) && !/We will not bid this load/.test(body), 'no will-not-bid card');
      ok(/id="cost"/.test(page.text) && /PER METRIC TONNE/i.test(body), 'the normal per-tonne cost form is drawn');
      const res = await call(base, 'POST', `/price/${r.id}`, { cost: '2240' });
      ok(res.status === 200 && live('UR-5'), `and a cost arms it (HTTP ${res.status}: ${res.json && res.json.error})`);
      const stale = await requests.createForLoad(load('UR-6', PMT_STALE));
      const res2 = await call(base, 'POST', `/price/${stale.id}`, { cost: '2240' });
      ok(res2.status === 200 && live('UR-6'), `a flat snapshot of a PMT rate arms too (HTTP ${res2.status})`);
    } finally { delete process.env.SP_PMT_BID; }
  }

  console.log('\nper-tonne bidding ON: every load the engine supported-rules check refuses is refused on the page');
  {
    process.env.SP_PMT_BID = '1';
    try {
      for (const [label, rules, id] of [
        ['a per-tonne load quoted in KG', { pricingMode: 'per_tonne', rateType: 'PMT', unit: 'KG' }, 'UR-7'],
        ['a per-tonne load whose unit was never recorded', { pricingMode: 'per_tonne', rateType: 'PMT' }, 'UR-8'],
        ['a per-tonne load carrying a shipper ceiling', { pricingMode: 'per_tonne', rateType: 'PMT', unit: 'MT', ceilingPrice: 3000 }, 'UR-9'],
        ['a load requiring a mechanic that is not built', { pricingMode: 'flat', rateType: 'FTL', requires: ['reverse_split'] }, 'UR-10'],
      ]) {
        const r = await requests.createForLoad(load(id, rules));
        const page = await call(base, 'GET', `/price/${r.id}`);
        ok(CARD.test(page.text.replace(/<script>[\s\S]*?<\/script>/g, '')) && !/id="cost"/.test(page.text),
          `${label}: the page shows the card and no cost field`);
        const res = await call(base, 'POST', `/price/${r.id}`, { cost: '2240', ceiling_ack: '1' });
        ok(res.status === 409 && SENTENCE.test((res.json && res.json.error) || '') && !live(id),
          `${label}: a submit is refused with the same sentence and nothing arms (HTTP ${res.status}: ${res.json && res.json.error})`);
      }
    } finally { delete process.env.SP_PMT_BID; }
  }

  console.log('\nthe in-page preview line for a stale tab uses the same wording');
  {
    const r = await requests.createForLoad(Object.assign(load('UR-11', { pricingMode: 'flat', rateType: 'FTL' }), { units: 1, quoteType: 'FTL' }));
    const page = await call(base, 'GET', `/price/${r.id}`);
    ok(page.text.includes("We don't bid loads priced this way yet. Quote it by hand on the portal.") && !/we do not bid loads priced this way/.test(page.text),
      'the preview script carries the owner sentence and not the old one');
  }

  console.log('\ncontrol: a flat load captures');
  {
    const r = await requests.createForLoad(Object.assign(load('UR-4', { pricingMode: 'flat', rateType: 'FTL' }), { units: 1, quoteType: 'FTL' }));
    const res = await call(base, 'POST', `/price/${r.id}`, { cost: '29000' });
    ok(res.status === 200 && live('UR-4'), `armed (HTTP ${res.status})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
