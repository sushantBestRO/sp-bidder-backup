'use strict';
/**
 * D073: a report field labelled "Priced" must count loads that were actually PRICED (a cost
 * captured), never silently substitute a different metric such as "participated" (a placed bid).
 *
 * Regression target: D073. eodReport.js's per-customer EOD printed day.participated (the count of
 * loads with a bid) on the line labelled "*Priced*" (eodReport.js:398/511 at the time this was
 * written) - a straightforward field-vs-label mismatch, since a captured cost can still fail to
 * bid (a refusal, a ceiling gate) and the two numbers can genuinely differ.
 *
 * @requires-summary-line
 *   node scripts/test-d073-eod-priced-line-counts-actual-price-captures.js
 */
const assert = require('assert');
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
  const store = new MemoryStore();
  const reqs = [
    // P1: priced AND bid - counts in both pricedCount and participated.
    { loadId: 'P1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } },
    // P2: priced (a cost was captured), but the engine never landed a bid (e.g. a ceiling
    // refusal) - counts in pricedCount, NOT in participated.
    { loadId: 'P2', createdAt: WIN_START + 3, capturedAt: WIN_START + 4, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3600000 } },
    // P3: never priced at all (still awaiting) - counts in neither.
    { loadId: 'P3', createdAt: WIN_START + 5, capturedAt: null, status: 'awaiting_price', load: { companyName: 'Syngenta', closesAt: NOW + 3600000 } },
  ];
  await store.putDoc('closedBids', 'P1', {
    auctionId: 'P1', status: 'closed', won: false, finalRank: 2, cost: 10000, lastBidPrice: 10500,
    ourBids: [{ price: 10500, ts: WIN_START + 10 }],
  });
  // P2 either has no closedBids doc at all, or one with an empty ourBids - either way it never
  // participated. Modelled here as the doc existing (armed, refused every rung) with no bids.
  await store.putDoc('closedBids', 'P2', { auctionId: 'P2', status: 'closed', won: false, cost: 12000, ourBids: [] });

  const day = await collectCustomerDay({
    requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  ok(day.pricedCount === 2, `setup sanity: two of the three inquiries were actually priced (got ${day.pricedCount})`);
  ok(day.participated === 1, `setup sanity: only ONE of those two priced loads ever landed a bid (got ${day.participated})`);

  const msg = renderEodReport({ label: 'Syngenta', day, slot: { h: 20, m: 0 } }, NOW);
  ok(msg.includes('*Priced* - 2 of 3 (67%)'),
    `the rendered "Priced" line must count pricedCount (2), not participated (1) (message:\n${msg}\n)`);
  ok(!msg.includes('*Priced* - 1 of 3'), 'the rendered "Priced" line must never fall back to the participated count');

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
