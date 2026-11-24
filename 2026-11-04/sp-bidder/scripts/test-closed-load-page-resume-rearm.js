'use strict';
/**
 * A LOAD WHOSE OUTCOME THE ENGINE HAS BOOKED IS CLOSED ON EVERY DOOR, NOT ONLY THE PRICE SUBMIT.
 *
 * Follow-up to 25829357. The price request reads armed until the posted close, so after the engine
 * booked the load:
 *   1. GET /price drew the live re-price form, inviting the submit the route now refuses;
 *   2. the desk's resume on a held load re-armed it;
 *   3. the console's Re-arm on a stopped load re-armed it.
 * Each now answers closed. Controls: a close the engine never saw (closed while down, or a monitor
 * retired as unknown) still gets the form and may still be re-armed.
 *
 *   node scripts/test-closed-load-page-resume-rearm.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-closed-doors-'));

const http = require('http');
const { app, requests, store, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const WORDS = 'Auction closed. Nothing saved.';

function call(base, method, url, json) {
  const body = json ? JSON.stringify(json) : null;
  return new Promise((resolve, reject) => {
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: base } : {};
    const r = http.request(`${base}${url}`, { method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
let seq = 0;
const load = () => ({ id: `CLD-${++seq}`, lane: { origin: 'Tumkur', destination: 'Bangalore' }, equipment: '32 FT SXL', units: 1,
  quoteType: 'FTL', companyName: 'Havells India', closesAt: Date.now() + 66_000, startsAt: Date.now() - 14 * 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = stacks[0].engine;
  const armedEvents = (id) => engine.events.filter((e) => e.type === 'armed' && String(e.auctionId) === id).length;
  const armedLoad = async () => {
    const r = await requests.createForLoad(load());
    const res = await call(base, 'POST', `/price/${r.id}`, { cost: '19000' });
    const id = String(r.loadId);
    if (res.status !== 200 || !engine.monitors.get(id)) throw new Error(`setup: ${id} did not arm (HTTP ${res.status})`);
    return { r, id };
  };
  const booked = async () => {
    const x = await armedLoad();
    await engine._finalize(engine.monitors.get(x.id), { myRank: null });
    await settle();
    return x;
  };

  console.log('\n1. GET /price on a booked load that still reads armed');
  {
    const { r } = await booked();
    ok((await requests.getByToken(r.id)).status === 'armed', 'setup: the request still reads armed');
    const page = await call(base, 'GET', `/price/${r.id}`);
    ok(page.status === 410 && /This auction has closed/.test(page.text) && !/id="mainForm"/.test(page.text),
      `the closed page, no re-price form (HTTP ${page.status})`);
    ok(!/The final bid was placed/.test(page.text), 'and it does not claim a final bid was placed');
    ok(page.text.includes('Auction closed. The price can' + String.fromCharCode(39) + 't be changed now.'), 'in the owner-approved words');
    const live = await armedLoad();
    const livePage = await call(base, 'GET', `/price/${live.r.id}`);
    ok(livePage.status === 200 && /id="mainForm"/.test(livePage.text), 'control: a load still bidding keeps its re-price form');
    const retired = await armedLoad();
    engine.monitors.get(retired.id).finalized = true;
    const retiredPage = await call(base, 'GET', `/price/${retired.r.id}`);
    ok(retiredPage.status === 200 && /id="mainForm"/.test(retiredPage.text),
      'control: a monitor retired with no result (closed while down) keeps the form');
  }

  console.log('\n2. the desk\'s resume on a held load the engine has booked');
  {
    const { r, id } = await booked();
    await store.patchDoc('priceRequests', r.id, { hold: { kind: 'standing', since: Date.now(),
      resume: { cost: 19000, marginsPct: [9, 5, 1], minMarginPct: 1 } } });
    const before = armedEvents(id);
    const res = await call(base, 'POST', `/price/${r.id}/resume`, {});
    await settle();
    ok(res.status === 410 && res.json && res.json.error === WORDS, `refused (HTTP ${res.status}: ${JSON.stringify(res.json)})`);
    ok(armedEvents(id) === before, `nothing was armed (${armedEvents(id) - before} new arms)`);
    ok(((await requests.getByToken(r.id)).hold || {}).kind === 'standing', 'and the hold is untouched');
  }

  console.log('\n3. the console Re-arm on a stopped load the engine has booked');
  {
    const { r, id } = await booked();
    const stop = await call(base, 'POST', `/api/auctions/${id}/stop`, {});
    ok(stop.status === 200, `setup: stopped (HTTP ${stop.status}: ${JSON.stringify(stop.json)})`);
    const before = armedEvents(id);
    const res = await call(base, 'POST', `/api/auctions/${id}/rearm`, {});
    await settle();
    ok(res.status === 410 && res.json && res.json.error === WORDS, `refused (HTTP ${res.status}: ${JSON.stringify(res.json)})`);
    ok(armedEvents(id) === before && !engine.monitors.get(id), 'nothing was armed');
    ok((await requests.getByToken(r.id)).status === 'stopped', 'and the load stays stopped');

    const down = await armedLoad();
    await call(base, 'POST', `/api/auctions/${down.id}/stop`, {});
    await store.patchDoc('closedBids', down.id, { status: 'closed', closedWhileDown: true });
    const again = await call(base, 'POST', `/api/auctions/${down.id}/rearm`, {});
    ok(again.status === 200, `control: a closed-while-down load may still be re-armed (HTTP ${again.status}: ${JSON.stringify(again.json)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
