'use strict';
/**
 * When the auction ran past the last close the portal published and the new close was never
 * published, the result receipt says so instead of stating the stale close as the close.
 *
 * Regression target: BC-31 (gap between last bid and close wrong on extended auctions); timing
 * diagnosis 2026-09-24 (timing-D) mechanism M7, the Dynamic Cables row it marks UNVERIFIED.
 *
 * THE DEFECT. On a SuperProcure soft load the countdown can sit at zero on a live auction: the
 * engine infers an extension (bidEngine _observeExtension, the _zeroRunExtendAt branch) but no new
 * close is ever published, so finalCloseAt stays at the last published close. The receipt prints
 * that stale close as "Bid Close Time" and, because our last bid's believed close equals it
 * (engineAlerts.closeMatchesBid), prints the bid's countdown as the gap to the close - "2s before
 * close" on Dynamic Cables 25703191 (23 Sep 2026), a claim nobody can verify, since the auction
 * went on past it. The result now carries `finalCloseUnknown: true` for exactly this case.
 *
 * HAND-WORKED FACTS. U: last published close 12:30:00 (also the posted close); our last bid landed
 * 2.6 - 0.2 = 2.4 s before it; one inferred extension after it; finalized ~12:33:05. P (control,
 * the close WAS published): the same load with finalCloseAt 12:32:00 and one extension.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - U never claims a final close time: no Closed line naming the stale 12:30 or the finalize
 *     instant 12:33.
 *   - P has no unknown-close line: the flag, not the extension count, selects it.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 * Offline and deterministic: real BidLogger on a memory store, real notifyEngineEvent and renderer
 * (scripts/lib/result-receipt-harness.js), TZ pinned to IST.
 *
 *   node scripts/test-receipt-unknown-final-close.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { clock, lastBid, closed, unknownClose } = require('./fixtures/result-receipt-copy');

const { istAt, closeAndRender, findLine, hasLine } = h;

const MARK_A = '\u0001';
const MARK_B = '\u0002';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LAST_BID_FORM = lastBid(MARK_A, MARK_B).value.split(MARK_A)[1].split(MARK_B)[0];
const UNKNOWN_RE = new RegExp(unknownClose(MARK_A).value.split(MARK_A).map(escapeRe).join('.*?'));
const OLD_LEAD = /\d+s before close|\d+ min before close/;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const timingLines = (text) => String(text || '').split('\n')
  .filter((l) => /close|last bid|extend|ran past/i.test(l)).map(ascii).join(' | ');
const lines = (text) => String(text || '').split('\n');

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok, text) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc} -- rendered: ${timingLines(text) || '(no timing lines)'}`);
}

function harness(cond, msg) {
  assert.ok(cond, `HARNESS: ${msg}`);
}

function bidEvent(price, rungIndex, ts, decidedLeadMs, closesInMs, believedCloseAt) {
  return {
    type: 'bid_placed', price, rungIndex, ts, decidedAt: ts - decidedLeadMs, closesInMs, believedCloseAt,
    latencyMs: decidedLeadMs, cost: 31000, closeModel: 'soft',
  };
}

const ID = '25703191';
const CUSTOMER = 'Dynamic Cables Limited';
const LANE = { origin: 'Jaipur', destination: 'Vadodara' };
const PUBLISHED = istAt(2026, 9, 23, 12, 30, 0);
const LAST_TS = istAt(2026, 9, 23, 12, 29, 57, 600);
const base = {
  auctionId: ID, platformKey: null,
  armed: { companyName: CUSTOMER, lane: LANE, cost: 31000 },
  events: [
    bidEvent(33500, 0, istAt(2026, 9, 23, 12, 20, 5), 200, 595200, PUBLISHED),
    bidEvent(32800, 1, istAt(2026, 9, 23, 12, 27, 30), 200, 150200, PUBLISHED),
    bidEvent(32240, 2, LAST_TS, 200, 2600, PUBLISHED),
  ],
};
const u = {
  ...base,
  result: {
    won: false, finalRank: 8, closeModel: 'soft', companyName: CUSTOMER, lane: LANE,
    postedCloseAt: PUBLISHED, finalCloseAt: PUBLISHED, finalCloseUnknown: true, extensionsAfterLastBid: 1,
    attemptsAllowed: 3, landedBids: 3, ts: istAt(2026, 9, 23, 12, 33, 5),
  },
};
const P_FINAL = istAt(2026, 9, 23, 12, 32, 0);
const p = {
  ...base,
  result: {
    won: false, finalRank: 8, closeModel: 'soft', companyName: CUSTOMER, lane: LANE,
    postedCloseAt: PUBLISHED, finalCloseAt: P_FINAL, extensionsAfterLastBid: 1,
    attemptsAllowed: 3, landedBids: 3, ts: istAt(2026, 9, 23, 12, 35, 5),
  },
};

async function main() {
  const uR = await closeAndRender(u);
  const pR = await closeAndRender(p);

  // Controls: the pipeline rendered the right receipt for the right load.
  for (const [name, r, finalAt] of [['U', uR, PUBLISHED], ['P', pR, P_FINAL]]) {
    harness(r.full.kind === 'lost' && r.full.template === 'lost', `${name}: full receipt routed as ${r.full.kind}/${r.full.template}, not lost/lost`);
    harness(r.short.template === 'lost_short', `${name}: group reply rendered ${r.short.template}, not lost_short`);
    harness(r.full.text.includes(ID), `${name}: full receipt does not carry load ${ID}`);
    harness(r.full.text.includes(CUSTOMER) && r.short.text.includes(CUSTOMER), `${name}: receipt does not name ${CUSTOMER}`);
    harness(r.record.ourBids.length === 3 && r.record.ourBids[2].ts === LAST_TS, `${name}: the record did not keep our 3 bids`);
    harness(r.record.finalCloseAt === finalAt, `${name}: the record did not keep finalCloseAt`);
  }

  const variants = (r) => [['lost', r.full.text], ['lost_short', r.short.text]];

  // Mechanism checks (red on base).
  for (const [variant, text] of variants(uR)) {
    const spec = unknownClose(clock(12, 30));
    check('M7 unpublished final close stated as unknown', `U ${variant}: expected line "${spec.value}"`, hasLine(text, spec), text);
  }
  for (const [variant, text] of variants(uR)) {
    const gapLines = lines(text).filter((l) => l.includes(LAST_BID_FORM) || OLD_LEAD.test(l));
    check('M7 no gap to a close that was not the final close', `U ${variant}: no line states a gap "before close" of the stale 12:30 close`, gapLines.length === 0, text);
  }
  for (const [variant, text] of variants(pR)) {
    const spec = closed(clock(12, 32, 0), clock(12, 30));
    check('M5 published final close with seconds and posted close', `P ${variant}: expected line "${spec.label} ... ${spec.value}"`, hasLine(text, spec), text);
  }

  // Guards (green on base, must stay green).
  const closedLabel = closed('', '').label;
  for (const [variant, text] of variants(uR)) {
    const claims = [
      closed(clock(12, 30, 0)),
      { label: closedLabel, value: clock(12, 33) },
      { label: closedLabel, value: clock(12, 33, 5) },
    ].map((spec) => findLine(text, spec)).filter(Boolean);
    check('M7 guard', `U ${variant}: no Closed line claims a final close time (stale 12:30 or finalize 12:33)`, claims.length === 0, text);
  }
  for (const [variant, text] of variants(pR)) {
    check('M7 guard', `P ${variant}: no unknown-close line when the final close was published`,
      !lines(text).some((l) => UNKNOWN_RE.test(l)), text);
  }

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-31/M7: the receipt states a stale close as the final close instead of saying the portal never published it`);
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
}

main().catch((e) => {
  console.log(ascii(e && e.stack ? e.stack : e));
  process.exit(1);
});
