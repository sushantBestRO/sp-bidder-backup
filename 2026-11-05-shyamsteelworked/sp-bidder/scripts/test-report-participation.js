'use strict';
/**
 * Deterministic, offline test for scripts/report-participation.js. Seeds synthetic price-request +
 * closed-bid records with KNOWN expected counts and asserts the participation funnel, the IST hour
 * bucketing (incl. midnight / 6pm / day-boundary edges and the year-2100 placeholder guard), the
 * customer / close-model segmentation, missing-field tolerance, and the CSV/env parsing helpers.
 *
 * Pure - imports only the exported pure functions (requiring the module runs no IO), so it needs
 * no live store and no running box. Part of `npm test` (scripts/run-tests.js globs test-*.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const R = require('./report-participation');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass += 1; } else { fail += 1; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// A fixed "now" so plausibility bounds are deterministic across machines/dates.
const NOW = Date.UTC(2026, 6, 25, 6, 0, 0); // 2026-07-25 11:30 IST

// ---- 1. istHour boundary cases (arithmetic IST, no ICU 24:00 quirk) --------------------------
eq(R.istHour(Date.UTC(2026, 6, 24, 3, 30, 0)), 9, 'istHour: 03:30 UTC = 09:00 IST');
eq(R.istHour(Date.UTC(2026, 6, 24, 12, 30, 0)), 18, 'istHour: 12:30 UTC = 18:00 IST (the 6pm boundary)');
eq(R.istHour(Date.UTC(2026, 6, 24, 18, 30, 0)), 0, 'istHour: 18:30 UTC = 00:00 IST next day (midnight, not 24)');
eq(R.istHour(Date.UTC(2026, 6, 24, 18, 29, 0)), 23, 'istHour: 18:29 UTC = 23:59 IST (last hour of day)');
eq(R.istHour(Date.UTC(2026, 6, 24, 18, 45, 0)), 0, 'istHour: 18:45 UTC = 00:15 IST next day');
eq(R.istHour(Date.UTC(2026, 6, 24, 6, 30, 0)), 12, 'istHour: 06:30 UTC = 12:00 IST noon');
eq(R.istHour(null), null, 'istHour: null -> null');
eq(R.istHour(''), null, 'istHour: empty -> null');
eq(R.istHour(NaN), null, 'istHour: NaN -> null');
eq(R.istHour(String(Date.UTC(2026, 6, 24, 3, 30, 0))), 9, 'istHour: numeric string accepted');

// ---- 2. parseTs / plausibleTs ---------------------------------------------------------------
eq(R.parseTs('2026-07-24T03:30:00.000Z'), Date.UTC(2026, 6, 24, 3, 30, 0), 'parseTs: ISO string');
eq(R.parseTs(1690000000000), 1690000000000, 'parseTs: epoch number');
eq(R.parseTs('1690000000000'), 1690000000000, 'parseTs: epoch string');
eq(R.parseTs(''), null, 'parseTs: empty -> null');
eq(R.parseTs(null), null, 'parseTs: null -> null');
eq(R.plausibleTs(Date.UTC(2100, 0, 1, 0, 0, 0), NOW), null, 'plausibleTs: year-2100 placeholder -> null');
eq(R.plausibleTs(Date.UTC(1990, 0, 1, 0, 0, 0), NOW), null, 'plausibleTs: ancient -> null');
eq(R.plausibleTs(Date.UTC(2026, 6, 24, 3, 0, 0), NOW), Date.UTC(2026, 6, 24, 3, 0, 0), 'plausibleTs: recent -> passes');

// ---- 3. deriveStatus (mirror of exportModel) ------------------------------------------------
eq(R.deriveStatus('armed', { numBids: 2, won: true }), 'won', 'deriveStatus: closed + bids + won -> won');
eq(R.deriveStatus('armed', { numBids: 1, won: false }), 'lost', 'deriveStatus: closed + bids + !won -> lost');
eq(R.deriveStatus('armed', { numBids: 0, won: false }), 'no_bid', 'deriveStatus: closed + 0 bids -> no_bid');
eq(R.deriveStatus('skipped_no_price', null), 'skipped_no_price', 'deriveStatus: funnel-only skipped');
eq(R.deriveStatus('dismissed', null), 'dismissed', 'deriveStatus: funnel-only dismissed');
eq(R.deriveStatus('closed', null), 'no_bid', 'deriveStatus: req closed with no outcome -> no_bid (never invented win/loss)');
eq(R.deriveStatus(null, null), 'unknown', 'deriveStatus: nothing -> unknown');

// ---- 4. funnel build + summary (the headline counts) ----------------------------------------
// L1 priced+won(2 bids); L2 priced+lost(1 bid); L3 skipped_no_price; L4 priced+no_bid(0 bids);
// L5 dismissed; L6 awaiting_price (open).
const H = (utc) => Date.UTC(2026, 6, 24, utc, 0, 0);
const reqLikes = [
  { loadId: 'L1', company: 'Havells', status: 'closed', createdAt: H(4), capturedAt: H(4) + 60000, closesAt: H(5), softClose: false },
  { loadId: 'L2', company: 'Havells', status: 'closed', createdAt: H(13), capturedAt: H(13) + 60000, closesAt: H(14), softClose: true },
  { loadId: 'L3', company: 'Syngenta', status: 'skipped_no_price', createdAt: H(15), capturedAt: null, closesAt: H(16), softClose: false },
  { loadId: 'L4', company: 'KEI', status: 'closed', createdAt: H(18), capturedAt: H(18) + 60000, closesAt: H(19), softClose: false },
  { loadId: 'L5', company: 'Durian', status: 'dismissed', createdAt: H(2), capturedAt: null, closesAt: H(3), softClose: false },
  { loadId: 'L6', company: 'Syngenta', status: 'awaiting_price', createdAt: H(20), capturedAt: null, closesAt: H(21), softClose: true },
];
const closedLikes = [
  { loadId: 'L1', company: 'Havells', numBids: 2, won: true, finalRank: 1, closeModel: 'hard', closedAt: H(5) },
  { loadId: 'L2', company: 'Havells', numBids: 1, won: false, finalRank: 4, closeModel: 'soft', closedAt: H(14) },
  { loadId: 'L4', company: 'KEI', numBids: 0, won: false, finalRank: null, closeModel: 'hard', closedAt: H(19) },
];
const closedByLoad = new Map(closedLikes.map((c) => [c.loadId, c]));
const funnelRows = R.buildFunnelRows(reqLikes, closedByLoad);
const f = R.summarizeFunnel(funnelRows);
eq(f.inquiries, 6, 'funnel: inquiries = 6 discovered loads');
eq(f.priced, 3, 'funnel: priced = L1,L2,L4');
eq(f.bid, 2, 'funnel: bid = L1,L2 (>=1 bid)');
eq(f.won, 1, 'funnel: won = L1');
eq(f.lost, 1, 'funnel: lost = L2');
eq(f.noBid, 1, 'funnel: no_bid = L4');
eq(f.pricedNoBid, 1, 'funnel: priced-but-never-bid = L4');
eq(f.skipped, 1, 'funnel: skipped_no_price = L3');
eq(f.dismissed, 1, 'funnel: dismissed = L5');
eq(f.open, 1, 'funnel: open (awaiting_price) = L6');
eq(f.participationPct, 50, 'funnel: participation% = 3/6 = 50');
eq(f.winPct, 50, 'funnel: win% = 1/(1+1) = 50');
// bidPct = 2/6 = 33.3 (one-decimal rounding)
eq(f.bidPct, 33.3, 'funnel: bid% = 2/6 = 33.3');

// closeModel carried from the join (L2 soft via closed record; L4 hard) and from softClose fallback.
const l2 = funnelRows.find((r) => r.loadId === 'L2');
eq(l2.closeModel, 'soft', 'funnel: L2 close model from closed record = soft');
const l3 = funnelRows.find((r) => r.loadId === 'L3');
eq(l3.closeModel, 'hard', 'funnel: L3 close model from softClose=false fallback = hard');

// ---- 5. outcome build + summary (full history) ----------------------------------------------
const outcomeRows = R.buildOutcomeRows(closedLikes);
const o = R.summarizeOutcomes(outcomeRows);
eq(o.total, 3, 'outcomes: 3 closed auctions');
eq(o.won, 1, 'outcomes: won = 1');
eq(o.lost, 1, 'outcomes: lost = 1');
eq(o.noBid, 1, 'outcomes: no_bid = 1');
eq(o.winPct, 50, 'outcomes: win% = 50');
eq(o.bidRatePct, 66.7, 'outcomes: bid rate = 2/3 = 66.7');

// ---- 6. hour-of-day bucketing (pricing window = createdAt) ----------------------------------
const byHour = R.segmentByHour(funnelRows, 'createdAt', NOW);
// L5 @ IST 07:30 (utc 2) -> hour 7; L1 @ IST 09:30 -> 9; L2 @ IST 18:30 -> 18; L3 @ IST 20:30 -> 20;
// L4 @ IST 23:30 -> 23; L6 @ IST 01:30 next day -> 1.
eq(byHour.buckets[9].total, 1, 'byHour[createdAt]: hour 09 has L1');
eq(byHour.buckets[18].total, 1, 'byHour[createdAt]: hour 18 has L2');
eq(byHour.buckets[23].total, 1, 'byHour[createdAt]: hour 23 has L4');
eq(byHour.buckets[23].noBid, 1, 'byHour[createdAt]: hour 23 L4 counted as no_bid');
eq(byHour.buckets[20].skipped, 1, 'byHour[createdAt]: hour 20 L3 counted as skipped');
eq(byHour.undated, 0, 'byHour[createdAt]: nothing undated (all have createdAt)');

// A row with a null createdAt goes to undated.
const undatedProbe = R.segmentByHour([{ status: 'skipped_no_price', participated: false, createdAt: null, auctionCloseAt: null }], 'createdAt', NOW);
eq(undatedProbe.undated, 1, 'byHour[createdAt]: null createdAt -> undated');

// ---- 7. close-time bucketing excludes the year-2100 placeholder -----------------------------
const placeholderRow = [{ status: 'no_bid', participated: true, createdAt: null, auctionCloseAt: Date.UTC(2100, 0, 1, 0, 0, 0) }];
const byClose = R.segmentByHour(placeholderRow, 'auctionCloseAt', NOW);
eq(byClose.undated, 1, 'byHour[close]: year-2100 placeholder close time excluded as undated');
eq(byClose.buckets.reduce((s, b) => s + b.total, 0), 0, 'byHour[close]: placeholder never lands in a bucket');

// ---- 8. day-part split + after-hours verdict ------------------------------------------------
// business rows: 2 priced, 0 skipped; after-hours rows: 2 loads, both skipped -> after-hours skip 100 > 0.
const dpRows = [
  { status: 'won', participated: true, createdAt: H(4) },   // IST 09:30 business
  { status: 'lost', participated: true, createdAt: H(6) },  // IST 11:30 business
  { status: 'skipped_no_price', participated: false, createdAt: H(15) }, // IST 20:30 after-hours
  { status: 'skipped_no_price', participated: false, createdAt: H(18) }, // IST 23:30 after-hours
];
const dp = R.dayPartSplit(dpRows, 'createdAt', NOW);
eq(dp.business.total, 2, 'dayPart: 2 business-hour loads');
eq(dp.afterHours.total, 2, 'dayPart: 2 after-hours loads');
eq(dp.business.skipRatePct, 0, 'dayPart: business skip rate 0%');
eq(dp.afterHours.skipRatePct, 100, 'dayPart: after-hours skip rate 100%');
ok(dp.afterHours.skipRatePct > dp.business.skipRatePct, 'dayPart: after-hours skip rate exceeds business (hypothesis-supporting shape)');

// ---- 9. customer segmentation (grouping + sort by inquiries desc) ---------------------------
const byCust = R.segmentByCustomer(funnelRows);
const havells = byCust.find((g) => g.key === 'Havells');
eq(havells.inquiries, 2, 'byCustomer: Havells has 2 loads');
eq(havells.won, 1, 'byCustomer: Havells won 1');
eq(havells.participationPct, 100, 'byCustomer: Havells priced both -> 100%');
ok(byCust[0].inquiries >= byCust[byCust.length - 1].inquiries, 'byCustomer: sorted by inquiries desc');
const syngenta = byCust.find((g) => g.key === 'Syngenta');
eq(syngenta.skipped, 1, 'byCustomer: Syngenta has 1 skipped');
eq(syngenta.priced, 0, 'byCustomer: Syngenta priced 0');

// ---- 10. close-model segmentation -----------------------------------------------------------
const byModel = R.segmentByCloseModel(funnelRows);
const hard = byModel.find((g) => g.key === 'hard');
const soft = byModel.find((g) => g.key === 'soft');
ok(hard && hard.inquiries >= 1, 'byCloseModel: hard bucket present');
ok(soft && soft.inquiries >= 1, 'byCloseModel: soft bucket present');

// ---- 11. missing-field tolerance ------------------------------------------------------------
const sparse = R.buildFunnelRows(
  [{ loadId: 'X1', status: 'skipped_no_price' }], // no company/createdAt/capturedAt/closesAt/softClose
  new Map(),
);
eq(sparse[0].company, '', 'sparse: missing company -> empty string');
eq(sparse[0].customer, 'Unknown', 'sparse: missing company -> customer Unknown');
eq(sparse[0].participated, false, 'sparse: missing capturedAt -> not participated');
eq(sparse[0].anyBid, null, 'sparse: no closed record -> anyBid null');
eq(sparse[0].createdAt, null, 'sparse: missing createdAt -> null');
eq(sparse[0].closeModel, '', 'sparse: unknown close model -> empty');
ok(typeof R.summarizeFunnel(sparse).participationPct === 'number', 'sparse: summarize does not throw');
// closedLike missing numBids -> treated as 0 bids (no_bid), no throw
const sparseOut = R.buildOutcomeRows([{ loadId: 'Y1', company: 'Z', won: false, closedAt: H(4) }]);
eq(sparseOut[0].status, 'no_bid', 'sparse: outcome missing numBids -> no_bid');

// buildModel end-to-end does not throw and formatReport returns a string with the key sections.
const model = R.buildModel({ funnelRows, outcomeRows, provenance: { mode: 'test', sources: [], notes: [] }, now: NOW });
const rep = R.formatReport(model);
ok(rep.includes('Participation funnel'), 'formatReport: has funnel section');
ok(rep.includes('By hour-of-day IST - pricing window'), 'formatReport: has pricing-window hour section');
ok(rep.includes('By customer'), 'formatReport: has customer section');
ok(rep.includes('Verdict:'), 'formatReport: has an after-hours verdict line');

// ---- 12. CSV parsing (quotes, embedded comma, "" escape, formula-lead apostrophe) -----------
const csv = 'loadId,shipper,status,createdAt\r\n'
  + 'L1,"Acme, Inc.",closed,2026-07-24T03:30:00.000Z\r\n'
  + 'L2,"say ""hi""",skipped_no_price,\r\n'
  + "L3,'+15,closed,\r\n";
const objs = R.parseCsvObjects(csv);
eq(objs.length, 3, 'parseCsvObjects: 3 data rows');
eq(objs[0].shipper, 'Acme, Inc.', 'parseCsvObjects: embedded comma preserved');
eq(objs[1].shipper, 'say "hi"', 'parseCsvObjects: doubled-quote unescaped');
eq(objs[1].createdAt, '', 'parseCsvObjects: trailing empty cell');
eq(objs[2].shipper, '+15', 'parseCsvObjects: leading formula-guard apostrophe stripped');

// ---- 13. basicHeader ------------------------------------------------------------------------
eq(R.basicHeader('user:pass'), `Basic ${Buffer.from('user:pass').toString('base64')}`, 'basicHeader: user:pass base64-encoded');
eq(R.basicHeader('YWxyZWFkeQ=='), 'Basic YWxyZWFkeQ==', 'basicHeader: already-encoded passes through');
eq(R.basicHeader(''), null, 'basicHeader: empty -> null');

// ---- 14. env-file parsing + process.env precedence ------------------------------------------
const tmp = path.join(os.tmpdir(), `sp-part-test-${process.pid}.env`);
try {
  fs.writeFileSync(tmp, '# comment\nSP_BIDDER_BASE_URL=https://example.test\nSP_BIDDER_USER="fileuser"\n', 'utf8');
  const parsed = R.loadEnvFile(tmp);
  eq(parsed.SP_BIDDER_BASE_URL, 'https://example.test', 'loadEnvFile: parses key=value');
  eq(parsed.SP_BIDDER_USER, 'fileuser', 'loadEnvFile: strips surrounding quotes');
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'SP_BIDDER_USER');
  const prev = process.env.SP_BIDDER_USER;
  process.env.SP_BIDDER_USER = 'envwins';
  const creds = R.resolveCreds(tmp);
  eq(creds.user, 'envwins', 'resolveCreds: process.env wins over file');
  eq(creds.baseUrl, 'https://example.test', 'resolveCreds: falls back to file when env absent');
  if (hadEnv) process.env.SP_BIDDER_USER = prev; else delete process.env.SP_BIDDER_USER;
} finally {
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
}

// ---- 15. customer-tag resolution: one real customer must not split across two rows ------------
// The defect this guards: in --api mode the price-requests export carries no customer tag, so a
// CLOSED load resolved to the box's friendly label while its never-closed sibling fell back to the
// raw platform company string - splitting one customer into two rows and inverting the per-customer
// skip read. loadFromApi now resolves every row off the closed-bids mapping; these asserts pin the
// grouping behaviour that fix produces, plus the routed marker that discloses what is left over.
eq(R.normCompany('  HAVELLS   INDIA LTD. '), 'havells india ltd.', 'normCompany: case+space collapse');
eq(R.normCompany(null), '', 'normCompany: null -> empty key');
eq(R.normCompany(undefined), '', 'normCompany: undefined -> empty key');

// Resolved shape (what the fix emits): every row carries the canonical tag, closed or not.
const resolvedReqs = [
  { loadId: 'R1', company: 'HAVELLS INDIA LTD.', customerLabel: 'Havells', status: 'closed', createdAt: H(4), capturedAt: H(4) + 1, closesAt: H(5), softClose: false },
  { loadId: 'R2', company: 'Havells India Ltd.', customerLabel: 'Havells', status: 'skipped_no_price', createdAt: H(5), capturedAt: null, closesAt: H(6), softClose: true },
  { loadId: 'R3', company: 'Havells', customerLabel: 'Havells', status: 'skipped_no_price', createdAt: H(6), capturedAt: null, closesAt: H(7), softClose: true },
];
const resolvedClosed = new Map([['R1', { loadId: 'R1', company: 'HAVELLS INDIA LTD.', customerLabel: 'Havells', numBids: 2, won: true, finalRank: 1, closeModel: 'hard', closedAt: H(5) }]]);
const resolvedRows = R.buildFunnelRows(resolvedReqs, resolvedClosed);
const resolvedSeg = R.segmentByCustomer(resolvedRows);
eq(resolvedSeg.length, 1, 'customer: resolved tags collapse 3 company-string variants into ONE row');
eq(resolvedSeg[0].key, 'Havells', 'customer: the single row is keyed by the canonical tag');
eq(resolvedSeg[0].inquiries, 3, 'customer: all 3 loads land in the one group');
eq(resolvedSeg[0].skipped, 2, 'customer: both skips stay with the customer that owns them');
eq(resolvedSeg[0].participationPct, 33.3, 'customer: participation is 1/3, not split across rows');
eq(resolvedSeg[0].routed, 'yes', 'customer: fully-resolved group marked routed=yes');
ok(resolvedRows.every((r) => r.customerResolved === true), 'customer: every resolved row flags customerResolved');

// Soft/hard split within the group: the soft lane is a near-total hole even though overall is 33%.
eq(resolvedSeg[0].hard, 1, 'customer: 1 hard-close load');
eq(resolvedSeg[0].hardPct, 100, 'customer: hard lane priced 100%');
eq(resolvedSeg[0].soft, 2, 'customer: 2 soft-close loads');
eq(resolvedSeg[0].softPct, 0, 'customer: soft lane priced 0% - the hole a blended rate would hide');

// Unresolved shape (no tag anywhere): rows key off the raw string and are marked routed=no.
const unroutedRows = R.buildFunnelRows(
  [{ loadId: 'U1', company: 'Ashirvad Pipes Pvt Ltd', status: 'skipped_no_price', createdAt: H(4), capturedAt: null }],
  new Map(),
);
const unroutedSeg = R.segmentByCustomer(unroutedRows);
eq(unroutedSeg[0].key, 'Ashirvad Pipes Pvt Ltd', 'customer: unrouted row keys off the raw company string');
eq(unroutedSeg[0].routed, 'no', 'customer: unrouted group marked routed=no');
eq(unroutedRows[0].customerResolved, false, 'customer: unrouted row flags customerResolved=false');

// A group that mixes both bases is itself a defect signal - it must not silently read as 'yes'.
const mixedRows = R.buildFunnelRows(
  [
    { loadId: 'M1', company: 'Acme', customerLabel: 'Acme', status: 'skipped_no_price', createdAt: H(4), capturedAt: null },
    { loadId: 'M2', company: 'Acme', status: 'skipped_no_price', createdAt: H(4), capturedAt: null },
  ],
  new Map(),
);
eq(R.segmentByCustomer(mixedRows)[0].routed, 'partial', 'customer: mixed-basis group marked routed=partial');

// The caveat block must state the unrouted counts, so the table cannot be read as two customers.
const caveat = R.customerCaveatLines(R.segmentByCustomer([...resolvedRows, ...unroutedRows]));
ok(caveat.includes('routed=no'), 'caveat: explains the routed=no marker');
ok(caveat.includes('not proof of a different customer'), 'caveat: warns against reading a variant as a second customer');
ok(/1 of 2 rows unrouted/.test(caveat), 'caveat: reports the live unrouted row count');
ok(/carrying 1 skip\)/.test(caveat), 'caveat: singular skip count reads grammatically');
ok(caveat.includes('softP%'), 'caveat: explains the close-model lane columns');

// The rendered report carries the caveat (not just the model).
const routedReport = R.formatReport(R.buildModel({
  funnelRows: [...resolvedRows, ...unroutedRows], outcomeRows: [],
  provenance: { mode: 'test', sources: [], notes: [] }, now: NOW,
}));
ok(routedReport.includes('How to read this table'), 'formatReport: by-customer caveat is rendered');
ok(routedReport.includes('routed'), 'formatReport: customer table carries the routed column');

// ---- 16. dayPartLines: minimum-N verdict guard (no direction from an empty/small band) -------
// The bug this guards: pct() collapses a zero-row band's skipRatePct to 0, indistinguishable from
// a real 0% over a real sample, and dayPartLines used to compare bands with a bare >/< with no N
// check - so an EMPTY band could produce a confidently wrong directional sentence.

// Empty after-hours band (all rows land in business hours, IST 15:30). Before the guard this
// printed a confident "does NOT support" verdict off zero after-hours observations.
const emptyAfterHoursRows = Array.from({ length: 12 }, () => ({ status: 'skipped_no_price', participated: false, createdAt: H(10) }));
const bandEmptyAfter = R.dayPartSplit(emptyAfterHoursRows, 'createdAt', NOW);
eq(bandEmptyAfter.afterHours.total, 0, 'dayPart: after-hours band genuinely empty (fixture sanity)');
const linesEmptyAfter = R.dayPartLines('Guard-empty-after', bandEmptyAfter);
ok(/insufficient data/.test(linesEmptyAfter), 'dayPartLines: empty after-hours band -> insufficient data, no verdict asserted');
ok(!/does NOT support|supports the after-hours hypothesis/.test(linesEmptyAfter), 'dayPartLines: empty band never renders a directional sentence');

// Empty business band - the DANGEROUS direction: a false CONFIRMATION of the hypothesis produced
// by zero business-hours observations (all 12 rows fall after-hours, IST 01:30).
const emptyBusinessRows = Array.from({ length: 12 }, () => ({ status: 'skipped_no_price', participated: false, createdAt: H(20) }));
const bandEmptyBiz = R.dayPartSplit(emptyBusinessRows, 'createdAt', NOW);
eq(bandEmptyBiz.business.total, 0, 'dayPart: business band genuinely empty (fixture sanity)');
const linesEmptyBiz = R.dayPartLines('Guard-empty-biz', bandEmptyBiz);
ok(/insufficient data/.test(linesEmptyBiz), 'dayPartLines: empty business band -> insufficient data (kills the false-confirmation direction)');
ok(!/supports the after-hours hypothesis/.test(linesEmptyBiz), 'dayPartLines: empty business band never asserts a false "supports" verdict');

// Small-but-nonzero band (n=1 per side) is also under-powered - the guard is an N floor, not just
// a zero check.
const smallRows = [
  { status: 'skipped_no_price', participated: false, createdAt: H(10) }, // 1 business row
  { status: 'skipped_no_price', participated: false, createdAt: H(20) }, // 1 after-hours row
];
const bandSmall = R.dayPartSplit(smallRows, 'createdAt', NOW);
const linesSmall = R.dayPartLines('Guard-small', bandSmall);
ok(/insufficient data/.test(linesSmall), 'dayPartLines: n=1 per band -> insufficient data, not a bare directional claim');

// A genuinely large sample (>= the floor on both sides) still gets a real directional verdict -
// the guard must not suppress a legitimate finding.
const bigRows = [
  ...Array.from({ length: 10 }, (_, i) => ({ status: i < 1 ? 'skipped_no_price' : 'won', participated: i >= 1, createdAt: H(10) })), // business: 10 rows, 1 skip = 10%
  ...Array.from({ length: 10 }, (_, i) => ({ status: i < 5 ? 'skipped_no_price' : 'won', participated: i >= 5, createdAt: H(20) })), // after-hours: 10 rows, 5 skip = 50%
];
const bandBig = R.dayPartSplit(bigRows, 'createdAt', NOW);
const linesBig = R.dayPartLines('Guard-big', bandBig);
ok(/supports the after-hours hypothesis/.test(linesBig), 'dayPartLines: >= floor on both sides still renders a real directional verdict');

// ---- 17. loadFromApi against a local fake box: GET failure classification + outcomes-only ----
// fallback. A local loopback HTTP server stands in for the SP-bidder box (never the live box -
// per house rules this script is never executed against it). Mirrors the test-auth.js pattern of
// spinning up a real server and driving it over real HTTP, so the untested I/O path (review
// finding F4) gets genuine coverage rather than a proxy unit test of an extracted pure helper.

const loginOk = () => ({ status: 200, headers: { 'set-cookie': 'sp_session=test; Path=/' }, body: JSON.stringify({ authRequired: true }) });

function startFakeBox(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const key = `${req.method} ${u.pathname}`;
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const h = handlers[key];
        if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
        const out = h({ body: Buffer.concat(chunks).toString('utf8') }) || {};
        const headers = Object.assign({ 'content-type': out.contentType || 'application/json' }, out.headers || {});
        res.writeHead(out.status || 200, headers);
        res.end(out.body != null ? out.body : '');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
function stopFakeBox(server) { return new Promise((resolve) => server.close(resolve)); }

async function testFatalOn500ExportEndpoint() {
  const { server, base } = await startFakeBox({
    'POST /api/login': loginOk,
    'GET /api/closed-bids': () => ({ status: 200, body: JSON.stringify({ closedBids: [] }) }),
    'GET /api/export/price-requests.csv': () => ({ status: 500, body: JSON.stringify({ error: 'Export failed.' }) }),
    'GET /api/export/funnel': () => ({ status: 500, body: JSON.stringify({ error: 'Export failed.' }) }),
  });
  let err = null;
  try { await R.loadFromApi({ baseUrl: base, user: 'u', password: 'p' }); } catch (e) { err = e; }
  await stopFakeBox(server);
  ok(err != null, 'loadFromApi: HTTP 500 on price-requests.csv is FATAL (throws), never silently skipped as (skipped)');
  ok(!!(err && /price-requests\.csv/.test(err.message)), 'loadFromApi: fatal error names the failed endpoint');
  ok(!!(err && /500/.test(err.message)), 'loadFromApi: fatal error names the failed status code');
}

async function testFatalOn401ClosedBids() {
  const { server, base } = await startFakeBox({
    'POST /api/login': loginOk,
    'GET /api/closed-bids': () => ({ status: 401, body: JSON.stringify({ error: 'unauthorized' }) }),
  });
  let err = null;
  try { await R.loadFromApi({ baseUrl: base, user: 'u', password: 'p' }); } catch (e) { err = e; }
  await stopFakeBox(server);
  ok(err != null, 'loadFromApi: HTTP 401 on /api/closed-bids (session expired mid-run) is FATAL, not swallowed');
  ok(!!(err && /closed-bids/.test(err.message) && /401/.test(err.message)), 'loadFromApi: 401 fatal error names endpoint + status');
}

async function testOutcomesOnlyFallbackRendersNA() {
  // 3 closed rows: this is exactly the shape that used to render "priced === inquiries === 3 ->
  // 100% of inquiries" once the fallback stamped capturedAt: 1 on every row.
  const closedBids = [
    { auctionId: 'C1', shipper: 'Havells', customer: { label: 'Havells' }, ourBids: [{ amount: 100 }, { amount: 90 }], won: true, finalRank: 1, closeModel: 'hard', closedAt: H(5) },
    { auctionId: 'C2', shipper: 'Havells', customer: { label: 'Havells' }, ourBids: [{ amount: 80 }], won: false, finalRank: 3, closeModel: 'hard', closedAt: H(6) },
    { auctionId: 'C3', shipper: 'KEI', customer: { label: 'KEI' }, ourBids: [], won: false, finalRank: null, closeModel: 'soft', closedAt: H(7) },
  ];
  const { server, base } = await startFakeBox({
    'POST /api/login': loginOk,
    'GET /api/closed-bids': () => ({ status: 200, body: JSON.stringify({ closedBids }) }),
    'GET /api/export/price-requests.csv': () => ({ status: 404, body: '' }), // genuinely absent
    'GET /api/export/funnel': () => ({ status: 404, body: '' }),             // genuinely absent
    'GET /api/export/summary': () => ({ status: 404, body: '' }),
  });
  const { reqLikes, closedLikes, closedByLoad, provenance } = await R.loadFromApi({ baseUrl: base, user: 'u', password: 'p' });
  await stopFakeBox(server);

  ok(provenance.spineIsOutcomesOnly === true, 'loadFromApi: double-404 (both funnel exports genuinely absent) sets spineIsOutcomesOnly');
  ok(reqLikes.every((r) => r.capturedAt == null), 'loadFromApi: outcomes-only fallback never synthesizes capturedAt (no more capturedAt: 1)');

  const funnelRows = R.buildFunnelRows(reqLikes, closedByLoad);
  const outcomeRows = R.buildOutcomeRows(closedLikes);
  const model = R.buildModel({ funnelRows, outcomeRows, provenance });

  eq(model.funnel.inquiries, 3, 'outcomes-only fallback: inquiries = 3 closed rows (fixture sanity)');
  eq(model.funnel.participationPct, null, 'outcomes-only fallback: participationPct is null, never a fabricated 100');
  eq(model.funnel.priced, null, 'outcomes-only fallback: priced is null, not silently equal to inquiries');
  eq(model.funnel.skipped, null, 'outcomes-only fallback: skipped is null (unknowable here), not a false 0');
  eq(model.funnel.dismissed, null, 'outcomes-only fallback: dismissed is null (unknowable here), not a false 0');
  eq(model.funnel.won, 1, 'outcomes-only fallback: won is still real (comes off the closed-bid join, not capturedAt)');

  const rendered = R.formatReport(model);
  ok(!rendered.includes('100% of inquiries'), 'formatReport: outcomes-only fallback never prints "100% of inquiries"');
  ok(rendered.includes('n/a (no funnel spine)'), 'formatReport: outcomes-only fallback prints the n/a banner, not a number');
  ok(rendered.includes('NO FUNNEL SPINE THIS RUN'), 'formatReport: outcomes-only fallback carries the explicit banner');
}

async function testNormalRunNotFlaggedOutcomesOnly() {
  const csv = 'loadId,shipper,status,createdAt,capturedAt,closesAt,softClose\n'
    + 'L1,Havells,closed,2026-07-24T03:30:00.000Z,2026-07-24T03:31:00.000Z,2026-07-24T04:00:00.000Z,false\n';
  const closedBids = [{ auctionId: 'L1', shipper: 'Havells', customer: { label: 'Havells' }, ourBids: [{ amount: 1 }], won: true, finalRank: 1, closeModel: 'hard', closedAt: H(4) }];
  const { server, base } = await startFakeBox({
    'POST /api/login': loginOk,
    'GET /api/closed-bids': () => ({ status: 200, body: JSON.stringify({ closedBids }) }),
    'GET /api/export/price-requests.csv': () => ({ status: 200, contentType: 'text/csv', body: csv }),
    'GET /api/export/summary': () => ({ status: 404, body: '' }),
  });
  const { provenance } = await R.loadFromApi({ baseUrl: base, user: 'u', password: 'p' });
  await stopFakeBox(server);
  ok(provenance.spineIsOutcomesOnly !== true, 'loadFromApi: a normal run (price-requests.csv present) is NOT flagged outcomes-only');
}

/**
 * Both API sources are all-portal and label every row, so this report can scope the join instead of
 * inheriting whatever scope the box happened to apply. The failure this pins is specific: an
 * all-portal outcome list joined to a single-portal funnel spine divides a participation percentage
 * by the wrong denominator, and nothing in the output would show it.
 */
async function testBothSidesCarryTheirPortal() {
  const csv = 'loadId,platform,shipper,status,createdAt,capturedAt,closesAt,softClose\n'
    + 'L1,sp,Havells,closed,2026-07-24T03:30:00.000Z,2026-07-24T03:31:00.000Z,2026-07-24T04:00:00.000Z,false\n'
    + 'GC-9,gocomet,Havells,closed,2026-07-24T03:30:00.000Z,,2026-07-24T04:00:00.000Z,false\n';
  const closedBids = [
    { auctionId: 'L1', platformKey: 'sp', shipper: 'Havells', ourBids: [{ amount: 1 }], won: true, finalRank: 1, closeModel: 'hard', closedAt: H(4) },
    { auctionId: 'GC-9', platformKey: 'gocomet', shipper: 'Havells', ourBids: [{ amount: 1 }], won: true, finalRank: 1, closeModel: 'hard', closedAt: H(4) },
    { auctionId: 'L2', shipper: 'Havells', ourBids: [], won: false, finalRank: null, closeModel: 'hard', closedAt: H(4) },
  ];
  const { server, base } = await startFakeBox({
    'POST /api/login': loginOk,
    'GET /api/closed-bids': () => ({ status: 200, body: JSON.stringify({ closedBids }) }),
    'GET /api/export/price-requests.csv': () => ({ status: 200, contentType: 'text/csv', body: csv }),
    'GET /api/export/summary': () => ({ status: 404, body: '' }),
  });
  const { reqLikes, closedLikes } = await R.loadFromApi({ baseUrl: base, user: 'u', password: 'p' });
  await stopFakeBox(server);
  const reqPlat = new Map(reqLikes.map((r) => [r.loadId, r.platform]));
  ok(reqPlat.get('L1') === 'sp' && reqPlat.get('GC-9') === 'gocomet',
    `loadFromApi: the funnel spine carries each row's own portal from the CSV's platform column - got ${JSON.stringify([...reqPlat])}`);
  const closedPlat = new Map(closedLikes.map((c) => [c.loadId, c.platform]));
  ok(closedPlat.get('L1') === 'sp' && closedPlat.get('GC-9') === 'gocomet',
    `loadFromApi: the outcome rows carry platformKey from /api/closed-bids - got ${JSON.stringify([...closedPlat])}`);
  ok(closedPlat.get('L2') === 'sp',
    'loadFromApi: an untagged legacy outcome row resolves to sp, the same fallback platformOf applies server-side');
}

// ---- the unknown outcome is COLLECTED and RENDERED, in every table that splits won from lost ----
// segmentBy and summarizeOutcomes both tallied closed_unknown while nothing printed it, so the
// segment tables silently failed to add up: a bid auction appeared in `bid` and under no outcome
// column beneath it, and the reader had no way to see where it went. These pin the counters AND the
// three renderers together - a counter nothing prints is the state this section exists to forbid.
const unknownSegRows = [
  { status: 'won', participated: true, anyBid: true, customer: 'Waaree', closeModel: 'soft', customerResolved: true },
  { status: 'lost', participated: true, anyBid: true, customer: 'Waaree', closeModel: 'soft', customerResolved: true },
  { status: 'closed_unknown', participated: true, anyBid: true, customer: 'Waaree', closeModel: 'soft', customerResolved: true },
];
const unknownSeg = R.segmentByCustomer(unknownSegRows);
eq(unknownSeg[0].closedUnknown, 1, 'segmentByCustomer: the unknown outcome is counted');
eq(unknownSeg[0].bid, unknownSeg[0].won + unknownSeg[0].lost + unknownSeg[0].closedUnknown,
  'segmentByCustomer: won + lost + unknown accounts for every bid load - the table adds up');
eq(unknownSeg[0].winPct, 50, 'segmentByCustomer: win% is over decided only, unaffected by the unknown');

const unknownOutcomes = R.summarizeOutcomes([
  { status: 'won' }, { status: 'lost' }, { status: 'closed_unknown' }, { status: 'no_bid' },
]);
eq(unknownOutcomes.closedUnknown, 1, 'summarizeOutcomes: the unknown outcome has its own tally');
eq(unknownOutcomes.won + unknownOutcomes.lost + unknownOutcomes.closedUnknown + unknownOutcomes.noBid,
  unknownOutcomes.total, 'summarizeOutcomes: the four printed numbers reconcile against total');
const unknownReport = R.formatReport(R.buildModel({
  funnelRows: unknownSegRows,
  outcomeRows: [{ status: 'won' }, { status: 'lost' }, { status: 'closed_unknown' }, { status: 'no_bid' }],
  provenance: { mode: 'test', sources: [], notes: [] }, now: NOW,
}));
ok(unknownReport.includes('won / lost / unknown / no_bid: 1 / 1 / 1 / 1'),
  'formatReport: the closed-outcome history prints the unknown count alongside the other three');
ok(!unknownReport.includes('closed_unknown'),
  'formatReport: and never leaks the raw status key onto a page a director reads');

// Both segment tables, read out of the rendered report rather than by calling the (unexported)
// renderers - the claim is that the column reaches the page, not that a helper can produce one.
const custHeader = unknownReport.split('\n').find((l) => /^customer\s/.test(l));
ok(!!custHeader && /unknown/.test(custHeader),
  `formatReport: the by-customer table has an unknown column (header: "${custHeader}")`);
const custRow = unknownReport.split('\n').find((l) => /^Waaree\s/.test(l));
ok(!!custRow && custRow.trim().split(/\s+/).slice(1, 7).join(' ') === '3 3 3 1 1 1',
  `formatReport: ...and the row reads inq/priced/bid/won/lost/unknown = 3 3 3 1 1 1, so bid accounts for every outcome beneath it (got "${custRow && custRow.trim()}")`);
const cmHeader = unknownReport.split('\n').find((l) => /^closeModel\s/.test(l));
ok(!!cmHeader && /unknown/.test(cmHeader),
  `formatReport: the by-close-model table has one too (header: "${cmHeader}")`);
const cmRow = unknownReport.split('\n').find((l) => /^soft\s/.test(l));
ok(!!cmRow && cmRow.trim().split(/\s+/).slice(1, 7).join(' ') === '3 3 3 1 1 1',
  `formatReport: ...and its soft-close row adds up the same way (got "${cmRow && cmRow.trim()}")`);

(async () => {
  await testFatalOn500ExportEndpoint();
  await testFatalOn401ClosedBids();
  await testOutcomesOnlyFallbackRendersNA();
  await testNormalRunNotFlaggedOutcomesOnly();
  await testBothSidesCarryTheirPortal();

  // ---- done ---------------------------------------------------------------------------------
  console.log(`\nreport-participation: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  // A final belt: the assert module import is used so a thrown assertion (if any is added later)
  // is distinguishable from a soft ok() failure. Keep a trivial invariant here.
  assert.strictEqual(typeof R.buildModel, 'function');
})();
