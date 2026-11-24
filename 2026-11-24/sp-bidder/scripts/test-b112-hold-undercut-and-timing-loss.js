'use strict';
/**
 * B112 (owner ruling 29, 2026-09-24): "if we lose we need to know it was other bidders who
 * undercut us on margin, not on time" - separates the engine's own failures from genuine
 * competitive losses. Adds a hold_undercut loss class and a timing-loss count on the
 * per-customer EOD. The "unpriced" cause is NOT a separate field - it is the existing
 * missedCutoff count, reported under that name already.
 *
 * Regression target: B112. util/reportedClose.js's resultReasonOf had no hold_undercut class
 * (every held-then-undercut load read as an ordinary undercut_while_leading); eodReport.js's
 * collectCustomerDay/renderEodReport carried no timing-loss or hold_undercut count at all.
 *
 * BLOCKING fix (coordinator review of 99c4bd0): the first cut keyed hold_undercut on ANY
 * costCorrections entry, but PR-1 (fix/money-path-divergences) also writes a costCorrections
 * entry on an ordinary DOWNWARD re-price that never held bidding at all - that record would have
 * been falsely labelled hold_undercut. Now keyed on a GENUINE hold-lifecycle entry only (reason
 * 'hold_entered' from recordAndHold, or 'resumed_by_desk' from resumeBidding) - the pin below
 * proves a downward, unheld correction does NOT classify as hold_undercut.
 *
 * Existing classes and their counts stay unchanged for existing records: a control below proves
 * an ordinary undercut_while_leading record (no hold trail at all) still classifies as before.
 *
 * @requires-summary-line
 *   node scripts/test-b112-hold-undercut-and-timing-loss.js
 */
const assert = require('assert');
const { resultReasonOf } = require('../src/util/reportedClose');
const { collectCustomerDay, renderEodReport } = require('../src/notify/eodReport');
const { MemoryStore } = require('../src/store');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 16, 14, 30);
const WIN_END = NOW;
const WIN_START = NOW - DAY;
function fakeRequests(docs) { return { listAll: async () => docs }; }

(async () => {
  const heldLostBase = {
    won: false, finalRank: 2, leadAfterLastBid: true,
    ourBids: [{ price: 27587, rungIndex: 0 }], marginsPct: [12.6, 7.2, 5], minMarginPct: 5, cost: 24500,
  };

  // --- resultReasonOf: a GENUINE hold (reason 'hold_entered') classifies as hold_undercut.
  const genuinelyHeld = Object.assign({}, heldLostBase, {
    costCorrections: [{ from: 24500, to: 26000, standingBidPrice: 27587, at: NOW - 500000, reason: 'hold_entered' }],
  });
  ok(resultReasonOf(genuinelyHeld, { landedBids: 1 }) === 'hold_undercut',
    `a record whose costCorrections trail carries a genuine hold entry must classify as hold_undercut (got ${resultReasonOf(genuinelyHeld, { landedBids: 1 })})`);

  // --- BLOCKING pin: a downward correction with NO hold (PR-1's shape - server.js's ordinary
  // re-price write, which carries no `reason` at all) must NOT classify as hold_undercut. This is
  // the exact false positive the coordinator's review caught in the first cut.
  const downwardNoHold = Object.assign({}, heldLostBase, {
    costCorrections: [{ from: 26000, to: 24500, standingBidPrice: 27587, at: NOW - 500000 }],
  });
  ok(resultReasonOf(downwardNoHold, { landedBids: 1 }) === 'undercut_while_leading',
    `a downward correction with no hold reason must NOT classify as hold_undercut (got ${resultReasonOf(downwardNoHold, { landedBids: 1 })})`);

  // --- a hold that was RESUMED (reason 'resumed_by_desk') also classifies as hold_undercut - the
  // load genuinely spent time on hold even though it later resumed.
  const resumedThenLost = Object.assign({}, heldLostBase, {
    costCorrections: [{ from: 24500, to: 26000, standingBidPrice: 27587, at: NOW - 500000, reason: 'resumed_by_desk' }],
  });
  ok(resultReasonOf(resumedThenLost, { landedBids: 1 }) === 'hold_undercut',
    `a resumed hold must also classify as hold_undercut (got ${resultReasonOf(resumedThenLost, { landedBids: 1 })})`);

  // Control: existing classes/counts stay unchanged - the same load with NO hold trail at all
  // still classifies as the ordinary undercut_while_leading, exactly as before B112.
  ok(resultReasonOf(heldLostBase, { landedBids: 1 }) === 'undercut_while_leading',
    `named reversal control: an ordinary held-the-lead loss with no hold trail is unchanged (got ${resultReasonOf(heldLostBase, { landedBids: 1 })})`);

  // Control: lost_on_timing is unaffected by B112's new branch.
  const timingLostRec = { won: false, finalRank: 2, leadAfterLastBid: false, ourBids: [{ price: 27587, rungIndex: 0 }], marginsPct: [12.6, 7.2, 5], minMarginPct: 5, cost: 24500 };
  ok(resultReasonOf(timingLostRec, { landedBids: 1 }) === 'lost_on_timing', 'control: lost_on_timing classification is unaffected');

  // --- eodReport: timing-loss and hold_undercut counts reach collectCustomerDay and render on the EOD.
  const store = new MemoryStore();
  const reqs = [
    { loadId: 'T1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } },
    { loadId: 'T2', createdAt: WIN_START + 3, capturedAt: WIN_START + 4, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } },
  ];
  await store.putDoc('closedBids', 'T1', {
    auctionId: 'T1', status: 'closed', won: false, finalRank: 3, cost: 24500, lastBidPrice: 27587,
    ourBids: [{ price: 27587, ts: WIN_START + 10 }], resultReason: 'lost_on_timing',
  });
  await store.putDoc('closedBids', 'T2', {
    auctionId: 'T2', status: 'closed', won: false, finalRank: 2, cost: 24500, lastBidPrice: 27000,
    ourBids: [{ price: 27000, ts: WIN_START + 10 }], resultReason: 'hold_undercut',
  });

  const day = await collectCustomerDay({
    requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  ok(day.timingLoss === 1, `collectCustomerDay must count the lost_on_timing doc (got ${day.timingLoss})`);
  ok(day.holdUndercutLoss === 1, `collectCustomerDay must count the hold_undercut doc (got ${day.holdUndercutLoss})`);
  ok(day.unpricedLoss === undefined, 'unpricedLoss is not a separate field - unpriced stays the existing missedCutoff count');

  const msg = renderEodReport({ label: 'Syngenta', day, slot: { h: 20, m: 0 } }, NOW);
  ok(/1 lost on timing \(our fault\)/.test(msg), `the rendered EOD names the timing-loss count (message:\n${msg}\n)`);
  ok(/1 held then undercut/.test(msg), `the rendered EOD names the hold_undercut count (message:\n${msg}\n)`);

  // Control: a day with neither cause renders no such line.
  const quietStore = new MemoryStore();
  const quietReqs = [{ loadId: 'Q1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } }];
  await quietStore.putDoc('closedBids', 'Q1', {
    auctionId: 'Q1', status: 'closed', won: false, finalRank: 2, cost: 24500, lastBidPrice: 27000,
    ourBids: [{ price: 27000, ts: WIN_START + 10 }], resultReason: 'lost_on_price',
  });
  const quietDay = await collectCustomerDay({
    requests: fakeRequests(quietReqs), store: quietStore, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  const quietMsg = renderEodReport({ label: 'Syngenta', day: quietDay, slot: { h: 20, m: 0 } }, NOW);
  ok(!/lost on timing/.test(quietMsg) && !/held then undercut/.test(quietMsg), 'control: neither loss-cause line renders when both counts are zero');

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
