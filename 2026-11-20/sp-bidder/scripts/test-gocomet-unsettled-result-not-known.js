'use strict';
/**
 * A GoComet close whose result the enquiry record does not settle is booked as not known (won null),
 * never as a win off the live rank, and a failed read of that record never throws out of _finalize.
 *
 * Regression target: the GoComet won-not-rank-1 finding (sibling of
 * test-gocomet-won-is-settled-rank-1). _finalize booked `won = finalRank === 1` off one bidding-data
 * vendor_rank, so every one of these shapes was booked WON while bidding-data read rank 1:
 *   1. the enquiry record is not closed yet (two of the six live cases closed 40 minutes and 36 hours
 *      after the zero the engine finalized on);
 *   2. the enquiry record read fails with a 500;
 *   3. the enquiry record read throws in transport;
 *   4. the enquiry record is closed at vendor_rank 1 but GoComet marks it Lost.
 * Each must book won null on the result event, the durable intent and the closed-bids record, and
 * _finalize must resolve. Nothing in any case may write to GoComet.
 *
 * Offline and deterministic: real GoCometAdapter over a fake transport, real BidEngine and BidLogger
 * on a memory store, stubbed clock, temp-file DurableScheduler, no network, no real sleeps.
 *
 *   node scripts/test-gocomet-unsettled-result-not-known.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files, fixtures), not app state
const path = require('path');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');

const EXPECTED_CHECKS = 4;
const KEY = '2608115VVB';
const FIX = path.join(__dirname, 'fixtures', 'gocomet');
const DETAIL = JSON.parse(fs.readFileSync(path.join(FIX, 'enquiry-detail.json'), 'utf8'));
const LIST = JSON.parse(fs.readFileSync(path.join(FIX, 'spot-enquiries.list.json'), 'utf8'));

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-unsettled-${process.pid}-${seq++}.json`);
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

// `detail` answers GET /enquiries/{key}: a function of the close time returning a body, or a Response
// to return as-is, or 'throw'.
function rig(detail) {
  const closesAt = Math.floor(vnow / 1000) * 1000 + 600_000;
  const ctrl = { secs: 600 };
  const writes = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method !== 'GET') { writes.push({ url: u, method }); return resp(404, { error: 'no_writes_offline' }); }
    if (u.includes(`/enquiries/${KEY}/bidding-data`)) {
      return resp(200, { data: { bid_closing_in: ctrl.secs, bid_opening_in: null, vendor_rank: 1,
        total_revisions: 3, revisions_left: 0, bid_close_time: '', current_server_time: istWire(vnow) } });
    }
    if (u.includes(`/enquiries/${KEY}`)) {
      if (detail === 'throw') throw new Error('socket hang up');
      const d = detail(closesAt);
      return d && d.status != null && d.text ? d : resp(200, { ...DETAIL, ...d });
    }
    if (u.includes('/enquiries')) {
      return resp(200, { ...LIST, total_page: 1, current_page: 1, total_count: 1, enquiries: [{ ...LIST.enquiries[0] }] });
    }
    return resp(404, { error: 'no_route' });
  };
  const adapter = new GoCometAdapter({ token: token(), fetchImpl, now: () => vnow, log: quiet,
    sleep: async (ms) => { vnow += Math.max(0, Number(ms) || 0); } });
  return { adapter, ctrl, closesAt, writes };
}

async function run(detail) {
  const r = rig(detail);
  await r.adapter.login();
  const meta = { id: KEY, lane: { origin: 'Degam', destination: 'Auroville' }, equipment: '40FT 25 Ton', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd.', closesAt: r.closesAt, platformKey: 'gocomet',
    rules: { revisionLimit: 3, minDecrement: 500 } };
  const events = [];
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  const eng = new BidEngine(r.adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    onEvent: (e) => { events.push(e); logger.handle(e); },
    log: quiet,
  });
  try {
    const m = eng.arm(meta, { cost: 60_000, marginsPct: [8, 6, 5] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    await logger.handle({ type: 'bid_placed', auctionId: KEY, ts: vnow, price: 64_800, rungIndex: 0, rank: 1 });
    m.landedBids = 1;
    const tick = async () => { await eng._tick(m); if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
    await tick();
    vnow = r.closesAt + 1_000;
    r.ctrl.secs = null;
    await tick();
    vnow += 310_000;
    await tick();
    await logger._tail;
    if (!m.finalized) throw new Error(`HARNESS: never reached _finalize (status ${m.status})`);
    if (r.writes.length) throw new Error(`HARNESS: attempted ${r.writes.length} write(s) to GoComet`);
    const result = events.find((e) => e.type === 'auction_result');
    if (!result) throw new Error('HARNESS: finalized without an auction_result event');
    const intent = eng.scheduler.get(KEY);
    const record = await store.getDoc('closedBids', KEY);
    return { result: result.won, intent: intent ? intent.won : 'absent', record: record ? record.won : 'absent' };
  } finally {
    try { eng.kill(); } catch (_) {}
  }
}

const results = [];
async function check(n, name, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}`);
  if (failure) console.log(`        ${failure}`);
}

const notKnown = (b, why) => (b.result === null && b.intent === null && b.record === null ? null
  : `${why}: booked auction_result.won=${b.result}, intent.won=${b.intent}, closedBids.won=${b.record}, expected null `
    + '(not known) on all three - _finalize books won off the live bidding-data rank');

async function main() {
  await check(1, 'enquiry_not_closed_yet_is_not_known', async () => notKnown(
    await run((closesAt) => ({ bidding_closed: false, status: 'Open', vendor_rank: 1, bid_close_timestamp: istWire(closesAt + 2_400_000) })),
    'the enquiry record still reads bidding_closed false'));

  await check(2, 'enquiry_read_500_is_not_known', async () => notKnown(
    await run(() => resp(500, { error: 'boom' })), 'the enquiry record read returned 500'));

  await check(3, 'enquiry_read_throw_is_not_known_and_finalize_resolves', async () => notKnown(
    await run('throw'), 'the enquiry record read threw in transport'));

  await check(4, 'rank_1_marked_lost_is_not_a_win', async () => {
    const b = await run(() => ({ bidding_closed: true, status: 'Lost', vendor_rank: 1 }));
    return b.result !== true && b.intent !== true && b.record !== true ? null
      : `GoComet marks the enquiry Lost at vendor_rank 1 and it was booked won: auction_result.won=${b.result}, `
        + `intent.won=${b.intent}, closedBids.won=${b.record}`;
  });

  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  Date.now = REAL_NOW;
  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS) {
    console.log(`FAIL - ran ${results.length} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`FAIL ${failed.length} of ${results.length} checks - a GoComet result the enquiry record does not settle is booked off the live rank`);
    process.exit(1);
  }
  console.log(`PASS ${results.length}/${EXPECTED_CHECKS} checks - an unsettled GoComet result is booked not known`);
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
