'use strict';

const { istDate, istTime, istDateTime, istDateTimeSecs, istStamp, pipe } = require('./csv');
const { withLaneDisplay } = require('./laneDisplay');
const { addressesByKind } = require('../notify/waTemplates');
const { platformOf, isPlaceholderClose, effectiveCloseAt } = require('../pricing/priceRequests');
const { reportedCloseAt, bidGapsMs, lastBidAtLowestMargin, earlyPortalCloseAt } = require('../util/reportedClose');
const { closedOutcome } = require('../util/closedOutcome');
const { resolveBidTimeCost } = require('../notify/bidTimeCost');
const config = require('../config');

/**
 * Funnel-spined export model for the director's filtered data export (Phase 1).
 *
 * WHY this exists (the warranty fix). The old `bid-history` export (exports.js `bidHistory`) reads
 * `closedBids` ONLY — so a load that was discovered and surfaced to the desk but never priced is
 * invisible in it, and the participation/funnel question ("how many of Havells' loads did we even
 * bid on?") cannot be answered from it. The fix is to spine the export on the FUNNEL
 * (`priceRequests`, which holds every discovered load incl. the never-priced ones) LEFT-JOINed to
 * `closedBids` (the won/lost outcome), with a derived per-load status and the branch column
 * (`branchName` lives on `priceRequests`, absent from `closedBids`).
 *
 * SCOPE: read-only. This module only READS the two existing stores through the same seams every
 * other read endpoint uses (`requests.listAll()`, `bidLogger.listClosed()`); it never writes, and
 * it lives entirely above the engine/pricing/platform layers — no bid path is touched.
 *
 * ROLLING WINDOW (state this plainly). `priceRequests` is pruned ~7 days after an auction closes
 * (priceRequests.js `pruneEnded`), so the funnel dataset itself is a rolling window, NOT lifetime
 * history. `closedBids` is never pruned, so the outcomes/bids views (B/C) carry full outcome
 * history back to first deploy. A funnel export that ASKS for a range the working list cannot reach
 * is therefore served from the union instead (see funnelBasis) — which restores every load we bid
 * on, with the request-only columns blank, but CANNOT restore a load we never bid on: nothing about
 * it was ever written anywhere durable. That half still needs the durable ledger (Phase 2, see the
 * scope doc). The consequence that matters is not the blank columns: it is that participation over
 * the union has a DIFFERENT DENOMINATOR than participation over the live list, so the two figures
 * are not comparable and every surface reporting one says which it is (coverageNote).
 * That ledger now accrues - priceRequests.js archives each record to the `priceRequestArchive`
 * stream as the prune drops it - but this export still spines on the live store and is unchanged.
 *
 * LEGAL WALL: our-side data only — our bids, our rank, our cost. SP masks rival amounts on these
 * rank-only auctions; no competitor price exists in the logs and none is emitted here.
 */

// ---- helpers ---------------------------------------------------------------------------------

// A cell value coerced to a finite Number, else '' (empty). SuperProcure ships some numbers as
// strings ("90000.00"); this parses them so the xlsx path can type them and Excel can sum/sort.
function num(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : '';
}

// Boolean -> 'Y' | 'N' | '' (unknown). Director-facing surfaces read Y/N more easily than true/false.
function yn(v) { return v == null ? '' : (v ? 'Y' : 'N'); }

// The customer identity key a row filters/groups on: the matched Customer's slug when one exists,
// else the raw platform company string. Facets and the customer filter both key off this.
function customerKey(row) {
  return (row.customer && row.customer.customerId) || row.companyName || '';
}
function customerLabel(row) {
  return (row.customer && row.customer.label) || row.companyName || '';
}
function accountKey(row) { return (row.account && row.account.accountId) || 'primary'; }
function accountLabel(row) { return (row.account && row.account.label) || 'Primary'; }

/**
 * The canonical per-load status, derived from the two stores (scope doc section 5 truth table).
 * Outcome states come from `closedBids`; funnel-only states come from `priceRequests`. When a
 * closed outcome record exists it wins (won/lost/no_bid), because that is the settled truth.
 */
function deriveStatus(req, closed) {
  if (closed) return closedOutcome(closed);
  // No outcome record -> the funnel status carries it (skipped_no_price / dismissed / awaiting_price
  // / armed / stopped / closed). A req marked 'closed' with no outcome doc is a load that ended with
  // nothing recorded; surface it as no_bid rather than inventing a win/loss.
  if (!req) return 'unknown';
  return req.status === 'closed' ? 'no_bid' : req.status;
}

// The one place the unknown outcome is worded, for every surface that states it. Plain English
// rather than a status key, because the reader is a director and "closed_unknown" answers nothing;
// and it says WHY, because "Unknown" alone reads as a data fault rather than as the specific,
// explainable event it is. No em dash - this string reaches WhatsApp and a downloaded sheet.
//
// FIRST PERSON PLURAL, and that is a hard constraint rather than a preference: the desk-voice gate
// (scripts/test-desk-voice.js) forbids the word "bot" on any surface a human can read, because a
// downloaded sheet gets forwarded and the counterparty platform must never be handed evidence of
// automation.
//
// It names the CONSEQUENCE, not one of the causes, because there are two and they are not the same
// event: a restart mid-auction (rehydrate's sweep) and a portal that stopped answering long past
// the close (_retireUnreadable). Wording it as "we restarted" would have been a plain falsehood on
// every load retired by the second path - nothing restarted, the portal went dark - and would have
// had the desk hunting a restart in the logs that never happened.
const CLOSED_UNKNOWN_LABEL = 'Unknown - we could not see how this auction ended';

// D027: SuperProcure exposes no award signal, so a "won" SP row is rank 1 at close, never a
// confirmed allotment - GoComet's own won flag, by contrast, comes off a settled award (see
// bidEngine.js's readSettledOutcome branch) and keeps its ordinary meaning. `platform` defaults
// to the SP-caveat wording, not the plain word: every canonical row carries a resolved platform
// (platformOf never returns null/undefined - it falls back to config.platformKey, 'sp'), so the
// only caller that reaches the undefined-platform branch is a test calling this directly with no
// argument, not a real row. Keyed on the CONFIGURED GoComet platform key
// (config.gocomet.platformKey, GC_PLATFORM_KEY env-overridable), never the literal 'gocomet',
// so this stays correct if that key is ever reconfigured.
function wonLabel(platform) { return platform === config.gocomet.platformKey ? 'Won' : 'Won (rank 1 at close)'; }

// The human "Result" label for the outcomes view (never the binary Won/Lost that mislabels a
// zero-bid row as a clean loss).
function resultLabel(status, platform) {
  if (status === 'won') return wonLabel(platform);
  if (status === 'lost') return 'Lost';
  if (status === 'no_bid') return 'No-bid';
  if (status === 'closed_unknown') return CLOSED_UNKNOWN_LABEL;
  return status || '';
}

// The Status cell for the funnel/history views, which print the raw status KEY for everything else
// and must keep doing so - those keys are what a saved file's reader filters and pivots on, and
// relabelling them would make new exports incomparable with every one already downloaded. The
// unknown outcome is the exception because it has no prior exports to stay comparable with, and
// because a bare 'closed_unknown' in the column a director reads is precisely the silence this
// change exists to remove.
function statusCell(status) {
  return status === 'closed_unknown' ? CLOSED_UNKNOWN_LABEL : status;
}

// Realized margin % on a won-or-bid row: (lastBid - cost) / cost. '' when either side is missing.
function realizedMarginPct(cost, lastBid) {
  const c = Number(cost);
  const b = Number(lastBid);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(b)) return '';
  return Math.round(((b - c) / c) * 1000) / 10; // one decimal place
}

/**
 * Join one price-request (funnel) and its optional closed-bid (outcome) into the canonical record
 * every view + the summary project from. Either side may be null (an outcomes-view row for a load
 * older than the ~7-day funnel window has no req; a funnel row for a not-yet-closed load has no
 * closed doc).
 */
function canonical(req, closed) {
  const load = (req && req.load) || {};
  const lane = load.lane || (closed && closed.lane) || {};
  const points = load.points || (closed && closed.points) || null;
  const ladder = closed && Array.isArray(closed.ladder) ? closed.ladder : [];
  const ourBids = closed && Array.isArray(closed.ourBids) ? closed.ourBids : [];
  const cost = (req && req.price && req.price.cost != null) ? req.price.cost
    : (closed && closed.cost != null ? closed.cost : '');
  const lastBid = closed && closed.lastBidPrice != null ? closed.lastBidPrice : '';
  // The margin anchor for realizedMargin ONLY (D030) - the cost the bid was actually placed
  // against (resolveBidTimeCost: the per-bid snapshot, else a withdrawn correction, else the
  // doc's own cost), never the request's CURRENT (possibly since-corrected) cost. The `cost`
  // field above stays the current/request cost for display - readers who want "what does this
  // load cost today" still get it; only the realized-margin arithmetic anchors on bid time, the
  // same anchor the receipt (engineAlerts) and the per-customer EOD already use (G-CC11).
  const marginCost = closed ? resolveBidTimeCost(closed) : null;
  const status = deriveStatus(req, closed);
  // D038: falls back to the closed record's own copy once the price request has been pruned -
  // same reasoning as loadCode/branchName/distanceKm/weight/weightUnit above. `createdAt` has no
  // such fallback (closedBids carries no discovery-time timestamp), so timeToPriceMins stays
  // blank for a pruned row regardless - that gap is pre-existing and outside D038's seven fields.
  const capturedAt = (req && req.capturedAt != null) ? req.capturedAt : (closed && closed.capturedAt != null ? closed.capturedAt : null);
  const createdAt = req ? req.createdAt : null;
  const laneFreight = closed && closed.laneFreight ? closed.laneFreight : null;
  return {
    loadId: (req && req.loadId) || (closed && String(closed.auctionId)) || '',
    // D038: falls back to the closed record's own copy once the price request has been pruned
    // (~7 days after close) - closedBids now carries this field forward too, specifically so an
    // older row does not go blank on the one store that never prunes.
    loadCode: (load.loadCode) || (closed && closed.loadCode) || null,
    // The portal this row came from, resolved through the one shared predicate so an untagged
    // legacy record normalizes to SP rather than showing as blank. Present on EVERY canonical row
    // because the datasets built from them are all-portal: it is the label that makes a mixed
    // result visible on screen and in the downloaded file instead of silently averaged into one.
    // Prefer the request side - both sides carry the key and agree, but the request is stamped at
    // discovery and exists for loads that never reached closedBids at all.
    platform: platformOf(req || closed),
    account: (req && req.account) || (closed && closed.account) || null,
    // customer tag is attached by the caller (server resolves it live); companyName is the raw string.
    customer: (req && req.customer) || (closed && closed.customer) || null,
    companyName: load.companyName || (closed && closed.shipper) || '',
    // D038: closedBids carries branchName forward now too, so a pruned request no longer blanks
    // this column on the durable side of the join.
    branchName: load.branchName || (closed && closed.branchName) || null,
    lane: { origin: lane.origin || '', destination: lane.destination || '' },
    points,
    // D038: same fallback, once the price request is pruned.
    distanceKm: load.distanceKm != null ? load.distanceKm : (closed && closed.distanceKm != null ? closed.distanceKm : ''),
    equipment: load.equipment || (closed && closed.equipment) || '',
    units: load.units != null ? load.units : (closed && closed.units != null ? closed.units : ''),
    weight: load.weight != null ? load.weight : (closed && closed.weight != null ? closed.weight : ''),
    weightUnit: load.weightUnit || (closed && closed.weightUnit) || '',
    closeModel: (closed && closed.closeModel) || (load.softClose ? 'soft' : (load.softClose === false ? 'hard' : '')) || '',
    softClose: load.softClose,
    // dates: auction close is what we have; loading date is NOT captured today (see availability note
    // in the scope doc s.4.1 + the PR). Kept as an explicit empty column so the reconciliation shape
    // is stable and self-documents the gap.
    // The auction's own close, through the SAME shared resolver the outcome receipt uses, so the two
    // client-facing surfaces cannot report different close times for one load. Resolving it here
    // instead - even with the same preference written out - is what let them disagree once: the
    // receipt applies a staleness fallback the export did not, and on those records the sheet showed
    // an auction close 190s earlier, before the bid time it lists for the same load. This field is
    // also the sort and report-range key, so a divergence near a day boundary buckets the load
    // differently on the two surfaces. The separate `closedAt` column below still carries the
    // finalize instant, so both facts remain available under distinct headers.
    // C069: the fallback (no closed doc yet) reads the LIVE close, never the stale discovery
    // snapshot alone - a still-open row whose auction extended must not report a close time the
    // portal has already moved past.
    auctionCloseAt: (closed && reportedCloseAt(closed)) || effectiveCloseAt(load) || null,
    auctionStartAt: load.startsAt || (closed && closed.armedAt) || null,
    armedAt: (closed && closed.armedAt) || null,
    closedAt: (closed && closed.closedAt) || null,
    loadingDate: null,
    createdAt,
    capturedAt,
    timeToPriceMins: (capturedAt && createdAt) ? Math.round((capturedAt - createdAt) / 60000) : '',
    cost,
    floor: closed && closed.floor != null ? closed.floor : '',
    openingBid: ladder.length ? ladder[0] : '',
    floorBid: ladder.length ? ladder[ladder.length - 1] : '',
    lastBid,
    numBids: ourBids.length,
    unconfirmedCount: (closed && closed.gcUnconfirmedSubmissions || []).length,
    anyBid: closed ? ourBids.length > 0 : null,
    finalRank: closed && closed.finalRank != null ? closed.finalRank : '',
    // NOT `!!closed.won` for an unknown outcome: the sweep deliberately writes won null to mean "not
    // known", and coercing it to false put "No" in the Won column of the very same exported row
    // whose Status now reads that the outcome is unknown. Before the unknown status existed both
    // columns were wrong together and agreed; fixing only one made them contradict each other.
    won: closed ? (status === 'closed_unknown' ? null : !!closed.won) : null,
    marginsPct: (req && req.marginsPct) || (closed && closed.marginsPct) || null,
    minMarginPct: (req && req.minMarginPct != null) ? req.minMarginPct
      : (closed && closed.minMarginPct != null ? closed.minMarginPct : ''),
    // D038: same fallback, once the price request is pruned.
    marginSource: (req && req.marginSource) || (closed && closed.marginSource) || '',
    realizedMargin: realizedMarginPct(marginCost != null ? marginCost : cost, lastBid),
    laneAvg: laneFreight ? (laneFreight.ftl != null ? laneFreight.ftl : (laneFreight.pmt != null ? laneFreight.pmt : '')) : '',
    status,
    participated: capturedAt != null,
    ourBids,
    _req: req,
    _closed: closed,
  };
}

/**
 * Build the joined datasets from the live stores. Read-only.
 *   funnel:   one canonical row per discovered load (priceRequests LEFT JOIN closedBids). The
 *             participation spine — includes never-priced (skipped) loads. Rolling ~7-day window.
 *   outcomes: one canonical row per closed auction (closedBids LEFT JOIN priceRequests, for branch
 *             + distance + loading-date context). Full outcome history.
 *   history:  the FULL OUTER JOIN - one canonical row per load known to EITHER store. This is the
 *             complete on-screen record the console's History page renders, and it is deliberately
 *             neither of the two above: `funnel` drops any auction older than the ~7-day request
 *             prune, `outcomes` drops every load we never armed (skipped / dismissed / still open).
 *             A director asking "where did that enquiry go?" needs both halves in one list, so the
 *             union is the only dataset that can answer it. The retention asymmetry survives the
 *             join and CANNOT be engineered away here - the last ~7 days are complete, and beyond
 *             that only loads with an outcome record still exist. Say so in the UI; do not imply
 *             the older window is empty because nothing was skipped.
 *   The bids view is projected from `outcomes` (it walks each row's ourBids[]).
 *
 * `attachCustomer(companyName) -> {customerId,label}|null` lets the caller (server.js) resolve the
 * customer tag with the same live matcher the rest of the console uses; omitted in tests.
 *
 * `platformKey`, when passed, scopes BOTH input sides to one portal - not just `reqs`. `outcomes`
 * and `history` build their rows by iterating `closed`/the union directly (not by looking anything
 * up off the filtered `reqs`), so a closedBids record from a second portal would otherwise land in
 * those datasets regardless of what `reqs` was scoped to - the exact half-filtered defect this
 * parameter exists to close. Both filters now go through the owning stores' own seams
 * (PriceRequestStore.listFor / BidLogger.listClosed) rather than a hand-rolled ownedBy pass here,
 * so there is one filter implementation per collection instead of one per reader.
 *
 * OMITTED means every portal, and the production call sites deliberately split on that: the
 * row-emitting ones (/api/history and the funnel/outcomes/bids/history downloads) pass nothing and
 * carry the portal in a `platform` column, because one desk works both portals and hiding the
 * GoComet rows it priced would be wrong rather than incomplete; /api/export/summary passes
 * config.platformKey, because a participation percentage has no row to label and mixing portals
 * into it is exactly the silent corruption the scoping exists to prevent. A caller that passes
 * neither and shows no label is the one combination that is always a defect.
 */
async function buildDatasets({ requests, bidLogger }, { attachCustomer, platformKey } = {}) {
  const [reqs, closed] = await Promise.all([
    platformKey ? requests.listFor(platformKey) : requests.listAll(),
    bidLogger.listClosed({ platformKey }),
  ]);
  const closedByLoad = new Map();
  for (const c of closed) closedByLoad.set(String(c.auctionId), c);
  const reqByLoad = new Map();
  for (const r of reqs) reqByLoad.set(String(r.loadId), r);

  const tag = (row) => {
    if (attachCustomer && !row.customer && row.companyName) row.customer = attachCustomer(row.companyName);
    return row;
  };

  const funnel = reqs.map((r) => tag(canonical(r, closedByLoad.get(String(r.loadId)) || null)));
  const outcomes = closed.map((c) => tag(canonical(reqByLoad.get(String(c.auctionId)) || null, c)));
  // The union key set: every load id either store knows about. Built off the SAME two maps, so
  // the full outer join costs no extra store read - only the canonical() projection per row.
  const allIds = new Set();
  for (const r of reqs) allIds.add(String(r.loadId));
  for (const c of closed) allIds.add(String(c.auctionId));
  const history = [...allIds].map((id) => tag(canonical(reqByLoad.get(id) || null, closedByLoad.get(id) || null)));
  // newest first, by the auction close
  const byClose = (a, b) => (Number(b.auctionCloseAt) || 0) - (Number(a.auctionCloseAt) || 0);
  funnel.sort(byClose);
  outcomes.sort(byClose);
  history.sort(byClose);
  return { funnel, outcomes, history };
}

// ---- filters ---------------------------------------------------------------------------------

// Query params arrive as string | string[] | undefined (Express arrays a repeated key). Normalize
// to a lowercased string array with blanks dropped.
function toArr(v) {
  if (v == null) return [];
  const a = Array.isArray(v) ? v : [v];
  return a.map((x) => String(x).trim()).filter(Boolean);
}
function toArrLower(v) { return toArr(v).map((s) => s.toLowerCase()); }

// epoch-ms or ISO string -> epoch ms, or null.
function parseTs(v) {
  if (v == null || v === '') return null;
  const p = Date.parse(v);
  if (!Number.isNaN(p)) return p;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the export/summary query string into a normalized filter object. All optional, all
 * AND-combined. `dateBasis` picks which date the from/to range applies to: 'auction' (default,
 * the auction close) or 'loading' (the SP loading date — NOT captured yet, so a loading-date
 * range currently narrows to nothing; documented, not a bug).
 */
function parseFilters(q = {}) {
  return {
    customer: toArrLower(q.customer),
    // The portal narrowing. It is what makes the all-portal datasets usable rather than merely
    // honest: the desk can pull one portal's rows back out, and can reproduce the SP-only
    // participation number /api/export/summary reports by passing platform=sp here. Empty (the
    // default) means every portal, matching the datasets the filter runs over.
    platform: toArrLower(q.platform),
    branch: toArrLower(q.branch),
    account: toArrLower(q.account),
    vehicle: toArrLower(q.vehicle),
    status: toArrLower(q.status),
    dateBasis: String(q.dateBasis || 'auction').toLowerCase() === 'loading' ? 'loading' : 'auction',
    // An EXPLICIT all-time request. Absent date bounds cannot carry this meaning: the Export page's
    // first paint and its Reset state also send no bound, and those mean the live worklist, not
    // every load we ever ran. Only a caller that says so gets the wider population (see funnelBasis).
    allTime: String(q.allTime == null ? '' : q.allTime).toLowerCase() === 'true',
    from: parseTs(q.from),
    to: parseTs(q.to),
    loadingFrom: parseTs(q.loadingFrom),
    loadingTo: parseTs(q.loadingTo),
    participated: q.participated == null || q.participated === '' ? null : (String(q.participated).toLowerCase() === 'true'),
    rankMin: parseNum(q.rankMin),
    rankMax: parseNum(q.rankMax),
    closeModel: q.closeModel ? String(q.closeModel).toLowerCase() : null,
    origin: q.origin ? String(q.origin).trim().toLowerCase() : null,
    destination: q.destination ? String(q.destination).trim().toLowerCase() : null,
    valueMin: parseNum(q.valueMin),
    valueMax: parseNum(q.valueMax),
    marginMin: parseNum(q.marginMin),
    marginMax: parseNum(q.marginMax),
  };
}

// The date a row is filtered on, given the basis. Loading date is null today, so a loading-basis
// range with any bound set excludes every row (until Phase 2 captures it).
function rowDate(row, basis) {
  return basis === 'loading' ? row.loadingDate : (Number(row.auctionCloseAt) || null);
}

/** Predicate: does this canonical row pass every active filter? Pure — no store access. */
function matches(row, f) {
  if (f.customer.length && !f.customer.includes(customerKey(row).toLowerCase())) return false;
  if (f.platform.length && !f.platform.includes(String(row.platform || '').toLowerCase())) return false;
  if (f.branch.length && !f.branch.includes(String(row.branchName || '').toLowerCase())) return false;
  if (f.account.length) {
    const ak = accountKey(row).toLowerCase();
    const al = accountLabel(row).toLowerCase();
    if (!f.account.includes(ak) && !f.account.includes(al)) return false;
  }
  if (f.vehicle.length && !f.vehicle.includes(String(row.equipment || '').toLowerCase())) return false;
  if (f.status.length && !f.status.includes(String(row.status || '').toLowerCase())) return false;

  // The single date picker applies to whichever date the basis toggle selects (auction close by
  // default; loading date when the director flips it). Loading date is uncaptured today, so a
  // loading-basis range currently narrows to nothing — documented, not a bug (see rowDate).
  if (f.from != null || f.to != null) {
    const d = rowDate(row, f.dateBasis);
    if (d == null) return false; // no date on this basis -> excluded when a bound is set
    if (f.from != null && d < f.from) return false;
    if (f.to != null && d > f.to) return false;
  }
  // Optional explicit loading-date bounds, independent of the basis toggle (honours the API
  // contract's loadingFrom/loadingTo); also empty until loading date is captured.
  if (f.loadingFrom != null || f.loadingTo != null) {
    if (row.loadingDate == null) return false;
    if (f.loadingFrom != null && row.loadingDate < f.loadingFrom) return false;
    if (f.loadingTo != null && row.loadingDate > f.loadingTo) return false;
  }

  // Same correction as funnelView's column: filter on pricedRow, not the raw flag. Filtering
  // `participated=true` on the raw flag silently DROPPED every won and lost auction older than the
  // request-retention window, because their price request had been pruned - so the one filter
  // meant to isolate "loads we actually bid on" excluded the strongest evidence that we did.
  if (f.participated != null && pricedRow(row) !== f.participated) return false;

  if (f.rankMin != null || f.rankMax != null) {
    const r = Number(row.finalRank);
    if (!Number.isFinite(r)) return false; // null rank excluded from a rank-bounded query
    if (f.rankMin != null && r < f.rankMin) return false;
    if (f.rankMax != null && r > f.rankMax) return false;
  }

  if (f.closeModel && String(row.closeModel || '').toLowerCase() !== f.closeModel) return false;
  if (f.origin && !String(row.lane.origin || '').toLowerCase().includes(f.origin)) return false;
  if (f.destination && !String(row.lane.destination || '').toLowerCase().includes(f.destination)) return false;

  if (f.valueMin != null || f.valueMax != null) {
    const v = Number(row.lastBid !== '' ? row.lastBid : row.cost);
    if (!Number.isFinite(v)) return false;
    if (f.valueMin != null && v < f.valueMin) return false;
    if (f.valueMax != null && v > f.valueMax) return false;
  }

  if (f.marginMin != null || f.marginMax != null) {
    const m = Number(row.realizedMargin);
    if (!Number.isFinite(m)) return false;
    if (f.marginMin != null && m < f.marginMin) return false;
    if (f.marginMax != null && m > f.marginMax) return false;
  }
  return true;
}

function applyFilters(rows, f) { return rows.filter((r) => matches(r, f)); }

// ---- coverage: which rows a range can actually be served from --------------------------------

/**
 * The oldest auction the LIVE working list still holds. `priceRequests` is pruned
 * PRUNE_RETENTION_MS after an auction closes, so this - not the requested range - is the real
 * bottom of the funnel dataset. null when the working list is empty.
 */
function liveFloor(funnelRows) {
  let min = null;
  for (const r of funnelRows) {
    const d = Number(r.auctionCloseAt);
    if (!Number.isFinite(d) || d <= 0) continue;
    if (min == null || d < min) min = d;
  }
  return min;
}

/**
 * WHICH POPULATION a funnel query is answered from, and therefore which metric the participation
 * percentage on it IS. The two are different numbers and must never be read against each other:
 *
 *   'live'     the rolling working list. Every load we SURFACED is in it, priced or not, so
 *              participation = bids / loads surfaced - the figure the desk's standing baseline is
 *              measured on. This is the default, including the page's first paint and its Reset.
 *   'history'  the union with closedBids. It reaches back to the first auction we ran, but a load
 *              that was discovered and never priced, older than the prune, was never written
 *              anywhere durable - so the denominator is loads still ON RECORD, not loads surfaced,
 *              and the ratio reads higher for that reason alone. The page has to say so.
 *
 * Absent date bounds mean 'live', not 'all time': the funnel dataset alone cannot answer a range
 * reaching below liveFloor, but "no bound given" is not such a range - it is the unfiltered default
 * state, and silently widening it swapped the population behind a card still titled "Live funnel".
 * A caller wanting the union asks for it (allTime), or picks a bound the working list cannot reach.
 */
function funnelBasis(datasets, filters) {
  if (!filters) return 'live';
  if (filters.allTime) return 'history';
  // Only an auction-close bound can be compared against the live floor; the loading-date basis has
  // no captured date on either side of the join, so it stays on the worklist it always read.
  if (filters.dateBasis !== 'auction') return 'live';
  if (filters.from == null && filters.to == null) return 'live';
  const floor = liveFloor(datasets.funnel);
  if (floor == null) return 'history'; // empty worklist: only the union can answer a bounded range
  const bound = filters.from != null ? filters.from : filters.to;
  return bound < floor ? 'history' : 'live';
}

/**
 * The rows a view exports under this filter.
 *
 * There is no double-count and no merge rule to get wrong: `history` is keyed by load id and each
 * row is the same canonical(req, closed) call the funnel row was, so a load present in both stores
 * yields ONE row built from its live request - the richer side - with the ledger filling only what
 * the request never carried. A load whose request is gone yields a row whose request-only columns
 * are blank (REQUEST_ONLY_COLUMNS); nothing is inferred to fill them.
 *
 * Only the funnel dataset has this problem. `outcomes` (and the bids view projected from it) read
 * closedBids, which is never pruned.
 */
function datasetFor(datasets, spec, filters) {
  if (!spec || spec.dataset !== 'funnel') return datasets[spec ? spec.dataset : 'funnel'];
  return funnelBasis(datasets, filters) === 'history' ? datasets.history : datasets.funnel;
}

/**
 * The range the produced file ACTUALLY covers, from the rows it contains. The filename used to be
 * stamped from the REQUESTED range, which is how a 90-day filename ended up on a week of rows.
 *
 * SuperProcure's shared year-2100 placeholder close is excluded from the bounds only - the row
 * still ships, it just may not name the range, or one unpriced placeholder would claim the file
 * runs to 2100. Both bounds are null when no row carries a usable close time.
 */
function coveredRange(rows, nowMs = Date.now()) {
  let from = null, to = null;
  for (const r of rows) {
    const d = Number(r.auctionCloseAt);
    if (!Number.isFinite(d) || d <= 0 || isPlaceholderClose(d, nowMs)) continue;
    if (from == null || d < from) from = d;
    if (to == null || d > to) to = d;
  }
  return { from, to };
}

// The funnel columns that only ever lived on the price request. On a load whose request has been
// pruned they are BLANK: the value was never written anywhere else, so there is nothing to recover
// and nothing may be invented in its place. Named here so the page can say so in the same words.
const REQUEST_ONLY_COLUMNS = [
  'Load Code', 'Branch', 'Distance(KM)', 'Weight', 'Unit', 'Priced At', 'Time-to-Price (min)', 'Margin Source',
];

/**
 * The plain-English caveat the Export page's summary strip renders, in the words of whichever
 * population answered the query (see funnelBasis). The caveat that matters is not "some columns are
 * blank" - it is WHICH participation figure the director is looking at, because the two have
 * different denominators and only one of them compares to the standing baseline.
 */
function coverageNote({ from, to }, retentionDays, basis = 'live') {
  const span = (from != null && to != null) ? `Covering ${istDate(from)} to ${istDate(to)}. ` : '';
  if (basis !== 'history') {
    return `${span}These are the live working list: participation is bids over every load we `
      + `surfaced, and the list holds every such load for the last ~${retentionDays} days.`;
  }
  return `${span}Complete for the last ~${retentionDays} days; before that only loads we bid on are `
    + `still on record, so ${REQUEST_ONLY_COLUMNS.join(', ')} are blank on those rows. Participation `
    + 'here is bids over loads still on record, NOT over every load we surfaced - do not read it '
    + 'against the live-window participation figure.';
}

/**
 * The download's filename stem. Stamped from the range the rows ACTUALLY span, not the range asked
 * for: stamping the request is what put a 90-day name on a week of rows and made the file look like
 * it had lost data. An empty result spans no range of its own, so it falls back to the bounds the
 * director picked, and istStamp renders a bound that is open on that side as 'all'.
 */
function exportFilename(spec, rows, filters, nowMs = Date.now()) {
  const covered = coveredRange(rows, nowMs);
  const from = covered.from != null ? covered.from : (filters ? filters.from : null);
  const to = covered.to != null ? covered.to : (filters ? filters.to : null);
  return `${spec.file}_${istStamp(from)}_to_${istStamp(to)}`;
}

// ---- summary + facets ------------------------------------------------------------------------

/**
 * The Export strip summary numbers, computed off the FILTERED funnel rows. `inquiries` is a
 * rolling ~7-day discovery count, not a live/open count - see summarizeHistory's `open` for that.
 *   inquiries        discovered loads in scope, over the rolling window
 *   priced           participated (a cost was captured)
 *   participationPct priced / inquiries
 *   skipped          discovered, never priced, auction closed (skipped_no_price)
 *   won / lost       from the joined outcome
 *   winPct           won / (won + lost)  — of decided auctions
 */
function summarize(funnelRows) {
  const inquiries = funnelRows.length;
  let priced = 0, skipped = 0, won = 0, lost = 0, noBid = 0, dismissed = 0, closedUnknown = 0;
  for (const r of funnelRows) {
    // pricedRow, NOT the raw `participated` flag, for the same reason matches() and funnelView use
    // it: `participated` reads capturedAt, which lives on the price request and is pruned after
    // PRUNE_RETENTION_MS. On any dataset reaching below that prune the raw flag reads false for
    // every load we demonstrably bid on and won, and this tile - the director's participation
    // number - would report it as unpriced.
    if (pricedRow(r)) priced += 1;
    switch (r.status) {
      case 'skipped_no_price': skipped += 1; break;
      case 'won': won += 1; break;
      case 'lost': lost += 1; break;
      case 'no_bid': noBid += 1; break;
      case 'dismissed': dismissed += 1; break;
      // deriveStatus's third answer. Falling through `default` left the row counted in `inquiries`
      // (a raw rows.length) and in no bucket, so the strip stopped summing with nothing naming where
      // the row went - on the screen the desk watches live.
      case 'closed_unknown': closedUnknown += 1; break;
      default: break;
    }
  }
  const decided = won + lost;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    inquiries, priced, skipped, won, lost, noBid, dismissed, closedUnknown,
    participationPct: pct(priced, inquiries),
    winPct: pct(won, decided),
  };
}

/**
 * Did we actually put a number on this load? `canonical.participated` reads capturedAt, which only
 * exists while the price-request survives (~7 days). On the history union an older row can have a
 * closed-bid record with its request already pruned - we plainly DID price that load (nothing gets
 * armed without a captured cost), so treating it as unpriced would understate every long-window
 * count. The outcome record is the durable proof; capturedAt is the fresh-window proof.
 */
function pricedRow(row) { return !!(row.participated || row._closed); }

/**
 * Roll-up for the console's History strip, computed over the FULL OUTER JOIN (see buildDatasets).
 *
 * Deliberately NOT summarize(): that one is the participation metric over the rolling funnel and
 * owns the director's headline "% participation" number. Reporting a second, differently-scoped
 * participation percentage on another screen is how one metric becomes two contradicting numbers,
 * so History reports COUNTS and leaves the ratio to the Reports strip. The one ratio it does carry
 * is the win rate, over DECIDED auctions only (won + lost) - a no-bid is not a loss, and counting
 * it as one is the exact defect this roll-up replaces.
 */
function summarizeHistory(rows) {
  let priced = 0, won = 0, lost = 0, noBid = 0, skipped = 0, dismissed = 0, open = 0, closedUnknown = 0;
  for (const r of rows) {
    if (pricedRow(r)) priced += 1;
    switch (r.status) {
      case 'won': won += 1; break;
      case 'lost': lost += 1; break;
      case 'no_bid': noBid += 1; break;
      case 'skipped_no_price': skipped += 1; break;
      case 'dismissed': dismissed += 1; break;
      case 'awaiting_price': case 'armed': case 'stopped': open += 1; break;
      // See summarize: the same third answer, and the same reason it cannot be left to fall through.
      case 'closed_unknown': closedUnknown += 1; break;
      default: break;
    }
  }
  const decided = won + lost;
  return {
    enquiries: rows.length, priced, won, lost, noBid, skipped, dismissed, open, closedUnknown,
    winPct: decided ? Math.round((won / decided) * 1000) / 10 : 0,
  };
}

/**
 * One canonical row projected to the wire shape the History table renders. Drops `_req`/`_closed`
 * (the whole source docs - megabytes of ladder/bid detail the table never reads) and `ourBids`,
 * keeping only the rendered columns plus the ids the row keys and searches on.
 */
function historyWireRow(row) {
  return {
    loadId: row.loadId,
    loadCode: row.loadCode || null,
    // /api/history is all-portal (see buildDatasets), so the portal has to ride each row or the
    // console shows two portals' enquiries in one list with no way to tell them apart.
    platform: row.platform || '',
    customer: row.customer || null,
    companyName: row.companyName || '',
    branchName: row.branchName || null,
    account: row.account || null,
    lane: row.lane,
    points: row.points || null,
    // The same composed lane the worklist renders (city labels, addresses from either portal's
    // shape), so a GoComet enquiry on History reads "Surat → Kutch" rather than two postal
    // addresses. Derived at serve time from the row's own lane and points, never stored.
    laneDisplay: withLaneDisplay({ lane: row.lane, points: row.points || null }, row.platform || undefined).laneDisplay,
    equipment: row.equipment || '',
    units: row.units === '' ? null : row.units,
    auctionCloseAt: row.auctionCloseAt || null,
    closeModel: row.closeModel || '',
    cost: row.cost === '' ? null : row.cost,
    lastBid: row.lastBid === '' ? null : row.lastBid,
    numBids: row.numBids,
    unconfirmedCount: row.unconfirmedCount || 0,
    finalRank: row.finalRank === '' ? null : row.finalRank,
    status: row.status,
    priced: pricedRow(row),
  };
}

/**
 * The dropdown options for the filter panel, derived from the FULL (unfiltered) funnel + outcomes
 * so a picked value never collapses the list to itself. Each facet is [{value,label}] sorted by
 * label. Customer/branch/vehicle/account/closeModel/status.
 */
function facets(funnelRows, outcomeRows) {
  const all = funnelRows.concat(outcomeRows);
  const cust = new Map(); const branch = new Map(); const veh = new Map(); const acct = new Map();
  const close = new Set(); const stat = new Set(); const plat = new Set();
  for (const r of all) {
    if (r.platform) plat.add(r.platform);
    const ck = customerKey(r); if (ck) cust.set(ck.toLowerCase(), { value: ck, label: customerLabel(r) });
    if (r.branchName) branch.set(r.branchName.toLowerCase(), { value: r.branchName, label: r.branchName });
    if (r.equipment) veh.set(String(r.equipment).toLowerCase(), { value: r.equipment, label: r.equipment });
    acct.set(accountKey(r).toLowerCase(), { value: accountKey(r), label: accountLabel(r) });
    if (r.closeModel) close.add(r.closeModel);
    if (r.status) stat.add(r.status);
  }
  const sortByLabel = (m) => [...m.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return {
    customers: sortByLabel(cust),
    branches: sortByLabel(branch),
    vehicles: sortByLabel(veh),
    accounts: sortByLabel(acct),
    closeModels: [...close].sort(),
    statuses: [...stat].sort(),
    platforms: [...plat].sort(),
  };
}

// ---- view projections ({headers, rows, numericColumns}) --------------------------------------
// numericColumns lists the 0-based header indices the xlsx writer types as numbers.

function pointsCols(points) {
  return { pickup: addressesByKind(points, 'pickup'), drop: addressesByKind(points, 'drop') };
}

// View A — Participation / funnel. One row per discovered load; includes skipped (never-priced).
// 'Platform' sits at column 2 in all three views, matching the price-requests CSV, so the three
// files an analyst opens together label the portal in the same place.
const FUNNEL_HEADERS = [
  'Load Id', 'Platform', 'Load Code', 'Auction Date', 'Auction Time', 'Loading Date',
  'Customer', 'Branch', 'Account', 'Origin', 'Destination', 'Distance(KM)', 'Vehicle',
  'Weight', 'Unit', 'Status', 'Participated (Y/N)', 'Priced At', 'Time-to-Price (min)',
  'Our Cost', 'Our Last Bid', 'Final Rank', 'Won', 'Close Model', 'Margin Source', 'SP Lane Avg',
  // Provenance, and it rides on the ROW on purpose. A saved file is opened outside this app, where
  // the only other signal that a row came from the bid record is that eight unrelated columns
  // happen to be blank - which reads as missing data rather than as a load whose enquiry was never
  // durably recorded. Appended last so FUNNEL_NUMERIC's indices stay valid.
  'Source',
];
const FUNNEL_NUMERIC = [11, 13, 18, 19, 20, 21, 25]; // Distance, Weight, TTP, Cost, LastBid, Rank, LaneAvg

// Which store this row's content could have come from. The price request is the richer side and is
// pruned; a row without one exists only because closedBids kept its outcome.
function rowSource(row) { return row._req ? 'funnel' : 'bid record'; }

function funnelView(rows) {
  const out = rows.map((r) => [
    r.loadId, r.platform || '', r.loadCode || '', istDate(r.auctionCloseAt), istTime(r.auctionCloseAt), istDate(r.loadingDate),
    customerLabel(r), r.branchName || '', accountLabel(r), r.lane.origin, r.lane.destination, num(r.distanceKm), r.equipment,
    // pricedRow, NOT the raw `participated` flag. `participated` reads capturedAt, which lives on
    // the price REQUEST - and requests are pruned after PRUNE_RETENTION_MS. A load we won three
    // weeks ago has no request left, so the raw flag is false and this column printed "N" against
    // an auction we demonstrably bid on and won. That is the export's headline question answered
    // backwards, on the artifact someone would use to reproduce the participation count. `_closed`
    // is the surviving evidence that a bid existed, which is exactly what pricedRow folds in.
    num(r.weight), r.weightUnit || '', statusCell(r.status), yn(pricedRow(r)), istDateTime(r.capturedAt), r.timeToPriceMins === '' ? '' : num(r.timeToPriceMins),
    num(r.cost), num(r.lastBid), num(r.finalRank), yn(r.won), r.closeModel || '', r.marginSource || '', num(r.laneAvg),
    rowSource(r),
  ]);
  return { headers: FUNNEL_HEADERS, rows: out, numericColumns: FUNNEL_NUMERIC };
}

// View B — Won/Lost outcomes. One row per closed auction; the reconciliation + branch columns
// added to the old bid-history shape, plus the honest Won/Lost/No-bid Result.
const OUTCOMES_HEADERS = [
  'Load Id', 'Platform', 'Auction Date', 'Auction Time', 'Loading Date', 'Customer', 'Branch', 'Account',
  'Origin', 'Destination', 'Distance(KM)', 'Vehicle', 'Units', 'Cost', 'Floor',
  'Opening Bid', 'Floor Bid', 'Our Last Bid', 'Num Bids', 'Any Bid (Y/N)',
  'Margin Band', 'Realized Margin %', 'Final Rank', 'Result', 'Close Model', 'Armed At', 'Closed At', 'Pickup', 'Drop',
];
const OUTCOMES_NUMERIC = [10, 12, 13, 14, 15, 16, 17, 18, 21, 22]; // Distance,Units,Cost,Floor,Opening,FloorBid,LastBid,NumBids,RealizedMargin,Rank

function outcomesView(rows) {
  const out = rows.map((r) => {
    const pc = pointsCols(r.points);
    return [
      r.loadId, r.platform || '', istDate(r.auctionCloseAt), istTime(r.auctionCloseAt), istDate(r.loadingDate), customerLabel(r), r.branchName || '', accountLabel(r),
      r.lane.origin, r.lane.destination, num(r.distanceKm), r.equipment, num(r.units), num(r.cost), num(r.floor),
      num(r.openingBid), num(r.floorBid), num(r.lastBid), r.numBids, yn(r.anyBid),
      pipe(r.marginsPct), r.realizedMargin === '' ? '' : num(r.realizedMargin), num(r.finalRank), resultLabel(r.status, r.platform),
      r.closeModel || '', istDateTime(r.armedAt), istDateTime(r.closedAt), pc.pickup, pc.drop,
    ];
  });
  return { headers: OUTCOMES_HEADERS, rows: out, numericColumns: OUTCOMES_NUMERIC };
}

// View C — Per-bid detail. One row per individual bid (the ladder walk), with Load Id + branch
// context so a bid row joins back to SP by Load Id.
const BIDS_HEADERS = [
  'Load Id', 'Platform', 'Customer', 'Branch', 'Origin', 'Destination', 'Bid #', 'Bid Time',
  'Rung Index', 'Price', 'Rank (socket)', 'Latency(ms)', 'Extends Observed', 'Revisions Left',
];
const BIDS_NUMERIC = [6, 8, 9, 10, 11, 12, 13];

function bidsView(rows) {
  const out = [];
  for (const r of rows) {
    r.ourBids.forEach((b, i) => {
      const rank = b.socketRank != null ? b.socketRank : (b.rank != null ? b.rank : '');
      out.push([
        r.loadId, r.platform || '', customerLabel(r), r.branchName || '', r.lane.origin, r.lane.destination, i + 1, istDateTimeSecs(b.ts),
        b.rungIndex != null ? b.rungIndex : '', num(b.price), num(rank), b.latencyMs != null ? num(b.latencyMs) : '',
        b.extendsObserved != null ? num(b.extendsObserved) : '', b.engineRevisionsLeft != null ? num(b.engineRevisionsLeft) : '',
      ]);
    });
  }
  return { headers: BIDS_HEADERS, rows: out, numericColumns: BIDS_NUMERIC };
}

// View D - one row per closed load: where our last bid stood and why the load ended as it did.
// Column names are the owner's (24 Sep 2026), verbatim. A cell the record cannot prove is left blank.
const LAST_BID_HEADERS = [
  'OA', 'Our last bid', 'Last bid, secs before close', 'Bid in final seconds?', 'At lowest margin?',
  'Undercut after our bid?', 'Result',
];
const LAST_BID_NUMERIC = [1, 2];

const RESULT_WORDS = {
  lost_on_price: 'Lost on price',
  lost_on_timing: 'Lost on timing (our fault)',
  undercut_while_leading: 'Undercut while leading',
  // B112: a subset of undercut_while_leading where the record shows this load went through a
  // GENUINE hold cycle - the rival's win may be OUR pause, not a clean competitive undercut.
  hold_undercut: 'Held, then undercut',
  no_bid_portal_closed_early: 'No bid: portal closed early',
  unknown: 'Unknown',
};

function resultWords(reason, platform) {
  if (!reason) return '';
  if (reason === 'won') return wonLabel(platform); // D027: SP caveat, GoComet plain
  if (RESULT_WORDS[reason]) return RESULT_WORDS[reason];
  return reason.startsWith('no_bid_') ? `No bid: ${reason.slice('no_bid_'.length).replace(/_/g, ' ')}` : reason;
}

const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');

function lastBidView(rows) {
  const out = [];
  for (const r of rows) {
    const closed = r._closed || {};
    const bids = r.ourBids.filter(Boolean);
    const last = bids.length ? bids[bids.length - 1] : null;
    // Measured to the ACTUAL close, so blank whenever that close is not known: never published, or
    // ended early by the portal.
    const known = closed.finalCloseUnknown !== true && earlyPortalCloseAt(closed) == null;
    const gap = last && known ? bidGapsMs(last, reportedCloseAt(closed)).toFinalMs : null;
    const lead = closed.leadAfterLastBid != null ? closed.leadAfterLastBid : null;
    let finalSeconds = '';
    if (last && closed.lastBidInFinalSeconds === true) finalSeconds = 'Yes';
    else if (last && closed.lastBidInFinalSeconds === false) finalSeconds = lead === true ? 'No (held rank 1)' : 'No';
    const rank = closed.finalRank != null ? Number(closed.finalRank) : null;
    const undercut = lead === true && rank != null ? rank > 1 : (lead === false ? false : null);
    out.push([
      r.loadId, last && closed.lastBidPrice != null ? num(closed.lastBidPrice) : '',
      gap == null ? '' : Math.round(gap / 100) / 10, finalSeconds,
      last ? yesNo(lastBidAtLowestMargin(closed)) : '', last ? yesNo(undercut) : '', resultWords(closed.resultReason, r.platform),
    ]);
  }
  return { headers: LAST_BID_HEADERS, rows: out, numericColumns: LAST_BID_NUMERIC };
}

// The set of view keys this module serves, and which dataset each projects from.
// `history` reuses the funnel PROJECTION over the union DATASET on purpose: the funnel columns
// (Status, Participated, cost, last bid, rank, won) are already the complete-record shape, and
// giving the History page's export button its own headers would let the screen and the file it
// downloads disagree about what a row is.
const VIEWS = {
  funnel: { dataset: 'funnel', project: funnelView, sheet: 'Funnel', file: 'inquiries-funnel' },
  outcomes: { dataset: 'outcomes', project: outcomesView, sheet: 'Outcomes', file: 'auction-outcomes' },
  bids: { dataset: 'outcomes', project: bidsView, sheet: 'Bids', file: 'every-bid' },
  lastbid: { dataset: 'outcomes', project: lastBidView, sheet: 'Last Bid', file: 'last-bid-per-load' },
  history: { dataset: 'history', project: funnelView, sheet: 'History', file: 'enquiry-history' },
};

module.exports = {
  buildDatasets, parseFilters, applyFilters, matches, summarize, summarizeHistory, facets,
  funnelView, outcomesView, bidsView, lastBidView, deriveStatus, canonical, historyWireRow, pricedRow, VIEWS,
  liveFloor, funnelBasis, datasetFor, coveredRange, coverageNote, exportFilename, rowSource,
  FUNNEL_HEADERS, OUTCOMES_HEADERS, BIDS_HEADERS, LAST_BID_HEADERS, REQUEST_ONLY_COLUMNS,
  // Exported so every surface that states the unknown outcome states it identically, and so a
  // test can pin the wording rather than re-typing it (a re-typed string silently drifts).
  CLOSED_UNKNOWN_LABEL, resultLabel, statusCell,
};
