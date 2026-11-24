'use strict';
/**
 * A win the bot never bid gets an honest receipt: it names the hand bid, the refused attempt and the
 * cap the portal allowed, and it credits no rate or margin to a bot bid that was never on the board.
 *
 * Regression target: BC-33b (no honest receipt for a win the bot never bid); timing diagnosis
 * 2026-09-24 (timing-D) mechanism M10. Plan test "test-receipt-hand-win" under PR-T6.
 *
 * THE DEFECT. On SuperProcure 25646560 (customer BG, 22 Sep 2026, close 11:05:00) rank 1 already
 * stood before the bot's bid: the desk had bid by hand from the same login. The bot's only attempt
 * (Rs 16,900) was refused with "less than or equal to 16400", so nothing of the bot's landed
 * (landedBids 0), yet the auction was won. outcomeEnrichment (engineAlerts.js :609-611) fills the
 * won rate and margin only from a landed bid, and wonMoney (waTemplates.js :927) then renders the
 * win as a plain bot win with Your Rate alone - nothing says the win was a hand bid, that the bot's
 * attempt was refused, or what the portal allowed. Two such wins on 22 Sep.
 *
 * HAND-WORKED FACTS: attempts used = landedBids 0, allowed 3, refused 1 (one rejectedBids entry);
 * the cap the portal named is 16,400; the close is 11:05:00 am, 22 Sep 2026 (posted = final).
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - the desk's own rate (16,800) stays on the Your Rate line;
 *   - no Won Rate line and no margin percentage: no bot rate was on the board;
 *   - an ordinary bot win (one landed bid) carries no hand-win line.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 * Offline and deterministic: real BidLogger on a memory store, real notifyEngineEvent and renderer
 * (scripts/lib/result-receipt-harness.js), TZ pinned to IST.
 *
 *   node scripts/test-receipt-hand-win.js
 */
const { istAt, closeAndRender, hasLine } = require('./lib/result-receipt-harness');
const copy = require('./fixtures/result-receipt-copy');

const HAND_MARK = copy.handWin(1, 'X', '0').value.split('.')[0];
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const flat = (text) => ascii(String(text).split('\n').filter(Boolean).join(' | '));

const CLOSE = istAt(2026, 9, 22, 11, 5, 0);
const bgLoad = {
  companyName: 'BG', lane: { origin: 'Bhiwandi', destination: 'Nagpur' }, equipment: '32 SXL (7 MT)', units: 1,
};
const armed = {
  ts: istAt(2026, 9, 22, 10, 30, 0), cost: 16800, floor: 16900, minMarginPct: 0.5, marginsPct: [0.6],
  ladder: [16900], ...bgLoad,
};
const resultBase = {
  ts: CLOSE + 3000, won: true, finalRank: 1, closeModel: 'hard', finalCloseAt: CLOSE, postedCloseAt: CLOSE,
  attemptsAllowed: 3, finalCloseUnknown: false, ...bgLoad,
};

const HAND = {
  name: 'SP hard won by hand, BG 25646560',
  auctionId: '25646560', platformKey: null, armed,
  events: [{
    type: 'bid_rejected', price: 16900, rungIndex: 0, ts: istAt(2026, 9, 22, 11, 4, 57, 200),
    status: 400, reason: 'price_raise_refused', body: 'Amount should be less than or equal to 16400',
    closesInMs: 3000, believedCloseAt: CLOSE, closeModel: 'hard',
  }],
  result: {
    ...resultBase, landedBids: 0, extensionsAfterLastBid: null,
    noBidReason: 'price_raise_refused', noBidAmountCap: 16400,
  },
};

const BOT = {
  name: 'SP hard won by the bot, BG 25646561',
  auctionId: '25646561', platformKey: null, armed,
  events: [{
    type: 'bid_placed', price: 16900, rungIndex: 0, decidedAt: istAt(2026, 9, 22, 11, 4, 57), closesInMs: 3000,
    believedCloseAt: CLOSE, ts: istAt(2026, 9, 22, 11, 4, 57, 600), latencyMs: 600, cost: 16800, minMarginPct: 0.5,
    closeModel: 'hard', socketRank: 1, extendsObserved: 0,
  }],
  result: { ...resultBase, landedBids: 1, extensionsAfterLastBid: 0 },
};

(async () => {
  let n = 0;

  // ---- controls: the right receipt for the right load, with the refusal on the record ---------
  const hand = await closeAndRender(HAND);
  n++;
  const rej = (hand.record.rejectedBids || [])[0];
  if (hand.full.template !== 'won' || String(hand.full.data.oaNo) !== HAND.auctionId
    || (hand.record.ourBids || []).length !== 0 || (hand.record.rejectedBids || []).length !== 1
    || !rej || rej.httpStatus !== 400 || !String(rej.body).includes('16400')
    || Number(hand.full.data.landedBids) !== 0 || hand.full.data.marketRate !== '16,800'
    || Number(hand.full.data.noBidAmountCap) !== 16400) {
    throw new Error(`HARNESS: check ${n}: ${HAND.name}: template ${hand.full.template}, oaNo ${hand.full.data.oaNo}, `
      + `ourBids ${(hand.record.ourBids || []).length}/0, rejectedBids ${(hand.record.rejectedBids || []).length}/1, `
      + `landedBids ${hand.full.data.landedBids}, marketRate ${hand.full.data.marketRate}, noBidAmountCap ${hand.full.data.noBidAmountCap}`);
  }
  const bot = await closeAndRender(BOT);
  n++;
  if (bot.full.template !== 'won' || String(bot.full.data.oaNo) !== BOT.auctionId
    || (bot.record.ourBids || []).length !== 1 || Number(bot.full.data.landedBids) !== 1) {
    throw new Error(`HARNESS: check ${n}: ${BOT.name}: template ${bot.full.template}, oaNo ${bot.full.data.oaNo}, `
      + `ourBids ${(bot.record.ourBids || []).length}/1, landedBids ${bot.full.data.landedBids}`);
  }
  console.log(`ok controls: ${n} won receipts rendered through BidLogger -> notifyEngineEvent -> templateFor`);

  const failures = [];
  const check = (cond, msg) => { n++; if (!cond) failures.push(`check ${n}: ${msg}`); };
  const text = hand.full.text;

  // ---- mechanism M10: the hand win is named, with the refused attempt and the close ------------
  const handSpec = copy.handWin(1, 'SuperProcure', '16,400');
  check(hasLine(text, handSpec),
    `BC-33b M10: won receipt for ${HAND.name} does not say "${handSpec.value}"; got: ${flat(text)}`);
  const attemptsSpec = copy.attempts(0, 3, 1);
  check(hasLine(text, attemptsSpec),
    `BC-33b M10: won receipt for ${HAND.name} has no "${attemptsSpec.label} ... ${attemptsSpec.value}" line`);
  const closedSpec = copy.closed(copy.clock(11, 5, 0));
  check(hasLine(text, closedSpec),
    `BC-33b M10: won receipt for ${HAND.name} has no "${closedSpec.label} ... ${closedSpec.value}" line`);

  // ---- negative controls: the desk's rate stays, no bot rate or margin, no hand line on a bot win
  check(hasLine(text, { label: 'Your Rate', value: '16,800' }),
    `BC-33b over-eager: won receipt for ${HAND.name} lost the desk's own rate 16,800 on the Your Rate line`);
  check(!/Won Rate/.test(text),
    `BC-33b over-eager: won receipt for ${HAND.name} carries a Won Rate line though no bot bid was on the board`);
  const pct = text.match(/\d%/);
  check(!pct,
    `BC-33b over-eager: won receipt for ${HAND.name} credits a margin percentage to a bot bid that never landed`);
  check(!bot.full.text.includes(HAND_MARK),
    `BC-33b over-eager: won receipt for ${BOT.name} (one landed bot bid) carries the hand-win line`);

  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`FAIL ${failures.length} of ${n} checks - BC-33b M10: a win the bot never bid renders as a plain bot win`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => {
  const msg = String(e && e.message);
  console.log(msg.startsWith('HARNESS:') ? msg : (e && e.stack) || e);
  process.exit(1);
});
