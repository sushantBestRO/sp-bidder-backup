'use strict';
/**
 * The attempts count on a loss counts a bid the engine reconciled as landed.
 *
 * Regression target: BC-30 (attempts missing from results), the count half of timing-D mechanism M6
 * (the 2026-09-24 result-alert timing diagnosis), with M9 (no attempts line at all).
 * Plan test "test-receipt-attempts-count-reconciled" under PR-T6.
 *
 * THE DEFECT. When a write comes back uncertain and the engine's read-back reconciles it as landed,
 * bidEngine increments landedBids but emits no bid_placed, so the closed-bids record's ourBids never
 * gets that entry. Load 26091792T2 (GoComet, Waaree Chikhli, 17 Sep 2026) closed with landedBids 3
 * and two entries in ourBids. outcomeEnrichment derives its `attempts` from ourBids.length, so any
 * attempts line fed from it would read "2 of 3 used" on a load that spent all three attempts. The
 * count must come from landedBids (engineAlerts.landedEvidence already takes max(event, record)).
 * Today there is no attempts line at all (PR #225, 9123dbb, removed it), so the positive checks are
 * red for that reason; the negative check guards the ourBids-derived count.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too): neither variant ever reads "2 of 3 used".
 *
 *   node scripts/test-receipt-attempts-count-reconciled.js
 */
const { istAt, closeAndRender, hasLine } = require('./lib/result-receipt-harness');
const copy = require('./fixtures/result-receipt-copy');

const AUCTION = '26091792T2';
const POSTED = istAt(2026, 9, 17, 18, 0, 0);
const lane = {
  origin: 'Survey No. 12, GIDC Degam, Chikhli, Gujarat 396530',
  destination: 'Plot 4, Sanand GIDC, Ahmedabad, Gujarat 382110',
};

function placed({ price, rungIndex, decidedAt, closesInMs, acceptMs, rank }) {
  return {
    type: 'bid_placed', price, rungIndex, decidedAt, closesInMs, believedCloseAt: POSTED,
    ts: decidedAt + acceptMs, latencyMs: acceptMs, cost: 52000, minMarginPct: 3, closeModel: 'soft',
    socketRank: rank, extendsObserved: 0,
  };
}

(async () => {
  let n = 0;
  // The third write (rung 2) came back uncertain and was reconciled as landed: no bid_placed for it.
  const r = await closeAndRender({
    auctionId: AUCTION, platformKey: 'gocomet',
    armed: {
      ts: istAt(2026, 9, 17, 17, 10, 0), cost: 52000, floor: 53560, minMarginPct: 3, marginsPct: [8, 5.5, 3],
      ladder: [56160, 54860, 53560], companyName: 'Waaree Energies Ltd.', lane, equipment: '32 ft MXL, 15 T', units: 1,
    },
    events: [
      placed({ price: 56160, rungIndex: 0, decidedAt: istAt(2026, 9, 17, 17, 50, 0), closesInMs: 600000, acceptMs: 3800, rank: 3 }),
      placed({ price: 54860, rungIndex: 1, decidedAt: istAt(2026, 9, 17, 17, 57, 0), closesInMs: 180000, acceptMs: 4600, rank: 2 }),
    ],
    result: {
      ts: POSTED + 302000, won: false, finalRank: 2, closeModel: 'soft', finalCloseAt: POSTED,
      landedBids: 3, attemptsAllowed: 3, extensionsAfterLastBid: 0, postedCloseAt: POSTED, finalCloseUnknown: false,
      companyName: 'Waaree Energies Ltd.', lane, laneCells: { from: 'Chikhli 396530', to: 'Ahmedabad 382110' },
      equipment: '32 ft MXL, 15 T', units: 1, shipperRef: 'ENT-2026-005198-3260101877',
    },
  });

  // ---- controls: the reconciled-bid shape reached the receipt ----------------------------------
  n++;
  const recBids = (r.record.ourBids || []).length;
  if (r.record.status !== 'closed' || recBids !== 2) {
    throw new Error(`HARNESS: check ${n}: record status ${r.record.status}, ourBids ${recBids} (want 2 - the reconciled third bid has no entry)`);
  }
  for (const [variant, want] of [['full', 'lost'], ['short', 'lost_short']]) {
    n++;
    const v = r[variant];
    if (v.template !== want || String(v.data.oaNo) !== AUCTION || Number(v.data.landedBids) !== 3) {
      throw new Error(`HARNESS: check ${n}: ${variant}: template ${v.template} (want ${want}), oaNo ${v.data.oaNo}, landedBids ${v.data.landedBids} (want 3)`);
    }
  }
  console.log(`ok controls: ${n} (record holds 2 bids, payload landedBids 3, lost + lost_short rendered)`);

  const failures = [];
  const check = (cond, msg) => { n++; if (!cond) failures.push(`check ${n}: ${msg}`); };

  // ---- mechanism (BC-30 / M6 + M9): attempts used = landedBids, not ourBids.length -------------
  const right = copy.attempts(3, 3);
  const wrong = copy.attempts(2, 3);
  for (const v of [r.full, r.short]) {
    check(hasLine(v.text, right),
      `BC-30 M6/M9: ${v.template} for ${AUCTION} has no "${right.label} ... ${right.value}" line `
      + '(landedBids 3 incl. one reconciled bid, attemptsAllowed 3, ourBids holds 2)');
  }

  // ---- negative control: the ourBids-derived count never reaches the receipt -------------------
  for (const v of [r.full, r.short]) {
    check(!v.text.includes(wrong.value),
      `BC-30 M6: ${v.template} for ${AUCTION} reads "${wrong.value}" - counted ourBids (2) instead of landedBids (3)`);
  }

  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`FAIL ${failures.length} of ${n} checks - BC-30 M6/M9: loss receipts do not state attempts from landedBids`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => {
  const msg = String(e && e.message);
  console.log(msg.startsWith('HARNESS:') ? msg : (e && e.stack) || e);
  process.exit(1);
});
