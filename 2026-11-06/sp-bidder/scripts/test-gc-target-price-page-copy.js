'use strict';
/**
 * What the desk reads on a target-rate ask when the answer cannot be sent from here.
 *
 * A target is one quote on a deadline. "Your price is kept and will be used when this portal goes
 * live" is the auction copy, and for a target it is false: nothing is kept for later, the offer
 * lapses. And a failed send must not print the internal error ("... cannot be armed") at the desk.
 * Both say, figures first, what stands and what to do: accept their rate on the portal by hand
 * before their deadline.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
process.env.GC_TARGET_PRICE = '1';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-target-copy-'));

const http = require('http');
const { renderMessage } = require('../src/notify/waTemplates');

let n = 0, fail = 0;
const ok = (c, m) => { n += 1; if (c) console.log(`  ok  ${n}. ${m}`); else { fail += 1; console.log(`FAIL ${n}. ${m}`); } };

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
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
const ascii = (t) => String(t).replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim();
const RAW = /cannot be armed|not running on this box|network error|write_disabled|GC_BID|backstop/i;

(async () => {
  const srv = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const sent = [];
  srv.notifier.alert = async (kind, data) => { sent.push({ kind, data }); };
  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const LOAD = { lane: { origin: 'Bhuj', destination: 'Chennai' }, equipment: '40FTHB', units: 1,
      companyName: 'Waaree Energies Ltd.', closesAt: Date.now() - 45 * 60_000, rules: {} };
    const ask = (id) => srv.requests.createForTargetPrice({ ...LOAD, id }, {
      targetPricePerUnit: 98000, standingPricePerUnit: 102695, targetDeadlineMs: Date.now() + 14 * 60_000,
      negotiationRound: 'r1', chargeLineCount: 1, platformKey: 'gocomet' });
    const rows = { cost: '80000', use_override: '1', m_0: '12', m_1: '9', m_2: '8' };

    // ---- sending is off on this portal (no GoComet stack running) ----
    const off = await ask('GCC1');
    const page = await request('GET', `${base}/price/${publicSeg(off)}`);
    ok(!/goes live/i.test(page.text), 'the ask page never promises the price is kept for when the portal goes live');
    const block = (page.text.match(/<div class="snote bad" id="wontBid">([\s\S]*?)<\/div><\/div>/) || [])[1] || '';
    ok(/Rs 98,000/.test(block) && /by hand/i.test(block),
      `the notice leads with their Rs 98,000 and says to accept it on the portal by hand (got "${visible(block).trim()}")`);

    const res = await request('POST', `${base}/price/${publicSeg(off)}`, rows);
    const text = visible(res.text);
    ok(/Not sent/.test(text) && !RAW.test(text), `the outcome page carries no internal error text (got "${text.slice(0, 400)}")`);
    ok(/switched off/i.test(text) && /Rs 98,000/.test(text) && /by hand/i.test(text),
      'it says sending is switched off and to accept Rs 98,000 on the portal by hand');
    const offMsg = sent.find((s) => s.data && s.data.targetDone && s.data.loadId === 'GCC1');
    const offWa = offMsg ? renderMessage('price_target_done', offMsg.data) : '';
    ok(/switched off/i.test(offWa) && !RAW.test(offWa), `the WhatsApp outcome says the same (got "${ascii(offWa)}")`);

    // ---- a send that failed on the way out: we cannot say it did not land ----
    srv.stacks.push({ platformKey: 'gocomet', account: { accountId: 'primary' }, tag: null, engine: null, discovery: null,
      adapter: { placeBid: async () => { const e = new Error('gocomet: bid network error'); e.code = 'NETWORK'; throw e; } } });
    const lost = await ask('GCC2');
    const res2 = await request('POST', `${base}/price/${publicSeg(lost)}`, rows);
    const text2 = visible(res2.text);
    ok(!RAW.test(text2), `a failed send shows no internal error text (got "${text2.slice(0, 400)}")`);
    ok(/could not confirm/i.test(text2) && !/did not quote|Not sent/i.test(text2),
      'and does not claim nothing went out - it says the send could not be confirmed');
    ok(/Rs 98,000/.test(text2) && /by hand/i.test(text2), 'it names Rs 98,000 and says to check the portal and accept it by hand');
    const lostMsg = sent.find((s) => s.data && s.data.targetDone && s.data.loadId === 'GCC2');
    const lostWa = lostMsg ? renderMessage('price_target_done', lostMsg.data) : '';
    ok(/could not confirm/i.test(lostWa) && !/did not accept/i.test(lostWa), `the WhatsApp outcome says the same (got "${ascii(lostWa)}")`);
  } finally {
    server.close();
  }

  console.log(`\n${n - fail}/${n} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
