'use strict';
/**
 * Owner ruling 91 (26 Sep 2026): "A hold-undercut loss gets '❌ Another transporter bid lower while
 * this load was on hold.'" It takes the advice-line slot on the LOST receipt, replacing the neutral
 * line for that class only. lost_on_price keeps its approved header and line; a timing loss and an
 * undercut-while-leading loss get no new line (ruling 91), and every non-hold loss renders exactly
 * as it did before.
 *
 * Driven through the real classifier (reportedClose.resultReasonOf) and the real receipt enrichment
 * (engineAlerts.outcomeEnrichment), on both the long 'lost' template and the 'lost_short' reply.
 *
 * @requires-summary-line
 *   node scripts/test-ruling91-hold-undercut-lost-line.js
 */
const assert = require('assert');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { resultReasonOf } = require('../src/util/reportedClose');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');

const HOLD_LINE = '❌ Another transporter bid lower while this load was on hold.';
const NEUTRAL = '📉 _A sharper rate on this lane wins the next one._';

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

// Receipt clocks are server-local, so the close is built in local time to render 03:30:00 pm under any TZ.
const base = { shipper: 'Havells', oaNo: 'OA1', finalRank: 2, resultFacts: true, closeAtMs: new Date(2026, 8, 20, 15, 30, 0).getTime() };
const lostRec = {
  status: 'closed', won: false, finalRank: 2, lastBidPrice: 27587, cost: 24500,
  ourBids: [{ price: 27587, rungIndex: 0, bidTimeCost: 24500 }], marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
};

function receipts(rec) {
  const r = Object.assign({}, rec);
  r.resultReason = resultReasonOf(r, { landedBids: 1 });
  const d = Object.assign({}, base, outcomeEnrichment(r));
  return { reason: r.resultReason, lost: renderMessage(templateFor('lost', d), d), short: renderMessage('lost_short', d) };
}

const MONEY_LONG = '🔴 *LOST - Havells*\n\n🆔 *OA No* - OA1\n🚛 *Vehicle Type* - -\n💰 *Your Rate* - ₹24,500\n🧮 *Our Bid* - ₹27,587 (+12.60%)\n🏅 *Our Final Ranking* - 2\n\n';
const MONEY_SHORT = '🔴 *LOST - Havells*\n🏅 *Our Final Ranking* - 2\n💰 *Your Rate* - ₹24,500\n🧮 *Our Bid* - ₹27,587 (+12.60%)\n\n';

(async () => {
  // A genuine hold ('hold_entered') and a resumed one ('resumed_by_desk') both classify hold_undercut.
  for (const holdReason of ['hold_entered', 'resumed_by_desk']) {
    const got = receipts(Object.assign({}, lostRec, { leadAfterLastBid: true,
      costCorrections: [{ from: 24500, to: 26000, standingBidPrice: 27587, at: 1, reason: holdReason }] }));
    ok(got.reason === 'hold_undercut', `fixture must classify hold_undercut (${holdReason}), got ${got.reason}`);
    ok(got.lost === MONEY_LONG + HOLD_LINE, `long LOST receipt ends in exactly the ruling-91 line (${holdReason}):\n${got.lost}`);
    ok(got.short === MONEY_SHORT + HOLD_LINE, `short LOST reply ends in exactly the ruling-91 line (${holdReason}):\n${got.short}`);
    ok(!got.lost.includes(NEUTRAL) && !got.short.includes(NEUTRAL), `the neutral line is replaced, not appended to (${holdReason})`);
    ok(got.lost.startsWith('🔴 *LOST - Havells*'), `a hold_undercut loss keeps the plain LOST header (${holdReason})`);
  }

  // lost_on_price: approved header and line, unchanged.
  {
    const got = receipts(Object.assign({}, lostRec, { lastBidPrice: 25725,
      ourBids: [{ price: 25725, rungIndex: 2, bidTimeCost: 24500 }], leadAfterLastBid: false }));
    ok(got.reason === 'lost_on_price', `fixture must classify lost_on_price, got ${got.reason}`);
    const priceLine = '❌ Outbid on price. Our lowest price, ₹25,725 (+5.00%), was on the board and another transporter bid lower. Winning this lane needs a lower margin.';
    ok(got.lost === '🔴 *LOST ON PRICE - Havells*\n\n🆔 *OA No* - OA1\n🚛 *Vehicle Type* - -\n💰 *Your Rate* - ₹24,500\n🧮 *Our Bid* - ₹25,725 (+5.00%)\n🏅 *Our Final Ranking* - 2\n\n' + priceLine,
      `lost_on_price long receipt unchanged:\n${got.lost}`);
    ok(got.short === '🔴 *LOST ON PRICE - Havells*\n🏅 *Our Final Ranking* - 2\n💰 *Your Rate* - ₹24,500\n🧮 *Our Bid* - ₹25,725 (+5.00%)\n\n' + priceLine,
      `lost_on_price short reply unchanged:\n${got.short}`);
  }

  // A timing loss and an undercut-while-leading loss: no new line, byte-identical to before.
  for (const [name, rec] of [
    ['lost_on_timing', Object.assign({}, lostRec, { leadAfterLastBid: false })],
    ['undercut_while_leading', Object.assign({}, lostRec, { leadAfterLastBid: true })],
  ]) {
    const got = receipts(rec);
    ok(got.reason === name, `fixture must classify ${name}, got ${got.reason}`);
    ok(got.lost === MONEY_LONG + NEUTRAL, `${name} long receipt byte-identical to before:\n${got.lost}`);
    ok(got.short === MONEY_SHORT + NEUTRAL, `${name} short reply byte-identical to before:\n${got.short}`);
  }

  // An ordinary loss carrying no classified reason: byte-identical to before.
  {
    const d = Object.assign({}, base);
    ok(renderMessage(templateFor('lost', d), d) === '🔴 *LOST - Havells*\n\n🆔 *OA No* - OA1\n🚛 *Vehicle Type* - -\n🏅 *Our Final Ranking* - 2\n⏰ *Closed* - 03:30:00 pm\n\n' + NEUTRAL,
      'ordinary loss long receipt byte-identical to before');
    ok(renderMessage('lost_short', d) === '🔴 *LOST - Havells*\n🏅 *Our Final Ranking* - 2\n⏰ *Closed* - 03:30:00 pm\n\n' + NEUTRAL,
      'ordinary loss short reply byte-identical to before');
  }

  console.log(`${pass}/21 checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
