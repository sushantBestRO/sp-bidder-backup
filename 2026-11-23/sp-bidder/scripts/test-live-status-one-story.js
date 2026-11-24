'use strict';
/**
 * BC-19: one load, one status, on every surface.
 *
 * A last-resort floor bid used to reach the customer group twice, six milliseconds apart: the status
 * bubble logged the bid, and a separate desk notice announced the same bid in other words. The
 * decision is ONE statement per state change, folded into the bubble when the bubble already shows
 * that bid, and one derived rank across the bubble, the notice, /price and /track.
 *
 * Every scenario runs the REAL engine into the REAL notifier through the same chain the server uses
 * (bidLogger.handle(evt).then(notifyEngineEvent)), with a mock WhatsApp transport that records each
 * wire call. A "message" is a type:'text' call (a fresh send or a reply); a type:'edit' is the
 * bubble changing in place, which pings nobody.
 *
 *   node scripts/test-live-status-one-story.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-live-status-'));

const http = require('http');
const { toRecipientRows } = require('../src/model/project');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { fmtNum } = require('../src/notify/waTemplates');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { MemoryStore } = require('../src/store');
const { makeExporters } = require('../src/web/exports');
const exportModel = require('../src/web/exportModel');

let pass = 0, fail = 0;
const check = (n, cond, msg) => {
  if (cond) { pass++; console.log(`  PASS ${n}. ${msg}`); } else { fail++; console.log(`  FAIL ${n}. ${msg}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `live-status-${tag}-${process.pid}-${Date.now()}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

const GROUP = '120363555555555555@g.us';
const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'] }];
const people = [{ personId: 'g1', name: 'Bids group', phone: GROUP, alertPrefs: 'all', enabled: true }];
const assignments = [{ assignmentId: 'a1', personId: 'g1', customerId: 'havells', enabled: true }];

const BAND = { cost: 50000, marginsPct: [14, 11.5, 11.2], minMarginPct: 11.2 };
const LANE = { origin: 'Alwar', destination: 'Bhiwandi' };

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

/**
 * One load: ask -> rate received (creates the status bubble) -> the engine's last-resort floor bid.
 * Returns the wire calls made AFTER the bubble existed, plus the engine events.
 */
async function lastResortLoad({ id, bubbleAgeMs = 0, noBubble = false, slowProbe = false, lastResort = true }) {
  const tr = mockTransport();
  const store = new MemoryStore();
  const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
  const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => toRecipientRows(customers, people, assignments) });
  const logger = new BidLogger({ store: new MemoryStore() });
  const load = { lane: LANE, companyName: 'Havells', units: 1, equipment: 'Trailer', closesAt: Date.now() + 3000 };
  const request = { id: 'rq-' + id, loadId: id, load, price: { cost: BAND.cost, marginsPct: BAND.marginsPct, minMarginPct: BAND.minMarginPct }, capturedAt: Date.now() };
  await n.requestPrice(request);
  if (!noBubble) await n.confirmSubmitted(request);
  if (bubbleAgeMs) {
    const doc = await store.getDocAsync('askThreads', id);
    doc.groups.forEach((g) => { g.bubbleSentAt = Date.now() - bubbleAgeMs; });
    await store.putDocAsync('askThreads', id, doc);
  }
  const before = tr.calls.length;
  // The two engine events of one last-resort bid reach the notifier a few ms apart. Here the sender
  // health probe answers the first of them (the bid) late and the next at once, the way a probe whose
  // cached answer has just expired does - so only ordering decides whether the notice sees the bid.
  if (slowProbe) {
    let first = true;
    n.healthProvider = async () => { if (first) { first = false; await sleep(50); } return true; };
  }

  const events = [];
  const chain = [];
  const f = tmp(id);
  const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 };
  const adapter = lastResort ? {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}), writeEnabled: true,
    async getAuctionState() { return { ok: true, status: 'live', myRank: 4, totalBidders: 9, standingL1Price: null,
      closesInMs: 1200, revisionLimit: 3, revisionsLeft: 1, minDecrement: 100, closeModel: 'soft', measuredRttMs: 50 }; },
    async placeBid() { return { accepted: true, myRank: 9, revisionsLeft: 0, latencyMs: 20 }; },
  } : {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}), writeEnabled: true,
    async getAuctionState() { return { ok: true, status: 'live', myRank: 3, totalBidders: 6, standingL1Price: null,
      closesInMs: 1200, revisionLimit: 3, revisionsLeft: 2, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }; },
    async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 1, latencyMs: 20 }; },
  };
  const onEvent = (e) => {
    events.push(e);
    chain.push(logger.handle(e).then(() => notifyEngineEvent(n, e, null, (x) => logger.getRecord(x))).catch(() => {}));
  };
  const eng = new BidEngine(adapter, new DurableScheduler(f), lastResort
    ? { config: CFG, rand: () => 0, onEvent, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } }
    : { config: CFG, rand: () => 0, onEvent });
  const m = eng.arm({ id, lane: LANE, units: 1, companyName: 'Havells', closesAt: Date.now() + 3000 }, BAND);
  if (lastResort) {
    m.closeModel = 'soft'; m.extendCap = 3; m.extendsObserved = 0;
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1);
    m.landedBids = 2; m.lastBidPrice = m.ladder[1]; m.revisionsLeft = 1;
  } else {
    m.currentRungIndex = 0; m.firedRungs.add(0); m.landedBids = 1; m.lastBidPrice = m.ladder[0];
  }
  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  eng.kill(); rm(f);
  await Promise.all(chain);
  await sleep(slowProbe ? 200 : 20);
  await Promise.all(chain);

  const after = tr.calls.slice(before).map((c) => c.body);
  return {
    events, floor: m.ladder[m.ladder.length - 1],
    messages: after.filter((b) => b.type === 'text'),
    edits: after.filter((b) => b.type === 'edit'),
  };
}

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  // ---- 1-3. The folded statement: the bubble already shows the bid, so no second message ----
  {
    const r = await lastResortLoad({ id: '25118167' });
    const fired = r.events.filter((e) => e.type === 'alert' && e.kind === 'last_resort_floor_fired');
    if (fired.length !== 1) throw new Error(`setup: expected one last-resort release, got ${fired.length}`);
    check(1, r.messages.length === 0,
      `one state change, one statement: the last-resort bid adds no new message to a group whose bubble shows it (got ${r.messages.length}: ${r.messages.map((b) => JSON.stringify(b.message.split('\n')[0])).join(', ')})`);
    const last = r.edits.length ? r.edits[r.edits.length - 1].message : '';
    const money = `Rs ${fmtNum(r.floor)}`;
    check(2, /Final bid/.test(last) && last.includes(money) && /our lowest/.test(last)
      && !/\bfloor\b|\bband\b|reserve|your lowest price|[—–]/i.test(last),
      `the bubble itself says the final price went out (${money}, our lowest) in desk words: ${JSON.stringify(last)}`);
    const line = last.split('\n').find((l) => l.includes(money)) || '';
    check(3, /rank 9\b/.test(line),
      `the final bid's line carries the rank that bid earned (9), the rank the notice used to carry: ${JSON.stringify(line)}`);
  }

  // ---- 4. The same fold when the bid's own delivery is the slower of the two ----
  {
    const r = await lastResortLoad({ id: '25118168', slowProbe: true });
    check(4, r.messages.length === 0,
      `the notice waits for the bid's own delivery, so a slow health probe cannot split one bid into two messages (got ${r.messages.length})`);
  }

  // ---- 5-6. Where the bubble cannot show it, the notice still goes (price-page gate) ----
  {
    const r = await lastResortLoad({ id: '25118169', bubbleAgeMs: 20 * 60 * 1000 });
    const notice = r.messages.find((b) => /Final bid placed/.test(b.message));
    check(5, r.messages.length === 1 && !!notice && !!notice.reply_to
      && /Bids placed on this load\* - 3/.test(notice.message) && /Where we stand now\* - 9/.test(notice.message),
      `a bubble past its edit window cannot show the bid, so the notice goes as one reply under the ask with count 3 and rank 9 (got ${r.messages.length})`);
  }
  {
    const r = await lastResortLoad({ id: '25118170', noBubble: true });
    check(6, r.messages.some((b) => /Final bid placed/.test(b.message)),
      'with no status bubble at all the notice still reaches the group');
  }

  // ---- 7. Control: the floor reached through the rank-aware snipe sends no notice ----
  {
    const r = await lastResortLoad({ id: '25106748', lastResort: false });
    const placed = r.events.filter((e) => e.type === 'bid_placed');
    const notices = r.events.filter((e) => e.type === 'alert' && e.kind === 'last_resort_floor_fired');
    check(7, placed.length > 0 && placed[placed.length - 1].price === r.floor && notices.length === 0
      && !r.messages.some((b) => /Final bid/.test(b.message)),
      'a floor reached by the ordinary snipe produces no notice and no final-bid message');
  }

  // ---- 8. Both exporters give one bid one rank ----
  {
    const bid = { ts: Date.now(), rungIndex: 2, price: 55577, rank: null, socketRank: 9, latencyMs: 20 };
    const rec = { auctionId: 'X1', status: 'closed', closedAt: Date.now(), lane: LANE, shipper: 'Havells', ourBids: [bid], finalRank: 9 };
    const legacy = await makeExporters({ store: new MemoryStore(), requests: { listAll: async () => [] },
      bidLogger: { listClosed: async () => [rec] } }).build('bid-detail', {});
    const rankCol = legacy.headers.indexOf('rank');
    const model = exportModel.bidsView([{ loadId: 'X1', lane: LANE, ourBids: [bid] }]);
    const modelCol = model.headers.indexOf('Rank (socket)');
    check(8, String(legacy.rows[0][rankCol]) === '9' && String(model.rows[0][modelCol]).replace(/[^0-9]/g, '') === '9',
      `both exporters export rank 9 for the same bid (legacy ${legacy.rows[0][rankCol]}, model ${model.rows[0][modelCol]})`);
  }

  // ---- 9-12. The pages: no missed-cutoff claim on a priced load, and the last stored rank ----
  const { app, requests, bidLogger, stacks } = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id) => ({ id, lane: LANE, equipment: 'Trailer', units: 1, companyName: 'Havells',
    closesAt: now + 20 * 60_000, startsAt: now - 60_000, softClose: false, status: 'live' });
  const bidOn = (id, price, extra) => bidLogger.handle(Object.assign({ type: 'bid_placed', auctionId: id, ts: Date.now(),
    price, rungIndex: 0, rank: null, socketRank: 9, lane: LANE, companyName: 'Havells' }, extra));
  {
    const rA = await requests.createForLoad(mkLoad('LS-1'), { deadlineAt: now + 60_000 });
    const unpriced = await req('GET', `${base}/track/${publicSeg(rA)}`);
    const rB = await requests.createForLoad(mkLoad('LS-2'), { deadlineAt: now - 60_000 });
    await requests.capture(rB.id, { cost: 50000 });
    await bidLogger.handle({ type: 'armed', auctionId: 'LS-2', lane: LANE, companyName: 'Havells', closesAt: now + 20 * 60_000 });
    await bidOn('LS-2', 55577);
    const priced = await req('GET', `${base}/track/${publicSeg(rB)}`);
    check(9, /Cost had to be entered by/.test(unpriced.text) && !/Cost had to be entered by/.test(priced.text),
      'a load captured and bid past its cutoff never claims its cost deadline was missed; an unpriced one still names the cutoff');
  }
  {
    const r = await requests.createForLoad(mkLoad('LS-3'), { deadlineAt: now + 60_000 });
    await requests.capture(r.id, { cost: 50000 });
    await bidLogger.handle({ type: 'armed', auctionId: 'LS-3', lane: LANE, companyName: 'Havells', closesAt: now + 20 * 60_000 });
    await bidOn('LS-3', 55577);
    const s = JSON.parse((await req('GET', `${base}/price/${r.id}/state`)).text);
    check(10, s.myRank === 9 && s.lastBidPrice === 55577,
      `with no live monitor, /price serves the last stored rank and bid (got rank ${s.myRank}, bid ${s.lastBidPrice})`);
  }
  {
    // A live monitor right after an accepted SuperProcure bid: the REST response carries no rank, so
    // the monitor holds null until the next socket read. The stored bid already has 9.
    const r = await requests.createForLoad(mkLoad('LS-4'), { deadlineAt: now + 60_000 });
    await requests.capture(r.id, { cost: 50000 });
    const eng = stacks[0].engine;
    const m = eng.arm({ id: 'LS-4', lane: LANE, units: 1, companyName: 'Havells', closesAt: now + 20 * 60_000 }, BAND);
    if (m.timer) clearTimeout(m.timer);
    m.myRank = null; m.lastBidPrice = 55577;
    await bidOn('LS-4', 55577);
    const p = JSON.parse((await req('GET', `${base}/price/${r.id}/state`)).text);
    const t = JSON.parse((await req('GET', `${base}/track/${publicSeg(r)}/state`)).text);
    const trackRank = t.engine ? t.engine.myRank : null;
    if (!t.engine) throw new Error('setup: /track does not see the live monitor');
    check(11, p.myRank === 9 && trackRank === 9,
      `/price and /track state one rank for a live load whose last response carried none (price ${p.myRank}, track ${trackRank})`);
  }
  {
    // After close the stored final rank is the answer on both pages.
    const r = await requests.createForLoad(mkLoad('LS-5'), { deadlineAt: now + 60_000 });
    await requests.capture(r.id, { cost: 50000 });
    await bidLogger.handle({ type: 'armed', auctionId: 'LS-5', lane: LANE, companyName: 'Havells', closesAt: now + 20 * 60_000 });
    await bidOn('LS-5', 55577, { socketRank: 4 });
    await bidLogger.handle({ type: 'auction_result', auctionId: 'LS-5', won: false, finalRank: 9, landedBids: 1 });
    const p = JSON.parse((await req('GET', `${base}/price/${r.id}/state`)).text);
    check(12, p.myRank === 9, `once closed, /price serves the stored final rank (got ${p.myRank})`);
  }
  await new Promise((r) => server.close(r));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
