'use strict';
/**
 * C069: every reader of a load's close time - the EOD's "armed tonight" count and the export's
 * close-time fallback - must read the LIVE effective close (priceRequests.effectiveCloseAt), never
 * the write-once discovery snapshot (load.closesAt). A snapshot goes stale the instant an auction
 * extends past it.
 *
 * Regression target: C069. eodReport.js's armedTonight read r.load.closesAt directly
 * (eodReport.js:383); exportModel.js's canonical() fell back to the bare load.closesAt for a row
 * with no closed record (exportModel.js:179 at the time this was written).
 *
 * @requires-summary-line
 *   node scripts/test-c069-effective-close.js
 */
const assert = require('assert');
const { collectCustomerDay } = require('../src/notify/eodReport');
const { canonical } = require('../src/web/exportModel');
const { MemoryStore } = require('../src/store');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 16, 14, 30);
const WIN_END = NOW;
const WIN_START = NOW - DAY;

function fakeRequests(docs) { return { listAll: async () => docs }; }

(async () => {
  // --- (a) EOD armedTonight: a load whose SNAPSHOT close already passed `now`, but whose
  // extended (liveClosesAt) close is still ahead of `now`, is still armed-tonight.
  const store = new MemoryStore();
  const reqs = [
    {
      loadId: 'L1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'armed',
      load: { companyName: 'Syngenta', closesAt: NOW - 60000, liveClosesAt: NOW + 3600000 },
    },
  ];
  const day = await collectCustomerDay({
    requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  ok(day.armedTonight === 1,
    `a load whose snapshot close is past but whose extended close is still ahead must count as armed tonight (got ${day.armedTonight})`);

  // Control: a load whose snapshot AND extended close both already passed must NOT count.
  const reqsPast = [
    {
      loadId: 'L2', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'armed',
      load: { companyName: 'Syngenta', closesAt: NOW - 60000, liveClosesAt: NOW - 30000 },
    },
  ];
  const dayPast = await collectCustomerDay({
    requests: fakeRequests(reqsPast), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
  });
  ok(dayPast.armedTonight === 0, `control: a genuinely-past close must not count as armed tonight (got ${dayPast.armedTonight})`);

  // --- (b) export canonical(): a funnel-only row (no closed doc) must fall back to the EFFECTIVE
  // close, not the stale discovery snapshot.
  const req = {
    loadId: 'L3', capturedAt: null, createdAt: WIN_START + 1,
    load: { companyName: 'Syngenta', closesAt: NOW - 60000, liveClosesAt: NOW + 3600000 },
  };
  const row = canonical(req, null);
  ok(row.auctionCloseAt === NOW + 3600000,
    `export canonical() must report the EXTENDED close for a row with no closed doc (got ${row.auctionCloseAt})`);

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
