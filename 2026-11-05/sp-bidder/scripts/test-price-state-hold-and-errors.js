'use strict';
/**
 * THE PRICE PAGE'S STATE POLL SEES A HOLD, AND ANSWERS A STORE FAULT INSTEAD OF HANGING.
 *
 * Regression targets:
 *   A039 - GET /price/:token/state served status, heldReason, closes, rank and last bid but nothing
 *          about a hold. A hold leaves status 'armed', so a second open form (another phone, another
 *          tab) compared against 'armed', saw no change, and kept a live countdown and an open submit
 *          on a load that is not being bid. The poll now carries the hold, and an open re-price form
 *          that sees it goes to the held page. Still no cost and no identity on the poll.
 *   A040 - the same route is an async handler with no try/catch, and Express 4 does not forward a
 *          rejected async handler, so a store fault left the poller's request open until a timeout
 *          with nothing surfaced. It now answers a JSON error.
 *
 * The page half runs the shipped inline poller script in a vm with a stub DOM and a stub fetch.
 *
 *   node scripts/test-price-state-hold-and-errors.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-state-hold-'));

const http = require('http');
const vm = require('vm');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function req(method, url, { body = null, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json, text: b }); }); });
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 0, timedOut: true }); });
    r.on('error', () => resolve({ status: 0, error: true }));
    if (body != null) r.write(body);
    r.end();
  });
}
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });

// Run the page's own poller against one state answer and report what it did.
async function runPoller(html, pathname, state) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.find((s) => s.includes('function poll()') && s.includes('stateUrl'));
  if (!src) return { ran: false };
  const flashes = [];
  let reloads = 0;
  const timers = [];
  const card = { classList: { contains: () => false, add() {}, remove() {} }, insertBefore: (el) => flashes.push(el) };
  const document = { getElementById: () => null, querySelector: () => card, querySelectorAll: () => [],
    createElement: () => ({ className: '', innerHTML: '' }) };
  const ctx = {
    document, location: { pathname, reload: () => { reloads++; } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(state) }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    Date, Number, String, Math, JSON, Promise, Error, isFinite, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  for (const t of timers.filter((x) => x.ms === 2500)) t.fn();
  return { ran: true, flashes: flashes.map((f) => f.innerHTML), reloads };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nA039 - a hold reaches every open form through the poll');
  {
    const r = await requests.createForLoad(load('ST-1'));
    const armed = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify({ cost: '29000' }) });
    ok(armed.status === 200, `setup: armed (HTTP ${armed.status})`);
    const openForm = await req('GET', `${base}/price/${r.id}`);
    const before = await req('GET', `${base}/price/${r.id}/state`);
    ok(before.status === 200 && before.json && !before.json.onHold, 'an ordinary armed load polls as not held');
    await requests.holdBidding(r.id, { kind: 'standing', reason: 'new_floor_above_standing_bid', standingBidPrice: 31_610,
      correctedCost: 38_000, floor: 38_380 });
    const held = await req('GET', `${base}/price/${r.id}/state`);
    ok(held.status === 200 && held.json && held.json.status === 'armed' && held.json.onHold === true,
      `the held load polls as held (${JSON.stringify(held.json && { status: held.json.status, onHold: held.json.onHold })})`);
    ok(!/38,?000|31,?610|38,?380/.test(held.text), 'and the poll still carries no cost or bid figures of the hold');
    const run = await runPoller(openForm.text, `/price/${r.id}`, held.json);
    ok(run.ran && run.reloads === 1 && run.flashes.length === 1,
      `an open re-price form that sees the hold leaves for the held page (flash ${JSON.stringify(run.flashes)}, reloads ${run.reloads})`);
    const calm = await runPoller(openForm.text, `/price/${r.id}`, before.json);
    ok(calm.ran && calm.reloads === 0 && calm.flashes.length === 0, 'control: an unchanged poll leaves the form alone');
  }

  console.log('\nA040 - a store fault on the poll is answered, not left hanging');
  {
    const r = await requests.createForLoad(load('ST-2'));
    const real = requests.getByToken;
    requests.getByToken = () => Promise.reject(new Error('store read failed'));
    let res;
    try { res = await req('GET', `${base}/price/${r.id}/state`, { timeoutMs: 2000 }); } finally { requests.getByToken = real; }
    ok(!res.timedOut && res.status >= 500 && res.status < 600, `the poll gets an error status (${res.timedOut ? 'timed out' : res.status})`);
    ok(!!res.json && typeof res.json.error === 'string', `with a JSON error envelope (${res.json && JSON.stringify(res.json)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
