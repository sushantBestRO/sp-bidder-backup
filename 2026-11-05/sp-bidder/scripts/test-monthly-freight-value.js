'use strict';
/**
 * BC-28 / CW-241: monthly freight value since launch (src/reports/monthlyFreightValue.js).
 *
 * Combined-release review (release-2026-09-28/r1, findings 1-4 + 7) found four real defects in
 * the first cut, all fixed here and pinned:
 *   - lane average is a PER-VEHICLE figure and must be scaled by unit count on a truck basis
 *     (was returned flat - understated every multi-truck never-bid load);
 *   - a closedBids-only row (its price request pruned, no archive row either) had no quoteType
 *     anywhere and silently fell through to "PMT", so a multi-truck our-rate bid was never scaled
 *     and a per-tonne lane anchor was used as a whole-load value on an unknown basis;
 *   - collectSinceLaunch scanned the archive from epoch 0 (readEvents' day-loop probes one file
 *     per day, ~20,700 of them) instead of bounding to the days the stream actually has files for;
 *   - the report claimed 'all loads' uniformly even for months that predate the archive stream,
 *     where only closedBids-sourced (armed) loads exist at all.
 *
 * Exercises: the per-load value priority (our rate -> lane average -> no value) under all three
 * basis states (truck / PMT / genuinely unknown), the truck-vs-PMT unit scaling on BOTH value
 * paths, an IST month boundary that disagrees with the UTC calendar day, the all-loads enquiry
 * count (never-priced loads still counted, never dropped), the complete/partial per-month
 * classification, the three-source merge/dedup in collectSinceLaunch, and the bounded archive
 * read (never epoch 0).
 */

const { valueForLoad, buildMonthlyReport, collectSinceLaunch } = require('../src/reports/monthlyFreightValue');
const { istMonthStamp } = require('../src/notify/dailyTask');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  // ---- valueForLoad: our rate, truck basis scales by doc.units (the #233 fix, reused) ----
  {
    const load = { quoteType: 'FTL' };
    const doc = { ourBids: [{ ts: 1 }], lastBidPrice: 50000, units: 3 };
    const { value, source } = valueForLoad({ load, doc });
    ok(value === 150000, `truck basis scales by units: got ${value}`);
    ok(source === 'our_rate', 'source is our_rate when a bid was placed');
  }

  // ---- valueForLoad: PMT our-rate never scales - a per-tonne rate stands alone ----
  {
    const load = { quoteType: 'PMT' };
    const doc = { ourBids: [{ ts: 1 }], lastBidPrice: 2240, units: 22 };
    const { value, source } = valueForLoad({ load, doc });
    ok(value === 2240, `PMT contributes its rate alone, never rate*tonnage: got ${value}`);
    ok(source === 'our_rate', 'PMT with a real bid is still our_rate');
  }

  // ---- FIX (finding 2): lane average is per-vehicle - armed-but-never-bid, truck basis, must
  //      scale by units. The committed test used to pin 42000 (unscaled); it is 84000. ----
  {
    const load = { quoteType: 'FTL', laneFreight: { ftl: 42000, pmt: null, freightRate: null } };
    const doc = { ourBids: [], lastBidPrice: null, units: 2, laneFreight: { ftl: 42000, pmt: null, freightRate: null } };
    const { value, source } = valueForLoad({ load, doc });
    ok(value === 84000, `SP's lane average is per-vehicle, so 2 trucks is 42000 x 2: got ${value}`);
    ok(source === 'lane_average', 'source is lane_average, not our_rate, when ourBids is empty');
  }

  // ---- review r2 V1-F01: an unknown basis is only ambiguous when more than one unit is at stake ----
  {
    const one = valueForLoad({ load: null, doc: { ourBids: [{}], lastBidPrice: 18500, units: 1 }, platformKey: 'sp' });
    ok(one.value === 18500 && one.source === 'our_rate', `unknown basis, 1 unit: truck and per-tonne agree, value is the bid: got ${one.value}`);
    const noCount = valueForLoad({ load: null, doc: { ourBids: [{}], lastBidPrice: 18500 }, platformKey: 'sp' });
    ok(noCount.value === 18500, `unknown basis, no unit count recorded: value is the bid: got ${noCount.value}`);
    const many = valueForLoad({ load: null, doc: { ourBids: [{}], lastBidPrice: 2400, units: 30 }, platformKey: 'sp' });
    ok(many.value === null, `unknown basis, 30 units on SuperProcure: genuinely ambiguous, no value: got ${many.value}`);
    const gc = valueForLoad({ load: null, doc: { ourBids: [{}], lastBidPrice: 45000, units: 2 }, platformKey: 'gocomet' });
    ok(gc.value === 90000, `GoComet has no per-tonne basis, so an unrecorded basis is per truck: got ${gc.value}`);
  }

  // ---- lane average, PMT basis: the anchor is used as-is, matching the our-rate PMT treatment ----
  {
    const load = { quoteType: 'PMT', laneFreight: { ftl: null, pmt: 1749.55, freightRate: null } };
    const doc = { ourBids: [], lastBidPrice: null, units: 22 };
    const { value, source } = valueForLoad({ load, doc });
    ok(value === 1749.55, `PMT lane average is per-tonne already, never scaled by units: got ${value}`);
    ok(source === 'lane_average', 'PMT lane average with no bid is still lane_average');
  }

  // ---- never priced at all, no closedBids doc: lane average lives on the live load, scaled by
  //      the load's own nominal unit count (the only unit source when no doc exists) ----
  {
    const load = { quoteType: 'FTL', units: 2, laneFreight: { ftl: 61000, pmt: null, freightRate: null } };
    const { value, source } = valueForLoad({ load, doc: null });
    ok(value === 122000, `no doc at all -> unit count comes from the load's own units (2): got ${value}`);
    ok(source === 'lane_average', 'source is lane_average with no doc');
  }

  // ---- SP's own "no anchor for this quote type" 0 is not a real value ----
  {
    const load = { quoteType: 'FTL', units: 2, laneFreight: { ftl: 0, pmt: 0, freightRate: 0 } };
    const { value, source } = valueForLoad({ load, doc: null });
    ok(value == null, `a zero anchor means no anchor, not a real zero freight value: got ${value}`);
    ok(source === 'none', 'source is none when every anchor is the SP zero-placeholder');
  }

  // ---- nothing at all -> no value, never a fabricated 0 ----
  {
    const { value, source } = valueForLoad({ load: { quoteType: 'FTL' }, doc: null });
    ok(value == null && source === 'none', 'a load with no rate and no lane average has no value');
  }

  // ---- FIX (finding 3): closedBids-only row, load gone, basis now recoverable from doc.quoteType
  //      (carried onto closedBids at arm time) - a 3-truck bid must scale, not fall back to 1 ----
  {
    const doc = { ourBids: [{ ts: 1 }], lastBidPrice: 40000, units: 3, quoteType: 'FTL' };
    const { value, source } = valueForLoad({ load: null, doc });
    ok(value === 120000, `closedBids' own quoteType recovers the truck basis: got ${value} (was 40000 when load was required)`);
    ok(source === 'our_rate', 'still our_rate once the basis is known from the doc alone');
  }

  // ---- FIX (finding 3): closedBids-only row, quoteType genuinely never recorded (an older
  //      record from before this fix) - no value, never a guessed x1 ----
  {
    const doc = { ourBids: [{ ts: 1 }], lastBidPrice: 40000, units: 3, quoteType: null };
    const { value, source } = valueForLoad({ load: null, doc });
    ok(value == null, `unknown basis is no value, not a silent units=1 guess: got ${value}`);
    ok(source === 'none', 'source is none on a genuinely unrecorded basis');
  }

  // ---- FIX (finding 2, second trigger): closedBids-only row, never bid, basis unknown - the old
  //      code took the PMT anchor as the whole load's value; now it is no value ----
  {
    const doc = { ourBids: [], lastBidPrice: null, quoteType: null, laneFreight: { ftl: null, pmt: 1749.55, freightRate: null } };
    const { value, source } = valueForLoad({ load: null, doc });
    ok(value == null, `an unknown-basis anchor is not assumed PMT and used as the whole load's value: got ${value}`);
    ok(source === 'none', 'source is none - the anchor exists but the basis needed to read it does not');
  }

  // ---- closedBids-only row, KNOWN PMT basis (quoteType carried), never bid - the PMT anchor IS
  //      usable once the basis is actually known, unscaled ----
  {
    const doc = { ourBids: [], lastBidPrice: null, quoteType: 'PMT', laneFreight: { ftl: null, pmt: 1749.55, freightRate: null } };
    const { value, source } = valueForLoad({ load: null, doc });
    ok(value === 1749.55, `a KNOWN PMT basis can still use the anchor, unscaled: got ${value}`);
    ok(source === 'lane_average', 'source is lane_average once the basis is known');
  }

  // ---- istMonthStamp: an IST month boundary that disagrees with the UTC calendar day ----
  {
    // 30 Sep 2026 20:00 UTC = 1 Oct 2026 01:30 IST - UTC still says September, IST already October.
    const crossesForward = Date.UTC(2026, 8, 30, 20, 0, 0);
    ok(istMonthStamp(crossesForward) === '2026-10', `UTC Sep 30 20:00 is IST Oct 1: got ${istMonthStamp(crossesForward)}`);

    // 30 Sep 2026 17:00 UTC = 30 Sep 2026 22:30 IST - stays in September despite being close to
    // the UTC month-end.
    const staysSeptember = Date.UTC(2026, 8, 30, 17, 0, 0);
    ok(istMonthStamp(staysSeptember) === '2026-09', `30 Sep 17:00 UTC is still 30 Sep IST: got ${istMonthStamp(staysSeptember)}`);
  }

  // ---- buildMonthlyReport: all-loads basis - enquiries counts a never-priced, no-value load.
  //      allLoadsFrom is well before this month, so it reads complete. ----
  {
    const sep = Date.UTC(2026, 8, 15, 10, 0, 0);
    const rows = [
      { loadId: 'L1', platformKey: 'sp', anchorAt: sep, load: { quoteType: 'FTL' }, doc: { ourBids: [{ ts: 1 }], lastBidPrice: 10000, units: 1 } },
      { loadId: 'L2', platformKey: 'sp', anchorAt: sep, load: { quoteType: 'FTL' }, doc: null }, // never priced, no lane avg
      { loadId: 'L3', platformKey: 'sp', anchorAt: sep, load: { quoteType: 'FTL', units: 1, laneFreight: { ftl: 5000 } }, doc: null }, // never priced, lane avg
    ];
    const report = buildMonthlyReport(rows, { allLoadsFrom: Date.UTC(2026, 7, 1) });
    ok(report.length === 1, 'one month bucket for three September rows');
    const m = report[0];
    ok(m.month === '2026-09', `bucketed as 2026-09: got ${m.month}`);
    ok(m.complete === true, 'September is complete: allLoadsFrom is in August, strictly before it');
    ok(m.enquiries === 3, `ALL loads basis counts all three, not just the priced one: got ${m.enquiries}`);
    ok(m.freightValueRs === 15000, `sum of the two loads that had a value (10000 + 5000): got ${m.freightValueRs}`);
    ok(m.ourRateLoads === 1 && m.laneAverageLoads === 1, `one our_rate, one lane_average: got ${m.ourRateLoads}/${m.laneAverageLoads}`);
    ok(m.noValueLoads.length === 1 && m.noValueLoads[0].loadId === 'L2', 'the report names the one load with no value, it does not just count it');
  }

  // ---- FIX (finding 1): a month cannot claim 'all loads' before the archive existed. The
  //      archive-start month itself, and everything before it, is 'partial'; only a full
  //      calendar month strictly after it is 'complete'. No allLoadsFrom -> every month partial. ----
  {
    const aug = Date.UTC(2026, 7, 10, 10, 0, 0);   // before the archive - closedBids-only era
    const sepStart = Date.UTC(2026, 8, 25, 10, 0, 0); // the archive-start month itself
    const oct = Date.UTC(2026, 9, 5, 10, 0, 0);    // a full month after the archive started
    const rows = [
      { loadId: 'AUG1', platformKey: 'sp', anchorAt: aug, load: null, doc: { ourBids: [{ ts: 1 }], lastBidPrice: 1000, units: 1, quoteType: 'FTL' } },
      { loadId: 'SEP1', platformKey: 'sp', anchorAt: sepStart, load: null, doc: { ourBids: [{ ts: 1 }], lastBidPrice: 1000, units: 1, quoteType: 'FTL' } },
      { loadId: 'OCT1', platformKey: 'sp', anchorAt: oct, load: { quoteType: 'FTL' }, doc: null },
    ];
    const allLoadsFrom = Date.UTC(2026, 8, 25); // the archive's earliest covered instant
    const report = buildMonthlyReport(rows, { allLoadsFrom });
    const byMonth = Object.fromEntries(report.map((m) => [m.month, m]));
    ok(byMonth['2026-08'].complete === false, 'August (before the archive) is partial');
    ok(byMonth['2026-09'].complete === false, 'September (the archive-start month itself) is partial too - only complete from allLoadsFrom onward within it');
    ok(byMonth['2026-10'].complete === true, 'October (a full month after the archive started) is complete');

    const noArchive = buildMonthlyReport(rows, { allLoadsFrom: null });
    ok(noArchive.every((m) => m.complete === false), 'with no archive data at all, every month is partial');
  }

  // ---- buildMonthlyReport: a row with no anchorAt cannot be dated into a month ----
  {
    const report = buildMonthlyReport([{ loadId: 'L4', platformKey: 'sp', anchorAt: null, load: {}, doc: null }]);
    ok(report.length === 0, 'an undateable row is skipped, never guessed into a month');
  }

  // ---- buildMonthlyReport: two months split correctly, sorted ascending ----
  {
    const aug = Date.UTC(2026, 7, 20, 10, 0, 0);
    const sep = Date.UTC(2026, 8, 5, 10, 0, 0);
    const rows = [
      { loadId: 'A1', platformKey: 'sp', anchorAt: sep, load: { quoteType: 'FTL' }, doc: { ourBids: [{ ts: 1 }], lastBidPrice: 1000, units: 1 } },
      { loadId: 'A2', platformKey: 'sp', anchorAt: aug, load: { quoteType: 'FTL' }, doc: { ourBids: [{ ts: 1 }], lastBidPrice: 2000, units: 1 } },
    ];
    const report = buildMonthlyReport(rows, { allLoadsFrom: null });
    ok(report.length === 2, 'two distinct months');
    ok(report[0].month === '2026-08' && report[1].month === '2026-09', 'sorted oldest month first');
  }

  // ---- collectSinceLaunch: merges live requests + archive + closedBids, dedup by (platform,
  //      loadId), and computes allLoadsFrom off the archive rows' own endedAt ----
  {
    const sep = Date.UTC(2026, 8, 10, 10, 0, 0);
    const closesAt = sep;
    const archiveDay = Date.UTC(2026, 8, 25); // the day-FILE this row happens to be written into
    const readEventsCalls = [];
    const fakeRequests = {
      listAll: async () => ([
        // never priced, still live within the request store - carries laneFreight live.
        { loadId: 'LIVE-1', platformKey: 'sp', createdAt: sep - 1000, load: { closesAt, quoteType: 'FTL', units: 1, laneFreight: { ftl: 7000 } } },
        // this one WAS armed and closed - also present in closedDocs below; must count once.
        { loadId: 'CLOSED-1', platformKey: 'sp', createdAt: sep - 2000, load: { closesAt, quoteType: 'FTL' } },
      ]),
      store: {
        listStreamDays: async () => ([archiveDay]),
        readEvents: async (stream, opts) => {
          readEventsCalls.push(opts);
          return [
            // aged out of the live store already; archive row is now its only source. endedAt (the
            // auction's OWN date) is well before the day-FILE's write-time name above.
            { loadId: 'ARCHIVED-1', platformKey: 'sp', quoteType: 'FTL', endedAt: sep, createdAt: sep - 3000 },
          ];
        },
      },
    };
    const fakeBidLogger = {
      listClosed: async () => ([
        { auctionId: 'CLOSED-1', platformKey: 'sp', ourBids: [{ ts: 1 }], lastBidPrice: 9000, units: 1, closedAt: sep + 500 },
      ]),
    };
    const { rows, allLoadsFrom } = await collectSinceLaunch({ requests: fakeRequests, bidLogger: fakeBidLogger });
    ok(rows.length === 3, `three distinct loads, CLOSED-1 counted once despite appearing in two sources: got ${rows.length}`);
    const byId = Object.fromEntries(rows.map((r) => [r.loadId, r]));
    ok(byId['CLOSED-1'].doc && byId['CLOSED-1'].doc.lastBidPrice === 9000, 'CLOSED-1 carries its closedBids doc');
    ok(byId['LIVE-1'].load.laneFreight.ftl === 7000, 'LIVE-1 carries its live load snapshot with laneFreight');
    ok(byId['ARCHIVED-1'].anchorAt === sep, "ARCHIVED-1 is dated off the archive row's endedAt");
    ok(allLoadsFrom === sep, `allLoadsFrom is the archive row's OWN endedAt (${sep}), not the day-file's write-time name (${archiveDay})`);

    ok(readEventsCalls.length === 1, 'readEvents was called exactly once for the archive stream');
    ok(readEventsCalls[0].from === archiveDay, 'readEvents is bounded to the day listStreamDays actually found, never epoch 0');
    ok(readEventsCalls[0].from !== 0, 'FIX (finding 4): the archive scan never starts at epoch 0');

    const report = buildMonthlyReport(rows, { allLoadsFrom });
    ok(report.length === 1 && report[0].month === '2026-09', 'all three fall in the same September bucket');
    ok(report[0].complete === false, 'September is the archive-start month itself, so it is partial, not complete');
    ok(report[0].enquiries === 3, 'enquiries counts all three sources merged, all-loads basis');
    // CLOSED-1: our rate (9000, load.quoteType='FTL' resolves the basis, units 1). LIVE-1: never
    // priced, but its still-live snapshot carries a lane average (7000, units 1) - the exact
    // "where one exists" case CW-241 describes. ARCHIVED-1: never priced, already aged out of the
    // live store, archive rows never carry laneFreight - no value survives.
    ok(report[0].freightValueRs === 16000, `9000 (CLOSED-1 our rate) + 7000 (LIVE-1 lane average): got ${report[0].freightValueRs}`);
    ok(report[0].noValueLoads.length === 1 && report[0].noValueLoads[0].loadId === 'ARCHIVED-1', 'ARCHIVED-1 is the one load the report names as carrying no value');
  }

  // ---- FIX (finding 4): no archive files exist at all - readEvents must never be called, and
  //      allLoadsFrom stays null (every month then reads partial) ----
  {
    let readEventsCalled = false;
    const fakeRequests = {
      listAll: async () => ([]),
      store: {
        listStreamDays: async () => ([]),
        readEvents: async () => { readEventsCalled = true; return []; },
      },
    };
    const { rows, allLoadsFrom } = await collectSinceLaunch({ requests: fakeRequests, bidLogger: { listClosed: async () => [] } });
    ok(rows.length === 0, 'nothing to merge when every source is empty');
    ok(allLoadsFrom === null, 'no archive data at all -> allLoadsFrom is null');
    ok(readEventsCalled === false, 'readEvents is never called when listStreamDays found no files - zero probing, not even one');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
