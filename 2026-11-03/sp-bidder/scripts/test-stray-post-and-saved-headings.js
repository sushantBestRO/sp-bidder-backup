'use strict';
/**
 * THREE PRICE-PAGE MESSAGES THAT MUST SAY WHAT HAPPENED.
 *
 *   1. A one-field form posted after the load is already armed (a stale tab, a back+resubmit) was
 *      answered with the load's page and HTTP 200: the typed cost was dropped and nothing said so.
 *      A different cost is now refused in words above the page; the same cost is not an error.
 *   2. Two "saved, but not bidding" messages rendered under "Could not save" / "Not saved". The
 *      heading and label follow the message.
 *   3. A capture lost to a status change showed the raw status value ("changed to
 *      skipped_no_price"). The desk reads plain words.
 *
 *   node scripts/test-stray-post-and-saved-headings.js
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
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stray-post-'));

const http = require('http');
const { app, requests, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, id, { json, form }) {
  const body = json ? JSON.stringify(json) : Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const type = json ? 'application/json' : 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}/price/${id}`, { method: 'POST', headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const shown = (res) => res.text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const heading = (res) => { const m = /<h1>([^<]*)<\/h1>/.exec(res.text); return m ? m[1] : null; };
const label = (res) => { const m = /<div class="enote"><div class="st">([^<]*)<\/div>/.exec(res.text); return m ? m[1] : null; };
let seq = 0;
const load = (over = {}) => ({ id: `SPH-${++seq}`, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', ...over });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. a one-field form posted to a load that is already armed');
  {
    const r = await requests.createForLoad(load());
    const armed = await post(base, r.id, { json: { cost: '20000' } });
    ok(armed.status === 200, `setup: armed at Rs 20,000 (HTTP ${armed.status})`);
    const WORDS = 'Rs 29,000 not saved: already priced at Rs 20,000. Use Re-price to change it.';
    const diff = await post(base, r.id, { form: { cost: '29000' } });
    ok(diff.status === 409 && shown(diff).includes(WORDS), `a different cost is refused in words (HTTP ${diff.status}): "${WORDS}"`);
    ok(/id="mainForm"/.test(diff.text) && diff.text.indexOf(WORDS.slice(0, 20)) >= 0 && diff.text.indexOf(WORDS.slice(0, 20)) < diff.text.indexOf('id="mainForm"'),
      'above the re-price form, which is still there to use');
    const same = await post(base, r.id, { form: { cost: '20000' } });
    ok(same.status === 200 && !/not saved/i.test(shown(same)) && /id="mainForm"/.test(same.text),
      `the same cost is not an error (HTTP ${same.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price && after.price.cost === 20000, `and nothing was changed (cost on record ${after.price && after.price.cost})`);
  }

  console.log('\n2. saved-but-not-bidding messages carry a heading that agrees with them');
  {
    // A GoComet request on a box running no GoComet stack: the cost is kept and nothing bids it.
    const r = await requests.createForLoad(load(), { platformKey: 'gocomet' });
    const cap = await post(base, r.id, { form: { cost: '20000' } });
    ok(/Your cost was saved, but/.test(shown(cap)), `setup: the capture keeps the cost (HTTP ${cap.status}: ${shown(cap).slice(0, 160)})`);
    ok(heading(cap) === 'Not bidding this load' && label(cap) === 'Not bidding',
      `capture: heading "${heading(cap)}", label "${label(cap)}" - not "Could not save" / "Not saved"`);

    const a = await requests.createForLoad(load(), { platformKey: 'gocomet' });
    await store.patchDoc('priceRequests', a.id, { status: 'armed', price: { cost: 20000, marginsPct: [9, 5, 1], minMarginPct: 1 }, capturedAt: Date.now() });
    const rp = await post(base, a.id, { form: { cost: '21000', m_0: '9', m_1: '5', m_2: '1', rows_shown: '9,5,1' } });
    ok(/Your new price was saved, but/.test(shown(rp)), `setup: the re-price keeps the price (HTTP ${rp.status}: ${shown(rp).slice(0, 160)})`);
    ok(heading(rp) === 'Not bidding this load' && label(rp) === 'Not bidding',
      `re-price: heading "${heading(rp)}", label "${label(rp)}" - not "Could not save" / "Not saved"`);
  }

  console.log('\n3. a capture lost to a status change names the status in plain words');
  for (const [status, words] of [['stopped', 'stopped'], ['closed', 'closed'], ['skipped_no_price', 'closed without a price'], ['expired', 'no longer open']]) {
    const r = await requests.createForLoad(load());
    await store.patchDoc('priceRequests', r.id, { status });
    let msg = null;
    try { await requests.capture(r.id, { cost: 20000 }); } catch (e) { msg = e.message; }
    ok(msg === `Not saved: this load is ${words}.`,
      `${status}: "${msg}"`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
