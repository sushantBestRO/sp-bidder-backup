'use strict';
/**
 * AT FINALIZE, THE SETTLED RANK IS THE ONE BOOKED, AND A NOT-KNOWN CLOSE IS NOT CALLED A LOSS (E-3, E-2).
 *
 * On a platform whose live rank is not its result, _finalize reads the settled outcome and books its
 * rank. Nothing pinned the rank half: with `finalRank = settled.rank` removed, a close settled at
 * rank 2 after a live rank 1 is still booked lost, but with rank 1 on the result, the record and the
 * LOST receipt ("Our Final Ranking - 1").
 *
 * And when the settled outcome cannot be read, the close is booked won = null (not known), yet the
 * alarm block's `else if (!won)` still emits lost_after_bidding for it: a not-known close reported
 * as a loss.
 *
 * What must happen: a close settled at rank 2 books rank 2 on every surface; a not-known close that
 * landed bids emits no lost_after_bidding.
 *
 * What must NOT move: a settled loss that landed bids still emits lost_after_bidding.
 *
 *   node scripts/test-finalize-settled-rank-booked.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');
const { toNotification, outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `finalize-settled-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function closeWith({ liveRank, settled }) {
  const closesAt = Math.floor(vnow / 1000) * 1000 + 60_000;
  const ctrl = { closed: false };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: true, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard', snipeBudgetMs: 3000 }),
    async getAuctionState() {
      return { ok: true, status: ctrl.closed ? 'closed' : 'live', closeModel: 'hard', myRank: liveRank, totalBidders: 4,
        standingL1Price: null, closesInMs: ctrl.closed ? 0 : closesAt - vnow, closesAtMs: closesAt,
        revisionsLeft: 0, measuredRttMs: 20 };
    },
    async placeBid() { return { accepted: false, error: 'offline test adapter' }; },
    async readSettledOutcome() { return settled; },
  };
  const id = `FS-${seq}`;
  const meta = { id, lane: { origin: 'Degam', destination: 'Satara' }, equipment: '32 SXL', units: 1,
    quoteType: 'FTL', companyName: 'Settled Rank Shipper', closesAt, rules: { revisionLimit: 3, minDecrement: 100 } };
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
    await logger.handle({ type: 'bid_placed', auctionId: id, ts: vnow, price: 63_000, rungIndex: 2, rank: liveRank });
    m.landedBids = 1;
    m.lastBidPrice = 63_000;
    vnow = closesAt + 500;
    ctrl.closed = true;
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    await logger._tail;
    if (!m.finalized) throw new Error(`HARNESS: ${id} never reached _finalize (status ${m.status})`);
    const result = events.find((e) => e.type === 'auction_result');
    const record = await store.getDoc('closedBids', id);
    const n = toNotification(result);
    Object.assign(n.data, outcomeEnrichment(record));
    const receipt = renderMessage(templateFor(n.kind, n.data), n.data) || '';
    const alerts = events.filter((e) => e.type === 'alert').map((e) => e.kind);
    return { result, record, receipt, alerts,
      line: `won ${result.won}, result rank ${result.finalRank}, record rank ${record && record.finalRank}, alerts ${JSON.stringify(alerts)}` };
  } finally {
    try { eng.kill(); } catch (_) {}
  }
}

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  console.log('\n1. live rank 1 at the close, the portal settles rank 2');
  const lost = await closeWith({ liveRank: 1, settled: { settled: true, rank: 2 } });
  await check('the result books won false at rank 2', async () => {
    assert.deepStrictEqual([lost.result.won, lost.result.finalRank], [false, 2], lost.line);
  });
  await check('the closed-bids record carries rank 2', async () => {
    assert.strictEqual(lost.record && lost.record.finalRank, 2, lost.line);
  });
  await check('the LOST receipt states "Our Final Ranking - 2"', async () => {
    assert.ok(/LOST/.test(lost.receipt) && /Our Final Ranking\* - 2\b/.test(lost.receipt), lost.receipt);
  });
  await check('control: a settled loss that landed a bid emits lost_after_bidding', async () => {
    assert.ok(lost.alerts.includes('lost_after_bidding'), lost.line);
  });

  console.log('\n2. live rank 2 at the close, the settled outcome cannot be read');
  const unknown = await closeWith({ liveRank: 2, settled: { settled: false } });
  await check('control: the result is booked not known (won null)', async () => {
    assert.strictEqual(unknown.result.won, null, unknown.line);
  });
  await check('no lost_after_bidding alert is emitted for it', async () => {
    assert.ok(!unknown.alerts.includes('lost_after_bidding'), unknown.line);
  });

  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  Date.now = REAL_NOW;
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - _finalize books the live rank instead of the settled one, or reports a not-known close as a loss:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - the settled rank is booked everywhere, and a not-known close raises no loss alert`);
  process.exit(0);
})().catch((e) => { Date.now = REAL_NOW; console.error('FAIL (setup):', e && e.stack); process.exit(1); });
