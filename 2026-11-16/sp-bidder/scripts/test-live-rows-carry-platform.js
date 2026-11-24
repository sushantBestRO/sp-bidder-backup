'use strict';
/**
 * EVERY LIVE ROW THE CONSOLE RECEIVES NAMES ITS PORTAL, AND A STOP SENT FROM IT REACHES ONLY THAT PORTAL.
 *
 * Regression target: C063 follow-up. The console's Live Bids Stop now sends the row's portal
 * (?platform=), so the row has to carry one: an armed SuperProcure row, an armed GoComet row and a
 * scheduled-not-yet-armed GoComet row, all from GET /api/auctions. With the same load id armed on
 * both portals, a Stop built from the GoComet row stops the GoComet auction and leaves the
 * SuperProcure one bidding.
 *
 * The GoComet stack is a real BidEngine on a stub adapter, pushed onto the server's stack list the
 * way attachGoCometStack pushes the live one.
 *
 *   node scripts/test-live-rows-carry-platform.js
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
const fs = require('fs'); // allowed: test harness (temp data dir, temp intent file), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-live-rows-platform-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function call(base, method, url, obj) {
  const body = obj ? JSON.stringify(obj) : null;
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = { origin: base };
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const ID = '888001';
const gcScheduler = new DurableScheduler(path.join(process.env.SP_DATA_DIR, 'intents-gc.json'));
const gcEngine = new BidEngine({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 3, closeModel: 'unknown' }),
  ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }), placeBid: async () => ({ accepted: true }),
}, gcScheduler, { onEvent: () => {} });
gcEngine._schedule = () => {};
stacks.push({ platformKey: 'gocomet', account: { accountId: 'gocomet', label: 'GoComet' }, engine: gcEngine,
  scheduler: gcScheduler, adapter: null });

const liveOn = (engine, id) => { const m = engine.monitors.get(id); return !!(m && !m.finalized); };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const spEngine = stacks[0].engine;

  const sp = await requests.createForLoad({ id: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
    softClose: false, closeModelKnown: true, status: 'live' });
  ok((await call(base, 'POST', `/price/${sp.id}`, { cost: '29000' })).status === 200 && liveOn(spEngine, ID), 'setup: SuperProcure 888001 armed');
  gcEngine.arm({ id: ID, lane: { origin: 'Pune', destination: 'Delhi' }, units: 1, companyName: 'Havells', closesAt: Date.now() + 40 * 60_000 },
    { cost: 50_000, marginsPct: [9, 5, 1] });
  gcEngine.schedule({ id: '888002', lane: { origin: 'Pune', destination: 'Delhi' }, units: 1, companyName: 'Havells',
    startsAt: Date.now() + 3_600_000, closesAt: Date.now() + 7_200_000 }, { cost: 50_000, marginsPct: [9, 5, 1] });
  ok(liveOn(gcEngine, ID), 'setup: GoComet 888001 armed on the same id');

  const res = await call(base, 'GET', '/api/auctions');
  const rows = (res.json && res.json.auctions) || [];
  const spRow = rows.find((a) => String(a.auctionId) === ID && a.platformKey === 'sp');
  const gcRow = rows.find((a) => String(a.auctionId) === ID && a.platformKey === 'gocomet');
  const gcScheduled = rows.find((a) => String(a.auctionId) === '888002');
  ok(!!spRow, `the armed SuperProcure row names its portal (${JSON.stringify(rows.map((a) => [a.auctionId, a.platformKey]))})`);
  ok(!!gcRow, 'the armed GoComet row names its portal');
  ok(!!gcScheduled && gcScheduled.scheduled === true && gcScheduled.platformKey === 'gocomet',
    `the scheduled GoComet row names its portal (${gcScheduled && gcScheduled.platformKey})`);

  const stop = await call(base, 'POST', `/api/auctions/${gcRow ? gcRow.auctionId : ID}/stop?platform=${encodeURIComponent(gcRow ? gcRow.platformKey : '')}`, {});
  ok(stop.status === 200, `a Stop built from the GoComet row is accepted (HTTP ${stop.status}: ${stop.json && stop.json.error})`);
  ok(!liveOn(gcEngine, ID), 'it stops the GoComet auction');
  ok(liveOn(spEngine, ID) && (await requests.getByToken(sp.id)).status === 'armed', 'and leaves the SuperProcure one bidding');

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
