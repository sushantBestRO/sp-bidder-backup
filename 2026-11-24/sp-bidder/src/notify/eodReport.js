'use strict';

const { createLogger } = require('../logging/logger');
const { isGroupJid } = require('../model/normalizePhone');
const { scopeMatches } = require('./notifier');
const { fmtNum } = require('./waTemplates');
const { COLLECTION: BIDLOG_COLLECTION } = require('../logging/bidLogger');
const { DAY_MS, istMidnight, istDayStamp, istDisplayDate, parseTimeIST, startDailyISTTask } = require('./dailyTask');
const { platformOf, effectiveCloseAt } = require('../pricing/priceRequests');
const { resolveBidTimeCost } = require('./bidTimeCost');
const { closedOutcome } = require('../util/closedOutcome');

/**
 * Per-customer end-of-day report - at 20:00 IST, every customer's WhatsApp group
 * gets ITS OWN day summary (only that customer's loads), day-end marked at 8 pm
 * per the client's ask. The message carries the client's six data points (inquiries
 * / participated / participation rate / won / winning rate / margin - his list
 * was a spec of WHAT he wants, not literal wording), laid out mobile-first for a
 * narrow WhatsApp column: one fact per line, grouped into three glanceable blocks
 * (funnel in -> outcomes -> quality) with a blank line between them, plus the bot's
 * most actionable additions (the missed-cutoff count that explains a low
 * participation rate, and what is armed or still unpriced right now).
 *
 * VOCABULARY is deliberately unified for a non-technical reader: "priced" (not
 * "participated") for a load the desk quoted and the bot bid on, "missed cutoff"
 * for its complement, "still bidding" for an auction whose result is not in yet.
 * An auction whose result IS in gets no adjective at all - the numbers say it. The
 * word "closed" is kept out of the message ENTIRELY, verdict headline included: in
 * freight it already means a closed load, a closed deal, or simply won, and the
 * client's director read the old "Closed - 12 of 12 priced" line as saying something
 * it did not. Every metric and value is identical to what the six-point spec asked
 * for - this layout is presentation only.
 *
 * Audience is a customer's pricing/ops team - slightly more operational than the
 * director heartbeat, same plain language, same rails: verdict-first line, emoji
 * line-leaders (one per field, drawn from the bot's own price/won/lost vocabulary
 * in waTemplates.js - anchors that make the message scannable on a phone, not
 * decoration - written as unicode escapes so the source stays ASCII), per-group
 * fail quiet-loud (one customer's unreadable data degrades ONE group's message,
 * never the run), quiet days still send one short line (the absence-is-the-alarm
 * philosophy - see heartbeat.js), and the shared daily-IST rail (dailyTask.js)
 * provides the schedule + missed-fire boot catch-up.
 *
 * CUSTOMER ATTRIBUTION - the linkage, chosen to mirror alert routing exactly:
 * groups come from people.json records with a group JID, scoped to customers via
 * enabled assignments (assignments -> customers -> aliases), and a load belongs
 * to a group when notifier.scopeMatches accepts the load against the SAME three
 * scope dimensions the day's alerts routed on - the customer's aliases as
 * `shippers`, plus the group record's own `originScope` and `branchScope`. That
 * is the very predicate that decided which alerts the group received all day, so
 * the evening report can never disagree with the day's messages about whose load
 * something was.
 *
 * The two narrowing dimensions are what make a SPLIT customer safe. One customer
 * can own several groups, one per plant desk (Waaree runs three on GoComet, each
 * pinned to its own plant by origin substring), and until 2026-08-22 this module
 * read the customer's aliases alone: every one of those groups was sent an evening
 * report covering the WHOLE customer - another desk's weighted margin, won value
 * and lost ranks. Mirroring the group's own scope is the fix, and it is a no-op
 * for an un-narrowed group (empty origins/branches match everything, exactly as
 * before).
 *
 * Known edges (accepted, documented): a load whose shipper matches two customers'
 * aliases appears in both groups' reports (routing duplicates the alerts the same
 * way); a customer with NO aliases would match every load under scopeMatches'
 * empty-list rule, so such a group is skipped (logged) rather than sent a firehose
 * report; and narrowing can leave a load in NOBODY's report when its origin
 * matches no group's tokens, which is reported by unclaimedLoads rather than
 * silently absorbed.
 *
 * NOT mirrored: applyBranchPrecedence, which in alert routing drops a customer's
 * general group for a load a branch group also matched. Here a general group still
 * counts its branches' loads, so a branch-split customer's general report is a
 * superset of its branch reports rather than their complement. That is per-group
 * isolation winning over exact parity - precedence is a decision across groups,
 * and this function deliberately gathers one group at a time.
 */

const log = createLogger('eodReport');

// One state doc through the store seam: lastRunAt + the IST date of the last
// successful run (the boot catch-up's dedupe). No per-group state is kept - a
// partial send (one group failed) is logged loudly, not retried mid-day.
const COLLECTION = 'eodReport';
const STATE_KEY = 'state';

// Three fits a phone line; the widest live group holds nine, and a full list wraps past the point
// anyone reads it.
const SCOPE_TOKENS_SHOWN = 3;

// Emoji line-leaders - one per field, each an ANCHOR that lets the reader scan the
// message on a phone, never decoration. Chosen to match the bot's existing WhatsApp
// vocabulary (the price_submitted / won / lost templates in waTemplates.js already
// speak this language: money, trophy, rank medal, margin chart), so the evening
// report reads as the same product as the per-load alerts the group saw all day.
// Written as unicode ESCAPES so the source file stays ASCII per repo convention;
// only the rendered message carries the glyphs, and log lines never do. The verdict
// pair (check / warning) stays mood-matched so a degraded evening can never look
// cheerful in the chat-list preview.
const EMOJI_OK = '\u{2705}';            // green check - active-day verdict
const EMOJI_WARN = '\u{26A0}\u{FE0F}';  // warning sign - degraded (could-not-read) report
const E_INQ = '\u{1F4E9}';              // incoming envelope - inquiries came in
const E_PRICED = '\u{1F4B0}';           // money bag - loads the desk priced + bid on
const E_MISSED = '\u{23F3}';            // hourglass - missed the pricing cutoff
// Auctions still running. The chequered flag (E_CLOSED, "auctions closed - result in")
// it replaces is retired: the finished state no longer gets a line of its own, only the
// UNFINISHED one does. A second hourglass would have read as the missed-cutoff anchor
// two blocks down, so this is the arrows-in-a-circle "still going round" glyph instead -
// one glyph per field is what makes the message scannable.
const E_LIVE = '\u{1F504}';             // arrows in a circle - auctions still running
const E_WON = '\u{1F3C6}';              // trophy - won (matches the won template)
const E_LOST = '\u{1F4C9}';             // chart down - lost (matches the lost template)
const E_RANK = '\u{1F3C5}';             // medal - where we finished on a loss
// Question mark - a load we bid on whose end we never saw. Its own glyph rather than the warning
// sign: nothing is broken and nothing was necessarily lost, so the degraded-report anchor would
// overstate it, and it must not share an anchor with won or lost when the whole point is that it is
// neither.
const E_UNKNOWN = '\u{2753}';
const E_VALUE = '\u{1F4B5}';            // banknote - won value (unconfirmed)
const E_MARGIN = '\u{1F4CA}';           // bar chart - margin % (matches the won template)
const E_RESP = '\u{23F1}\u{FE0F}';      // stopwatch - desk response speed
const E_NOW = '\u{1F4CC}';              // pushpin - the point-in-time "right now" line
// Round pushpin - the plants this group covers. A different glyph from E_NOW's flat pushpin
// because both sit in the same message.
const E_SCOPE = '\u{1F4CD}';

// Every glyph the rendered message can carry - the single source of truth the tests
// use to assert the output is ASCII outside this deliberate set (no stray non-ASCII).
const MSG_EMOJI = [
  EMOJI_OK, EMOJI_WARN, E_INQ, E_PRICED, E_MISSED, E_LIVE,
  E_WON, E_LOST, E_RANK, E_UNKNOWN, E_VALUE, E_MARGIN, E_RESP, E_NOW, E_SCOPE,
];

/** Epoch ms of the most recent HH:MM IST at-or-before `now` - the day-window end.
 *  The window is then [end - 24h, end): "since 8 pm yesterday, up to 8 pm today". */
function windowEndAt(now, { h, m }) {
  let t = istMidnight(now) + (h * 60 + m) * 60000;
  if (t > now) t -= DAY_MS;
  return t;
}

/** '8 pm' / '7:30 am' - the human slot time for the report footer. */
function fmtSlot({ h, m }) {
  const ap = h < 12 ? 'am' : 'pm';
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`;
}

/**
 * The (portal, loadId) join key shared by both EOD collectors. A loadId alone is not an identity:
 * SP's numeric ids and GoComet's enquiry keys are both unvalidated String() casts of a vendor
 * field, so keying the closedBids lookup on it would let one portal's row answer for another's.
 * platformOf resolves an absent platformKey to SuperProcure, which is what keeps every untagged
 * pre-GoComet record on both sides joining exactly as it always did.
 */
function loadKey(record, id) {
  return `${platformOf(record)}\u0000${String(id)}`;
}

const finite = (v) => v != null && Number.isFinite(Number(v));

/**
 * Is this load's pricing basis a known TRUCK count - i.e. may a per-vehicle price
 * be multiplied by `units` to get a freight value? Mirrors directorEod.js's
 * isTruckBasis exactly (kept local rather than imported - directorEod.js already
 * requires this module, so importing back would be circular). PMT means `units`
 * is a tonnage quantity, never a truck count; a null/absent quoteType is "basis
 * not recorded", not "FTL", and also reads false so an unrecorded basis can never
 * inflate a money figure the desk reads.
 */
function isTruckBasis(load) {
  const quote = load && load.quoteType != null ? String(load.quoteType).trim().toUpperCase() : '';
  return quote !== '' && quote !== 'PMT';
}

/** Median of a numeric list (even count -> mean of the two middles); null when empty. */
function median(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Indian-style compact rupees, ASCII only: 'Rs 2.5Cr' / 'Rs 1.4L' at a lakh and
 * above (1dp, trailing .0 trimmed), plain Indian-grouped rupees below ('Rs 45,000',
 * via the same fmtNum every other template uses). Freight people read lakh/crore,
 * not millions - and 'Rs' stays ASCII where the currency glyph would not.
 */
function fmtRsCompact(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return 'Rs -';
  const one = (x) => { const s = x.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
  if (v >= 1e7) return `Rs ${one(v / 1e7)}Cr`;
  if (v >= 1e5) return `Rs ${one(v / 1e5)}L`;
  return `Rs ${fmtNum(v)}`;
}

/**
 * Resolve which groups get a report, dynamically from the model - never a
 * hardcoded list. A group qualifies with: an enabled person record whose phone is
 * a group JID, and at least one enabled assignment to an enabled customer with
 * aliases. Everything else is skipped with a debug line (a customer without a
 * group simply gets no EOD - that is configuration, not an error). A group
 * assigned to several customers reports the union of their loads under a joined
 * label (rare, but the model allows it and silently dropping one customer's data
 * would be worse).
 */
async function resolveGroups({ personStore, customerStore, assignmentStore }) {
  const [people, customers, assignments] = await Promise.all([
    personStore.list(), customerStore.list(), assignmentStore.list(),
  ]);
  const custById = new Map((customers || []).filter((c) => c && c.enabled !== false).map((c) => [c.customerId, c]));
  const byPerson = new Map();
  for (const a of (assignments || [])) {
    if (!a || a.enabled === false) continue;
    if (!byPerson.has(a.personId)) byPerson.set(a.personId, []);
    byPerson.get(a.personId).push(a);
  }
  const groups = [];
  for (const p of (people || [])) {
    if (!p || p.enabled === false || !isGroupJid(p.phone)) continue;
    const myAssignments = byPerson.get(p.personId) || [];
    const custs = myAssignments.map((a) => custById.get(a.customerId)).filter(Boolean);
    if (!custs.length) {
      // D024: a disabled assignment collapsing a group to zero customers is exactly the shape that
      // let one group generate real, unanswered pricing volume for weeks with no trace anyone would
      // ever see - debug is invisible unless verbose logging happens to be on. Warn, so it surfaces
      // in ordinary pm2 logs.
      log.warn(`eod report: group '${p.name || p.personId}' has no enabled customer assignment - skipped`, { personId: p.personId });
      continue;
    }
    const aliases = [...new Set(custs.flatMap((c) => c.aliases || []))].filter(Boolean);
    if (!aliases.length) {
      // Empty aliases would match EVERY load under scopeMatches' empty-scope rule -
      // a firehose report is worse than none, so skip and say so.
      log.debug(`eod report: group '${p.name || p.personId}' resolves to a customer with no aliases - skipped`, { personId: p.personId });
      continue;
    }
    groups.push({
      personId: p.personId, name: p.name || null, jid: p.phone,
      label: custs.map((c) => c.label).join(' + '),
      aliases,
      // Copied off the person record the same way model/project.js:toRecipientRows builds the
      // routing row, so the report's scope and the day's alert scope are the same two arrays.
      origins: (p.originScope || []).slice(),
      branches: (p.branchScope || []).slice(),
      // CW-240 desk scorecard's "no owner set" marker - true iff any of this group's enabled
      // assignments designates an enabled owner (assignmentStore.js's `owner: true`).
      owner: myAssignments.some((a) => a.owner === true),
    });
  }
  return groups;
}

/**
 * The three keys scopeMatches reads, off a price-request's load snapshot. Written as the same
 * expressions Notifier._priceNeededData and engineAlerts.outcomeScopeKeys use, because a report
 * that read the origin from a different field than the ask did would disagree with it.
 */
function loadScopeKeys(load) {
  return {
    shipper: (load && load.companyName) || '',
    origin: (load && load.lane && load.lane.origin) || '',
    branch: (load && load.branchName) || '',
  };
}

/**
 * In-window loads owned by a reporting group's CUSTOMER that no group's narrowing claimed - the
 * gap narrowing itself opens. With every scope empty this is empty by construction; once a
 * customer is split by origin, a load from a plant nobody holds a token for lands in no report at
 * all, and the desk has no way to notice. Surfaced as a log line, never repaired here: which desk
 * should own a new plant is the operator's call.
 */
async function unclaimedLoads({ requests, groups, windowStart, windowEnd }) {
  const scoped = (groups || []).map((g) => ({
    customer: { origins: [], shippers: g.aliases, branches: [] },
    group: { origins: g.origins || [], shippers: g.aliases, branches: g.branches || [] },
  }));
  if (!scoped.length) return [];
  const all = await requests.listAll();
  const out = [];
  for (const r of (all || [])) {
    if (!r || !r.load) continue;
    if (r.createdAt == null || r.createdAt < windowStart || r.createdAt >= windowEnd) continue;
    const keys = loadScopeKeys(r.load);
    if (!scoped.some((s) => scopeMatches(s.customer, keys))) continue;
    if (scoped.some((s) => scopeMatches(s.group, keys))) continue;
    out.push({ loadId: r.loadId, shipper: keys.shipper, origin: keys.origin });
  }
  return out;
}

/**
 * One customer's day, over [windowStart, windowEnd). Definitions (stated because
 * the client's spine words are ambiguous and these are the choices made):
 *
 *   inquiries    = price requests CREATED in the window whose load companyName
 *                  matches the customer's aliases (discovery opens exactly one
 *                  request per in-scope load, so created = discovered).
 *   pricedCount  = of those inquiries, the loads the desk actually captured a cost for
 *                  (capturedAt != null) - what the rendered "Priced" line counts (D073). NOT the
 *                  same population as participated below: a captured load can still fail to bid
 *                  (a refusal, a ceiling gate), and a load can in principle land a bid the desk
 *                  never formally captured (a rate-model or restored plan) - the two numbers are
 *                  allowed to differ and both are reported for what they actually are.
 *   participated = of those inquiries, the loads we placed at least one bid on
 *                  (the closedBids doc for that loadId holds a non-empty ourBids).
 *                  Cohort-based on purpose so participation rate and winning rate
 *                  describe the SAME population the first line counted.
 *   decided      = participated loads whose auction has closed; won/lost split
 *                  from the doc's won flag. Still-open participated loads are
 *                  reported as "still live", never counted as losses, and the
 *                  winning rate divides by decided only ('-' when none decided).
 *   weighted margin = total margin amount / total cost across participated loads
 *                  with a captured cost and a final bid, i.e. sum(finalBid - cost)
 *                  / sum(cost) - each load's house margin ((bid - cost) / cost)
 *                  weighted by the load's value, so one big load
 *                  counts for what it is worth and a tiny load cannot skew the
 *                  number. cost = the BID-TIME cost (bidTimeCost.resolveBidTimeCost,
 *                  the same anchor engineAlerts uses for the won/lost receipt), never
 *                  the doc's current cost - G-CC11, so a load cannot read one margin
 *                  on its receipt and a different one here. Final bid = the doc's lastBidPrice (the FINAL rung
 *                  that stood), never a sum over rungs.
 *   won value    = sum of the final accepted bid (lastBidPrice) over the WON
 *                  loads - the freight value at close (rank 1); allotment is a
 *                  separate, later SuperProcure state this bot does not track,
 *                  so this is NOT confirmed/banked revenue. Scaled by unit count
 *                  on a known truck basis only (see isTruckBasis below) - a PMT
 *                  load or one whose basis was never recorded contributes its
 *                  bid price alone, never a fabricated per-truck total.
 *   total value bid = the same per-load figure (final bid, scaled the same way)
 *                  summed over EVERY participated load regardless of outcome -
 *                  won, lost, or still bidding. This is what the desk quoted and
 *                  bid on, not revenue: a lost bid never became freight moved,
 *                  so this is reported as "total value bid", never "handled".
 *   lost ranks   = the finalRank of each lost load that has one (socket rank
 *                  tracking). ONLY the rank: SuperProcure masks competitor
 *                  amounts, so a "lost by Rs X" gap would be invented data.
 *   median response = median ms from price-request creation to cost capture
 *                  over the cohort's priced loads; null under 2 samples (one
 *                  capture presented as a "median" overstates what we know).
 *
 * Known edge (accepted): a load found late in the window and bid AFTER 8 pm shows
 * as not-participated tonight and is not re-counted tomorrow (tomorrow's cohort is
 * created-tomorrow only). Same-day close dominates SP hard-close loads, so the
 * window split loses little; a "carried over" line can be added if it ever bites.
 *
 * THE COHORT IS ALL-PORTAL, and the loadId join is what keeps that safe. Until 2026-08-12 this
 * function took a single `platformKey` and production passed config.platformKey, which is 'sp' -
 * so a customer whose loads run on the OTHER portal was invisible to its own report. That is not
 * hypothetical: BRL's GoComet board carries exactly one shipper (Waaree), its group
 * "BRL Bids . GC . Waaree" was resolved and sent a message on 2026-08-12, and the message read
 * "no loads today, all quiet" on a day that surfaced 88 Waaree loads, 55 of which missed the
 * pricing cutoff. A customer group told nothing happened is worse than any mixing the filter
 * prevented, and the filter could never have been right here anyway: the correct scope for a
 * customer's report is the portals that customer actually runs on, which is a property of its
 * rows, not of the process default.
 *
 * The reason the filter existed is preserved WITHOUT excluding anything. It guarded the
 * loadId -> closedBids join, because SP loadIds and GoComet enquiry keys are both unvalidated
 * String() casts of a vendor field and nothing here can hold them distinct. So the join key is now
 * (portal, loadId) rather than loadId alone: a request only ever resolves the doc its own portal
 * wrote, and a cross-portal id collision cannot produce a false participation, win or margin
 * number even though both portals' rows are now in scope.
 *
 * @param {Object} params - Input dependencies and window bounds.
 * @param {Object} params.requests - Price-request reader (listAll()).
 * @param {Object} params.store - Doc store used to read the closed-bids collection.
 * @param {string[]} params.aliases - The customer's shipper aliases (scopeMatches attribution).
 * @param {string[]} [params.origins] - The group's own originScope; empty/absent = every origin.
 * @param {string[]} [params.branches] - The group's own branchScope; empty/absent = every branch.
 * @param {number} params.windowStart - Epoch ms, inclusive start of the rolling report window.
 * @param {number} params.windowEnd - Epoch ms, exclusive end of the rolling report window.
 * @param {number} params.now - Current epoch ms - the "right now" (point-in-time) lines' anchor.
 * @returns {Promise<Object>} The day's metrics (inquiries, participated, won, lostDecided,
 *   decided, stillLive, missedCutoff, awaiting, armedTonight, weightedMarginPct, wonValue,
 *   totalBidValue, lostRanks, medianResponseMs) per the definitions above.
 */
async function collectCustomerDay({ requests, store, aliases, origins, branches, windowStart, windowEnd, now }) {
  // The routing predicate itself (scopeMatches) so attribution == alert routing.
  const scope = { origins: origins || [], shippers: aliases, branches: branches || [] };
  const mine = (load) => scopeMatches(scope, loadScopeKeys(load));
  const inWindow = (ts) => ts != null && ts >= windowStart && ts < windowEnd;

  const allReqs = await requests.listAll();
  const myReqs = (allReqs || []).filter((r) => r && r.load && mine(r.load));
  const cohort = myReqs.filter((r) => inWindow(r.createdAt));
  const missedCutoff = cohort.filter((r) => r.status === 'skipped_no_price').length;
  // D073: the loads the desk actually PRICED (a cost was captured) - the label the rendered
  // "*Priced*" line carries. NOT the same population as `participated` below (a load the desk
  // priced whose bid the engine then failed to place - a refusal, a ceiling gate - is priced but
  // never participated; a load found without ever landing a bid attempt should not be able to
  // claim it was priced when it was not).
  const pricedCount = cohort.filter((r) => r.capturedAt != null).length;
  // "right now" lines are point-in-time (at send), not window-bound.
  const awaiting = myReqs.filter((r) => r.status === 'awaiting_price').length;
  // The LIVE close (priceRequests.effectiveCloseAt), never the discovery-time snapshot alone - a
  // load whose snapshot close already passed but whose auction extended is still armed tonight
  // (C069: the snapshot going stale mid-extension used to under-report this count).
  const armedTonight = myReqs.filter((r) => r.status === 'armed' && effectiveCloseAt(r.load) != null && effectiveCloseAt(r.load) > now).length;

  const rawDocs = await store.listDocs(BIDLOG_COLLECTION);
  const docByLoad = new Map((rawDocs || []).filter(Boolean).map((d) => [loadKey(d, d.auctionId), d]));

  let participated = 0, won = 0, lostDecided = 0, stillLive = 0;
  // Bid, end never seen. Tracked separately so it is out of BOTH won and lostDecided rather than
  // silently absorbed by either - see the branch that sets it.
  let closedUnknown = 0;
  // B112 (ruling 29): loss causes that separate the engine's OWN failures from a genuine
  // competitive loss, off the closed-bids record's own resultReason (util/reportedClose.js).
  let timingLoss = 0, holdUndercutLoss = 0;
  let marginAmount = 0, costTotal = 0, marginBase = 0;
  let wonValue = 0, totalBidValue = 0;
  const lostRanks = [];
  for (const r of cohort) {
    const doc = docByLoad.get(loadKey(r, r.loadId));
    if (!doc || !(doc.ourBids || []).length) continue;
    participated += 1;
    const finalBid = doc.lastBidPrice != null ? Number(doc.lastBidPrice) : null;
    // Scale by unit count ONLY on a known truck basis (see isTruckBasis) - a PMT
    // load or one whose basis was never recorded contributes its bid price alone
    // rather than a fabricated total (mirrors directorEod.js's winningBidValue).
    const units = isTruckBasis(r.load) && finite(doc.units) && Number(doc.units) > 0
      ? Number(doc.units)
      : 1;
    if (finalBid != null && Number.isFinite(finalBid)) totalBidValue += finalBid * units;
    if (doc.status === 'closed') {
      const outcome = closedOutcome(doc);
      if (outcome === 'won') {
        won += 1;
        // On a win our final bid IS the accepted freight value (we are rank 1).
        if (finalBid != null && Number.isFinite(finalBid)) wonValue += finalBid * units;
      } else if (outcome === 'closed_unknown') {
        // Neither won nor lost: `lostDecided` feeds the customer's own win-rate line, and booking a
        // result we never saw there charges the customer a loss we cannot evidence.
        closedUnknown += 1;
      } else {
        lostDecided += 1;
        // Rank only - SP masks competitor amounts, so rank is ALL we truthfully have.
        if (doc.finalRank != null && Number.isFinite(Number(doc.finalRank))) lostRanks.push(Number(doc.finalRank));
        if (doc.resultReason === 'lost_on_timing') timingLoss += 1;
        else if (doc.resultReason === 'hold_undercut') holdUndercutLoss += 1;
      }
    } else {
      stillLive += 1;
    }
    // The BID-TIME cost (bidTimeCost.resolveBidTimeCost), the same anchor the won/lost receipt uses
    // (engineAlerts.outcomeEnrichment via bidTimeBand) - G-CC11: before this, one load could read
    // +9% on its receipt and -16.82% here, with neither surface saying which cost it used. Falls
    // back to the doc-level cost on the ~3,136 legacy rows with no snapshot, same order as the
    // receipt's fallback, so this can never disagree with it about which epoch's cost applies.
    //
    // It is NOT a backstop for the receipt's per-load correction trail. This is one aggregate per
    // customer day and cannot name the load whose rate moved; the per-load receipt does
    // (engineAlerts.outcomeEnrichment -> waTemplates.rateChangedLine / wonCostAlert).
    const cost = resolveBidTimeCost(doc);
    if (cost != null && cost > 0 && finalBid != null) {
      marginAmount += finalBid - cost;
      costTotal += cost;
      marginBase += 1;
    }
  }
  // Pricing-desk response time: creation -> capture, over the cohort's priced loads.
  const responseTimes = cohort
    .filter((r) => r.capturedAt != null && r.createdAt != null)
    .map((r) => r.capturedAt - r.createdAt)
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const decided = won + lostDecided;
  return {
    ok: true,
    inquiries: cohort.length, participated, pricedCount, won, lostDecided, closedUnknown, decided, stillLive,
    missedCutoff, awaiting, armedTonight,
    // B112: timingLoss/holdUndercutLoss are the two genuine loss-cause classes for the EOD, off
    // the closed-bids doc's own resultReason above. The unpriced count is the existing
    // missedCutoff field itself - no separate alias.
    timingLoss, holdUndercutLoss,
    weightedMarginPct: costTotal > 0 ? (marginAmount / costTotal) * 100 : null,
    marginBase, // how many loads the margin line rests on (0 -> render '-')
    wonValue,
    totalBidValue,
    lostRanks,
    // null under 2 samples - a single capture reported as "the median" overstates it.
    medianResponseMs: responseTimes.length >= 2 ? median(responseTimes) : null,
  };
}

/**
 * Render one group's message, mobile-first for a narrow WhatsApp column: a verdict
 * line the chat-list preview shows before the chat is opened, then three glanceable
 * blocks with a blank line between them - funnel in (inquiries -> priced -> missed
 * cutoff), outcomes (still bidding -> won / lost by rank), and quality (won value, margin,
 * desk speed) - each fact on its own emoji-led line so nothing wraps mid-thought.
 * Every number and value is identical to the old layout; only the presentation and
 * the wording changed. Quiet day = ONE short line (no blocks, no footer, no emoji);
 * degraded = a warning line that never looks cheerful.
 */
function renderEodReport({ label, day, slot, origins, branches }, now) {
  const date = istDisplayDate(now);
  const scope = scopeLabel(origins, branches);
  const quiet = !day.inquiries && !day.participated && !day.decided && !day.stillLive
    && !day.awaiting && !day.armedTonight;
  // The quiet day has no numbers, so without this there is nothing at all to tell siblings apart.
  if (quiet) {
    return scope
      ? `*${label}* (${scope.line}) - no loads today, all quiet (${date})`
      : `*${label}* - no loads today, all quiet (${date})`;
  }

  const pct = (num, den) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '-');
  const lines = [];

  // --- verdict / chat-list glance -------------------------------------------
  // One clean headline (no longer two denominators on one line, the old
  // "30 loads, won 3 of 10 closed"): the bare win ratio once anything has a result,
  // otherwise the loads-in count so an evening before any result still says
  // something. This is the line WhatsApp shows in the chat list before the message
  // is opened, so it is the most-read line in the product and it gets the fewest
  // words. No noun after the denominator: "won 4 of 12" already reads as four wins
  // out of twelve results, and the two candidates both earned their cut - "closed"
  // was the word the director misread, and "finished" only restated what the number
  // says. While auctions are live the denominator is the settled subset, but the
  // "N still bidding" and "so far" lines below carry that - saying it a third time
  // here is noise. It stays a REAL ratio, wins over decided: never an N-of-N, which
  // is exactly the emptiness removed from the outcomes block below.
  const headline = day.decided
    ? `won ${day.won} of ${day.decided}`
    : `${day.inquiries} load${day.inquiries === 1 ? '' : 's'} in`;
  lines.push(`${EMOJI_OK} *${label} - end of day: ${headline}* (${date})`);
  if (scope) lines.push(`${E_SCOPE} _${scope.line}_`);

  // --- block 1: funnel in ---------------------------------------------------
  // "Priced" (D073: loads the desk actually captured a cost for - matches the label, unlike the
  // old "participated" substitution) and its complement "Missed cutoff", both as a share of the
  // day's inquiries so the funnel reads as one thought: 30 in, 10 priced, 20 missed.
  lines.push('');
  lines.push(`${E_INQ} *Inquiries* - ${day.inquiries}`);
  lines.push(`${E_PRICED} *Priced* - ${day.pricedCount} of ${day.inquiries} (${pct(day.pricedCount, day.inquiries)})`);
  if (day.missedCutoff) lines.push(`${E_MISSED} *Missed cutoff* - ${day.missedCutoff} of ${day.inquiries}`);

  // --- block 2: outcomes (only when we actually bid on something) -----------
  // The UNFINISHED state is the only thing worth announcing here. The old line
  // ("Closed - 12 of 12 priced") reported the finished count, which on a normal
  // evening is every load we priced - the client's director read it and it told him
  // nothing, because "12 of 12" is a fact about a day that went as expected. It only
  // ever carried information when some auctions were still running, so that is now
  // the only case it renders in, and it says the running part out loud instead of
  // making the reader subtract. "Closed" is also the wrong word for a customer's ops
  // team: a closed load, a closed deal and a closed (won) auction are three different
  // things in freight, and only one of them is what we meant.
  //
  // Counting is untouched: still-open priced loads are never losses, and the win rate
  // still divides by DECIDED only (the definitions block above) - it just carries a
  // "so far" while auctions are live, so nobody quotes tonight's percentage as final.
  // Rendered only when participated > 0 - a day we bid on nothing has no outcomes to
  // show (and participated>0 is what makes decided / stillLive reachable at all).
  if (day.participated > 0) {
    lines.push('');
    // Leads the block: what is not settled yet, before any number that could be
    // mistaken for a result.
    if (day.stillLive) lines.push(`${E_LIVE} *${day.stillLive} still bidding* - not final yet`);
    if (day.decided) {
      const soFar = day.stillLive ? ' so far' : '';
      lines.push(`${E_WON} *Won* - ${day.won} of ${day.decided}${soFar} (${pct(day.won, day.decided)})`);
      // Same caveat the Won-value line below already carries, and for the identical reason:
      // a won load here is rank 1 at close, not a confirmed SuperProcure award.
      if (day.won > 0) lines.push('_rank 1 at close, award not confirmed yet_');
    } else if (!day.stillLive && !day.closedUnknown) {
      // Nothing decided and nothing running - no denominator exists, so no rate. Excluded when
      // unknowns exist, because "none yet" reads as still-pending on a day whose auctions DID close.
      lines.push(`${E_WON} *Won* - none yet`);
    }
    // Neither won nor lost, so it gets its own line rather than being absorbed by either. The
    // collector has counted it since this class existed; nothing rendered it, so the customer's
    // message silently omitted the rows and its buckets stopped reconciling with Priced.
    if (day.closedUnknown) {
      lines.push(`${E_UNKNOWN} *Result not seen* - ${day.closedUnknown}`);
      lines.push('_we could not see how these ended_');
    }
    // Where we FINISHED on losses, ONE rank per line so a long breakdown never wraps
    // mid-thought on a phone. Rank only - SP masks competitor amounts, so a rupee gap
    // would be invented. Omitted entirely when no lost load carries a rank.
    const ranked = (day.lostRanks || []).slice().sort((a, b) => a - b);
    if (day.lostDecided > 0 && ranked.length) {
      const byRank = new Map();
      for (const r of ranked) byRank.set(r, (byRank.get(r) || 0) + 1);
      lines.push(`${E_LOST} *Lost* - ${day.lostDecided}`);
      for (const [r, c] of byRank) lines.push(`${E_RANK} rank ${r} - ${c}`);
      // B112 (ruling 29): separates a genuine competitive loss from the engine's OWN failure
      // modes, so the desk knows it was outbid on margin rather than beaten on time or by its own
      // pause. Rendered only when either count is nonzero - most days have neither.
      if (day.timingLoss || day.holdUndercutLoss) {
        const parts = [];
        if (day.timingLoss) parts.push(`${day.timingLoss} lost on timing (our fault)`);
        if (day.holdUndercutLoss) parts.push(`${day.holdUndercutLoss} held then undercut`);
        lines.push(`_${parts.join(', ')}_`);
      }
    }
  }

  // --- block 3: quality - two visual groups -------------------------------
  // Every qualifier that used to sit in a trailing parenthetical is now its own
  // italic SUB-LINE (no brackets), so nothing wraps mid-thought on a narrow phone
  // and each fact reads as one line + its note.
  const quality = [];
  // Group A - won value + its unconfirmed-award caveat. NOT banked revenue:
  // SuperProcure confirms the actual award later and this bot does not track that,
  // so the caveat stays - rank 1 is not a confirmed win (23167278).
  if (day.wonValue > 0) {
    quality.push(`${E_VALUE} *Won value* - ${fmtRsCompact(day.wonValue)}`);
    quality.push('_rank 1 at close, award not confirmed yet_');
  }
  // Second, separately-labelled total: every load we bid on, won or not. Never
  // folded into "Won value" and never called "handled" - a lost bid never became
  // freight moved, so this is what the desk quoted and bid on, not revenue (T18).
  if (day.totalBidValue > 0) {
    quality.push(`${E_VALUE} *Total value bid* - ${fmtRsCompact(day.totalBidValue)}`);
    quality.push('_all loads bid on today, won or not_');
  }
  // Group B - margin + desk speed. Margin is weighted BY LOAD VALUE (so one big load
  // counts for what it is worth and a tiny load cannot skew it); that qualifier is
  // the "_weighted by load value_" sub-line, replacing the bare "Weighted margin".
  // Never dropped on an active bidding day; a bid day with no captured cost says
  // "not available today" (a single line, no sub-line). Desk speed is the median
  // over mean (one slow morning must not define the day); whole minutes, floored at 1
  // so a fast desk never reads "~0 min"; the "_median_" sub-line names the statistic.
  //
  // The anchor label (G-CC11) - stated plainly, once, only where a margin number is actually on
  // the screen. Without it neither this line nor the receipt says which cost it used, which is how
  // one load read +9% on its receipt and -16.82% here with nobody able to tell which was wrong.
  const perf = [];
  if (day.participated > 0) {
    if (day.marginBase > 0 && day.weightedMarginPct != null) {
      perf.push(`${E_MARGIN} *Margin* - ${day.weightedMarginPct.toFixed(1)}%`);
      perf.push('_weighted by load value_');
      perf.push('_Margins measured at the cost when each bid was placed._');
    } else {
      perf.push(`${E_MARGIN} *Margin* - not available today`);
    }
  }
  if (day.medianResponseMs != null) {
    perf.push(`${E_RESP} *Desk response* - ~${Math.max(1, Math.round(day.medianResponseMs / 60000))} min`);
    perf.push('_median_');
  }
  // One blank line between the two groups, only when both are present, so "Won value"
  // gets its own block and never runs straight into "Margin".
  if (quality.length && perf.length) quality.push('');
  quality.push(...perf);
  if (quality.length) { lines.push(''); lines.push(...quality); }

  // --- right now: the point-in-time snapshot the desk can act on ------------
  const rightNow = [];
  if (day.armedTonight) rightNow.push(`${day.armedTonight} armed for tonight`);
  if (day.awaiting) rightNow.push(`${day.awaiting} awaiting price`);
  if (rightNow.length) { lines.push(''); lines.push(`${E_NOW} *Right now* - ${rightNow.join(', ')}`); }

  // --- footer: two short italic lines - what this is, then the rolling window
  // it covers. "Last 24h" says it plainly; the old "(yesterday 8 pm to today 8 pm)"
  // parenthetical was redundant once we say 24h, and it wrapped, so it is dropped.
  lines.push('');
  lines.push(`_Automated report for ${label} loads${scope ? ` from ${scope.covers}` : ''}._`);
  lines.push('_Last 24h._');
  return lines.join('\n');
}

/** The never-cheerful fallback when one group's data could not be read. */
function renderDegraded(label, now, origins, branches) {
  const scope = scopeLabel(origins, branches);
  const who = scope ? `${label} (${scope.line})` : label;
  return `${EMOJI_WARN} *${who}* - the end-of-day report could not read today's records (${istDisplayDate(now)})\n`
    + 'Bidding may still be running normally - please have it checked.';
}

/**
 * What THIS group's report covers - the line that tells sibling desks apart. #208 gave a split
 * customer's groups their own numbers but every one still opened with the customer's label, so
 * Waaree's three desks read "Waaree - end of day" over three different sets of them and BRL's
 * director reported the report as un-split a week after it was split.
 *
 * Read off the scope arrays, NOT the WhatsApp group name: the names are not a reliable key (of 25
 * live groups, 16 carry no portal segment, five carry "SP", three "GC", one separates with a
 * period instead of a middot), and renaming a group in WhatsApp must not change what its report
 * claims to cover.
 *
 * Only each word's first letter is touched, so a lowercase origin token title-cases while an
 * already-cased branch token ("Alwar Cable (1350)") survives intact.
 *
 * @param {string[]} [origins] - The group's originScope; plant/pickup substrings.
 * @param {string[]} [branches] - The group's branchScope; BRL's own branch names.
 * @returns {?{line: string, covers: string}} null for an un-narrowed group, which renders
 *   byte-for-byte as it did before this existed.
 */
function scopeLabel(origins, branches) {
  const o = (origins || []).filter(Boolean);
  const b = (branches || []).filter(Boolean);
  const tokens = o.concat(b);
  if (!tokens.length) return null;
  const cased = tokens.map((t) => String(t).split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' '));
  const shown = cased.slice(0, SCOPE_TOKENS_SHOWN);
  const rest = cased.length - shown.length;
  // A branch group told it covers "plants" would be plainly wrong to its desk. The determiner
  // travels with the noun because the footer cannot agree on its own - that is how "from these
  // plant" once reached a one-plant group.
  const plural = tokens.length > 1;
  const noun = o.length ? (plural ? 'plants' : 'plant') : (plural ? 'branches' : 'branch');
  return { line: shown.join(', ') + (rest ? ` +${rest} more` : ''), covers: `${plural ? 'these' : 'this'} ${noun}` };
}

/**
 * One EOD run: resolve groups -> per group, gather + render + send (each group
 * isolated - one customer's broken data or failed send never costs another group
 * its report). State (sentDate for the catch-up dedupe) is written when at least
 * one group was actually reached.
 */
async function runEodReport(deps) {
  const now = deps.now != null ? deps.now : Date.now();
  const cfg = (deps.config && deps.config.eodReport) || {};
  const slotTime = parseTimeIST(cfg.timeIST, { h: 20, m: 0 });
  const windowEnd = windowEndAt(now, slotTime);
  const windowStart = windowEnd - DAY_MS;
  const slot = fmtSlot(slotTime);

  let groups = [];
  try {
    groups = await resolveGroups(deps);
  } catch (e) {
    log.error('eod report could not resolve the customer groups - nothing sent this evening', { err: e });
    return { sent: 0, groups: 0 };
  }
  if (!groups.length) {
    log.debug('eod report: no customer groups with assignments exist - nothing to send');
    return { sent: 0, groups: 0 };
  }

  let sent = 0;
  const messages = []; // returned for tests/preview tooling only
  for (const g of groups) {
    let message;
    try {
      const day = await collectCustomerDay({
        requests: deps.requests, store: deps.store,
        aliases: g.aliases, origins: g.origins, branches: g.branches,
        windowStart, windowEnd, now,
      });
      message = renderEodReport({ label: g.label, day, slot, origins: g.origins, branches: g.branches }, now);
    } catch (e) {
      log.error(`eod report could not gather ${g.label}'s day - sending the degraded message`, { err: e });
      message = renderDegraded(g.label, now, g.origins, g.branches);
    }
    const res = await deps.notifier.sendDirect(g.jid, message, { kind: 'eod_report', name: g.name || g.label });
    if (res && res.ok) sent += 1;
    else log.error(`eod report send to group '${g.label}' failed`, { group: g.label });
    messages.push({ group: g.label, jid: g.jid, message });
  }
  if (!sent) log.error(`eod report send failed for all ${groups.length} group(s) - no evening report went out`, { groups: groups.length });
  else log.info(`eod report sent to ${sent}/${groups.length} customer group(s)`, { sent, groups: groups.length });

  try {
    const unclaimed = await unclaimedLoads({ requests: deps.requests, groups, windowStart, windowEnd });
    if (unclaimed.length) {
      log.error(`eod report: ${unclaimed.length} load(s) matched a reporting customer but no group's scope - they are in nobody's evening report`, {
        count: unclaimed.length,
        sample: unclaimed.slice(0, 10).map((u) => `${u.loadId} <- ${u.origin || '(no origin)'}`),
      });
    }
  } catch (e) {
    log.error('eod report could not check for unclaimed loads', { err: e });
  }

  try {
    const patch = { lastRunAt: now };
    if (sent > 0) patch.sentDate = istDayStamp(now);
    await deps.store.patchDoc(COLLECTION, STATE_KEY, patch);
  } catch (e) {
    log.error('eod report could not persist its state', { err: e });
  }
  return { sent, groups: groups.length, messages };
}

/** Start the 20:00-IST daily schedule on the shared rail. Returns { stop() }; null when disabled. */
function startDailyEodReport(deps) {
  const cfg = (deps.config && deps.config.eodReport) || {};
  return startDailyISTTask({
    label: 'eodReport',
    enabled: !!cfg.enabled,
    timeIST: cfg.timeIST,
    defaultTime: { h: 20, m: 0 },
    alreadyDoneToday: async (now) => {
      const state = await deps.store.getDoc(COLLECTION, STATE_KEY).catch(() => null);
      return !!(state && state.sentDate === istDayStamp(now));
    },
    run: () => runEodReport(deps),
  });
}

module.exports = {
  COLLECTION, STATE_KEY, MSG_EMOJI,
  windowEndAt, fmtSlot, median, fmtRsCompact, loadKey, loadScopeKeys, resolveGroups, isTruckBasis,
  unclaimedLoads, collectCustomerDay,
  scopeLabel, renderEodReport, renderDegraded, runEodReport, startDailyEodReport,
};
