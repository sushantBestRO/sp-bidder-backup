'use strict';
/**
 * Platform-scoped readers (fix/platform-scoped-readers) - the READING half of the GoComet
 * integration. Every price request already carries a platformKey (discovery.js stamps it,
 * priceRequests.js persists it), but before this change almost no reader filtered on it - the
 * moment a GoComet record exists, every aggregate reader (including the client-facing
 * participation percentage) would silently fold it into SuperProcure's numbers. No GoComet
 * records exist yet, which is exactly why this is provable offline right now.
 *
 * THE LINE THIS FILE PINS. GoComet runs in THIS process - one `stacks` array, one
 * PriceRequestStore, one closedBids collection - so "which portal" is a property of a row, not of
 * a deployment. Two different answers are correct depending on who reads the rows:
 *
 *   - An ACCOUNTS-shaped reader is SCOPED, and the heartbeat's accounts section is the one that
 *     survives as such: it compares live stacks against loadAccounts(), an SP-only roster, and
 *     renders the words "SuperProcure account". A GoComet stack in that count is a wrong number.
 *   - The heartbeat's FUNNEL and TODAY sections are ALL-PORTAL (amended 2026-08-12, following the
 *     EOD amendment below). They were the original "an internal aggregate has no row to hang a
 *     label on, so keep it scoped" case, and that argument does not survive reading what they
 *     render: "New loads found", "Priced in time", "Missed the pricing cutoff", "N loads still
 *     waiting for a price". Those are counts of loads and bids across the whole desk, and two
 *     portals' loads and bids add - there is nothing incompatible to corrupt by summing. Unlike
 *     the EOD collectors they do no loadId lookup, so no join key needs making portal-safe.
 *   - An operator-facing ROW LIST or BULK EXPORT is ALL-PORTAL and carries an explicit `platform`
 *     column. One desk works both portals; hiding the GoComet rows that same desk priced is a
 *     worse defect than showing them, and the label makes a mixed result impossible to mistake.
 *   - The two EOD REPORTS are ALL-PORTAL with a portal-safe JOIN (section F). Amended 2026-08-12,
 *     when the scoped reading shipped: the Waaree group - a customer that exists only on GoComet -
 *     was sent "no loads today, all quiet" on a day it surfaced 88 loads and missed the cutoff on
 *     55, and the same evening's director DM put 74 surfaced loads outside the participation
 *     denominator. A single process-default platformKey cannot be the right scope for a report
 *     about a customer, because which portals a customer runs on is a property of its rows.
 *
 * Restated: scoping belongs where the two portals' rows mean different things and one of them would
 * be counted as the other. Where the reader is reporting activity - to a customer, to the director,
 * or to the morning health check - excluding a portal is itself the corruption.
 *
 * THIS FILE PROVES FOUR THINGS:
 *
 *   A. SET-EQUALITY (the safety proof). A store holding ONLY SP-tagged records AND untagged
 *      legacy records (both present - the untagged case is the one that would regress live SP
 *      reporting if platformOf's "absent means SP" reasoning were wrong) produces IDENTICAL
 *      output from every scoped reader, scoped or not - because every record in that store
 *      resolves to the SP platform either way. Then ONE GoComet-tagged record is added: every
 *      scoped reader's result stays UNCHANGED while listAll() grows by one. That is what makes
 *      "provably SP-behaviour-preserving" a fact rather than a claim. The four report collectors -
 *      the two EOD ones and the heartbeat's funnel/today - are the declared exception and are
 *      asserted to GROW instead (see the amendments above).
 *
 *   F. PORTAL-SAFE JOIN. Two requests sharing one loadId across portals, one bid record between
 *      them: the participation, win and value all land on the portal that owns the record. This is
 *      what lets the EOD collectors read every portal without a filter.
 *
 *   B. BOTH SIDES, whichever way a reader is scoped. The closedBids side is a SEPARATE pass from
 *      the request cohort in every one of these readers, so a scope applied only to the cohort
 *      leaves the other portal's bids, rejections and outcomes miscounted. Proved in both
 *      directions: buildDatasets stays scoped on both sides (B), collectFunnel reads both sides
 *      all-portal (B2).
 *
 *   E. LABELLED, NOT HIDDEN. Every exporter and every operator row list returns BOTH portals'
 *      rows and carries a correct `platform` value on each one.
 *
 *   D. THE GREP GATE. Every aggregate read of the two shared collections anywhere in src/ is
 *      accounted for, per CALL SITE and not per file, across all three access paths
 *      (requests.listAll/listOpen, bidLogger.listClosed, and a direct store.listDocs on either
 *      collection). A new, unlisted call site fails the gate - the regression this whole change
 *      exists to prevent. The gate's own scanner is unit-tested (D0) against synthetic sources,
 *      because the previous version recorded a FILE and stopped at the first match, which made it
 *      structurally unable to see a second unscoped call site in a file it had already listed.
 *
 *   node scripts/test-shared-reader-platform-scope.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../src/store');
const {
  PriceRequestStore, COLLECTION: PRICE_REQ_COLLECTION, platformOf, ownedBy,
} = require('../src/pricing/priceRequests');
const { BidLogger, COLLECTION: BIDLOG_COLLECTION } = require('../src/logging/bidLogger');
const { collectFunnel, collectToday } = require('../src/notify/heartbeat');
const { collectDirectorDay } = require('../src/notify/directorEod');
const { collectCustomerDay } = require('../src/notify/eodReport');
const exportModel = require('../src/web/exportModel');
const { makeExporters } = require('../src/web/exports');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. A file that exits 0 having asserted nothing is a silent green run
// in this project's exit-code-graded runner (scripts/run-tests.js), so the sentinel at the
// bottom pins the count.
const EXPECTED_CHECKS = 57;

const DAY = 86_400_000;
// Fixed reference instants (same pattern as test-heartbeat.js): 08:00 IST, 16 Jul 2026.
const NOW = Date.UTC(2026, 6, 16, 2, 30);
const TODAY_MID = Date.UTC(2026, 6, 15, 18, 30);   // 00:00 IST, 16 Jul
const YEST_MID = TODAY_MID - DAY;                  // 00:00 IST, 15 Jul

const loadDoc = (over) => Object.assign({
  lane: { origin: 'A', destination: 'B' }, softClose: false,
}, over);

// ================================================================================================
// THE GATE'S SCANNER, as a pure function over one file's source text, so section D0 can prove it
// catches what it is supposed to catch instead of trusting that it does.
// ================================================================================================

/**
 * Which local identifiers in THIS source name one of the two shared collections. DERIVED from the
 * file's own requires rather than hardcoded, so importing the constant under a different alias
 * cannot hide a call site from the gate.
 */
function collectionAliases(src) {
  const names = new Set();
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*(?:priceRequests|bidLogger)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.split(':').map((s) => s.trim());
      if (orig === 'COLLECTION') names.add(alias || orig);
    }
  }
  return names;
}

// The argument text of a call whose '(' is at openIdx. Balanced within the line; a call broken
// across lines yields whatever is on this line, which reads as UNSCOPED - failing toward "must be
// declared in the allowlist" rather than quietly passing.
function callArgs(line, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < line.length; i++) {
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')') { depth -= 1; if (depth === 0) return line.slice(openIdx + 1, i); }
  }
  return line.slice(openIdx + 1);
}

/**
 * Every UNSCOPED aggregate read of the two shared collections in one source file, one entry per
 * CALL SITE - no break after the first, which is the whole point. A `.listClosed(` whose own
 * arguments carry a platformKey is scoped and is not reported; testing the whole LINE for that
 * word would misread `platformKey ? x.listFor(platformKey) : x.listAll()`, where the listAll half
 * genuinely is the unscoped branch.
 */
function scanSource(src) {
  const aliases = collectionAliases(src);
  const hits = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const re = /\.(listAll|listOpen|listClosed)\(|\blistDocs\(/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const args = callArgs(line, openIdx);
      const method = m[1] || 'listDocs';
      if (method === 'listDocs') {
        // Only the two SHARED collections are in scope. Every other store-backed module reads its
        // own collection through the same call and is none of this gate's business.
        const arg = args.trim().split(/[,)]/)[0].trim();
        if (!aliases.has(arg)) continue;
      }
      if (method === 'listClosed' && /\bplatformKey\b/.test(args)) continue; // scoped at the seam
      hits.push({ line: i + 1, method, text: trimmed });
    }
  });
  return hits;
}

(async () => {
  // ---- setup: one shared store, one PriceRequestStore, one BidLogger ----
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5 });
  const bidLogger = new BidLogger({ store });

  // ---- seed: SP-tagged AND untagged-legacy price requests, both present ----
  const seedReq = (id, over) => store.putDoc(PRICE_REQ_COLLECTION, id, Object.assign({
    id, marginsPct: [10], minMarginPct: 5, marginSource: 'default', price: null, capturedAt: null,
  }, over));

  // "Yesterday" cohort (for collectFunnel's rolling window).
  await seedReq('sp-armed-yesterday', {
    loadId: '1001', platformKey: 'sp', status: 'armed',
    createdAt: YEST_MID + 3_600_000, capturedAt: YEST_MID + 3_900_000,
    price: { cost: 1000, marginsPct: [10], minMarginPct: 5 },
    load: loadDoc({ companyName: 'Waaree Energies', closesAt: YEST_MID + 5_000_000 }),
  });
  await seedReq('legacy-awaiting-yesterday', {
    // NO platformKey field at all - a record persisted before GoComet's field existed.
    loadId: '1002', status: 'awaiting_price', createdAt: YEST_MID + 4 * 3_600_000,
    load: loadDoc({ companyName: 'Waaree Energies', closesAt: YEST_MID + 8_000_000 }),
  });

  // "Today" cohort (for collectDirectorDay / collectCustomerDay / collectToday).
  await seedReq('sp-armed-today', {
    loadId: '2001', platformKey: 'sp', status: 'armed',
    createdAt: TODAY_MID + 3_600_000, capturedAt: TODAY_MID + 3_900_000,
    price: { cost: 2000, marginsPct: [10], minMarginPct: 5 },
    load: loadDoc({ companyName: 'Renewsys', closesAt: NOW + 3_600_000 }),
  });
  await seedReq('legacy-skipped-today', {
    // NO platformKey field - the exact "old data" case platformOf's fallback exists for.
    loadId: '2002', status: 'skipped_no_price', createdAt: TODAY_MID + 2 * 3_600_000,
    load: loadDoc({ companyName: 'Syngenta', closesAt: TODAY_MID + 2 * 3_600_000 - 60_000 }),
  });

  // ---- seed: matching closedBids, ALSO SP-tagged + untagged-legacy, both present ----
  const seedClosed = (id, over) => store.putDoc(BIDLOG_COLLECTION, id, Object.assign({
    auctionId: id, status: 'closed', ourBids: [], lastBidPrice: null, finalRank: null, won: null,
  }, over));
  await seedClosed('1001', {
    platformKey: 'sp', shipper: 'Waaree Energies', won: true, lastBidPrice: 1200,
    ourBids: [{ price: 1200, ts: YEST_MID + 3_800_000 }],
  });
  await seedClosed('2001', {
    // untagged legacy closedBids record.
    shipper: 'Renewsys', won: false, lastBidPrice: 2100,
    ourBids: [{ price: 2100, ts: TODAY_MID + 3_800_000 }],
  });

  // ==================================================================================
  // A1. listFor()/listAll() set-equality on the SP+legacy-only store.
  // ==================================================================================
  const idsOf = (rows) => rows.map((r) => r.id).sort();
  const allBefore = await requests.listAll();
  ok(allBefore.length === 4, `A1: seeded 4 price requests, got ${allBefore.length}`);
  const spBefore = await requests.listFor('sp');
  ok(JSON.stringify(idsOf(spBefore)) === JSON.stringify(idsOf(allBefore)),
    'A1: listFor(\'sp\') == listAll() when every record is SP-tagged or untagged-legacy');
  // Direct exercise of the untagged-legacy fallback the whole change rests on.
  ok(platformOf({ loadId: '1002' }) === 'sp', 'A1: platformOf() on an untagged record resolves to \'sp\'');
  ok(ownedBy({ loadId: '1002' }, 'sp') === true, 'A1: ownedBy() treats an untagged record as SP-owned');

  // ==================================================================================
  // A2. Every SCOPED reader: scoped('sp') output === unscoped output, on the SP+legacy store.
  // ==================================================================================
  // The heartbeat's two report collectors take no platformKey at all any more, so on the SP+legacy
  // store their job is simply to see every record - which is also the untagged-legacy proof, since
  // half this cohort has no platformKey field and must still be counted.
  const funnelScoped1 = await collectFunnel({ requests, store, now: NOW });
  ok(funnelScoped1.discovered === 2, `A2: collectFunnel cohort finds both yesterday requests, got ${funnelScoped1.discovered}`);
  ok(funnelScoped1.bidsPlaced === 1 && funnelScoped1.won === 0,
    `A2: collectFunnel reads the SP-tagged closedBids record's bid (bids ${funnelScoped1.bidsPlaced}, won ${funnelScoped1.won})`);

  const todayScoped1 = await collectToday({ requests, now: NOW });
  ok(todayScoped1.armedToday === 1, `A2: collectToday finds the one armed-today request, got ${todayScoped1.armedToday}`);
  ok(todayScoped1.awaiting === 1, `A2: collectToday finds the untagged-legacy awaiting request, got ${todayScoped1.awaiting}`);

  const dirScoped1 = await collectDirectorDay({ requests, store, customers: [], now: NOW });
  ok(dirScoped1.surfaced === 2, `A2: collectDirectorDay surfaces both today requests, got ${dirScoped1.surfaced}`);
  ok(dirScoped1.bid === 1 && dirScoped1.priced === 1,
    `A2: collectDirectorDay joins the untagged-legacy closedBids record (bid ${dirScoped1.bid}, priced ${dirScoped1.priced})`);

  const custWindow = { windowStart: TODAY_MID, windowEnd: TODAY_MID + DAY, now: NOW, aliases: ['renewsys', 'syngenta'] };
  const custScoped1 = await collectCustomerDay(Object.assign({ requests, store }, custWindow));
  ok(custScoped1.inquiries === 2, `A2: collectCustomerDay's alias-matched cohort finds both, got ${custScoped1.inquiries}`);
  ok(custScoped1.participated === 1,
    `A2: collectCustomerDay joins the untagged-legacy closedBids record, got ${custScoped1.participated}`);

  const dsScoped1 = await exportModel.buildDatasets({ requests, bidLogger }, { platformKey: 'sp' });
  const dsUnscoped1 = await exportModel.buildDatasets({ requests, bidLogger }, { platformKey: undefined });
  assert.deepStrictEqual(dsScoped1, dsUnscoped1);
  ok(dsScoped1.funnel.length === 4 && dsScoped1.outcomes.length === 2,
    `A2: buildDatasets funnel/outcomes sized correctly, got ${dsScoped1.funnel.length}/${dsScoped1.outcomes.length}`);
  ok(true, 'A2: buildDatasets scoped(\'sp\') deep-equals unscoped on the SP+legacy store (both sides)');

  // The exporters take no platformKey at all (see makeExporters) - they are all-portal by design -
  // so on a store holding only SP + legacy the label must read 'sp' on every row anyway.
  const expBefore = await makeExporters({ store, bidLogger, requests }).build('price-requests', {});
  const platIdx = expBefore.headers.indexOf('platform');
  ok(platIdx === 1, `A2: the price-requests CSV carries an explicit platform column at position 2, got ${platIdx + 1}`);
  ok(expBefore.rows.length === 4 && expBefore.rows.every((r) => r[platIdx] === 'sp'),
    `A2: every row of the SP+legacy price-requests export is labelled 'sp', ${expBefore.rows.length} rows`);

  // ==================================================================================
  // A3. Add ONE GoComet-tagged price request. listAll() grows by one; every SCOPED
  //     reader's result is UNCHANGED. companyName deliberately reuses 'Renewsys'
  //     (an SP customer's own alias) - proving the platform filter, not alias exclusivity,
  //     is what keeps this record out (per the brief: alias filtering alone would leak it).
  // ==================================================================================
  await seedReq('gocomet-armed-today', {
    loadId: 'GC-3001', platformKey: 'gocomet', status: 'armed',
    createdAt: TODAY_MID + 3 * 3_600_000, capturedAt: TODAY_MID + 3.1 * 3_600_000,
    price: { cost: 5000, marginsPct: [10], minMarginPct: 5 },
    load: loadDoc({ companyName: 'Renewsys', closesAt: NOW + 7_200_000 }),
  });

  const allAfter = await requests.listAll();
  ok(allAfter.length === 5, `A3: listAll() grew by exactly one after the GoComet record, got ${allAfter.length}`);

  // The heartbeat's funnel and today sections are the SECOND pair of declared exceptions to A3, and
  // these assertions were inverted on 2026-08-12. They used to assert both stayed UNCHANGED when a
  // GoComet record landed - which is the behaviour that would have told the director "201 new loads
  // found" on the morning of 13 Aug, on a day the desk was actually shown 275. The new record is
  // armed-today, so it moves collectToday's armed count but not the yesterday funnel's cohort.
  const funnelScoped2 = await collectFunnel({ requests, store, now: NOW });
  assert.deepStrictEqual(funnelScoped2, funnelScoped1);
  ok(true, 'A3: collectFunnel is unchanged by a GoComet record created TODAY - its window is yesterday');

  const todayScoped2 = await collectToday({ requests, now: NOW });
  ok(todayScoped2.armedToday === todayScoped1.armedToday + 1,
    `A3: collectToday COUNTS the armed GoComet load (armedToday ${todayScoped1.armedToday}->${todayScoped2.armedToday})`);

  // The two EOD collectors are the deliberate EXCEPTION to A3, and the assertions here were
  // inverted on 2026-08-12. They used to assert both stayed UNCHANGED when a GoComet record landed,
  // which is the behaviour that shipped "no loads today, all quiet" to the Waaree group on the day
  // GoComet went live with 88 surfaced loads, and that cut 74 surfaced loads out of the director's
  // participation denominator on the same evening. A report a customer reads must cover that
  // customer's loads whatever portal carried them, so both now GROW - and section F proves the
  // loadId join stays portal-safe, which is the property the old filter was really protecting.
  const dirScoped2 = await collectDirectorDay({ requests, store, customers: [], now: NOW });
  ok(dirScoped2.surfaced === dirScoped1.surfaced + 1 && dirScoped2.priced === dirScoped1.priced + 1,
    `A3: collectDirectorDay COUNTS the GoComet record (surfaced ${dirScoped1.surfaced}->${dirScoped2.surfaced}, priced ${dirScoped1.priced}->${dirScoped2.priced})`);

  const custScoped2 = await collectCustomerDay(Object.assign({ requests, store }, custWindow));
  ok(custScoped2.inquiries === custScoped1.inquiries + 1,
    `A3: collectCustomerDay COUNTS the alias-matching GoComet record (inquiries ${custScoped1.inquiries}->${custScoped2.inquiries})`);

  const dsScoped2 = await exportModel.buildDatasets({ requests, bidLogger }, { platformKey: 'sp' });
  assert.deepStrictEqual(dsScoped2, dsScoped1);
  ok(true, 'A3: buildDatasets(\'sp\') funnel/outcomes/history unchanged after the GoComet record lands');
  const dsUnscoped2 = await exportModel.buildDatasets({ requests, bidLogger }, {});
  ok(dsUnscoped2.funnel.length === dsScoped2.funnel.length + 1,
    'A3: the UNFILTERED buildDatasets, by contrast, grows by exactly the one new GoComet row');

  // The CSV export is the deliberate counter-case to the four collectors above: it does NOT stay
  // unchanged, it grows and labels the new row. A desk that priced the GoComet enquiry has to be
  // able to find it in the file it downloads.
  const expAfter = await makeExporters({ store, bidLogger, requests }).build('price-requests', {});
  const gcRow = expAfter.rows.find((r) => r[0] === 'GC-3001');
  ok(expAfter.rows.length === 5 && !!gcRow && gcRow[platIdx] === 'gocomet',
    `A3: the price-requests CSV GAINS the GoComet row, labelled 'gocomet' (${expAfter.rows.length} rows)`);

  // ==================================================================================
  // B. buildDatasets filters BOTH sides - a GoComet closedBids record proves it, since
  //    outcomes/history are built by iterating `closed` directly, not by a loadId lookup
  //    off the (already-scoped) request side.
  // ==================================================================================
  await seedClosed('GC-3001', {
    platformKey: 'gocomet', shipper: 'Renewsys', won: true, lastBidPrice: 5500,
    ourBids: [{ price: 5500, ts: TODAY_MID + 3.2 * 3_600_000 }],
  });
  const dsScopedB = await exportModel.buildDatasets({ requests, bidLogger }, { platformKey: 'sp' });
  const dsUnscopedB = await exportModel.buildDatasets({ requests, bidLogger }, {});
  ok(!dsScopedB.outcomes.some((r) => r.loadId === 'GC-3001'), 'B: scoped buildDatasets excludes the GoComet outcome row');
  ok(!dsScopedB.funnel.some((r) => r.loadId === 'GC-3001'), 'B: scoped buildDatasets excludes the GoComet funnel row');
  ok(dsUnscopedB.outcomes.some((r) => r.loadId === 'GC-3001'), 'B: unscoped buildDatasets DOES include it - proving the closed side alone would leak without the fix');

  // ==================================================================================
  // B2. collectFunnel reads BOTH sides all-portal, and the closedBids side is the half that needs
  //     proving separately: its loop iterates records directly (bidsPlaced/loadsBid/rejected/
  //     won/lost) rather than looking them up off the request cohort, so a fix applied only to the
  //     cohort would still under-report every bid, rejection and outcome the other portal produced.
  //     Both records land inside YESTERDAY's window - B's GC-3001 sits in today's and would not
  //     exercise this. Inverted 2026-08-12: this used to assert the GoComet rows stayed OUT.
  // ==================================================================================
  await seedReq('gocomet-skipped-yesterday', {
    loadId: 'GC-2998', platformKey: 'gocomet', status: 'skipped_no_price',
    createdAt: YEST_MID + 5 * 3_600_000,
    load: loadDoc({ companyName: 'Waaree Energies', closesAt: YEST_MID + 6_000_000 }),
  });
  await seedClosed('GC-2999', {
    platformKey: 'gocomet', shipper: 'Waaree Energies', won: true, lastBidPrice: 4400,
    closedAt: YEST_MID + 6_000_000,
    ourBids: [{ price: 4400, ts: YEST_MID + 5_900_000 }],
    rejectedBids: [{ price: 4600, ts: YEST_MID + 5_800_000 }],
  });
  const funnelB2 = await collectFunnel({ requests, store, now: NOW });
  ok(funnelB2.discovered === funnelScoped1.discovered + 1 && funnelB2.missedCutoff === funnelScoped1.missedCutoff + 1,
    `B2: the REQUEST side counts the GoComet load and its missed cutoff (discovered ${funnelScoped1.discovered}->${funnelB2.discovered}, missed ${funnelScoped1.missedCutoff}->${funnelB2.missedCutoff})`);
  ok(funnelB2.bidsPlaced === funnelScoped1.bidsPlaced + 1
    && funnelB2.loadsBid === funnelScoped1.loadsBid + 1
    && funnelB2.rejected === funnelScoped1.rejected + 1
    && funnelB2.won === funnelScoped1.won + 1,
  `B2: the CLOSEDBIDS side counts the GoComet bid, rejection and win - the half a cohort-only fix would miss (bids ${funnelScoped1.bidsPlaced}->${funnelB2.bidsPlaced}, rejected ${funnelScoped1.rejected}->${funnelB2.rejected}, won ${funnelScoped1.won}->${funnelB2.won})`);

  // ==================================================================================
  // C. getByLoad's optional platformKey.
  // ==================================================================================
  const byLoadUnscoped = await requests.getByLoad('1002');
  ok(!!byLoadUnscoped && byLoadUnscoped.id === 'legacy-awaiting-yesterday', 'C: getByLoad(loadId) with no platformKey still finds a legacy record');
  const byLoadScopedLegacy = await requests.getByLoad('1002', 'sp');
  ok(!!byLoadScopedLegacy && byLoadScopedLegacy.id === 'legacy-awaiting-yesterday', 'C: getByLoad(loadId, \'sp\') also finds it - untagged resolves to sp');
  const byLoadWrongPlatform = await requests.getByLoad('GC-3001', 'sp');
  ok(byLoadWrongPlatform === null, 'C: getByLoad(loadId, \'sp\') does NOT find a GoComet-tagged record');
  const byLoadRightPlatform = await requests.getByLoad('GC-3001', 'gocomet');
  ok(!!byLoadRightPlatform && byLoadRightPlatform.id === 'gocomet-armed-today', 'C: getByLoad(loadId, \'gocomet\') finds it');

  // ==================================================================================
  // E. The operator-facing half: EVERY exporter and row list returns BOTH portals' rows,
  //    each carrying a correct platform value. The store now holds sp + untagged-legacy +
  //    gocomet on both collections, which is the only state in which this is provable.
  // ==================================================================================
  const exporters = makeExporters({ store, bidLogger, requests });

  const bh = await exporters.build('bid-history', {});
  const bhPlat = bh.headers.indexOf('platform');
  const bhIds = bh.rows.map((r) => r[0]).sort();
  ok(bhPlat === 1 && bhIds.join(',') === '1001,2001,GC-2999,GC-3001',
    `E: bid-history is all-portal with a platform column at position 2 - got [${bhIds.join(',')}], platform col ${bhPlat + 1}`);
  const bhBy = new Map(bh.rows.map((r) => [r[0], r[bhPlat]]));
  ok(bhBy.get('1001') === 'sp' && bhBy.get('2001') === 'sp'
    && bhBy.get('GC-3001') === 'gocomet' && bhBy.get('GC-2999') === 'gocomet',
  `E: every bid-history row is labelled with its own portal (untagged legacy reads 'sp') - got ${JSON.stringify([...bhBy])}`);

  const bd = await exporters.build('bid-detail', {});
  const bdPlat = bd.headers.indexOf('platform');
  const bdGc = bd.rows.filter((r) => r[bdPlat] === 'gocomet');
  const bdSp = bd.rows.filter((r) => r[bdPlat] === 'sp');
  ok(bdPlat === 1 && bdGc.length === 2 && bdSp.length === 2,
    `E: bid-detail carries per-bid rows from both portals, labelled (sp ${bdSp.length}, gocomet ${bdGc.length})`);

  // The exportModel views (the .xlsx downloads) get the same treatment, and their numericColumns
  // indices have to follow the inserted column - an off-by-one there silently types the wrong
  // cells as numbers in Excel, which no row-count assertion would catch.
  const dsE = await exportModel.buildDatasets({ requests, bidLogger }, {});
  const fv = exportModel.VIEWS.funnel.project(dsE.funnel);
  const fvPlat = fv.headers.indexOf('Platform');
  ok(fvPlat === 1 && fv.rows.some((r) => r[fvPlat] === 'gocomet') && fv.rows.some((r) => r[fvPlat] === 'sp'),
    'E: the funnel view is all-portal with a Platform column, both values present');
  ok(fv.numericColumns.every((i) => ['Distance(KM)', 'Weight', 'Time-to-Price (min)', 'Our Cost', 'Our Last Bid', 'Final Rank', 'SP Lane Avg'].includes(fv.headers[i])),
    `E: FUNNEL_NUMERIC still points at the numeric headers after the insert - ${JSON.stringify(fv.numericColumns.map((i) => fv.headers[i]))}`);
  const ov = exportModel.VIEWS.outcomes.project(dsE.outcomes);
  ok(ov.headers.indexOf('Platform') === 1
    && ov.numericColumns.every((i) => ['Distance(KM)', 'Units', 'Cost', 'Floor', 'Opening Bid', 'Floor Bid', 'Our Last Bid', 'Num Bids', 'Realized Margin %', 'Final Rank'].includes(ov.headers[i])),
  `E: the outcomes view is labelled and OUTCOMES_NUMERIC follows the insert - ${JSON.stringify(ov.numericColumns.map((i) => ov.headers[i]))}`);
  const bv = exportModel.VIEWS.bids.project(dsE.outcomes);
  ok(bv.headers.indexOf('Platform') === 1
    && bv.numericColumns.every((i) => ['Bid #', 'Rung Index', 'Price', 'Rank (socket)', 'Latency(ms)', 'Extends Observed', 'Revisions Left', 'Secs Before Close at Bid', 'Secs Before Final Close'].includes(bv.headers[i])),
  `E: the bids view is labelled and BIDS_NUMERIC follows the insert - ${JSON.stringify(bv.numericColumns.map((i) => bv.headers[i]))}`);

  // /api/history's wire shape, and the filter that lets the desk narrow an all-portal list back
  // to one portal - which is what makes "all-portal" a usable answer rather than only an honest one.
  const wire = dsE.history.map(exportModel.historyWireRow);
  ok(wire.every((r) => r.platform === 'sp' || r.platform === 'gocomet') && wire.some((r) => r.platform === 'gocomet'),
    'E: every /api/history wire row carries its portal, GoComet included');
  const spOnly = exportModel.applyFilters(dsE.funnel, exportModel.parseFilters({ platform: 'sp' }));
  ok(spOnly.length === dsScoped1.funnel.length && !spOnly.some((r) => r.platform === 'gocomet'),
    `E: platform=sp narrows the all-portal funnel back to exactly the scoped set (${spOnly.length} vs ${dsScoped1.funnel.length})`);
  ok(exportModel.facets(dsE.funnel, dsE.outcomes).platforms.join(',') === 'gocomet,sp',
    'E: the filter panel offers both portals as facet values');

  // ==================================================================================
  // F. THE JOIN IS PORTAL-SAFE. Now that both EOD collectors read every portal's rows, the
  //    loadId -> closedBids lookup is the only thing standing between them and one portal's
  //    result being reported as another's. Two requests share the id 'X9' across portals and
  //    only the GoComet one has a bid record: a bare-loadId join would report the SP load as
  //    participated and won as well. Its own store, so the counts above are untouched.
  // ==================================================================================
  const store2 = createStore({ backend: 'memory' });
  const requests2 = new PriceRequestStore({ store: store2, marginsPct: [10], minMarginPct: 5 });
  const seed2 = (id, over) => store2.putDoc(PRICE_REQ_COLLECTION, id, Object.assign({
    id, marginsPct: [10], minMarginPct: 5, marginSource: 'default', price: null, capturedAt: null,
  }, over));
  await seed2('sp-X9', {
    loadId: 'X9', platformKey: 'sp', status: 'armed', createdAt: TODAY_MID + 3_600_000,
    load: loadDoc({ companyName: 'Collide', closesAt: NOW + 3_600_000 }),
  });
  await seed2('gc-X9', {
    loadId: 'X9', platformKey: 'gocomet', status: 'armed',
    createdAt: TODAY_MID + 3_600_000, capturedAt: TODAY_MID + 3_700_000,
    load: loadDoc({ companyName: 'Collide', closesAt: NOW + 3_600_000 }),
  });
  await store2.putDoc(BIDLOG_COLLECTION, 'X9', {
    auctionId: 'X9', platformKey: 'gocomet', status: 'closed', won: true, cost: 100, lastBidPrice: 130,
    finalRank: 1, ourBids: [{ price: 130, ts: TODAY_MID + 3_800_000 }],
  });

  const collideCust = await collectCustomerDay({
    requests: requests2, store: store2, aliases: ['collide'],
    windowStart: TODAY_MID, windowEnd: TODAY_MID + DAY, now: NOW,
  });
  ok(collideCust.inquiries === 2,
    `F: both portals' same-id requests are in the customer's cohort, got ${collideCust.inquiries}`);
  ok(collideCust.participated === 1 && collideCust.won === 1,
    `F: only the portal that OWNS the bid record joins it - a bare-loadId join would say 2/2 (got ${collideCust.participated}/${collideCust.won})`);

  const collideDir = await collectDirectorDay({ requests: requests2, store: store2, customers: [], now: NOW });
  ok(collideDir.surfaced === 2 && collideDir.bid === 1,
    `F: collectDirectorDay counts both surfaced but credits the bid to one portal only (surfaced ${collideDir.surfaced}, bid ${collideDir.bid})`);
  ok(collideDir.won === 1 && collideDir.winningBidValue === 130,
    `F: the win and its value are counted ONCE - the SP twin cannot inherit them (won ${collideDir.won}, value ${collideDir.winningBidValue})`);

  // ==================================================================================
  // D0. The gate's own scanner, against synthetic sources. The previous gate recorded a FILE
  //     and broke after the first match, so a second unscoped call site in an already-listed
  //     file was invisible - and its regex saw only `.listAll()`, so the unscoped listClosed()
  //     readers in exports.js passed it green. Both are pinned here.
  // ==================================================================================
  const REQUIRE_BIDLOG = "const { COLLECTION: BIDLOG_COLLECTION } = require('../logging/bidLogger');\n";
  ok(scanSource('const a = await requests.listAll();\nconst b = await requests.listAll();\n').length === 2,
    'D0: two listAll() call sites in ONE file are BOTH reported (the per-file break is gone)');
  ok(scanSource('const r = await bidLogger.listClosed({ from, to });\n').length === 1,
    'D0: an unscoped bidLogger.listClosed() is reported - the access path the old regex could not see');
  ok(scanSource('const r = await bidLogger.listClosed({ from, to, platformKey });\n').length === 0,
    'D0: a listClosed() scoped at the seam is NOT reported');
  ok(scanSource(`${REQUIRE_BIDLOG}const d = await store.listDocs(BIDLOG_COLLECTION);\n`).length === 1,
    'D0: a direct store.listDocs() on a shared collection is reported, alias resolved from the require');
  ok(scanSource('const d = await store.listDocs(ACCOUNTS_COLLECTION);\n').length === 0,
    'D0: a listDocs() on some OTHER collection is not this gate\'s business');
  ok(scanSource('// const a = await requests.listAll();\n').length === 0,
    'D0: a commented-out call site is not a call site');

  // ==================================================================================
  // D. The gate itself: every unscoped aggregate read of the two shared collections in src/,
  //    declared per file with its call-site COUNT.
  // ==================================================================================
  // The two seam OWNERS are excluded: their listDocs(COLLECTION) IS the seam every entry below
  // reads through, and holding them to this rule would just forbid the collections from having an
  // implementation. Everything else in src/ is in scope.
  const OWNERS = [path.join('pricing', 'priceRequests.js'), path.join('logging', 'bidLogger.js')];

  // Files whose broad read is DELIBERATE and must stay that way: the rows reach a human, labelled.
  // The count is exact in BOTH directions here - losing one of these means somebody scoped an
  // operator-facing view, which is the failure this half of the gate exists to catch.
  const CROSS_PLATFORM = new Map([
    [path.join('web', 'server.js'), { count: 3, why: '/api/state + /api/price-requests + /api/closed-bids - one desk, both portals, platformKey per row' }],
    [path.join('web', 'exports.js'), { count: 3, why: 'bid-history + bid-detail + price-requests CSVs - all-portal with a platform column' }],
    [path.join('platform', 'mockAdapter.js'), { count: 1, why: 'auctionSim.listOpen() - an unrelated simulator method that happens to share the name' }],
  ]);

  // Files that read broadly and then scope AT THE CALL SITE (ownedBy / an explicit platformKey).
  // The count is an UPPER BOUND, not an equality: consolidating one of these onto listFor() or the
  // listClosed() seam is a strictly correct change that removes a call site, and a gate that failed
  // on it would be blocking the tightening it exists to encourage. Adding one still fails.
  const SCOPED_AT_CALL_SITE = new Map([
    [path.join('notify', 'directorEod.js'), { max: 2, why: 'all-portal by design (section F) - the closedBids join is keyed on (portal, loadId), not filtered' }],
    [path.join('notify', 'eodReport.js'), { max: 3, why: 'all-portal by design (section F) - the closedBids join is keyed on (portal, loadId), not filtered. The third site is unclaimedLoads, which joins nothing and so has no key to scope: it asks which of TODAY\'S loads no reporting group claimed, and a portal filter there would hide exactly the gap it exists to find' }],
    [path.join('notify', 'heartbeat.js'), { max: 3, why: 'collectFunnel (requests + closedBids) and collectToday (requests) are all-portal by design - neither joins by loadId, so there is no key to scope' }],
    [path.join('web', 'exportModel.js'), { max: 1, why: 'the listFor/listAll ternary - the listAll branch is the deliberate all-portal one' }],
    [path.join('discovery', 'discovery.js'), { max: 1, why: 'the pass snapshot that stands in for getByLoad(loadId) - the same unscoped read, keyed on loadId with the first match winning, taken once per stretch instead of once per listed load; createForLoad re-checks through the same unscoped getByLoad' }],
    [path.join('reports', 'monthlyFreightValue.js'), { max: 2, why: 'all-portal by design, same as the EOD reports (section F) - the archive/live-request/closedBids merge is keyed on (portal, loadId) via eodReport.js\'s own loadKey, so this is a report on freight value across the whole desk, not per portal' }],
  ]);

  const srcRoot = path.join(__dirname, '..', 'src');
  const found = new Map(); // rel -> [{line, method, text}]
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(srcRoot, p);
      if (OWNERS.includes(rel)) continue;
      const hits = scanSource(fs.readFileSync(p, 'utf8'));
      if (hits.length) found.set(rel, hits);
    }
  })(srcRoot);

  const describe = (rel) => `${rel} [${found.get(rel).map((h) => `${h.line}:${h.method}`).join(', ')}]`;
  const unexpected = [...found.keys()].filter((f) => !CROSS_PLATFORM.has(f) && !SCOPED_AT_CALL_SITE.has(f));
  ok(unexpected.length === 0,
    `D: no UNDECLARED file reads the shared collections unscoped - offenders: ${JSON.stringify(unexpected.map(describe))}`);

  const overCount = [...found.keys()].filter((f) => {
    const cp = CROSS_PLATFORM.get(f);
    const sc = SCOPED_AT_CALL_SITE.get(f);
    const limit = cp ? cp.count : (sc ? sc.max : 0);
    return found.get(f).length > limit;
  });
  ok(overCount.length === 0,
    `D: no declared file gained an unscoped call site - offenders: ${JSON.stringify(overCount.map(describe))}`);

  const lostCrossPlatform = [...CROSS_PLATFORM.keys()].filter((f) => (found.get(f) || []).length !== CROSS_PLATFORM.get(f).count);
  ok(lostCrossPlatform.length === 0,
    `D: every deliberately cross-platform read is still cross-platform - changed: ${JSON.stringify(lostCrossPlatform)}`);

  // A walker that silently found nothing would pass all three assertions above. Pin the floor.
  const totalSites = [...found.values()].reduce((n, h) => n + h.length, 0);
  ok(found.size >= 7 && totalSites >= 12,
    `D: the walker actually scanned the tree - ${found.size} files, ${totalSites} call sites`);

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE, so an early return or a swallowed throw would otherwise exit 0
  // as a green zero-assertion run. Assert the full check count actually executed, not just that
  // nothing failed.
  assert.strictEqual(fail, 0, `${fail} platform-scope checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
