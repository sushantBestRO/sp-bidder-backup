'use strict';
/**
 * A loss names the margin as its cause only where the record proves it, and an extension is
 * credited to other bidders only where our own last bid cannot have caused it.
 *
 * Owner copy ruling (24 Sep 2026): when our last landed bid was already at the desk's lowest BAND
 * margin and someone still ranked above us, the loss says so in place of the generic advice line.
 * Every other loss stays neutral; a fought loss with attempts to spare and a last bid above the
 * lowest band margin is flagged on the record (lostWithAttemptsLeft) for ops and never on the
 * receipt. "Lowest" is the lowest band margin of the pricing the bid was placed under, never the
 * floor guard, so a ladder that still carries a floor rung reads the same as one that does not.
 *
 * WHAT MUST NOT MOVE: a loss whose last bid was above the lowest band margin keeps the neutral line;
 * a load whose last bid landed inside the extension window keeps "after our last bid".
 *
 * Named reversal (owner ruling, 26 Sep 2026): the 24 Sep "lowest margin" line above is retired in
 * favour of the lost_on_price loss-cause line (waTemplates.lostAdvice), sourced straight off the
 * existing classifier (reportedClose.resultReasonOf) rather than this file's own lastBidAtLowestMargin
 * + finalRank>1 guess - resultReasonOf's lost_on_price already folds lastBidAtLowestMargin in, so the
 * two were never independent signals. The at-lowest-margin cases below (LM1, LM3) now assert the new
 * wording, and its absence, in place of the old.
 *
 *   node scripts/test-receipt-lowest-margin-and-cause.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const copy = require('./fixtures/result-receipt-copy');

const { istAt, closeAndRender, hasLine } = h;

const POSTED = istAt(2026, 9, 17, 21, 30, 0);
const IN_FORCE = istAt(2026, 9, 17, 21, 34, 58);
const FINAL = istAt(2026, 9, 17, 21, 44, 59);
const ARMED = {
  companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' }, equipment: '40 ft, 25 T', units: 1,
  cost: 65000, marginsPct: [9, 7.2, 3.6], minMarginPct: 2, ladder: [70850, 69680, 67340, 66300], floor: 66300,
};
const bid = (price, rungIndex, ts, closesInMs) => ({
  type: 'bid_placed', price, rungIndex, ts, decidedAt: ts - 3600, closesInMs, believedCloseAt: IN_FORCE, cost: 65000, minMarginPct: 2,
});
const BIDS = [
  bid(70850, 0, istAt(2026, 9, 17, 21, 27, 31), 450000),
  bid(69680, 1, istAt(2026, 9, 17, 21, 28, 9), 413600),
  bid(67340, 2, istAt(2026, 9, 17, 21, 28, 45), 376400),
  bid(66300, 3, istAt(2026, 9, 17, 21, 29, 20), 341400),
];

function load(id, bids, extra = {}) {
  return {
    auctionId: id, platformKey: 'gocomet', armed: ARMED, events: bids,
    result: {
      won: false, finalRank: 2, closeModel: 'soft', companyName: ARMED.companyName, lane: ARMED.lane, equipment: ARMED.equipment, units: 1,
      landedBids: bids.length, attemptsAllowed: 3, extensionsAfterLastBid: 2, postedCloseAt: POSTED, finalCloseAt: FINAL,
      finalCloseUnknown: false, lastBidBeforeTriggerWindow: true, ts: istAt(2026, 9, 17, 21, 50, 4), ...extra,
    },
  };
}

const ascii = (s) => String(s).replace(/[^\x20-\x7e\n]/g, '?');
const failures = [];
let n = 0;
const check = (ok, msg, text) => { n += 1; if (!ok) failures.push(`FAIL ${n}: ${msg}${text ? ` -- rendered: ${ascii(text).split('\n').join(' | ')}` : ''}`); };

(async () => {
  const atLowest = await closeAndRender(load('LM1', BIDS.slice(0, 3)));
  const aboveLowest = await closeAndRender(load('LM2', BIDS.slice(0, 2)));
  const floorBid = await closeAndRender(load('LM3', [BIDS[0], BIDS[1], BIDS[3]]));
  const inWindow = await closeAndRender(load('LM4', BIDS.slice(0, 3), { lastBidBeforeTriggerWindow: false }));
  const rankUnknown = await closeAndRender(load('LM5', BIDS.slice(0, 3), { finalRank: null }));

  for (const [name, r] of [['LM1', atLowest], ['LM2', aboveLowest], ['LM3', floorBid], ['LM4', inWindow]]) {
    assert.ok(r.full.template === 'lost' && r.short.template === 'lost_short' && r.full.text.includes('Waaree'),
      `HARNESS: ${name} did not render as a Waaree loss (${r.full.template}/${r.short.template})`);
  }

  for (const [variant, text] of [['lost', atLowest.full.text], ['lost_short', atLowest.short.text]]) {
    check(hasLine(text, copy.outbidOnPrice('67,340', '+3.60')), `last bid at the lowest band margin (3.6%) names the margin on ${variant}`, text);
    check(!hasLine(text, copy.lowestMargin('+3.60')), `named reversal: the retired 24 Sep lowest-margin line never renders on ${variant}`, text);
    check(!hasLine(text, copy.SHARPER_RATE), `the lowest-margin line replaces the generic advice on ${variant}`, text);
    check(hasLine(text, copy.closed(copy.clock(21, 44, 59), copy.clock(21, 30))), `closed with the posted close on ${variant}`, text);
    check(hasLine(text, copy.extensions(2, true)),
      `extensions credited to other bids when our last bid landed before the window, on ${variant}`, text);
  }
  check(atLowest.record.lostWithAttemptsLeft !== true, 'no defect flag when every attempt was used at the lowest margin');

  for (const [variant, text] of [['lost', floorBid.full.text], ['lost_short', floorBid.short.text]]) {
    check(hasLine(text, copy.outbidOnPrice('66,300', '+2.00')), `a last bid below the band (the floor rung) counts as the lowest margin on ${variant}`, text);
    check(!hasLine(text, copy.lowestMargin('+2.00')), `named reversal: the retired 24 Sep lowest-margin line never renders on ${variant}`, text);
  }

  for (const [variant, text] of [['lost', aboveLowest.full.text], ['lost_short', aboveLowest.short.text]]) {
    check(!/lowest margin/.test(text), `a last bid above the lowest band margin never blames the margin on ${variant}`, text);
    check(hasLine(text, copy.SHARPER_RATE), `the neutral advice stays on ${variant}`, text);
    check(!/attempts left|lostWithAttemptsLeft/i.test(text), `the defect flag never reaches the receipt on ${variant}`, text);
  }
  check(aboveLowest.record.lostWithAttemptsLeft === true, 'a loss with 2 of 3 attempts used above the lowest margin is flagged for ops');

  for (const [variant, text] of [['lost', inWindow.full.text], ['lost_short', inWindow.short.text]]) {
    check(hasLine(text, copy.extensions(2)),
      `extensions stay "after our last bid" when our bid landed inside the window, on ${variant}`, text);
    check(!/by other bids/.test(text), `no extension credited to other bids when ours may have caused one, on ${variant}`, text);
  }

  check(!/lowest margin/.test(rankUnknown.full.text) && hasLine(rankUnknown.full.text, copy.SHARPER_RATE),
    'no margin blame when the final rank is unknown', rankUnknown.full.text);

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${n} checks - a loss names the margin or other bidders only where the record proves it`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => { console.log(ascii(e && e.stack ? e.stack : e)); process.exit(1); });
