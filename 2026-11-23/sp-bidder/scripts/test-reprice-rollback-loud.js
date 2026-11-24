'use strict';
/**
 * EVERY WAY A RE-PRICE ROLLBACK CAN FAIL IS LOUD, AND EACH OCCURRENCE REACHES THE DESK.
 *
 * Regression targets: A008 and A087 review findings 3, 4 and 5.
 *   3. A Stop landing while the rolled-back plan re-armed answered stoppedMidSave's "Saved, but ...":
 *      nothing was saved. It must say "Not changed. This load was stopped at the same moment, so it
 *      is not bidding."
 *   4a. undoReprice failing for any reason but a Stop was rethrown: the load read armed on the new
 *       plan with no monitor, no hold and no alert.
 *   4b. holdUnbiddable throwing after a double re-arm failure skipped the reprice_arm_failed alert.
 *   5. Error alerts are deduped on (load, kind) for the load's lifetime, so a second
 *      reprice_arm_failed on the same load, and a live-countdown close_unknown_held after a restart
 *      one, were dropped. Each is keyed per occurrence now.
 *
 *   node scripts/test-reprice-rollback-loud.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rollback-loud-'));

const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');
const { toNotification } = require('../src/notify/engineAlerts');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, url, obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: base } },
    (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });
const eng = () => stacks[0].engine;
const liveMonitor = (id) => { const m = eng().monitors.get(id); return !!(m && !m.finalized); };
const alerts = [];
{
  const realEmit = eng().emit.bind(eng());
  eng().emit = (e) => { if (e && e.type === 'alert') alerts.push(e); return realEmit(e); };
}
const failArm = (times, onCall) => {
  const e = eng(); const real = e.arm; let n = 0;
  e.arm = function (...a) { n += 1; if (onCall) onCall(n); if (n <= times) throw new Error('arm refused'); return real.apply(this, a); };
  return () => { e.arm = real; };
};
const alertsFor = (id, kind) => alerts.filter((a) => String(a.auctionId) === id && a.kind === kind);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armed = async (id) => {
    const r = await requests.createForLoad(load(id));
    if ((await post(base, `/price/${r.id}`, { cost: '29000' })).status !== 200) throw new Error(`setup: ${id}`);
    return r;
  };
  const reprice = (r) => post(base, `/price/${r.id}`, { cost: '33000', m_0: '9', m_1: '5', m_2: '1' });

  console.log('\n3. a Stop lands while the prior plan re-arms');
  {
    const r = await armed('RL-3');
    const restore = failArm(1, (n) => { if (n === 2) store.patchDoc('priceRequests', r.id, { status: 'stopped' }); });
    let res;
    try { res = await reprice(r); } finally { restore(); }
    ok(res.status === 409 && /^Not changed\. This load was stopped at the same moment, so it is not bidding\.$/.test((res.json && res.json.error) || ''),
      `the desk is told nothing changed (HTTP ${res.status}: ${res.json && res.json.error})`);
  }

  console.log('\n4a. putting the prior plan back fails for a reason other than a Stop');
  {
    const r = await armed('RL-4A');
    const realUndo = requests.undoReprice;
    requests.undoReprice = () => Promise.reject(new Error('store write failed'));
    const restore = failArm(1);
    let res;
    try { res = await reprice(r); } finally { restore(); requests.undoReprice = realUndo; }
    const after = await requests.getByToken(r.id);
    // The put-back failed, so the new cost IS on record: the text must not say "Not saved".
    ok(res.status === 409 && /^This load isn't bidding now\. Re-arm it or bid by hand\.$/.test((res.json && res.json.error) || ''),
      `a refusal saying the load is not bidding, not a server fault, and not claiming "Not saved" (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(after.status !== 'armed' && !liveMonitor('RL-4A'), `the record no longer reads armed with nothing bidding (${after.status})`);
    ok(alertsFor('RL-4A', 'reprice_arm_failed').length === 1, 'an error alert names the load');
  }

  console.log('\n4a (form post). the same failure seen by a page with no script');
  {
    const r = await armed('RL-4AF');
    const realUndo = requests.undoReprice;
    requests.undoReprice = () => Promise.reject(new Error('store write failed'));
    const restore = failArm(1);
    let page;
    try {
      page = await new Promise((resolve, reject) => {
        const body = 'cost=33000&m_0=9&m_1=5&m_2=1';
        const u = new URL(`${base}/price/${r.id}`);
        const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
        (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
        q.on('error', reject); q.write(body); q.end();
      });
    } finally { restore(); requests.undoReprice = realUndo; }
    const visible = page.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/&#39;/g, "'");
    ok(page.status === 409 && /This load isn't bidding now\. Re-arm it or bid by hand\./.test(visible),
      `the page states the outcome (HTTP ${page.status})`);
    ok(!/Not saved|Could not save/.test(visible), 'and nothing on it claims the change was not saved - the new cost is on record');
  }

  console.log('\n4b. both re-arms fail and parking the load fails too');
  {
    const r = await armed('RL-4B');
    const realHold = requests.holdUnbiddable;
    requests.holdUnbiddable = () => Promise.reject(new Error('store write failed'));
    const restore = failArm(2);
    let res;
    try { res = await reprice(r); } finally { restore(); requests.holdUnbiddable = realHold; }
    ok(res.status === 409 && /^Not saved\. This load isn't bidding now\. Re-arm it or bid by hand\.$/.test((res.json && res.json.error) || ''),
      `the desk is still told it is not bidding (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(alertsFor('RL-4B', 'reprice_arm_failed').length === 1, 'and the error alert still goes out');
  }

  console.log('\n5. each occurrence is its own alert');
  {
    const r = await armed('RL-5');
    let restore = failArm(2);
    try { await reprice(r); } finally { restore(); }
    await post(base, `/api/auctions/RL-5/rearm?platform=sp`, {});
    restore = failArm(2);
    try { await reprice(r); } finally { restore(); }
    const keys = alertsFor('RL-5', 'reprice_arm_failed').map((e) => toNotification(e).dedupeKey);
    ok(keys.length === 2 && keys[0] !== keys[1], `two failures, two delivery keys (${JSON.stringify(keys)})`);

    const held = [];
    const e = new BidEngine({ capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
      ensureSession: async () => ({}), getAuctionState: async () => ({ ok: true, status: 'live', closeModel: 'hard', closesInMs: null, myRank: 3 }),
      placeBid: async () => ({ accepted: true }) }, new DurableScheduler(path.join(process.env.SP_DATA_DIR, 'cu.json')),
    { config: {}, softClose: { enabled: false }, onEvent: (x) => { if (x.type === 'alert' && x.kind === 'close_unknown_held') held.push(x); } });
    e._holdUnknownClose({ auctionId: 'RL-CU', status: 'bidding', closesAt: null });
    const m = e.arm({ id: 'RL-CU', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'X', closesAt: Date.now() + 600_000 },
      { cost: 100_000, marginsPct: [12, 7, 2] });
    if (m.timer) clearTimeout(m.timer);
    await e._tick(m);
    if (m.timer) clearTimeout(m.timer);
    const cuKeys = held.map((x) => toNotification(x).dedupeKey);
    ok(cuKeys.length === 2 && cuKeys[0] !== cuKeys[1],
      `a restart hold and a live-countdown hold on one load are two deliveries (${JSON.stringify(cuKeys)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
