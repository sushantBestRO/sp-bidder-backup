'use strict';
/**
 * SuperProcure settled rank: the PENDING-tab /sp/loads/v4 read books the rank the socket never sent.
 *
 * On the Epack logins the socket delivers no bid rows for carrier 17360, so _finalize booked rank null
 * and "lost" on loads SuperProcure shows us at rank 1. The PENDING tab of /sp/loads/v4 carries our
 * active row's rank in bidDetails[]. The fixture is that response, redacted from the owner's HAR of
 * 2026-09-28 (our carrier's rows only; no user names, mobiles or credentials).
 *
 * What must hold:
 *   - readSettledOutcome returns our active row's rank and amount (25903462 -> 1 at 73,500).
 *   - a load absent from PENDING, or present with no active whole-ranked row of ours, is unsettled.
 *   - a failed read (status 0, 503, HTML 500, 401) is unverified, never "not won" (S2002).
 *   - _finalize books that rank when the socket gave none; a failed read books won null.
 *   - a cached socket rank is also verified, and one we never bid on is never read.
 *
 *   node scripts/test-sp-settled-rank.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (fixture + temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter, settledFromV4 } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');
const { toNotification, outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sp-v4-pending-epack-2026-09-28.json'), 'utf8'));

const REAL_NOW = Date.now;
let vnow = Date.parse('2026-09-28T11:00:00Z');
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `sp-settled-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function adapterServing(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init && init.method, body });
    const r = respond(url, body);
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: () => null }, text: async () => r.text };
  };
  const a = new RealSuperProcureAdapter({ token: 'test-only', fetchImpl, sleep: async () => {}, rand: () => 0,
    authProbeEnabled: false });
  a.account = { carrierId: 2667, branchIds: [52567, 52860] };
  return { a, calls };
}
// The historical redaction omitted biddingOn; add the closed-state fact only to this test response.
const pending = (data = FIXTURE) => () => ({ status: 200, text: JSON.stringify({ ...data,
  loadDetails: data.loadDetails.map(l => ({ biddingOn: 0, ...l })) }) });
const verified = (rank, amount) => ({ settled: true, rank, amount, source: 'sp_v4',
  tab: 'PENDING', verifiedAt: vnow, awardConfirmed: false });

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${String(e && e.message).split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e && e.stack}`); }
}

async function closeWith({ auctionId, liveRank, respond, landed = true }) {
  const closesAt = vnow + 60_000;
  const ctrl = { closed: false };
  const sp = adapterServing(respond);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard', snipeBudgetMs: 3000,
      settledOutcomeRequiresOwnPosition: sp.a.capabilities().settledOutcomeRequiresOwnPosition }),
    async getAuctionState() {
      return { ok: true, status: ctrl.closed ? 'closed' : 'live', closeModel: 'hard', myRank: liveRank, totalBidders: null,
        standingL1Price: null, closesInMs: ctrl.closed ? 0 : closesAt - vnow, closesAtMs: closesAt,
        revisionsLeft: 0, measuredRttMs: 20 };
    },
    async placeBid() { return { accepted: false, error: 'offline test adapter' }; },
    readSettledOutcome: (id, opts) => sp.a.readSettledOutcome(id, opts),
  };
  const meta = { id: auctionId, lane: { origin: 'Noida', destination: 'Ghiloth' }, equipment: '32 SXL', units: 1,
    quoteType: 'FTL', companyName: 'Epack Prefab Technologies Limited', closesAt, rules: { revisionLimit: 3, minDecrement: 100 } };
  const events = [];
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    onEvent: (e) => { events.push(e); logger.handle(e); },
    log: quiet,
  });
  try {
    const m = eng.arm(meta, { cost: 70_000, marginsPct: [8, 6, 5] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    if (landed) {
      const priorBid = FIXTURE.bidDetails.find(b => String(b.load) === String(auctionId) && b.isActive === 1);
      const price = priorBid ? priorBid.amount : 73_500;
      await logger.handle({ type: 'bid_placed', auctionId, ts: vnow, price, rungIndex: 2, rank: null });
      m.landedBids = 1;
      m.lastBidPrice = price;
    }
    vnow = closesAt + 500;
    ctrl.closed = true;
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    await logger._tail;
    if (!m.finalized) throw new Error(`HARNESS: ${auctionId} never reached _finalize (status ${m.status})`);
    const result = events.find((e) => e.type === 'auction_result');
    const record = await store.getDoc('closedBids', auctionId);
    const n = toNotification(result);
    Object.assign(n.data, outcomeEnrichment(record));
    const receipt = renderMessage(templateFor(n.kind, n.data), n.data) || '';
    const alerts = events.filter((e) => e.type === 'alert').map((e) => e.kind);
    return { result, record, receipt, alerts, reads: sp.calls.length,
      line: `won ${result.won}, rank ${result.finalRank}, record ${record && record.finalRank}/${record && record.won}, reads ${sp.calls.length}, alerts ${JSON.stringify(alerts)}` };
  } finally {
    try { eng.kill(); } catch (_) {}
  }
}

(async () => {
  console.log('\n1. the PENDING-tab read (adapter)');
  await check('25903462 settles at rank 1 for 73,500 (the HAR shape)', async () => {
    const { a } = adapterServing(pending());
    assert.deepStrictEqual(await a.readSettledOutcome('25903462'), verified(1, 73500));
  });
  await check('25905527 settles at rank 4 for 38,850', async () => {
    const { a } = adapterServing(pending());
    assert.deepStrictEqual(await a.readSettledOutcome(25905527), verified(4, 38850));
  });
  await check('it POSTs /sp/loads/v4 with the listAuctions body on tab PENDING', async () => {
    const { a, calls } = adapterServing(pending());
    await a.readSettledOutcome('25903462');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/sp/loads/v4') && calls[0].method === 'POST', calls[0].url);
    const f = calls[0].body.baseFilter;
    assert.strictEqual(f.tab, 'PENDING');
    assert.strictEqual(f.loadId, 25903462);
    assert.deepStrictEqual(f.branchIds, [52567, 52860]);
    assert.deepStrictEqual(calls[0].body.limit, { limit: 5000, offset: 0 });
    assert.strictEqual(calls[0].body.isWeb, 1);
  });
  await check('listAuctions still sends the identical OPEN body', async () => {
    const { a, calls } = adapterServing(() => ({ status: 200, text: JSON.stringify({ loadDetails: [], bidDetails: [] }) }));
    await a.listAuctions();
    const b = calls[0].body;
    assert.deepStrictEqual(Object.keys(b), ['baseFilter', 'limit', 'sort', 'isWeb']);
    assert.deepStrictEqual(Object.keys(b.baseFilter), ['branchIds', 'fromDate', 'toDate', 'tab', 'loadId']);
    assert.strictEqual(b.baseFilter.tab, 'OPEN');
    assert.strictEqual(b.baseFilter.fromDate, '2026-09-21');
    assert.strictEqual(b.baseFilter.toDate, '2026-10-12');
    assert.deepStrictEqual(b.sort, { value: null, order: 'ASC' });
  });
  await check('a load absent from PENDING is unsettled', async () => {
    const { a } = adapterServing(pending());
    assert.deepStrictEqual(await a.readSettledOutcome('11111111'), { settled: false, reason: 'not_found' });
  });
  await check('a load with no active row of ours is unsettled', async () => {
    const data = JSON.parse(JSON.stringify(FIXTURE));
    for (const b of data.bidDetails) if (b.load === 25903462) b.isActive = 0;
    const { a } = adapterServing(pending(data));
    assert.deepStrictEqual(await a.readSettledOutcome('25903462'), { settled: false, reason: 'own_bid_ambiguous' });
  });
  await check('an active row with no whole rank is unsettled', async () => {
    const data = JSON.parse(JSON.stringify(FIXTURE));
    for (const b of data.bidDetails) if (b.load === 25903462 && b.isActive === 1) b.rank = null;
    const { a } = adapterServing(pending(data));
    assert.deepStrictEqual(await a.readSettledOutcome('25903462'), { settled: false, reason: 'rank_unknown' });
  });
  await check('a row on another carrier is never read as ours', async () => {
    const data = JSON.parse(JSON.stringify(FIXTURE));
    for (const b of data.bidDetails) if (b.load === 25905527) { b.bidCarrierId = 99999; b.company = 99999; }
    const { a } = adapterServing(pending(data));
    assert.deepStrictEqual(await a.readSettledOutcome('25905527'), { settled: false, reason: 'own_bid_ambiguous' });
  });
  await check('an own bid without a matching closed load is not verified', async () => {
    const data = { loadDetails: [], bidDetails: [{ id: 1, load: 42, bidCarrierId: 2667, isActive: 1, rank: 2, amount: 50000 }] };
    const { a } = adapterServing(pending(data));
    assert.deepStrictEqual(await a.readSettledOutcome('42'), { settled: false, reason: 'not_found' });
  });
  for (const [label, respond] of [
    ['status 0 (transport failure)', () => new Error('ECONNRESET')],
    ['503', () => ({ status: 503, text: 'Service Unavailable' })],
    ['an HTML 500', () => ({ status: 500, text: '<html><body>boom</body></html>' })],
    ['a 200 that is not JSON', () => ({ status: 200, text: '<html>maintenance</html>' })],
    ['a 200 with no bidDetails', () => ({ status: 200, text: JSON.stringify({ loadDetails: [] }) })],
  ]) {
    await check(`a failed read (${label}) is unverified`, async () => {
      const { a } = adapterServing(respond);
      assert.deepStrictEqual(await a.readSettledOutcome('25903462'), { settled: false, reason: 'read_failed' });
    });
  }
  await check('a 401 is unverified and counts on the READ auth streak', async () => {
    const { a } = adapterServing(() => ({ status: 401, text: 'Unauthorized' }));
    const before = a._readStreak || 0;
    assert.deepStrictEqual(await a.readSettledOutcome('25903462'), { settled: false, reason: 'auth_failed' });
    assert.ok((a._readStreak || 0) > before, `read streak ${a._readStreak}`);
  });
  await check('settledFromV4 maps every load in the fixture', async () => {
    const m = settledFromV4(FIXTURE, { carrierIds: [2667] });
    const got = {};
    for (const [k, v] of m) got[k] = v;
    assert.deepStrictEqual(got, {
      25916568: { rank: 4, amount: 31500 }, 25913499: { rank: 1, amount: 36750 },
      25905527: { rank: 4, amount: 38850 }, 25903462: { rank: 1, amount: 73500 },
      25903199: { rank: 4, amount: 35000 }, 25840948: { rank: 1, amount: 70350 },
      25836105: { rank: 2, amount: 39900 }, 25787460: { rank: 8, amount: 135000 },
      25761228: { rank: 2, amount: 47000 },
    });
  });

  console.log('\n2. _finalize with a blind socket');
  const won = await closeWith({ auctionId: '25903462', liveRank: null, respond: pending() });
  await check('socket blind, PENDING rank 1: booked won at rank 1', async () => {
    assert.deepStrictEqual([won.result.won, won.result.finalRank], [true, 1], won.line);
    assert.deepStrictEqual([won.record.won, won.record.finalRank], [true, 1], won.line);
  });
  await check('socket blind, PENDING rank 1: no LOST receipt and no lost_after_bidding', async () => {
    assert.ok(!/LOST/.test(won.receipt), won.receipt);
    assert.ok(!won.alerts.includes('lost_after_bidding'), won.line);
  });
  const lost = await closeWith({ auctionId: '25905527', liveRank: null, respond: pending() });
  await check('socket blind, PENDING rank 4: booked lost at rank 4', async () => {
    assert.deepStrictEqual([lost.result.won, lost.result.finalRank], [false, 4], lost.line);
    assert.ok(/LOST/.test(lost.receipt) && /Our Final Ranking\* - 4\b/.test(lost.receipt), lost.receipt);
  });
  const failed = await closeWith({ auctionId: '25903462', liveRank: null, respond: () => ({ status: 503, text: 'down' }) });
  await check('socket blind, read fails: booked not known, never lost', async () => {
    assert.strictEqual(failed.result.won, null, failed.line);
    assert.strictEqual(failed.record.won, null, failed.line);
    assert.ok(!/LOST/.test(failed.receipt), failed.receipt);
    assert.ok(!failed.alerts.includes('lost_after_bidding'), failed.line);
  });
  const absent = await closeWith({ auctionId: '11111111', liveRank: null, respond: pending() });
  await check('socket blind, load not yet in PENDING: booked not known', async () => {
    assert.strictEqual(absent.result.won, null, absent.line);
    assert.strictEqual(absent.result.finalRank, null, absent.line);
  });

  console.log('\n3. what must not move');
  const ranked = await closeWith({ auctionId: '25903462', liveRank: 2, respond: pending() });
  await check('a cached socket rank is replaced by the verified portal rank', async () => {
    assert.strictEqual(ranked.reads, 1, ranked.line);
    assert.deepStrictEqual([ranked.result.won, ranked.result.finalRank], [true, 1], ranked.line);
  });
  const nobid = await closeWith({ auctionId: '25903462', liveRank: null, respond: pending(), landed: false });
  await check('a load we never bid on is not read and has no verified result', async () => {
    assert.strictEqual(nobid.reads, 0, nobid.line);
    assert.strictEqual(nobid.result.won, null, nobid.line);
    assert.strictEqual(nobid.result.finalRank, null, nobid.line);
  });

  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  Date.now = REAL_NOW;
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - participated closes use a verified portal rank`);
  process.exit(0);
})().catch((e) => { Date.now = REAL_NOW; console.error('FAIL (setup):', e && e.stack); process.exit(1); });
