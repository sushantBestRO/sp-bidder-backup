'use strict';
/**
 * A result states an early portal close when SuperProcure refused a write as "already ended" well
 * before the close it published, and every closed-bids record carries why the load ended.
 *
 * Regression target: owner ruling 29 (24 Sep 2026, loss-cause tag). Real case: Havells 25702437,
 * SP soft, 23 Sep 2026 - published close 10:45:00, first refusal "Auction has already ended for this
 * load" at 10:39:24.655, no bid landed. The receipt said "Closed 10:45:00", a close that never
 * happened.
 *
 * Hand-worked: 10:45:00 - 10:39:24 (the printed second) = 5 min 36 s. A refusal 3 s before the close
 * is clock offset, not an early close; GoComet's "enquiry is closed or maximum revision limit" never
 * proves one.
 *
 * WHAT MUST NOT MOVE (green on the base too): no early line on either negative control, and the
 * normal Closed line stays on them.
 *
 *   node scripts/test-result-reason-and-early-close.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const copy = require('./fixtures/result-receipt-copy');

const { istAt, closeThroughLogger, closeAndRender, findLine, hasLine } = h;

const CLOSE = istAt(2026, 9, 23, 10, 45, 0);
const ENDED = istAt(2026, 9, 23, 10, 39, 24, 655);
const SP_ENDED = 'Auction has already ended for this load';
const GC_CLOSED = 'Validation failed: Cannot Submit Quote either the enquiry is closed or you have reached maximum revision limit';
const LANE = { origin: 'Alwar', destination: 'Pune' };
const ARMED = {
  companyName: 'Havells India Ltd', lane: LANE, equipment: '32 MXL', units: 1,
  cost: 24500, marginsPct: [12.6, 7.2, 5], minMarginPct: 5, ladder: [27587, 26926, 26264, 25725], floor: 25725,
};

const refusal = (ts, body, price = 27587) => ({ type: 'bid_rejected', price, rungIndex: 0, ts, status: 400, reason: 'http_400', body });
const bid = (price, ts, closesInMs) => ({
  type: 'bid_placed', price, rungIndex: ARMED.ladder.indexOf(price), ts, decidedAt: ts - 400, closesInMs,
  believedCloseAt: CLOSE, cost: 24500, minMarginPct: 5, closeModel: 'soft',
});

function load(id, events, extra = {}, platformKey = null) {
  const landed = events.filter((e) => e.type === 'bid_placed').length;
  return {
    auctionId: id, platformKey, armed: ARMED, events,
    result: {
      won: false, finalRank: null, closeModel: 'soft', companyName: ARMED.companyName, lane: LANE, equipment: ARMED.equipment,
      units: 1, landedBids: landed, attemptsAllowed: 30, postedCloseAt: CLOSE, finalCloseAt: CLOSE, extensionsAfterLastBid: null,
      finalCloseUnknown: false, lastBidBeforeTriggerWindow: null, leadAfterLastBid: null, lastBidInFinalSeconds: null,
      ts: istAt(2026, 9, 23, 10, 42, 27, 583), ...extra,
    },
  };
}

const ascii = (s) => String(s).replace(/[^\x20-\x7e\n]/g, '?');
const failures = [];
let n = 0;
const check = (mech, ok, msg, text) => {
  n += 1;
  if (!ok) failures.push(`FAIL ${n} [${mech}] ${msg}${text ? ` -- rendered: ${ascii(text).split('\n').join(' | ')}` : ''}`);
};
const EARLY_WORDS = 'Portal closed this auction early';

(async () => {
  const havells = await closeAndRender(load('25702437', [refusal(ENDED, SP_ENDED)], { noBidReason: 'submission_window_closed' }));
  const offset = await closeAndRender(load('25702438', [refusal(CLOSE - 3000, SP_ENDED)], { noBidReason: 'submission_window_closed' }));
  const gocomet = await closeAndRender(load('2609230001', [refusal(CLOSE - 300000, GC_CLOSED)],
    { noBidReason: 'submission_window_closed' }, 'gocomet'));
  const lostEarly = await closeAndRender(load('25702439', [bid(27587, istAt(2026, 9, 23, 10, 30, 0), 900400), refusal(ENDED, SP_ENDED, 26926)],
    { finalRank: 3 }));

  for (const [name, r, full, short] of [['havells', havells, 'no_bid', 'no_bid_short'], ['offset', offset, 'no_bid', 'no_bid_short'],
    ['gocomet', gocomet, 'no_bid', 'no_bid_short'], ['lostEarly', lostEarly, 'lost', 'lost_short']]) {
    assert.ok(r.full.template === full && r.short.template === short && r.full.text.includes('Havells'),
      `HARNESS: ${name} rendered ${r.full.template}/${r.short.template}, want ${full}/${short} naming Havells`);
    const refused = (r.record.rejectedBids || []).length;
    assert.ok(refused === 1, `HARNESS: ${name} record kept ${refused} refusals, want 1`);
  }

  const early = copy.earlyClose(copy.clock(10, 39, 24), copy.gap.minSec(5, 36), copy.clock(10, 45));
  const stale = copy.closed(copy.clock(10, 45, 0));
  for (const [variant, text] of [['no_bid', havells.full.text], ['no_bid_short', havells.short.text]]) {
    check('early close line', hasLine(text, early), `Havells ${variant} states the early close verbatim`, text);
    check('early close line', !hasLine(text, stale), `Havells ${variant} does not claim it closed at 10:45:00`, text);
  }
  check('resultReason', havells.record.resultReason === 'no_bid_portal_closed_early',
    `Havells record.resultReason = ${havells.record.resultReason}, want no_bid_portal_closed_early`);

  for (const [name, r] of [['refusal 3 s before the close', offset], ['GoComet closed-or-limit refusal 5 min early', gocomet]]) {
    for (const [variant, text] of [['no_bid', r.full.text], ['no_bid_short', r.short.text]]) {
      check('guard: no early line', !text.includes(EARLY_WORDS), `${name}: no early-close line on ${variant}`, text);
      check('guard: normal Closed line', hasLine(text, stale), `${name}: the normal Closed 10:45:00 line stays on ${variant}`, text);
    }
  }
  check('resultReason', offset.record.resultReason === 'no_bid_submission_window_closed',
    `refusal 3 s early: record.resultReason = ${offset.record.resultReason}, want no_bid_submission_window_closed`);

  const bidClock = { label: 'Last bid', value: copy.clock(10, 30, 0) };
  for (const [variant, text] of [['lost', lostEarly.full.text], ['lost_short', lostEarly.short.text]]) {
    check('early close line', hasLine(text, early), `landed bid then early close: ${variant} states the early close`, text);
    const line = findLine(text, bidClock);
    check('last bid without a gap', line != null && !/before the final close/.test(line),
      `landed bid then early close: ${variant} Last bid line shows ${bidClock.value} with no gap to a close that never happened`, text);
  }
  check('resultReason', lostEarly.record.resultReason === 'unknown',
    `early close after a landed bid above the lowest margin: resultReason = ${lostEarly.record.resultReason}, want unknown`);

  const T = istAt(2026, 9, 23, 10, 44, 58);
  const reasons = [
    ['won', load('R1', [bid(26926, T, 2400)], { won: true, finalRank: 1, leadAfterLastBid: true }), 'won'],
    ['last bid at the lowest band margin, rank 2', load('R2', [bid(25725, T, 2400)], { finalRank: 2, leadAfterLastBid: false }), 'lost_on_price'],
    ['at lowest AND led after it: price outranks undercut', load('R3', [bid(25725, T, 2400)], { finalRank: 2, leadAfterLastBid: true }), 'lost_on_price'],
    ['above lowest, never led, every bid recorded', load('R4', [bid(27587, T, 2400)], { finalRank: 2, leadAfterLastBid: false }), 'lost_on_timing'],
    ['above lowest, held rank 1 after our bid', load('R5', [bid(27587, T, 2400)], { finalRank: 2, leadAfterLastBid: true }), 'undercut_while_leading'],
    ['final rank unknown', load('R6', [bid(27587, T, 2400)], { finalRank: null, leadAfterLastBid: false }), 'unknown'],
    ['3 landed, 2 recorded, not at lowest',
      load('R7', [bid(27587, T - 60000, 62400), bid(26926, T, 2400)], { finalRank: 2, leadAfterLastBid: false, landedBids: 3 }), 'unknown'],
    ['no bid with no recorded reason', load('R8', [], {}), 'unknown'],
    ['above lowest, lead after our bid not known (restart)', load('R9', [bid(27587, T, 2400)], { finalRank: 2, leadAfterLastBid: null }), 'unknown'],
  ];
  for (const [name, spec, want] of reasons) {
    const { record } = await closeThroughLogger(spec);
    assert.ok(record && record.status === 'closed', `HARNESS: ${name} did not close a record`);
    check('resultReason', record.resultReason === want, `${name}: resultReason = ${record.resultReason}, want ${want}`);
  }

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${n} checks - ruling 29: the receipt claims a published close the portal never reached, `
      + 'and the closed-bids record carries no resultReason');
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => { console.log(ascii(e && e.stack ? e.stack : e)); process.exit(1); });
