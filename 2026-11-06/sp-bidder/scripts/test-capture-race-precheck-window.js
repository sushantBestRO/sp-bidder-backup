'use strict';
/**
 * A CAPTURE THAT LOSES THE RACE AFTER THE ROUTE'S OWN OPEN CHECK IS STILL AN ERROR ON THE SCREEN.
 *
 * Regression target: A009, second race window. The /price route reads the request and checks it is
 * open, then awaits the live config, the customer minimum and the below-minimum check before it
 * calls capture(). Another capture that arms the load inside that window made capture() throw a
 * plain NOT_OPEN, which the route answered by rendering the load's current page with HTTP 200 - the
 * desk's number vanished with nothing said - and a JSON caller got a 409 without the owner's words.
 *
 * Deterministic: the first capture is held at a gate inside capture() until the second request has
 * completed; no timers.
 *
 *   node scripts/test-capture-race-precheck-window.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-capture-precheck-'));

const http = require('http');
const { app, requests, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const WORDS = 'Not saved: another price was saved for this load just now. Reload to see it.';

function post(base, url, { json, form }) {
  const body = json ? JSON.stringify(json) : Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const type = json ? 'application/json' : 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } },
    (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });
const shownText = (res, as) => (as === 'json' ? ((res.json && res.json.error) || '') : res.text.replace(/&#39;/g, "'"));

// Holds the first capture() at its entry until `interleave` has run to completion.
async function holdFirstCapture(first, interleave) {
  const real = requests.capture;
  let reached, release;
  const atGate = new Promise((r) => { reached = r; });
  const gate = new Promise((r) => { release = r; });
  requests.capture = async function (...a) { requests.capture = real; reached(); await gate; return real.apply(this, a); };
  const slow = first();
  await atGate;
  await interleave();
  release();
  return slow;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const as of ['form', 'json']) {
    console.log(`\n${as === 'form' ? 'the price page (form post)' : 'a JSON caller'}: another capture arms the load after the route's open check`);
    const r = await requests.createForLoad(load(`PRE-${as}`));
    let fast;
    const slow = await holdFirstCapture(
      () => post(base, `/price/${r.id}`, { [as]: { cost: '29000' } }),
      async () => { fast = await post(base, `/price/${r.id}`, { [as]: { cost: '41000' } }); });
    ok(fast.status === 200, `the other capture lands (HTTP ${fast.status})`);
    ok(slow.status === 409, `the late one is refused, not rendered as a page (HTTP ${slow.status})`);
    ok(shownText(slow, as).includes(WORDS), `with the owner's words on the screen (${as === 'json' ? shownText(slow, as) : (shownText(slow, as).includes(WORDS) ? 'found' : 'not in the page')})`);
  }

  for (const as of ['form', 'json']) {
    console.log(`\n${as === 'form' ? 'form post' : 'JSON'}: the load is stopped after the route's open check`);
    const r = await requests.createForLoad(load(`PRE-STOP-${as}`));
    const slow = await holdFirstCapture(
      () => post(base, `/price/${r.id}`, { [as]: { cost: '29000' } }),
      async () => { await store.patchDoc('priceRequests', r.id, { status: 'stopped' }); });
    ok(slow.status === 409 && /Not saved: this load is stopped\./.test(shownText(slow, as)),
      `an error naming the change, not a silent page (HTTP ${slow.status})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
