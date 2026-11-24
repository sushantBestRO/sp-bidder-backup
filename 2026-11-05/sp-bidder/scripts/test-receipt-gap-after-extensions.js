'use strict';
/**
 * A result receipt states the gap from our last bid to the ACTUAL final close, the close with its
 * seconds and date, and how many times the auction extended after our last bid.
 *
 * Regression target: BC-31 (gap between last bid and close wrong on extended auctions), BC-33a (the
 * win receipt missing the same fields); timing diagnosis 2026-09-24 (timing-D) mechanisms M3, M5, M8
 * at the notify seam, the reporting half of M1/M2.
 *
 * THE DEFECT. closeTimeCell / shortBidTimingLine print the countdown the portal published when the
 * bid was DECIDED, and only when the bid's believed close equals the reported close
 * (engineAlerts.closeMatchesBid). On a load that extended after our last bid the two differ, so the
 * gap is dropped; where it is printed, leadPhrase rounds it to whole seconds or whole minutes and it
 * is measured at decision rather than at landing. The close has no seconds and no date, the group
 * reply (lost_short) carries no close at all, and nothing says the auction extended after our bid.
 * Real loads: GoComet 2609173132 (Waaree, 17 Sep 2026) read "6 min before close", truth 16 min 14 s
 * after two more 299 s rounds; SuperProcure soft 25625834 (Transrail, 21 Sep 2026) showed the bid
 * time alone, truth 6 min 2 s after three 120 s extensions.
 *
 * HAND-WORKED FACTS (contract: landing gap = closesInMs - (ts - decidedAt); gap to final = landing
 * gap + (finalCloseAt - that bid's believedCloseAt)):
 *   G1 GoComet: 376.4 - 3.6 = 372.8 s at landing ("6 min 13 s"); + (21:44:59 - 21:34:58 = 601 s)
 *      = 973.8 s to the final close ("16 min 14 s"). Two extensions after the bid.
 *   G2 SP soft: 2.45 - 0.25 = 2.2 s at landing; + (15:16:00 - 15:10:00 = 360 s) = 362.2 s
 *      ("6 min 2 s"). Three extensions after the bid.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - G1 never presents the at-that-time gap (6 min 13 s) or the decision countdown (6 min 16 s) as
 *     the gap to the close, nor the old whole-minute / whole-second lead wording.
 *   - The Extended sentence (retired by the owner on 24 Sep 2026: one gap per message, always to
 *     the final close) appears on no result, G1, G2 or N.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 * Offline and deterministic: real BidLogger on a memory store, real notifyEngineEvent and renderer
 * (scripts/lib/result-receipt-harness.js), TZ pinned to IST.
 *
 *   node scripts/test-receipt-gap-after-extensions.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { gap, clock, lastBid, lastBidRound, closed, extensions, extended } = require('./fixtures/result-receipt-copy');

const { istAt, closeAndRender, findLine, hasLine } = h;

const MARK = '\u0001';
const lastBidGapPrefix = (gapText) => lastBid(gapText, MARK).value.split(MARK)[0];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const extendedRes = Array.from({ length: 10 }, (_, i) => {
  const parts = extended(i + 1, MARK).value.split(MARK).map(escapeRe);
  return new RegExp(parts.join('.*?'));
});
const OLD_LEAD = /\d+s before close|\d+ min before close/;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const timingLines = (text) => String(text || '').split('\n')
  .filter((l) => /close|last bid|extend/i.test(l)).map(ascii).join(' | ');

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok, text) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc} -- rendered: ${timingLines(text) || '(no timing lines)'}`);
}

function bidEvent(price, rungIndex, ts, decidedLeadMs, closesInMs, believedCloseAt, cost) {
  return {
    type: 'bid_placed', price, rungIndex, ts, decidedAt: ts - decidedLeadMs, closesInMs, believedCloseAt,
    latencyMs: decidedLeadMs, cost, closeModel: 'soft',
  };
}

// G1 - GoComet 'off' load, 2609173132 shape.
const G1_ID = '2609173132';
const G1_POSTED = istAt(2026, 9, 17, 21, 30, 0);
const G1_IN_FORCE = istAt(2026, 9, 17, 21, 34, 58);
const G1_FINAL = istAt(2026, 9, 17, 21, 44, 59);
const G1_LAST_TS = istAt(2026, 9, 17, 21, 28, 45, 0);
function g1(won) {
  return {
    auctionId: G1_ID, platformKey: 'gocomet',
    armed: { companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' }, cost: 48000 },
    events: [
      bidEvent(52000, 0, istAt(2026, 9, 17, 21, 18, 2), 3000, 721000, G1_POSTED, 48000),
      bidEvent(51000, 1, istAt(2026, 9, 17, 21, 24, 31), 3000, 332000, G1_POSTED, 48000),
      bidEvent(50000, 2, G1_LAST_TS, 3600, 376400, G1_IN_FORCE, 48000),
    ],
    result: {
      won, finalRank: won ? 1 : 2, closeModel: 'soft', companyName: 'Waaree Energies Ltd.',
      lane: { origin: 'Degam', destination: 'Akola' },
      postedCloseAt: G1_POSTED, finalCloseAt: G1_FINAL, extensionsAfterLastBid: 2,
      attemptsAllowed: 3, landedBids: 3, ts: istAt(2026, 9, 17, 21, 50, 4),
    },
  };
}

// G2 - SuperProcure soft allowlisted load, Transrail 25625834 shape.
const G2_ID = '25625834';
const G2_POSTED = istAt(2026, 9, 21, 15, 10, 0);
const G2_FINAL = istAt(2026, 9, 21, 15, 16, 0);
const g2 = {
  auctionId: G2_ID, platformKey: null,
  armed: { companyName: 'Transrail Lighting Limited', lane: { origin: 'Umred', destination: 'Shergarh' }, cost: 2450 },
  events: [
    bidEvent(2650, 0, istAt(2026, 9, 21, 15, 2, 10), 250, 470250, G2_POSTED, 2450),
    bidEvent(2600, 1, istAt(2026, 9, 21, 15, 7, 40), 250, 140250, G2_POSTED, 2450),
    bidEvent(2548, 2, istAt(2026, 9, 21, 15, 9, 57, 800), 250, 2450, G2_POSTED, 2450),
  ],
  result: {
    won: false, finalRank: 6, closeModel: 'soft', companyName: 'Transrail Lighting Limited',
    lane: { origin: 'Umred', destination: 'Shergarh' },
    postedCloseAt: G2_POSTED, finalCloseAt: G2_FINAL, extensionsAfterLastBid: 3,
    attemptsAllowed: 10, landedBids: 3, ts: istAt(2026, 9, 21, 15, 19, 5),
  },
};

// N - negative control: same SP shape, last bid in the final round, nothing extended after it.
const n = {
  ...g2,
  events: [
    bidEvent(2650, 0, istAt(2026, 9, 21, 15, 2, 10), 250, 470250, G2_POSTED, 2450),
    bidEvent(2600, 1, istAt(2026, 9, 21, 15, 7, 40), 250, 140250, G2_POSTED, 2450),
    bidEvent(2548, 2, istAt(2026, 9, 21, 15, 15, 57, 800), 250, 2450, G2_FINAL, 2450),
  ],
  result: { ...g2.result, extensionsAfterLastBid: 0 },
};

function harness(cond, msg) {
  assert.ok(cond, `HARNESS: ${msg}`);
}

async function main() {
  const g1Lost = await closeAndRender(g1(false));
  const g1Won = await closeAndRender(g1(true));
  const g2Lost = await closeAndRender(g2);
  const nLost = await closeAndRender(n);

  // Controls: the pipeline rendered the right receipt for the right load.
  for (const [name, r, customer, lastTs, finalAt] of [
    ['G1 lost', g1Lost, 'Waaree Energies Ltd.', G1_LAST_TS, G1_FINAL],
    ['G2 lost', g2Lost, 'Transrail Lighting Limited', g2.events[2].ts, G2_FINAL],
    ['N lost', nLost, 'Transrail Lighting Limited', n.events[2].ts, G2_FINAL],
  ]) {
    harness(r.full.kind === 'lost' && r.full.template === 'lost', `${name}: full receipt routed as ${r.full.kind}/${r.full.template}, not lost/lost`);
    harness(r.short.template === 'lost_short', `${name}: group reply rendered ${r.short.template}, not lost_short`);
    harness(r.full.text.includes(customer) && r.short.text.includes(customer), `${name}: receipt does not name ${customer}`);
    harness(r.record.ourBids.length === 3 && r.record.ourBids[2].ts === lastTs, `${name}: the record did not keep our 3 bids`);
    harness(r.record.finalCloseAt === finalAt, `${name}: the record did not keep finalCloseAt`);
  }
  harness(g1Won.full.kind === 'won' && g1Won.full.template === 'won', `G1 won: routed as ${g1Won.full.kind}/${g1Won.full.template}`);
  harness(g1Won.full.text.includes('Waaree Energies Ltd.'), 'G1 won: receipt does not name the customer');

  // Mechanism checks (red on base).
  const g1Expect = [
    // CW-267: extended after our bid, so timed to its round close (372.8 s at landing).
    ['CW-267 gap to the round close, at landing', lastBidRound(gap.minSec(6, 13), clock(21, 28, 45))],
    ['M5 close with seconds and posted close', closed(clock(21, 44, 59), clock(21, 30))],
    ['M3 extensions after our last bid stated', extensions(2)],
  ];
  for (const [variant, text] of [['G1 lost', g1Lost.full.text], ['G1 lost_short', g1Lost.short.text], ['G1 won (BC-33a)', g1Won.full.text]]) {
    for (const [mech, spec] of g1Expect) {
      check(mech, `${variant}: expected line "${spec.label ? `${spec.label} ... ` : ''}${spec.value}"`, hasLine(text, spec), text);
    }
  }
  const g2Expect = [
    // CW-267: extended after our bid, so timed to its round close (2.2 s at landing).
    ['CW-267 gap to the round close, at landing', lastBidRound(gap.tenths(2.2), clock(15, 9, 57))],
    ['M5 close with seconds and posted close', closed(clock(15, 16, 0), clock(15, 10))],
    ['M3 extensions after our last bid stated', extensions(3)],
  ];
  for (const [variant, text] of [['G2 lost', g2Lost.full.text], ['G2 lost_short', g2Lost.short.text]]) {
    for (const [mech, spec] of g2Expect) {
      check(mech, `${variant}: expected line "${spec.label ? `${spec.label} ... ` : ''}${spec.value}"`, hasLine(text, spec), text);
    }
  }

  // Guards (green on base, must stay green).
  const lastLabel = lastBid('', '').label;
  for (const [variant, text] of [['G1 lost', g1Lost.full.text], ['G1 lost_short', g1Lost.short.text], ['G1 won', g1Won.full.text]]) {
    const stale = [gap.minSec(6, 13), gap.minSec(6, 16)]
      .map((g) => findLine(text, { label: lastLabel, value: lastBidGapPrefix(g) })).filter(Boolean);
    const oldLead = String(text).split('\n').filter((l) => OLD_LEAD.test(l));
    check('M3 guard', `${variant}: the at-that-time gap or decision countdown is not presented as the gap to the close`,
      stale.length === 0 && oldLead.length === 0, text);
  }
  for (const [variant, text] of [['G1 lost', g1Lost.full.text], ['G1 lost_short', g1Lost.short.text], ['G1 won', g1Won.full.text],
    ['G2 lost', g2Lost.full.text], ['G2 lost_short', g2Lost.short.text], ['N lost', nLost.full.text], ['N lost_short', nLost.short.text]]) {
    check('M3 guard', `${variant}: the retired Extended sentence appears on no result`,
      !String(text).split('\n').some((l) => extendedRes.some((re) => re.test(l))), text);
  }

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-31/BC-33a: the receipt does not state the gap to the actual final close, the dated close, or the extensions after our last bid`);
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
}

main().catch((e) => {
  console.log(ascii(e && e.stack ? e.stack : e));
  process.exit(1);
});
