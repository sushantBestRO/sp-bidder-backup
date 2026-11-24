'use strict';
/**
 * A close whose result the portal had not confirmed reads "not yet known" everywhere, never won and
 * never lost.
 *
 * Regression target: the GoComet won-not-rank-1 finding. The engine now books won = null when
 * GoComet's own enquiry record cannot confirm a settled rank 1 (test-gocomet-won-is-settled-rank-1).
 * That null has to survive to every surface the client and the desk read:
 *   - bidLogger._onResult wrote `rec.won = !!e.won`, so the null became false and the record read as
 *     a fought loss;
 *   - summarizeClosed, exportModel.deriveStatus, the customer EOD, the director EOD and the heartbeat
 *     only knew "unknown" as closedWhileDown with no rank, so a won-null record with a rank was lost;
 *   - engineAlerts routed `evt.won ? 'won' : 'lost'`, so the desk got "WE LOST THIS ONE" for a load
 *     it may have won and still has to place a vehicle for.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   1. control: a won:true and a won:false close, each with a landed bid, read won and lost on every
 *      surface and render the WON and LOST receipts;
 *   5. control: a won:null close with nothing landed is a no-bid everywhere and renders NO BID PLACED.
 *
 *   node scripts/test-closed-outcome-won-unknown.js
 */
const { BidLogger, summarizeClosed } = require('../src/logging/bidLogger');
const { deriveStatus } = require('../src/web/exportModel');
const { collectCustomerDay } = require('../src/notify/eodReport');
const { collectDirectorDay } = require('../src/notify/directorEod');
const { collectFunnel } = require('../src/notify/heartbeat');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { MemoryStore } = require('../src/store');

const EXPECTED_CHECKS = 5;
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0);
const SHIPPER = 'Waaree Energies Ltd.';
const LANE = { origin: 'Degam', destination: 'Satara' };

function resultEvent(id, won, landedBids) {
  return { type: 'auction_result', auctionId: id, ts: T0 + 9000, won, finalRank: 1, closeModel: 'soft',
    lane: LANE, equipment: '32 SXL', companyName: SHIPPER, landedBids };
}

async function logged(id, won, landedBids) {
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  await logger.handle({ type: 'armed', auctionId: id, ts: T0, lane: LANE, equipment: '32 SXL', units: 1,
    companyName: SHIPPER, cost: 60000, marginsPct: [8, 6, 5], minMarginPct: 5, ladder: [64800, 63600, 63000],
    floor: 63000 });
  if (landedBids > 0) {
    await logger.handle({ type: 'bid_placed', auctionId: id, ts: T0 + 1000, price: 64800, rungIndex: 0, rank: 1 });
  }
  await logger.handle(resultEvent(id, won, landedBids));
  const rec = await store.getDoc('closedBids', id);
  if (!rec || rec.status !== 'closed') throw new Error(`HARNESS: ${id} did not close through the logger`);
  return rec;
}

async function surfaces(id, rec) {
  const store = new MemoryStore();
  await store.putDoc('closedBids', id, rec);
  const req = { loadId: id, createdAt: T0, capturedAt: T0 + 60_000, status: 'closed',
    load: { companyName: SHIPPER, lane: LANE, closesAt: T0 + 8000 } };
  const requests = { listAll: async () => [req] };
  const day = await collectCustomerDay({ requests, store, aliases: [SHIPPER],
    windowStart: T0 - 3_600_000, windowEnd: T0 + 12 * 3_600_000, now: T0 + 12 * 3_600_000 - 1 });
  const eod = day.won ? 'won' : day.lostDecided ? 'lost' : day.closedUnknown ? 'closed_unknown'
    : (day.participated === 0 ? 'no_bid' : 'unbucketed');
  const dir = await collectDirectorDay({ requests, store, customers: [], now: T0 + 12 * 3_600_000 });
  const director = dir.won ? 'won' : dir.lost ? 'lost' : dir.closedUnknown ? 'closed_unknown'
    : (dir.noBid ? 'no_bid' : 'unbucketed');
  const hb = await collectFunnel({ requests, store, now: Date.UTC(2026, 8, 21, 3, 0, 0) });
  const heartbeat = hb.won ? 'won' : hb.lost ? 'lost' : hb.closedUnknown ? 'closed_unknown'
    : (hb.loadsBid === 0 ? 'no_bid' : 'unbucketed');
  const s = summarizeClosed([rec]);
  const rollup = s.won ? 'won' : s.lost ? 'lost' : s.noBid ? 'no_bid' : 'closed_unknown';
  return { rollup, export: deriveStatus(null, rec), eod, director, heartbeat };
}

function receipts(id, won, landedBids) {
  const n = toNotification(resultEvent(id, won, landedBids));
  return {
    full: renderMessage(templateFor(n.kind, n.data), n.data) || '',
    short: renderMessage(templateFor(n.kind, n.data, { short: true }), n.data) || '',
  };
}

const disagree = (cls, want) => Object.entries(cls).filter(([, v]) => v !== want).map(([k, v]) => `${k}=${v}`);
const claimsResult = (msg) => /\bWON\b|\bLOST\b|WE WON|WE LOST/.test(msg);

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  await check(1, 'control_won_and_lost_read_as_themselves', 'control', async () => {
    const bad = [];
    for (const [id, won, want, head] of [['W1', true, 'won', 'WON'], ['L1', false, 'lost', 'LOST']]) {
      const d = disagree(await surfaces(id, await logged(id, won, 1)), want);
      if (d.length) bad.push(`${id}: ${d.join(' ')}`);
      const r = receipts(id, won, 1);
      if (!r.full.includes(head)) bad.push(`${id}: receipt has no ${head} header: ${r.full.split('\n')[0]}`);
    }
    return bad.length ? `HARNESS DEAD: ${bad.join('; ')}` : null;
  });

  await check(2, 'unconfirmed_result_is_stored_as_null_not_false', 'mechanism', async () => {
    const rec = await logged('U1', null, 1);
    return rec.won === null ? null : `auction_result won:null was stored as won=${JSON.stringify(rec.won)} - `
      + 'bidLogger coerces the result with !!e.won, so "not confirmed" becomes a fought loss';
  });

  await check(3, 'unconfirmed_result_reads_not_known_on_every_surface', 'mechanism', async () => {
    const rec = { auctionId: 'U2', status: 'closed', won: null, finalRank: 1, closedWhileDown: false,
      closedAt: T0 + 9000, shipper: SHIPPER, lane: LANE, units: 1,
      ourBids: [{ price: 64800, rungIndex: 0, rank: 1, ts: T0 + 1000 }], lastBidPrice: 64800 };
    const d = disagree(await surfaces('U2', rec), 'closed_unknown');
    return d.length ? `a closed record with won null and rank 1 is not "not yet known": ${d.join(' ')} - `
      + 'the surfaces only treat closedWhileDown with no rank as unknown' : null;
  });

  await check(4, 'unconfirmed_result_receipt_claims_neither_won_nor_lost', 'mechanism', async () => {
    const r = receipts('U3', null, 1);
    const bad = [];
    for (const [k, msg] of Object.entries(r)) {
      if (claimsResult(msg)) bad.push(`${k}: "${msg.split('\n')[0]}"`);
      else if (!/not yet known/i.test(msg)) bad.push(`${k} does not say the result is not yet known: "${msg.split('\n')[0]}"`);
    }
    return bad.length ? `${bad.join('; ')} - engineAlerts routes evt.won ? 'won' : 'lost', so an unconfirmed `
      + 'result is told to the desk as a loss' : null;
  });

  await check(5, 'control_unconfirmed_with_nothing_landed_is_no_bid', 'control', async () => {
    const bad = disagree(await surfaces('N1', await logged('N1', null, 0)), 'no_bid');
    const r = receipts('N1', null, 0);
    if (!r.full.includes('NO BID PLACED') || !r.short.includes('NO BID PLACED')) {
      bad.push(`receipt: "${r.full.split('\n')[0]}" / "${r.short.split('\n')[0]}"`);
    }
    return bad.length ? `a won:null close with nothing landed moved off no-bid: ${bad.join('; ')}` : null;
  });

  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS) {
    console.log(`FAIL - ran ${results.length} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`FAIL ${failed.length} of ${results.length} checks - an unconfirmed result is reported as won or lost`);
    process.exit(1);
  }
  console.log(`PASS ${results.length}/${EXPECTED_CHECKS} checks - an unconfirmed result reads not yet known everywhere`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
