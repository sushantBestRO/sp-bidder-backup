'use strict';
/**
 * STOP ENDS A HOLD, AND A RATE SENT TO A STOPPED LOAD IS REFUSED OUT LOUD.
 *
 * Regression target: T3 D2 (R2-2).
 *
 * "That rate is wrong" (an upward correction on the price link, which holds the load) followed by
 * the console's Stop left a record that was held AND stopped. The hold panel and its Resume button
 * are drawn only on the re-price page, which a stopped load never reaches, and the next rate the
 * desk typed was answered 200 with a "Bidding paused" page while the number was thrown away.
 *
 *   node scripts/test-stop-retires-hold.js
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
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stop-hold-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 10;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const visible = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

const COST = 29_000;
const STANDING = 31_610;
const NEW_COST = 38_000;
const RETYPED = 41_000;
const BAND = { m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' };

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`, { body: form(body), contentType: 'application/x-www-form-urlencoded' });

  const heldThenStopped = async (loadId) => {
    const now = Date.now();
    const r = await requests.createForLoad({
      id: loadId, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
      softClose: false, closeModelKnown: true, status: 'live',
    });
    if ((await priceForm(r.id, { cost: String(COST) })).status !== 200) throw new Error(`setup: ${loadId} did not arm`);
    const m = liveMonitor(loadId);
    if (!m) throw new Error(`setup: no monitor for ${loadId}`);
    m.lastBidPrice = STANDING; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) {
        s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await priceForm(r.id, Object.assign({ cost: String(NEW_COST) }, BAND));
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status})`);
    if (!(await requests.getByToken(r.id)).hold) throw new Error(`setup: ${loadId} is not held`);
    const stopped = await req('POST', `${base}/api/auctions/${loadId}/stop`, { body: '{}', origin: base });
    if (stopped.status !== 200) throw new Error(`setup: stop refused (HTTP ${stopped.status})`);
    return r;
  };

  console.log('\n1. Stop on a held load ends the hold and keeps the record of it');
  {
    const r = await heldThenStopped('STH-1');
    const doc = await requests.getByToken(r.id);
    ok(doc.status === 'stopped', 'the load is stopped');
    ok(!doc.hold, `and no longer held - a record cannot be both (hold=${JSON.stringify(doc.hold && doc.hold.kind)})`);
    ok(Array.isArray(doc.holdHistory) && doc.holdHistory.length === 1 && doc.holdHistory[0].correctedCost === NEW_COST,
      'the hold that ended is kept in the hold history, with the correction it recorded');
    ok(!liveMonitor('STH-1'), 'and nothing is bidding it');
  }

  console.log('\n2. a rate typed on the price link after Stop is refused, not thrown away behind a 200');
  {
    const r = await heldThenStopped('STH-2');
    const html = await priceForm(r.id, Object.assign({ cost: String(RETYPED) }, BAND));
    ok(html.status === 409, `the HTML submit is refused (got ${html.status})`);
    ok(/Rs 41,000/.test(visible(html.text)) && /not saved/i.test(visible(html.text)),
      'the page names the figure and says it was not saved');
    const json = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify(Object.assign({ cost: RETYPED }, BAND)) });
    ok(json.status === 409 && !!json.json && /Rs 41,000/.test(json.json.error || '') && /not saved/i.test(json.json.error || ''),
      `the JSON submit is refused in the same words (got ${json.status} "${json.json && json.json.error}")`);
    ok(!!json.json && /stopped/i.test(json.json.error || '') && !/status=/.test(json.json.error || ''),
      'naming the state plainly, not as a status code');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === NEW_COST && after.status === 'stopped', 'the stored cost and the stop are unchanged');
    ok(!liveMonitor('STH-2'), 'and nothing was armed by the refused submit');
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
