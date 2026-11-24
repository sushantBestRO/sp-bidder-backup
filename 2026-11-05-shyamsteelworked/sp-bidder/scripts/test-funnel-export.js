'use strict';
/**
 * Funnel-spined export test (deterministic, offline, memory store). Covers the Phase-1 filtered
 * data-export feature: the priceRequests LEFT-JOIN closedBids spine, the derived per-load status,
 * the branch column (present on the funnel side, absent from closedBids), filter honouring, the
 * summary numbers, the IST filename stamp, and the in-repo .xlsx writer (AutoFilter + typed number
 * cells + a genuine ZIP round-trip). All headless, part of `npm test`.
 */
const zlib = require('zlib');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const model = require('../src/web/exportModel');
const xlsx = require('../src/web/xlsx');
const csv = require('../src/web/csv');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Minimal ZIP reader: walk the central directory, inflate each stored entry -> { name: string }.
// Proves the hand-written container in xlsx.js is structurally valid, not just PK-prefixed.
function unzip(buf) {
  const eocdSig = 0x06054b50;
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== eocdSig) eocd -= 1;
  if (eocd < 0) throw new Error('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central dir sig');
    const cSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + cSize);
    out[name] = zlib.inflateRawSync(comp).toString('utf8');
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

(async () => {
  // ---- 1. IST date helpers (the filename bug fix) ----
  // 2026-07-23 20:00 UTC = 2026-07-24 01:30 IST -> the IST calendar day is the 24th, UTC says 23rd.
  const afterHalfSix = Date.UTC(2026, 6, 23, 20, 0, 0);
  eq(csv.istStamp(afterHalfSix), '2026-07-24', 'istStamp: rolls to IST calendar day');
  eq(csv.stamp(afterHalfSix), '2026-07-23', 'stamp: UTC day (the old, wrong-for-filename behaviour)');
  eq(csv.istStamp(null), 'all', 'istStamp: open bound -> all');
  eq(csv.istDate(Date.UTC(2026, 6, 23, 19, 0, 0)), '2026-07-24', 'istDate: 00:30 IST is next day');
  ok(/^\d{2}:\d{2}$/.test(csv.istTime(afterHalfSix)), 'istTime: HH:MM');
  eq(csv.istDateTime(null), '', 'istDateTime: null -> blank');

  // ---- 2. seed the two stores ----
  const store = createStore({ backend: 'memory' });
  const bidLogger = new BidLogger({ store });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const now = Date.UTC(2026, 6, 23, 12, 0, 0);

  const master = { accountId: 'master', label: 'Best Roadways (Master)' };
  const neemrana = { accountId: 'neemrana', label: 'Neemrana' };
  const ALWAR = 'Alwar Cable (1350)';

  // closedBids via the engine event seam (same path production uses).
  // L1 Havells - WON (2 bids), branch supplied only by the priceRequest join below.
  await bidLogger.handle({ type: 'armed', auctionId: 'L1', ts: now, account: master, lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: 'Tata Truck (6 Tyre)', units: 1, companyName: 'Havells', cost: 80000, ladder: [90080, 85040], floor: 85040 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'L1', ts: now + 1000, price: 90080, rungIndex: 0, socketRank: 2, latencyMs: 210 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'L1', ts: now + 2000, price: 85040, rungIndex: 1, socketRank: 1, latencyMs: 180 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'L1', ts: now + 3000, won: true, finalRank: 1, closeModel: 'hard' });
  // L2 Havells - LOST (1 bid, rank 4).
  await bidLogger.handle({ type: 'armed', auctionId: 'L2', ts: now, account: master, lane: { origin: 'Alwar', destination: 'Pune' }, equipment: 'Tata Truck (6 Tyre)', units: 1, companyName: 'Havells', cost: 50000, ladder: [56300, 53150], floor: 53150 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'L2', ts: now + 1000, price: 56300, rungIndex: 0, socketRank: 4, latencyMs: 200 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'L2', ts: now + 3000, won: false, finalRank: 4, closeModel: 'hard' });
  // L4 KEI - NO-BID (armed + result, no bid ever placed; ourBids empty, rank null).
  await bidLogger.handle({ type: 'armed', auctionId: 'L4', ts: now, account: neemrana, lane: { origin: 'Bhiwadi', destination: 'Surat' }, equipment: '32ft', units: 1, companyName: 'KEI', cost: 40000 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'L4', ts: now + 3000, won: false, finalRank: null, closeModel: 'hard' });
  // L6 Havells - WON, outcomes-only (NO priceRequest -> older than the funnel window; branch blank).
  await bidLogger.handle({ type: 'armed', auctionId: 'L6', ts: now - 10 * 86400000, account: master, lane: { origin: 'Alwar', destination: 'Delhi' }, equipment: 'Tata Truck (6 Tyre)', units: 1, companyName: 'Havells', cost: 60000, ladder: [67000, 63000], floor: 63000 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'L6', ts: now - 10 * 86400000 + 1000, price: 63000, rungIndex: 1, socketRank: 2, latencyMs: 150 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'L6', ts: now - 10 * 86400000 + 3000, won: true, finalRank: 2, closeModel: 'hard' });

  // priceRequests (the funnel side; carries branchName, weight/unit, distance).
  const putReq = (id, over) => store.putDoc('priceRequests', id, Object.assign({
    id, loadId: id, account: master, customer: null,
    load: { lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: 'Tata Truck (6 Tyre)', units: 1, companyName: 'Havells', branchName: ALWAR, weight: 9, weightUnit: 'MT', distanceKm: 1894.24, loadCode: `EN-${id}`, closesAt: now + 3000, softClose: false },
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, marginSource: 'customer:havells',
    status: 'closed', createdAt: now - 900000, capturedAt: now - 720000, deadlineAt: now + 1000,
    price: { cost: 80000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 },
  }, over));
  await putReq('L1', {});
  await putReq('L2', { load: { lane: { origin: 'Alwar', destination: 'Pune' }, equipment: 'Tata Truck (6 Tyre)', units: 1, companyName: 'Havells', branchName: ALWAR, weight: 9, weightUnit: 'MT', distanceKm: 500, loadCode: 'EN-L2', closesAt: now + 3000, softClose: false }, price: { cost: 50000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 } });
  // L3 Syngenta - SKIPPED (never priced): no closedBids, capturedAt null.
  await putReq('L3', { account: master, load: { lane: { origin: 'Pune', destination: 'Hosur' }, equipment: '32ft', units: 1, companyName: 'Syngenta', branchName: 'Syngenta Pune', weight: 20, weightUnit: 'MT', distanceKm: 900, loadCode: 'EN-L3', closesAt: now - 1000, softClose: false }, status: 'skipped_no_price', capturedAt: null, price: null });
  // L4 KEI - priced (capturedAt set) but the bot never bid -> no_bid via the closedBids join.
  await putReq('L4', { account: neemrana, load: { lane: { origin: 'Bhiwadi', destination: 'Surat' }, equipment: '32ft', units: 1, companyName: 'KEI', branchName: 'KEI Bhiwadi', weight: 15, weightUnit: 'MT', distanceKm: 1200, loadCode: 'EN-L4', closesAt: now + 3000, softClose: false }, price: { cost: 40000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 } });
  // L5 Durian - DISMISSED (operator declined): no closedBids, capturedAt null.
  await putReq('L5', { load: { lane: { origin: 'Chennai', destination: 'Bangalore' }, equipment: '20ft', units: 1, companyName: 'Durian', branchName: 'Durian TN', weight: 8, weightUnit: 'MT', distanceKm: 350, loadCode: 'EN-L5', closesAt: now + 3000, softClose: false }, status: 'dismissed', capturedAt: null, price: null });

  // ---- 3. datasets + status derivation ----
  const { funnel, outcomes, history } = await model.buildDatasets({ requests, bidLogger });
  eq(funnel.length, 5, 'funnel: one row per discovered load (L1..L5)');
  eq(outcomes.length, 4, 'outcomes: one row per closed auction (L1,L2,L4,L6)');
  const F = (id) => funnel.find((r) => r.loadId === id);
  eq(F('L1').status, 'won', 'status: L1 won (closedBids.won)');
  eq(F('L2').status, 'lost', 'status: L2 lost (bid + not won)');
  eq(F('L4').status, 'no_bid', 'status: L4 no_bid (closed, ourBids empty)');
  eq(F('L3').status, 'skipped_no_price', 'status: L3 skipped (funnel only)');
  eq(F('L5').status, 'dismissed', 'status: L5 dismissed (funnel only)');
  eq(F('L3').participated, false, 'participated: skipped row did not participate');
  eq(F('L4').participated, true, 'participated: no_bid row WAS priced (capturedAt set)');

  // ---- 4. funnel view: includes skipped rows + branch/status columns ----
  const fv = model.funnelView(funnel);
  const H = (name) => fv.headers.indexOf(name);
  ok(H('Branch') >= 0 && H('Status') >= 0 && H('Load Id') >= 0, 'funnel view: has Load Id, Branch, Status columns');
  eq(fv.rows.length, 5, 'funnel view: 5 rows (skipped row present)');
  const fL3 = fv.rows.find((r) => r[H('Load Id')] === 'L3');
  eq(fL3[H('Status')], 'skipped_no_price', 'funnel view: skipped row carries its status');
  eq(fL3[H('Participated (Y/N)')], 'N', 'funnel view: skipped row Participated=N');
  const fL1 = fv.rows.find((r) => r[H('Load Id')] === 'L1');
  eq(fL1[H('Branch')], ALWAR, 'funnel view: branch present on L1');
  eq(fL1[H('Won')], 'Y', 'funnel view: L1 Won=Y');
  eq(fL1[H('Time-to-Price (min)')], 3, 'funnel view: time-to-price = 3 min');
  // Auction Date is IST, not UTC.
  eq(fL1[H('Auction Date')], csv.istDate(now + 3000), 'funnel view: Auction Date is IST');

  // ---- 5. outcomes view: branch filled from the join (closedBids has none) ----
  const ov = model.outcomesView(outcomes);
  const OH = (name) => ov.headers.indexOf(name);
  const oL1 = ov.rows.find((r) => r[OH('Load Id')] === 'L1');
  eq(oL1[OH('Branch')], ALWAR, 'outcomes view: branch filled from priceRequest join (absent on closedBids)');
  // named reversal: D027 - an SP row (L1 carries no platformKey, so it resolves to SP) has no
  // award signal, so "Won" alone overstated a confirmed allotment. The label now says what the
  // record actually proves: rank 1 at close.
  eq(oL1[OH('Result')], 'Won (rank 1 at close)', 'outcomes view: Result label carries the SP award caveat (D027)');
  const oL4 = ov.rows.find((r) => r[OH('Load Id')] === 'L4');
  eq(oL4[OH('Result')], 'No-bid', 'outcomes view: no-bid labelled No-bid (not a clean loss)');
  eq(oL4[OH('Final Rank')], '', 'outcomes view: null rank -> empty cell (not 0)');
  const oL6 = ov.rows.find((r) => r[OH('Load Id')] === 'L6');
  eq(oL6[OH('Branch')], '', 'outcomes view: outcomes-only row (no req) has blank branch');

  // ---- 6. bids view: one row per placed bid ----
  const bv = model.bidsView(outcomes);
  const BH = (name) => bv.headers.indexOf(name);
  eq(bv.rows.length, 4, 'bids view: 4 placed bids total (L1x2, L2x1, L6x1)');
  const bL2 = bv.rows.find((r) => r[BH('Load Id')] === 'L2');
  eq(bL2[BH('Rank (socket)')], 4, 'bids view: socket rank carried');

  // ---- 7. filter honouring ----
  const only = (rows, id) => rows.length === 1 && rows[0].loadId === id;
  const custHavells = model.applyFilters(funnel, model.parseFilters({ customer: 'havells' }));
  eq(custHavells.length, 2, 'filter: customer=havells -> L1,L2');
  ok(custHavells.every((r) => r.companyName === 'Havells'), 'filter: customer filter kept only Havells');
  const branchAlwar = model.applyFilters(funnel, model.parseFilters({ branch: ALWAR.toLowerCase() }));
  eq(branchAlwar.length, 2, 'filter: branch=Alwar Cable (1350) -> L1,L2');
  const skipped = model.applyFilters(funnel, model.parseFilters({ status: 'skipped_no_price' }));
  ok(only(skipped, 'L3'), 'filter: status=skipped_no_price -> L3 only');
  const acct = model.applyFilters(funnel, model.parseFilters({ account: 'neemrana' }));
  ok(only(acct, 'L4'), 'filter: account=neemrana -> L4 only');
  const rankHi = model.applyFilters(outcomes, model.parseFilters({ rankMin: '3' }));
  ok(only(rankHi, 'L2'), 'filter: rankMin=3 (outcomes) -> L2 (rank 4) only');
  const notParticipated = model.applyFilters(funnel, model.parseFilters({ participated: 'false' }));
  eq(notParticipated.length, 2, 'filter: participated=false -> L3,L5');
  const vehicle = model.applyFilters(funnel, model.parseFilters({ vehicle: '32ft' }));
  eq(vehicle.length, 2, 'filter: vehicle=32ft -> L3,L4');
  const combined = model.applyFilters(funnel, model.parseFilters({ customer: 'havells', status: 'won' }));
  ok(only(combined, 'L1'), 'filter: AND-combined customer=havells & status=won -> L1');
  // loading-date basis: not captured, so any bound narrows to nothing (documented, not a bug).
  const loadingRange = model.applyFilters(funnel, model.parseFilters({ dateBasis: 'loading', from: String(now - 86400000) }));
  eq(loadingRange.length, 0, 'filter: loading-date basis with a bound -> empty (loading date uncaptured)');

  // ---- 8. summary numbers (backing the live strip) ----
  const s = model.summarize(funnel);
  eq(s.inquiries, 5, 'summary: 5 inquiries');
  eq(s.priced, 3, 'summary: 3 priced (L1,L2,L4)');
  eq(s.skipped, 1, 'summary: 1 skipped (L3)');
  eq(s.won, 1, 'summary: 1 won');
  eq(s.lost, 1, 'summary: 1 lost');
  eq(s.noBid, 1, 'summary: 1 no_bid');
  eq(s.participationPct, 60, 'summary: participation 3/5 = 60%');
  eq(s.winPct, 50, 'summary: win 1/(1+1) = 50%');
  // summary reflects the active filter
  const sFiltered = model.summarize(model.applyFilters(funnel, model.parseFilters({ customer: 'havells' })));
  eq(sFiltered.inquiries, 2, 'summary: honours the customer filter (2 Havells)');

  // ---- 9. facets (filter dropdown options; from the FULL set) ----
  const fac = model.facets(funnel, outcomes);
  ok(fac.customers.some((c) => c.label === 'Havells'), 'facets: customers list includes Havells');
  ok(fac.branches.some((b) => b.value === ALWAR), 'facets: branches list includes Alwar Cable (1350)');
  ok(fac.accounts.some((a) => a.value === 'neemrana'), 'facets: accounts list includes neemrana');

  // ---- 10. .xlsx writer: AutoFilter, typed number cells, frozen header, ZIP round-trip ----
  const parts = xlsx.buildParts({ sheetName: 'Funnel', headers: ['Load Id', 'Our Cost'], rows: [['L1', 90000], ['L2', '']], numericColumns: [1] });
  const sheet = parts['xl/worksheets/sheet1.xml'];
  ok(sheet.includes('<autoFilter ref="A1:B3"'), 'xlsx: AutoFilter present across the used range');
  ok(sheet.includes('<pane ySplit="1"'), 'xlsx: header row frozen');
  ok(sheet.includes('<v>90000</v>'), 'xlsx: numeric column emitted as a typed number cell');
  ok(sheet.includes('t="inlineStr"><is><t xml:space="preserve">Load Id'), 'xlsx: header emitted as inline string');
  ok(!sheet.includes('<v>L1</v>'), 'xlsx: a text value never lands in a numeric <v> cell');
  const buf = xlsx.toXlsx({ sheetName: 'Funnel', headers: ['Load Id', 'Our Cost'], rows: [['L1', 90000], ['L2', '']], numericColumns: [1] });
  ok(Buffer.isBuffer(buf) && buf[0] === 0x50 && buf[1] === 0x4b, 'xlsx: output is a PK-framed ZIP buffer');
  const back = unzip(buf);
  eq(back['xl/worksheets/sheet1.xml'], sheet, 'xlsx: ZIP round-trips the worksheet XML byte-for-byte');
  ok(back['[Content_Types].xml'].includes('spreadsheetml.sheet.main+xml'), 'xlsx: content-types part round-trips');

  // ---- 11. history: the FULL OUTER JOIN behind the console's History page ----
  // The regression under test: History used to read closedBids only, so a discovered-but-never-
  // priced load (L3) had no row anywhere on that screen. `history` must carry BOTH the
  // funnel-only rows (L3 skipped, L5 dismissed) and the outcomes-only rows (L6, whose price
  // request has aged past the prune) - neither `funnel` nor `outcomes` alone can do that.
  eq(history.length, 6, 'history: the union of both stores (L1..L6)');
  const ids = history.map((r) => r.loadId).sort();
  eq(ids.join(','), 'L1,L2,L3,L4,L5,L6', 'history: every load from either store, no duplicates');
  ok(!outcomes.some((r) => r.loadId === 'L3'), 'history: L3 is absent from outcomes (the old History feed) ...');
  ok(history.some((r) => r.loadId === 'L3'), '... and present in history (the gap this fixes)');
  ok(!funnel.some((r) => r.loadId === 'L6'), 'history: L6 is absent from the funnel (request pruned) ...');
  ok(history.some((r) => r.loadId === 'L6'), '... and present in history (outcome record survives)');
  const H6 = (id) => history.find((r) => r.loadId === id);
  eq(H6('L3').status, 'skipped_no_price', 'history: L3 keeps its skipped status through the union');
  eq(H6('L5').status, 'dismissed', 'history: L5 keeps its dismissed status');
  eq(H6('L6').status, 'won', 'history: L6 settles from the outcome record alone');
  // pricedRow vs canonical.participated: L6 has no surviving request, so capturedAt is null even
  // though the load was plainly priced (nothing arms without a cost). The outcome record is the
  // durable proof; reading capturedAt alone would understate every long-window count.
  eq(H6('L6').participated, false, 'history: L6 capturedAt is gone with the pruned request ...');
  eq(model.pricedRow(H6('L6')), true, '... but pricedRow still counts it as priced (outcome record)');
  eq(model.pricedRow(H6('L3')), false, 'history: a skipped row is not priced by either test');

  // ---- 12. summarizeHistory: counts over the union, win rate over DECIDED only ----
  const hs = model.summarizeHistory(history);
  eq(hs.enquiries, 6, 'summarizeHistory: 6 enquiries');
  eq(hs.priced, 4, 'summarizeHistory: 4 priced (L1,L2,L4 captured + L6 by outcome)');
  eq(hs.won, 2, 'summarizeHistory: 2 won (L1,L6)');
  eq(hs.lost, 1, 'summarizeHistory: 1 lost (L2)');
  eq(hs.noBid, 1, 'summarizeHistory: 1 no-bid (L4)');
  eq(hs.skipped, 1, 'summarizeHistory: 1 skipped (L3)');
  eq(hs.dismissed, 1, 'summarizeHistory: 1 dismissed (L5)');
  eq(hs.open, 0, 'summarizeHistory: nothing still in flight in this fixture');
  // The defect this replaces: folding no-bid into lost gave 2/(2+2) = 50%. L4 was never contested.
  eq(hs.winPct, 66.7, 'summarizeHistory: win rate 2/(2+1) = 66.7% over decided auctions only');

  // ---- 13. historyWireRow: the table's shape, without the source docs ----
  const wire = model.historyWireRow(H6('L1'));
  ok(!('_req' in wire) && !('_closed' in wire), 'wire row: source docs stripped');
  ok(!('ourBids' in wire), 'wire row: the per-bid ladder is not shipped to the table');
  eq(wire.loadId, 'L1', 'wire row: keeps the load id the table keys on');
  eq(wire.status, 'won', 'wire row: keeps the derived status');
  eq(wire.priced, true, 'wire row: carries the pricedRow verdict, not raw capturedAt');
  eq(wire.branchName, ALWAR, 'wire row: keeps branch (funnel-side only, used by search)');
  const wire3 = model.historyWireRow(H6('L3'));
  eq(wire3.lastBid, null, 'wire row: a skipped row has no last bid (null, never 0)');
  eq(wire3.finalRank, null, 'wire row: a skipped row has no rank (null, never 0)');

  // ---- 14. the history EXPORT view: the file matches the screen ----
  // Same projection as the funnel view over the union dataset, so a director who can see a
  // skipped enquiry on the page also gets it in the download.
  eq(model.VIEWS.history.dataset, 'history', 'history view: projects from the union dataset');
  const hv = model.VIEWS.history.project(history);
  const HH = (name) => hv.headers.indexOf(name);
  eq(hv.rows.length, 6, 'history view: 6 rows (skipped + outcomes-only both present)');
  ok(hv.rows.some((r) => r[HH('Load Id')] === 'L3'), 'history view: the skipped load is in the file');
  ok(hv.rows.some((r) => r[HH('Load Id')] === 'L6'), 'history view: the outcomes-only load is in the file');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
