'use strict';
/**
 * A CLOSE WHOSE RESULT IS NOT KNOWN IS STILL GIVEN A LOSS REASON (E-1).
 *
 * The engine books a GoComet close whose settled result it could not read as won = null, and every
 * status surface says "not known". resultReasonOf does not look at won beyond `won === true`, so when
 * the last live rank was 2 or worse the record is still stamped lost_on_price, lost_on_timing or
 * undercut_while_leading, and the "last bid per load" export prints "Lost on price" on a row whose
 * status reads not known.
 *
 * What must happen instead: a close that is not a settled loss carries the reason 'unknown', on the
 * record and on the export.
 *
 * What must NOT move: the same close with won = false keeps its loss reasons; a not-known close at
 * live rank 1 reads unknown, as it already does.
 *
 * Figures: cost 60,000 on [8, 6, 5] -> [64800, 63600, 63000]. A last bid of 63,000 is at the lowest
 * band margin; 64,800 is above it.
 *
 *   node scripts/test-closed-unknown-carries-no-loss-reason.js
 */
const assert = require('assert');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');
const exportModel = require('../src/web/exportModel');

const T0 = Date.UTC(2026, 8, 20, 4, 0, 0);
const LANE = { origin: 'Degam', destination: 'Satara' };

async function closed({ won, finalRank = 2, lastBid, leadAfterLastBid }) {
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  const id = 'GC-UNK';
  await logger.handle({ type: 'armed', auctionId: id, ts: T0, lane: LANE, equipment: '32 SXL', units: 1,
    companyName: 'Unknown Result Shipper', cost: 60000, marginsPct: [8, 6, 5], minMarginPct: 5,
    ladder: [64800, 63600, 63000], floor: 63000, platformKey: 'gocomet' });
  await logger.handle({ type: 'bid_placed', auctionId: id, ts: T0 + 1000, price: lastBid, rungIndex: lastBid === 63000 ? 2 : 0, rank: finalRank });
  const evt = { type: 'auction_result', auctionId: id, ts: T0 + 9000, won, finalRank, closeModel: 'soft',
    lane: LANE, equipment: '32 SXL', companyName: 'Unknown Result Shipper', landedBids: 1, finalCloseAt: T0 + 8000 };
  if (leadAfterLastBid !== undefined) evt.leadAfterLastBid = leadAfterLastBid;
  await logger.handle(evt);
  await logger._tail;
  const rec = await store.getDoc('closedBids', id);
  const view = exportModel.lastBidView([{ loadId: id, ourBids: rec.ourBids || [], _closed: rec }]);
  const row = view.rows[0];
  return { rec, words: row[row.length - 1], line: `won ${rec.won}, rank ${rec.finalRank}, resultReason ${rec.resultReason}, export "${row[row.length - 1]}"` };
}

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  console.log('\n1. result not known (won null), last live rank 2');
  await check('last bid at the lowest band margin: reason unknown, export "Unknown", not "Lost on price"', async () => {
    const c = await closed({ won: null, lastBid: 63000 });
    assert.deepStrictEqual([c.rec.resultReason, c.words], ['unknown', 'Unknown'], c.line);
  });
  await check('last bid above it, our lead taken after it: reason unknown, not undercut_while_leading', async () => {
    const c = await closed({ won: null, lastBid: 64800, leadAfterLastBid: true });
    assert.strictEqual(c.rec.resultReason, 'unknown', c.line);
  });
  await check('last bid above it, no lead after it: reason unknown, not lost_on_timing', async () => {
    const c = await closed({ won: null, lastBid: 64800, leadAfterLastBid: false });
    assert.strictEqual(c.rec.resultReason, 'unknown', c.line);
  });

  console.log('\n2. controls: behaviour that must not move');
  await check('the same close settled as lost (won false) keeps lost_on_price, "Lost on price"', async () => {
    const c = await closed({ won: false, lastBid: 63000 });
    assert.deepStrictEqual([c.rec.resultReason, c.words], ['lost_on_price', 'Lost on price'], c.line);
  });
  await check('settled as lost with our lead taken keeps undercut_while_leading; with none, lost_on_timing', async () => {
    const a = await closed({ won: false, lastBid: 64800, leadAfterLastBid: true });
    const b = await closed({ won: false, lastBid: 64800, leadAfterLastBid: false });
    assert.deepStrictEqual([a.rec.resultReason, b.rec.resultReason], ['undercut_while_leading', 'lost_on_timing'], `${a.line} | ${b.line}`);
  });
  await check('not known at live rank 1 reads unknown', async () => {
    const c = await closed({ won: null, finalRank: 1, lastBid: 63000 });
    assert.strictEqual(c.rec.resultReason, 'unknown', c.line);
  });

  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a close whose result is not known is given a loss reason (resultReasonOf reads only won === true, so won null at rank 2 falls through to the loss branches):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - only a settled loss carries a loss reason`);
  process.exit(0);
})().catch((e) => { console.error('FAIL (setup):', e && e.stack); process.exit(1); });
