'use strict';
/**
 * A result receipt states the gap from our last bid to the close as measured AT LANDING, to one
 * decimal under 10 s, whole seconds under 2 min, "X min Y s" above.
 *
 * Regression target: BC-31 (gap between last bid and close wrong); timing diagnosis 2026-09-24
 * (timing-D) mechanism M8. Plan test "test-receipt-gap-precision-at-landing" under PR-T6. Owner
 * rulings: the gap is "measured at landing", and "one decimal under 10 s, so Durian/Syngenta will
 * read 2.1-2.5 s".
 *
 * THE DEFECT. The lead the receipt prints is the bid's closesInMs, the countdown the decision was
 * taken on (bidLogger persists it as-is), not the countdown left when the portal accepted the bid;
 * and leadPhrase (waTemplates) rounds it to whole seconds under 2 min and whole minutes above. A
 * Durian hard-close bid decided on 2.4 s and accepted 300 ms later reads "2s before close"; the
 * desk cannot tell 2.1 s from 2.9 s, which is the margin those loads are won or lost on.
 *
 * Every load here closed where it was posted and did not extend after our last bid
 * (extensionsAfterLastBid 0, believedCloseAt = finalCloseAt = postedCloseAt), so the gap to the
 * final close IS the landing gap = closesInMs - (ts - decidedAt).
 *
 * HAND-WORKED FACTS:
 *   P1 SP hard, Durian shape: 2400 - 300 = 2100 ms -> "2.1 s", accepted 12:19:58 pm.
 *   P2 SP hard: 2700 - 200 = 2500 ms -> "2.5 s", accepted 12:39:58 pm.
 *   P3 GoComet: 385600 - 3600 = 382000 ms -> 6 min 22 s, accepted 03:53:38 pm.
 *   P4 SP hard: 27000 - 600 = 26400 ms -> "26 s", accepted 01:59:34 pm.
 * The SP accept clocks are whole seconds on this machine's clock, a few hundred ms off the portal's
 * (the gap is clock-free by construction; the printed clock is the engine's).
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too): the decision countdown is never presented as
 * the gap - P1 never reads "2.4 s" and P3 never "6 min 26 s" on the Last bid line.
 * Not pinned (open copy questions): gaps exactly at 10 s or 2 min, and the wording of a landing at
 * or after the close.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 *
 *   node scripts/test-receipt-gap-precision-at-landing.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { gap, clock, lastBid } = require('./fixtures/result-receipt-copy');

const { istAt, closeAndRender, findLine, hasLine } = h;

const MARK = '\u0001';
const lastBidGapPrefix = (gapText) => lastBid(gapText, MARK).value.split(MARK)[0];
const OLD_LEAD = /(^|[^\d.])\d+s before close|(^|[^\d.])\d+ min before close/;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const timingLines = (text) => String(text || '').split('\n')
  .filter((l) => /close|last bid/i.test(l)).map(ascii).join(' | ');

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok, text) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc} -- rendered: ${timingLines(text) || '(no timing lines)'}`);
}

function placed(price, rungIndex, ts, acceptMs, closesInMs, believedCloseAt, cost, closeModel) {
  return {
    type: 'bid_placed', price, rungIndex, ts, decidedAt: ts - acceptMs, closesInMs, believedCloseAt,
    latencyMs: acceptMs, cost, closeModel,
  };
}

function load({ auctionId, platformKey, companyName, lane, cost, close, first, last, won }) {
  const closeModel = platformKey === 'gocomet' ? 'soft' : 'hard';
  return {
    auctionId, platformKey,
    armed: { companyName, lane, cost },
    events: [
      placed(first.price, 0, first.ts, first.acceptMs, first.closesInMs, close, cost, closeModel),
      placed(last.price, 1, last.ts, last.acceptMs, last.closesInMs, close, cost, closeModel),
    ],
    result: {
      won, finalRank: won ? 1 : 2, closeModel, companyName, lane,
      postedCloseAt: close, finalCloseAt: close, extensionsAfterLastBid: 0,
      attemptsAllowed: 3, landedBids: 2, ts: close + 3000,
    },
  };
}

const DURIAN = { companyName: 'Durian Industries Ltd', lane: { origin: 'Palghar', destination: 'Todapur' }, cost: 88000 };

const P1_CLOSE = istAt(2026, 9, 24, 12, 20, 0);
const P1_LAST_TS = istAt(2026, 9, 24, 12, 19, 58);
const p1 = (won) => load({
  auctionId: '25747721', platformKey: null, ...DURIAN, close: P1_CLOSE, won,
  first: { price: 95920, ts: istAt(2026, 9, 24, 12, 18, 20, 500), acceptMs: 500, closesInMs: 100000 },
  last: { price: 94300, ts: P1_LAST_TS, acceptMs: 300, closesInMs: 2400 },
});

const P2_CLOSE = istAt(2026, 9, 24, 12, 40, 0);
const P2_LAST_TS = istAt(2026, 9, 24, 12, 39, 58);
const p2 = load({
  auctionId: '25747788', platformKey: null, ...DURIAN, close: P2_CLOSE, won: false,
  first: { price: 95920, ts: istAt(2026, 9, 24, 12, 38, 20, 500), acceptMs: 500, closesInMs: 100000 },
  last: { price: 94300, ts: P2_LAST_TS, acceptMs: 200, closesInMs: 2700 },
});

const P3_CLOSE = istAt(2026, 9, 22, 16, 0, 0);
const P3_LAST_TS = istAt(2026, 9, 22, 15, 53, 38);
const p3 = load({
  auctionId: '2609223301', platformKey: 'gocomet', companyName: 'Waaree Energies Ltd.',
  lane: { origin: 'Degam', destination: 'Akola' }, cost: 48000, close: P3_CLOSE, won: false,
  first: { price: 52000, ts: istAt(2026, 9, 22, 15, 40, 3), acceptMs: 3000, closesInMs: 1200000 },
  last: { price: 51000, ts: P3_LAST_TS, acceptMs: 3600, closesInMs: 385600 },
});

const P4_CLOSE = istAt(2026, 9, 23, 14, 0, 0);
const P4_LAST_TS = istAt(2026, 9, 23, 13, 59, 34);
const p4 = load({
  auctionId: '25751140', platformKey: null, ...DURIAN, close: P4_CLOSE, won: false,
  first: { price: 95920, ts: istAt(2026, 9, 23, 13, 58, 20, 500), acceptMs: 500, closesInMs: 100000 },
  last: { price: 94300, ts: P4_LAST_TS, acceptMs: 600, closesInMs: 27000 },
});

function harness(cond, msg) {
  assert.ok(cond, `HARNESS: ${msg}`);
}

async function main() {
  const p1Lost = await closeAndRender(p1(false));
  const p1Won = await closeAndRender(p1(true));
  const p2Lost = await closeAndRender(p2);
  const p3Lost = await closeAndRender(p3);
  const p4Lost = await closeAndRender(p4);

  for (const [name, r, customer, lastTs, closeAt, closesInMs] of [
    ['P1 lost', p1Lost, DURIAN.companyName, P1_LAST_TS, P1_CLOSE, 2400],
    ['P2 lost', p2Lost, DURIAN.companyName, P2_LAST_TS, P2_CLOSE, 2700],
    ['P3 lost', p3Lost, 'Waaree Energies Ltd.', P3_LAST_TS, P3_CLOSE, 385600],
    ['P4 lost', p4Lost, DURIAN.companyName, P4_LAST_TS, P4_CLOSE, 27000],
  ]) {
    harness(r.full.kind === 'lost' && r.full.template === 'lost', `${name}: full receipt routed as ${r.full.kind}/${r.full.template}, not lost/lost`);
    harness(r.short.template === 'lost_short', `${name}: group reply rendered ${r.short.template}, not lost_short`);
    harness(r.full.text.includes(customer) && r.short.text.includes(customer), `${name}: receipt does not name ${customer}`);
    const bids = r.record.ourBids || [];
    harness(bids.length === 2 && bids[1].ts === lastTs && bids[1].closesInMs === closesInMs, `${name}: the record did not keep our last bid`);
    harness(r.record.finalCloseAt === closeAt, `${name}: the record did not keep finalCloseAt`);
  }
  harness(p1Won.full.kind === 'won' && p1Won.full.template === 'won', `P1 won: routed as ${p1Won.full.kind}/${p1Won.full.template}`);
  harness(p1Won.full.text.includes(DURIAN.companyName), 'P1 won: receipt does not name the customer');

  const mech = 'M8 gap at landing, one decimal under 10 s';
  const expect = [
    ['P1 lost', p1Lost.full.text, lastBid(gap.tenths(2.1), clock(12, 19, 58))],
    ['P1 lost_short', p1Lost.short.text, lastBid(gap.tenths(2.1), clock(12, 19, 58))],
    ['P1 won', p1Won.full.text, lastBid(gap.tenths(2.1), clock(12, 19, 58))],
    ['P2 lost', p2Lost.full.text, lastBid(gap.tenths(2.5), clock(12, 39, 58))],
    ['P2 lost_short', p2Lost.short.text, lastBid(gap.tenths(2.5), clock(12, 39, 58))],
    ['P3 lost', p3Lost.full.text, lastBid(gap.minSec(6, 22), clock(15, 53, 38))],
    ['P3 lost_short', p3Lost.short.text, lastBid(gap.minSec(6, 22), clock(15, 53, 38))],
    ['P4 lost', p4Lost.full.text, lastBid(gap.secs(26), clock(13, 59, 34))],
    ['P4 lost_short', p4Lost.short.text, lastBid(gap.secs(26), clock(13, 59, 34))],
  ];
  for (const [variant, text, spec] of expect) {
    check(mech, `${variant}: expected line "${spec.label} ... ${spec.value}"`, hasLine(text, spec), text);
  }
  for (const [variant, text] of expect) {
    check('M8 whole-second/whole-minute lead retired', `${variant}: no "Ns before close" / "N min before close" lead`,
      !String(text).split('\n').some((l) => OLD_LEAD.test(l)), text);
  }

  const lastLabel = lastBid('', '').label;
  for (const [variant, text, countdown] of [
    ['P1 lost', p1Lost.full.text, gap.tenths(2.4)],
    ['P1 lost_short', p1Lost.short.text, gap.tenths(2.4)],
    ['P1 won', p1Won.full.text, gap.tenths(2.4)],
    ['P3 lost', p3Lost.full.text, gap.minSec(6, 26)],
    ['P3 lost_short', p3Lost.short.text, gap.minSec(6, 26)],
  ]) {
    check('M8 guard', `${variant}: the decision countdown (${countdown}) is not presented as the gap`,
      findLine(text, { label: lastLabel, value: lastBidGapPrefix(countdown) }) == null, text);
  }

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-31/M8: the receipt gap is the decision countdown rounded to whole seconds or minutes, not the gap at landing to one decimal under 10 s`);
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
}

main().catch((e) => {
  console.log(ascii(e && e.stack ? e.stack : e));
  process.exit(1);
});
