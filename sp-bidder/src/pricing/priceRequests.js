'use strict';

const crypto = require('crypto');
const { buildBandLadder, maxImprovementPrice, floorMarginSubstitution, effectiveFloorMarginPct } = require('../engine/pricing');
const { validateMargins } = require('./marginValidate');
const { resolveBand } = require('./marginResolver');
const { resolveMargin, matchCustomer, resolveRoundPolicy, resolvePreEmptiveFloor } = require('../model/resolve');
const { normalizeTransitDays, MAX_TRANSIT_DAYS } = require('../model/loadRules');
const { redactToken } = require('../util/redactToken');
const { laneEnds } = require('../notify/waTemplates');
// Single source of truth for the pricing-cutoff lead default: config.priceDeadlineLeadMs
// (src/config.js). Only used as the recompute fallback when a caller omits deadlineAt.
const appConfig = require('../config');
const { MAX_PLAUSIBLE_DEADLINE_MS } = require('../platform/realAdapter');
const { createLogger } = require('../logging/logger');

// Module-scoped, for the FREE functions in this file only - the class keeps its injected `this.log`
// seam untouched. armFromRequest has no DI channel and is the last gate before a live-money arm, so
// the alternative to this is a money-path correction with no log line at all.
const log = createLogger('priceRequests');

/**
 * PriceRequestStore — the human-in-the-loop pricing intake (the missing piece the
 * 2026-06-26 reframe identified). The engine already prices off two numbers; what
 * was missing is the async loop: discover a load -> ask the pricing team for a
 * number -> capture it -> arm. This persists one request per load through the store
 * seam, so it survives a restart like everything else.
 *
 * Request lifecycle:
 *   awaiting_price -> armed            (a human captured the cost in time)
 *                  -> skipped_no_price (deadline passed with no number; never bid blind)
 *                  -> closed           (auction ended)
 *
 * The captured number is the operator's COST. The bot bids the configured margin
 * band above it (buildBandLadder) and never below the operating floor (the lowest
 * band rung) - see _research/2026-06-26_floor-vs-prediction-reconciliation-logic.md.
 */

const COLLECTION = 'priceRequests';
const ALIAS_COLLECTION = 'priceTokenAliases';

// The link token. base62 (no '-'/'_') so a single '-' cleanly separates a cosmetic, human-
// readable slug from the token in a pretty URL - tokenFromPath() splits on the LAST '-'. 11
// chars over 62 symbols is ~65 bits (62^11 ~= 5.2e19): YouTube-video-ID length, and it clears
// the OWASP >=64-bit floor for a link that is itself the auth. (Was 18 hex chars / 72 bits -
// same order of entropy, ~40% fewer characters because hex wastes half of every byte.)
const TOKEN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TOKEN_LEN = 11;
function newToken() {
  // Rejection-sample so the 62 symbols stay uniform: a plain byte % 62 would over-weight the
  // first 8 symbols. 248 = 62*4 is the largest multiple of 62 <= 256; discard bytes >= 248.
  let out = '';
  while (out.length < TOKEN_LEN) {
    for (const b of crypto.randomBytes(TOKEN_LEN * 2)) {
      if (b < 248) { out += TOKEN_ALPHABET[b % 62]; if (out.length === TOKEN_LEN) break; }
    }
  }
  return out;
}

// ---- pretty capture/track links: readable slug + the opaque token (Notion-style) -----------
// The slug is COSMETIC and never authoritative - getByToken looks up ONLY the token that
// tokenFromPath() splits off the end, so a wrong / edited / absent slug still resolves (or 404s
// on a bad token) exactly as a bare token does. Kept to STABLE facts (shipper + close DATE): the
// live close time can move on a soft-close extension and the page already shows the countdown,
// so the time is deliberately left out of the URL.
const IST_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const slugPart = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// A cleaned branch segment for the slug, given the customer slug already in the URL and SP's raw
// branchName. Multi-branch shippers (Renewsys REN-K/REN-H, Ashirvad's 9 depots, Havells, KEI)
// share ONE companyName/customerId, so the customer slug alone can't tell their loads apart in a
// capture link; SP's branchName is the distinguisher. COSMETIC, like the rest of the slug. It
// DE-STUTTERS the common case where the branch code repeats the shipper: "REN-K" under customer
// "renewsys", or "Epack Noida" under "epack" - a branch token that equals, or is a >=3-char
// prefix of (or is prefixed by), a customer token is dropped, so "renewsys" + "REN-K" renders
// "renewsys-k", not the stuttering "renewsys-ren-k". Short distinguishers (the "k"/"h"/"u" that
// actually name the branch) never match a customer token, so they survive. Falls back to the full
// branch slug if de-stuttering would empty it (branchName == the customer), and caps at the first
// 3 tokens - SP branch names run long ("Kolkata- Panchla DC") and the slug is decoration, not id.
function branchSlug(customerSlug, branchName) {
  const bslug = slugPart(branchName);
  if (!bslug) return '';
  const custTokens = slugPart(customerSlug).split('-').filter(Boolean);
  const dupOfCustomer = (t) => custTokens.some((c) => {
    if (t === c) return true;
    const [shorter, longer] = t.length < c.length ? [t, c] : [c, t];
    return shorter.length >= 3 && longer.startsWith(shorter);
  });
  const toks = bslug.split('-').filter(Boolean);
  const kept = toks.filter((t) => !dupOfCustomer(t));
  return (kept.length ? kept : toks).slice(0, 3).join('-');
}
function linkSlug(req) {
  const L = (req && req.load) || {};
  const parts = [];
  // Prefer the matched Customer's clean slug (customerId) over the platform's raw companyName.
  // SP company strings arrive as e.g. "BG (BorosilLimited(Govindgarh))", and the first-2-words
  // cut below turned that into "bg-borosillimited-..." in every capture link the pricing desk
  // saw; the customerId is already the canonical [a-z0-9-] slug the console names the entity by
  // ("borosil"). The tag is snapshotted at createForLoad (resolveCustomerTag); when absent (no
  // model match, or a pre-snapshot request) the companyName-derived slug renders unchanged.
  // slugPart() re-applied defensively - idempotent on an already-clean slug.
  const custSlug = req && req.customer && req.customer.customerId ? slugPart(req.customer.customerId) : '';
  const shipper = custSlug || slugPart(L.companyName).split('-').slice(0, 2).join('-'); // first ~2 words keep it short
  if (shipper) parts.push(shipper);
  // Branch segment for multi-branch shippers - between shipper and close-date, so the URL reads
  // shipper -> branch -> day (renewsys-k-8jul-<token>). De-stuttered against the shipper slug
  // just pushed; empty (nothing added) when the load carries no branchName.
  const branch = branchSlug(shipper, L.branchName);
  if (branch) parts.push(branch);
  if (L.closesAt) {
    const day = IST_DAY.format(new Date(L.closesAt)).toLowerCase().replace(/[^a-z0-9]/g, ''); // "8 Jul" -> "8jul"
    if (day) parts.push(day);
  }
  return parts.join('-');
}
// The single path segment that goes in a link: "<slug>-<token>", or just "<token>" when the load
// carries nothing slug-able. The token is ALWAYS the final '-'-delimited chunk.
function publicSeg(req) {
  const slug = linkSlug(req);
  return slug ? `${slug}-${req.id}` : req.id;
}
// Inverse of publicSeg for the router: pull the real token out of a path param that may carry a
// cosmetic slug prefix. The token is base62 (no '-'), so it is the substring after the last '-';
// a bare token (old hex links, internal callers) has no '-' and returns unchanged.
function tokenFromPath(param) {
  const s = String(param == null ? '' : param);
  const i = s.lastIndexOf('-');
  return i === -1 ? s : s.slice(i + 1);
}

const PRUNE_RETENTION_MS = 7 * 86_400_000; // drop requests whose auction closed > 7d ago

// The durable participation ledger (2026-07-24_data-export-filters-scope.md section 7). One
// immutable row per request, appended just before pruneEnded drops it, through the SAME
// append-only seam as the bids jsonl (store.appendEvent -> <logDir>/<stream>-YYYY-MM-DD.jsonl).
// Day files are keyed on WRITE time, which for an archive row is ~7d after the auction it
// describes - every date question is answered from the row's own closesAt/createdAt, never from
// the filename.
const ARCHIVE_STREAM = 'priceRequestArchive';

// How far back the exactly-once seed reads the archive on the first prune of a process. A record
// reaches the archive only once its auction ended > PRUNE_RETENTION_MS ago, and the append is
// followed immediately by its removeDoc - so the only id that can come round a second time is one
// whose removal did not land, and it comes round on the very next tick. Several multiples of the
// retention covers that with room to spare while keeping the seed read bounded as the archive
// passes a year.
const ARCHIVE_DEDUPE_LOOKBACK_MS = 30 * 86_400_000;

// The archive row. An ALLOWLIST, not the whole record: `poster` (a shipper-side contact name and
// mobile) and the free-text `notes` are third-party text on what is now a permanent, backed-up
// surface, which is the exposure src/platform/gocometAdapter.js:212 closes on the bid log for the
// same reason. Everything a participation, funnel or outcome question could need is here - the
// point of the ledger is to answer questions nobody has asked yet, so nothing is dropped for
// being unused by today's export.
function archiveRow(req, endedAt) {
  const L = req.load || {};
  return {
    schema: 1,
    id: req.id,
    loadId: req.loadId,
    loadCode: L.loadCode != null ? L.loadCode : null,
    shipperRef: L.shipperRef != null ? L.shipperRef : null,
    platformKey: platformOf(req),
    account: req.account || null,
    customer: req.customer || null,
    companyName: L.companyName != null ? L.companyName : null,
    branchName: L.branchName != null ? L.branchName : null,
    lane: L.lane || null,
    laneParsed: L.laneParsed || null,
    distanceKm: L.distanceKm != null ? L.distanceKm : null,
    equipment: L.equipment != null ? L.equipment : null,
    shipmentType: L.shipmentType != null ? L.shipmentType : null,
    quoteType: L.quoteType != null ? L.quoteType : null,
    units: L.units != null ? L.units : null,
    loadTotalQuantity: L.loadTotalQuantity != null ? L.loadTotalQuantity : null,
    cargoTypes: L.cargoTypes || null,
    weight: L.weight != null ? L.weight : null,
    weightUnit: L.weightUnit != null ? L.weightUnit : null,
    ceiling: L.ceiling != null ? L.ceiling : null,
    revisionLimit: L.revisionLimit != null ? L.revisionLimit : null,
    softClose: !!L.softClose,
    closeModelKnown: L.closeModelKnown != null ? L.closeModelKnown : null,
    startsAt: L.startsAt != null ? L.startsAt : null,
    closesAt: L.closesAt != null ? L.closesAt : null,
    liveClosesAt: L.liveClosesAt != null ? L.liveClosesAt : null,
    endedAt,
    createdAt: req.createdAt != null ? req.createdAt : null,
    notifiedAt: req.notifiedAt != null ? req.notifiedAt : null,
    reminderSentAt: req.reminderSentAt != null ? req.reminderSentAt : null,
    deadlineAt: req.deadlineAt != null ? req.deadlineAt : null,
    // D026: the first-open signal must survive the prune too, or a scorecard/audit question about
    // an older ask ("was this one ever opened?") goes unanswerable the moment the live record ages
    // off priceRequests.json - the same reasoning D038 already applied to the seven closedBids
    // fields.
    openedAt: req.openedAt != null ? req.openedAt : null,
    capturedAt: req.capturedAt != null ? req.capturedAt : null,
    dismissedAt: req.dismissedAt != null ? req.dismissedAt : null,
    stoppedAt: req.stoppedAt != null ? req.stoppedAt : null,
    status: req.status != null ? req.status : null,
    // The participation numerator. A cost was entered at some point, which `status` cannot tell
    // you: 23 records in one 7-day window were 'closed' having never carried a price.
    priced: req.price != null,
    price: req.price != null ? req.price : null,
    bidVehicleCount: req.bidVehicleCount != null ? req.bidVehicleCount : null,
    perTypeCosts: req.perTypeCosts || null,
    marginsPct: req.marginsPct || null,
    minMarginPct: req.minMarginPct != null ? req.minMarginPct : null,
    marginSource: req.marginSource != null ? req.marginSource : null,
    marginOverride: req.marginOverride || null,
    heldReason: req.heldReason != null ? req.heldReason : null,
  };
}

// Minimum spacing between the original price ask and its approaching-deadline reminder, used to
// CLAMP the reminder point on a short-fuse load whose whole window is shorter than the configured
// reminderLeadMs (see dueForReminder). It is the separation, not the lead, that makes a reminder
// read as a nudge rather than a duplicate ping - below about a minute the desk sees two near
// identical messages for one load, which is the WhatsApp noise the Director has objected to
// before. A load whose entire window is shorter than this gets no reminder at all: there is no
// room for a second distinct message, and the original ask already carries the cutoff time.
//
// Capped by the lead itself at use (min(gap, lead)) so it can only ever pull a reminder LATER
// than the ask, never later than the nominal lead point. Without that cap an operator who
// deliberately dials the lead below a minute would silently get no reminders at all - the clamp
// would push every reminder past its own deadline. The clamp exists to rescue short windows, not
// to overrule a short lead.
const REMINDER_MIN_GAP_MS = 60_000;

// Plausibility bound on an awaiting request's deadline, IMPORTED from realAdapter's own
// boundedParse (src/platform/realAdapter.js) rather than re-declared here - see that
// constant's comment for why the window is 30 days. SuperProcure fills biddingOn:0 loads
// with a SHARED year-2100 placeholder close time instead of null (observed live
// 2026-07-11: identical "2100-05-24T..." across unrelated shippers); that parses as a
// valid Date, so deadlineAt (closesAt - lead) lands ~74 years out and `nowMs >=
// deadlineAt` can never be true - the row sat awaiting_price forever (39 had to be
// hand-deleted on 2026-07-14). A deadline further out than the listing horizon is a
// placeholder, not a real runway, so expireOverdue treats it as expirable/invalid rather
// than eternally pending. Because this is realAdapter's own bound, not a hand-synced copy,
// a load that legitimately cleared that gate (closesAt <= now + MAX_PLAUSIBLE_DEADLINE_MS)
// is structurally, not just by convention, never falsely expired here - see
// test-allowlist-and-prune.js's cross-module pin.

/**
 * Is this closesAt SuperProcure's placeholder rather than a real auction schedule? A close beyond
 * the listing horizon is structurally impossible for a live SP auction, so a hit here is proof the
 * value is the placeholder, not a suspicion. ONE predicate for every call site: this bound decides
 * whether a load can ever be bid, and a bound copied per call site drifts out of agreement.
 */
function isPlaceholderClose(closesAt, nowMs = Date.now()) {
  return !!(closesAt && closesAt > nowMs + MAX_PLAUSIBLE_DEADLINE_MS);
}

// A shipper Target Rate ask, as against the auction ask. Absent on every record written before the
// field existed, which is why the test is for this exact value rather than for "not auction".
// Seconds held back from a shipper deadline so a cost typed at the line still has time to be
// submitted. One bid is one API call, so this is small on purpose - it buys runway without eating
// a short window.
function targetSubmitRunwayMs(windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return Math.min(60_000, Math.max(15_000, Math.round(windowMs * 0.1)));
}

const TARGET_PRICE_KIND = 'target_price';
const isTargetPriceReq = (r) => !!(r && r.kind === TARGET_PRICE_KIND);

/**
 * THE CLOSE TIME EVERY GATE AND SWEEP READS. `load.closesAt` is the snapshot written once at
 * discovery; `load.liveClosesAt` is the portal's own later close, refreshed while the auction was
 * still listed (refreshLiveClose). On a portal whose posted close is provisional, the snapshot is a
 * guess the platform has already superseded, and keying the sweeps on it files a still-running
 * auction 'closed' - which drops it off the operator worklist and makes reArm throw GONE at exactly
 * the moment re-pricing is the only lever left.
 *
 * FORWARD-ONLY, and that is what makes this change SuperProcure-preserving by construction rather
 * than by exemption: a record with no `liveClosesAt` strictly greater than its snapshot returns the
 * snapshot itself, unchanged, so every SuperProcure and untagged record - none of which any code
 * path writes the field onto - takes the identical value it took before this function existed.
 */
function effectiveCloseAt(load) {
  const snapshot = load && load.closesAt;
  const live = load && load.liveClosesAt;
  return (Number.isFinite(live) && Number.isFinite(snapshot) && live > snapshot) ? live : snapshot;
}

/**
 * The patch fields that take a load OFF hold while keeping the hold that ended.
 *
 * `hold` is the LIVE state the price page renders, so ending a hold has to clear it. What must not
 * go with it is the record that the hold happened at all: it carries the standing bid, the corrected
 * cost and the plan the desk was bidding before the correction, which is the only place a
 * post-mortem can read why a load spent an auction not bidding. `holdHistory` is append-only.
 *
 * A no-op on a load that was never held, so every existing caller's patch is unchanged.
 */
function retireHold(req, reason) {
  if (!req || !req.hold) return { hold: null };
  const prior = Array.isArray(req.holdHistory) ? req.holdHistory : [];
  return {
    hold: null,
    holdHistory: prior.concat([Object.assign({}, req.hold, { resolvedAt: Date.now(), resolvedReason: String(reason) })]),
  };
}

/**
 * THE RE-PRICE EPOCH: a monotonic counter that says "this is a new quote", and the only thing that
 * tells a re-price apart from a pm2 restart.
 *
 * The engine carries the portal's verdicts about a ladder across a restart and must drop them on a
 * re-price. It used to decide which by comparing ladders - and a re-price that leaves the band
 * untouched (a lowered truck count, a plain re-submit) rebuilds a byte-identical one, so a new quote
 * inherited every verdict about the old one and the load stopped bidding with nothing said. A
 * restart replays this number unchanged; only a desk write moves it, so no input the ladder happens
 * not to depend on can defeat it.
 *
 * Bumped by every writer that rebuilds the ladder from a desk action - setBidOverride,
 * clearBidOverride and resumeBidding, all three of which the caller follows with reArmWithNewBand -
 * and by rearm, the desk's Re-arm on a stopped load.
 */
function bumpRepriceEpoch(req) {
  const n = Number(req && req.repriceEpoch);
  return { repriceEpoch: (Number.isInteger(n) && n >= 0 ? n : 0) + 1 };
}

/**
 * The operator-facing refusal, following the codebase's assertX convention (assertAboveFloor,
 * assertValidVcq, assertTransitSatisfied). Re-arming, restoring or pricing a placeholder recreates
 * a monitor whose countdown never reaches zero - the forever-armed class that once sat "armed" for
 * ~74 years (docs/diagnoses/2026-07-13_zero-bid-silent-miss-and-placeholder-cleanup.md).
 *
 * NOT 'GONE'. A closed auction and a load with no real close time are different facts that need
 * different words on screen: 'GONE' means the portal stopped accepting bids, and telling a desk
 * operator their cost "arrived after this auction closed" beside a summary card reading 2100 is
 * false in a way that sends them looking for a mistake they did not make.
 */
function assertRealClose(closesAt, nowMs = Date.now()) {
  if (isPlaceholderClose(closesAt, nowMs)) {
    const e = new Error('that load has no valid close time (placeholder)');
    e.code = 'NO_VALID_CLOSE';
    throw e;
  }
}

/** Has the auction opened? The same test armFromRequest uses to arm now rather than schedule. */
function hasOpened(load, nowMs = Date.now()) {
  return !!load && (load.status === 'live' || !load.startsAt || nowMs >= load.startsAt);
}

/**
 * A load that has not opened is scheduled for its start, and the wake needs a close to bid against.
 * With no positive close on record (null, or 0 read as 1 Jan 1970) a cost taken now would be
 * receipted and then held at the wake, so it is refused at submit instead (W1-3).
 */
function assertCloseKnownBeforeOpen(load, closesAt, nowMs = Date.now()) {
  if (hasOpened(load, nowMs) || Number(closesAt) > 0) return;
  const e = new Error('Not saved. This load has not opened yet and the portal shows no closing time for it. '
    + 'Send your cost again once the portal shows when it closes.');
  e.code = 'NO_CLOSE';
  throw e;
}

/**
 * The portal a persisted request/record belongs to. An ABSENT platformKey means SuperProcure BY
 * CONSTRUCTION, not by guess: discovery.js has stamped platformKey on every price request only
 * since GoComet's own platformKey field was added (src/discovery/discovery.js:344), and GoComet
 * did not exist before that point - so every record ever persisted without the field is,
 * definitionally, an SP record written before there was a second portal to confuse it with. That
 * is what makes this fallback SAFE rather than a plausible-looking guess: there is no third
 * portal whose records this default could be silently misreading as SP.
 *
 * THE FALLBACK IS NOT AN OVERRIDE SAFETY NET, and an earlier version of this comment claimed it
 * was. Reading appConfig.platformKey instead of the literal 'sp' only covers the UNTAGGED case,
 * which is the one that cannot bite. Every record written since discovery.js started stamping the
 * field carries whatever config.platformKey was AT WRITE TIME, and ownedBy compares it by exact
 * string equality against today's value - so changing SP_PLATFORM_KEY once tagged records exist
 * ORPHANS every one of them from listFor(), silently, with no code deploy and no error. There is
 * no resolution rule that fixes that: pinning the literal 'sp' here would strand a deployment that
 * legitimately runs under another key in exactly the same way, just in the mirror direction. Only
 * rewriting the stored field migrates them.
 *
 * The consequence is a MIGRATION requirement, not a code one, so it is recorded here rather than
 * guarded: SP_PLATFORM_KEY is set nowhere - not scripts/deploy.sh, not ecosystem.config.cjs, not
 * the on-box .env - so today the value is always the 'sp' default and nothing can drift. Changing
 * it is a deliberate operator act, and the safe order is stop the app, rewrite platformKey on
 * every priceRequests and closedBids doc, then restart with the new value. A boot-time refusal
 * would be worse than this note: it would have to fire on a variable that is unset in the only
 * configuration that exists, on a live-money box where failing to start is the expensive
 * direction.
 */
function platformOf(req) {
  return (req && req.platformKey) || appConfig.platformKey;
}

/** Does this record belong to the given portal? The one predicate every filtered reader uses -
 *  never re-derived per call site, so "which portal owns this row" has exactly one definition. */
function ownedBy(req, platformKey) {
  return platformOf(req) === platformKey;
}

/**
 * Refuse a re-price whose ladder cannot be reached from the bid we already have standing.
 *
 * `standingBid` is `{ price, minDecrement }` as the engine reports it for this load, or null/absent
 * when the load has never landed a bid - in which case every ladder is reachable and this is a
 * no-op. A reverse auction accepts only an improvement on our own last offer, so the lowest rung
 * has to clear the standing price by at least the platform's decrement; anything else is refused on
 * the wire, and re-arming around it replaces a live bidding position with a ladder of guaranteed
 * refusals.
 *
 * Throws a MACHINE-READABLE refusal: `code` plus the three numbers that decide it, so the caller
 * can render whatever the desk should read without re-deriving the arithmetic from a string.
 */
function assertLadderReachable(plan, standingBid) {
  if (!standingBid) return;
  // The CERTAIN rule, not the decrement one - matching bidEngine._mustImproveOn, and for the same
  // reason. The engine reserves the floor rung as a decisive final shot and fires it even when it
  // sits inside the platform's stated decrement; a gate that refused on the decrement would refuse
  // re-prices the engine would go on to bid and possibly win. Refuse only what cannot land at all.
  const reachAt = maxImprovementPrice(standingBid.price, 1);
  if (reachAt == null) return; // nothing stands -> every ladder is reachable
  const floor = Number(plan && plan.floor);
  if (!Number.isFinite(floor)) return; // no floor to judge; the buildable check owns malformed plans
  if (floor <= reachAt) return;
  const standing = Number(standingBid.price);
  const e = new Error(`cannot re-price: the lowest price this can bid is Rs ${floor}, `
    + `which does not improve on the Rs ${standing} already bid on this load`);
  e.code = 'UNREACHABLE';
  e.reason = 'new_floor_above_standing_bid';
  e.standingBidPrice = standing;
  e.floor = floor;
  e.maxBiddablePrice = reachAt;
  // The load's own decrement, for whoever renders this - the number the desk needs to clear, which
  // is not the same as maxBiddablePrice above (that is the certain bound this gate refuses on).
  if (standingBid.minDecrement != null) e.minDecrement = Number(standingBid.minDecrement);
  throw e;
}

class PriceRequestStore {
  // Margin source, highest-priority provider first:
  //   customersProvider (CustomerStore | null): the unified-model source of truth. When present,
  //     the band derives from customers + assignments (resolveMargin) - golden-equivalent to the
  //     legacy profiles path on migrated data (scripts/test-model-migration.js).
  //   profiles (MarginProfileStore | null): the LEGACY per-customer overrides, kept as the
  //     fallback when no customersProvider is wired (unit tests, pre-migration installs).
  //   neither -> the default band (marginsPct/minMarginPct) always applies (day-one behaviour).
  // assignmentsProvider (AssignmentStore | null): read alongside customers for per-assignment
  //   margin overrides; ignored when customersProvider is absent.
  // platformKey ('sp' default): the portal used for resolution when a caller doesn't
  //   pass one. Multi-portal: each discovery poller passes its own key per call.
  constructor({ store, marginsPct, minMarginPct, profiles = null, customersProvider = null, assignmentsProvider = null, platformKey = 'sp', log = () => {} }) {
    this.store = store;
    this.marginsPct = marginsPct;
    this.minMarginPct = minMarginPct; // explicit operating-floor margin (Task 3)
    this.profiles = profiles;
    this.customersProvider = customersProvider;
    this.assignmentsProvider = assignmentsProvider;
    this.platformKey = platformKey;
    this.log = log;
    // Single-flight guard for createForLoad, keyed by loadId. Closes the duplicate-request race a
    // stalled discovery tick resuming beside its replacement can open: both calls pass the
    // pre-write getByLoad check before either write lands, because that check and the eventual
    // write are separated by several awaits (resolveInherited, resolveRoundPolicy,
    // resolveCustomerTag). A second overlapping call now awaits the first one's own promise and
    // returns its request, instead of racing it to a second write.
    this._creatingByLoadId = new Map();
    this._archivedIdCache = null; // seeded from the archive on the first prune (see _archivedIds)
  }

  /**
   * Resolve the INHERITED band for a load: a matching customer profile, else the
   * default band. Async (reads the profile store when present). Returns
   * { marginsPct, minMarginPct, source } where source is 'default' | `customer:<key>`.
   * A bid-level override (tier 1) is layered on top of this by capture/setBidOverride.
   */
  async resolveInherited(load, platformKey = this.platformKey) {
    const defaults = { marginsPct: this.marginsPct, minMarginPct: this.minMarginPct };
    const companyName = load && load.companyName;
    // Unified model (source of truth): band = assignment override > customer margin > default.
    if (this.customersProvider) {
      const [customers, assignments] = await Promise.all([
        this.customersProvider.list(),
        this.assignmentsProvider ? this.assignmentsProvider.list() : Promise.resolve([]),
      ]);
      return resolveMargin({ platformKey, companyName, customers, assignments, defaults });
    }
    // Legacy fallback: no model wired -> the marginProfiles path (or default when neither).
    if (!this.profiles) {
      return { marginsPct: (defaults.marginsPct || []).slice(), minMarginPct: defaults.minMarginPct, source: 'default' };
    }
    const profs = await this.profiles.list(platformKey);
    return resolveBand({ platformKey, companyName, profiles: profs, defaults });
  }

  /**
   * The customer minimum for a request: the effective minimum of the band it inherits with no
   * per-load override, i.e. what "Revert to standard margins" would restore.
   */
  async customerMinimumFor(req) {
    const inherited = await this.resolveInherited((req && req.load) || {}, (req && req.platformKey) || this.platformKey);
    return effectiveFloorMarginPct(inherited);
  }

  /**
   * The minimum for a band typed on the /price page: its lowest row, or the customer minimum where
   * that is lower, so an edit above the customer's minimum keeps it as the guard. A customer minimum
   * that is not above 0 (a legacy stored 0) is never taken.
   */
  async withCustomerMinimum(req, band) {
    const customerMinPct = await this.customerMinimumFor(req);
    return (customerMinPct > 0 && customerMinPct < Number(band.minMarginPct))
      ? { ...band, minMarginPct: customerMinPct } : band;
  }

  /**
   * { marginPct, customerMinPct } when a per-load band's own minimum is below the customer minimum,
   * else null. Its own minimum, not its lowest margin: that minimum is the guard, and a ceiling can
   * be bid all the way down to it. The band is expected to be validated already.
   */
  async belowCustomerMinimum(req, band) {
    const customerMinPct = await this.customerMinimumFor(req);
    const own = effectiveFloorMarginPct(band);
    if (customerMinPct == null || own == null || !(own < customerMinPct)) return null;
    return { marginPct: own, customerMinPct };
  }

  /**
   * READ-SIDE tag: the Customer this load's companyName resolves to, snapshotted onto the
   * request at create time (same lifecycle as the load-field and band snapshots). The tag
   * feeds the pretty link slug (linkSlug prefers the clean customerId over the platform's
   * raw companyName) and the display surfaces (the WA *Name* line and the price/track pages
   * prefer the label). It NEVER feeds routing, margin, or scope - those resolve live from
   * the model on every read. null when nothing matches or no model is wired (legacy
   * installs, unit tests); every consumer falls back to load.companyName.
   * scripts/migrate-customer-slugs.js rewrites this snapshot on a slug rename, so in-flight
   * requests never keep linking under a retired slug.
   */
  async resolveCustomerTag(load) {
    if (!this.customersProvider) return null;
    const customers = await this.customersProvider.list();
    const c = matchCustomer(load && load.companyName, customers);
    return c ? { customerId: c.customerId, label: c.label } : null;
  }

  /**
   * The load's per-plant round policy, resolved beside its margin band and snapshotted onto the
   * request: null when no customer or no policy matches (the engine's default cap then applies).
   */
  async resolveRoundPolicy(load) {
    if (!this.customersProvider) return null;
    const customers = await this.customersProvider.list();
    return resolveRoundPolicy({ companyName: load && load.companyName,
      origin: load && load.lane && load.lane.origin, customers });
  }

  /** The customer's T9 W9 switch for this load, resolved at capture like the round policy. */
  async resolvePreEmptiveFloor(load) {
    if (!this.customersProvider) return false;
    return resolvePreEmptiveFloor({ companyName: load && load.companyName, customers: await this.customersProvider.list() });
  }

  async getByToken(token) { return this.store.getDoc(COLLECTION, token); }
  // A re-price is authorised by the status it read, and the caller re-arms off the result. If an
  // operator Stop moved the record in between, the write is refused rather than merged under it:
  // a status-less patch kept 'stopped' and the re-arm then bid a load the desk had stopped (T1 D9).
  async _patchAuthorisedBy(token, patch, status) {
    try { return await this.store.patchDoc(COLLECTION, token, { ...patch, __expect: { status } }); }
    catch (e) {
      if (e.code !== 'EXPECT_FAILED') throw e;
      const w = new Error(e.actual === 'stopped'
        ? 'Not saved: this load was stopped while your change was being saved.'
        : `Not saved: this load changed to ${e.actual} while your change was being saved.`);
      w.code = 'NOT_OPEN';
      w.actual = e.actual;
      throw w;
    }
  }
  async listAll() { return this.store.listDocs(COLLECTION); }
  async listOpen() { return (await this.listAll()).filter((r) => r.status === 'awaiting_price'); }
  /**
   * `platformKey` is OPTIONAL and correctness-only, not a required scope: SuperProcure's own
   * loadIds are numeric strings and GoComet's enquiry keys are alphanumeric (discovery.js /
   * gocometAdapter.js), so an unscoped lookup colliding across portals is essentially impossible
   * today. Passing it lets a caller that already knows its own platform state that constraint
   * explicitly rather than leaning on the near-impossibility; omitting it keeps today's behaviour.
   */
  // Target-rate requests are EXCLUDED here, and that exclusion is what keeps the auction path
  // byte-identical. A target rate arrives on a load that already has an auction request, so without
  // this a second doc would share the loadId and `.find` would return whichever the store happened
  // to enumerate first - non-deterministically handing the auction's own callers the wrong record.
  // Docs written before this field existed have no `kind` and read as auction records.
  /** Every portal's auction record for one load id - for a caller that must refuse an id two portals share. */
  async listByLoad(loadId) {
    return (await this.listAll()).filter((r) => String(r.loadId) === String(loadId) && !isTargetPriceReq(r));
  }
  async getByLoad(loadId, platformKey) {
    const all = platformKey ? await this.listFor(platformKey) : await this.listAll();
    return all.find((r) => String(r.loadId) === String(loadId) && !isTargetPriceReq(r)) || null;
  }

  /**
   * Close out an answered target rate. capture() moves EVERY request to 'armed', and on a target
   * rate that status is what opens the re-price surface - which posts back into the auction arm
   * path. There is nothing left to re-price here: the bid was sent or it was refused, and either
   * way the shipper's window is the only clock and it is not ours to restart. Terminal.
   */
  async settleTargetPrice(token, { submitted, price, reason } = {}) {
    return this.store.patchDoc(COLLECTION, token, {
      status: 'closed',
      targetOutcome: {
        submitted: !!submitted,
        price: price != null ? price : null,
        reason: reason || null,
        at: Date.now(),
      },
    });
  }

  /** The target-rate ask for one load and one negotiation round, if it exists. */
  async getTargetPriceRequest(loadId, round, platformKey) {
    const all = platformKey ? await this.listFor(platformKey) : await this.listAll();
    return all.find((r) => isTargetPriceReq(r)
      && String(r.loadId) === String(loadId) && String(r.negotiationRound) === String(round)) || null;
  }

  /**
   * Raise a desk ask for a shipper Target Rate on an already-closed load.
   *
   * WHY THIS IS NOT createForLoad. That one opens with `getByLoad(id); if (existing) return existing`
   * and has no status check, so on a load whose auction request has already been swept to the
   * terminal 'closed' it returns the dead row: no new token, no message, no error. There is no
   * transition out of 'closed' anywhere in this file - restore() covers 'dismissed' only - so the
   * ask would silently never happen. A separate record keyed by (loadId, round) is the fix, and it
   * also gives a second negotiation round its own ask instead of merging into the first.
   *
   * The load snapshot carries the TARGET deadline as closesAt, not the auction's. Every sweep and
   * gate in this file reads effectiveCloseAt(load), so with the auction's close - which is already
   * in the past by the time a target arrives - expireOverdue would retire this ask on its very next
   * tick. Pointing closesAt at the shipper's deadline makes the existing sweeps, the page countdown
   * and the approaching-deadline reminder all do the right thing with no change to any of them.
   */
  async createForTargetPrice(load, { targetPricePerUnit, targetDeadlineMs, standingPricePerUnit,
    negotiationRound, comment = null, autoBiddable = true, chargeLineCount = 1,
    platformKey = this.platformKey } = {}) {
    if (!Number.isFinite(targetDeadlineMs)) { const e = new Error('a target-rate ask needs the shipper deadline'); e.code = 'BAD_INPUT'; throw e; }
    const existing = await this.getTargetPriceRequest(load.id, negotiationRound, platformKey);
    if (existing) return existing;
    const token = newToken();
    const band = await this.resolveInherited(load, platformKey);
    const req = {
      id: token,
      loadId: String(load.id),
      kind: TARGET_PRICE_KIND,
      negotiationRound: String(negotiationRound),
      account: load.account || null,
      platformKey,
      customer: await this.resolveCustomerTag(load),
      load: Object.assign({}, load, {
        // the shipper's own clock, not the auction's - see the docblock above
        closesAt: targetDeadlineMs,
        liveClosesAt: null,
        // The target is a stated maximum the shipper will pay, which is exactly what a ceiling is,
        // so it rides the existing ceiling machinery: planPreview, the dead-plan copy and the
        // ceiling belt all judge it without a second implementation of the same idea.
        rules: Object.assign({}, load.rules || {}, { ceilingPrice: targetPricePerUnit }),
      }),
      targetPricePerUnit,
      standingPricePerUnit: standingPricePerUnit != null ? standingPricePerUnit : null,
      targetDeadlineMs,
      targetComment: comment,
      autoBiddable,
      chargeLineCount,
      marginsPct: band.marginsPct,
      minMarginPct: band.minMarginPct,
      marginSource: band.source,
      marginOverride: null,
      status: 'awaiting_price',
      createdAt: Date.now(),
      // A CUTOFF SET BEFORE THE WALL, the same shape the auction ask uses. Setting deadlineAt to the
      // shipper's own deadline collapsed the two: the page then invited the desk to answer at the
      // exact instant the offer lapses, leaving the submit no runway at all. The reserve scales with
      // the window because the two observed ones differ by a factor of four (13m45s and 58m55s), and
      // a flat minute is a twelfth of the short one. capture() still accepts a cost right up to the
      // real deadline - deadlineAt is the advisory line the page warns on, never the wall.
      deadlineAt: targetDeadlineMs - targetSubmitRunwayMs(targetDeadlineMs - Date.now()),
      price: null,
      capturedAt: null,
      notified: false,
    };
    await this.store.putDoc(COLLECTION, token, req);
    this.log(`[price-req] target-rate ask ${redactToken(token)} for load ${load.id} round ${negotiationRound} (target ${targetPricePerUnit})`);
    return req;
  }

  /** Create a request for a discovered load. Idempotent: one request per load.
   *  The margin band is RESOLVED here (customer profile -> default), because this is
   *  where the load's shipper is known and where the /price page snapshot is taken. */
  async createForLoad(load, opts = {}) {
    const key = `${opts.platformKey || this.platformKey}:${load.id}`;
    const inFlight = this._creatingByLoadId.get(key);
    if (inFlight) return inFlight;
    const p = this._createForLoadOnce(load, opts);
    this._creatingByLoadId.set(key, p);
    try {
      return await p;
    } finally {
      this._creatingByLoadId.delete(key);
    }
  }

  async _createForLoadOnce(load, { deadlineAt, platformKey = this.platformKey } = {}) {
    const existing = await this.getByLoad(load.id, platformKey);
    if (existing) return existing;
    const token = newToken();
    const band = await this.resolveInherited(load, platformKey);
    const roundPolicy = await this.resolveRoundPolicy(load);
    const req = {
      id: token,
      loadId: String(load.id),
      account: load.account || null, // carrier/account label (multi-account later)
      platformKey,                   // which portal - for later re-resolution + display
      // the matched Customer {customerId, label} | null - display + link-slug only, never
      // routing (see resolveCustomerTag above for the full contract).
      customer: await this.resolveCustomerTag(load),
      load: {
        lane: load.lane, equipment: load.equipment, units: load.units,
        // SP's own friendly enquiry code (distinct from the numeric `id` used as loadId
        // everywhere else) - carried so it can correlate a won/lost back to the priced enquiry.
        loadCode: load.loadCode || null,
        // The shipper's own reference for this enquiry, when the portal publishes one - the number
        // the desk quotes back to the customer, as against `loadId` which is the portal's key.
        // Snapshotted like companyName so the page can still name it after the load ages off the
        // board. null on SuperProcure and on every snapshot taken before this field existed; those
        // render the identifier line exactly as they do today.
        shipperRef: load.shipperRef || null,
        // declared load weight - distinct from the rated capacity in the vehicle name. The
        // UNIT varies per branch (weightUnit, from SuperProcure's own brancheUnit - most are
        // MT, some like Ashirvad Pipes are KG); display layers must read weightUnit, never
        // assume MT.
        weight: load.weight != null ? load.weight : null,
        weightUnit: load.weightUnit || null,
        // route distance in km, straight from SuperProcure (loadDistance) - null on loads
        // that don't carry it (sim/mock).
        distanceKm: load.distanceKm != null ? load.distanceKm : null,
        // GoComet's own cargo size string ("40'x10'x10\""), verbatim - null on SuperProcure and
        // on GoComet loads that carried no dimension block.
        dimensions: load.dimensions || null,
        // full pickup/drop addresses from the adapter (drop is what the pricing team
        // prices against); null on loads that don't carry them (sim/mock) - the lane
        // string stays the fallback everywhere.
        points: Array.isArray(load.points) && load.points.length ? load.points : null,
        // Cities/states/pincodes parsed out of a portal whose lane fields are free-text postal
        // addresses (GoComet publishes no city or state field). DISPLAY ONLY - `lane` above stays
        // the raw strings every allowlist, intent and route-history lookup is keyed on. null on
        // portals whose lane is already a city name (SuperProcure), so the surfaces keep rendering
        // `lane` exactly as they do today.
        laneParsed: load.laneParsed || null,
        companyName: load.companyName, shipmentType: load.shipmentType,
        // SP's consignor branch label ("REN-K", "Bhiwadi- Plant", ...) - snapshotted like
        // companyName so the capture link + display can name the branch even after the load
        // ages off the board. DISPLAY/LINK-ONLY (same contract as the customer tag), never
        // routing/margin. null on sim/mock loads and pre-branchName snapshots.
        branchName: load.branchName || null,
        // WHO POSTED THE LOAD - {name, mobile, createdBy} | null, snapshotted like branchName so
        // the desk can still see (and ring) the shipper-side contact after the load ages off the
        // board. DISPLAY-ONLY, never routing/margin. The adapter has ALREADY applied the
        // fail-closed guards (System placeholder, placeholder mobile, displayPartyDetails off), so
        // a non-null value here is one the desk may act on. null on sim/mock loads and on every
        // snapshot persisted before this field existed - those simply render no contact row.
        poster: load.poster || null,
        // The QUOTE TYPE (pricing basis: FTL = per vehicle, PMT = per tonne). Carried so the engine
        // can tell a genuine FTL multi-vehicle load (fail-closed / vcq:N) from a PMT tonnage load
        // (`units` is MT there, never a truck count) after the arm round-trip. NOT shipmentType:
        // SuperProcure reports loadShipmentType "FTL" even on a PMT load, so the basis has to come
        // from its own field (realAdapter._mapLoad -> branchQuoteType/rateType). Null on sim/mock
        // loads and on snapshots persisted before this field existed - "basis not recorded", not
        // "FTL". loadTotalQuantity mirrors it as a cross-check (vehicleCount on FTL, tonnage on PMT).
        quoteType: load.quoteType || null,
        loadTotalQuantity: load.loadTotalQuantity != null ? load.loadTotalQuantity : null,
        // How many separate cargo lines the portal's quote will carry. Snapshotted like every other
        // per-load fact so the desk page can refuse a load we cannot price BEFORE a cost is typed,
        // rather than at the write. null when the adapter did not establish it - "not recorded",
        // never "one line", so an absent count can never be read as safe.
        cargoLines: load.cargoLines != null ? load.cargoLines : null,
        // The truck types on a multi-type load, [{label, count}]. Snapshotted for the same reason
        // as everything else here - the price link outlives the board - and null on every load
        // that carries one type and on every snapshot written before this field existed, so an
        // absent value reads as "not recorded" rather than "one type".
        cargoTypes: Array.isArray(load.cargoTypes) && load.cargoTypes.length ? load.cargoTypes : null,
        closesAt: load.closesAt, startsAt: load.startsAt, ceiling: load.ceiling,
        revisionLimit: load.revisionLimit, softClose: !!load.softClose,
        extendSeconds: load.extendSeconds != null ? load.extendSeconds : null,
        extendCount: load.extendCount != null ? load.extendCount : null,
        // carry whether the close model was verified, so the scope backstop (server.js) and
        // the reconcile fail closed on an unverified load, not just an explicitly-soft one.
        closeModelKnown: load.closeModelKnown, status: load.status,
        // shipper-attached context the pricing person must see: the load's note (plain
        // text, flattened by the adapter) + product, and whether the portal holds
        // comments/attachments this snapshot can't carry. All null/false when absent.
        productName: load.productName || null,
        notes: load.notes || null,
        hasPortalComments: !!load.hasPortalComments,
        hasPortalAttachments: !!load.hasPortalAttachments,
        // LoadRules: the per-load facts snapshotted WHOLE at intake (the audit's fix-first seam),
        // so the payload builder reads the same facts that were true when the load was discovered.
        // null on loads that don't carry it (sim/mock). Inert in this PR - carried, not yet consumed.
        rules: load.rules || null,
      },
      marginsPct: band.marginsPct,
      minMarginPct: band.minMarginPct,
      marginSource: band.source,     // 'default' | `customer:<key>` | 'bid' (once overridden)
      marginOverride: null,          // set when a bid-level override applies to this load
      ...(roundPolicy ? { roundPolicy } : {}),
      status: 'awaiting_price',
      createdAt: Date.now(),
      // deadlineAt is normally precomputed by discovery (closesAt - lead) and passed in; this
      // fallback only fires when a caller omits it (e.g. the demo-seed path). Recompute from the
      // SAME source of truth (config.priceDeadlineLeadMs), not a hardcoded lead. `||` (not `??`)
      // is deliberate here: deadlineAt is an absolute timestamp, so any falsy value (including 0 /
      // the epoch) is not a real deadline and SHOULD trigger the recompute.
      deadlineAt: deadlineAt || (load.closesAt ? load.closesAt - appConfig.priceDeadlineLeadMs : null),
      price: null,
      capturedAt: null,
      // false until the WhatsApp price-needed push actually went out. Stays false if the send was
      // skipped because the sender session was down, so discovery re-fires it on recovery (see
      // markNotified + discovery's re-notify). Dashboard mode counts as notified (nothing to push).
      notified: false,
      // CW-145/G9: true when the push resolved to zero recipients (no group or person scope covers
      // this customer) - a routing-config gap, not a delivery hiccup. Cleared the moment a later
      // attempt actually reaches someone (markNotified). Read by the console badge (PR-3).
      reachedNobody: false,
    };
    await this.store.putDoc(COLLECTION, token, req);
    const lane = load.lane ? `${load.lane.origin}->${load.lane.destination}` : '?';
    this.log(`[price-req] created ${redactToken(token)} for load ${load.id} (${lane}, ${load.companyName || '?'})`);
    return req;
  }

  /**
   * Re-resolve the inherited band onto every request still awaiting a price that carries no per-load
   * band, so a customer, margin-profile or assignment save reaches loads already waiting (M0-F6).
   * Armed and per-load-override requests are never touched. Returns how many were refreshed.
   */
  async resnapshotOpenBands() {
    let refreshed = 0;
    for (const r of await this.listOpen()) {
      if (r.marginSource === 'bid' || r.marginOverride) continue;
      const band = await this.resolveInherited(r.load || {}, r.platformKey || this.platformKey);
      const same = r.marginSource === band.source && Number(r.minMarginPct) === Number(band.minMarginPct)
        && JSON.stringify((r.marginsPct || []).map(Number)) === JSON.stringify((band.marginsPct || []).map(Number));
      if (same) continue;
      const cur = await this.getByToken(r.id);
      if (!cur || cur.status !== 'awaiting_price' || cur.marginSource === 'bid' || cur.marginOverride) continue;
      await this.store.patchDoc(COLLECTION, r.id, { marginsPct: band.marginsPct, minMarginPct: band.minMarginPct, marginSource: band.source });
      refreshed++;
    }
    if (refreshed) this.log(`[price-req] re-snapshotted the inherited margins on ${refreshed} request(s) awaiting a price`);
    return refreshed;
  }

  /**
   * Mark that the WhatsApp price-needed push actually went out for this request. Idempotent; a no-op
   * if the request is gone. Discovery calls this after a successful notify so it won't re-fire.
   */
  async markNotified(token) {
    const req = await this.getByToken(token);
    if (!req || req.notified) return req || null;
    // reachedNobody:false clears a stale CW-145/G9 flag - the routing gap that produced it is fixed
    // the moment a real send lands, and a badge left on after that would be its own false alarm.
    return this.store.patchDoc(COLLECTION, token, { notified: true, notifiedAt: Date.now(), reachedNobody: false });
  }

  /**
   * CW-145/G9: mark that a price-needed push resolved to ZERO recipients - notifier._whatsapp's
   * 'unreached' result. Deliberately does NOT set notified: discovery's retry loop must keep
   * re-attempting every tick, because the routing gap (no group or person scope covers this
   * customer) can be fixed live and the very next attempt may actually reach someone. Idempotent;
   * a no-op if the request is gone.
   */
  async markReachedNobody(token) {
    const req = await this.getByToken(token);
    if (!req) return null;
    return this.store.patchDoc(COLLECTION, token, { reachedNobody: true, reachedNobodyAt: Date.now() });
  }

  /**
   * Move a still-live record's close forward to the portal's own current one. The ONLY writer of
   * `load.liveClosesAt`; the snapshot `load.closesAt` is never rewritten, so what the desk was told
   * at pricing time stays legible beside what the platform later did.
   *
   * Called from discovery, off the same `listAuctions()` response the intake already reads - the
   * existing adapter -> discovery -> pricing direction. It deliberately does NOT come from the
   * engine: the engine only knows loads that are ARMED, and the records this defect strands include
   * every un-priced one (expireOverdue files those 'skipped_no_price' - the desk's own work reported
   * as desk non-response). A load absent from the listing gets no refresh, which is the correct
   * direction: it is evidence the auction is over, not evidence it is running.
   *
   * Six refusals, all fail-safe, because a bad accept here is worse than a missed refresh - a close
   * pushed out on a dead auction is the forever-armed class this codebase has already paid for:
   *   - no declared extension increment    -> nothing bounds the move, so do not make one up
   *   - a non-finite value                 -> not a time
   *   - a terminal record                  -> a retired auction cannot re-open
   *   - backward                           -> pulling a close EARLIER could retire a live auction;
   *                                           an early move is the engine's business, not a sweep's
   *   - beyond the listing horizon         -> the year-2100 placeholder shape parses as a perfectly
   *                                           valid Date, so NaN guards miss it entirely
   *   - beyond ONE extension step from the later of the current close and now -> the platform's own
   *     declared mechanism cannot produce it in one observation, so it is corruption, not an
   *     extension. Measured against `now` as well as the close so a refresh delayed across several
   *     rounds (a slow tick, a restart) still lands rather than being locked out by its own bound.
   *
   * `record` spares the whole-collection read when the caller already holds this token's record from
   * a read with no suspension point since, so it is exactly what getByToken would return.
   */
  async refreshLiveClose(token, liveClosesAt, { extensionStepMs, nowMs = Date.now(), record } = {}) {
    const step = Number(extensionStepMs);
    if (!Number.isFinite(step) || step <= 0) return null;
    const live = Number(liveClosesAt);
    if (!Number.isFinite(live)) return null;
    const req = record && record.id === token ? record : await this.getByToken(token);
    if (!req) return null;
    if (!(req.status === 'awaiting_price' || req.status === 'armed' || req.status === 'stopped')) return null;
    const current = effectiveCloseAt(req.load);
    if (!Number.isFinite(current) || live <= current) return null;
    if (isPlaceholderClose(live, nowMs)) return null;
    if (live > Math.max(current, nowMs) + step) return null;
    const updated = await this.store.patchDoc(COLLECTION, token, {
      load: Object.assign({}, req.load, { liveClosesAt: live, liveCloseSeenAt: nowMs }),
    });
    this.log(`[price-req] ${redactToken(token)} (load ${req.loadId}) close moved out ${Math.round((live - current) / 1000)}s - the auction extended`);
    return updated;
  }

  /**
   * A human submits the cost -> request goes 'armed'. Validates the number.
   * An optional bid-level `marginOverride` (from the /price capture page's "adjust
   * margin" expander) overrides the inherited customer/default band for this load
   * only; when absent, the request's snapshotted band is used unchanged.
   * `transitDays` is REQUIRED when the load's snapshotted rules carry loadIsTransitTimeOn
   * (SuperProcure rejects a bid without transit time on those loads - proven live on SIKA:
   * null -> HTTP 400) and DISCARDED otherwise, so a non-transit load's wire stays untouched.
   */
  async capture(token, { cost, costByType, marginOverride, transitDays, bidVehicleCount } = {}) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'awaiting_price') throw captureLost(req.status);
    // The ONLY hard stop is the auction actually closing on the portal. A cost is accepted right up
    // to then - best-effort: the engine fires the floor into whatever window is left (bidEngine
    // _decide sends a fresh monitor straight to the floor inside the final window). deadlineAt is
    // now an advisory "danger zone" line the UI warns on (renderCaptured), NEVER a wall - refusing a
    // late cost loses winnable loads, and a late cost the bot can't place is a warning, not a silent
    // throwaway. Only past the real close is there genuinely nothing left to bid.
    const closesAt = effectiveCloseAt(req.load);
    if (closesAt && Date.now() >= closesAt) {
      const e = new Error('this auction has closed on the portal');
      e.code = 'GONE';
      throw e;
    }
    // Refusing HERE specifically matters because the operator has ALREADY typed a cost: a silent
    // accept turns their work into a load that can never bid.
    assertRealClose(closesAt);
    assertCloseKnownBeforeOpen(req.load, closesAt);
    // Per-truck-type costs, when the desk priced each type separately. The blended per-truck cost
    // it derives REPLACES the posted single cost: the page computes the same number client-side to
    // drive the band preview, but the value that arms is the one recomputed here, because a number
    // typed by the page is a number a curl can type too.
    const byType = normalizeCostByType(costByType, req.load && req.load.cargoTypes);
    const c = byType ? byType.cost : Number(cost);
    // Rs 1 minimum, not just > 0: a sub-rupee cost rounds to 0 in buildBandLadder (Math.round),
    // which collapses the true-cost floor to 0 and lets a Rs 0 bid past assertAboveFloor.
    if (!(c >= 1) || !Number.isFinite(c)) { const e = new Error('cost must be a finite number of at least Rs 1'); e.code = 'BAD_INPUT'; throw e; }

    // Conditional transit time (fail closed at the intake, the same posture as the engine's
    // unknown-mechanic guard): a transit-required load priced WITHOUT days would only ever arm a
    // bid SuperProcure 400s, so refuse the capture with a message the pricing person can act on.
    // The POST handler is untrusted (a curl with the token bypasses the form's `required`), so
    // this server-side check is the real gate, not the HTML attribute. Days on a load that does
    // NOT require them are dropped, never stored - the non-transit wire must stay byte-identical.
    const needsTransit = !!(req.load && req.load.rules && req.load.rules.loadIsTransitTimeOn);
    let transitDaysNorm = null;
    if (needsTransit) {
      transitDaysNorm = normalizeTransitDays(transitDays);
      if (transitDaysNorm == null) {
        const e = new Error(`this shipper requires transit time: enter the transit days (a whole number of days, 1-${MAX_TRANSIT_DAYS}) along with the cost`);
        e.code = 'BAD_INPUT'; throw e;
      }
    }

    // Effective band: a bid-level override (tier 1) wins over the inherited band snapshotted
    // on the request (tier 2/3). The override is validated here; the floor invariant
    // is still enforced downstream in buildBandLadder / assertAboveFloor.
    let marginsPct = req.marginsPct, minMarginPct = req.minMarginPct, marginSource = req.marginSource || 'default';
    let overrideDoc = req.marginOverride || null;
    if (marginOverride != null) {
      let v;
      try { v = validateMargins(marginOverride.marginsPct, marginOverride.minMarginPct); }
      catch (ve) { const e = new Error(`invalid margin override: ${ve.message}`); e.code = 'BAD_INPUT'; throw e; }
      marginsPct = v.marginsPct; minMarginPct = v.minMarginPct; marginSource = 'bid';
      overrideDoc = { marginsPct: v.marginsPct, minMarginPct: v.minMarginPct, setBy: marginOverride.setBy || 'pricing', setAt: Date.now() };
      const below = await this.belowCustomerMinimum(req, v);
      if (below) overrideDoc.belowMinimum = { ...below, setBy: overrideDoc.setBy, setAt: overrideDoc.setAt };
    }

    // Prove the bid plan builds BEFORE committing 'armed': otherwise a bad band (env typo, or a
    // bad override -> NaN) marks the request armed but the engine never arms, silently missing it.
    try {
      buildBandLadder({ cost: c, marginsPct, minMarginPct });
    } catch (planErr) {
      const e = new Error(`cannot arm: bid plan not buildable (${planErr.message}) - fix the margin band`);
      e.code = 'BAD_INPUT';
      throw e;
    }
    // price.transitDays only ever exists on a transit-required load. It lives on `price` (not the
    // rules snapshot) because it is operator-CAPTURED data like the cost, and every write that
    // preserves the price preserves it: setBidOverride/clearBidOverride Object.assign over price,
    // stop/rearm keep it, reopen() nulls the whole price (days re-entered with the retried cost).
    // Operator-chosen truck count (bid-max-always default; the desk may LOWER it to a partial). Lives
    // on `price` like transitDays - operator-captured data that every price-preserving write carries -
    // so armFromRequest -> the intent -> _multiVehiclePlan can send it as the bid's vcq. Validated
    // (whole number, 1..total) or throws BAD_INPUT; null (not supplied / single-unit load) -> the
    // engine keeps its bid-max default and the wire stays byte-identical.
    const vehicleCount = normalizeBidVehicleCount(bidVehicleCount, req.load && req.load.units);
    const price = { cost: c, marginsPct, minMarginPct };
    if (transitDaysNorm != null) price.transitDays = transitDaysNorm;
    if (vehicleCount != null) price.bidVehicleCount = vehicleCount;
    // Stored BESIDE cost, never instead of it, so every existing consumer keeps reading one number
    // and only the paths that know about truck types read the vector. The two must never drift:
    // `cost` was derived from `costByType` above, and setBidOverride drops the vector whenever a
    // bare cost replaces it.
    if (byType) price.costByType = byType;
    // A request created before its customer's round policy existed resolves it now, so a record
    // seeded mid-day reaches the next load priced rather than only the next load discovered.
    const roundPolicy = req.roundPolicy === undefined ? await this.resolveRoundPolicy(req.load) : null;
    const preEmptive = await this.resolvePreEmptiveFloor(req.load);
    // Compare-and-set on the status read above: a second capture that passed the same check loses
    // here, so the cost on record is always the one whose arm owns the wire. The loser is an error
    // the desk sees, never a silent render of the page the winner produced.
    let updated;
    try {
      updated = await this._patchAuthorisedBy(token, {
        status: 'armed',
        price,
        marginsPct, minMarginPct, marginSource, marginOverride: overrideDoc,
        ...(roundPolicy ? { roundPolicy } : {}),
        ...(preEmptive || req.preEmptiveFloorAtRankOne !== undefined ? { preEmptiveFloorAtRankOne: preEmptive } : {}),
        capturedAt: Date.now(),
      }, 'awaiting_price');
    } catch (e) {
      if (e.code !== 'NOT_OPEN') throw e;
      throw captureLost(e.actual);
    }
    this.log(`[price-req] captured ${redactToken(token)} for load ${req.loadId}${transitDaysNorm != null ? ` (transit ${transitDaysNorm}d)` : ''}${vehicleCount != null ? ` (bid ${vehicleCount} of ${Math.round(Number(req.load.units))} vehicles)` : ''}${marginSource === 'bid' ? ' (bid-level margin override)' : ''}`);
    return updated;
  }

  /**
   * Set a bid-level margin override on one request (tier 1). Valid on:
   *   awaiting_price - the override rides through capture() (which reads req.marginsPct).
   *   armed          - a live re-price; the CALLER must re-arm the engine (stop + armFromRequest)
   *                    so the new band rebuilds the ladder. Real money -> confirm-gated at the
   *                    endpoint. Updates price.* (margins AND, optionally, cost) too so
   *                    armFromRequest sees the new numbers.
   * `standingBid` ({ price, minDecrement }, from the engine's own monitor for this load) is what
   * the reachability gate below judges the new ladder against. Absent means "nothing stands", which
   * is true for every awaiting-price capture and for an armed load that has not landed a bid yet.
   * `planFloor` is the floor the ENGINE would arm for these numbers (engine.planPreview().floor);
   * absent, the gate judges the bare band, which the round-figure grid can leave a step below the
   * real one.
   * `transitDays` is SET-ONCE recovery, not an edit: it is stored only when this armed
   * transit-required load has none yet (a request captured before the transit build deployed -
   * the engine refuses to bid those until days exist). Once a load HAS days they are sticky -
   * SuperProcure's transit time is per-load, reused on every revision - so a re-price that
   * passes a different value is deliberately ignored, never an update.
   */
  async setBidOverride(token, { marginsPct, minMarginPct, cost, costByType, transitDays, bidVehicleCount }, { setBy, standingBid, planFloor } = {}) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'awaiting_price' && req.status !== 'armed') {
      const e = new Error(`can only override margin on an awaiting or armed request (status=${req.status})`); e.code = 'NOT_OPEN'; throw e;
    }
    // Same hard stop as capture(): only the auction actually closing refuses a re-price. A late
    // re-price rebuilds the live ladder (reArmWithNewBand -> engine.stop + arm), and the engine now
    // sends that fresh monitor straight to the FLOOR inside the final window (bidEngine _decide), so
    // a last-second re-price commits our winning price instead of re-establishing at the opening -
    // safe to accept right up to close. Only past the real close is there nothing left to bid.
    const closesAt = effectiveCloseAt(req.load);
    if (req.status === 'armed' && closesAt && Date.now() >= closesAt) {
      const e = new Error('this auction has closed on the portal'); e.code = 'GONE'; throw e;
    }
    let v;
    // The stored band is exempt from the rows-below-minimum rule, so re-saving it unchanged (a
    // legacy band whose minimum sits above its lowest row) is not refused.
    try { v = validateMargins(marginsPct, minMarginPct, { marginsPct: req.marginsPct, minMarginPct: req.minMarginPct }); }
    catch (ve) { const e = new Error(`invalid margin override: ${ve.message}`); e.code = 'BAD_INPUT'; throw e; }
    // Cost change is optional and only meaningful once a cost has been captured (armed) - an
    // awaiting request has no price.cost yet, that's what capture() is for. Same Rs >= 1 floor
    // capture() enforces (a sub-rupee cost rounds to 0 in buildBandLadder, collapsing the floor
    // to break-even). A NEW cost re-prices the whole ladder; the engine's fired-rung carryover
    // is matched by PRICE (see bidEngine.remapFiredRungs), so a cost change correctly re-fires
    // a fresh bid off the new ladder instead of colliding with a stale index.
    let newCost = req.price ? req.price.cost : null;
    // A RE-PRICE MAY REPLACE THE PER-TYPE VECTOR, AND MUST NEVER LEAVE A STALE ONE BEHIND. The
    // adapter turns a rung into per-line rates by scaling each type's cost against the blended one
    // the ladder was built from, so a `cost` that no longer matches `costByType` would put every
    // line at the wrong ratio. Re-priced with a vector -> both replaced together; re-priced with a
    // bare cost -> the vector is dropped and the load goes back to one rate on every type.
    const newByType = (req.status === 'armed') ? normalizeCostByType(costByType, req.load && req.load.cargoTypes) : null;
    if (newByType) newCost = newByType.cost;
    else if (cost != null && req.status === 'armed') {
      const c = Number(cost);
      if (!(c >= 1) || !Number.isFinite(c)) { const e = new Error('cost must be a finite number of at least Rs 1'); e.code = 'BAD_INPUT'; throw e; }
      newCost = c;
    }
    if (req.status === 'armed' && newCost > 0) {
      let plan;
      try { plan = buildBandLadder({ cost: newCost, marginsPct: v.marginsPct, minMarginPct: v.minMarginPct }); }
      catch (planErr) { const e = new Error(`cannot re-price: bid plan not buildable (${planErr.message})`); e.code = 'BAD_INPUT'; throw e; }
      // Judge the plan the ENGINE will arm, when the caller can supply it. buildBandLadder is only
      // the band; arm() puts it through the rest of _planFor, and the round-figure grid moves the
      // floor UP (ceil to the step) - so a gate reading the raw band would be permissive by up to
      // one step and could save a re-price the engine then refuses to bid, with a green receipt.
      // Same reasoning, and the same source, as the ceiling gate's planPreview.
      if (plan && planFloor != null && Number.isFinite(Number(planFloor))) plan = Object.assign({}, plan, { floor: Number(planFloor) });
      // BUILDABLE IS NOT BIDDABLE. The check above only asks whether a ladder can be constructed;
      // it never asks whether the load can still be bid from where our own price already stands.
      // A reverse auction takes only an improvement on our last offer, so a ladder whose LOWEST
      // rung is not below the standing bid cannot land a single price - and accepting it rebuilds
      // a live monitor around prices the portal will refuse, which is how load 260908LD2Z spent
      // 114 minutes re-sending 41,420 against its own live 31,610.
      assertLadderReachable(plan, standingBid);
    }
    const marginOverride = { marginsPct: v.marginsPct, minMarginPct: v.minMarginPct, setBy: setBy || 'operator', setAt: Date.now() };
    const below = await this.belowCustomerMinimum(req, v);
    if (below) marginOverride.belowMinimum = { ...below, setBy: marginOverride.setBy, setAt: marginOverride.setAt };
    const patch = { marginsPct: v.marginsPct, minMarginPct: v.minMarginPct, marginSource: 'bid', marginOverride };
    if (req.status === 'armed' && req.price) {
      patch.price = Object.assign({}, req.price, { cost: newCost, marginsPct: v.marginsPct, minMarginPct: v.minMarginPct });
      if (newByType) patch.price.costByType = newByType;
      else if (cost != null) delete patch.price.costByType;
    }
    // Transit-days recovery (set-once): fill the gap on an armed transit-required load that was
    // captured before the transit build existed. Existing days always win (sticky per load);
    // a non-transit load never stores days at all. An invalid value is simply not stored - the
    // engine's MISSING_TRANSIT_TIME refusal keeps alerting until a valid one lands.
    const needsTransit = !!(req.load && req.load.rules && req.load.rules.loadIsTransitTimeOn);
    const hasDays = req.price && req.price.transitDays != null;
    if (needsTransit && !hasDays && patch.price) {
      const days = normalizeTransitDays(transitDays);
      if (days != null) patch.price.transitDays = days;
    }
    // Re-priced truck count: an armed multi-vehicle load's desk-chosen count can be adjusted on a
    // re-price the same way the cost is - reArmWithNewBand replays armFromRequest, which reads it off
    // price.bidVehicleCount. Validated (whole number, 1..total) or throws BAD_INPUT. Only meaningful
    // on an armed re-price (patch.price exists); an omitted value leaves the stored count unchanged.
    if (req.status === 'armed' && patch.price) {
      const vehicleCount = normalizeBidVehicleCount(bidVehicleCount, req.load && req.load.units);
      if (vehicleCount != null) patch.price.bidVehicleCount = vehicleCount;
    }
    // Any fresh re-price clears the previous hold. The caller re-establishes it when the new numbers
    // are held too, so a stale panel can never outlive the correction it described.
    Object.assign(patch, retireHold(req, 'superseded_by_reprice'), bumpRepriceEpoch(req));
    const updated = await this._patchAuthorisedBy(token, patch, req.status);
    this.log(`[price-req] bid-level margin override on ${redactToken(token)} (load ${req.loadId}) -> ${v.marginsPct.join('/')}% floor ${v.minMarginPct}%${(cost != null && req.status === 'armed') ? ' (cost updated)' : ''}`);
    return updated;
  }

  /**
   * Write back the floor margin armFromRequest had to substitute for a stored 0 (see there for why
   * the substitution exists). Deliberately narrow: it moves the two floor-margin fields and nothing
   * else, so a heal can never be mistaken for a re-price - the cost, the margin steps, the override
   * and the audit trail all stay exactly as they were. A missing row is a no-op rather than an
   * error, because this runs behind a fire-and-forget catch on the arm path.
   */
  async healZeroFloorMargin(token, minMarginPct) {
    const req = await this.getByToken(token);
    if (!req) return null;
    // The read above and the write below are not atomic, and patchDoc is a shallow top-level
    // Object.assign - so writing a `price` rebuilt from this read would replace the whole nested
    // object and silently revert a re-price that landed in between, losing the desk's new COST and
    // not merely a margin. Heal ONLY a record that still reads as a zero floor: anything else has
    // already been corrected by a writer that knew more than this one does. That also makes the
    // heal idempotent, so a repeated arm on the same load cannot walk a corrected band backwards.
    //
    // The SAME resolution the caller used (effectiveFloorMarginPct), not the bare field: the
    // caller's trigger (floorMarginSubstitution) also falls back to the band's own lowest anchor
    // when minMarginPct is absent, and a narrower gate here would refuse to heal exactly the
    // records that reached this call because the caller's wider check fired.
    const marginsPct = req.price ? req.price.marginsPct : req.marginsPct;
    const currentPct = req.price ? req.price.minMarginPct : req.minMarginPct;
    const current = effectiveFloorMarginPct({ marginsPct, minMarginPct: currentPct });
    if (!(Number.isFinite(current) && current <= 0)) return null;
    const patch = { minMarginPct };
    if (req.price) patch.price = Object.assign({}, req.price, { minMarginPct });
    const updated = await this.store.patchDoc(COLLECTION, token, patch);
    this.log(`[price-req] healed 0% floor margin on ${redactToken(token)} (load ${req.loadId}) -> ${minMarginPct}%`);
    return updated;
  }

  /** Clear a bid-level override -> revert to the inherited (customer/default) band, re-resolved live. */
  async clearBidOverride(token, { standingBid, planFloor } = {}) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'awaiting_price' && req.status !== 'armed') {
      const e = new Error(`can only clear an override on an awaiting or armed request (status=${req.status})`); e.code = 'NOT_OPEN'; throw e;
    }
    // Same hard stop as setBidOverride: only the auction actually closing refuses a revert (which
    // also rebuilds the live ladder via reArmWithNewBand). Accepted right up to close; the engine
    // fires the floor into whatever window is left.
    const closesAt = effectiveCloseAt(req.load);
    if (req.status === 'armed' && closesAt && Date.now() >= closesAt) {
      const e = new Error('this auction has closed on the portal'); e.code = 'GONE'; throw e;
    }
    const band = await this.resolveInherited(req.load || {}, req.platformKey || this.platformKey);
    // A REVERT IS A RE-PRICE, and it is the one most likely to be unreachable. The inherited band it
    // restores is the one the desk overrode to make this load biddable, so reverting RAISES the
    // floor - the exact move that puts the ladder above what the portal will still take from us. The
    // ceiling gate on this route already argues this direction for its own invariant; this is the
    // same argument for the standing bid. Judged against the band being RESTORED and the cost
    // already stored, never against the override about to be discarded.
    const revertCost = Number(req.price && req.price.cost);
    if (req.status === 'armed' && Number.isFinite(revertCost) && revertCost > 0) {
      // Reported, not swallowed, and reported the way setBidOverride reports the identical failure.
      // A null plan used to skip assertLadderReachable outright, so the ONE input that disables this
      // guard was an input the guard never got to see - on the route the comment above calls the one
      // most likely to be unreachable. A band that will not build is also a band the engine cannot
      // arm, so refusing at submit is the cheap moment to say so.
      let plan;
      try { plan = buildBandLadder({ cost: revertCost, marginsPct: band.marginsPct, minMarginPct: band.minMarginPct }); }
      catch (planErr) { const e = new Error(`cannot revert: bid plan not buildable (${planErr.message})`); e.code = 'BAD_INPUT'; throw e; }
      if (planFloor != null && Number.isFinite(Number(planFloor))) plan = Object.assign({}, plan, { floor: Number(planFloor) });
      assertLadderReachable(plan, standingBid);
    }
    const patch = Object.assign(
      { marginsPct: band.marginsPct, minMarginPct: band.minMarginPct, marginSource: band.source, marginOverride: null },
      retireHold(req, 'superseded_by_reprice'), bumpRepriceEpoch(req));
    if (req.status === 'armed' && req.price) patch.price = Object.assign({}, req.price, { marginsPct: band.marginsPct, minMarginPct: band.minMarginPct });
    const updated = await this._patchAuthorisedBy(token, patch, req.status);
    this.log(`[price-req] cleared override on ${redactToken(token)} (load ${req.loadId}) -> ${band.source}`);
    return updated;
  }

  /**
   * Operator manually declines a load: awaiting_price -> 'dismissed'. STICKY on purpose - the
   * doc stays, so discovery's one-request-per-load guard won't re-create it next tick (a hard
   * delete would reappear within one poll, since the load still matches the targets). pruneEnded
   * clears it after the auction ages out. Only an un-acted (awaiting) request can be dismissed.
   */
  /**
   * Record the first time this request's price-capture link was actually OPENED (any GET, any
   * status) - a provider-accepted send only proves the message reached the platform, never that a
   * human looked at it (D026). Idempotent by construction: once `openedAt` is set, every later
   * open (including a resubmit, a re-price, a bot, a prefetch) is a no-op - the FIRST open is the
   * fact the scorecard needs, and nothing here tries to tell a real view from any other kind. Best
   * effort: called fire-and-forget from the page route, never on the render's critical path.
   *
   * OFF THE RENDER PATH via `setImmediate`, not the store's Async seam (review of 99c4bd0's first
   * cut, which used getDocAsync/putDocAsync). Every OTHER writer of this collection - capture,
   * hold, resume, dismiss, stop - still goes through the plain synchronous patchDoc/putDoc, which
   * does NOT serialize against the store's async queue (that queue only orders calls that go
   * through it). Mixing the two let a synchronous write here race a concurrent synchronous write
   * from another request's handler for the SAME priceRequests.json: two renames onto one
   * destination from two different execution contexts, which reproduced as a real, repeatable
   * `EPERM: operation not permitted, rename ...` on Windows (test-pin-from-notes.js, caught by the
   * full suite, not by this item's own pin). `setImmediate` still uses the synchronous path -
   * every write to this collection stays on the ONE path that is safe by construction (JS
   * single-threading never interleaves two synchronous calls) - it just moves the ~30ms write off
   * the current tick so it never accounts against this specific request's own handling.
   */
  markOpened(token, req) {
    if (req && req.openedAt != null) return Promise.resolve(req);
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        this.getByToken(token).then((cur) => {
          if (!cur || cur.openedAt != null) return resolve(cur);
          resolve(this.store.patchDoc(COLLECTION, token, { openedAt: Date.now() }));
        }).catch(reject);
      });
    });
  }

  async dismiss(token) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'awaiting_price') { const e = new Error(`can only dismiss an awaiting request (status=${req.status})`); e.code = 'NOT_OPEN'; throw e; }
    const updated = await this.store.patchDoc(COLLECTION, token, { status: 'dismissed', dismissedAt: Date.now() });
    this.log(`[price-req] dismissed ${redactToken(token)} (load ${req.loadId}) - operator declined`);
    return updated;
  }

  /**
   * Un-dismiss: 'dismissed' -> 'awaiting_price', so a load declined by mistake (or reconsidered)
   * comes back to the queue. Blocked only once the auction has actually closed - reviving a closed
   * one would only bounce straight to skipped. A load still open (even inside the danger zone) can
   * be restored and priced best-effort, same as any late cost.
   */
  async restore(token) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'dismissed') { const e = new Error(`can only restore a dismissed request (status=${req.status})`); e.code = 'NOT_OPEN'; throw e; }
    const now = Date.now();
    const closesAt = effectiveCloseAt(req.load);
    if (closesAt && now >= closesAt) { const e = new Error('that auction has already closed'); e.code = 'GONE'; throw e; }
    // restore() un-dismisses a row back into awaiting_price, and finalizeClosed never sweeps
    // 'dismissed' - so this is the one path that can re-introduce a placeholder the sweeps can
    // no longer retire.
    assertRealClose(closesAt, now);
    const updated = await this.store.patchDoc(COLLECTION, token, { status: 'awaiting_price', dismissedAt: null });
    this.log(`[price-req] restored ${redactToken(token)} (load ${req.loadId}) -> awaiting_price`);
    return updated;
  }

  /** Roll a captured request back to open (arm failed after capture; the human must retry). */
  async reopen(token) {
    return this.store.patchDoc(COLLECTION, token, { status: 'awaiting_price', price: null, capturedAt: null });
  }

  /**
   * Record that a load is held after a correction the portal cannot take, and what the desk was
   * told about it. The ENGINE is what actually stops bidding (_holdAboveStandingBid latches at
   * _decide, before the wire); this is the durable copy the price page reads back, which is what
   * makes it a panel that survives a reload rather than a bubble that expired in 3.5 seconds.
   *
   * Deliberately does NOT set status 'stopped'. setBidOverride refuses on 'stopped' (NOT_OPEN
   * above), so a stopped load's cost could never be corrected again - the desk would get exactly
   * one correction per load and then the record would freeze, which is the same class of bug as
   * the one this fixes.
   */
  async holdBidding(token, hold) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    const updated = await this._patchAuthorisedBy(token, { hold: Object.assign({ at: Date.now() }, hold) }, 'armed');
    this.log(`[price-req] holding ${redactToken(token)} (load ${req.loadId}) - status stays ${req.status}`);
    return updated;
  }

  /**
   * Take a held load OFF hold by putting back the plan it was bidding before the correction.
   *
   * THIS IS A RE-PRICE, not a new bidding mode. It restores a cost and a band that already priced a
   * bid this portal accepted, and hands the load back to the same ladder under the same gates - the
   * caller re-arms exactly as any other re-price does. Nothing here decides a price.
   *
   * The plan comes off the hold record's own `resume` snapshot, taken at hold time, so a second
   * correction on an already-held load cannot make the FIRST correction the thing we resume to. A
   * record without one refuses rather than guessing: there is no safe default for the cost a live
   * auction bids from.
   *
   * assertLadderReachable runs here for the same reason setBidOverride runs it - the restored plan
   * has to be able to improve on our own standing bid, or resuming would rebuild a monitor around
   * prices the portal will refuse. It is the pre-correction plan, so it passes; the check is what
   * makes that a fact rather than an assumption.
   */
  async resumeBidding(token, { reason = 'resumed_by_desk', standingBid = null, planFloor = null } = {}) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    const hold = req.hold;
    if (!hold || hold.kind !== 'standing') {
      const e = new Error('this load is not on hold'); e.code = 'NOT_OPEN'; throw e;
    }
    const resume = hold.resume || null;
    const cost = Number(resume && resume.cost);
    if (!Number.isFinite(cost) || !(cost >= 1)) {
      const e = new Error('the cost this load was bidding before the correction is not on record, so it cannot be resumed here. Re-price it with that cost instead.');
      e.code = 'BAD_INPUT'; throw e;
    }
    // Past the close there is nothing to resume INTO. Refused before any write, so a late tap leaves
    // the hold record exactly as it was and the page keeps showing the held-closed state.
    const closesAt = effectiveCloseAt(req.load);
    if (closesAt && Date.now() >= closesAt) {
      const e = new Error('this auction has closed on the portal'); e.code = 'GONE'; throw e;
    }
    // Refused BEFORE any write, because the caller's re-arm is what makes a resume real: on a load
    // that is not armed, retiring the hold here spends it on a load nothing re-arms and leaves the
    // desk a green message over a load sitting out the auction.
    //
    // BELOW the close guard, and that order is load-bearing: finalizeClosed sweeps a held load
    // 'armed' -> 'closed' on the first tick past its close without touching the hold, so asking
    // about status first answers every post-close tap with "re-arm it first" - which rearm() then
    // refuses, because it takes only 'stopped'.
    if (req.status !== 'armed') {
      const e = new Error(`this load is not bidding (status=${req.status}), so resuming cannot put it back on the ladder - re-arm it first, then resume`);
      e.code = 'NOT_OPEN'; throw e;
    }
    let v;
    try { v = validateMargins(resume.marginsPct, resume.minMarginPct, resume); }
    catch (ve) { const e = new Error(`cannot resume: the saved band is not valid (${ve.message})`); e.code = 'BAD_INPUT'; throw e; }
    let plan;
    try { plan = buildBandLadder({ cost, marginsPct: v.marginsPct, minMarginPct: v.minMarginPct }); }
    catch (planErr) { const e = new Error(`cannot resume: bid plan not buildable (${planErr.message})`); e.code = 'BAD_INPUT'; throw e; }
    if (planFloor != null && Number.isFinite(Number(planFloor))) plan = Object.assign({}, plan, { floor: Number(planFloor) });
    assertLadderReachable(plan, standingBid);
    const patch = Object.assign({
      marginsPct: v.marginsPct, minMarginPct: v.minMarginPct,
      // The pre-correction SOURCE too, so a load that was on its customer's band before the
      // correction does not come back wearing "custom for this load".
      marginSource: resume.marginSource || 'bid',
      marginOverride: resume.marginOverride || null,
    }, retireHold(req, reason), bumpRepriceEpoch(req));
    if (req.price) {
      patch.price = Object.assign({}, req.price, { cost, marginsPct: v.marginsPct, minMarginPct: v.minMarginPct });
      // Same rule setBidOverride applies: a cost and a per-type vector must move together or the
      // adapter scales every line off a ratio that no longer holds.
      if (resume.costByType) patch.price.costByType = resume.costByType;
      else delete patch.price.costByType;
      // The count is the vcq on the wire, and the same re-price form moves it with the cost. A
      // snapshot taken before the count was carried has no key at all; its count is left as it stands.
      if (Object.prototype.hasOwnProperty.call(resume, 'bidVehicleCount')) {
        if (resume.bidVehicleCount != null) patch.price.bidVehicleCount = resume.bidVehicleCount;
        else delete patch.price.bidVehicleCount;
      }
    }
    const updated = await this._patchAuthorisedBy(token, patch, 'armed');
    this.log(`[price-req] resumed ${redactToken(token)} (load ${req.loadId}) - cost back to ${cost}, hold closed: ${reason}`);
    return updated;
  }

  /**
   * Put back every field resumeBidding wrote, for a resume whose re-arm then failed. `prior` is the
   * held document read before the resume, so the hold, its history and the corrected plan return
   * exactly and the desk's Resume button is there again.
   */
  async undoResume(token, prior) {
    return this._putBackPlan(token, prior, 'resume');
  }

  /**
   * The same put-back for a re-price or revert whose re-arm failed: setBidOverride and
   * clearBidOverride write the same fields resumeBidding does, so `prior` - the doc read before the
   * write - restores the plan, the hold and its history exactly.
   */
  async undoReprice(token, prior) {
    return this._putBackPlan(token, prior, 're-price');
  }

  async _putBackPlan(token, prior, what) {
    // The epoch too: the failed write bumped it, and a re-arm on a bumped epoch reads the put-back
    // plan as a new quote and drops the portal's verdicts on it.
    const plan = {
      marginsPct: prior.marginsPct, minMarginPct: prior.minMarginPct,
      marginSource: prior.marginSource, marginOverride: prior.marginOverride || null,
      price: prior.price,
      repriceEpoch: Number.isInteger(prior.repriceEpoch) ? prior.repriceEpoch : 0,
    };
    let updated;
    try {
      updated = await this._patchAuthorisedBy(token,
        Object.assign({ hold: prior.hold || null, holdHistory: prior.holdHistory || null }, plan), 'armed');
    } catch (e) {
      if (e.code !== 'NOT_OPEN' || e.actual !== 'stopped') throw e;
      // A Stop landed after the write. The change did not happen, so its figures go back and a later
      // Re-arm bids the prior plan; the hold stays ended, as every stop ends it.
      await this._patchAuthorisedBy(token, Object.assign(retireHold(prior, 'superseded_by_operator_stop'), plan), 'stopped');
      throw e;
    }
    this.log(`[price-req] ${what} undone on ${redactToken(token)} (load ${prior.loadId}) - back on ${prior.price && prior.price.cost}`);
    return updated;
  }

  /**
   * Park a captured request whose portal cannot bid yet: 'armed' -> 'stopped', cost KEPT.
   *
   * The counterpart to reopen(), and the difference is the whole point. reopen() is for an arm that
   * FAILED and should be RETRIED, so it nulls the price and sends the row back to 'awaiting_price' -
   * from where expireOverdue (which reads listOpen, i.e. 'awaiting_price' only) later sweeps it to
   * 'skipped_no_price' and discovery alerts "no number entered". Using it here would file the desk's
   * own work as desk non-response, about a load they DID price, on the one portal where retrying can
   * never help. This lands on 'stopped' instead: not swept by expireOverdue, still retired by
   * finalizeClosed when the auction ends, and the captured cost survives so the existing Re-arm
   * affordance is exactly right the day the write gate opens.
   *
   * `heldReason` is additive and records WHY the row is stopped, so a stop the operator performed
   * and a stop the system performed are distinguishable in the record rather than by inference.
   */
  async holdUnbiddable(token, reason, { expectedStatus = null } = {}) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    const patch = {
      status: 'stopped', stoppedAt: Date.now(), heldReason: String(reason || 'unbiddable'),
    };
    const updated = expectedStatus == null
      ? await this.store.patchDoc(COLLECTION, token, patch)
      : await this._patchAuthorisedBy(token, patch, expectedStatus);
    this.log(`[price-req] held ${redactToken(token)} (load ${req.loadId}) - cost KEPT, not armed: ${reason}`);
    return updated;
  }

  /**
   * The engine stopped bidding a load and handed it to the desk to bid by hand. An armed request
   * leaves 'armed' with that reason, so the /price and /track pages stop saying the engine will bid
   * it, and a re-price needs a deliberate Re-arm instead of silently putting the engine back on a
   * load the desk is bidding. Anything not armed is left alone.
   */
  async holdHandedOff(loadId, platformKey) {
    const req = await this.getByLoad(loadId, platformKey);
    if (!req || req.status !== 'armed') return null;
    return this.holdUnbiddable(req.id, 'tick_fault_handoff');
  }

  /**
   * Operator stops an armed load: 'armed' -> 'stopped'. The bot stops bidding it (the caller
   * also calls engine.stop), but the captured cost is KEPT so a later rearm needs no re-entry.
   * Does not retract any bid already placed on the portal - a reverse auction can't be un-bid.
   */
  async stop(token) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'armed') { const e = new Error(`can only stop an armed load (status=${req.status})`); e.code = 'NOT_OPEN'; throw e; }
    // A held record that is also stopped can no longer be corrected or resumed (setBidOverride and
    // resumeBidding both need 'armed'), so the stop ends the hold, keeping it in holdHistory.
    const updated = await this.store.patchDoc(COLLECTION, token, Object.assign(
      { status: 'stopped', stoppedAt: Date.now() }, retireHold(req, 'superseded_by_operator_stop')));
    this.log(`[price-req] stopped ${redactToken(token)} (load ${req.loadId}) - operator stopped bidding`);
    return updated;
  }

  /**
   * Re-arm a stopped load: 'stopped' -> 'armed' (the caller re-arms the engine from the kept
   * cost). Blocked once the auction has closed. The engine preserves already-fired rungs, so a
   * rearm resumes where it left off and never re-spends a rung.
   */
  async rearm(token) {
    const req = await this.getByToken(token);
    if (!req) { const e = new Error('unknown price-request token'); e.code = 'NOT_FOUND'; throw e; }
    if (req.status !== 'stopped') { const e = new Error(`can only re-arm a stopped load (status=${req.status})`); e.code = 'NOT_OPEN'; throw e; }
    const closesAt = effectiveCloseAt(req.load);
    const nowMs = Date.now();
    if (closesAt && nowMs >= closesAt) { const e = new Error('that auction has already closed'); e.code = 'GONE'; throw e; }
    // So the Re-arm button on a stale placeholder row can't resurrect the forever-armed monitor.
    assertRealClose(closesAt, nowMs);
    // heldReason must clear here, not just stoppedAt: the store patch is a MERGE (fileStore.js),
    // so a stale reason from a prior hold survives every later patch otherwise - a load held for
    // platform_bidding_disabled, re-armed, then genuinely stop()ped by an operator would still
    // read as a portal fault, not the operator decision that just happened.
    // The epoch moves too: the desk is asking the bot to try this load again, so the portal's refusals
    // from before the stop are re-learned rather than carried back as a stand-down. Landed rungs are
    // not touched by it (they ride firedRungs), so nothing already on the board is re-spent.
    const updated = await this.store.patchDoc(COLLECTION, token,
      Object.assign({ status: 'armed', stoppedAt: null, heldReason: null }, bumpRepriceEpoch(req)));
    this.log(`[price-req] re-armed ${redactToken(token)} (load ${req.loadId}) -> armed`);
    return updated;
  }

  /**
   * Retire requests whose auction has closed: awaiting_price / armed / stopped -> terminal 'closed'.
   * ('dismissed' and 'skipped_no_price' are already terminal, left as-is.) Once bidding ends
   * the request is no longer actionable - the outcome, if a bid landed, lives in the bid log /
   * History. It then drops from the live worklist and ages out via pruneEnded. Runs each tick.
   *
   * Two closes count as "no longer a live auction": one already in the past, and one further out
   * than the listing horizon - SuperProcure's shared year-2100 placeholder (biddingOn:0 loads),
   * which parses as a valid Date so `nowMs >= closesAt` can never fire and the row would otherwise
   * sit on the worklist forever with a Re-arm button that resurrects a monitor that can never fire
   * (docs/diagnoses/2026-07-13_zero-bid-silent-miss-and-placeholder-cleanup.md; the same
   * MAX_PLAUSIBLE_DEADLINE_MS bound expireOverdue uses on the intake side). For that placeholder
   * case, normalize the bogus closesAt to now as well, so every closesAt-keyed consumer - the
   * console worklist filter and pruneEnded's aging - treats the retired row correctly instead of
   * seeing a live-looking ~74-years-out close. A real past close needs no such rewrite.
   */
  // PLATFORM-SCOPED BY ITS CALLER, and that scope is a correctness requirement rather than tidiness.
  // A record's close only ever moves forward under its OWN portal's poller (refreshLiveClose, off
  // that portal's listing), so a poller sweeping another portal's records is reading a snapshot it
  // has no way to refresh: it retires a still-running auction off a superseded close, permanently,
  // because 'closed' is terminal and refreshLiveClose refuses a terminal record. Each portal's own
  // poller retires its own ended auctions, so nothing is left on the worklist by narrowing this.
  // Omitting the key sweeps every portal, which is correct only for a caller that owns them all.
  async finalizeClosed(nowMs = Date.now(), { platformKey } = {}) {
    const all = platformKey ? await this.listFor(platformKey) : await this.listAll();
    let closed = 0;
    for (const r of all) {
      const closesAt = effectiveCloseAt(r.load);
      if (!closesAt) continue;
      const sweepable = r.status === 'awaiting_price' || r.status === 'armed' || r.status === 'stopped';
      if (!sweepable) continue;
      const pastClose = nowMs >= closesAt;
      const placeholderClose = isPlaceholderClose(closesAt, nowMs);
      if (!pastClose && !placeholderClose) continue;
      const patch = placeholderClose
        ? { status: 'closed', load: Object.assign({}, r.load, { closesAt: nowMs }) }
        : { status: 'closed' };
      await this.store.patchDoc(COLLECTION, r.id, patch);
      closed += 1;
    }
    return closed;
  }

  /**
   * Reconcile awaiting-price requests against a target filter (matchFn(load) -> bool).
   * Drops the un-acted asks whose load no longer matches - e.g. after a bidding target is
   * removed or hard-close-only is toggled on. ONLY touches 'awaiting_price': an armed request
   * is a committed decision (a human priced it, the bot may be live on it) and is never
   * dropped by a targets edit - the allowlist is an intake filter, not a retroactive kill.
   * Reversible: re-adding the target re-creates the request on the next discovery tick.
   * Returns the dropped requests.
   *
   * opts.owner ({accountId}) scopes the reconcile to that account's own requests -
   * with per-account allowlists, poller A must never drop poller B's asks just
   * because B's shipper is outside A's scope. Untagged (pre-multi-account) requests
   * belong to 'primary'. No owner = today's single-account behaviour (all requests).
   */
  /** listAll() scoped to one portal's own records (see ownedBy). The filtered readers' entry
   *  point - every caller that must not fold GoComet into an SP-only view uses this instead of
   *  listAll(), so "which portal" is stated at the call site, never assumed. */
  async listFor(platformKey) {
    return (await this.listAll()).filter((r) => ownedBy(r, platformKey));
  }

  // opts.platformKey scopes it to one portal, and matchFn is why that matters: the filter is the
  // CALLER'S allowlist, which describes what that portal bids and says nothing true about another
  // portal's loads. An SP poller's hardCloseOnly list rejects every (soft-close) GoComet load, so
  // unscoped this hard-DELETES the other portal's asks. `owner` alone does not cover it - it is
  // undefined on a single-account box, and where it is set the isolation rests on the two portals
  // happening to have chosen different accountIds. Each portal's poller reconciles its own asks.
  async dropOutOfScope(matchFn, { owner, platformKey } = {}) {
    if (typeof matchFn !== 'function') return [];
    const open = await this.listOpen(); // awaiting_price only
    const dropped = [];
    for (const r of open) {
      if (platformKey && !ownedBy(r, platformKey)) continue;
      if (owner && (((r.account && r.account.accountId) || 'primary') !== owner.accountId)) continue;
      if (!matchFn(r.load || {})) {
        await this._noteMovedToken(r);   
        await this.store.removeDoc(COLLECTION, r.id);
        dropped.push(r);
      }
    }
    if (dropped.length) this.log(`[price-req] dropped ${dropped.length} awaiting-price request(s) no longer in scope`);
    return dropped;
  }

  /** Mark awaiting-price requests whose AUCTION has closed as skipped. Returns the skipped ones (to
   *  alert). A close time that is EITHER already past OR implausibly far in the future (an SP
   *  year-2100 placeholder - see MAX_PLAUSIBLE_DEADLINE_MS) is expirable: an eternally-future
   *  placeholder is not a real schedule and leaving it pending clutters the worklist forever.
   *  Keyed off closesAt, NOT deadlineAt: deadlineAt is no longer a wall - an awaiting request stays
   *  actionable right up to the real close, so sweeping at deadlineAt would retire a still-priceable
   *  request while it sits in the danger zone. */
  // PLATFORM-SCOPED BY ITS CALLER, same requirement as finalizeClosed above and biting harder: a
  // record swept off another portal's stale snapshot lands on terminal 'skipped_no_price', so the
  // desk's cost is refused with NOT_OPEN at submit on an auction that is still running, and the
  // 'price_expired' alert the caller then raises reports the desk's own work as desk non-response -
  // the misattribution refreshLiveClose exists to prevent. Fires BEFORE finalizeClosed on the tick,
  // so scoping only that one would leave this half live.
  async expireOverdue(nowMs = Date.now(), { platformKey } = {}) {
    const open = await this.listOpen();
    const expired = [];
    for (const r of open) {
      if (platformKey && !ownedBy(r, platformKey)) continue;
      const closesAt = effectiveCloseAt(r.load);
      if (!closesAt) continue;
      const overdue = nowMs >= closesAt;
      const implausiblyFarFuture = isPlaceholderClose(closesAt, nowMs);
      if (overdue || implausiblyFarFuture) {
        await this.store.patchDoc(COLLECTION, r.id, { status: 'skipped_no_price' });
        expired.push(r);
      }
    }
    return expired;
  }

  /**
   * Awaiting-price requests whose pricing deadline is approaching but hasn't passed - a
   * follow-up nudge for the desk's well-documented "prices at the last minute" habit (see
   * docs/diagnoses/2026-07-14_price-form-countdown-lock-dead.md). Due once, when `now` crosses
   * the reminder point. Returns the requests newly due (does NOT mark them - the caller marks via
   * markReminded only after a confirmed delivery, mirroring the notified/markNotified pattern).
   *
   * The reminder point is normally `deadlineAt - leadMs`, but it is CLAMPED to at least
   * `REMINDER_MIN_GAP_MS` after the original notify. Before 2026-07-25 a window shorter than the
   * lead was dropped outright ("the one original ping is enough"), which was harmless at the old
   * 60s lead but not at the 5-minute one: measured over 504 real requests, 0.8% of ask -> cutoff
   * windows are under 5 minutes, and those are exactly the loads where a nudge matters most. So a
   * short-fuse load now still gets EXACTLY ONE reminder, just later than the nominal lead - as
   * soon as a readable gap after the ask allows. The gap is what the old rule was really
   * protecting: a reminder landing on top of the ask is a duplicate ping, not a nudge.
   *
   * Still skipped when even the clamped point is at/past the deadline - a load whose entire window
   * is shorter than the minimum gap has no room for a second, distinct message, and the original
   * ask already carries the cutoff.
   */
  // Deliberately cross-platform, unlike the close-keyed sweeps above: it writes no status and
  // retires nothing, so a foreign poller reaching a record first costs it no state - and the
  // channel is resolved per record by notifyModeFor(platformOf(request)), so the nudge still goes
  // out on the owning portal's channel whichever poller sends it.
  //
  // deadlineAt deliberately does NOT follow a refreshed close, unlike every close-keyed gate. This
  // is one nudge per request, latched by reminderSentAt, and the ask it follows already carried the
  // original cutoff; re-deriving it on each extension would re-open the window on a load that has
  // already been nudged and turn a 22-extension auction into a stream of near-identical pings - the
  // WhatsApp noise the gap clamp below exists to prevent. Missing a second nudge costs nothing: the
  // record stays priceable right up to the real close either way, which is the sweeps' job.
  async dueForReminder(nowMs = Date.now(), leadMs) {
    const lead = Number(leadMs);
    if (!(lead > 0)) return [];
    const gap = Math.min(REMINDER_MIN_GAP_MS, lead); // never clamp past the nominal lead point
    const open = await this.listOpen();
    const due = [];
    for (const r of open) {
      if (r.reminderSentAt) continue;
      if (!r.deadlineAt || nowMs >= r.deadlineAt) continue; // no deadline, or already past it (expireOverdue's job)
      const noticeAt = r.notifiedAt || r.createdAt || 0;
      const reminderAt = Math.max(r.deadlineAt - lead, noticeAt + gap);
      if (reminderAt >= r.deadlineAt) continue; // no room left for a distinct nudge before the cutoff
      if (nowMs < reminderAt) continue; // not due yet
      due.push(r);
    }
    return due;
  }

  /** Mark that the approaching-deadline reminder actually went out for this request. Idempotent;
   *  a no-op if the request is gone. Mirrors markNotified. */
  async markReminded(token) {
    const req = await this.getByToken(token);
    if (!req || req.reminderSentAt) return req || null;
    return this.store.patchDoc(COLLECTION, token, { reminderSentAt: Date.now() });
  }

  /** Drop requests whose auction ended > retentionMs ago (keyed off closesAt, so a still-open
   *  auction is never at risk). Bounds the collection - nothing else removes docs. */
  // Deliberately cross-platform, unlike the close-keyed sweeps above: it bounds the WHOLE
  // collection's size, and a per-portal prune would still have to walk every record. A stale
  // snapshot close cannot reach a live record here the way it can there - effectiveCloseAt already
  // follows a refreshed close forward, and a record still inside a running auction is nowhere near
  // the multi-day retention either way.
  async pruneEnded(nowMs = Date.now(), retentionMs = PRUNE_RETENTION_MS) {
    const all = await this.listAll();
    let removed = 0;
    let archiveFailed = 0;
    for (const r of all) {
      const endedAt = effectiveCloseAt(r.load) || r.createdAt;
      if (endedAt == null) continue; // no close/created time -> can't age safely, keep
      if (nowMs - endedAt > retentionMs) {
        // The prune is what bounds the collection, so it runs whatever the archive did. A lost
        // archive row costs a day of history; a discovery tick that stops here stops the desk
        // seeing loads, and that costs the client money.
        try {
          await this.archiveOne(r, endedAt, nowMs);
        } catch (err) {
          archiveFailed += 1;
          this.log(`[price-req] ARCHIVE FAILED for ${redactToken(r.id)} (load ${r.loadId}) - pruning it anyway, this record is lost: ${err && err.message}`);
        }
        await this.store.removeDoc(COLLECTION, r.id);
        removed += 1;
      }
    }
    try {
      for (const a of await this.store.listDocs(ALIAS_COLLECTION)) {
        if (a && a.droppedAt && nowMs - a.droppedAt > retentionMs && a.token) await this.store.removeDoc(ALIAS_COLLECTION, a.token);
      }
    } catch (err) { this.log(`[price-req] alias cleanup skipped: ${err && err.message}`); }
    if (removed) this.log(`[price-req] pruned ${removed} request(s) whose auction ended > ${Math.round(retentionMs / 86_400_000)}d ago${archiveFailed ? ` (${archiveFailed} NOT archived)` : ''}`);
    return removed;
  }

   async _noteMovedToken(req) {
    try {
      await this.store.putDoc(ALIAS_COLLECTION, req.id, {
        token: req.id, loadId: String(req.loadId), platformKey: platformOf(req), droppedAt: Date.now(),
      });
    } catch (err) {
      this.log(`[price-req] could not record moved token for load ${req && req.loadId}: ${err && err.message}`);
    }
  }

  async resolveMovedToken(token) {
    const alias = await this.store.getDoc(ALIAS_COLLECTION, token);
    if (!alias) return null;
    const live = await this.getByLoad(alias.loadId, alias.platformKey);
    return { live: live || null };
  }

  /** Append one request to the durable archive, at most once ever. Returns true when this call
   *  wrote the row, false when it was already there. Throws on a write failure - pruneEnded owns
   *  the decision to proceed regardless. */
  async archiveOne(req, endedAt, nowMs = Date.now()) {
    const seen = await this._archivedIds(nowMs);
    if (seen.has(req.id)) return false;
    // Append BEFORE marking: a failed write leaves the id unmarked and the doc unremoved, so the
    // next tick retries it. A crash between this line and the removeDoc that follows leaves the
    // doc behind too, and the seed below - re-read from disk on restart - is what stops the retry
    // writing a second row.
    await this.store.appendEventAsync(ARCHIVE_STREAM, archiveRow(req, endedAt));
    seen.add(req.id);
    return true;
  }

  async _archivedIds(nowMs) {
    if (this._archivedIdCache) return this._archivedIdCache;
    const seen = new Set();
    // Lower bound only. An upper bound of nowMs would drop any row whose write clock ran ahead of
    // this prune's, and the whole point of the seed is that it misses nothing.
    for (const rec of await this.store.readEvents(ARCHIVE_STREAM, { from: nowMs - ARCHIVE_DEDUPE_LOOKBACK_MS })) {
      if (rec && rec.id) seen.add(rec.id);
    }
    this._archivedIdCache = seen;
    return seen;
  }
}

/**
 * Turn a captured (armed) request into an engine arm/schedule call. Live load ->
 * arm now; not-yet-started -> schedule (the engine wakes + arms at start).
 */
/**
 * The desk's chosen vehicle count for a multi-vehicle FTL (truck-basis) load. BID-MAX-ALWAYS is the
 * default (bid the load's full truck count); this lets the desk LOWER it when BRL can only supply
 * fewer trucks. The count is a whole number in [1, total] - a PARTIAL is allowed, MORE than the load
 * needs is not (you cannot bid for more trucks than the load requires). Returns:
 *   null       - no count supplied, OR the load is not a multi-unit load (round(units) <= 1). The
 *                engine then keeps its bid-max default (round(units)); a single-truck load never
 *                carries one, and the wire stays byte-identical to today.
 *   integer N  - a valid full/partial count: an INTEGER in [1, total]. Never 0 / NaN / a fraction /
 *                above the load's own count.
 * Throws BAD_INPUT on an out-of-range or non-integer count, so a bad count is a VISIBLE rejection at
 * capture time (the desk sees it), not a silent clamp. This is the truck-basis path only: a PMT
 * (per-tonne) load's tonnage is fixed by the load and is never posted here (the price page renders it
 * read-only), so a stray PMT count is inert - the engine bids PMT single regardless. The engine
 * additionally re-clamps to [1, round(units)] (assertValidVcq is the final belt), so even a corrupt
 * persisted count can never over-commit onto the wire.
 */
function normalizeBidVehicleCount(raw, totalUnits) {
  const total = Math.round(Number(totalUnits));
  if (!Number.isFinite(total) || total <= 1) return null; // not a multi-unit load -> no chosen count applies
  if (raw == null || String(raw).trim() === '') return null; // not supplied -> the engine's bid-max default
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > total) {
    const e = new Error(`vehicle count must be a whole number between 1 and ${total} - you cannot bid for more trucks than the load needs (${total})`);
    e.code = 'BAD_INPUT';
    throw e;
  }
  return n;
}

// A capture that finds the request no longer open - armed by another save, or stopped or closed -
// after the caller saw it open. Always an error the desk sees, never a render of the load's page.
function captureLost(status) {
  const words = { stopped: 'stopped', closed: 'closed', skipped_no_price: 'closed without a price' }[status] || 'no longer open';
  const e = new Error(status === 'armed'
    ? 'Not saved: another price was saved for this load just now. Reload to see it.'
    : `Not saved: this load is ${words}.`);
  e.code = 'CAPTURE_LOST';
  e.actual = status;
  return e;
}

/**
 * The desk's cost for EACH truck type on a multi-type load, plus the one blended number every
 * existing consumer already reads.
 *
 * `raw` is one cost per entry of the load's own `cargoTypes`, in that order - the order the page
 * rendered the inputs in - and nothing downstream ever uses that order again: each entry carries
 * its type's `match` token, and the adapter joins on that. Index is the FORM's key, content is the
 * WIRE's key, and they are deliberately not the same thing.
 *
 * THE BLENDED COST IS THE WEIGHTED MEAN, not the average of the rates: sum(cost_i x count_i) over
 * the total truck count. That is the true per-truck cost of the load, so the ladder, the operating
 * floor, hardCostFloorFor, the receipt and the end-of-day value figure all keep meaning exactly
 * what they meant - and the rung the engine picks is a margin over the real cost of this load
 * rather than over an unweighted number no truck was ever priced at.
 *
 * Returns null when the desk gave one rate (nothing supplied), which is the unchanged single-rate
 * path. Throws BAD_INPUT rather than dropping to a blend when the desk DID type per-type numbers
 * and they cannot be used - a per-type entry that silently becomes one rate is the one outcome
 * worse than not offering per-type at all.
 */
function normalizeCostByType(raw, cargoTypes) {
  if (raw == null) return null;
  const list = Array.isArray(raw) ? raw.filter((v) => v != null && String(v).trim() !== '') : null;
  if (!list || !list.length) return null;
  const types = Array.isArray(cargoTypes) ? cargoTypes : [];
  const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };
  if (types.length < 2) bad('this load carries one truck type - enter a single rate');
  if (list.length !== types.length) bad(`enter a cost for each of the ${types.length} truck types on this load`);
  const out = [];
  let weighted = 0;
  let trucks = 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    // No `match` means the snapshot predates the per-type build, so nothing can route this rate to
    // a freight line. Refuse the per-type capture and let the desk price the load with one rate,
    // rather than store a vector the adapter will refuse at bid time.
    if (!t || !t.match || !Number.isInteger(t.count) || t.count <= 0) {
      bad('this load\'s truck types were recorded before per-type pricing existed - enter a single rate for it');
    }
    const c = Number(list[i]);
    if (!Number.isFinite(c) || !(c >= 1)) bad(`the cost for ${t.label || `type ${i + 1}`} must be a finite number of at least Rs 1`);
    out.push({ index: i, label: t.label, match: t.match, count: t.count, cost: c });
    weighted += c * t.count;
    trucks += t.count;
  }
  return { types: out, cost: Math.round(weighted / trucks) };
}

// `opts.requests` is the PriceRequestStore, supplied only so a corrected floor margin can be healed
// back onto the stored record (see the substitution below). Optional: every caller that omits it
// still arms identically, the correction just does not outlive the process.
// THE PORTAL WRITE GATE, checked before a monitor can exist. An adapter that declares it cannot
// bid would otherwise arm normally and throw on every rung of the ladder, and the request would
// sit in status 'armed' - which to the desk means we ARE bidding it. That is a lie of exactly
// the class this integration has shipped before (a desk cost typed into a live page, discarded,
// the load later reported unpriced), and the per-rung throw stream trains the desk to ignore
// engine alerts on the portal that CAN bid.
//
// Read as a CAPABILITY off the adapter, never as a platform test: no caller outside
// src/platform/ may need to know which portal it is talking to (MULTI_PLATFORM_ARCHITECTURE.md
// invariants 2 and 7). Absent is TRUE, so every adapter predating the field - and every
// hand-rolled test double - arms exactly as before; only an explicit false refuses.
//
// Callable on its own because a caller that WRITES before it arms has to ask this BEFORE the write:
// the resume route retires a hold and rolls back a corrected cost on the way to arming, and a
// refusal landing after that has already spent both. One function so the two sites cannot drift.
function assertBiddingEnabled(engine) {
  const caps = (engine && engine.caps) || {};
  if (caps.biddingEnabled === false) {
    const e = new Error('this portal is not live for bidding yet, so we will not bid this load');
    e.code = 'PLATFORM_BIDDING_DISABLED';
    throw e;
  }
}

function armFromRequest(engine, req, opts) {
  if (!req || !req.price || !(req.price.cost > 0)) throw new Error('armFromRequest: request has no captured cost');
  // A SHIPPER TARGET RATE IS NEVER ARMABLE, and this is asserted here rather than at the routes
  // because there is more than one way in: the capture POST, the re-price POST once the record
  // reads 'armed', and the console's margin route all funnel through this function. Arming any of
  // them would build a descending ladder on an enquiry whose auction has already closed, spending
  // revisions against a cap shared with BRL's own bot. One entry point, one refusal.
  if (isTargetPriceReq(req)) {
    const e = new Error('a shipper target rate is answered by a single bid, not by arming the auction engine');
    e.code = 'TARGET_RATE_NOT_ARMABLE';
    throw e;
  }
  assertBiddingEnabled(engine);
  const caps = (engine && engine.caps) || {};
  const load = req.load || {};
  // LoadRules rides onto monitor.meta -> placeBid opts (the carry path). The operator-captured
  // transit days are layered onto the rules HERE - the single merge point every arm path funnels
  // through (capture, re-price via reArmWithNewBand, stop/rearm, and the restart rehydrate that
  // replays the persisted intent this merged object lands on) - so the days stay sticky for every
  // rung/revision on the load. Merged under the LoadRules' own non-wire key (transitDays), never
  // the wire key (transitTime): buildBidPayload owns the days -> "<days>"-string translation.
  const baseRules = load.rules || null;
  // Per-truck-type costs ride the LoadRules the same way transitDays does: a non-wire key on the
  // per-load facts, which _bidOpts already hands the adapter verbatim and arm() already persists on
  // the durable intent. That is the whole reason this design was chosen over N ladders - the engine
  // needs no change at all, and a restart or a scheduled wake restores the vector with the rules.
  // Carried only where the portal can act on it, so a stale vector cannot follow a load onto a
  // platform that prices one line.
  const perTypeCost = (caps.multiCargoBidSupported !== false && req.price.costByType
    && Array.isArray(req.price.costByType.types) && req.price.costByType.types.length > 1)
    ? req.price.costByType : null;
  const ruleAdds = {};
  if (req.price.transitDays != null) ruleAdds.transitDays = req.price.transitDays;
  if (perTypeCost) ruleAdds.costByType = perTypeCost;
  // A LOAD WITH NO LoadRules STILL HAS TO CARRY THESE. The old form required baseRules to be truthy
  // before it would merge, so a load carrying none dropped transitDays and costByType on the floor -
  // and GoComet only attaches a rules object when the enquiry declares a minDecrement or a ceiling
  // (gocometAdapter.js:1648), so an enquiry with neither is exactly the live case that lost them.
  //
  // THIS IS A WIRE CHANGE, NOT A MESSAGING ONE, and that is the point of it. _bidOpts spreads
  // meta.rules into placeBid, so on a no-rules GoComet multi-type enquiry the vector now engages
  // resolvePerTypePrices (gocometAdapter.js:2240) where that function previously short-circuited on
  // a null spec and the load bid one blended rate. Each line gets its own rate, and a vector that
  // cannot be routed to the quote's freight lines is refused rather than blended - handled as a
  // pre-wire refusal in bidEngine's placeBid catch, never as an uncertain outcome.
  //
  // Left as baseRules when there is nothing to add, so a load that carries no rules and adds none
  // still arms with null rather than an invented empty object.
  const rules = Object.keys(ruleAdds).length
    ? Object.assign({}, baseRules || {}, ruleAdds)
    : baseRules;
  const meta = {
    id: req.loadId, lane: load.lane, equipment: load.equipment, units: load.units,
    companyName: load.companyName, softClose: load.softClose,
    // Which portal this load came from, so the engine can stamp it onto the closedBids record at
    // write time (bidEngine's 'armed' event -> BidLogger._onArmed) - the tag bid-log readers need
    // to stay platform-scoped, same reasoning as platformOf() above.
    platformKey: platformOf(req),
    // SP's consignor branch label ("Alwar Cable (1350)") - the ROUTING key for a branch-scoped
    // WhatsApp group, read off the same load snapshot the price ask reads (notifier._priceNeededData).
    // Without it on the engine's events, the ask anchors on the branch group while every later
    // bid_live/outbid/won/lost resolves to the customer's GENERAL group, finds no ask thread there
    // and is silently skipped - the 2026-07-25 blackout. null when the load carries no branch.
    branchName: load.branchName || null,
    // WHO POSTED THE LOAD ({name, mobile, createdBy} | null) - carried onto the engine's events so the
    // WON message can name the shipper-side contact the desk rings to place the vehicle (Suyashh,
    // 2026-07-28). Read off the same load snapshot the price ask and the /price card read, so all
    // three surfaces name one person. DISPLAY-ONLY, exactly like branchName's display half - never a
    // routing or margin key. null on sim/mock loads and on snapshots predating the field.
    poster: load.poster || null,
    // The shipper's OWN reference for this enquiry (GoComet's enquiry.name). Rides the same
    // display-only carry path as poster so the loss receipt can name the number the desk quotes
    // back to the customer; null on SuperProcure, which publishes no such field.
    shipperRef: load.shipperRef || null,
    // The close the monitor's whole countdown, cadence and snipe timing is computed against, so it
    // must be the latest one the portal published rather than the snapshot: arming on a close that
    // has already moved makes every timing decision wrong from frame 1. Same repair the scheduled
    // wake already applies when its own live read disagrees with the captured close.
    closesAt: effectiveCloseAt(load), startsAt: load.startsAt,
    points: load.points || null, // full pickup/drop addresses -> Live Bids / History
    // The lane's two display cells, resolved HERE from the whole snapshot and carried as the
    // RESULT rather than as their inputs. The receipt used to re-resolve them from the bare engine
    // event, which carries neither the shipper note (SuperProcure's only source for a pin behind a
    // 7+-digit address run) nor laneParsed (GoComet's, holding the portal's own zip field). Both
    // gaps rendered a lane that disagreed with the ask's - #114 again, once per portal.
    //
    // The inputs cannot simply ride along instead: laneParsed is display-derived and gocometLane.js
    // deliberately keeps it off meta and the durable intent, because `lane` is what the allowlist,
    // the rehydrated intent and the route-history lookup are keyed on. Carrying the finished cells
    // keeps that wall intact, keeps the shipper's free text off the intent file, and makes the two
    // surfaces agree BY CONSTRUCTION - one call, one input object, the same one the ask renders.
    laneCells: laneEnds(load, platformOf(req)),
    // pricing basis (FTL/PMT), so the engine's multi-vehicle guard has it at bid time and after a
    // restart (arm() persists it on the intent; _intentToArm reads it back). null when unrecorded.
    quoteType: load.quoteType || null,
    // Operator-chosen truck count (bid-max default; a partial when the desk lowered it). Rides the
    // same carry path as quoteType so _multiVehiclePlan can send it as vcq, and survives a restart
    // (arm() persists it; _intentToArm restores it). null -> the engine's bid-max default.
    // DROPPED where the portal cannot express one, so the engine falls back to its bid-max default
    // instead of sending a vcq the write path refuses on every rung. Same capability doctrine as
    // biddingEnabled above (absent is true), and this is the seam rather than the page because a
    // count captured before the portal declared itself - or restored from a durable intent - reaches
    // the engine without the page ever rendering again.
    bidVehicleCount: (caps.partialVehicleCountSupported !== false
      && req.price && Number.isInteger(req.price.bidVehicleCount)) ? req.price.bidVehicleCount : null,
    // Which quote this arm is for (see bumpRepriceEpoch). arm() compares it against the epoch stamped
    // on the persisted verdicts and carries them only where the two agree. A record written before
    // this key existed reads 0, the same value arm() will persist and read back, so a load already
    // live on the day this ships still has its restart carry-back.
    repriceEpoch: Number.isInteger(req.repriceEpoch) ? req.repriceEpoch : 0,
    // D038: the seven fields that used to live ONLY on the short-retention working store
    // (this request, pruned ~7 days after close) - carried onto the engine's events so
    // BidLogger stamps them onto the durable closedBids doc at arm time. Display-only, exactly
    // like branchName/poster above: never a routing, pricing or dedupe key. A load older than the
    // prune window used to lose every one of these permanently once its request was pruned;
    // forward-only (new records only), same as every other additive field in this object.
    loadCode: load.loadCode != null ? load.loadCode : null,
    distanceKm: load.distanceKm != null ? load.distanceKm : null,
    weight: load.weight != null ? load.weight : null,
    weightUnit: load.weightUnit || null,
    capturedAt: req.capturedAt != null ? req.capturedAt : null,
    marginSource: req.marginSource || null,
    rules,
  };
  // A load priced after its posted close already moved: the snapshot close is the one its rounds
  // are counted from. The engine persists this at first arm and ignores it on every later one.
  if (Number.isFinite(load.closesAt) && load.closesAt < meta.closesAt) meta.postedCloseAt = load.closesAt;
  if (req.roundPolicy) meta.roundPolicy = req.roundPolicy;
  if (req.preEmptiveFloorAtRankOne !== undefined) meta.preEmptiveFloorAtRankOne = req.preEmptiveFloorAtRankOne === true;
  // FAIL CLOSED ON A STORED ZERO (T6, 2026-09-09). A floor margin of 0 makes buildBandLadder's
  // operating floor exactly the cost, so the ladder walks down to a bid at the desk's own buying
  // price. The /price page refuses one at entry, but a row captured before that gate existed never
  // renders the page again.
  //
  // The DECISION is pricing.js's floorMarginSubstitution, shared with _planFor, and that is the
  // repair rather than a tidy-up: this block used to hold the only copy of the rule while claiming
  // to cover "a durable intent replayed after a restart, and the scheduled wake" - the two paths
  // that reach engine.arm() through _intentToArm and never enter this function at all. What stays
  // here is what only this seam can do: correct and heal the stored RECORD.
  const floorSub = floorMarginSubstitution({ marginsPct: req.price.marginsPct,
    minMarginPct: req.price.minMarginPct, houseDefaultPct: appConfig.minMarginPct });
  let minMarginPct = req.price.minMarginPct;
  if (floorSub) {
    const storedFloorPct = floorSub.stored;
    const houseDefault = floorSub.substituted;
    minMarginPct = houseDefault;
    // CORRECT THE RECORD, not just this call's inputs. Every surface that reads the request rather
    // than the armed ladder would otherwise report a margin the engine did not use: notifier's
    // receipt takes floorPct off price.minMarginPct while floorBid comes from the ladder, so it
    // would state "never below 0%" beside a floor of cost x (1 + house/100). Both fields move
    // because they have different readers - the receipt reads price.minMarginPct, the exports read
    // the top-level one.
    //
    // In place FIRST and synchronously, because the caller sends that receipt off this same object
    // on the next line and cannot wait on a write. The store patch behind it is what stops the zero
    // coming back on the next restart; it is best-effort by design - a failed heal must never turn
    // a successful arm into a failed one, and the in-memory correction has already made the load safe.
    req.price.minMarginPct = houseDefault;
    req.minMarginPct = houseDefault;
    const requests = opts && opts.requests;
    if (requests && typeof requests.healZeroFloorMargin === 'function') {
      requests.healZeroFloorMargin(req.id, houseDefault)
        .catch((e) => log.warn('floor-margin heal write failed; the arm is unaffected but the stored record still reads 0', {
          auctionId: req.loadId, err: e && e.message }));
    }
    log.warn('stored floor margin was not above 0: arming on the house default instead of bidding at cost', {
      auctionId: req.loadId, stored: storedFloorPct, substituted: houseDefault, cost: req.price.cost });
    if (engine && typeof engine.emit === 'function') {
      engine.emit({ type: 'alert', level: 'error', kind: 'zero_floor_margin_substituted',
        auctionId: req.loadId, lane: load.lane, companyName: load.companyName, branchName: load.branchName || null,
        detail: `stored floor margin ${storedFloorPct}% would bid this load at cost (Rs ${req.price.cost}); armed on the house ${houseDefault}% instead - correct this customer's margin`,
      });
    }
  }
  const inputs = { cost: req.price.cost, marginsPct: req.price.marginsPct, minMarginPct };
  if (!hasOpened(load)) return engine.schedule(meta, inputs);
  const monitor = engine.arm(meta, inputs);
  // Re-arm safety: arm() creates a fresh monitor with an EMPTY firedRungs, but the durable intent
  // may already record rungs that spent real money (a re-armed, previously-stopped load). Restore
  // them into the monitor so it resumes where it left off and never re-fires a paid rung. A
  // first-time arm has an empty intent firedRungs, so this is a no-op there.
  const it = engine.scheduler && engine.scheduler.get ? engine.scheduler.get(req.loadId) : null;
  if (monitor && monitor.firedRungs && typeof monitor.firedRungs.add === 'function'
      && it && Array.isArray(it.firedRungs) && it.firedRungs.length) {
    for (const r of it.firedRungs) monitor.firedRungs.add(r);
    monitor.currentRungIndex = Math.max(monitor.currentRungIndex, ...it.firedRungs);
  }
  return monitor;
}

module.exports = { PriceRequestStore, armFromRequest, assertBiddingEnabled, assertLadderReachable, normalizeBidVehicleCount, normalizeCostByType, COLLECTION, publicSeg, tokenFromPath, linkSlug, isPlaceholderClose, assertRealClose, effectiveCloseAt, MAX_PLAUSIBLE_DEADLINE_MS, PRUNE_RETENTION_MS, platformOf, ownedBy, TARGET_PRICE_KIND, isTargetPriceReq, ARCHIVE_STREAM, archiveRow };
