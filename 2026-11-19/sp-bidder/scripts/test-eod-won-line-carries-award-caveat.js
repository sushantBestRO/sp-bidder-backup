'use strict';
/**
 * Red pin (dossier rider 3, option b): the per-customer EOD's Won line has no
 * award-confirmation caveat, while the Won-value line right below it already carries one
 * for the identical reason (rank 1 at close is not a confirmed SuperProcure award). A desk
 * reading "Won 1 of 1" is told nothing of that; the value line is. No recount here - the
 * "participated"/"Priced" mislabel is a separate defect, fixed under D073
 * (test-d073-eod-priced-line-counts-actual-price-captures.js): the "Priced" line now counts
 * pricedCount (a captured cost), not participated (a placed bid).
 */
const { collectCustomerDay, renderEodReport } = require('../src/notify/eodReport');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 16, 14, 30);
const WIN_END = NOW;
const WIN_START = NOW - DAY;

function fakeRequests(docs) { return { listAll: async () => docs }; }

(async () => {
  const store = new MemoryStore();
  const reqs = [
    { loadId: 'L1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } },
  ];
  await store.putDoc('closedBids', 'L1', {
    auctionId: 'L1', status: 'closed', won: true, cost: 10000, lastBidPrice: 11000,
    ourBids: [{ price: 11000, ts: WIN_START + 10 }],
  });

  const day = await collectCustomerDay({
    requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  ok(day.won === 1 && day.decided === 1, 'fixture actually won (setup sanity)');

  const msg = renderEodReport({ label: 'Syngenta', day, slot: { h: 20, m: 0 } }, NOW);
  ok(msg.includes('*Won* - 1 of 1 (100%)'), 'the Won line renders');
  ok(msg.includes('*Won* - 1 of 1 (100%)\n_rank 1 at close, award not confirmed yet_'),
    'the Won line carries the SAME unconfirmed-award caveat the Won-value line already carries, ' +
    `on its own italic sub-line right after it (rendered:\n${msg}\n)`);

  console.log(`\ntest-eod-won-line-carries-award-caveat: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test-eod-won-line-carries-award-caveat: FATAL', e);
  process.exit(1);
});
