'use strict';
/**
 * Durable-history backfill for the Export page (deterministic, offline, memory store).
 *
 * The defect this pins: picking ALL data on the Export page returned only the last few days,
 * because the funnel view reads the live working list and that list drops each enquiry a week
 * after its auction closes. The closedBids ledger is never pruned and holds outcomes back to
 * first deploy, so a request the working list cannot answer is served from the union instead.
 *
 * The second half of the same feature, and the half that reaches the director as a NUMBER: the two
 * populations do not share a participation denominator. Over the working list it is every load we
 * surfaced; over the union a never-priced old load is structurally absent, so it is only loads
 * still on record. Sections 1b, 7b, 7c and 7d pin the routing, the numerator, the two denominators,
 * and that the strip names which of the two it is showing.
 *
 * Reproduced from the owner's own download (295 rows, 2026-08-24 to 2026-09-12) against a ledger
 * spanning 2026-07-07 to 2026-09-09.
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const model = require('../src/web/exportModel');
const csv = require('../src/web/csv');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// run-tests.js grades by EXIT CODE ALONE, so a file that ends early - a swallowed rejection, a stray
// return - reaches exit 0 having asserted nothing and reads as a silent green.
const EXPECTED_CHECKS = 92;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS && fail === 0) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks (${fail} failed), expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);        // 2026-09-12
const LEDGER_FLOOR = Date.UTC(2026, 6, 7, 6, 0, 0);  // 2026-07-07 - oldest durable record
const GC_BOUNDARY = Date.UTC(2026, 7, 13, 6, 45, 0); // 2026-08-13 - GoComet's first auction ever
const PLACEHOLDER = Date.UTC(2100, 4, 24, 19, 53, 25); // SuperProcure's shared year-2100 close
const ALWAR = 'Alwar Cable (1350)';

(async () => {
  const store = createStore({ backend: 'memory' });
  // Counts collection reads so the backfill can be proven to cost no extra disk pass. FileStore
  // reads disk on every call, so a per-row lookup here would be thousands of reads on live data.
  const reads = {};
  const realList = store.listDocs.bind(store);
  store.listDocs = (c) => { reads[c] = (reads[c] || 0) + 1; return realList(c); };

  const bidLogger = new BidLogger({ store });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const master = { accountId: 'master', label: 'Best Roadways (Master)' };

  // ---- durable-only loads: their price request was pruned, only the ledger survives ----
  const closeOut = async (id, at, over) => {
    await bidLogger.handle(Object.assign({
      type: 'armed', auctionId: id, ts: at - 3_600_000, account: master,
      lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: '32ft', units: 1,
      companyName: 'Havells', cost: 60000, ladder: [67000, 63000], floor: 63000,
    }, over));
    await bidLogger.handle({ type: 'bid_placed', auctionId: id, ts: at - 1000, price: 63000, rungIndex: 1, socketRank: 2 });
    await bidLogger.handle({ type: 'auction_result', auctionId: id, ts: at, won: over && over.won === true, finalRank: 2, closeModel: 'hard' });
  };
  await closeOut('D1', LEDGER_FLOOR, { won: true });
  await closeOut('D2', Date.UTC(2026, 7, 5, 9, 0, 0), { companyName: 'KEI', cost: 40000 });
  await closeOut('D3', GC_BOUNDARY, { platformKey: 'gocomet', companyName: 'Waaree', cost: 50000 });
  // R1 closed too - it exists in BOTH stores, which is where a naive concat double-counts.
  await closeOut('R1', NOW - 2 * DAY, { won: true });

  // ---- the live working list ----
  const putReq = (id, over) => store.putDoc('priceRequests', id, Object.assign({
    id, loadId: id, account: master, customer: null,
    load: {
      lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: '32ft', units: 1,
      companyName: 'Havells', branchName: ALWAR, weight: 9, weightUnit: 'MT', distanceKm: 1894,
      loadCode: `EN-${id}`, closesAt: NOW - DAY, softClose: false,
    },
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, marginSource: 'customer:havells',
    status: 'closed', createdAt: NOW - 3 * DAY, capturedAt: NOW - 3 * DAY + 600_000,
    price: { cost: 60000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 },
  }, over));
  await putReq('R1', {});
  await putReq('R2', { status: 'skipped_no_price', capturedAt: null, price: null, load: { lane: { origin: 'Pune', destination: 'Hosur' }, equipment: '32ft', companyName: 'Syngenta', branchName: 'Syngenta Pune', closesAt: NOW - 5 * DAY, loadCode: 'EN-R2' } });
  await putReq('R3', { platformKey: 'gocomet', load: { lane: { origin: 'Degam', destination: 'Gandhinagar' }, equipment: '40 ft, 22 T', companyName: 'Waaree', branchName: 'Waaree Degam', closesAt: NOW - DAY, loadCode: 'EN-R3' } });
  // A still-open load carrying SuperProcure's year-2100 placeholder close. It ships in the file,
  // but must never be allowed to name the range the file covers.
  await putReq('R4', { status: 'awaiting_price', capturedAt: null, price: null, load: { lane: { origin: 'Chennai', destination: 'Hosur' }, equipment: '20ft', companyName: 'Durian', branchName: 'Durian TN', closesAt: PLACEHOLDER, loadCode: 'EN-R4' } });

  // Same live matcher the console uses: the raw platform company string resolves to a customer key.
  const attachCustomer = (name) => {
    const key = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return key ? { customerId: key, label: String(name).trim() } : null;
  };

  const datasets = await model.buildDatasets({ requests, bidLogger }, { attachCustomer });

  // ---- 1. the reproduction: the live list cannot answer a range below its own floor ----
  eq(datasets.funnel.length, 4, 'live funnel holds only the unpruned requests (R1..R4)');
  eq(datasets.history.length, 7, 'the union knows every load either store holds (R1..R4 + D1..D3)');
  const floor = model.liveFloor(datasets.funnel);
  eq(floor, NOW - 5 * DAY, 'liveFloor: the oldest auction the working list still holds');

  const spec = model.VIEWS.funnel;
  const allRows = model.datasetFor(datasets, spec, model.parseFilters({ allTime: 'true' }));
  eq(allRows.length, 7, 'ALL data: backfilled from the ledger, not the 4-row working list');
  const july = model.applyFilters(allRows, model.parseFilters({ from: String(Date.UTC(2026, 6, 1)), to: String(NOW) }));
  ok(july.some((r) => r.loadId === 'D1'), 'a July auction is exportable again');
  eq(model.applyFilters(datasets.funnel, model.parseFilters({ from: String(Date.UTC(2026, 6, 1)), to: String(NOW) })).length, 3,
    'the same range over the working list alone still returns only its own rows - the defect');

  // A range wholly inside the live window keeps the working list: nothing about the rolling
  // participation view changes for the query it was always able to answer.
  const inWindow = model.datasetFor(datasets, spec, model.parseFilters({ from: String(NOW - 5 * DAY) }));
  eq(inWindow.length, 4, 'a range at or above the live floor still reads the working list');
  ok(inWindow === datasets.funnel, 'in-window requests are byte-identical to today (same array)');

  // ---- 1b. NO date bound is the live worklist, not "all time" -----------------------------------
  // The page's first paint and its Reset both send no bound. Treating that as an all-time request
  // swapped the population behind a card titled "Live funnel" on every default load; only a caller
  // that explicitly asks (allTime) or picks a bound below the floor gets the wider population.
  const bare = model.parseFilters({});
  eq(bare.allTime, false, 'parseFilters: no allTime param -> false, never a truthy string');
  eq(model.funnelBasis(datasets, bare), 'live', 'no filter at all is the LIVE worklist');
  ok(model.datasetFor(datasets, spec, bare) === datasets.funnel, 'and it returns the funnel array itself');
  eq(model.funnelBasis(datasets, model.parseFilters({ allTime: 'true' })), 'history', 'an explicit allTime widens');
  eq(model.funnelBasis(datasets, model.parseFilters({ from: String(NOW - 5 * DAY) })), 'live', 'a from AT the floor stays live');
  eq(model.funnelBasis(datasets, model.parseFilters({ from: String(NOW - 6 * DAY) })), 'history', 'a from BELOW the floor widens');
  eq(model.funnelBasis(datasets, model.parseFilters({ to: String(NOW - 6 * DAY) })), 'history',
    'a to-bound entirely below the floor widens too - the worklist cannot answer it');
  // Loading-date basis has no captured date on either side of the join, so it reads the worklist it
  // always read rather than silently switching population on a query both datasets answer empty.
  eq(model.funnelBasis(datasets, model.parseFilters({ dateBasis: 'loading', from: String(LEDGER_FLOOR) })), 'live',
    'a loading-date range does not silently swap the population');
  eq(model.funnelBasis({ funnel: [] }, model.parseFilters({ from: String(NOW - DAY) })), 'history',
    'an empty worklist has no floor, so only the union can answer a bounded range');

  // ---- 2. no double-counting, and the live row wins ----
  eq(allRows.filter((r) => r.loadId === 'R1').length, 1, 'a load in BOTH stores appears exactly once');
  const r1 = allRows.find((r) => r.loadId === 'R1');
  eq(r1.branchName, ALWAR, 'the richer live row wins the merge (branch lives only on the request)');
  eq(r1.status, 'won', 'the merged row still carries the settled outcome');

  // ---- 3. columns that were never stored are BLANK, never fabricated ----
  const view = spec.project(allRows);
  const H = (name) => view.headers.indexOf(name);
  eq(view.headers.length, model.FUNNEL_HEADERS.length, 'backfill does not change the header set');
  const d1 = view.rows.find((r) => r[H('Load Id')] === 'D1');
  for (const col of model.REQUEST_ONLY_COLUMNS) {
    ok(H(col) >= 0, `${col} is a real funnel column`);
    eq(d1[H(col)], '', `backfilled row: ${col} is blank (never stored, never invented)`);
  }
  // ...and the columns the ledger DOES hold are filled, so this is a gap, not a blanked-out row.
  eq(d1[H('Customer')], 'Havells', 'backfilled row: customer comes from the ledger');
  eq(d1[H('Our Cost')], 60000, 'backfilled row: our cost comes from the ledger');
  eq(d1[H('Our Last Bid')], 63000, 'backfilled row: our last bid comes from the ledger');
  eq(d1[H('Won')], 'Y', 'backfilled row: the outcome comes from the ledger');
  eq(d1[H('Participated (Y/N)')], 'Y', 'backfilled row: an armed load counts as priced');

  // ---- 3b. provenance rides on the ROW, not on which cells happen to be blank ------------------
  // The file is opened outside this app. Eight blank columns read as missing data; this column is
  // the difference between "we lost it" and "it was never durably recorded".
  ok(H('Source') >= 0, 'Source is a real funnel column');
  eq(model.FUNNEL_HEADERS.indexOf('Source'), model.FUNNEL_HEADERS.length - 1,
    'Source is appended last, so the numeric-column indices stay valid');
  eq(d1[H('Source')], 'bid record', 'a row whose price request was pruned says so');
  const r1row = view.rows.find((r) => r[H('Load Id')] === 'R1');
  eq(r1row[H('Source')], 'funnel', 'a row the working list still holds says funnel');
  eq(d1.length, model.FUNNEL_HEADERS.length, 'every row is as wide as the header set');
  // The numeric columns are typed by INDEX, so an insert (rather than an append) would silently
  // retype cells. Pin the last numeric header rather than the raw index list.
  eq(model.FUNNEL_HEADERS[25], 'SP Lane Avg', 'the last numeric column did not shift');

  // ---- 4. the filename states the range actually returned, not the range asked for ----
  const covered = model.coveredRange(july, NOW);
  eq(csv.istStamp(covered.from), csv.istDate(LEDGER_FLOOR), 'covered range starts at the oldest row returned');
  eq(csv.istStamp(covered.to), csv.istDate(NOW - DAY), 'covered range ends at the newest row returned');
  // The year-2100 placeholder ships as a row but cannot name the range.
  ok(allRows.some((r) => r.loadId === 'R4'), 'the placeholder-close load is still exported');
  const allCovered = model.coveredRange(allRows, NOW);
  eq(csv.istStamp(allCovered.to), csv.istDate(NOW - DAY), 'a year-2100 placeholder never names the range');
  eq(model.coveredRange([], NOW).from, null, 'an empty result claims no range at all');

  // ---- 4b. the filename stem itself, including the branch nothing exercised before ---------------
  // Previously three lines inline in server.js, reachable only by booting the app and reading a
  // Content-Disposition header - so the empty-result fallback was a claim in a comment.
  const julyF = model.parseFilters({ from: String(Date.UTC(2026, 6, 1)), to: String(NOW) });
  eq(model.exportFilename(spec, july, julyF, NOW),
    `inquiries-funnel_${csv.istDate(LEDGER_FLOOR)}_to_${csv.istDate(NOW - DAY)}`,
    'a non-empty file is named for the rows it holds, not the range asked for');
  eq(model.exportFilename(spec, [], julyF, NOW),
    `inquiries-funnel_${csv.istDate(Date.UTC(2026, 6, 1))}_to_${csv.istDate(NOW)}`,
    'an empty result falls back to the bounds the director picked');
  eq(model.exportFilename(spec, [], model.parseFilters({}), NOW), 'inquiries-funnel_all_to_all',
    'an empty result with no bounds says all_to_all, never NaN or Invalid Date');
  eq(model.exportFilename(spec, [], model.parseFilters({ from: String(Date.UTC(2026, 6, 1)) }), NOW),
    `inquiries-funnel_${csv.istDate(Date.UTC(2026, 6, 1))}_to_all`,
    'one open bound falls back on that side only');
  // A file holding ONLY the year-2100 placeholder has no usable span, so it falls back rather than
  // naming 2100 - the placeholder guard and the fallback have to compose.
  const onlyPlaceholder = allRows.filter((r) => r.loadId === 'R4');
  eq(model.exportFilename(spec, onlyPlaceholder, julyF, NOW),
    `inquiries-funnel_${csv.istDate(Date.UTC(2026, 6, 1))}_to_${csv.istDate(NOW)}`,
    'a placeholder-only file falls back instead of claiming it runs to 2100');

  // ---- 5. GoComet before 2026-08-13 is a data boundary, not a gap to fill ----
  const gc = model.applyFilters(allRows, model.parseFilters({ platform: 'gocomet', from: String(Date.UTC(2026, 7, 1)), to: String(NOW) }));
  ok(gc.length > 0, 'GoComet rows are backfilled from its own first auction onward');
  ok(gc.every((r) => Number(r.auctionCloseAt) >= GC_BOUNDARY), 'no GoComet row is invented before 2026-08-13');
  eq(gc.filter((r) => r.loadId === 'D3').length, 1, 'the 13-Aug GoComet auction itself is present');

  // ---- 6. every filter applies to a backfilled row too ----
  const havells = model.applyFilters(allRows, model.parseFilters({ customer: 'havells' }));
  ok(havells.some((r) => r.loadId === 'D1'), 'customer filter resolves a backfilled row through the same matcher');
  ok(havells.every((r) => r.customer && r.customer.customerId === 'havells'), 'customer filter keeps only that customer');
  const branch = model.applyFilters(allRows, model.parseFilters({ branch: ALWAR.toLowerCase() }));
  ok(branch.every((r) => r.loadId !== 'D1'), 'a branch filter cannot match a row whose branch was never stored');
  const vehicle = model.applyFilters(allRows, model.parseFilters({ vehicle: '32ft' }));
  ok(vehicle.some((r) => r.loadId === 'D2'), 'vehicle filter reads the ledger-side equipment');
  const acct = model.applyFilters(allRows, model.parseFilters({ account: 'master' }));
  ok(acct.some((r) => r.loadId === 'D1'), 'account filter reads the ledger-side account');
  const beforeAug = model.applyFilters(allRows, model.parseFilters({ to: String(Date.UTC(2026, 7, 1)) }));
  eq(beforeAug.length, 1, 'a to-bound narrows the backfilled rows the same way it narrows live ones');
  eq(beforeAug[0].loadId, 'D1', 'and it keeps the right one');

  // ---- 7. the summary tiles count whatever range is on screen ----
  const s = model.summarize(july);
  eq(s.inquiries, july.length, 'summary counts the same rows the download contains');
  eq(s.won, july.filter((r) => r.status === 'won').length, 'summary win count agrees with the rows');

  // ---- 7b. participation: the NUMERATOR agrees with the column beside it ------------------------
  // summarize() counted `priced` off the raw `participated` flag, which reads capturedAt and is
  // pruned with the request. Every backfilled row therefore counted as UNPRICED while the funnel
  // view's own 'Participated (Y/N)' column printed Y on the same row - the tile and the file
  // disagreeing about the director's headline number, understated by roughly an order of magnitude.
  const H2 = (name) => model.FUNNEL_HEADERS.indexOf(name);
  const yCells = spec.project(allRows).rows.filter((r) => r[H2('Participated (Y/N)')] === 'Y').length;
  eq(model.summarize(allRows).priced, yCells,
    "summarize().priced equals the count of Participated=Y cells in the file it sits above");
  eq(model.summarize(allRows).priced, 5, 'priced = 3 ledger-only + R1 + R3; R2 skipped, R4 still open');
  // The same predicate the participated= chip filters on, so chipping "Priced" cannot return a set
  // whose size disagrees with the tile.
  eq(model.applyFilters(allRows, model.parseFilters({ participated: 'true' })).length,
    model.summarize(allRows).priced, 'the Priced chip and the Priced tile count the same rows');

  // ---- 7c. participation: the DENOMINATOR is a different metric on each population ---------------
  // Live: bids over every load we SURFACED - the measure the desk's standing participation figure
  // is on. History: a never-priced load older than the prune is structurally absent from both
  // stores, so the denominator is loads still ON RECORD and the ratio reads higher for that reason
  // alone. Both numbers are correct; reading one as the other is the defect.
  const liveS = model.summarize(model.datasetFor(datasets, spec, model.parseFilters({})));
  const histS = model.summarize(model.datasetFor(datasets, spec, model.parseFilters({ allTime: 'true' })));
  eq(liveS.inquiries, 4, 'live participation denominator is the worklist: every load we surfaced');
  eq(liveS.priced, 2, 'two of the four live loads were priced (R2 skipped, R4 still open)');
  eq(liveS.participationPct, 50, 'live participation is 2/4 - never-priced loads are IN the denominator');
  eq(histS.inquiries, 7, 'history denominator is loads still on record');
  eq(histS.priced, 5, 'every backfilled row is priced by construction - we only kept what we bid on');
  eq(histS.participationPct, 71.4, 'so the union ratio is 5/7, inflated by the three loads it recovered');
  ok(histS.participationPct > liveS.participationPct,
    'the union ratio is structurally the higher of the two, which is why it needs its own words');

  // ---- 7d. the strip SAYS which of the two it is showing -----------------------------------------
  const liveNote = model.coverageNote(model.coveredRange(datasets.funnel, NOW), 7, 'live');
  const histNote = model.coverageNote(model.coveredRange(allRows, NOW), 7, 'history');
  ok(liveNote.includes('every load we surfaced'), 'live note names the baseline-comparable metric');
  ok(!liveNote.includes('blank'), 'live note does not claim blank columns it has none of');
  ok(histNote.includes('loads still on record'), 'history note names its own, different denominator');
  ok(histNote.includes('NOT over every load we surfaced'), 'history note says which metric it is NOT');
  ok(histNote.includes('Load Code'), 'history note still names the columns that are blank');
  for (const n of [liveNote, histNote]) {
    ok(n.startsWith('Covering 2026-'), 'both notes open with the range they actually cover');
    ok(!n.includes('—') && !n.includes('–'), 'no em/en dash - this is director-facing copy');
  }
  eq(model.coverageNote({ from: null, to: null }, 7, 'live').startsWith('Covering'), false,
    'a note with no usable span claims no span');

  // ---- 8. one pass per collection, no per-row disk reads ----
  const before = { ...reads };
  await model.buildDatasets({ requests, bidLogger }, { attachCustomer });
  eq(reads.priceRequests - (before.priceRequests || 0), 1, 'buildDatasets reads priceRequests once');
  eq(reads.closedBids - (before.closedBids || 0), 1, 'buildDatasets reads closedBids once');

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
