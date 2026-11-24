'use strict';
/**
 * A GoComet load is booked WON only when GoComet's own enquiry record says we finished rank 1.
 *
 * Regression target: bid-command overstating GoComet wins - 6 of its 22 "won" loads on 1-9 Sep 2026
 * were not vendor rank 1 on GoComet (2609018BQ6, 2609071564, 260903YISG, 2609072PJC, 260908343H,
 * 260908MNRJ; GoComet's enquiry record: vendor_rank 2 or 4, status Lost or Closed). Same family as
 * NEW-3 / BC-33b: a win the client reads that the portal does not back.
 *
 * THE MECHANISM. bidEngine._finalize books the outcome as
 *   const won = finalRank === 1;
 * where finalRank is ONE gocometAdapter.getAuctionState read of `bidding-data.vendor_rank`, taken
 * once the countdown (bid_closing_in) has read null for extendMs + finalizeDebounceMs. bidding-data
 * carries no close flag and no result, and nothing on the outcome path ever reads the enquiry
 * record (the detail and list endpoints), which is where GoComet states the settled vendor_rank and
 * status. _finalize is terminal, so nothing later corrects it. In all six live cases bid-command's
 * own rank samples read vendor_rank 1 straight through the zero and the final read, so the booking
 * is a faithful copy of a live rank that was not the final one; for two of the six (2609071564,
 * 260903YISG) GoComet's enquiry record carries a close 40 minutes and 36 hours after the zero
 * bid-command finalized on.
 *
 * THE CASE. Real GoCometAdapter over a fake transport, real BidEngine, real BidLogger on a memory
 * store. bidding-data reads bid_closing_in null and vendor_rank 1 at the close (the live shape);
 * the enquiry record (detail and every list route) reads bidding_closed true, status Closed and
 * vendor_rank 2. The engine is driven through _tick to its own held-zero finalize.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   1. control: the same enquiry settled at vendor_rank 1 is booked won on the result event, the
 *      durable intent and the closed-bids record. It differs from check 2 in vendor_rank ONLY;
 *   3. control: a SuperProcure load read rank 1 at its hard close is booked won.
 *
 * Offline and deterministic: stubbed clock (the adapter's sleep advances it), temp-file
 * DurableScheduler under os.tmpdir(), no network, no real sleeps.
 *
 *   node scripts/test-gocomet-won-is-settled-rank-1.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');

const EXPECTED_CHECKS = 3;
const KEY = '2608115VVB';
const FIX = path.join(__dirname, 'fixtures', 'gocomet');
const DETAIL = JSON.parse(fs.readFileSync(path.join(FIX, 'enquiry-detail.json'), 'utf8'));
const LIST = JSON.parse(fs.readFileSync(path.join(FIX, 'spot-enquiries.list.json'), 'utf8'));
const CAUSE = '_finalize books won = (bidding-data vendor_rank === 1) from one live read at the held-zero '
  + 'countdown and never reads the enquiry record where GoComet states the settled rank';

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-won-settled-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const istWire = (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30');
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(REAL_NOW() / 1000) + 30 * 86_400, user_id: 'u1', client_id: 'c1' })}.sig`;

function gocometRig(settledRank) {
  const closesAt = Math.floor(vnow / 1000) * 1000 + 600_000;
  const ctrl = { secs: 600 };
  const writes = [];
  const settled = { bidding_closed: true, status: 'Closed', vendor_rank: settledRank,
    bid_close_timestamp: istWire(closesAt), bid_closing_in: null };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method !== 'GET') { writes.push({ url: u, method }); return resp(404, { error: 'no_writes_offline' }); }
    if (u.includes(`/enquiries/${KEY}/bidding-data`)) {
      return resp(200, { data: { bid_closing_in: ctrl.secs, bid_opening_in: null, vendor_rank: 1,
        total_revisions: 3, revisions_left: 0, bid_close_time: '', current_server_time: istWire(vnow) } });
    }
    if (u.includes(`/enquiries/${KEY}`)) return resp(200, { ...DETAIL, ...settled });
    if (u.includes('/enquiries')) {
      return resp(200, { ...LIST, total_page: 1, current_page: 1, total_count: 1,
        enquiries: [{ ...LIST.enquiries[0], ...settled }] });
    }
    return resp(404, { error: 'no_route' });
  };
  const adapter = new GoCometAdapter({ token: token(), fetchImpl, now: () => vnow, log: quiet,
    sleep: async (ms) => { vnow += Math.max(0, Number(ms) || 0); } });
  return { adapter, ctrl, closesAt, writes };
}

async function runEngine(adapter, meta, drive) {
  const events = [];
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    onEvent: (e) => { events.push(e); logger.handle(e); },
    log: quiet,
  });
  try {
    const m = eng.arm(meta, { cost: 60_000, marginsPct: [8, 6, 5] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    await logger.handle({ type: 'bid_placed', auctionId: meta.id, ts: vnow, price: 64_800, rungIndex: 0, rank: 1 });
    const tick = async () => { await eng._tick(m); if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
    await drive(tick, m);
    await logger._tail;
    if (!m.finalized) throw new Error(`HARNESS: ${meta.id} never reached _finalize (status ${m.status})`);
    const result = events.find((e) => e.type === 'auction_result');
    if (!result) throw new Error(`HARNESS: ${meta.id} finalized without an auction_result event`);
    const intent = eng.scheduler.get(meta.id);
    const record = await store.getDoc('closedBids', String(meta.id));
    if (!record || record.status !== 'closed') throw new Error(`HARNESS: no closed record for ${meta.id}`);
    return { booked: { result: result.won, intent: intent && intent.won, record: record.won }, finalRank: result.finalRank };
  } finally {
    try { eng.kill(); } catch (_) {}
  }
}

async function gocometCase(settledRank) {
  const r = gocometRig(settledRank);
  await r.adapter.login();
  const meta = { id: KEY, lane: { origin: 'Degam', destination: 'Auroville' }, equipment: '40FT 25 Ton', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd.', closesAt: r.closesAt, platformKey: 'gocomet',
    rules: { revisionLimit: 3, minDecrement: 500 } };
  const out = await runEngine(r.adapter, meta, async (tick) => {
    await tick();
    vnow = r.closesAt + 1_000;
    r.ctrl.secs = null;
    await tick();
    vnow += 310_000;
    await tick();
  });
  if (r.writes.length) throw new Error(`HARNESS: the offline GoComet case attempted ${r.writes.length} write(s)`);
  return out;
}

async function spCase() {
  const closesAt = Math.floor(vnow / 1000) * 1000 + 60_000;
  const ctrl = { closed: false };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: true, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard', snipeBudgetMs: 3000 }),
    async getAuctionState() {
      return { ok: true, status: ctrl.closed ? 'closed' : 'live', closeModel: 'hard', myRank: 1, totalBidders: 4,
        standingL1Price: null, closesInMs: ctrl.closed ? 0 : closesAt - vnow, closesAtMs: closesAt,
        revisionsLeft: 0, measuredRttMs: 20 };
    },
    async placeBid() { return { accepted: false, error: 'offline test adapter' }; },
  };
  const meta = { id: 'SP-25646999', lane: { origin: 'Bhiwandi', destination: 'Nagpur' }, equipment: '32 SXL', units: 1,
    quoteType: 'FTL', companyName: 'BG', closesAt, rules: { revisionLimit: 3, minDecrement: 100 } };
  return runEngine(adapter, meta, async (tick) => {
    vnow = closesAt + 500;
    ctrl.closed = true;
    await tick();
  });
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const fmt = (b) => `auction_result.won=${b.result}, intent.won=${b.intent}, closedBids.won=${b.record}`;

async function main() {
  await check(1, 'control_gocomet_settled_rank_1_is_won', 'control', async () => {
    const { booked } = await gocometCase(1);
    return booked.result === true && booked.intent === true && booked.record === true ? null
      : `HARNESS DEAD: a GoComet enquiry settled at vendor_rank 1 was not booked won (${fmt(booked)})`;
  });

  await check(2, 'gocomet_settled_rank_2_is_not_booked_won', 'mechanism', async () => {
    const { booked, finalRank } = await gocometCase(2);
    const bad = Object.entries(booked).filter(([, v]) => v === true).map(([k]) => k);
    return bad.length ? `GoComet enquiry settled at vendor_rank 2 (status Closed) booked as WON with finalRank `
      + `${finalRank}: ${fmt(booked)} - ${CAUSE}` : null;
  });

  await check(3, 'control_sp_rank_1_at_hard_close_is_won', 'control', async () => {
    const { booked } = await spCase();
    return booked.result === true && booked.intent === true && booked.record === true ? null
      : `a SuperProcure load read rank 1 at its hard close was not booked won (${fmt(booked)})`;
  });

  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  Date.now = REAL_NOW;
  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS) {
    console.log(`FAIL - ran ${results.length} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`FAIL ${failed.length} of ${results.length} checks - GoComet won overstated: ${CAUSE}`);
    process.exit(1);
  }
  console.log(`PASS ${results.length}/${EXPECTED_CHECKS} checks - a GoComet win is booked only on the settled rank 1`);
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
