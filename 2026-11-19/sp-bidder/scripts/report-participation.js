'use strict';
/**
 * report-participation.js - READ-ONLY participation analysis for the SP auto-bidder.
 *
 * WHY. The client directive (Suyashh, 2026-07-25) is "100% participation - every load gets a
 * bid." Nothing can be driven to 100% until it is measured. This script IS the measurement: it
 * computes the participation funnel from the bidder's OWN records -
 *
 *     inquiries (loads surfaced) -> priced (a cost captured) -> bid (>=1 bid placed) -> won / lost
 *
 * and the NON-participation set that 100% has to eat: skipped_no_price (surfaced, never priced),
 * dismissed (operator declined), no_bid / priced-but-never-bid (armed but the engine placed zero
 * bids). It segments every one of those by (a) hour-of-day IST of the pricing window (the price-
 * request created time) and the close time, (b) customer, and (c) close model where known - so the
 * after-hours-skip hypothesis (_research/2026-07-24_after-hours-voice-nudge-idea.md) can be answered
 * from data rather than asserted.
 *
 * READ-ONLY. This script issues no writes of its own - no writeFile/appendFile/rename/mkdir call
 * appears anywhere in this file - never calls any bidding path, and in --api mode never hits any
 * endpoint except the login POST (a GET-only read of what the box already exposes). It lives
 * entirely above the engine/pricing/platform layers. ONE NARROW EXCEPTION worth stating honestly:
 * in --data-dir mode, reads go through the app's OWN store seam (createStore -> FileStore.listDocs
 * -> readJSON in src/store/atomicFile.js), and that shared primitive's own crash-recovery behavior
 * renames a collection file to `<file>.corrupt.<ts>` if it fails to parse as JSON. That rename is
 * the store's pre-existing corrupt-file recovery, not a write this script asks for or could
 * disable without forking the app's one fs-touch-point (a deliberate architectural gate - see
 * atomicFile.js) - it only fires if a collection file was already corrupt on disk before this
 * script ran. --api mode makes no filesystem calls at all, so it cannot trigger this.
 *
 * TWO DATA MODES:
 *   --data-dir <path>   Read the store JSON docs through the app's OWN store modules (createStore +
 *                       PriceRequestStore + BidLogger + CustomerStore) - the reconcile-desk-owners.js
 *                       pattern, so it can run ON the box against data/.
 *   --api               Pull from a running box over HTTPS: POST /api/login (body {user,password}),
 *                       then GET /api/closed-bids and whichever /api/export/* endpoints exist. A
 *                       404 means the endpoint is genuinely absent on this release (e.g.
 *                       /api/export/summary 404s on the current release) and is tolerated - the
 *                       report states which sources actually fed the numbers. Any OTHER non-200
 *                       (401/403/5xx) or a network failure is treated as FATAL: the script throws
 *                       and exits non-zero naming the failed endpoint, rather than silently
 *                       degrading into a plausible-looking wrong report. If neither funnel source
 *                       is available (both legitimately 404), the report falls back to closed-
 *                       outcome history alone and explicitly renders participation/skipped/
 *                       dismissed as "n/a (no funnel spine)" - it never prints a fabricated number,
 *                       and in particular can never print 100% from a missing denominator.
 *
 * Credentials (--api) are read from the environment or a .env file ONLY and are NEVER printed:
 *   SP_BIDDER_BASE_URL, SP_BIDDER_BASIC_AUTH (nginx outer Basic layer), SP_BIDDER_USER,
 *   SP_BIDDER_PASSWORD (the app's inner operator login).
 *
 * OUTPUT: a plain-text/markdown report to stdout, or a machine-readable dump with --json.
 *
 * The participation status derivation mirrors src/web/exportModel.js deriveStatus() exactly (a
 * closed outcome wins; a funnel-only row carries its own status; a req marked 'closed' with no
 * outcome is surfaced as no_bid, never invented as a win/loss) so the two modes and the console's
 * own funnel export agree on every count.
 *
 * CUSTOMER AXIS. Both modes resolve every funnel row - including never-closed (skipped) loads - to
 * a canonical customer tag before grouping: --data-dir through the CustomerStore, --api by applying
 * the mapping the box already resolved on /api/closed-bids. Without that, only CLOSED loads would
 * carry a tag and a single real customer would split across two rows (canonical label for its won
 * loads, raw legal-name string for its skips), which inverts the per-customer skip read this report
 * exists to produce. Rows that still resolve to nothing are marked routed=no and called out in a
 * note under the table, because an unrouted variant is a routing gap, NOT a second customer.
 */

const fs = require('fs');
const { outcomeOf } = require('../src/util/closedOutcome');

// ============================================================================================
// PURE HELPERS (no IO - unit-tested by scripts/test-report-participation.js)
// ============================================================================================

const DAY_MS = 86_400_000;
const IST_OFFSET_MIN = 330; // Asia/Kolkata is a fixed UTC+05:30, no DST - arithmetic is exact.

/**
 * IST hour-of-day (0..23) for an epoch-ms instant, computed arithmetically so it is deterministic
 * and free of the ICU "24:00 at midnight" locale quirk that the codebase guards elsewhere
 * (csv.istTime). Returns null for a missing / non-finite value.
 */
function istHour(ms) {
  // Explicit null/empty guard FIRST: Number(null) and Number('') both coerce to 0, which would
  // otherwise slip past Number.isFinite and report a spurious 05:00 bucket.
  if (ms == null) return null;
  if (typeof ms === 'string' && ms.trim() === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const h = Math.floor((n + IST_OFFSET_MIN * 60_000) / 3_600_000) % 24;
  return h < 0 ? h + 24 : h; // guard pre-epoch inputs, though real data is always positive
}

/** IST "YYYY-MM-DD" for an instant (fixed +05:30), or '' when absent/invalid. */
function istDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return new Date(n + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** IST "HH:MM" for an instant, or '' when absent/invalid. */
function istHM(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return new Date(n + IST_OFFSET_MIN * 60_000).toISOString().slice(11, 16);
}

/**
 * Loose timestamp parse: accepts epoch-ms (number or numeric string), an ISO date string, or
 * ''/null. Returns epoch-ms or null. This is what both modes funnel every time field through
 * (the CSV exports emit ISO; the store holds epoch-ms).
 */
function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const p = Date.parse(s);
  if (!Number.isNaN(p)) return p;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A close time only counts for hour-bucketing when it is PLAUSIBLE - within a sane window around
 * now. SuperProcure stamps a year-2100 placeholder close time on some loads (documented gotcha:
 * project_brl-sp-placeholder-closetime-2100) that parses as a valid finite number and would
 * otherwise poison a close-time histogram. Out-of-range -> null (counted as undated, never bucketed).
 */
function plausibleTs(ms, now = Date.now()) {
  const n = parseTs(ms);
  if (n == null) return null;
  const lo = now - 3 * 365 * DAY_MS;
  const hi = now + 400 * DAY_MS;
  return n >= lo && n <= hi ? n : null;
}

function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

/**
 * Normalized lookup key for a raw platform company string. Case- and whitespace-insensitive so
 * "HAVELLS  INDIA LTD." and "Havells India Ltd." collapse to one key. Deliberately NOT a fuzzy
 * matcher: it only collapses noise, it never guesses that two DIFFERENT legal strings are the same
 * customer - that judgement belongs to the customer model, not to this read-only report.
 */
function normCompany(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

const OPEN_STATES = new Set(['awaiting_price', 'armed', 'stopped']);

const closedLikeOutcome = (c) => outcomeOf({ bidCount: c.numBids, won: c.won, closedWhileDown: c.closedWhileDown,
  finalRank: c.finalRank });

/**
 * Canonical per-load status from a price-request status + its optional closed-bid record.
 * Mirrors src/web/exportModel.js deriveStatus() exactly. `closed` here is the normalized
 * closedLike ({ numBids, won, ... }) or null.
 */
function deriveStatus(reqStatus, closed) {
  if (closed) return closedLikeOutcome(closed);
  if (!reqStatus) return 'unknown';
  return reqStatus === 'closed' ? 'no_bid' : reqStatus;
}

/**
 * Build the FUNNEL rows (participation spine) - one normalized row per discovered load, price-
 * requests LEFT JOIN closed-bids by loadId. This is the set that includes never-priced (skipped)
 * loads, which the closed-bids log alone can never show.
 *
 *   reqLikes: [{ loadId, company, customerLabel, status, createdAt, capturedAt, closesAt, softClose }]
 *   closedByLoad: Map<string, closedLike>
 */
function buildFunnelRows(reqLikes, closedByLoad) {
  return reqLikes.map((r) => {
    const c = closedByLoad.get(String(r.loadId)) || null;
    const status = deriveStatus(r.status, c);
    const closeModel = (c && c.closeModel)
      || (r.softClose === true ? 'soft' : (r.softClose === false ? 'hard' : '')) || '';
    // A resolved customer TAG and a raw platform company STRING are not the same axis, and mixing
    // them silently is how one real customer splits into two rows (its closed loads under the
    // friendly label, its skipped loads under the legal-name string) - which would corrupt the
    // per-customer skip rate this report exists to produce. Track which basis won so the table can
    // mark it and the reader can never mistake a routing gap for a second customer.
    const resolvedLabel = r.customerLabel || (c && c.customerLabel) || '';
    return {
      loadId: String(r.loadId),
      company: r.company || (c && c.company) || '',
      customer: resolvedLabel || r.company || (c && c.company) || 'Unknown',
      customerResolved: Boolean(resolvedLabel),
      status,
      participated: r.capturedAt != null, // a cost was captured (priced)
      anyBid: c ? c.numBids > 0 : null,
      won: c ? !!c.won : null,
      finalRank: c && c.finalRank != null ? c.finalRank : null,
      createdAt: parseTs(r.createdAt),          // pricing-window open (alert fired)
      auctionCloseAt: (c && parseTs(c.closedAt)) || parseTs(r.closesAt) || null,
      closeModel,
    };
  });
}

/** Build the OUTCOME rows - one normalized row per closed auction (full history, never pruned). */
function buildOutcomeRows(closedLikes) {
  return closedLikes.map((c) => {
    const n = c.numBids || 0;
    const status = closedLikeOutcome(c);
    return {
      loadId: String(c.loadId),
      company: c.company || '',
      customer: c.customerLabel || c.company || 'Unknown',
      customerResolved: Boolean(c.customerLabel),
      status,
      participated: true, // every closed record was armed, i.e. a cost was captured
      anyBid: n > 0,
      won: !!c.won,
      finalRank: c.finalRank != null ? c.finalRank : null,
      createdAt: null,
      auctionCloseAt: parseTs(c.closedAt),
      closeModel: c.closeModel || '',
    };
  });
}

/**
 * Overall funnel counters off normalized funnel rows.
 *
 * `spineIsOutcomesOnly` marks a run where the funnel spine had to fall back to closed-outcome
 * history alone (see loadFromApi's `if (!reqLikes)` branch) - i.e. every row in `rows` is a closed
 * auction and none of the true funnel surface (never-closed / skipped / dismissed loads) is
 * visible. In that mode `priced`, `skipped`, `dismissed`, `pricedNoBid` and `participationPct`
 * are NOT knowable from this data (the denominator itself is wrong - it can only ever equal the
 * priced count, which is why an unmarked fallback used to read a tautological 100%) and are
 * reported as `null` so the formatter renders "n/a" instead of a number that looks measured but
 * isn't. `bid`/`won`/`lost`/`noBid` stay real: they come straight off each row's closed-bid join
 * (anyBid/won/lost), which IS accurate even in outcomes-only mode.
 */
function summarizeFunnel(rows, opts) {
  const spineIsOutcomesOnly = !!(opts && opts.spineIsOutcomesOnly);
  let priced = 0, bid = 0, won = 0, lost = 0, noBid = 0, skipped = 0, dismissed = 0, open = 0, pricedNoBid = 0, unknown = 0;
  // Kept SEPARATE from `unknown`, which means "the request carried no status at all" - a data gap.
  // This one is an auction we really did bid and whose end we never saw. Folding them together would
  // make the report unable to tell a missing record from a retired one.
  let closedUnknown = 0;
  for (const r of rows) {
    if (r.participated) priced += 1;
    if (r.anyBid === true) bid += 1;
    switch (r.status) {
      case 'won': won += 1; break;
      case 'lost': lost += 1; break;
      case 'no_bid': noBid += 1; break;
      case 'skipped_no_price': skipped += 1; break;
      case 'dismissed': dismissed += 1; break;
      case 'closed_unknown': closedUnknown += 1; break;
      case 'unknown': unknown += 1; break;
      default: if (OPEN_STATES.has(r.status)) open += 1; break;
    }
    if (r.participated && r.status === 'no_bid') pricedNoBid += 1; // priced but engine placed 0 bids
  }
  const inquiries = rows.length;
  const decided = won + lost;
  return {
    inquiries,
    priced: spineIsOutcomesOnly ? null : priced,
    bid, won, lost, noBid,
    skipped: spineIsOutcomesOnly ? null : skipped,
    dismissed: spineIsOutcomesOnly ? null : dismissed,
    open,
    pricedNoBid: spineIsOutcomesOnly ? null : pricedNoBid,
    closedUnknown, unknown, decided,
    spineIsOutcomesOnly,
    participationPct: spineIsOutcomesOnly ? null : pct(priced, inquiries),
    bidPct: pct(bid, inquiries),
    winPct: pct(won, decided),
  };
}

/** Roll-up over closed outcome rows (won / lost / unknown / no_bid, full history). */
function summarizeOutcomes(rows) {
  let won = 0, lost = 0, noBid = 0, closedUnknown = 0;
  for (const r of rows) {
    if (r.status === 'won') won += 1;
    else if (r.status === 'lost') lost += 1;
    else if (r.status === 'no_bid') noBid += 1;
    // Counted in `total` either way; without its own tally the four printed numbers cannot be
    // reconciled against `total` and the reader has no way to see where the difference went.
    else if (r.status === 'closed_unknown') closedUnknown += 1;
  }
  const total = rows.length;
  return { total, won, lost, noBid, closedUnknown, winPct: pct(won, won + lost), bidRatePct: pct(total - noBid, total) };
}

/**
 * Histogram of rows by IST hour of a chosen timestamp field. `field` is 'createdAt' (pricing
 * window) or 'auctionCloseAt' (close time). Close times are plausibility-bounded; createdAt is
 * taken as-is (always a real event time). Returns 24 buckets + an undated count.
 */
function segmentByHour(rows, field, now = Date.now()) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour, total: 0, priced: 0, skipped: 0, noBid: 0, dismissed: 0, won: 0, lost: 0,
  }));
  let undated = 0;
  for (const r of rows) {
    const ts = field === 'auctionCloseAt' ? plausibleTs(r.auctionCloseAt, now) : r[field];
    const h = istHour(ts);
    if (h == null) { undated += 1; continue; }
    const b = buckets[h];
    b.total += 1;
    if (r.participated) b.priced += 1;
    if (r.status === 'skipped_no_price') b.skipped += 1;
    if (r.status === 'no_bid') b.noBid += 1;
    if (r.status === 'dismissed') b.dismissed += 1;
    if (r.status === 'won') b.won += 1;
    if (r.status === 'lost') b.lost += 1;
  }
  return { buckets, undated };
}

/**
 * Business-hours vs after-hours split on a timestamp field. Business = 09:00-17:59 IST inclusive;
 * after-hours = 18:00-08:59 (the "6 p.m. onwards" boundary in the after-hours-nudge idea). Reports
 * each band's inquiries / priced / skipped and the participation + skip rates, so the hypothesis
 * "the skip rate spikes after ~6pm" is answered numerically.
 */
function dayPartSplit(rows, field, now = Date.now()) {
  const mk = () => ({ total: 0, priced: 0, skipped: 0, notPriced: 0 });
  const band = { business: mk(), afterHours: mk() };
  let undated = 0;
  for (const r of rows) {
    const ts = field === 'auctionCloseAt' ? plausibleTs(r.auctionCloseAt, now) : r[field];
    const h = istHour(ts);
    if (h == null) { undated += 1; continue; }
    const key = (h >= 9 && h < 18) ? 'business' : 'afterHours';
    const b = band[key];
    b.total += 1;
    if (r.participated) b.priced += 1; else b.notPriced += 1;
    if (r.status === 'skipped_no_price') b.skipped += 1;
  }
  const decorate = (b) => Object.assign(b, {
    participationPct: pct(b.priced, b.total),
    skipRatePct: pct(b.skipped, b.total),
  });
  decorate(band.business);
  decorate(band.afterHours);
  band.undated = undated;
  return band;
}

/** Group funnel rows by a key function, with per-group participation counters. Sorted by inquiries desc. */
function segmentBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r) || 'Unknown';
    let g = groups.get(key);
    if (!g) {
      g = {
        key, inquiries: 0, priced: 0, bid: 0, won: 0, lost: 0, noBid: 0, skipped: 0, dismissed: 0,
        closedUnknown: 0,
        resolved: 0, soft: 0, softPriced: 0, hard: 0, hardPriced: 0,
      };
      groups.set(key, g);
    }
    g.inquiries += 1;
    if (r.participated) g.priced += 1;
    if (r.anyBid === true) g.bid += 1;
    if (r.status === 'won') g.won += 1;
    if (r.status === 'lost') g.lost += 1;
    if (r.status === 'no_bid') g.noBid += 1;
    if (r.status === 'skipped_no_price') g.skipped += 1;
    if (r.status === 'dismissed') g.dismissed += 1;
    if (r.status === 'closed_unknown') g.closedUnknown += 1;
    if (r.customerResolved) g.resolved += 1;
    // Close-model split WITHIN the group: a customer can sit near 100% overall and still be near
    // 0% on its soft-close lane, and that lane is invisible in a single blended participation%.
    if (r.closeModel === 'soft') { g.soft += 1; if (r.participated) g.softPriced += 1; }
    else if (r.closeModel === 'hard') { g.hard += 1; if (r.participated) g.hardPriced += 1; }
  }
  const out = [...groups.values()].map((g) => Object.assign(g, {
    participationPct: pct(g.priced, g.inquiries),
    winPct: pct(g.won, g.won + g.lost),
    softPct: pct(g.softPriced, g.soft),
    hardPct: pct(g.hardPriced, g.hard),
    // yes = every load carried a resolved customer tag; no = none did (the key is a RAW platform
    // company string); partial = the group mixes both, which is itself a routing defect worth seeing.
    routed: g.resolved === g.inquiries ? 'yes' : (g.resolved === 0 ? 'no' : 'partial'),
  }));
  out.sort((a, b) => b.inquiries - a.inquiries || String(a.key).localeCompare(String(b.key)));
  return out;
}

function segmentByCustomer(rows) { return segmentBy(rows, (r) => r.customer); }
function segmentByCloseModel(rows) { return segmentBy(rows, (r) => r.closeModel || 'unknown'); }

/**
 * The whole participation model, computed from the two normalized row sets. Pure - this is the
 * single function the report + the --json dump + the test all read from.
 */
function buildModel({ funnelRows, outcomeRows, provenance, now = Date.now() }) {
  const spineIsOutcomesOnly = !!(provenance && provenance.spineIsOutcomesOnly);
  return {
    generatedAt: now,
    provenance: provenance || {},
    funnel: summarizeFunnel(funnelRows, { spineIsOutcomesOnly }),
    outcomes: summarizeOutcomes(outcomeRows),
    byHourPricing: segmentByHour(funnelRows, 'createdAt', now),
    byHourClose: segmentByHour(funnelRows, 'auctionCloseAt', now),
    dayPartPricing: dayPartSplit(funnelRows, 'createdAt', now),
    dayPartClose: dayPartSplit(funnelRows, 'auctionCloseAt', now),
    byCustomer: segmentByCustomer(funnelRows),
    byCloseModel: segmentByCloseModel(funnelRows),
    counts: { funnelRows: funnelRows.length, outcomeRows: outcomeRows.length },
  };
}

// ============================================================================================
// REPORT FORMATTING (pure string work)
// ============================================================================================

function padR(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function formatReport(m) {
  const L = [];
  const f = m.funnel;
  L.push('# SP auto-bidder - participation report');
  L.push('');
  L.push(`Generated: ${istDate(m.generatedAt)} ${istHM(m.generatedAt)} IST`);
  L.push('');

  // ---- provenance ----
  L.push('## Sources');
  const p = m.provenance || {};
  L.push(`- Mode: ${p.mode || 'unknown'}`);
  if (p.sources && p.sources.length) {
    for (const s of p.sources) L.push(`  - ${s}`);
  }
  L.push(`- Funnel spine rows (participation, incl. skipped): ${m.counts.funnelRows}`);
  L.push(`- Closed outcome rows (won/lost history): ${m.counts.outcomeRows}`);
  if (p.notes && p.notes.length) for (const n of p.notes) L.push(`- Note: ${n}`);
  L.push('');

  // ---- headline funnel ----
  L.push('## Participation funnel (spine = discovered loads)');
  L.push('');
  if (f.spineIsOutcomesOnly) {
    L.push('**NO FUNNEL SPINE THIS RUN.** No price-request/funnel export was readable from the box, so');
    L.push('this funnel is built from CLOSED-OUTCOME history only. "inquiries" below therefore counts');
    L.push('CLOSED auctions, not true surfaced loads - never-closed, skipped, and dismissed loads are');
    L.push('invisible to this run. Participation cannot be computed from this data and is reported as');
    L.push('n/a, never as a number - do NOT read this run as a participation measurement.');
    L.push('');
  }
  L.push('```');
  L.push(`inquiries (surfaced)        ${padL(f.inquiries, 6)}`);
  L.push(`  -> priced (cost captured) ${padL(f.priced == null ? 'n/a' : f.priced, 6)}   ${f.participationPct == null ? 'n/a (no funnel spine)' : `${f.participationPct}% of inquiries`}`);
  L.push(`  -> bid (>=1 bid placed)   ${padL(f.bid, 6)}   ${f.bidPct}% of inquiries`);
  L.push(`       -> won              ${padL(f.won, 6)}   ${f.winPct}% of decided (won+lost=${f.decided})`);
  L.push(`       -> lost             ${padL(f.lost, 6)}`);
  // Printed as a THIRD child of `bid` so the three sum to it. Without this line these rows are
  // counted in `bid` and appear on no line beneath it, so the block silently fails to add up and
  // the reader has no way to see where the missing auctions went.
  L.push(`       -> unknown          ${padL(f.closedUnknown, 6)}   auction ended while we were not watching`);
  L.push('```');
  L.push('');
  L.push('Non-participation set (the gap 100% has to close):');
  L.push(`- skipped_no_price (surfaced, never priced): ${f.skipped == null ? 'n/a (no funnel spine)' : f.skipped}`);
  L.push(`- dismissed (operator declined):             ${f.dismissed == null ? 'n/a (no funnel spine)' : f.dismissed}`);
  L.push(`- no_bid (armed/priced but 0 bids placed):   ${f.noBid}  (of which priced-but-never-bid: ${f.pricedNoBid == null ? 'n/a' : f.pricedNoBid})`);
  if (f.open) L.push(`- still open (awaiting_price/armed/stopped, not yet terminal): ${f.open}`);
  if (f.unknown) L.push(`- unknown status: ${f.unknown}`);
  L.push('');
  L.push('_Funnel window is rolling (~7 days): the price-request store is pruned after close, so the');
  L.push('spine is the current window, not lifetime. The closed-outcome history below is complete._');
  L.push('');

  // ---- outcome history ----
  const o = m.outcomes;
  L.push('## Closed-outcome history (complete, never pruned)');
  L.push('');
  L.push(`- closed auctions: ${o.total}`);
  L.push(`- won / lost / unknown / no_bid: ${o.won} / ${o.lost} / ${o.closedUnknown} / ${o.noBid}`);
  L.push('- unknown = we bid, and the auction ended while we were not watching it.');
  L.push(`- win rate (of decided): ${o.winPct}%`);
  L.push(`- bid rate (>=1 bid): ${o.bidRatePct}%`);
  L.push('');

  // ---- hour-of-day (pricing window) ----
  L.push('## By hour-of-day IST - pricing window (price-request created)');
  L.push('_This is the after-hours test: when the alert fired, was the load priced or skipped?_');
  L.push('');
  L.push(hourTable(m.byHourPricing));
  L.push('');
  L.push(dayPartLines('Pricing-window', m.dayPartPricing));
  L.push('');

  // ---- hour-of-day (close time) ----
  L.push('## By hour-of-day IST - close time (secondary)');
  L.push('');
  if (f.spineIsOutcomesOnly) {
    L.push('_No funnel spine this run (see banner above) - the `priced`/`part%` columns below read 0'
      + ' because every row here is a closed load with no known capturedAt, NOT because nothing was'
      + ' priced. Read `total`/`skipped` only; ignore `priced`/`part%` in this table._');
    L.push('');
  }
  L.push(hourTable(m.byHourClose));
  L.push('');
  L.push(dayPartLines('Close-time', m.dayPartClose));
  L.push('');

  // ---- by customer ----
  L.push('## By customer');
  L.push('');
  if (f.spineIsOutcomesOnly) {
    L.push('_No funnel spine this run (see banner above) - `priced`/`part%`/`soft`/`hard` lane % columns'
      + ' below read 0 because every row is a closed load with no known capturedAt, NOT because nothing'
      + ' was priced. Read `inq`/`won`/`lost`/`win%` only; ignore the priced/participation columns._');
    L.push('');
  }
  L.push(customerTable(m.byCustomer));
  L.push('');
  L.push(customerCaveatLines(m.byCustomer));
  L.push('');

  // ---- by close model ----
  L.push('## By close model');
  L.push('');
  if (f.spineIsOutcomesOnly) {
    L.push('_No funnel spine this run (see banner above) - `priced`/`part%` columns below read 0 because'
      + ' every row is a closed load with no known capturedAt, NOT because nothing was priced. Read'
      + ' `inq`/`won`/`lost`/`win%` only; ignore the priced/participation columns._');
    L.push('');
  }
  L.push(closeModelTable(m.byCloseModel));
  L.push('');

  return L.join('\n');
}

function hourTable(seg) {
  const rows = [];
  rows.push(`${padR('hour', 6)}${padL('total', 7)}${padL('priced', 8)}${padL('skipped', 9)}${padL('part%', 8)}${padL('skip%', 8)}`);
  rows.push('-'.repeat(46));
  for (const b of seg.buckets) {
    if (b.total === 0) continue;
    rows.push(
      padR(`${padL(b.hour, 2)}:00`, 6)
      + padL(b.total, 7) + padL(b.priced, 8) + padL(b.skipped, 9)
      + padL(pct(b.priced, b.total), 8) + padL(pct(b.skipped, b.total), 8),
    );
  }
  if (seg.undated) rows.push(`(undated/out-of-range excluded: ${seg.undated})`);
  return '```\n' + rows.join('\n') + '\n```';
}

// A band with zero (or too few) rows collapses `skipRatePct` to 0 via pct()'s zero-denominator
// rule - numerically indistinguishable from a real 0% skip rate over a real sample. Below this
// floor, a directional verdict cannot be honest (it can be produced entirely by an empty band), so
// dayPartLines refuses to assert a direction and reports the counts instead.
const MIN_DAYPART_N = 10;

function dayPartLines(label, band) {
  const b = band.business, a = band.afterHours;
  let verdict;
  if (b.total < MIN_DAYPART_N || a.total < MIN_DAYPART_N) {
    verdict = `insufficient data (N=${b.total} business / N=${a.total} after-hours, need >= ${MIN_DAYPART_N} per band) - no read`;
  } else {
    verdict = a.skipRatePct > b.skipRatePct
      ? `after-hours skip rate is HIGHER (${a.skipRatePct}% vs ${b.skipRatePct}%) -> supports the after-hours hypothesis`
      : (a.skipRatePct < b.skipRatePct
        ? `after-hours skip rate is LOWER (${a.skipRatePct}% vs ${b.skipRatePct}%) -> does NOT support the after-hours hypothesis`
        : `after-hours and business skip rates are EQUAL (${a.skipRatePct}%) -> inconclusive`);
  }
  return [
    `${label} business vs after-hours (business = 09:00-17:59 IST):`,
    '```',
    `business    total ${padL(b.total, 5)}  priced ${padL(b.priced, 5)}  skipped ${padL(b.skipped, 5)}  part% ${padL(b.participationPct, 6)}  skip% ${padL(b.skipRatePct, 6)}`,
    `after-hours total ${padL(a.total, 5)}  priced ${padL(a.priced, 5)}  skipped ${padL(a.skipped, 5)}  part% ${padL(a.participationPct, 6)}  skip% ${padL(a.skipRatePct, 6)}`,
    '```',
    `Verdict: ${verdict}.`,
  ].join('\n');
}

function customerTable(seg) {
  const rows = [];
  rows.push(
    `${padR('customer', 26)}${padL('inq', 5)}${padL('priced', 7)}${padL('bid', 5)}${padL('won', 5)}`
    + `${padL('lost', 6)}${padL('unknown', 9)}${padL('skip', 6)}${padL('part%', 7)}${padL('win%', 7)}`
    + `${padL('soft', 6)}${padL('softP%', 8)}${padL('hard', 6)}${padL('hardP%', 8)}${padL('routed', 8)}`,
  );
  rows.push('-'.repeat(119));
  for (const g of seg) {
    rows.push(
      padR(String(g.key).slice(0, 25), 26)
      + padL(g.inquiries, 5) + padL(g.priced, 7) + padL(g.bid, 5) + padL(g.won, 5)
      + padL(g.lost, 6) + padL(g.closedUnknown, 9) + padL(g.skipped, 6) + padL(g.participationPct, 7) + padL(g.winPct, 7)
      + padL(g.soft, 6) + padL(g.soft ? g.softPct : '-', 8)
      + padL(g.hard, 6) + padL(g.hard ? g.hardPct : '-', 8)
      + padL(g.routed, 8),
    );
  }
  return '```\n' + rows.join('\n') + '\n```';
}

/**
 * The misread-guard for the by-customer table. Two distinct traps live in that table and both
 * produce a confidently wrong conclusion if unstated: (1) an unrouted row is keyed by a RAW
 * platform company string, so the SAME real customer can appear twice - once under its canonical
 * tag and once under a legal-name variant - and reading those as two customers points the fix at
 * the wrong place; (2) a blended participation% hides a customer whose soft-close lane is a
 * near-total hole. State both, with the live counts, every run.
 */
function customerCaveatLines(seg) {
  const unrouted = seg.filter((g) => g.routed === 'no');
  const partial = seg.filter((g) => g.routed === 'partial');
  const unroutedInq = unrouted.reduce((s, g) => s + g.inquiries, 0);
  const unroutedSkips = unrouted.reduce((s, g) => s + g.skipped, 0);
  const totalInq = seg.reduce((s, g) => s + g.inquiries, 0);
  const L = [];
  L.push('How to read this table (both traps below produce a wrong conclusion if ignored):');
  L.push('');
  L.push('- `routed` = did the row resolve to a canonical customer tag? `yes` = every load did;'
    + ' `no` = none did, so the row key is the RAW platform company string; `partial` = the row'
    + ' mixes both bases and should be treated as a routing defect in its own right.');
  L.push(`- **A \`routed=no\` row is not proof of a different customer.** An unmapped legal-name`
    + ` variant is usually the SAME customer as its short-name sibling, seen through a company`
    + ` string nothing has mapped yet. Read those two rows as one customer with a routing gap, not`
    + ` as two customers. Here: ${unrouted.length} of ${seg.length} rows unrouted`
    + ` (${unroutedInq} of ${totalInq} inquiries, carrying ${unroutedSkips}`
    + ` skip${unroutedSkips === 1 ? '' : 's'})`
    + `${partial.length ? `; ${partial.length} row(s) partial` : ''}.`);
  L.push('- `soft`/`hard` split the same inquiries by close model; `softP%`/`hardP%` are'
    + ' participation within each lane. A customer can read near-100% overall and still be near-0%'
    + ' on soft-close, so check the lane before concluding a customer is covered.');
  return L.join('\n');
}

function closeModelTable(seg) {
  const rows = [];
  // `unknown` here is a COLUMN COUNT, not the row key of the same name: a row keyed 'unknown' is a
  // load whose CLOSE MODEL was never recorded, while this column is auctions whose OUTCOME was never
  // seen. Unrelated facts that happen to share a word - read the column header, not the row label.
  rows.push(`${padR('closeModel', 14)}${padL('inq', 5)}${padL('priced', 8)}${padL('bid', 5)}${padL('won', 5)}${padL('lost', 6)}${padL('unknown', 9)}${padL('part%', 7)}${padL('win%', 7)}`);
  rows.push('-'.repeat(66));
  for (const g of seg) {
    rows.push(
      padR(String(g.key), 14)
      + padL(g.inquiries, 5) + padL(g.priced, 8) + padL(g.bid, 5) + padL(g.won, 5)
      + padL(g.lost, 6) + padL(g.closedUnknown, 9) + padL(g.participationPct, 7) + padL(g.winPct, 7),
    );
  }
  return '```\n' + rows.join('\n') + '\n```';
}

// ============================================================================================
// CSV parsing (RFC-4180, matching src/web/csv.js output)
// ============================================================================================

/** Parse CSV text into an array of records (arrays of string cells). Handles quotes + "" escapes. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQ = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else { inQ = false; }
      } else { field += ch; }
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || record.length) { record.push(field); rows.push(record); }
  // csv.js text-forces a leading formula trigger with a "'"; strip it back off for our reads.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** CSV text -> array of {header: cell} objects. */
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.replace(/^'/, ''));
  return rows.slice(1).map((cells) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (cells[i] != null ? cells[i] : '').replace(/^'/, ''); });
    return o;
  });
}

// ============================================================================================
// DATA-DIR MODE (read the store through the app's own modules)
// ============================================================================================

async function loadFromDataDir(dataDir) {
  // Lazy-require the heavy app modules so the pure functions above (and the test that imports
  // them) never pull in the store/adapter dependency chain.
  const { createStore } = require('../src/store');
  const { PriceRequestStore, platformOf } = require('../src/pricing/priceRequests');
  const { BidLogger } = require('../src/logging/bidLogger');

  const store = createStore({ dataDir });
  const requests = new PriceRequestStore({ store, marginsPct: [], minMarginPct: 0 });
  const bidLogger = new BidLogger({ store });

  // Customer resolution mirrors server.js customerTagFor: match the raw companyName against the
  // CustomerStore snapshot. Best-effort - if the model isn't present we fall back to companyName.
  let matchCustomer = null; let customers = [];
  try {
    const { CustomerStore } = require('../src/model/customerStore');
    ({ matchCustomer } = require('../src/model/resolve'));
    customers = await new CustomerStore({ store }).list();
  } catch (e) { /* no model wired - segment by raw company */ }
  const tagFor = (companyName) => {
    if (!matchCustomer || !companyName) return null;
    const c = matchCustomer(companyName, customers);
    return c ? c.label : null;
  };

  const reqs = await requests.listAll();
  const closed = await bidLogger.listClosed({});

  const reqLikes = reqs.map((r) => {
    const load = r.load || {};
    return {
      loadId: r.loadId,
      platform: platformOf(r),
      company: load.companyName || '',
      customerLabel: (r.customer && r.customer.label) || tagFor(load.companyName),
      status: r.status,
      createdAt: r.createdAt,
      capturedAt: r.capturedAt,
      closesAt: load.closesAt,
      softClose: load.softClose,
    };
  });
  const closedLikes = closed.map((c) => ({
    loadId: String(c.auctionId),
    platform: platformOf(c),
    company: c.shipper || '',
    customerLabel: (c.customer && c.customer.label) || tagFor(c.shipper),
    numBids: Array.isArray(c.ourBids) ? c.ourBids.length : 0,
    won: c.won === null ? null : !!c.won,
    finalRank: c.finalRank,
    closedWhileDown: c.closedWhileDown === true,
    closeModel: c.closeModel || null,
    closedAt: c.closedAt,
  }));

  const provenance = {
    mode: 'data-dir',
    sources: [
      `store priceRequests collection: ${reqLikes.length} docs (funnel spine, rolling ~7d)`,
      `store closedBids collection: ${closedLikes.length} closed docs (outcome history)`,
      `dataDir: ${dataDir}`,
    ],
    notes: [],
  };
  return { reqLikes, closedLikes, provenance };
}

// ============================================================================================
// API MODE (GET-only read of a running box; login is the only POST)
// ============================================================================================

function loadEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Resolve SP_BIDDER_* from process.env first, then an optional env file (never printed). */
function resolveCreds(envFile) {
  const fromFile = envFile ? loadEnvFile(envFile) : {};
  const get = (k) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : fromFile[k]);
  return {
    baseUrl: get('SP_BIDDER_BASE_URL'),
    basicAuth: get('SP_BIDDER_BASIC_AUTH'),
    user: get('SP_BIDDER_USER'),
    password: get('SP_BIDDER_PASSWORD'),
  };
}

/** "user:pass" -> base64; an already-encoded value (no colon) passes through. Never logged. */
function basicHeader(basicAuth) {
  if (!basicAuth) return null;
  const v = String(basicAuth);
  const enc = v.includes(':') ? Buffer.from(v, 'utf8').toString('base64') : v;
  return `Basic ${enc}`;
}

function httpRequest(method, urlStr, { headers = {}, body = null } = {}) {
  const https = require('https');
  const http = require('http');
  const u = new URL(urlStr);
  const lib = u.protocol === 'http:' ? http : https;
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    headers: Object.assign({}, headers),
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(new Error('request timeout')); });
    if (body != null) req.write(body);
    req.end();
  });
}

async function loadFromApi(creds) {
  if (!creds.baseUrl) throw new Error('SP_BIDDER_BASE_URL is not set (env or --env-file).');
  const base = creds.baseUrl.replace(/\/+$/, '');
  const u = new URL(base);
  const origin = `${u.protocol}//${u.host}`;
  const basic = basicHeader(creds.basicAuth);
  const baseHeaders = {};
  if (basic) baseHeaders.Authorization = basic;

  const sources = [];
  const notes = [];

  // ---- login (the only POST) - carries a same-host Origin for the CSRF guard ----
  let cookie = null;
  const loginRes = await httpRequest('POST', `${base}/api/login`, {
    headers: Object.assign({}, baseHeaders, { 'Content-Type': 'application/json', Origin: origin }),
    body: JSON.stringify({ user: creds.user || '', password: creds.password || '' }),
  });
  if (loginRes.status === 200) {
    const setCookie = loginRes.headers['set-cookie'];
    if (Array.isArray(setCookie) && setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    let authRequired = true;
    try { authRequired = JSON.parse(loginRes.text).authRequired !== false; } catch (e) { /* keep default */ }
    sources.push(`POST /api/login -> 200 (${cookie ? 'session cookie set' : (authRequired ? 'no cookie returned' : 'auth-off box')})`);
  } else {
    // Do not print bodies that could echo an error containing sensitive context; status only.
    throw new Error(`login failed: HTTP ${loginRes.status} (check SP_BIDDER_USER/PASSWORD/BASIC_AUTH/BASE_URL)`);
  }
  const getHeaders = Object.assign({}, baseHeaders);
  if (cookie) getHeaders.Cookie = cookie;

  // 404 is the ONLY status this script tolerates as "endpoint absent on this release" and falls
  // through on - that is the case the (skipped) path was written for. Every other non-200
  // (401/403/5xx, or anything else unexpected) means the endpoint IS there but the call FAILED -
  // an expired session, a box hiccup, an internal error - and is indistinguishable from "absent"
  // only if we let it be. Treating it as fatal (throw, non-zero exit, name the endpoint) is what
  // stops a transient failure from silently degrading into a fabricated report; see loadFromApi's
  // `if (!reqLikes)` fallback, which now only triggers on a genuine double-404. A network-level
  // failure (DNS, connection refused, timeout) already rejects out of httpRequest() and is fatal
  // by the same mechanism - it is never caught here.
  const failIfNotTolerable = (pathPart, status) => {
    if (status === 404) return true; // tolerate: caller returns null and falls through
    throw new Error(`GET ${pathPart} -> HTTP ${status}: endpoint failed, not absent (not a 404) - `
      + 'refusing to report on a possibly-incomplete pull. Check the box/session and re-run.');
  };
  const getJson = async (pathPart, label) => {
    const res = await httpRequest('GET', `${base}${pathPart}`, { headers: getHeaders });
    if (res.status !== 200) {
      failIfNotTolerable(pathPart, res.status);
      sources.push(`GET ${pathPart} -> 404 (endpoint absent, skipped)`);
      return null;
    }
    try { const j = JSON.parse(res.text); sources.push(`GET ${pathPart} -> 200`); return j; }
    catch (e) { sources.push(`GET ${pathPart} -> 200 but unparseable JSON (skipped)`); return null; }
  };
  const getCsv = async (pathPart) => {
    const res = await httpRequest('GET', `${base}${pathPart}`, { headers: getHeaders });
    if (res.status !== 200) {
      failIfNotTolerable(pathPart, res.status);
      sources.push(`GET ${pathPart} -> 404 (endpoint absent, skipped)`);
      return null;
    }
    const objs = parseCsvObjects(res.text);
    sources.push(`GET ${pathPart} -> 200 (${objs.length} rows)`);
    return objs;
  };

  // ---- closed-bids: full outcome history (JSON; present on every release) ----
  const closedJson = await getJson('/api/closed-bids', 'closed-bids');
  const closedRows = closedJson && Array.isArray(closedJson.closedBids) ? closedJson.closedBids : [];
  const closedLikes = closedRows.map((c) => ({
    loadId: String(c.auctionId),
    // Both API sources are ALL-PORTAL and self-label: /api/closed-bids carries platformKey per row
    // and price-requests.csv carries a `platform` column. That is what keeps this join coherent -
    // the alternative the exporters used to present, an all-portal outcome list joined to an
    // SP-only funnel spine, silently divides a participation percentage by the wrong denominator.
    // The scope is applied ONCE, in main(), so both sides are narrowed by the same key.
    platform: c.platformKey || 'sp',
    company: c.shipper || '',
    customerLabel: (c.customer && c.customer.label) || null,
    numBids: Array.isArray(c.ourBids) ? c.ourBids.length : 0,
    won: c.won === null ? null : !!c.won,
    finalRank: c.finalRank,
    closedWhileDown: c.closedWhileDown === true,
    closeModel: c.closeModel || null,
    closedAt: c.closedAt,
  }));
  const closedByLoad = new Map(closedLikes.map((c) => [c.loadId, c]));

  // ---- customer-tag resolution for the funnel spine ----
  // The price-requests export carries no resolved customer tag, so on its own a funnel row could
  // only ever get one from the closed join. That asymmetry is a trap: a load that CLOSED resolves
  // to the box's friendly label while its never-closed sibling - the skips, i.e. exactly the rows
  // this report exists to count - falls back to the raw platform company string. One real customer
  // then splits across two table rows with its participation divided between them, and the
  // per-customer skip rate reads wrong in the direction that matters. Fix: borrow the mapping the
  // box ALREADY resolved on /api/closed-bids and apply it to every row, so one customer is one row
  // here just as it is in --data-dir mode (which resolves everything through tagFor()).
  const labelByCompany = new Map();
  for (const c of closedLikes) {
    const key = normCompany(c.company);
    if (key && c.customerLabel && !labelByCompany.has(key)) labelByCompany.set(key, c.customerLabel);
  }
  const labelFor = (company) => labelByCompany.get(normCompany(company)) || null;

  // ---- funnel spine: prefer price-requests.csv (has createdAt = pricing window). Fall back to
  //      the newer funnel.csv (has Status/Participated but no createdAt) when the box lacks it. ----
  let reqLikes = null;
  const prCsv = await getCsv('/api/export/price-requests.csv');
  if (prCsv) {
    reqLikes = prCsv.map((r) => ({
      loadId: r.loadId,
      platform: r.platform || 'sp',
      company: r.shipper || '',
      // The exporter emits no customer tag, so resolve it off the closed-bids mapping above rather
      // than leaving it null and letting buildFunnelRows fall back to the raw string per-row.
      customerLabel: labelFor(r.shipper),
      status: r.status,
      createdAt: r.createdAt,
      capturedAt: r.capturedAt || null,
      closesAt: r.closesAt || null,
      softClose: r.softClose === 'true' ? true : (r.softClose === 'false' ? false : null),
    }));
  } else {
    const funnelCsv = await getCsv('/api/export/funnel?format=csv');
    if (funnelCsv) {
      notes.push('price-requests export absent; used funnel.csv - it has no price-request created time, so the pricing-window (createdAt) hour analysis is empty and the close-time hour analysis carries the after-hours read instead.');
      reqLikes = funnelCsv.map((r) => {
        const closeIso = r['Auction Date'] && r['Auction Time'] ? `${r['Auction Date']}T${r['Auction Time']}:00+05:30` : '';
        const participated = String(r['Participated (Y/N)']).toUpperCase() === 'Y';
        return {
          loadId: r['Load Id'],
          platform: r.Platform || 'sp',
          company: r.Customer || '',
          customerLabel: labelFor(r.Customer) || r.Customer || null,
          status: r.Status,
          createdAt: null,
          capturedAt: participated ? (parseTs(r['Priced At']) || 1) : null, // Y/N only; value is a marker
          closesAt: parseTs(closeIso),
          softClose: (r['Close Model'] || '').toLowerCase() === 'soft' ? true : ((r['Close Model'] || '').toLowerCase() === 'hard' ? false : null),
        };
      });
    }
  }

  // Both funnel sources were legitimately absent (double-404, not a call failure - a call failure
  // already threw above via failIfNotTolerable). There is no funnel spine at all: fall back to
  // closed-outcome history so the report is still produced, but the fallback rows carry NO
  // capturedAt (never a synthesized `1`) - this data source structurally cannot know which loads
  // were ever priced, only which closed. `spineIsOutcomesOnly` tells buildModel/summarizeFunnel to
  // render participation/skipped/dismissed as "n/a", never as a number - the report must be
  // incapable of printing a participation percentage, let alone 100%, from a missing denominator.
  let spineIsOutcomesOnly = false;
  if (!reqLikes) {
    spineIsOutcomesOnly = true;
    notes.push('NO funnel/price-request export available on this box (both price-requests.csv and '
      + 'funnel.csv are absent - genuinely 404, not a failed call); the funnel spine falls back to '
      + 'closed-outcome history only. Skipped/never-priced/dismissed loads are NOT visible in this '
      + 'run and participation cannot be computed - reported as n/a, not as a number.');
    // The outcomes-only fallback spine inherits each row's own portal from closedLikes above.
    reqLikes = closedLikes.map((c) => ({
      loadId: c.loadId, platform: c.platform, company: c.company, customerLabel: c.customerLabel,
      status: 'closed', createdAt: null, capturedAt: null, closesAt: c.closedAt,
      softClose: c.closeModel === 'soft' ? true : (c.closeModel === 'hard' ? false : null),
    }));
  }

  // A cross-check of the box's own summary strip when it exists (documented to 404 on the current
  // release - tolerated).
  const summary = await getJson('/api/export/summary', 'summary');
  if (summary && summary.summary) {
    notes.push(`box /api/export/summary present: inquiries=${summary.summary.inquiries} priced=${summary.summary.priced} participation=${summary.summary.participationPct}% (cross-check).`);
  }

  notes.push(`customer axis: ${labelByCompany.size} company string(s) resolved to a canonical customer`
    + ' tag via the closed-bids join and applied to every funnel row (skipped loads included). Rows'
    + ' with no mapping are shown under the raw platform company string and marked routed=no - see'
    + ' the note under the by-customer table before reading those rows as separate customers.');

  const provenance = { mode: 'api', base, sources, notes, spineIsOutcomesOnly };
  return { reqLikes, closedLikes, closedByLoad, provenance };
}

// ============================================================================================
// MAIN
// ============================================================================================

// `platform` defaults to 'sp' rather than to "everything", and that default is the whole point:
// this report's headline output is a PARTICIPATION PERCENTAGE, which has no row to carry a portal
// label, so a run that quietly averaged two portals together would be wrong in a way its own output
// could not show. Both data sources are all-portal and self-labelling now, so the narrowing happens
// here, once, over both sides of the join. `--platform all` opts out deliberately.
function parseArgs(argv) {
  const a = { mode: null, dataDir: null, json: false, envFile: null, base: null, platform: 'sp' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--data-dir') { a.mode = 'data-dir'; a.dataDir = argv[++i]; }
    else if (t === '--api') { a.mode = 'api'; }
    else if (t === '--json') { a.json = true; }
    else if (t === '--env-file') { a.envFile = argv[++i]; }
    else if (t === '--base') { a.base = argv[++i]; }
    else if (t === '--platform') { a.platform = String(argv[++i] || '').trim().toLowerCase(); }
    else if (t === '--help' || t === '-h') { a.help = true; }
  }
  return a;
}

const USAGE = `Usage:
  node scripts/report-participation.js --data-dir <path-to-data-dir> [--platform <key>] [--json]
  node scripts/report-participation.js --api [--env-file <.env>] [--base <url>] [--platform <key>] [--json]

Reads (read-only):
  --platform  which bidding portal to report on. Default 'sp'. 'all' reports every portal in one
              set, which mixes portals into one participation percentage - only pass it knowingly.
  --data-dir  the store JSON docs (priceRequests + closedBids) via the app's own store modules.
  --api       a running box: POST /api/login, then GET /api/closed-bids and /api/export/* (only
              the login is a POST; every data pull is a GET). Credentials from env or --env-file:
              SP_BIDDER_BASE_URL, SP_BIDDER_BASIC_AUTH, SP_BIDDER_USER, SP_BIDDER_PASSWORD.
              Never printed.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.mode) { process.stdout.write(USAGE + '\n'); process.exit(args.mode ? 0 : 1); }

  let reqLikes, closedLikes, provenance, closedByLoad;
  if (args.mode === 'data-dir') {
    if (!args.dataDir) { process.stderr.write('--data-dir requires a path\n'); process.exit(1); }
    ({ reqLikes, closedLikes, provenance } = await loadFromDataDir(args.dataDir));
    closedByLoad = new Map(closedLikes.map((c) => [String(c.loadId), c]));
  } else {
    const creds = resolveCreds(args.envFile);
    if (args.base) creds.baseUrl = args.base;
    ({ reqLikes, closedLikes, closedByLoad, provenance } = await loadFromApi(creds));
  }

  if (args.platform && args.platform !== 'all') {
    const before = { reqs: reqLikes.length, closed: closedLikes.length };
    reqLikes = reqLikes.filter((r) => (r.platform || 'sp') === args.platform);
    closedLikes = closedLikes.filter((c) => (c.platform || 'sp') === args.platform);
    // Rebuilt AFTER the filter, not reused from the loader: a closedByLoad still holding the other
    // portal's rows would re-admit them through the funnel join and undo the scope.
    closedByLoad = new Map(closedLikes.map((c) => [String(c.loadId), c]));
    provenance.notes.push(`scoped to platform '${args.platform}': ${reqLikes.length}/${before.reqs} funnel rows, ${closedLikes.length}/${before.closed} outcome rows`);
  } else {
    provenance.notes.push('platform scope: ALL portals in one set - any participation or win percentage below mixes them');
  }

  const funnelRows = buildFunnelRows(reqLikes, closedByLoad);
  const outcomeRows = buildOutcomeRows(closedLikes);
  const model = buildModel({ funnelRows, outcomeRows, provenance });

  if (args.json) process.stdout.write(JSON.stringify(model, null, 2) + '\n');
  else process.stdout.write(formatReport(model) + '\n');
}

// Exported for the standalone test. Requiring this module runs no IO - the pure functions never
// touch fs/network, and loadFromApi only does so when CALLED (the test drives it against a local
// loopback fake box, never the live SP-bidder box).
module.exports = {
  istHour, istDate, istHM, parseTs, plausibleTs, pct, deriveStatus, normCompany,
  buildFunnelRows, buildOutcomeRows, summarizeFunnel, summarizeOutcomes,
  segmentByHour, dayPartSplit, dayPartLines, segmentBy, segmentByCustomer, segmentByCloseModel,
  buildModel, formatReport, customerCaveatLines, parseCsv, parseCsvObjects,
  basicHeader, resolveCreds, loadEnvFile, loadFromApi,
};

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`report-participation failed: ${e && e.message}\n`); process.exit(1); });
}
