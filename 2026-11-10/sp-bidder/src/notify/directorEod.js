'use strict';

const { createLogger } = require('../logging/logger');
const { matchCustomer } = require('../model/resolve');
const { COLLECTION: BIDLOG_COLLECTION } = require('../logging/bidLogger');
const {
  fmtRsCompact, median, loadKey, resolveGroups, unclaimedLoads, loadScopeKeys,
} = require('./eodReport');
const { scopeMatches } = require('./notifier');
const { applyBranchPrecedence } = require('./branchRouting');
const { noScheduleCounts } = require('../discovery/discovery');
const { outcomeOf } = require('../util/closedOutcome');
const { IST_OFFSET_MS, DAY_MS, istMidnight, istDayStamp, istDisplayDate, startDailyISTTask } = require('./dailyTask');

/**
 * Director-level end-of-day PARTICIPATION DM - one CROSS-customer WhatsApp message,
 * sent after the per-customer group reports (default 20:10 IST, just past the 20:00
 * group EOD), to the directors by number. Where the per-customer EOD (eodReport.js)
 * answers "how did MY loads do today", this answers the one question the director set
 * as the target: of every load we SURFACED today, on how many did we place a bid? The
 * client directive (Suyashh, 2026-07-25) is "100% participation: every load gets a
 * bid", so the LEAK (today's unpriced loads, named) is the line this message exists for.
 *
 * PARTICIPATION IS MEASURED ON THE SURFACED DENOMINATOR - the load-bearing choice. The
 * denominator is loads SURFACED (every price request discovery opened), NOT the armed/
 * closed subset. Measuring bids against closed-bids alone reads ~95% (the armed subset)
 * while the true figure is far lower (the participation-baseline run, PR #92, measured
 * 35.3% priced-of-surfaced - hundreds of loads skipped upstream of arming are invisible
 * to closed-bids). A director number flattering to 95% would be false and would bury the
 * point. So the funnel is price-requests LEFT JOIN closed-bids by loadId, with per-load
 * status derived by the same rules the console export applies.
 *
 * CROSS-SURFACE PARITY IS NOT YET ENFORCED - do not read the above as a guarantee. This DM
 * measures bid/surfaced. The console export (src/web/exportModel.js, which is NOT in this
 * branch's lineage) measures priced/inquiries - a DIFFERENT numerator, so the two report
 * different percentages for the same day. The day windows differ too: IST midnight-to-
 * midnight here, a 20:00-anchored rolling window in eodReport.js. Reconciling them means
 * changing exportModel.js and is deliberately out of scope on this branch; until that
 * lands, this number is the DM's own definition and must not be quoted as the console's.
 *
 * WHATSAPP-CRISP, LOCKED SKELETON. ~9-11 lines, one emoji per line as a visual anchor,
 * number-first, no tables, the SAME shape every day so a director reads the trend by
 * shape. Every percentage says what it is a percent of (never a bare "34%"): the funnel
 * is a plain counts line plus a labelled participation line. Per-customer breakdowns
 * belong to the per-group EODs, not here - the only per-customer thing here is the "best
 * win rates" line. The engine-conversion ratio (bid of priced) is a docs/PR metric and
 * surfaces as a line ONLY when it drops below the health threshold (an exception, never
 * a daily stat). Emoji in the rendered WhatsApp copy are deliberate (the ASCII-only rule
 * is for source/logs; the emoji here are unicode escapes so the source file stays ASCII).
 *
 * FAIL-SAFE, off by default. Unlike the heartbeat and group EOD (on by default because
 * their ABSENCE is the alarm), this goes to named humans by raw number, so it stays DARK
 * until SP_DIRECTOR_EOD_RECIPIENTS is set - an unset var is silence, never a surprise DM
 * to a stale number. Empty recipients => the schedule never starts.
 *
 * DEGRADE HONESTLY. A day on which nothing surfaced still sends the short zero-activity
 * message (the desk must trust the cadence). A gather that cannot read the records sends
 * a never-cheerful degraded line, not silence. A rate with nothing to divide by renders
 * as '-' and a zero value is omitted - never a fabricated 0 that reads as real.
 *
 * All reads go through the store seam / injected components; this module touches no
 * filesystem and no network of its own (the send rides notifier.sendDirect - the same
 * person-DM path the heartbeat uses).
 *
 * SENDER-HEALTH GATE - CROSS-PR DEPENDENCY. On this branch sendDirect is not behind the
 * sender-health circuit breaker. PR #78 (fix/sender-health-gate) puts it behind one: a
 * HEALTH_POLICY map keyed by message kind, whose default for an UNLISTED kind is 'drop'.
 * 'director_eod' is a new kind that map does not know about, so whichever of the two lands
 * second MUST add an explicit entry for it ('reroute' matches how heartbeat treats a
 * named-human DM; 'drop' matches eod_report). Left unlisted, this DM goes silent on exactly
 * the evenings the sender is down - which is a documented recurring incident on this box.
 */

const log = createLogger('directorEod');

// One state doc through the store seam: lastRunAt + the IST date of the last successful
// send (the boot catch-up's dedupe). No per-recipient state is kept.
const COLLECTION = 'directorEod';
const STATE_KEY = 'state';

// One emoji per line, as a visual anchor (unicode escapes so the source stays ASCII per
// repo convention; log lines never carry these). The warning emoji keeps a leak or a
// conversion shortfall from ever looking cheerful in the chat-list preview.
const EMOJI = {
  truck: '\u{1F69A}',                 // header
  box: '\u{1F4E6}',                   // funnel counts + per-group rows
  chart: '\u{1F4CA}',                 // participation %
  warn: '\u{26A0}\u{FE0F}',           // nobody-priced / not-sent / no-schedule / conversion flags
  clock: '\u{23F1}\u{FE0F}',          // desk speed
};

// Engine conversion (bid of priced) surfaces as a line ONLY below this, on a real sample.
const ENGINE_CONV_ALERT_PCT = 90;
const ENGINE_CONV_MIN_SAMPLE = 5;
// A customer must have at least this many decided loads to appear in "best win rates"
// (no 100%-of-1 noise).
const BEST_WINRATE_MIN_DECIDED = 3;
// IST hour at/after which a surfaced load counts toward the "after 6pm" leak component.
const AFTER_HOURS_START_H = 18;
const UNKNOWN_NAME = 'Unknown';

const finite = (v) => v != null && Number.isFinite(Number(v));

/**
 * Is this load's pricing basis a known TRUCK count - i.e. may a per-vehicle price be
 * multiplied by `units` to get a freight value?
 *
 * PMT means `units` is a TONNAGE QUANTITY, never a truck count, and its unit is
 * branch-configured (MT for most, KG for some - src/model/loadRules.js) and explicitly
 * UNVERIFIED for the KG branches. Multiplying a per-tonne rate by a kilogram quantity
 * overstates by 1000x, so PMT reads false here. A null/absent quoteType is "basis not
 * recorded", NOT "FTL", and also reads false - an unrecorded basis must never be able to
 * inflate a money figure the director acts on. Same fail-safe direction as the engine's
 * multi-vehicle guard, which likewise refuses to invent a count it cannot establish.
 * The basis rides the price request's own snapshot (priceRequests.js records quoteType
 * for exactly this purpose), so no new persisted field is needed.
 */
function isTruckBasis(load) {
  const quote = load && load.quoteType != null ? String(load.quoteType).trim().toUpperCase() : '';
  return quote !== '' && quote !== 'PMT';
}

/** Whole-percent string, or '-' when there is nothing to divide by (never a fake 0%). */
function pctStr(num, den) {
  return den > 0 ? `${Math.round((num / den) * 100)}%` : '-';
}

/** IST hour-of-day (0..23) for an epoch-ms instant (fixed +05:30, no DST). */
function istHour(ts) {
  return new Date(Number(ts) + IST_OFFSET_MS).getUTCHours();
}

/**
 * Canonical per-load status from a price-request status + its optional CLOSED-bid record. A closed
 * outcome resolves through util/closedOutcome like every other surface; an unfinished row carries
 * its own request status; a request marked 'closed' with no outcome is no_bid, never invented as a
 * win/loss. `closed` is { numBids, won, closedWhileDown, finalRank } for a CLOSED doc, or null.
 */
function deriveStatus(reqStatus, closed) {
  if (closed) {
    return outcomeOf({ bidCount: closed.numBids, won: closed.won, closedWhileDown: closed.closedWhileDown,
      unconfirmedCount: closed.unconfirmedCount || 0,
      finalRank: closed.finalRank });
  }
  if (!reqStatus) return 'unknown';
  return reqStatus === 'closed' ? 'no_bid' : reqStatus;
}

/**
 * The cross-customer participation day, over the loads SURFACED today (price requests
 * whose createdAt falls in the IST calendar day of `now` - discovery opens exactly one
 * request per in-scope load, so created == surfaced). Definitions:
 *
 *   surfaced      = the today cohort size (the participation denominator).
 *   priced        = capturedAt != null (a cost was entered).
 *   bid           = the closed-bids doc holds >=1 ourBids (a bid was actually placed).
 *   won / lost    = of loads with a CLOSED doc, its won flag; decided = won + lost.
 *   winning value = sum lastBidPrice x units over WON loads (units where known, else 1;
 *                   lastBidPrice is per-vehicle/per-tonne, so units gives the freight
 *                   value at a rank-1 close). Labelled "in winning bids" in the copy - it
 *                   is never claimed as allotted revenue (allotment is a later SP state
 *                   this system does not track; that nuance lives here/in the PR, not the DM).
 *   best win rate = per matched customer (matchCustomer, falling back to the raw name), the
 *                   win rate over its decided loads, for customers with >= 3 decided.
 *   leak          = skipped_no_price = surfaced, deadline passed, never priced. Broken into
 *                   named components (customer name variants, rendered AS-IS; soft-close;
 *                   after-6pm) so the director sees WHERE the gap is, biggest first.
 *   desk speed    = median ask-to-price time (capturedAt - createdAt) over priced loads,
 *                   reusing the branch's median(); null under 2 samples (a single capture
 *                   is not a median).
 *   engineConv    = bid / priced (once armed, did the engine bid) - surfaced only below the
 *                   health threshold.
 *   record        = the same spine without the today filter (every retained request): bid /
 *                   surfaced to date. Bounded by the price-request store's ~7-day prune, so
 *                   it is the record over retained data. A docs/PR number, not a DM line.
 *
 * EVERY PORTAL COUNTS TOWARD PARTICIPATION. Until 2026-08-12 the cohort was filtered to a single
 * platformKey and production passed config.platformKey ('sp'), so the day GoComet went live in
 * production its 74 surfaced loads - 55 of them never priced - were absent from the one message
 * whose stated purpose is to name today's leak. "Of every load we SURFACED today, on how many did
 * we place a bid" has no honest reading in which a load we surfaced on the other portal is not a
 * load we surfaced. Folding them in moves the headline percentage, deliberately: the loads were
 * always in the denominator of the question, only ever missing from the answer.
 *
 * The join is what the removed filter was really protecting, and it is now keyed on (portal,
 * loadId) via eodReport.loadKey - see there for why a bare loadId is not an identity.
 *
 * @param {Object} params - Input dependencies and context.
 * @param {Object} params.requests - Price-request reader (listAll()) - the surfaced cohort source.
 * @param {Object} params.store - Doc store used to read the closed-bids collection.
 * @param {Array} params.customers - Known customers, for the "best win rates" label match.
 * @param {number} params.now - Current epoch ms - anchors the IST day window.
 * @returns {Promise<Object>} The day's metrics object (surfaced, priced, bid, won, lost,
 *   winningBidValue, bestCustomers, skipSoft/skipAfter6/skipTop, medianAskToPriceMs, record) per
 *   the definitions above.
 */
// The two reads collectDirectorDay and collectScorecard both need, factored to ONE place so this
// file keeps exactly the two call sites test-shared-reader-platform-scope.js caps it at - a second
// function reading requests.listAll()/store.listDocs(BIDLOG_COLLECTION) directly would be counted
// as two MORE unscoped call sites by that gate's per-line scan, not a shared one.
async function _readDay({ requests, store }) {
  const allReqs = (await requests.listAll()) || [];
  const rawDocs = (await store.listDocs(BIDLOG_COLLECTION)) || [];
  const docByLoad = new Map(rawDocs.filter(Boolean).map((d) => [loadKey(d, d.auctionId), d]));
  return { allReqs, docByLoad };
}

async function collectDirectorDay({ requests, store, customers, now }) {
  const dayStart = istMidnight(now);          // 00:00 IST of the day containing now
  const dayEnd = dayStart + DAY_MS;
  const inToday = (ts) => finite(ts) && ts >= dayStart && ts < dayEnd;
  const custList = customers || [];

  const { allReqs, docByLoad } = await _readDay({ requests, store });

  const m = {
    ok: true,
    surfaced: 0, priced: 0, bid: 0, won: 0, lost: 0, closedUnknown: 0, skipped: 0, dismissed: 0, open: 0, noBid: 0,
    winningBidValue: 0, softSurfaced: 0, softPriced: 0,
    // Priced loads that have actually CLOSED, and how many of those we bid on. These - not
    // the raw priced/bid totals - are the engine-conversion pair: a load priced today but
    // closing tomorrow has not had its chance to bid yet.
    pricedClosed: 0, bidClosed: 0,
  };
  const record = { surfaced: 0, bid: 0 };
  const cust = new Map();       // matched label -> { label, won, lost }
  // Leak buckets keyed by MATCHED CUSTOMER label (falling back to the raw name when nothing
  // matches), so one shipper's branch-qualified SP name variants aggregate into a single
  // offender instead of splitting across branches and losing to a smaller single-branch one.
  // The verbatim legal names are kept alongside so the RENDERED name is still as-is - the
  // count is per-customer, the display name is untouched.
  const skipByCustomer = new Map(); // label -> { count, names: Map<rawName, n> }
  let skipSoft = 0, skipAfter6 = 0;
  const responseMs = [];        // ask-to-price durations over priced loads

  for (const r of allReqs) {
    if (!r) continue;
    const doc = docByLoad.get(loadKey(r, r.loadId));
    const numBids = doc && Array.isArray(doc.ourBids) ? doc.ourBids.length : 0;
    const anyBid = numBids > 0;

    // Record-to-date (every retained request, regardless of when it surfaced).
    record.surfaced += 1;
    if (anyBid) record.bid += 1;

    if (!inToday(r.createdAt)) continue;

    const priced = r.capturedAt != null;
    // Only a CLOSED doc resolves an outcome; a still-open bid is bid+open, never a loss.
    // closedWhileDown + finalRank ride along or the branch above can never fire - the projection was
    // narrower than the classifier it feeds, which is the quiet way a mirror stops mirroring.
    const closed = doc && doc.status === 'closed'
      ? { numBids, won: doc.won, closedWhileDown: doc.closedWhileDown === true, finalRank: doc.finalRank,
        unconfirmedCount: (doc.gcUnconfirmedSubmissions || []).length }
      : null;
    const status = deriveStatus(r.status, closed);
    const rawName = String((r.load && r.load.companyName) || '').trim() || UNKNOWN_NAME;
    const matched = matchCustomer(r.load && r.load.companyName, custList);
    const label = (matched && matched.label) || rawName;
    const soft = !!(r.load && r.load.softClose);

    m.surfaced += 1;
    if (priced) {
      m.priced += 1;
      if (closed) { m.pricedClosed += 1; if (anyBid) m.bidClosed += 1; }
      if (finite(r.createdAt) && finite(r.capturedAt) && r.capturedAt >= r.createdAt) responseMs.push(r.capturedAt - r.createdAt);
    }
    if (anyBid) m.bid += 1;
    if (soft) { m.softSurfaced += 1; if (priced) m.softPriced += 1; }

    const c = cust.get(label) || { label, won: 0, lost: 0 };
    switch (status) {
      case 'won': {
        m.won += 1; c.won += 1;
        const bidPrice = finite(doc && doc.lastBidPrice) ? Number(doc.lastBidPrice) : 0;
        // Scale by the unit count ONLY on a known truck basis (see isTruckBasis). A PMT win
        // or a win whose basis was never recorded contributes its bid price alone rather
        // than a fabricated total - understating is survivable, a 1000x overstatement in
        // the director's evening message is not.
        const units = isTruckBasis(r.load) && finite(doc && doc.units) && Number(doc.units) > 0
          ? Number(doc.units)
          : 1;
        if (bidPrice > 0) m.winningBidValue += bidPrice * units;
        break;
      }
      case 'lost': m.lost += 1; c.lost += 1; break;
      case 'skipped_no_price': {
        m.skipped += 1;
        const bucket = skipByCustomer.get(label) || { count: 0, names: new Map() };
        bucket.count += 1;
        bucket.names.set(rawName, (bucket.names.get(rawName) || 0) + 1);
        skipByCustomer.set(label, bucket);
        if (soft) skipSoft += 1;
        if (finite(r.createdAt) && istHour(r.createdAt) >= AFTER_HOURS_START_H) skipAfter6 += 1;
        break;
      }
      case 'dismissed': m.dismissed += 1; break;
      case 'no_bid': m.noBid += 1; break;
      // Its own bucket, in neither won nor lost. The load was bid and its end was never seen, so it
      // is neither - and keeping it out of m.lost is the whole point: it must not sit in the win-rate
      // denominator of the message the Director reads. Counted rather than dropped because the render
      // calls m.decided "the N that closed", and a row that is in no bucket at all makes that claim
      // false with no line anywhere accounting for the gap.
      case 'closed_unknown': m.closedUnknown += 1; break;
      default: if (status === 'awaiting_price' || status === 'armed' || status === 'stopped') m.open += 1; break;
    }
    cust.set(label, c);
  }

  m.decided = m.won + m.lost;
  m.participationPct = m.surfaced > 0 ? (m.bid / m.surfaced) * 100 : null; // headline: bid / surfaced
  m.winPct = m.decided > 0 ? (m.won / m.decided) * 100 : null;
  // Engine conversion is measured over priced loads that have actually CLOSED. Measuring it
  // over every priced load counts a load closing tomorrow as a miss, which fires the alert
  // line at a perfectly healthy engine on any day with a carry-over load.
  m.engineConvPct = m.pricedClosed > 0 ? (m.bidClosed / m.pricedClosed) * 100 : null;

  // Best win rates: customers with enough decided loads to be meaningful, best first.
  m.bestCustomers = [...cust.values()]
    .map((c) => ({ label: c.label, decided: c.won + c.lost, won: c.won }))
    .filter((c) => c.decided >= BEST_WINRATE_MIN_DECIDED)
    .sort((a, b) => (b.won / b.decided) - (a.won / a.decided) || b.decided - a.decided || String(a.label).localeCompare(String(b.label)))
    .slice(0, 3);

  // Leak decomposed by CAUSE (rendered in a fixed order): soft-close coverage first, then
  // after-hours, then the single biggest skipped shipper named as-is. The name is a fact, NOT
  // a routing/naming story - routed loads the desk simply never priced still surface here, by
  // their own legal name, without being framed as a routing failure.
  m.skipSoft = skipSoft;
  m.skipAfter6 = skipAfter6;
  // Biggest offender by CUSTOMER; the name shown is that customer's most frequent raw SP
  // string, ties broken alphabetically so the same day always renders the same name.
  m.skipTop = [...skipByCustomer.entries()]
    .map(([label, bucket]) => ({
      name: [...bucket.names.entries()]
        .sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])))[0][0],
      count: bucket.count,
      label,
    }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))[0] || null;

  m.medianAskToPriceMs = responseMs.length >= 2 ? median(responseMs) : null;
  m.record = {
    surfaced: record.surfaced, bid: record.bid,
    participationPct: record.surfaced > 0 ? (record.bid / record.surfaced) * 100 : null,
  };
  return m;
}

const OPEN_TRACKING_COLLECTION = 'openTracking';
const OPEN_TRACKING_KEY = 'goLive';

/**
 * The moment page-open tracking (D026's requests.markOpened) went live, persisted the FIRST time
 * this runs so it survives a restart. A request created before this moment carries no openedAt
 * for a structural reason - the feature did not exist yet - never because nobody opened it, so
 * D048's "never opened" count must exclude it. Best-effort: a write failure just re-derives the
 * same moment (now) on the next run rather than blocking the scorecard.
 */
async function ensureOpenTrackingGoLive(store, now) {
  try {
    const existing = await store.getDoc(OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY);
    if (existing && Number.isFinite(existing.at)) return existing.at;
  } catch (e) {
    log.warn('open-tracking go-live marker could not be read - treating this run as go-live', { err: e });
  }
  const at = Number.isFinite(now) ? now : Date.now();
  try {
    await store.putDoc(OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY, { at });
  } catch (e) {
    log.warn('open-tracking go-live marker could not be persisted - will re-derive on the next run', { err: e });
  }
  return at;
}

/**
 * CW-240 desk scorecard, ruling 46 ("rides PR-2 as a recorded free concession"). Per-group
 * asked/priced/bid for today, plus which today-surfaced loads matched a customer but no group's
 * OWN scope ("not sent"), plus the Cords/no-schedule per-shipper warranty count (ruling 46,
 * discovery.js's durable noScheduleLoads collection). Attribution mirrors the notifier's actual
 * routing: scopeMatches per group, THEN applyBranchPrecedence, so a branch-scoped group's load is
 * never also counted under the customer's general group (an Alwar load counts once, under Alwar).
 *
 * Reuses collectDirectorDay's own read (_readDay above) rather than reading requests/closedBids
 * again - test-shared-reader-platform-scope.js caps this file at 2 unscoped call sites.
 */
async function collectScorecard({ requests, store, groups, now }) {
  const dayStart = istMidnight(now);
  const dayEnd = dayStart + DAY_MS;
  const { allReqs, docByLoad } = await _readDay({ requests, store });
  const goLiveAt = await ensureOpenTrackingGoLive(store, now);

  const byGroup = new Map(); // personId -> { personId, label, owner, asks, priced, bid }
  for (const r of allReqs) {
    if (!r || !r.load) continue;
    if (!finite(r.createdAt) || r.createdAt < dayStart || r.createdAt >= dayEnd) continue;
    const keys = loadScopeKeys(r.load);
    const matched = (groups || []).filter((g) =>
      scopeMatches({ origins: g.origins, shippers: g.aliases, branches: g.branches }, keys));
    if (!matched.length) continue;
    const winners = applyBranchPrecedence(
      matched.map((g) => ({ ...g, scope: { shippers: g.aliases, branches: g.branches } })));
    const doc = docByLoad.get(loadKey(r, r.loadId));
    const priced = r.capturedAt != null;
    const bid = !!(doc && Array.isArray(doc.ourBids) && doc.ourBids.length > 0);
    // D048/D026: distinguish "never opened at all" from "opened after the pricing deadline" -
    // merging both into one unpriced bucket hides that they need different fixes (desk
    // capacity/training vs a routing gap). `deadlineAt` is the ask's own pricing cutoff
    // (priceRequests.js - load.closesAt minus the configured lead), the only threshold this
    // request already carries for "late" - there is no separate open-lateness threshold in the
    // code to prefer over it.
    //
    // "Never opened" must NOT fire on:
    //   - a priced ask (it was engaged with, whatever happened to the open signal);
    //   - an ask still before its own deadline (it may yet be opened - there is nothing to report);
    //   - an ask created BEFORE page-open tracking went live (goLiveAt, ensured below) - that
    //     request has no openedAt for a structural reason (the feature did not exist), not
    //     because nobody opened it, and counting it would misreport every pre-deploy ask as a
    //     desk failure.
    const pastDeadline = finite(r.deadlineAt) && now > r.deadlineAt;
    const trackedSinceGoLive = goLiveAt != null && finite(r.createdAt) && r.createdAt >= goLiveAt;
    const neverOpened = !priced && r.openedAt == null && pastDeadline && trackedSinceGoLive;
    const openedLate = r.openedAt != null && finite(r.deadlineAt) && r.openedAt > r.deadlineAt;
    for (const w of winners) {
      // A branch-scoped group shares its customer's label with the general group (both are
      // assigned to the same customerId) - disambiguate by appending the branch filter, the only
      // thing that told the two groups apart to begin with.
      const label = (w.branches || []).length ? `${w.label} (${w.branches.join(', ')})` : w.label;
      const row = byGroup.get(w.personId) || {
        personId: w.personId, label, owner: !!w.owner, asks: 0, priced: 0, bid: 0, neverOpened: 0, openedLate: 0,
      };
      row.asks += 1;
      if (priced) row.priced += 1;
      if (bid) row.bid += 1;
      if (neverOpened) row.neverOpened += 1;
      if (openedLate) row.openedLate += 1;
      byGroup.set(w.personId, row);
    }
  }
  const rows = [...byGroup.values()].sort((a, b) => b.asks - a.asks || a.label.localeCompare(b.label));
  const notSent = await unclaimedLoads({ requests, groups, windowStart: dayStart, windowEnd: dayEnd });
  const noSchedule = await noScheduleCounts(store);
  return { rows, notSent, noSchedule };
}

/**
 * Render the director DM to the locked skeleton. One emoji per line, number-first, no
 * tables, WhatsApp *bold* only on the header, hyphens (never em dashes). Every percentage
 * says what it is a percent of. The word "bot" never appears - the product voice is "Bid
 * Command".
 */
function renderDirectorEod(m, now) {
  const date = istDisplayDate(now);

  // Zero-activity day: header + one line + target.
  if (!m.surfaced) {
    return [
      `${EMOJI.truck} *Bid Command EOD - ${date}*`,
      'No auctions closed today.',
      '_Target: 100% participation._',
    ].join('\n');
  }

  const lines = [];
  // Block 1: header + funnel counts + the (bold) participation headline.
  lines.push(`${EMOJI.truck} *Bid Command EOD - ${date}*`);
  lines.push(`${EMOJI.box} ${m.surfaced} loads came in, desk priced ${m.priced}, we bid on ${m.bid}`);
  lines.push(`${EMOJI.chart} *Participation: ${pctStr(m.bid, m.surfaced)}* of all loads got our bid`);

  // Block 2: the desk scorecard (CW-240, ruling 46) - per-group asked/priced/bid, who has
  // nothing priced, what never reached a group, and the Cords/no-schedule warranty count.
  // NO win count, no win rate, no won value anywhere in this message (ruling 46's own words) -
  // m.won/m.decided/m.winningBidValue/m.bestCustomers stay computed above (other readers of this
  // same collector, e.g. the portal-safe-join proof, still need them) but nothing below renders them.
  lines.push('');
  const sc = m.scorecard || {};
  const rows = sc.rows || [];
  const notSent = sc.notSent || [];
  const noSchedule = sc.noSchedule || {};

  if (rows.length) {
    lines.push(`${EMOJI.box} Per customer (asked / priced / bid)`);
    for (const row of rows) lines.push(`${row.label}: ${row.asks} / ${row.priced} / ${row.bid}`);
  }

  // A group with 0 priced is named here, with "(no owner set)" only for the groups among them
  // that carry no enabled owner assignment (resolveGroups' owner flag).
  const zeroPriced = rows.filter((row) => row.priced === 0);
  if (zeroPriced.length) {
    const parts = zeroPriced.map((row) => `${row.label} ${row.asks}`).join(', ');
    const ownerless = zeroPriced.filter((row) => !row.owner).map((row) => row.label);
    let line = `${EMOJI.warn} Nobody priced: ${parts}`;
    if (ownerless.length) line += ` (no owner set for ${ownerless.join(', ')})`;
    lines.push(line);
  }

  // D048: "never opened" (the link was never clicked) and "opened late" (opened past the pricing
  // deadline) are named separately from "nobody priced" - they point at different fixes (desk
  // capacity/coverage vs a genuinely late desk) and merging them hid that 96% of one audit's
  // unpriced asks were never opened at all, not late.
  const neverOpenedRows = rows.filter((row) => row.neverOpened > 0);
  if (neverOpenedRows.length) {
    const parts = neverOpenedRows.map((row) => `${row.label} ${row.neverOpened}`).join(', ');
    lines.push(`${EMOJI.warn} Never opened: ${parts}`);
  }
  const openedLateRows = rows.filter((row) => row.openedLate > 0);
  if (openedLateRows.length) {
    const parts = openedLateRows.map((row) => `${row.label} ${row.openedLate}`).join(', ');
    lines.push(`${EMOJI.warn} Opened late: ${parts}`);
  }

  // A load that matched a customer's aliases but no group's OWN scope - the narrowing gap
  // itself opens (unclaimedLoads). Named per shipper, never absorbed into any customer's row.
  if (notSent.length) {
    const byShipper = new Map();
    for (const u of notSent) byShipper.set(u.shipper, (byShipper.get(u.shipper) || 0) + 1);
    const parts = [...byShipper.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([shipper, count]) => `${shipper} ${count}`).join(', ');
    lines.push(`${EMOJI.warn} Not sent to any group: ${notSent.length} load${notSent.length === 1 ? '' : 's'} (${parts})`);
  }

  // Cords/no-schedule (ruling 46): a durable, per-shipper count of loads whose close time
  // SuperProcure never reports - bidding them is OUT, but the desk has to hear about them to bid
  // by hand. noScheduleCounts() is a running total since discovery first noticed each load (its
  // own docstring: "noticed so far"), not a today-only count - the desk is told this line covers
  // everything tracked to date, not just today's occurrences.
  const scheduleEntries = Object.entries(noSchedule)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  if (scheduleEntries.length) {
    const parts = scheduleEntries.map(([shipper, count]) => `${shipper} ${count}`).join(', ');
    lines.push(`${EMOJI.warn} No fixed close time (bid by hand), tracked so far: ${parts}`);
  }

  // Desk speed (reuses the branch's median desk-response computation).
  if (m.medianAskToPriceMs != null) {
    lines.push(`${EMOJI.clock} Desk speed: ${Math.max(1, Math.round(m.medianAskToPriceMs / 60000))} min median from ask to price`);
  } else {
    lines.push(`${EMOJI.clock} Desk speed: too few priced loads for a median today`);
  }

  // The target, on its own, in WhatsApp italics.
  lines.push('');
  lines.push('_Target: 100% participation._');

  // Conversion exception - only when it drops below the threshold on a real sample.
  //
  // Reworded 2026-07-27. It read "Engine flag: bid only 89% of priced loads that closed", and the
  // client's Director asked what it meant - fairly: "Engine flag" is a system-internal label (and
  // "engine" is on the banned-vocabulary list for anything a human reads), and the number itself is
  // ambiguous next to the participation target on the line above.
  //
  // The BASIS is spelled out in the sentence on purpose. This is conversion on the ARMED subset -
  // of the loads the desk actually priced AND that closed today, how many got a bid onto the board.
  // It is NOT participation, which is bids over loads SURFACED and is the number the target line
  // above refers to. Those two have been conflated before; a reader who sees two bare percentages
  // in one message will conflate them again, so this one names what it is measuring and says what
  // the shortfall means in plain terms.
  if (m.pricedClosed >= ENGINE_CONV_MIN_SAMPLE && m.engineConvPct != null && m.engineConvPct < ENGINE_CONV_ALERT_PCT) {
    lines.push(`${EMOJI.warn} Of the loads the desk priced that closed today, only ${pctStr(m.bidClosed, m.pricedClosed)} got a bid in - the rest closed with nothing from us`);
  }
  return lines.join('\n');
}

/** The never-cheerful fallback when the day's records could not be read. */
function renderDegraded(now) {
  return `${EMOJI.warn} *Bid Command EOD - participation could not be read (${istDisplayDate(now)})*\n`
    + 'please check Bid Command.';
}

/**
 * Who gets the director DM: the raw numbers in config.directorEod.recipients (already
 * trimmed + non-empty in config.js). No person lookup and NO default recipient - unlike
 * the heartbeat, an empty list means nothing goes out (the fail-safe that keeps this
 * feature dark until it is deliberately configured).
 */
function resolveRecipients(config) {
  const cfg = (config && config.directorEod) || {};
  return (cfg.recipients || []).map((s) => String(s).trim()).filter(Boolean);
}

/**
 * One director-EOD run: gather -> render -> send -> remember. Layered fallbacks:
 *   - a gather/render failure still sends the degraded "could not read" line;
 *   - no resolvable recipient logs and sends nothing (the feature is off);
 *   - a failed send is logged and sentDate is NOT written, so the boot catch-up can
 *     retry after a restart;
 *   - state-doc persistence failing never blocks the send (it already happened).
 * `collect` is injectable for tests only; production always uses collectDirectorDay.
 */
async function runDirectorEod(deps, { collect = collectDirectorDay } = {}) {
  const now = deps.now != null ? deps.now : Date.now();
  let message;
  try {
    // Customers feed the skip-leak label match inside collect(); a read failure there must not
    // sink the whole message, so it degrades to raw names rather than the degraded fallback.
    let customers = [];
    try { customers = (deps.customerStore && (await deps.customerStore.list())) || []; }
    catch (e) { log.warn('director EOD could not read customers - the skip leak falls back to raw names', { err: e }); }
    const day = await collect({
      requests: deps.requests, store: deps.store, customers, now,
    });
    // The desk scorecard rides the same message (CW-240, ruling 46). personStore/assignmentStore
    // are optional deps - a box that has not wired them (or a scorecard-build failure) degrades to
    // an empty scorecard, never to the whole degraded fallback: the participation funnel above is
    // still real data worth sending.
    try {
      const groups = (deps.personStore && deps.customerStore && deps.assignmentStore)
        ? await resolveGroups({
          personStore: deps.personStore, customerStore: deps.customerStore, assignmentStore: deps.assignmentStore,
        })
        : [];
      day.scorecard = await collectScorecard({ requests: deps.requests, store: deps.store, groups, now });
    } catch (e) {
      log.warn('director EOD could not build the desk scorecard - per-group rows will be empty', { err: e });
      day.scorecard = { rows: [], notSent: [], noSchedule: {} };
    }
    message = renderDirectorEod(day, now);
  } catch (e) {
    log.error('director EOD could not gather the day - sending the degraded message', { err: e });
    message = renderDegraded(now);
  }

  const recipients = resolveRecipients(deps.config);
  if (!recipients.length) {
    // Off by design (no recipients configured). Info, not error - a dark feature is the
    // fail-safe default, not a fault.
    log.info('director EOD has no configured recipients (SP_DIRECTOR_EOD_RECIPIENTS unset) - nothing sent');
    return { sent: 0, recipients: 0, message };
  }
  let sent = 0;
  for (const phone of recipients) {
    const res = await deps.notifier.sendDirect(phone, message, { kind: 'director_eod' });
    if (res && res.ok) sent += 1;
  }
  if (!sent) log.error(`director EOD send failed for all ${recipients.length} recipient(s) - the evening summary did NOT go out`, { recipients: recipients.length });
  else log.info(`director EOD sent to ${sent}/${recipients.length} recipient(s)`, { sent, recipients: recipients.length });

  try {
    const patch = { lastRunAt: now };
    if (sent > 0) patch.sentDate = istDayStamp(now);
    await deps.store.patchDoc(COLLECTION, STATE_KEY, patch);
  } catch (e) {
    log.error('director EOD could not persist its state', { err: e });
  }
  return { sent, recipients: recipients.length, message };
}

/**
 * Start the daily director-EOD schedule on the shared daily-IST rail (default 20:10 IST -
 * just after the 20:00 group EOD). Enabled only when recipients are configured
 * (config.directorEod.enabled derives from a non-empty recipient list), so an unset
 * SP_DIRECTOR_EOD_RECIPIENTS starts nothing. Returns { stop() }; null when disabled.
 */
function startDailyDirectorEod(deps) {
  const cfg = (deps.config && deps.config.directorEod) || {};
  return startDailyISTTask({
    label: 'directorEod',
    enabled: !!cfg.enabled,
    timeIST: cfg.timeIST,
    defaultTime: { h: 20, m: 10 },
    alreadyDoneToday: async (now) => {
      const state = await deps.store.getDoc(COLLECTION, STATE_KEY).catch(() => null);
      return !!(state && state.sentDate === istDayStamp(now));
    },
    run: () => runDirectorEod(deps),
  });
}

module.exports = {
  COLLECTION, STATE_KEY, ENGINE_CONV_ALERT_PCT, ENGINE_CONV_MIN_SAMPLE, BEST_WINRATE_MIN_DECIDED,
  OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY, ensureOpenTrackingGoLive,
  pctStr, istHour, isTruckBasis, deriveStatus, collectDirectorDay, collectScorecard,
  renderDirectorEod, renderDegraded, resolveRecipients, runDirectorEod, startDailyDirectorEod,
};
