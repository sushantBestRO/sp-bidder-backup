'use strict';
/**
 * BC-28/CW-241: /api/export/freight-value, over the REAL HTTP surface (boot the app, GET the
 * endpoint) rather than calling the report module directly - the coordinator's own ask, because a
 * unit test on monthlyFreightValue.js proves nothing about whether the console can actually reach
 * it. Same http.get + app.listen(0) pattern as test-export-open-tile.js.
 *
 * Covers what a unit test cannot: the route is wired (require, endpoint, JSON shape), the
 * ALL-LOADS basis holds end to end - a never-priced, no-value load still counts as an enquiry -
 * an IST month boundary (30 Sep 20:00 UTC = 1 Oct 01:30 IST lands in October, not September), and
 * (combined-release review, findings 1 + 3) that a month is marked complete/partial by whether the
 * archive actually reaches it, and that a closedBids-only row (no live/archived request record)
 * still scales a multi-truck bid using the basis now carried on the doc itself.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const { app, store } = require('../src/web/server');
const { ARCHIVE_STREAM } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

(async () => {
  const AUG_EARLY = Date.UTC(2026, 7, 5, 10, 0, 0);      // 5 Aug 2026 - the archive's earliest day.
  const SEP_MID = Date.UTC(2026, 8, 15, 10, 0, 0);       // 15 Sep 2026, 15:30 IST - plain September.
  const SEP_NEVER_PRICED = Date.UTC(2026, 8, 20, 10, 0, 0); // 20 Sep 2026 - September, no value.
  // 30 Sep 2026 20:00 UTC = 1 Oct 2026 01:30 IST - UTC still says September, IST already October.
  const IST_BOUNDARY = Date.UTC(2026, 8, 30, 20, 0, 0);

  // The archive's earliest row - August is therefore the archive-start month (partial); every
  // full month strictly after it (September onward) reads complete.
  await store.appendEvent(ARCHIVE_STREAM, {
    loadId: 'ARCH-AUG', platformKey: 'sp', quoteType: 'FTL', endedAt: AUG_EARLY, createdAt: AUG_EARLY - 3_600_000,
  });

  // A closedBids-only row from the same (partial) August, no live/archived request record at all -
  // the exact shape finding 3 fixed. Basis and unit count come from the doc alone (quoteType, units).
  await store.putDoc('closedBids', 'AUG-CLOSED', {
    auctionId: 'AUG-CLOSED', platformKey: 'sp', status: 'closed', closedAt: AUG_EARLY + 3_600_000,
    ourBids: [{ ts: AUG_EARLY, price: 15000 }], lastBidPrice: 15000, units: 2, quoteType: 'FTL', won: true,
  });

  // Our-rate load: priced, armed, bid, closed in September - value = lastBidPrice x units (truck basis).
  await store.putDoc('priceRequests', 'BID1', {
    id: 'BID1', loadId: 'BID1', platformKey: 'sp', account: null, customer: null,
    createdAt: SEP_MID - 3_600_000, capturedAt: SEP_MID - 1_800_000, status: 'closed',
    price: { cost: 18000 },
    load: { lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: '32ft', units: 1, quoteType: 'FTL', companyName: 'Havells', closesAt: SEP_MID },
  });
  await store.putDoc('closedBids', 'BID1', {
    auctionId: 'BID1', platformKey: 'sp', status: 'closed', closedAt: SEP_MID,
    ourBids: [{ ts: SEP_MID - 60000, price: 20000 }], lastBidPrice: 20000, units: 1, won: true,
  });

  // Never priced, no lane average - September, no value, but still an enquiry (ALL LOADS basis).
  await store.putDoc('priceRequests', 'NOPRICE1', {
    id: 'NOPRICE1', loadId: 'NOPRICE1', platformKey: 'sp', account: null, customer: null,
    createdAt: SEP_NEVER_PRICED - 3_600_000, capturedAt: null, status: 'skipped_no_price', price: null,
    load: { lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32ft', units: 1, quoteType: 'FTL', companyName: 'Adama', closesAt: SEP_NEVER_PRICED },
  });

  // Never priced, closes at an instant that is September in UTC but October in IST.
  await store.putDoc('priceRequests', 'BOUNDARY1', {
    id: 'BOUNDARY1', loadId: 'BOUNDARY1', platformKey: 'sp', account: null, customer: null,
    createdAt: IST_BOUNDARY - 3_600_000, capturedAt: null, status: 'awaiting_price', price: null,
    load: { lane: { origin: 'Surat', destination: 'Kutch' }, equipment: '32ft', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: IST_BOUNDARY },
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await get(base, '/api/export/freight-value');
  ok(res.status === 200, '/api/export/freight-value returns 200');
  ok(res.json != null, 'response body parses as JSON');
  eq(res.json && res.json.allLoadsFrom, AUG_EARLY, 'allLoadsFrom is the archive\'s own earliest row, not a hardcoded date');

  const months = (res.json && res.json.months) || [];
  const byMonth = Object.fromEntries(months.map((m) => [m.month, m]));

  ok(!!byMonth['2026-08'], 'August bucket exists (the closedBids-only row)');
  ok(!!byMonth['2026-09'], 'September bucket exists');
  ok(!!byMonth['2026-10'], 'October bucket exists - the IST-boundary load did not stay in September');
  if (byMonth['2026-08'] && byMonth['2026-09'] && byMonth['2026-10']) {
    eq(byMonth['2026-08'].complete, false, 'August is the archive-start month itself - partial, not complete');
    eq(byMonth['2026-08'].enquiries, 2, 'August: ARCH-AUG + AUG-CLOSED');
    eq(byMonth['2026-08'].freightValueRs, 30000, 'FIX (finding 3): AUG-CLOSED (no request record) still scales 15000 x 2 units from its own doc.quoteType/units, not a bare 15000');
    eq(byMonth['2026-08'].noValueLoads, 1, 'ARCH-AUG (archive-only, no rate, no lane average) is the one load with no value');

    eq(byMonth['2026-09'].complete, true, 'September is a full month strictly after the archive-start month - complete');
    eq(byMonth['2026-09'].enquiries, 2, 'September: BID1 + NOPRICE1, both counted (all-loads basis)');
    eq(byMonth['2026-09'].freightValueRs, 20000, 'September freight value is BID1\'s bid alone (20000 x 1)');
    eq(byMonth['2026-09'].noValueLoads, 1, 'September: NOPRICE1 is the one load with no value');

    eq(byMonth['2026-10'].complete, true, 'October is also complete');
    eq(byMonth['2026-10'].enquiries, 1, 'October: only BOUNDARY1, dated by its IST close - not September');
    eq(byMonth['2026-10'].freightValueRs, 0, 'October has no priced load, so no freight value');
    eq(byMonth['2026-10'].noValueLoads, 1, 'BOUNDARY1 is named as carrying no value');
  }

  ok(res.json && res.json.totals && res.json.totals.enquiries === 5, `totals.enquiries is 5 across all three months (got ${res.json && res.json.totals && res.json.totals.enquiries})`);
  ok(res.json && res.json.totals && res.json.totals.freightValueRs === 50000, `totals.freightValueRs is 50000 (30000 + 20000 + 0) (got ${res.json && res.json.totals && res.json.totals.freightValueRs})`);
  ok(res.json && res.json.totals && res.json.totals.noValueLoads === 3, `totals.noValueLoads is 3 (got ${res.json && res.json.totals && res.json.totals.noValueLoads})`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
