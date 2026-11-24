'use strict';

const { ALERT_KINDS } = require('../admin/configStore');
const { renderMessage, templateFor, closeRuleOf, fmtDMY, fmtCloseWithCutoff, reminderRemainingPhrase, fmtClock, fmtNum, fmtVehicle, fmtWeight, vehicleWeightCell, dropAddress, pickupAddress, laneEnds } = require('./waTemplates');
const { publicSeg, platformOf, isTargetPriceReq } = require('../pricing/priceRequests');
const { isMultiVehicle, isPmtBasis } = require('../discovery/discovery');
const { pmtVehicleCountFor, pmtTotalUnitsFor } = require('../model/loadRules');
const { logAt } = require('../logging/logger');
const { redactToken } = require('../util/redactToken');
const { COLLECTION: ACCOUNT_CONTACTS_COLLECTION } = require('../auth/accountContacts');
const { isGroupJid } = require('../model/normalizePhone');
// Ask-thread seam: the group edit/reply noise-reduction lifecycle (persist the ask's messageId per
// load, decide edit-vs-reply by the ~15-min window). Group channel only - see _deliverGroup.
const { recordAsk, recordBubble, appendBubbleBid, markBubbleFinal, getAskFor, closeAsk, withinEditWindow } = require('./askThread');
const { branchMatches, applyBranchPrecedence } = require('./branchRouting');

/**
 * The MT-only gate for the desk-facing "per tonne" copy (pmtNoteLine, cargo/cargoQty's split
 * rewrite, and the submittedRate suffix below). isPmtBasis alone also matches a KG-quoted per-tonne
 * load (Tata Consumer, Ashirvad - loadRules.js:370-377, refused by the engine's own MT-only gate),
 * where "per MT" would misstate the unit by 1000x. Mirrors the price page's own MT-vs-KG fallback
 * rule (server.js pmtUnitWord: `weightUnit === 'KG' ? ... : metric tonnes`) so the two surfaces
 * cannot disagree about which loads get per-tonne treatment.
 */
function pmtMtBasis(L) {
  return isPmtBasis(L) && L.weightUnit !== 'KG';
}

/**
 * The ask's `cargo` and the receipt's `cargoQty` for an MT per-tonne load - ONE function so the two
 * messages cannot disagree about a split load (review r1, Finding 1) or an unknown-count load
 * (release-2026-09-28 sweep, Finding 5). `trucks` is the load's own pmtVehicleCountFor
 * (loadRules.js) - the SAME call the price page's pmtCommitmentText uses, so the two surfaces can
 * never derive a different truck count for the same load.
 *
 *   trucks === 1     the load's weight already *is* the load quantity - the original owner-approved
 *                     single-truck copy, unchanged.
 *   trucks > 1        a genuine split: states BOTH the per-truck figure and the whole-load total
 *                     (units - the "PMT lie", loadRules.js derivePmtQuantity), so the desk sees the
 *                     full commitment, not just one truck's share of it.
 *   trucks === null   the count is genuinely UNKNOWN (derivePmtVehicleCount: a non-integral
 *                     vehicleCount/weight ratio). This used to fall through to the trucks===1
 *                     rendering and state only the per-truck L.weight - silently UNDERSTATING the
 *                     load, while the price page's pmtCommitmentText(trucks=null) states the full
 *                     L.units. States the SAME whole-load total here (pmtTotalUnitsFor - the exact
 *                     rounding the price page's own totalUnits uses), with no truck count and no
 *                     "each": we do not know how many trucks it is, so we never invent one.
 */
function pmtCargoCell(L, trucks) {
  if (Number.isInteger(trucks) && trucks > 1) {
    const each = fmtWeight(L.weight, L.weightUnit);
    const total = fmtWeight(pmtTotalUnitsFor(L), L.weightUnit);
    return `${fmtVehicle(L.equipment, trucks)}${each ? ` . ${each} each${total ? ` (${total})` : ''}` : ''}`;
  }
  if (trucks === 1) {
    return vehicleWeightCell({ cargo: fmtVehicle(L.equipment, null), weight: L.weight, weightUnit: L.weightUnit });
  }
  return vehicleWeightCell({ cargo: fmtVehicle(L.equipment, null), weight: pmtTotalUnitsFor(L), weightUnit: L.weightUnit });
}

/**
 * Notifier seam - how the pricing team is told something happened.
 *
 * Default 'dashboard': the request/outcome already lives in the store, so the console
 * worklist (/api/price-requests) + History surface it; we just emit a line to the log.
 *
 * 'whatsapp' ALSO renders the matching message and sends it (via Maytapi) to every
 * recipient subscribed to that alert kind - the same three-event behaviour BRL's
 * GoComet bot has (rate-needed / won / lost), extended to the six kinds we already
 * model in config (adds bid-live / outbid / error). Channel swap is config, not a
 * rewrite - that is the point of the seam.
 *
 * THE CHANNEL IS RESOLVED PER RECORD, NOT GLOBALLY (notifyModeFor). One portal can surface
 * everywhere inside the product and send nothing while another keeps messaging - which is the whole
 * requirement for GoComet, and impossible while `mode` was a single scalar: turning it down to
 * silence GoComet also silenced SuperProcure, which is live and earning.
 *
 * Dedupe rides the store seam (restart-safe), keyed {id}_{kind}, and is bounded so the
 * collection can't grow without limit (GoComet caps its sent-set; we do too).
 */

const DEDUPE_COLLECTION = 'notifSent';
const DEDUPE_CAP = 1000;

// A recipient's scope decides which loads their alerts cover. Empty origins+shippers+branches = all
// loads. Otherwise the load's plant/origin (and/or shipper) must match - same case-insensitive
// substring match the bidding allowlist uses. Every dimension set = must match all of them.
//
// `branches` is the optional branch filter (a group narrowed to ONE branch of a shipper, e.g.
// Havells' Alwar branch). It is kept RAW here - branchMatches normalizes both sides (SP's "(1350)"
// id is the key), a stricter identity test than the origin/shipper substring match, so it never
// over-matches a different same-town branch. Empty branches = no branch constraint, so a group
// without one matches exactly as it did before this dimension existed (backward-compatible).
function scopeMatches(scope, data) {
  // ACCOUNT-WIDE facts (a login's session expiring or disconnecting - tokenExpiry.js, authAlert.js)
  // are judged on the SHIPPER dimension alone, and FAIL CLOSED on an empty one. Both halves are
  // load-bearing and neither is what the general rule below does:
  //   - There is no origin and no branch on an account fact, and the general rule ANDs every
  //     dimension a recipient sets - so a branch- or origin-narrowed group would be structurally
  //     unmatchable even when its shipper name is a byte-perfect match. Ignoring those two
  //     dimensions is what lets a customer's branch group hear that bidding stopped for them.
  //   - The general rule reads an EMPTY scope as "every load", which on an account fact is one
  //     customer's outage fanned out to every unscoped recipient and every alertAll group. A
  //     customer channel has to be NAMED to be written to.
  if (data && data.accountWide) {
    const named = ((scope && scope.shippers) || []).map((s) => String(s).toLowerCase()).filter(Boolean);
    const shipper = String(data.shipper || '').toLowerCase();
    if (!named.length || !shipper) return false;
    return named.some((s) => shipper.includes(s));
  }
  if (!scope) return true;
  const origins = (scope.origins || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const shippers = (scope.shippers || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const branches = (scope.branches || []).filter(Boolean);
  if (!origins.length && !shippers.length && !branches.length) return true;
  const origin = String(data.origin || '').toLowerCase();
  const shipper = String(data.shipper || '').toLowerCase();
  const originOk = !origins.length || origins.some((o) => origin.includes(o));
  const shipperOk = !shippers.length || shippers.some((s) => shipper.includes(s));
  const branchOk = !branches.length || branches.some((b) => branchMatches(b, data.branch));
  return originOk && shipperOk && branchOk;
}

// Everyone subscribed to `kind` whose scope covers this load. The FIRST half of routing; per-kind
// narrowing (outbid/bid_live/the paired-error dedupe) is applied by the caller on top of this.
function matchRecipients(recipients, kind, data) {
  return (recipients || []).filter((r) =>
    r && r.phone && Array.isArray(r.alerts) && r.alerts.includes(kind) && scopeMatches(r.scope, data));
}

// The SECOND half of routing: split a matched set into the group channel and the individual DMs.
// A scoped group (non-empty shipper scope) is its customer's sole channel; applyBranchPrecedence
// then drops a general group superseded by a branch group for this load. `others` is keyed off
// scopedGroups, not channelGroups, so a superseded general group is excluded from the DM path too.
// Extracted so the delivery prediction below resolves through EXACTLY this code, not a copy of it.
function splitChannels(matched) {
  const scopedGroups = matched.filter((r) => isGroupJid(r.phone) && r.scope && (r.scope.shippers || []).length > 0);
  const channelGroups = applyBranchPrecedence(scopedGroups);
  const others = matched.filter((r) => !scopedGroups.includes(r));
  return { scopedGroups, channelGroups, others };
}

/**
 * Who the PAIRED OUTCOME message will actually be delivered to - the set whose error copy is
 * therefore redundant. `paired` is {kind, data} off the error payload (engineAlerts
 * PAIRED_WITH_OUTCOME): the outcome's routing kind plus a mirror of its scope keys.
 *
 * Resolved through the same matchRecipients + splitChannels the real send runs, because the failure
 * this replaces came from INFERRING delivery from subscription. Two mechanisms defeat that
 * inference: an error payload carries no shipper, so no shipper-scoped group ever matches the alarm,
 * while the outcome does carry one - and once any scoped group takes the outcome, the individual DMs
 * are deliberately never delivered. An unscoped all-alerts ops recipient was thus filtered out of
 * the alarm AND suppressed out of the outcome, and received nothing at all.
 *
 * Predicts the group send SUCCEEDS, which is the safe direction: if it fails, the outcome falls back
 * to the DMs and a suppressed recipient gets the outcome instead of the alarm - still one message,
 * never zero. The reverse assumption would hand the DM list both.
 */
function pairedOutcomeDelivery(recipients, paired) {
  // A truthy-but-shapeless marker (a legacy boolean payload, a hand-rolled alert() call) suppresses
  // NOBODY. Fail open: an extra alarm is noise, a missing one is the outage this alert exists for.
  if (!paired || !paired.kind) return new Set();
  const matched = matchRecipients(recipients, paired.kind, paired.data || {});
  const { channelGroups, others } = splitChannels(matched);
  return new Set(channelGroups.length > 0 ? channelGroups : others);
}

// SENDER-HEALTH POLICY, per message CLASS. This is the ONE place the accept-and-queue hazard is
// turned into a per-class decision, so EVERY send path applies the same rule instead of each one
// remembering to add a breaker. The hazard (confirmed live 2026-07-15 and again 2026-07-24/25):
// when the Maytapi sender session is logged out, a POST is ACCEPTED and QUEUED (Maytapi answers
// ok:true), then the whole stale backlog floods the moment the session re-links - so ok:true is not
// delivery. This map is consulted ONLY when the session is confirmed DOWN (a healthy or unreadable
// probe always SENDS - see _healthAction); its value is the disposition for a down sender:
//   - 'retryable' : skip now, let the caller re-fire while still relevant. Nothing rides this today
//                   (price_needed moved to 'failover'); kept because it is the correct disposition
//                   for any future kind that a loop genuinely re-fires while the load is open.
//   - 'failover'  : try to DELIVER THE SAME ASK by another route before giving up, and only degrade
//                   to the 'retryable' skip when every route has failed. price_needed only - see the
//                   long note on its entry below.
//   - 'drop'      : skip and discard - a message whose value has already passed or is carried
//                   elsewhere is worse re-delivered stale than not at all. The per-load outcome
//                   pings (price_submitted/bid_live/outbid) and the daily eod_report ride this;
//                   won/lost/error are also 'drop' here (they are the diagnosis's "guarded-skip":
//                   the WON is not silently forgotten - it is carried by the dashboard and the next
//                   evening's EOD "won X of Y" - it simply must not queue onto the dead sender).
//   - 'reroute'   : deliver the SAME body through the Maytapi-INDEPENDENT channel (Brevo email +
//                   a healthy sibling phone), NEVER onto the dead sender. The named-human DMs
//                   (heartbeat, director_eod) ride this - a message whose whole point is that a
//                   HUMAN hears from the bot today must reach that human by some live path, but it
//                   must never be the queued warning that floods a dead sender it was itself
//                   warning about.
// A kind with no entry defaults to 'drop' (fail-safe: never queue an unclassified message onto a
// down sender). That default is safe but SILENT, so it is backed by a coverage test rather than by
// hope: scripts/test-nobid-classification.js asserts every configStore.ALERT_KINDS member has an
// EXPLICIT entry here and fails if one is ever left out. (Before that test existed this comment
// claimed a guarantee the suite did not actually provide - the only assertions were three named
// kinds plus one that pinned the default, which an unclassified kind SATISFIES rather than trips.
// director_eod nearly shipped into that gap and was caught only by a hand-written cross-PR note.)
const HEALTH_POLICY = {
  // WAS 'retryable' until 2026-08-06. That classification cost 8 auctions in one outage: the sender
  // logged out at 07:04Z, and for the next ~2h every price ask was skipped here and re-fired by
  // discovery into the same dead sender roughly once per 30s tick until each load's deadline passed.
  // 8 asks expired undelivered, 10 more were still undelivered when the incident was reviewed. Each
  // one was built correctly, routed correctly, and never reached the wire.
  //
  // 'retryable' is only correct for a SHORT outage - it is a bet that the sender comes back inside
  // the load's pricing window. Over a two-hour QR re-link that bet loses every load, and it loses
  // them SILENTLY, because a skip is not a failure anyone is paged about.
  //
  // Why it was not 'reroute': the director_eod entry below argues a group broadcast cannot be
  // rerouted because "a sibling phone cannot post into a group it is not a member of". That premise
  // is TRUE and still is. The conclusion was wrong. A live read-only census (2026-08-06) shows the
  // second controlled number 136151 IS a participant of 16 of the 18 live "BRL Bids" groups - it is
  // added as the second controlled admin at group birth (group-directory.js). A sender that is
  // already in the group can post the ask. The policy had simply never asked.
  //
  // 'failover' is therefore its own disposition rather than a reuse of 'reroute', because the two do
  // genuinely different things. 'reroute' abandons the channel and delivers the body somewhere else
  // (email + a sibling DM) - correct for a DM to two named humans, wrong for a per-customer ask whose
  // whole value is that the desk that prices that customer sees it in that customer's thread.
  // 'failover' PRESERVES the channel wherever it still can: same group, same thread, a different
  // sender. Only when no controlled sender can reach that specific group does it step down to the
  // desk owner's DM, and only then to email. See _failoverDeliver for the chain and its ordering.
  price_needed: 'failover',
  price_submitted: 'drop',
  bid_live: 'drop',
  outbid: 'drop',
  won: 'drop',
  lost: 'drop',
  error: 'drop',
  // Classified HERE, in the same change that mints the kind, because this map's fail-safe default
  // for an UNLISTED kind is 'drop' and a new kind that quietly takes the default is how a feature
  // goes silent without anyone noticing (director_eod nearly shipped that way - see its entry
  // below). 'drop' happens to be the right answer for this one and is chosen, not inherited: it is
  // a one-shot per-load notice with nothing that re-fires it, exactly like its won/lost/error
  // siblings, and re-delivering it hours later on reconnect would announce a refusal on a load that
  // has long since closed. The fact is not lost when it drops - the refusal still logs, and the
  // load's own no-bid receipt at close states the same reason.
  desk_notice: 'drop',
  eod_report: 'drop',
  heartbeat: 'reroute',
  // Classified HERE, ahead of its sender (PR #96's runDirectorEod - the ~20:10 IST participation DM
  // to the two Directors). Deliberate, because the map's fail-safe default is 'drop' and for THIS
  // kind the default is the one wrong answer: a silent drop means that on the exact days the bot's
  // WhatsApp leg is broken - the days the Directors most need to know the desk's participation
  // number is unreliable - the DM they judge the system by simply never arrives, and nothing
  // anywhere says so. It is 'reroute', not 'drop', for three reasons that separate it from its
  // sibling eod_report:
  //   1. AUDIENCE. It is a DM to two named humans, like heartbeat - not the per-customer group
  //      broadcast eod_report is. Rerouting a DM to those same humans by email/sibling reaches the
  //      intended reader; there is no group-channel semantics to preserve.
  //   2. NO CATCH-UP. eod_report drops safely because its content is standing state - the dashboard
  //      holds it and the NEXT evening's report is a fresh, complete record. The director DM is a
  //      per-DAY cohort (requests created in that IST day); tomorrow's DM covers tomorrow's cohort,
  //      so a dropped day is a permanently missing day, not a deferred one.
  //   3. NOT RETRYABLE. 'retryable' is wrong for the same reason - it fires from a once-a-day cron
  //      slot, not from a discovery loop that re-notifies while the load is still open. Nothing
  //      re-fires it, so "skip now and let the caller retry" means "never".
  // The reroute body is the DM verbatim; it goes out over Brevo email + a healthy SIBLING phone and
  // never touches the down sender. If no channel is wired it degrades to the same fail-safe DROP as
  // heartbeat (see sendDirect) - still never queued onto the dead session.
  director_eod: 'reroute',
};

// remindApproaching's urgency banner (the DM/individual path - a scoped group's own reminder goes
// through the SEPARATE ask_reminder template/bubble in _deliverGroup, unaffected by this). Director
// ask, 2026-07-25: the same "how many minutes" clause the group thread got now rides here too - a
// customer with no scoped group must not read a less useful reminder than one with a group, or the
// gap becomes a support question later. ADDS the relative clause ahead of the existing message body,
// which still carries the ABSOLUTE enter-cost-by time via closesText (fmtCloseWithCutoff) - the
// relative clause is what a phone glance wants right now, the absolute time is what still reads
// correctly if the message is opened hours later. Reuses reminderClosingClause - the SAME formatter
// the group path uses - against the SAME request.deadlineAt (threaded onto data by
// _priceNeededData), so there is exactly one minutes-left implementation, not two.
//
// A FUNCTION, not a baked string: _whatsapp calls this at message-assembly time (right where the
// banner is actually prepended, just before dispatch), not back when remindApproaching built the
// payload - mirrors the group path's ask_reminder placeholders(), which also evaluates at send time.
// Falls back to the original bare "approaching!" banner when the deadline is unknown or already
// past, rather than appending a dangling half-sentence.
// `nowMs` defaults to Date.now() at call time (the production path via _whatsapp never passes it) -
// exposed as a param purely so tests can pin a deterministic instant, same as the formatter.
//
// Says "pricing cutoff in N minutes", never "closing in N minutes" - deadlineAt is the
// enter-cost-by cutoff, not the auction close, and a cost after it still counts best-effort (full
// reasoning on reminderClosingClause in waTemplates.js). Composes the shared
// reminderRemainingPhrase directly instead of re-wording the group's clause, so neither surface
// depends on the exact string the other renders.
function remindApproachingBanner(d, nowMs = Date.now()) {
  const phrase = reminderRemainingPhrase(d && d.deadlineAt, nowMs);
  if (!phrase) return '⏰ *REMINDER - pricing cutoff approaching!*\n\n';
  return `⏰ *REMINDER - pricing cutoff ${phrase}.*\n\n`;
}

// The valid channel names, as a set rather than a pair of string comparisons: the notify-gating
// gate asserts that no channel comparison lives outside the resolver, and a validation check is
// not a routing decision - it should not have to look like one.
const NOTIFY_MODES = new Set(['whatsapp', 'dashboard']);

class Notifier {
  constructor({ mode = 'dashboard', platformModes = null, targetRateMode = 'whatsapp', baseUrl = '', log = () => {}, wa = null, store = null, recipientsProvider = null, historyProvider = null, healthProvider = null, fallbackAlert = null, senderFleet = null, ownersProvider = null } = {}) {
    this.mode = mode;
    // Per-portal channel overrides, {platformKey: 'whatsapp'|'dashboard'}. Anything NOT listed here
    // resolves to `mode` - see notifyModeFor for why that is the money-safe direction. Mutable, so a
    // Settings save moves one portal live without a redeploy (server.js applyConfigValues).
    this.platformModes = Object.assign({}, platformModes);
    // A target-rate ask resolves its channel HERE rather than through platformModes, because it is
    // the one price ask whose whole purpose is to reach a phone inside minutes. See config.
    this.targetRateMode = targetRateMode;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.log = log;
    this.wa = wa;                               // WhatsAppClient | null
    this.store = store;                         // for dedupe; null disables persistence
    // Dedupe keys THIS PROCESS actually put on the wire, held independently of whether the
    // persistent mark survived. _markSent writes a file and can throw (a full disk), and a caller
    // running a delivery retry must never read a failed WRITE as proof the message never went out -
    // that turns one page into one per retry tick. Bounded like the store's own collection.
    this._sentThisProcess = new Set();
    this.recipientsProvider = recipientsProvider; // async () => [{ name, phone, alerts[] }]
    this.historyProvider = historyProvider;     // async (lane, {excludeLoadId, equipment}) => [{ amount, rank, at, equipment, units }] | null
    // circuit breaker: async () => boolean. null = always-healthy (unchanged behaviour). Production
    // wires this to wa.sessionHealthy() so a dead-session alert is skipped, not queued (see _whatsapp).
    this.healthProvider = healthProvider;
    // Out-of-band reroute channel for the heartbeat when the sender is down: async ({ subject, body,
    // to, name, kind }) => { ok }. Delivers the body through a Maytapi-INDEPENDENT path (Brevo email
    // + a healthy sibling phone - see src/notify/alertChannel.js), NEVER the dead sender. null = no
    // reroute wired, so a heartbeat that would reroute DROPS instead (fail-safe: it still never
    // queues onto the down sender, and the standalone sender-health monitor covers the sender-down
    // case independently). Only the 'reroute' policy consults it.
    this.fallbackAlert = fallbackAlert;
    // The ORDERED candidate senders for the price-ask failover (src/notify/senderFleet.js). null = no
    // fleet wired, which is the DEFAULT and reproduces the old behaviour exactly: with no sibling to
    // try, the failover chain finds no group sender, no owner DM is configured either on most boxes,
    // and price_needed degrades to the same skip-and-retry 'retryable' always gave. Consulted ONLY
    // after the primary has already probed DOWN, so a healthy system never touches it and makes
    // exactly the same number of WhatsApp operations it made before this existed.
    this.senderFleet = senderFleet;
    // async (companyName) => [{ personId, name, phone }] - the desk owners of that customer, i.e. the
    // humans to DM when NO controlled sender can reach the customer's group at all. Resolved through
    // model/resolve.js resolveOwners at the caller, so the notifier stays store-ignorant. null (or an
    // empty return) is a normal, expected answer: `owner` is a deliberately narrow designation and
    // plenty of customers have none. That case skips straight to email rather than guessing a human.
    this.ownersProvider = ownersProvider;
    // In-flight dedupe reservation (see _whatsapp). The persistent notifSent mark only lands AFTER the
    // whole Maytapi send loop (0.7-2.1s), so two events sharing a dedupeKey that fire within that window
    // - e.g. two descending-ladder bid rungs ~1s apart, both emitting the one-per-auction bid_live alert
    // - can both pass _alreadySent before either marks, and both send (the live duplicate/mislabel seen
    // on multi-rung snipes). This Map closes that check->mark window synchronously: a dedupeKey is
    // reserved in the same tick it passes _alreadySent, before the first await of the send path, and
    // released in a finally so a failed or health-skipped send never leaves a lasting block (only a
    // SUCCESSFUL send does, via _markSent). In-memory + per-process, which is all this needs: the app
    // is a single PM2 process, and cross-restart re-fires are already guarded by the persistent mark.
    //
    // Maps key -> a promise resolving to whether the holder's own attempt actually DELIVERED (W1-8
    // F3). A plain Set (the value the reservation used to be) tells a waiter only that a send is
    // running, not what it did - so a waiter that simply returned true once the key was reserved
    // could report "handled" for an event whose holder went on to fail every recipient's send. The
    // waiter has to know the outcome, not just the fact that someone got there first.
    this._inFlight = new Map();
  }

  // `log` arrives via constructor injection - most call sites in this codebase (see
  // logging/logger.js's own header comment) still pass the plain ad hoc `log(msg)` callback
  // rather than a full createLogger instance with .debug/.info/.warn/.error, so route
  // level-specific calls through whichever shape was actually injected instead of assuming a
  // method that might not exist. Shared with DiscoveryPoller/WhatsAppClient via logging/
  // logger.js's exported logAt() so the DI-fallback logic lives in exactly one place.
  _emit(level, msg, meta) {
    logAt(this.log, level, msg, meta);
  }

  /**
   * THE CHANNEL FOR ONE RECORD. Every send decision in this class resolves through here, so
   * "does this message go out on WhatsApp" has exactly one definition and it is answered per
   * portal, never by a global.
   *
   * AN UNRECOGNISED PORTAL RESOLVES TO SUPERPROCURE, and that direction is deliberate on two
   * grounds. It is the money-safe one: a missed SuperProcure price ask is a missed live auction,
   * while a stray GoComet message is only noise. And it is the SAME convention platformOf (in
   * priceRequests) already establishes for an absent platformKey - every record written before
   * GoComet existed is definitionally a SuperProcure record. A third behaviour (silence-by-default for
   * anything unknown) would make a typo'd key, a renamed portal, or a caller that simply forgot to
   * thread the platform go dark on the live-money path with no error anywhere.
   *
   * hasOwnProperty, not truthiness: only an EXPLICIT per-portal entry overrides.
   */
  /**
   * The channel for ONE price-request record. A target rate resolves through targetRateMode rather
   * than the portal's mode - see config. Every caller that needs to NAME the channel uses this, so
   * a log line can never claim a different one from the send path (they diverge by default: the
   * portal is 'dashboard' and the target rate is 'whatsapp').
   */
  channelFor(request) {
    return isTargetPriceReq(request) ? this.targetRateMode : this.notifyModeFor(platformOf(request));
  }

  /**
   * Turn the target-rate channel down at RUNTIME. Without this the mode is write-once at boot, so
   * neither the console's GoComet channel control nor the global notify kill can stop it, and an
   * operator watching a storm has no lever short of a restart. This project has had one 214-message
   * WhatsApp storm reach the client already; a channel with no off switch is not shippable.
   */
  setTargetRateMode(mode) {
    if (!NOTIFY_MODES.has(mode)) {
      const e = new Error(`setTargetRateMode: unknown mode ${mode}`); e.code = 'BAD_INPUT'; throw e;
    }
    this.targetRateMode = mode;
    return this.targetRateMode;
  }

  notifyModeFor(platformKey) {
    if (platformKey && Object.prototype.hasOwnProperty.call(this.platformModes, platformKey)) {
      return this.platformModes[platformKey];
    }
    return this.mode;
  }

  // Readable capture link: /price/<shipper>-<closeDate>-<token>. The token still carries the
  // auth; publicSeg() just prepends a cosmetic slug (falls back to the bare token if the load
  // has nothing slug-able).
  link(request) { return `${this.baseUrl}/price/${publicSeg(request)}`; }

  /**
   * The single sender-health decision point (see the HEALTH_POLICY map above). Both send paths -
   * the per-load alert path (_whatsapp) and the scheduled direct path (sendDirect) - route through
   * here so the accept-and-queue hazard is judged in exactly one place, per message CLASS.
   *
   * Returns 'send' when there is no breaker wired OR the sender session probes healthy OR the probe
   * cannot be read. That last case is the load-bearing FAIL-OPEN: a listPhones glitch, an HTTP 500,
   * or a throwing provider must NEVER cause a total send blackout (which is worse than the queued
   * flood the breaker guards) - so an unreadable/erroring probe is treated as healthy and SENDS,
   * exactly as WhatsAppClient.sessionHealthy() itself fails open on an unreadable listPhones. Only a
   * DEFINITIVE "session down" returns a non-send disposition, taken from HEALTH_POLICY.
   */
  async _healthAction(kind) {
    if (!this.healthProvider) return 'send';               // no breaker wired -> unchanged (always send)
    let healthy = true;                                    // fail-OPEN default (see the doc above)
    try { healthy = await this.healthProvider(); } catch (_) { healthy = true; }
    // STRICT === false, not a truthiness test. Only a DEFINITIVE "session down" blocks; anything a
    // provider returns that is NOT the boolean false (undefined, null, 0, '') is an unreadable probe
    // and must fail OPEN, exactly like a throwing one two lines up. The wired provider
    // (wa.sessionHealthy) always answers a real boolean, so this changes nothing today - it hardens
    // against a FUTURE provider that forgets a return and would otherwise silently fail CLOSED,
    // turning a coding slip into the total scheduled-send blackout this doc says must never happen.
    if (healthy !== false) return 'send';
    return HEALTH_POLICY[kind] || 'drop';                  // down: unclassified kinds fail SAFE (drop, never queue)
  }

  /**
   * The 'price_needed' template's data, shared by the original ask (requestPrice) and the
   * approaching-deadline nudge (remindApproaching) - both are the same underlying "please price
   * this load" message, just at a different moment and with a different dedupe key/urgency.
   */
  async _priceNeededData(request) {
    const L = request.load || {};
    const link = this.link(request);
    const platformKey = platformOf(request);
    // The lane's two ends, each already written the way the /price page and the console write it -
    // see waTemplates.laneEnds. The portal has to be passed because it decides whether a stored
    // record needs the serve-time GoComet parse; without it a pre-parser record renders a postal
    // address where a city belongs.
    const lane = laneEnds(L, platformKey);
    // BRL "New enquiry" fields.
    const data = {
      // Which portal owns this record - the key the send gate resolves the channel from. Read
      // through platformOf so an untagged legacy request reads as SuperProcure, exactly as
      // everywhere else. DISPLAY-INERT: no template renders it.
      platformKey,
      loadId: request.loadId,
      name: request.loadId,               // fallback inside loadNumberCell()'s *Load #* line only -
                                           // *Name* itself renders d.shipper (the company), not this
      // the enter-cost-by cutoff (raw timestamp, not yet formatted) - carried through so the
      // ask_reminder template's "closing in N minutes" clause (reminderClosingClause) can compute
      // the remaining time itself at render/send time, rather than off a value baked in here.
      deadlineAt: request.deadlineAt || null,
      loadCode: L.loadCode != null ? L.loadCode : '',   // SP's own friendly code, appended alongside Load #
      // The shipper's OWN reference for this enquiry (GoComet's enquiry.name), snapshotted onto the
      // request at createForLoad. The desk works by this number, not by the portal's key - the
      // client settled that himself against his own portal notification - and until now it reached
      // the /price page and nothing else, so the ask that arrives FIRST named only the portal key.
      // Passed through untouched; oaLine() decides whether the line renders at all.
      shipperRef: L.shipperRef || '',
      shipper: L.companyName || '', link,
      // DISPLAY-ONLY name: the matched customer's clean label when the request carries the
      // model tag (request.customer, snapshotted at createForLoad), else the raw companyName.
      // `shipper` above must stay the RAW platform string - scopeMatches routes on it, and the
      // recipients' scope tokens (customer aliases) are matched against that raw string, never
      // against the label. Conflating the two would silently re-route alerts on a rename.
      shipperName: (request.customer && request.customer.label) || L.companyName || '',
      // SP's consignor branch label ("REN-K"), rendered in the *Name* line as "<shipper>
      // (<branch>)" so the desk sees WHICH branch of a multi-branch shipper before opening the
      // link. DISPLAY-ONLY - `shipper` above stays the sole scope-routing key. Blank when absent.
      branch: L.branchName || '',
      origin: (L.lane && L.lane.origin) || '',   // scope-routing key - stays the single collapsed
                                                  // point; only the DISPLAYED From below needs
                                                  // every pickup point a multi-pickup load has.
      from: pickupAddress(L),
      to: dropAddress(L),
      // One city + PIN per line, under its own *From* / *To* label. The FULL pickup/drop addresses
      // (from/to above) stay on the load snapshot and render on the /price page; the ask carries
      // the short pair plus the two pins that say WHICH city, since the name alone repeats across
      // India (Director, 2026-07-27).
      laneFrom: lane.from,
      laneTo: lane.to,
      // The WhatsApp ask is the FIRST thing the pricing desk sees. Two facts ride the existing
      // *Bid Close Time* slot (template body untouched):
      //  - the entry cutoff: the close time alone let the desk work a link against 2:45 for a
      //    load whose cost had to be in by 2:43:30 - fmtCloseWithCutoff spells it out.
      //  - a scheduled-but-not-yet-open window (SP UI: "Auction starts at ..."): the start time
      //    is appended so the desk knows bidding hasn't begun and doesn't misread the close
      //    countdown as a live auction.
      closesText: L.startsAt && L.startsAt > Date.now()
        ? `${fmtCloseWithCutoff(L.closesAt, request.deadlineAt)} (bidding opens ${fmtDMY(L.startsAt)})`
        : fmtCloseWithCutoff(L.closesAt, request.deadlineAt),
      // On an MT per-tonne load `units` is the load's TOTAL quantity (the "PMT lie"), not a truck
      // count, so passing it straight to fmtVehicle rendered it as a truck count ("30 x Any Vehicle"
      // on a 30 MT load). pmtCargoCell states the per-truck weight (single truck) or BOTH the
      // per-truck figure and the real total (a split load, review r1 Finding 1) - never bare
      // fmtVehicle(units). A KG per-tonne load (pmtMtBasis false, Finding 3) falls through to the
      // ORIGINAL non-PMT rendering unchanged - "per tonne" copy is MT-only.
      cargo: pmtMtBasis(L) ? pmtCargoCell(L, pmtVehicleCountFor(L, true)) : fmtVehicle(L.equipment, L.units),
      // Gates pmtNoteLine (waTemplates.js): the one line telling the desk the rate they enter next
      // is per MT, not the whole-load figure that was landing there (Vishal Pipes, 2026-09-28).
      pmtBasis: pmtMtBasis(L),
      closeRule: closeRuleOf(request, platformOf(request)),
      // BC-35: the truck's own size ("32'x8'x8'8\""), GoComet's punctuation verbatim - only ever
      // set on a single-cargo-type load (gocometCargo.readLoadSpec), so it needs no gating here
      // against the multi-type branch below.
      dimensions: L.dimensions || '',
      // EVERY TRUCK TYPE, each with its own count, so the ask can give each one its own line.
      // Absent/one type -> the ask renders byte-identically to today off `cargo` above.
      cargoTypes: Array.isArray(L.cargoTypes) && L.cargoTypes.length > 1 ? L.cargoTypes : null,
      // BC-36: extra pickup/drop points beyond the primary lane - see laneDisplay.twoPointFacts,
      // which is what actually reads these two plus shipperRef above.
      otherOrigins: Array.isArray(L.otherOrigins) ? L.otherOrigins : null,
      otherDestinations: Array.isArray(L.otherDestinations) ? L.otherDestinations : null,
      // A transit-REQUIRED load (its own loadIsTransitTimeOn rule flag, snapshotted at intake)
      // renders an instruction line: the rate must come with transit days or SuperProcure rejects
      // the bid. SP still exposes no transit-time VALUE to show - the days come from the pricing
      // person, on the capture page this message links to.
      needsTransitTime: !!(L.rules && L.rules.loadIsTransitTimeOn),
      // the shipper's EXTRA NOTE (SP load note) - the pricing person must see it before quoting.
      extraNote: L.notes || '',
      // quote-critical facts already captured on the load snapshot (createForLoad) but
      // previously dropped here before ever reaching the template - see waTemplates.js
      // loadDetails()/portalNote() for how each renders.
      // On an MT per-tonne load, `cargo` above (pmtCargoCell) already has the weight text baked in
      // (single truck: "Any Vehicle . 30 MT"; split: "... . 30 MT each (60 MT)") - the price_needed
      // template's vehicleWeightCell(d) would otherwise append fmtWeight(d.weight, ...) a SECOND
      // time onto the same line. loadDetails() (the only other reader of these two fields) is not
      // wired into any MESSAGES template, so nulling them here is safe.
      weight: pmtMtBasis(L) ? null : (L.weight != null ? L.weight : null),
      weightUnit: pmtMtBasis(L) ? null : (L.weightUnit || null),
      distanceKm: L.distanceKm != null ? L.distanceKm : null,
      shipmentType: L.shipmentType || '',
      productName: L.productName || '',
      hasPortalComments: !!L.hasPortalComments,
      hasPortalAttachments: !!L.hasPortalAttachments,
    };
    // recent quotes on the same route (our own bid log), when a provider is wired. Best-effort:
    // a missing/failing lookup just drops the block, never blocks the price ask.
    if (this.historyProvider && L.lane) {
      try {
        // Pass the load's own equipment so the lookup hard-matches vehicle type, not just the
        // city pair - a 20ft-container rate must never surface as a reference on a 32ft load
        // (Director flagged exactly that, 2026-07-16). An unknown equipment yields no history.
        // Scoped to THIS load's own platform (C071) - a GoComet quote surfacing as "our previous
        // quote" on an SP ask (or vice versa) mis-anchors the desk on a different price basis and
        // revision budget, the same class of risk the equipment hard-match above already guards.
        const rh = await this.historyProvider(L.lane, { excludeLoadId: request.loadId, equipment: L.equipment, platformKey: platformOf(request) });
        if (Array.isArray(rh) && rh.length) data.quotes = rh;
      } catch (e) { this.log(`[notify] route-history lookup failed for ${request.loadId}: ${e && e.message}`); }
    }
    // A shipper TARGET RATE ask - the customer reopened a load we already quoted and named their
    // price. Only these three fields differ from a normal ask, and `targetRate` is what makes
    // templateFor select the target-rate copy; a request without them renders exactly as before.
    if (isTargetPriceReq(request)) {
      data.targetRate = true;
      data.notifyModeOverride = this.targetRateMode;
      data.targetPrice = request.targetPricePerUnit != null ? request.targetPricePerUnit : null;
      data.standingPrice = request.standingPricePerUnit != null ? request.standingPricePerUnit : null;
      data.chargeLineCount = request.chargeLineCount != null ? request.chargeLineCount : 1;
    }
    // requests are account-tagged only when >1 SP account runs - single-account
    // messages stay identical (no label noise).
    if (request.account && request.account.label) {
      data.accountId = request.account.accountId;
      data.accountLabel = request.account.label;
    }
    return data;
  }

  async requestPrice(request, { force = false } = {}) {
    const L = request.load || {};
    const lane = L.lane ? `${L.lane.origin}->${L.lane.destination}` : '?';
    const link = this.link(request);
    // The RESOLVED channel for this record, not the global one - an operator reading pm2 logs must
    // be able to see at a glance that a GoComet ask went to the dashboard only.
    const channel = this.channelFor(request);
    // Capture link carries the price-request token (the sole auth for that public page) -
    // redact it before logging; the full link still reaches WhatsApp/dashboard delivery.
    this.log(`[notify:${channel}] price needed for load ${request.loadId} (${lane})${force ? ' [re-alert]' : ''}. Capture: ${redactToken(publicSeg(request))}`);
    // force (operator "Alert again") uses a unique dedupe key so the repeat isn't swallowed.
    const dedupeKey = force ? `${request.id}_price_needed_${Date.now()}` : `${request.id}_price_needed`;
    const data = await this._priceNeededData(request);
    // delivered === false ONLY when the WhatsApp push was skipped for a down session (retryable);
    // the caller re-fires while the load is still open. true in every other case (incl. dashboard mode).
    const delivered = await this._whatsapp('price_needed', dedupeKey, data);
    return { channel, link, delivered };
  }

  /**
   * A follow-up nudge as a load's pricing deadline approaches, still unpriced (see
   * priceRequests.dueForReminder). Reuses the exact 'price_needed' template + recipient
   * subscriptions (no new ALERT_KINDS entry, no separate opt-in needed - anyone already
   * subscribed to price asks gets the reminder automatically), with a plain-text urgency
   * banner prepended so it reads as a distinct nudge, not a duplicate of the original ask.
   * Own dedupe key (fires once, independent of the original 'price_needed' send).
   */
  async remindApproaching(request) {
    const L = request.load || {};
    const lane = L.lane ? `${L.lane.origin}->${L.lane.destination}` : '?';
    const channel = this.channelFor(request);
    this.log(`[notify:${channel}] pricing deadline approaching for load ${request.loadId} (${lane}). Capture: ${redactToken(publicSeg(request))}`);
    const dedupeKey = `${request.id}_price_reminder`;
    const data = await this._priceNeededData(request);
    const delivered = await this._whatsapp('price_needed', dedupeKey, data, {
      bannerPrefix: remindApproachingBanner,
    });
    return { channel, link: data.link, delivered };
  }

  /**
   * Confirm to the pricing team that their submitted cost landed and the bot is armed
   * (the "Market Rate Submitted" receipt), with a footer link to change a mistaken rate.
   * Fired from the /price POST on BOTH the first capture AND a re-price ({reprice:true}), so a
   * corrected rate is acknowledged too (BRL's ask, 2026-07-16) - the original wired it to the
   * first capture only, and a re-price went out silent. Each re-price gets its OWN receipt
   * (unique dedupe key); a first-capture retry stays de-duplicated. Best-effort - never fails the
   * capture. `ladder` (the armed rung array, opening price first, operating floor last) drives the
   * "We'll bid from ... never below ..." bidding-contract line on the receipt when the band is known.
   */
  async confirmSubmitted(request, ladder = null, { reprice = false } = {}) {
    const L = request.load || {};
    const origin = (L.lane && L.lane.origin) || '';   // scope-routing key - single collapsed point
    const pickup = pickupAddress(L);                  // DISPLAYED route - every pickup point
    const drop = dropAddress(L);
    const cost = request.price ? request.price.cost : null;
    // Where the desk priced each truck type, the RECEIPT SHOWS WHAT THEY TYPED. `cost` here is the
    // truck-weighted mean the ladder is built from, and printing it as "Your Rate" put a number
    // nobody entered - below every number they did - on the one message the desk checks their own
    // entry against (260907C2I8, 2026-09-08: entered 45,000 and 28,000, receipt read 39,333).
    // `match` is deliberately not carried: it is the adapter's freight-line join key and has no
    // business in a message payload or its log line.
    const byType = request.price && request.price.costByType
      && Array.isArray(request.price.costByType.types) && request.price.costByType.types.length > 1
      ? request.price.costByType.types : null;
    // BRL "Market Rate Submitted" fields. GID is dropped (SP does not expose it); the per-vehicle
    // freight breakdown BRL shows collapses to our single entered cost.
    const data = {
      platformKey: platformOf(request),      // the send gate's key (see _priceNeededData)
      loadId: request.loadId, oaNo: request.loadId,
      shipper: L.companyName || '', origin,   // scope-routing keys
      // routing key for a branch-scoped group (the Alwar split): the RAW SP branch label off the load
      // snapshot, the same source price_needed reads. Keeps the submit receipt in the SAME group the
      // price ask went to. Blank when the load carries no branch (then no branch group can match it).
      branch: L.branchName || '',
      closingTime: fmtDMY(L.closesAt),
      closeRule: closeRuleOf(request, platformOf(request)),
      route: pickup && drop ? `${pickup} -> ${drop}` : (pickup || drop || '-'),
      // Same PMT carve-out and split-load statement as the ask's `cargo` above (pmtCargoCell) - the
      // ask and this receipt's *Vehicle Type* field must say the SAME thing for the same load, never
      // "30 x Any Vehicle" and never just the per-truck figure on a split load.
      cargoQty: pmtMtBasis(L) ? pmtCargoCell(L, pmtVehicleCountFor(L, true)) : fmtVehicle(L.equipment, L.units),
      // First capture -> when the cost was captured. A re-price -> now (the moment the corrected
      // rate was entered): capturedAt still holds the ORIGINAL entry, so reusing it would misdate
      // the receipt to the mistaken rate's time.
      enteredTime: fmtClock(reprice ? Date.now() : request.capturedAt),
      // "per MT" on an MT per-tonne load - this is the number the desk typed, and both the receipt's
      // *Your Rate* line and the group's "We have your rate" bubble (ask_resolved) read it off this
      // SAME field (submittedRateCell), so a bare rupee figure never states a whole-load amount
      // where a per-tonne rate was meant. A KG per-tonne load (pmtMtBasis false) keeps no suffix.
      submittedRate: cost != null ? `₹${fmtNum(cost)}${pmtMtBasis(L) ? ' per MT' : ''}` : '-',
      rateByType: byType ? byType.map((t) => ({ label: t.label, count: t.count, cost: t.cost })) : null,
      // The entered rate is PER VEHICLE (SP multiplies `amount` by the truck count), so on a genuine
      // FTL multi-vehicle load the receipt echoes the multiplier. Resolved from the SAME predicate
      // the engine's Layer A/B uses (discovery.isMultiVehicle - no second definition); null on a
      // single-vehicle / PMT / unknown-basis load, where perVehicleNote renders the line unchanged.
      vehicleCount: isMultiVehicle(L) ? Math.max(1, Math.round(Number(L.units))) : null,
      // The SAME public link doubles as the re-price surface once armed - the footer's "change it"
      // target. Omitted from the message body (changeLinkFooter) when absent - dashboard mode has none.
      changeLink: this.link(request),
    };
    // Bidding-contract line ("We'll bid from ... never below ..."): the rung PRICES come from the
    // armed ladder (opening first, lowest last). Each PERCENT is the margin that price carries over
    // the cost - the band's own figure where the price is that margin's price, so 12.6% shows as
    // 12.6%, and derived from the price where a ceiling, the minimum-margin clamp or a grid moved it.
    // The minimum margin is never a bid, so it is never the percent beside the lowest price.
    // All four numbers must be present or the line is omitted (waTemplates.biddingContract), and
    // the receipt renders exactly as before: a scheduled/not-yet-live capture whose armFromRequest
    // returned no ladder, or a rate-model demo that carries no marginsPct.
    const band = request.price || {};
    const margins = Array.isArray(band.marginsPct) ? band.marginsPct.map(Number).filter(Number.isFinite) : [];
    if (Array.isArray(ladder) && ladder.length && cost != null && margins.length && band.minMarginPct != null) {
      const rungPct = (price) => {
        const anchor = margins.find((m) => Math.round(cost * (1 + m / 100)) === price);
        return anchor != null ? anchor : (price / cost - 1) * 100;
      };
      data.openingBid = ladder[0];
      data.floorBid = ladder[ladder.length - 1];
      data.openingPct = rungPct(data.openingBid);
      data.floorPct = rungPct(data.floorBid);
    }
    if (request.account && request.account.label) {
      data.accountId = request.account.accountId;
      data.accountLabel = request.account.label;
    }
    const below = request.marginOverride && request.marginOverride.belowMinimum;
    if (below) data.belowMinimum = { marginPct: below.marginPct, customerMinPct: below.customerMinPct };
    // First capture keeps the stable per-request dedupe key, so a double-submit / retry can't
    // double-send. A re-price is a DELIBERATE repeat (the desk corrected the rate) and must get a
    // fresh acknowledgement each time - so it uses a unique key, the same way requestPrice's
    // operator "Alert again" does, and is never swallowed by the first receipt.
    const dedupeKey = reprice ? `${request.id}_price_submitted_reprice_${Date.now()}` : `${request.id}_price_submitted`;
    // changeLink IS the public /price capture link, whose final path segment is the raw capture
    // token - the sole auth for viewing and re-pricing this live-money load. Redact that token in
    // the LOGGED copy exactly as requestPrice does (redactToken(publicSeg) - first 6 chars, the
    // cosmetic slug prefix), so it never lands in stdout/pm2 or the dashboard event feed. The
    // unredacted data.changeLink still reaches the WhatsApp send path below - that message is the
    // whole point of the change-rate footer.
    const logData = { ...data, changeLink: `${this.baseUrl}/price/${redactToken(publicSeg(request))}` };
    await this.alert('price_submitted', data, { dedupeKey, logPayload: logData });
  }

  /**
   * What happened to a shipper TARGET RATE after the desk answered it.
   *
   * NOT confirmSubmitted: that one describes a ladder and tells the desk bidding has started. On a
   * target rate there is no ladder and nothing is still running - one bid was sent at the customer's
   * number, or nothing was sent and the desk needs to know why while the window is still open.
   *
   * Rides price_submitted's routing (same recipients, same scoping, no new ALERT_KINDS member) and
   * selects its own copy off the targetDone flag, the same mechanism the ask itself uses.
   */
  async confirmTargetRate(request, outcome = {}) {
    const L = request.load || {};
    const data = {
      platformKey: platformOf(request),
      // The outcome must reach the same phone the ask did, so it carries the channel override too -
      // otherwise the desk gets asked on WhatsApp and answered on a console nobody is watching.
      notifyModeOverride: this.targetRateMode,
      loadId: request.loadId, oaNo: request.loadId,
      shipper: L.companyName || '', origin: (L.lane && L.lane.origin) || '',
      branch: L.branchName || '',
      loadCode: L.loadCode || null,
      targetDone: true,
      targetSubmitted: !!outcome.submitted,
      targetPrice: outcome.price != null ? outcome.price : request.targetPricePerUnit,
      targetReason: outcome.reason || null,
      targetSendingOff: !!outcome.sendingOff,
      chargeLineCount: request.chargeLineCount != null ? request.chargeLineCount : 1,
    };
    await this.alert('price_submitted', data,
      { dedupeKey: `${request.id}_target_done` });
  }

  /**
   * CW-225. One line to the load's own group when the desk takes it off hold.
   *
   * A HOLD sends nothing today - its engine alert kind routes to neither ERROR_KINDS nor
   * DESK_NOTICE_KINDS (engineAlerts), and the re-price receipt is deliberately suppressed on the way
   * in, because a "rate submitted" confirmation on a load that stopped bidding is the product defect
   * this workstream exists to remove. The RESUME is the opposite fact and does need saying: the load
   * is bidding again, off a cost the desk has just replaced. So it takes the desk_notice channel -
   * the customer's own group, never the ops fault channel, scoped by the same keys every other
   * per-load message on that group carries.
   *
   * Best-effort, like every other receipt here: a send failure never fails the resume.
   */
  async holdResumed(request, hold) {
    const L = request.load || {};
    const data = {
      platformKey: platformOf(request),
      // scope-routing keys, at the top of `data` exactly as a desk notice needs them, or no
      // shipper-scoped or branch-scoped group can ever match this.
      origin: (L.lane && L.lane.origin) || '', shipper: L.companyName || '', branch: L.branchName || '',
      dest: (L.lane && L.lane.destination) || '',
      lane: [(L.lane && L.lane.origin) || '', (L.lane && L.lane.destination) || ''].filter(Boolean).join(' -> ') || '-',
      auctionId: request.loadId, oaNo: request.loadId,
      reason: 'bidding_resumed',
      standingBidPrice: hold && hold.standingBidPrice != null ? hold.standingBidPrice : null,
      resumedCost: request.price && request.price.cost != null ? request.price.cost : null,
    };
    // Per RESUME, not per load: a load corrected and resumed twice is two facts the desk needs, and
    // a load-only key would swallow the second.
    await this.alert('desk_notice', data, { dedupeKey: `${request.id}_hold_resumed_${Date.now()}` });
  }

  // `logPayload` (optional): a redacted view of `payload` used for the log line ONLY. The full
  // `payload` still reaches the WhatsApp send path unchanged - so a caller carrying a secret in
  // the payload (e.g. confirmSubmitted's capture-token changeLink) can keep it out of the log
  // without dropping it from delivery. Absent = log the payload as-is (unchanged for every other
  // caller).
  // Returns _whatsapp's disposition unchanged: FALSE only when the send was skipped because the
  // sender session is down (retryable - nothing sent, nothing marked), TRUE in every other case,
  // except 'price_needed' resolving to zero recipients, which returns the string 'unreached'
  // (also retryable, but a routing-config gap rather than a sender outage - see discovery.js).
  // TRUE IS NOT PROOF OF DELIVERY: it also covers "every recipient's send failed" and a swallowed
  // send error, both of which deliberately leave the key UNMARKED so a later offer can still land
  // it. A caller running a delivery retry must ask wasDelivered rather than trust this boolean.
  // Surfaced because such a caller needs the retryable signal; every existing caller ignores the
  // value and is unaffected.
  async alert(kind, payload = {}, { dedupeKey, logPayload } = {}) {
    this.log(`[notify:${this.notifyModeFor(payload.platformKey)}] ${kind} ${JSON.stringify(logPayload || payload)}`);
    if (ALERT_KINDS.includes(kind)) {
      return this._whatsapp(kind, dedupeKey || `${payload.auctionId || 'global'}_${kind}`, payload);
    }
    return true;
  }

  // Send the template to every recipient subscribed to `kind`. Never throws into the
  // engine/discovery path; a successful send marks the dedupe key so it won't repeat.
  // Returns FALSE only when the send was skipped because the sender session is down - a RETRYABLE
  // state the caller (discovery) re-attempts while the alert is still relevant. Returns TRUE in
  // every other case (sent, already-sent, no recipients, dashboard mode, disabled) so the caller
  // treats it as done and does not retry - EXCEPT 'price_needed' with zero matched recipients,
  // which returns 'unreached': also retryable (the routing gap may be fixed live), but distinct
  // from a sender outage so discovery can record it honestly and alert instead of going silent.
  async _whatsapp(kind, dedupeKey, data, { bannerPrefix } = {}) {
    // THE choke point. Every WhatsApp send in the product funnels through this line, so gating one
    // portal is a resolution change here rather than a filter at each of the callers. The payload's
    // platformKey is stamped by whoever built it (_priceNeededData, confirmSubmitted,
    // engineAlerts.notifyEngineEvent); absent resolves to SuperProcure - see notifyModeFor.
    // notifyModeOverride is set only by the target-rate payloads. Everything else resolves through
    // notifyModeFor exactly as before, so this cannot change any existing portal's routing.
    const mode = (data && data.notifyModeOverride) || this.notifyModeFor(data && data.platformKey);
    if (mode !== 'whatsapp' || !this.wa || !this.wa.enabled()) return true;
    // W1-1 V3-F01: checked BEFORE the persistent mark, not instead of it. A delivered send whose
    // _markSent write then failed (a full disk - the same fault a write-fault alert is often
    // reporting) leaves the persistent notifSent doc absent, so _alreadySent alone would read a
    // delivered message as never-sent and re-send it on every re-offer inside the re-alert window
    // (see bidEngine._recordWriteFailed). _sentThisProcess is set before _markSent is even attempted
    // (_recordSent), so it still answers correctly when the persist step is what's broken.
    if (dedupeKey && this._sentThisProcess.has(dedupeKey)) return true;
    // `reserved` tracks whether THIS call acquired the in-flight reservation, so only the acquiring
    // call releases it in the finally - a concurrent call that bails on `_inFlight.has` must never
    // delete the holder's key.
    let reserved = false;
    let resolveReservation = null;
    try {
      // Persistent (cross-restart) dedupe first, then the synchronous in-flight reservation that closes
      // the check->mark race (see constructor). The reservation is a check-and-set with NO await between
      // has() and set(), so two concurrent sends of the same key can never both pass it. Both stay inside
      // this try so a store error in _alreadySent is swallowed (return true) exactly as before, never
      // thrown into the fire-and-forget engine path.
      if (await this._alreadySent(dedupeKey)) return true;
      if (dedupeKey && this._inFlight.has(dedupeKey)) {
        // A send for this key is already running. WAIT for it rather than assume it will deliver -
        // the holder can acquire the reservation and still fail (every recipient's send errors, or a
        // health-skip lands after the reservation is taken), and this event has no other chance: the
        // dedupe key is the same one the holder is using, so nothing else will ever offer it again.
        const delivered = await this._inFlight.get(dedupeKey);
        if (delivered || this._sentThisProcess.has(dedupeKey)) return true;
        if (await this._alreadySent(dedupeKey)) return true;
        // The holder did not deliver it. Fall through and become the new holder below.
      }
      if (dedupeKey) {
        this._inFlight.set(dedupeKey, new Promise((resolve) => { resolveReservation = resolve; }));
        reserved = true;
      }
      const recipients = this.recipientsProvider ? (await this.recipientsProvider()) || [] : [];
      let matched = matchRecipients(recipients, kind, data);
      // Director, 2026-07: the group channel carries no per-bid rank PING. `outbid` is dropped for
      // scoped groups outright (rank lives on the dashboard + the /price link, not a WhatsApp ping).
      // `bid_live` is NOT dropped here: it reaches _deliverGroup, which folds it into the load's
      // status bubble as a SILENT edit ("bid placed" + the reprice link) - state, not a ping - and
      // skips the group entirely when there is no bubble to edit (so a group-only customer's DM
      // fallback still works, and no fresh bid_live ping is ever minted on the group). The alert
      // kinds themselves are untouched (the dashboard event feed and any DM subscriber still see both).
      if (kind === 'outbid') {
        matched = matched.filter((r) => !(isGroupJid(r.phone) && r.scope && (r.scope.shippers || []).length > 0));
      }
      // bid_live STEP-DOWN rungs (rungIndex > 0) only APPEND to the scoped group's bid-log bubble -
      // they must never re-ping a DM subscriber ("First bid" is the establishing rung 0 only). Drop
      // every non-scoped-group recipient for those. The establishing rung (0 / null) is untouched:
      // it still reaches DMs for the one first-bid ping AND the group for the log's first line.
      // `establishing === false` is the second way in: a bid banked after a re-price retired its
      // monitor carries no rung index at all (Number(null) is 0, which would read as the establishing
      // rung), and the engine states the fact outright instead. Same treatment as a step-down.
      if (kind === 'bid_live' && (Number(data.rungIndex) > 0 || data.establishing === false)) {
        matched = matched.filter((r) => isGroupJid(r.phone) && r.scope && (r.scope.shippers || []).length > 0);
      }
      // ONE message per close, and never ZERO. `pairedWithOutcome` marks an error alert the engine
      // emits in the same _finalize as the auction_result whose outcome message states the same fact
      // with more context (today: never_bid_before_close alongside the no_bid outcome - see
      // engineAlerts PAIRED_WITH_OUTCOME). Drop the redundant error copy only for the recipients that
      // outcome will ACTUALLY reach, resolved through the same matching + group-precedence the
      // outcome's own send runs. Keying on subscription instead is what left an unscoped all-alerts
      // ops recipient with nothing at all on a grouped customer: filtered out of the alarm because
      // they take 'lost', suppressed out of the outcome because a scoped group took it. Every matched
      // recipient now ends up with at least one of the two messages. Still deterministic - it is a
      // pure function of the recipient table, not of which alert happens to land first.
      if (kind === 'error' && data.pairedWithOutcome) {
        const covered = pairedOutcomeDelivery(recipients, data.pairedWithOutcome);
        matched = matched.filter((r) => !covered.has(r));
      }
      if (matched.length === 0) {
        // AN ACCOUNT-WIDE NOTICE THAT REACHES NOBODY IS BUCKET 3 of the price-page gate - a
        // notification that fails silently. It depends on two independently maintained config
        // surfaces agreeing (the recipient's shipper scope, and the account's deskCustomer), and
        // nothing forces them to, so the miss has to be observable rather than a quiet `return`.
        // Scoped to this class deliberately: most kinds legitimately resolve to zero recipients,
        // and warning on all of them would bury this one.
        if (data && data.accountWide) {
          this._emit('warn', `[notify:whatsapp] ${kind}: account-wide notice for '${data.shipper || ''}' matched ZERO recipients`
            + ' - no group carries a shipper scope naming that customer, so nobody was told',
          { kind, shipper: (data && data.shipper) || null, sessionAlert: (data && data.sessionAlert) || null });
        }
        // CW-145/G9: a price ask reaching zero recipients used to read exactly like an ordinary
        // delivery (return true -> markNotified -> nobody ever hears about it, nobody retries). A
        // distinct value lets the caller (discovery.js) tell this apart from the sender-down skip
        // (false) and from an ordinary successful send (true), so it can leave the request retryable
        // and raise a loud alert instead of a silent miss. See discovery.js's requestPrice call sites.
        if (kind === 'price_needed') return 'unreached';
        return true;
      }
      // Circuit breaker, now expressed through the shared per-CLASS health policy (_healthAction /
      // HEALTH_POLICY) so this path and the scheduled sendDirect path judge a down sender in ONE
      // place. If the sender's WhatsApp session is down, DON'T send: Maytapi would accept and QUEUE
      // the message, then flood the whole stale backlog on reconnect (a price ask for an auction
      // that already closed = noise). Every alert kind that reaches _whatsapp resolves to a SKIP
      // here - price_needed is 'retryable' (discovery re-fires it while the load is still open) and
      // the one-shot outcome kinds (price_submitted/bid_live/outbid/won/lost/error) are 'drop'
      // (nothing re-fires them; they are carried by the dashboard + the EOD summary). 'reroute' is
      // never returned for these kinds - it is the heartbeat's policy, and the heartbeat never comes
      // through _whatsapp. So the disposition is unchanged from before this refactor: skip the
      // send, return false (RETRYABLE to the one caller that consumes it, requestPrice), and do NOT
      // mark it sent, so nothing here can ever land on that queue. The request is also on the
      // dashboard worklist meanwhile, and the sender-health monitor alerts the operator to the
      // outage. No provider or an unreadable probe -> 'send' (fail-open), unchanged.
      let action = await this._healthAction(kind);
      // A notice nothing will ever re-send (engineAlerts DELIVER_WHEN_SENDER_DOWN) takes the price
      // ask's failover route rather than its class's drop.
      if (action !== 'send' && data && data.failoverWhenSenderDown) action = 'failover';
      // 'failover' (price_needed only) does NOT bail here - it falls through to build the very same
      // message this send would have carried, then hands it to _failoverDeliver below, which tries to
      // deliver it by another route before it will accept the skip. Every other non-'send'
      // disposition still short-circuits exactly as before.
      if (action !== 'send' && action !== 'failover') {
        this._emit('warn', `[notify:whatsapp] ${kind}: sender session DOWN - ${action} - skipping ${matched.length} send(s); not marked sent. Request is on the dashboard worklist.`,
          { kind, action, skipped: matched.length });
        return false;
      }
      // Group-routing: a per-customer group - a group carrying an explicit shipper scope - is the
      // SOLE channel for its customer's loads; individual DMs are then suppressed. That is how a
      // grouped customer's per-person DM blast collapses to one group message WITHOUT editing any
      // person's alertAll/assignment (the every-load people just stop matching a grouped customer
      // here, while still getting every customer that has no group). Only a SCOPED group triggers
      // suppression: an every-load group (empty shipper scope, which matches every load) is treated
      // as an ordinary extra recipient, never a global mute - otherwise one all-loads group would
      // silence every customer's DMs. When a BRANCH-scoped group also matches, it WINS over the same
      // customer's general group, so an Alwar load reaches the Alwar group ONLY - never both, and
      // never falling through to an individual DM. The mechanics live in splitChannels (shared with
      // the paired-outcome delivery prediction); delivery/fallback is handled at the send step below.
      const { channelGroups, others } = splitChannels(matched);
      // The TEMPLATE can differ from the routing kind (templateFor): a 'lost' close with zero landed
      // bids renders the no_bid receipt instead, without changing who the message routes to.
      let message = renderMessage(templateFor(kind, data), data);
      if (!message) return true;
      // remindApproaching's urgency banner: prepended here (not baked into waTemplates.js) so the
      // well-tested price_needed template body itself is untouched by the reminder feature. It also
      // marks this send as the approaching-deadline REMINDER (vs the original ask), which the group
      // lifecycle turns into a short threaded reply instead of the full DM re-send below. bannerPrefix
      // is a FUNCTION (remindApproachingBanner) evaluated HERE, at message-assembly time, not a
      // pre-baked string - so its "closing in N minutes" clause reflects elapsed time up to the actual
      // send, the same send-time guarantee the group path's ask_reminder template already has.
      const isReminder = kind === 'price_needed' && !!bannerPrefix;
      if (bannerPrefix) message = (typeof bannerPrefix === 'function' ? bannerPrefix(data) : bannerPrefix) + message;
      // multi-account only (accountId is never set with a single account): identify which SP
      // account this alert belongs to using the operator-set email for that account's login
      // contact, never the internal accountId/label, which reads as meaningless jargon to the
      // pricing team ("Account: Primary"). The write side (console's Accounts page + add-account.js
      // --email) lives in the accounts-contact-phone branch/PR - until that's merged AND an
      // account's email is actually set through it, this lookup finds nothing and the line is
      // simply omitted, never a fallback to the internal label (that omission is the intended
      // degrade-gracefully behavior, not a bug - see this PR's description for the dependency).
      if (data.accountId && this.store) {
        const contact = await this.store.getDoc(ACCOUNT_CONTACTS_COLLECTION, data.accountId)
          .catch((e) => { this.log(`[notify] account-contact lookup failed for ${data.accountId}: ${e && e.message}`); return null; });
        if (contact && contact.email) message += `\nAccount: ${contact.email}`;
      }
      // THE PRIMARY IS DOWN AND THIS IS A PRICE ASK. Everything above (routing, group precedence,
      // template, banner, account label) has already resolved identically to a healthy send, so the
      // failover delivers the SAME body to the SAME audience - only the wire it goes out on changes.
      // Placed here, after assembly and before the first wire call, so no send is ever attempted on
      // the dead sender first.
      if (action === 'failover') {
        return await this._failoverDeliver({ kind, dedupeKey, data, message, channelGroups, others });
      }
      let sent = 0;
      // `send` is the per-recipient wire call: a plain fresh sendText for individual DMs, or the
      // group edit/reply lifecycle (_deliverGroup) for a scoped group. Everything else - recording
      // the attempt, counting sends, surfacing a delivery failure - is identical regardless.
      //
      // Returns a per-run TALLY. `sent` alone cannot tell "0 sent because every send failed" from
      // "0 sent because every recipient was deliberately skipped", and those two need opposite
      // reporting: one is a channel outage, the other is normal design. Conflating them is what made
      // the 2026-07-25 bid_live blackout read as a Maytapi failure for 43 minutes when not a single
      // send had ever been attempted.
      const deliver = async (list, send) => {
        const tally = { sent: 0, skipped: 0, failed: 0, skipReasons: [] };
        for (const r of list) {
          const res = await send(r);
          // A deliberate group no-op (e.g. bid_live with no status bubble to edit) is neither a
          // send nor a failure: don't count it, don't record it, don't error-log it. Leaving `sent`
          // untouched lets the DM `others` fallback run below, so a group-only customer's bid_live
          // still reaches its DM subscribers instead of being swallowed.
          if (res && res.skipped) {
            tally.skipped += 1;
            if (res.reason) tally.skipReasons.push(res.reason);
            continue;
          }
          await this._record(kind, r.phone, r.name, res);
          if (res && res.ok) { sent += 1; tally.sent += 1; continue; }
          tally.failed += 1;
          // A WhatsApp delivery failure here is otherwise invisible to the operator - the dashboard
          // shows the alert as "sent" once _whatsapp returns, so this is the one place a stopped
          // channel surfaces.
          const err = new Error((res && (res.error || res.reason)) || 'unknown');
          this._emit('error', `[notify:whatsapp] ${kind} -> ${r.name || r.phone} failed: ${err.message}`,
            { kind, recipient: r.name || r.phone, err });
        }
        return tally;
      };
      // Groups first. Suppress the individual DMs only if a group actually TOOK the message; if
      // every group send fails (the bot was removed from the group, or it was deleted), fall
      // through to the individuals. So a grouped customer that retains ANY individual fallback (an
      // every-load operator, an assigned person) can never silently reach nobody. A group-ONLY
      // customer whose group is dead has, by definition, no one left to deliver to - that case is
      // not silent either: it emits a distinct "reached NOBODY" error below. (A Maytapi 'ok' is
      // "accepted", not "read"; the alive-but-empty group is a membership-health concern for a
      // follow-up, not something this send-level fallback can detect.)
      let groupSent = 0;
      let groupTally = null;
      if (channelGroups.length > 0) {
        this._emit('debug', `[notify:whatsapp] dispatching ${kind} to ${channelGroups.length} group(s)`, { kind, recipientCount: channelGroups.length });
        groupTally = await deliver(channelGroups, (r) => this._deliverGroup(r, { kind, data, message, isReminder }));
        groupSent = sent;
      }
      if (channelGroups.length === 0 || groupSent === 0) {
        // SKIP vs FAILURE. Zero group sends has two completely different meanings, and the wording
        // below must not claim the wrong one: `allSkipped` is every group recipient deliberately
        // no-op'ing (no ask thread / no status bubble for bid_live) with NOTHING attempted on the
        // wire - normal, expected, and an INFO line naming the reason. A genuine send failure keeps
        // the error + reachedNobody wording, which is now true whenever it appears.
        const allSkipped = !!groupTally && groupTally.failed === 0 && groupTally.skipped > 0;
        const why = (groupTally && groupTally.skipReasons.length)
          ? [...new Set(groupTally.skipReasons)].join('; ') : 'no reason recorded';
        if (channelGroups.length > 0 && others.length === 0) {
          if (allSkipped) {
            this._emit('info', `[notify:whatsapp] ${kind}: every group recipient was deliberately SKIPPED (${why}) - nothing was attempted on the wire and there is no individual fallback`,
              { kind, allSkipped: true, skipped: groupTally.skipped, reason: why });
          } else {
            this._emit('error', `[notify:whatsapp] ${kind}: every group send failed and there is NO individual fallback - this alert reached NOBODY`, { kind, reachedNobody: true });
          }
        } else if (channelGroups.length > 0) {
          if (allSkipped) {
            this._emit('info', `[notify:whatsapp] ${kind}: every group recipient was deliberately SKIPPED (${why}) - falling back to ${others.length} individual DM(s)`,
              { kind, allSkipped: true, skipped: groupTally.skipped, reason: why, fallback: others.length });
          } else {
            this._emit('error', `[notify:whatsapp] ${kind}: every group send failed - falling back to ${others.length} individual DM(s)`, { kind, fallback: others.length });
          }
        } else {
          this._emit('debug', `[notify:whatsapp] dispatching ${kind} to ${others.length} recipient(s)`, { kind, recipientCount: others.length });
        }
        // A GROUP in `others` is an unscoped ops/desk group, not an individual - it gets the
        // anchoring path so a load's messages thread there too. Individuals are unchanged: the
        // edit/reply lifecycle is group-channel-only, and a DM has no thread to join.
        await deliver(others, (r) => (isGroupJid(r.phone)
          ? this._deliverGroupAnchored(r, { kind, data, message, isReminder })
          : this.wa.sendText(r.phone, message, { kind })));
        // BACKSTOP - the group channel must never resolve to zero deliveries silently.
        //
        // bid_live is the one kind with no fallback left at this point: the rungIndex > 0 filter
        // above strips every DM recipient, and _deliverGroup skips the group whenever the load has
        // no ask thread or no status bubble to edit. Those two mechanisms together can reach nobody
        // with no bug in play at all - a genuinely bubble-less load does it - and during a live
        // soft-close defend that means the desk watches a silent group while the bot bids.
        //
        // So degrade to a fresh group sendText: exactly the path won/lost already take when their
        // thread is missing (_deliverGroup's `return this.wa.sendText(jid, message, ...)`). It costs
        // one extra bubble on an already-rare path and is strictly better than silence.
        //
        // Deliberately NOT fired on a genuine send failure - a fresh send to a jid whose send just
        // failed would fail the same way. Skips only.
        if (kind === 'bid_live' && allSkipped && others.length === 0) {
          this._emit('warn', `[notify:whatsapp] ${kind}: group skipped (${why}) with no DM fallback - degrading to a fresh group message so the alert is not silent`,
            { kind, backstop: true, reason: why, recipientCount: channelGroups.length });
          await deliver(channelGroups, (r) => this.wa.sendText(r.phone, message, { kind }));
        }
      }
      // An outcome ENDS the load's thread - nothing after it quotes this anchor - so mark it closed.
      // That mark is what lets the anchor collection be bounded by evicting FINISHED loads instead
      // of the oldest one, which is routinely an auction still running.
      if (kind === 'won' || kind === 'lost') {
        const loadId = data && (data.loadId || data.oaNo || data.auctionId);
        if (loadId) {
          try { await closeAsk(this.store, loadId); }
          catch (e) { this.log(`[notify] ask-thread close failed for load ${loadId}: ${e && e.message}`); }
        }
      }
      if (sent > 0) await this._recordSent(dedupeKey, kind);
      return true;
    } catch (e) {
      this._emit('error', `[notify:whatsapp] ${kind} send aborted: ${e && e.message}`, { kind, err: e });
      return true; // a generic send error is logged, not retried (only the deliberate health-skip retries)
    } finally {
      // Release the reservation on EVERY exit of the acquiring call - success, the retryable health-skip
      // (return false), an all-recipients-failed send (sent === 0, so _markSent was skipped), or a thrown
      // error. Only a successful send leaves a lasting block, and that block is the persistent _markSent
      // above, not this Map - so a genuine failure/skip stays retryable exactly as before this change.
      // Resolve the reservation's promise with the actual outcome (whether THIS process marked the key
      // delivered) so any waiter that queued up behind it knows to send itself rather than trust a
      // holder that failed.
      if (reserved) {
        this._inFlight.delete(dedupeKey);
        resolveReservation(this._sentThisProcess.has(dedupeKey));
      }
    }
  }

  /**
   * THE PRICE-ASK FAILOVER CHAIN. Runs only when the primary sender has already probed DOWN and the
   * kind is price_needed (HEALTH_POLICY 'failover'). Per group, in order, stopping at the FIRST
   * success:
   *
   *   1. another controlled sender that is HEALTHY and a VERIFIED PARTICIPANT of THAT group;
   *   2. a direct message to that customer's designated desk OWNERS;
   *   3. email, through the existing Maytapi-independent Brevo channel;
   *   4. nothing worked -> return false, which is the old skip-and-retry, unchanged.
   *
   * ORDERING RATIONALE, which is the whole design. Each step is strictly worse than the one above it
   * at the thing the ask is FOR - putting a priceable load in front of the people who price that
   * customer, in the place they already watch:
   *   - a sibling in the same group is nearly free and costs the reader nothing: same group, same
   *     thread, same audience, same /price link. Only the sending number differs.
   *   - the owner DM reaches an accountable human but loses the group: the rest of the desk cannot
   *     see the ask, and a customer with no designated owner has nobody here at all. That is why it
   *     is second and not first.
   *   - email is the only tier that survives ALL of WhatsApp being down, and is the slowest thing a
   *     freight desk reads. Last, and genuinely last-resort.
   *
   * EXACTLY ONE DELIVERY PER ASK. `continue` on the first successful step per group - a group that a
   * sibling reached never also DMs the owner, and never also emails. Within the owner step every
   * designated owner is DM'd, because that step REPLACES a group broadcast to that customer's desk
   * and one sleeping owner would otherwise silently swallow the ask; that is one channel delivering
   * to its audience, not four channels each delivering a copy.
   *
   * IDEMPOTENT ACROSS RECOVERY, and this is the part that had to be got right. A fallback delivery
   * funnels into the SAME `sent` counter and the SAME `_markSent(dedupeKey)` the healthy path uses,
   * and returns TRUE. That single fact closes both re-send doors at once:
   *   - `_whatsapp` returning true makes requestPrice report delivered:true, so discovery.js calls
   *     markNotified and the request flips to notified:true - it is no longer re-fired at all;
   *   - and even if something did re-fire it (an operator "Alert again" shares the key, a restart
   *     replays a tick), `_alreadySent(dedupeKey)` now finds the persisted notifSent doc and returns
   *     true before a single wire call. The persistent mark is what survives the restart; the
   *     notified flag is what stops the loop.
   * The failure this avoids is the loud one: had the fallback delivered while still returning false,
   * every ask delivered during the outage would have been re-sent into every group the moment 128023
   * re-linked - 18 groups' worth of duplicate asks on loads that had already been priced.
   *
   * A failed step is NOT marked and NOT counted, so it stays retryable exactly as before.
   */
  async _failoverDeliver({ kind, dedupeKey, data, message, channelGroups, others }) {
    let sent = 0;
    let groupsDelivered = 0;   // how many channelGroups actually landed, by any tier
    const chain = [];   // one label per group/DM, for a single readable summary line at the end

    // ---- groups: sibling sender -> owner DM -> email -------------------------------------------
    for (const g of channelGroups) {
      const alt = this.senderFleet ? await this.senderFleet.pickForGroup(g.phone) : null;
      if (alt) {
        const res = await alt.sendText(g.phone, this._viaFallbackNote(message), { kind });
        await this._record(kind, g.phone, g.name, res);
        if (res && res.ok) {
          sent += 1;
          chain.push(`${g.name || g.phone}: sibling ${alt.phoneId}`);
          // Record the ask anchor WITH the sender that actually minted it. A later reply/edit is
          // issued by whichever phone is live then, and a message id minted by one Maytapi phone is
          // not something another phone is known to be able to quote - unverified, and this is not
          // the place to gamble on it. _deliverGroup treats a `via` mismatch as "no thread" and
          // degrades to a fresh send, which is the same safe path a missing thread already takes.
          const loadId = data && (data.loadId || data.oaNo || data.auctionId);
          if (kind === 'price_needed' && res.messageId && loadId) {
            try { await recordAsk(this.store, loadId, g.phone, res.messageId, Date.now(), { via: alt.phoneId }); }
            catch (e) { this.log(`[notify] ask-thread record failed for load ${loadId}: ${e && e.message}`); }
          }
          groupsDelivered += 1;
          continue;   // delivered - do NOT also DM the owner, do NOT also email
        }
        this._emit('error', `[notify:failover] ${kind}: sibling ${alt.phoneId} could not reach ${g.name || g.phone} - stepping down to the desk owner`,
          { kind, via: alt.phoneId, group: g.name || g.phone });
      } else {
        this._emit('warn', `[notify:failover] ${kind}: no healthy controlled sender is a verified participant of ${g.name || g.phone} - stepping down to the desk owner`,
          { kind, group: g.name || g.phone });
      }
      const viaOwner = await this._deliverToOwners({ kind, data, message, group: g });
      if (viaOwner > 0) { sent += viaOwner; groupsDelivered += 1; chain.push(`${g.name || g.phone}: owner DM x${viaOwner}`); continue; }
      if (await this._deliverByEmail({ kind, data, message, group: g })) {
        sent += 1; groupsDelivered += 1; chain.push(`${g.name || g.phone}: email`); continue;
      }
      chain.push(`${g.name || g.phone}: UNDELIVERED`);
    }

    // ---- individual DM subscribers -------------------------------------------------------------
    // No membership question here (a DM has no group to be a participant of), so any healthy fleet
    // member will do. These are people already subscribed to price asks on customers with no scoped
    // group, so losing them to the outage is the same money loss in a different shape.
    //
    // Gated exactly like the healthy path's own others delivery (_whatsapp: `channelGroups.length ===
    // 0 || groupSent === 0`): price_needed always runs it (a price ask never holds back a fallback -
    // money on the table), and every other kind runs it only when no channel group actually landed.
    // Without this gate an unscoped recipient subscribed to more than one alert kind could get BOTH
    // this DM (redundant - their group already has the message via a sibling/owner/email) and a
    // separate call's own others delivery (e.g. tick_fault_handoff's OPS_MIRRORED_NOTICES error
    // mirror), for one event, where the healthy path would have sent them exactly one message.
    if (others.length && (kind === 'price_needed' || groupsDelivered === 0)) {
      const dm = this.senderFleet ? await this.senderFleet.pickForDm() : null;
      if (dm) {
        for (const r of others) {
          const res = await dm.sendText(r.phone, this._viaFallbackNote(message), { kind });
          await this._record(kind, r.phone, r.name, res);
          if (res && res.ok) { sent += 1; continue; }
          this._emit('error', `[notify:failover] ${kind} -> ${r.name || r.phone} failed on sibling ${dm.phoneId}: ${(res && (res.error || res.reason)) || 'unknown'}`,
            { kind, recipient: r.name || r.phone, via: dm.phoneId });
        }
        chain.push(`DMs via sibling ${dm.phoneId}`);
      } else {
        chain.push(`${others.length} DM(s): no healthy sender`);
      }
    }

    if (sent > 0) {
      this._emit('warn', `[notify:failover] ${kind}: primary sender DOWN - delivered by fallback (${chain.join('; ')}); marked sent so it is NOT re-sent on recovery`,
        { kind, delivered: sent, chain });
      await this._recordSent(dedupeKey, kind);
      return true;
    }
    this._emit('error', `[notify:failover] ${kind}: primary sender DOWN and EVERY fallback route failed (${chain.join('; ') || 'no route attempted'}) - not marked sent, still retryable. Request is on the dashboard worklist.`,
      { kind, chain, reachedNobody: true });
    return false;
  }

  /**
   * DM the customer's designated desk owners. Returns how many landed (0 = this step did not deliver
   * and the caller steps down to email).
   *
   * `owner:true` is the ONLY designation walked, exactly as resolveOwners defines it - assignments
   * answer "who receives this customer's alerts", which on live data is nearly everyone including the
   * Director, and blasting that list would be worse than the outage. A customer with no owner returns
   * 0 honestly rather than guessing a plausible human; guessing here would put a live-money ask in
   * front of someone with no authority to price it.
   */
  async _deliverToOwners({ kind, data, message, group }) {
    if (!this.ownersProvider) return 0;
    let owners = [];
    try { owners = (await this.ownersProvider(data && data.shipper)) || []; }
    catch (e) { this._emit('error', `[notify:failover] owner lookup failed: ${e && e.message}`, { kind, err: e }); return 0; }
    if (!owners.length) {
      this._emit('warn', `[notify:failover] ${kind}: ${group.name || group.phone} has NO designated desk owner - stepping down to email`,
        { kind, group: group.name || group.phone });
      return 0;
    }
    const dm = this.senderFleet ? await this.senderFleet.pickForDm() : null;
    if (!dm) return 0;
    const body = this._ownerDmNote(message, group, kind);
    let landed = 0;
    for (const o of owners) {
      const res = await dm.sendText(o.phone, body, { kind });
      await this._record(kind, o.phone, o.name, res);
      if (res && res.ok) landed += 1;
      else this._emit('error', `[notify:failover] ${kind}: owner DM to ${o.name || o.phone} failed: ${(res && (res.error || res.reason)) || 'unknown'}`,
        { kind, recipient: o.name || o.phone, via: dm.phoneId });
    }
    return landed;
  }

  // Last resort: the SAME body out through the Maytapi-independent Brevo channel the heartbeat's
  // 'reroute' already uses. Only reached when no controlled sender can post into the group and no
  // desk owner could be DM'd. `to`/`name` are left empty so alertChannel's sibling tier finds no
  // dialable individual and skips itself - the WhatsApp attempts are already exhausted by this point
  // and repeating them here would be a second delivery of the same ask.
  async _deliverByEmail({ kind, data, message, group }) {
    if (!this.fallbackAlert) return false;
    const who = (data && data.shipperName) || (group && group.name) || 'a customer';
    const ask = kind === 'price_needed';
    try {
      const out = await this.fallbackAlert({
        subject: ask ? `BRL bidder: PRICE NEEDED for ${who} - WhatsApp could not be reached`
          : `BRL bidder: please bid by hand for ${who} - WhatsApp could not be reached`,
        body: `${message}\n\n---\nThe WhatsApp sender is down and no controlled number could post into this customer's group.`
          + (ask ? ' Price this load from the link above.' : ''),
        to: '', name: null, kind,
      });
      return !!(out && out.ok);
    } catch (e) {
      this._emit('error', `[notify:failover] email tier threw: ${e && e.message}`, { kind, err: e });
      return false;
    }
  }

  /**
   * ONE line saying this came from the backup number, prepended to the otherwise byte-identical ask.
   *
   * DELIBERATE, and it is a trade. The cost is a line of noise on a message the desk reads under time
   * pressure. The benefit is that the ask arrives from a number the reader has never seen it come
   * from before, carrying a link and asking for a price on live money - which is indistinguishable in
   * shape from the freight-payment phishing these desks actually receive. An ask that reads as a scam
   * is an ask that does not get priced, and an unexplained new sender is also the thing most likely
   * to be reported to an admin mid-incident. Saying it plainly costs one line and removes both.
   *
   * Prepended, never woven in, so the ask body itself stays exactly what the golden template tests
   * pin - the fallback cannot drift the message the desk normally reads.
   */
  _viaFallbackNote(message) {
    return `_(sent from the backup number - the usual one is offline)_\n\n${message}`;
  }

  // The owner DM carries MORE explanation than the group note, because the reader is being addressed
  // somewhere they do not normally receive asks at all, about a customer whose group is silent. It
  // names the group so an owner covering several desks knows which one is dark, and says the desk did
  // not get it - otherwise the natural assumption is that this is a duplicate of something the group
  // already saw, and it gets ignored as noise.
  _ownerDmNote(message, group, kind = 'price_needed') {
    const label = (group && group.name) || 'the customer group';
    const what = kind === 'price_needed' ? 'ask' : 'message';
    return `_(you are getting this directly because *${label}* could not be reached - the WhatsApp sender is offline, and the desk has NOT seen this ${what})_\n\n${message}`;
  }

  /**
   * Deliver one message to a scoped GROUP with the noise-reduction lifecycle (group channel only;
   * individual DMs go through the plain sendText path in _whatsapp, unchanged). One load's separate
   * group pings collapse to ONE pristine anchor + ONE mutating status bubble + a pinging outcome:
   *
   *   - THE ASK (price_needed, non-reminder): SENDS fresh, records the ask's messageId, and is
   *     NEVER edited again. It carries the rate request + the /price link, and is the anchor every
   *     reply threads onto - so the outcome always hangs off the original ask, not a mutated bubble.
   *   - THE STATUS BUBBLE: ONE message that lives between the ask and the outcome. Created lazily as
   *     a REPLY to the ask on the FIRST status event (pings once - the load visibly moved), then
   *     EDITED in place (silent) on every later transition:
   *       reminder        -> ask_reminder body  (the deadline nudge - usually creates the bubble)
   *       price_submitted -> ask_resolved body   (rate received; remembers the reprice link)
   *       bid_live        -> bid_placed body     (bid placed + the reprice link)
   *     bid_live ONLY edits an existing bubble; with no bubble it SKIPS the group (returns a skip,
   *     so the DM fallback still runs) rather than mint a fresh ping. EDITS past Maytapi's ~15-min
   *     window silently no-op (soft-close runs longer) - we do NOT re-anchor with a new reply (that
   *     is the per-bid noise the Director killed); the reprice link on the last good edit carries
   *     live state. So bubble edits are best-effort by design.
   *   - WON: a REPLY under the pristine ask carrying the full RICH outcome (pings - they want it).
   *   - LOST: a REPLY under the pristine ask carrying the SHORT outcome (lost_short) - the ask above
   *     already has the lane/vehicle/close, so the loss reply need only shout rank + our last bid.
   *   - anything else SENDS fresh (unchanged).
   *
   * Returns a sendText-shaped result so the caller's record/accounting is identical to a plain send
   * (a `skipped` result is treated as a benign no-op there). Any thread-store hiccup degrades to a
   * fresh send - a busy group never loses a message over this.
   */
  async _deliverGroup(group, { kind, data, message, isReminder }) {
    const jid = group.phone;
    const loadId = data && (data.loadId || data.oaNo || data.auctionId);
    const now = Date.now();
    // THE ASK: send fresh, remember its message id, never touch it again. A re-alert of the ask
    // resets the entry (recordAsk), so a fresh ask is a fresh anchor AND a fresh (empty) bubble.
    if (kind === 'price_needed' && !isReminder) {
      const res = await this.wa.sendText(jid, message, { kind });
      if (res && res.ok && res.messageId && loadId) {
        // Stamped with THIS sender, symmetrically with the failover path, so the ownership test below
        // is a comparison between two recorded values rather than "absent means mine".
        try { await recordAsk(this.store, loadId, jid, res.messageId, now, { via: this.wa && this.wa.phoneId }); }
        catch (e) { this.log(`[notify] ask-thread record failed for load ${loadId}: ${e && e.message}`); }
      }
      return res;
    }
    // Every later message needs the ask handle; without it (ask predates this / was DM-only / store
    // hiccup) fall back to a fresh send so nothing drops - except bid_live, a silent enhancement
    // that skips rather than mint a ping the Director asked us not to.
    let thread = null;
    if (loadId) {
      try { thread = await getAskFor(this.store, loadId, jid); }
      catch (e) { this.log(`[notify] ask-thread lookup failed for load ${loadId}: ${e && e.message}`); }
    }
    // A thread minted by a DIFFERENT Maytapi phone is treated as NO thread. reply_to/edit quote a
    // message id, and cross-phone quoting is unverified on this account - a reply that silently
    // no-ops (Maytapi answers success:true for edits that vanish) would lose the outcome message
    // entirely. Degrading to a fresh send costs one extra bubble on a load whose ask went out during
    // an outage, and is the same fallback a missing thread already takes. `via` absent = legacy entry
    // from before the field existed -> trusted, so no pre-upgrade load changes behaviour.
    const mine = !thread || thread.via == null || String(thread.via) === String(this.wa && this.wa.phoneId);
    if (!thread || !thread.messageId || !mine) {
      if (kind === 'bid_live') return { ok: false, skipped: true, reason: 'no ask thread for bid_live' };
      return this.wa.sendText(jid, message, { kind });
    }

    // OUTCOME: reply to the PRISTINE ASK (never the bubble). won is rich; lost is the short reply.
    if (kind === 'won') {
      return this._replyOrSend(jid, thread.messageId, message, kind);
    }
    if (kind === 'lost') {
      // short reply under the ask - lost_short, or no_bid_short when nothing ever landed. The short
      // body is only safe BECAUSE it quotes the ask (which carries lane/vehicle/close); if the reply
      // is refused, _replyOrSend must re-send the FULL body, not the short one that assumed context.
      const body = renderMessage(templateFor(kind, data, { short: true }), data) || message;
      return this._replyOrSend(jid, thread.messageId, body, kind, { plainBody: message });
    }

    // STATUS-BUBBLE transitions (reminder / rate received / bid placed).
    const isBubbleKind = (kind === 'price_needed' && isReminder) || kind === 'price_submitted' || kind === 'bid_live';
    if (isBubbleKind) {
      // bid_live only ever EDITS an existing bubble; with none it skips (stays silent, DM still runs).
      if (kind === 'bid_live' && !thread.bubbleId) return { ok: false, skipped: true, reason: 'no status bubble for bid_live' };
      let body; let link;
      if (kind === 'price_needed') { body = renderMessage('ask_reminder', data) || message; }
      // A TARGET RATE IS NOT A RATE RECEIVED. ask_resolved says the rate landed and bidding follows,
      // and it carries the re-price link. On a target rate nothing follows - the bid was sent or it
      // was refused - and the record is closed, so the link leads to a page that cannot re-price.
      // Same payload flag the DM path selects on, so the two channels cannot say different things.
      else if (kind === 'price_submitted' && data && data.targetDone) { body = renderMessage('price_target_done', data) || message; link = null; }
      else if (kind === 'price_submitted') { body = renderMessage('ask_resolved', data) || message; link = data.changeLink; }
      else { // bid_live: APPEND this bid to the bubble's running log, then re-render the whole log.
        // ts is stamped now (the engine fires bid_placed synchronously at placement); rank is the
        // live socket rank off the event; the live link comes off the receipt (stored on the thread).
        let logState = null;
        try { logState = await appendBubbleBid(this.store, loadId, jid, { ts: now, price: data.price, rank: data.rank }, now); }
        catch (e) { this.log(`[notify] bid-log append failed for load ${loadId}: ${e && e.message}`); }
        const bids = (logState && logState.bids) || [{ ts: now, price: data.price, rank: data.rank }];
        const bidCount = (logState && logState.bidCount) || 1;
        const bidData = { name: loadId, bids, bidCount, changeLink: data.changeLink || thread.link };
        body = renderMessage('bid_placed', bidData) || message;
      }
      if (thread.bubbleId) {
        // EDIT the bubble in place (silent, best-effort past the window - see the method header).
        const res = await this.wa.editText(jid, thread.bubbleId, body, { kind });
        // Remember a link a later state may need (rate-received's reprice link) WITHOUT moving
        // bubbleSentAt - the edit window is measured from the bubble's original send.
        if (link != null && link !== '') { try { await recordBubble(this.store, loadId, jid, thread.bubbleId, thread.bubbleSentAt || now, { link }); } catch (_) {} }
        return res;
      }
      // First status event -> CREATE the bubble as a REPLY to the ask (pings once), record it.
      // Routed through _replyOrSend like every other reply site in this function: a refused reply
      // here used to return straight to deliver(), which only tallies a failure and logs - the
      // reminder and the first receipt reached the group as nothing at all.
      // recordBubble stays gated on `threaded` - a plain-send fallback is not a quotable bubble
      // parent, so recording it would aim every later edit at a message that was never a bubble.
      const res = await this._replyOrSend(jid, thread.messageId, body, kind);
      if (res && res.ok && res.threaded && res.messageId && loadId) {
        try { await recordBubble(this.store, loadId, jid, res.messageId, now, { link }); }
        catch (e) { this.log(`[notify] bubble record failed for load ${loadId}: ${e && e.message}`); }
      }
      return res;
    }

    // A last-resort floor bid is one state change. When this group's bubble already logged that bid
    // and can still be edited, the bubble takes the final-bid statement and no second message goes.
    // Past the edit window an edit silently no-ops, so the notice is sent as before.
    if (kind === 'desk_notice' && data && data.reason === 'last_resort_floor_fired'
        && thread.bubbleId && withinEditWindow(thread.bubbleSentAt, now)) {
      let logState = null;
      try { logState = await markBubbleFinal(this.store, loadId, jid, { price: data.floor, rank: data.myRank }, now); }
      catch (e) { this.log(`[notify] final-bid mark failed for load ${loadId}: ${e && e.message}`); }
      // The bubble prints the final line only when the marked bid is its LAST entry; markBubbleFinal
      // marks the most recent one at this price, which a later, higher entry can follow.
      const lastBid = logState && logState.bids[logState.bids.length - 1];
      if (lastBid && lastBid.final) {
        const body = renderMessage('bid_placed', { name: loadId, bids: logState.bids, bidCount: logState.bidCount, changeLink: thread.link });
        const res = body ? await this.wa.editText(jid, thread.bubbleId, body, { kind }) : null;
        if (res && res.ok) return Object.assign({}, res, { folded: true });
      }
    }

    // EVERYTHING ELSE ABOUT THIS LOAD (error, desk_notice, outbid): a threaded reply under the
    // pristine ask, so an alarm reads as part of the load's thread rather than a loose message the
    // group has to match up by hand. Reply, never edit: these state NEW facts, not a newer version
    // of the ask, and an edit past Maytapi's ~15-min window silently no-ops while still answering
    // success:true - a live auction outlives that window routinely.
    return this._replyOrSend(jid, thread.messageId, message, kind);
  }

  /**
   * The group channel for a recipient that is NOT a customer's scoped group - the unscoped ops/desk
   * groups, which reach here through the `others` list. They get ANCHORING ONLY: the ask is
   * remembered, later messages about that load quote it, and nothing else changes. Deliberately not
   * the full _deliverGroup lifecycle - that rewrites bodies and can SKIP a bid_live with no bubble,
   * and neither belongs on a group that subscribed to raw alerts.
   *
   * The error class can ONLY arrive here: an error payload carries no shipper (engineAlerts keeps
   * its scope keys nested on purpose), so no shipper-scoped group ever matches one.
   *
   * LIMITATION - this threads a load only when THIS group also took that load's ask. `others` is
   * delivered only when no scoped group took the message (the precondition at the `groupSent === 0`
   * branch above), and the price ask DOES carry a shipper. So on a load whose customer has a working
   * scoped group, the ask never reaches this path, no anchor is ever recorded under this jid, and the
   * later ops alarm finds no thread and degrades to the plain send at the tail below - exactly the
   * loose message it was before this path existed. Threading here therefore fires for loads with NO
   * scoped group, or whose scoped-group ask send failed. That is the case the live complaint came
   * from, and it is the whole of what this path fixes.
   *
   * Making a shipper-less alarm join a SCOPED group's thread is a routing change - the alarm would
   * have to inherit the load's scope - with a real noise cost, and is deliberately not made here.
   * Pinned by the two-group case in scripts/test-wa-load-thread.js.
   */
  async _deliverGroupAnchored(group, { kind, data, message, isReminder }) {
    const jid = group.phone;
    const loadId = data && (data.loadId || data.oaNo || data.auctionId);
    const now = Date.now();
    if (kind === 'price_needed' && !isReminder) {
      const res = await this.wa.sendText(jid, message, { kind });
      if (res && res.ok && res.messageId && loadId) {
        try { await recordAsk(this.store, loadId, jid, res.messageId, now, { via: this.wa && this.wa.phoneId }); }
        catch (e) { this.log(`[notify] ask-thread record failed for load ${loadId}: ${e && e.message}`); }
      }
      return res;
    }
    if (!loadId) return this.wa.sendText(jid, message, { kind });
    let thread = null;
    try { thread = await getAskFor(this.store, loadId, jid); }
    catch (e) { this.log(`[notify] ask-thread lookup failed for load ${loadId}: ${e && e.message}`); }
    // Same cross-phone rule as the scoped path: an id minted by a sibling sender is not known to be
    // quotable by this one, so it is treated as no anchor at all.
    const mine = !thread || thread.via == null || String(thread.via) === String(this.wa && this.wa.phoneId);
    if (!thread || !thread.messageId || !mine) return this.wa.sendText(jid, message, { kind });
    return this._replyOrSend(jid, thread.messageId, message, kind);
  }

  /**
   * Send `message` as a reply quoting `parentId`, degrading to a plain unthreaded send if the wire
   * refuses the reply. Threading is a READABILITY win and is never allowed to cost a delivery: a
   * stale, deleted or otherwise unquotable parent must leave the desk with the message, not with
   * silence. `plainBody` is the fallback text for a caller whose threaded body was shortened on the
   * assumption the quoted parent supplies the missing context.
   *
   * A `skipped` result (client disabled, sender down) is returned as-is - that is a deliberate
   * no-op the caller already accounts for, not a failed reply to retry.
   *
   * A delivered result carries `threaded`: true when the messageId came from the REPLY, false when
   * it came from the plain-send fallback. Only the bubble-create caller reads it, and it must: a
   * plain send is not a quotable bubble parent.
   */
  async _replyOrSend(jid, parentId, message, kind, { plainBody } = {}) {
    const res = await this.wa.replyText(jid, parentId, message, { kind });
    if (res && res.skipped) return res;
    if (res && res.ok) return Object.assign({}, res, { threaded: true });
    this._emit('warn', `[notify:whatsapp] ${kind}: threaded reply to ${jid} was refused (${(res && res.error) || 'unknown'}) - re-sending it unthreaded`,
      { kind, recipient: jid, threaded: false, err: (res && res.error) || null });
    const out = await this.wa.sendText(jid, plainBody != null ? plainBody : message, { kind });
    return Object.assign({}, out, { threaded: false });
  }

  /**
   * Direct send to ONE explicit recipient - the daily-heartbeat and per-customer EOD paths (and any
   * future message with a fixed, operator-chosen audience). Deliberately NOT routed through
   * _whatsapp: alert-kind subscription/scope/dedupe are per-load routing concerns, and these sends'
   * audiences are config/model-driven lists that must not depend on someone keeping an alert-kind
   * ticked on the Team page. It IS, since 2026-07-25, behind the sender-health policy (_healthAction).
   * This path used to bypass the breaker entirely, which is how a logged-out sender silently QUEUED
   * the daily EOD + heartbeat onto a dead session (the accept-and-queue flood the breaker exists to
   * prevent - confirmed live 2026-07-24/25). The old bypass rationale - "a late heartbeat still
   * proves the box was alive, whereas skipping recreates the silent morning" - is HONORED, not
   * discarded: the heartbeat is REROUTED to a live out-of-band channel (email + a healthy sibling
   * phone) rather than skipped, so the reader still hears from the bot without the dead-sender queue;
   * the EOD, which never had that justification (it reused sendDirect by convenience), is DROPPED and
   * carried by the dashboard + the next evening's report. Mirrors sendTest for the wa.enabled() gate
   * and reuses _record, so every attempt (sent, dropped, or rerouted) lands on the same queryable
   * notifications stream. Operator "Send test" (sendTest) stays OUTSIDE this gate by design - the
   * operator triggers it to OBSERVE delivery, and a breaker would hide the very failure being tested.
   */
  async sendDirect(phone, message, { kind = 'direct', name = null } = {}) {
    if (!this.wa || !this.wa.enabled()) return { ok: false, skipped: true, reason: 'whatsapp disabled' };
    const to = String(phone || '').trim();
    if (!to) return { ok: false, error: 'no recipient number' };
    if (!message) return { ok: false, error: 'no message' };
    // Sender-health gate. sendDirect used to POST unconditionally; now it routes through the SAME
    // per-class policy the alert path uses, so a down sender is judged in exactly one place and this
    // scheduled path can never again queue onto a dead session (see _healthAction / HEALTH_POLICY).
    const action = await this._healthAction(kind);
    if (action === 'reroute') {
      // The named-human DMs (heartbeat, director_eod): reach a human by a LIVE path, but never queue
      // onto the very sender they are often warning about. Deliver the SAME body through the Maytapi-
      // independent fallback channel (Brevo email + a healthy sibling phone), NEVER the dead sender.
      // No channel wired -> DROP (still never falls through to the dead sender): the standalone
      // sender-health monitor emails the operators on sender-down independently, so the outage is
      // not unheard even then.
      if (this.fallbackAlert) {
        let out = null;
        // Subject names the CLASS that was rerouted, so a Director opening a rerouted EOD is not
        // told it is a heartbeat. Interpolated rather than branched - for kind 'heartbeat' this
        // renders the exact string it always did.
        const subject = `BRL bidder: WhatsApp sender is DOWN - ${kind} rerouted`;
        try {
          out = await this.fallbackAlert({ subject, body: message, to, name, kind });
        } catch (e) {
          this._emit('error', `[notify:${kind}] reroute channel threw: ${e && e.message}`, { kind, recipient: name || to, err: e });
        }
        const rerouted = { ok: !!(out && out.ok), skipped: true, rerouted: true, reason: 'sender down - rerouted' };
        this._emit(rerouted.ok ? 'warn' : 'error',
          `[notify:${kind}] sender session DOWN - rerouted to the out-of-band channel (email/sibling), NOT the dead sender${rerouted.ok ? '' : ' - reroute did not confirm delivery'}`,
          { kind, recipient: name || to, ok: rerouted.ok });
        await this._record(kind, to, name, rerouted);
        return rerouted;
      }
      const dropped = { ok: false, skipped: true, reason: 'sender down - no reroute channel; dropped' };
      this._emit('error', `[notify:${kind}] sender session DOWN and no reroute channel wired - dropped (NOT queued onto the dead sender); the standalone monitor covers sender-down`,
        { kind, recipient: name || to });
      await this._record(kind, to, name, dropped);
      return dropped;
    }
    if (action !== 'send') {
      // 'drop' (eod_report + the fail-safe default for any unclassified scheduled kind): a stale
      // scheduled message is worse re-delivered than skipped - skip the POST so nothing queues onto
      // the dead sender, record the attempt as not-delivered, and return a benign skip. (No
      // sendDirect caller yields 'retryable' today; if one ever did it also lands here - safely
      // skipped, never queued onto a down sender. Only 'send' below ever reaches the wire.)
      const dropped = { ok: false, skipped: true, reason: `sender down - ${action}` };
      this._emit('warn', `[notify:${kind}] sender session DOWN - ${action}, not queued onto the dead sender (on the dashboard; next report carries it)`,
        { kind, recipient: name || to, action });
      await this._record(kind, to, name, dropped);
      return dropped;
    }
    const res = await this.wa.sendText(to, message, { kind });
    await this._record(kind, to, name, res);
    if (!res || !res.ok) {
      const err = new Error((res && (res.error || res.reason)) || 'unknown');
      this._emit('error', `[notify:${kind}] send to ${name || to} failed: ${err.message}`, { kind, recipient: name || to, err });
    }
    return res;
  }

  // Operator "Send test" - verify delivery to one number without touching the alert routing.
  async sendTest(phone, { note } = {}) {
    if (!this.wa || !this.wa.enabled()) return { ok: false, error: 'WhatsApp not connected (set the Maytapi token, product ID and phone ID on the server).' };
    const to = String(phone || '').trim();
    if (!to) return { ok: false, error: 'A phone number is required.' };
    const message = renderMessage('test', { note });
    if (!message) return { ok: false, error: 'test message missing' };
    const res = await this.wa.sendText(to, message, { kind: 'test' });
    await this._record('test', to, null, res);
    if (!res || !res.ok) {
      const err = new Error((res && (res.error || res.reason)) || 'unknown');
      this._emit('error', `[notify:whatsapp] test send to ${to} failed: ${err.message}`, { err });
    }
    return res;
  }

  // Append each send attempt (ok or fail) to a queryable stream so a silent failure is visible.
  async _record(kind, to, name, res) {
    if (!this.store) return;
    try {
      await this.store.appendEvent('notifications', {
        kind, to, name: name || null,
        ok: !!(res && res.ok),
        error: res && res.ok ? null : (res && (res.error || res.reason)) || 'unknown',
        messageId: (res && res.messageId) || null,
      });
    } catch (_) { /* recording must never break a send */ }
  }

  /**
   * Has this dedupeKey been RECORDED as delivered? Marked only after at least one recipient was
   * actually sent to, so this is the one honest delivery signal the notifier can offer.
   *
   * Answers from what this process actually SENT first, and only then from the store. Those differ
   * in the case that matters: a send can land and its mark fail to persist, and reading the store
   * alone would then report the page as never delivered and invite a retry on every tick.
   *
   * NULL means "cannot answer" - nothing sent here and no store to ask - which is a different fact
   * from "no". A caller running a retry must not read an unanswerable store as proof the page never
   * landed, or it will re-offer forever on a store-less box.
   */
  /**
   * Record a delivery that actually reached the wire. BOTH of _whatsapp's delivery exits funnel
   * through here - the ordinary send and the price-ask failover chain - so wasDelivered can never
   * answer "no" about a message a human received.
   *
   * In-process FIRST, then the persistent mark. The order is the whole point: the mark is a file
   * write and can throw on a full disk, and a caller that retries undelivered pages would then
   * re-send something already delivered, once per retry tick.
   */
  async _recordSent(dedupeKey, kind) {
    if (dedupeKey) {
      this._sentThisProcess.add(dedupeKey);
      if (this._sentThisProcess.size > DEDUPE_CAP) {
        this._sentThisProcess.delete(this._sentThisProcess.values().next().value);
      }
    }
    await this._markSent(dedupeKey, kind);
  }

  async wasDelivered(key) {
    if (!key) return null;
    if (this._sentThisProcess.has(key)) return true;
    if (!this.store) return null;
    return this._alreadySent(key);
  }

  async _alreadySent(key) {
    if (!this.store || !key) return false;
    return !!(await this.store.getDoc(DEDUPE_COLLECTION, key));
  }

  async _markSent(key, kind) {
    if (!this.store || !key) return;
    await this.store.putDoc(DEDUPE_COLLECTION, key, { key, kind, at: Date.now() });
    const all = await this.store.listDocs(DEDUPE_COLLECTION);
    if (all.length > DEDUPE_CAP) {
      const overflow = all.filter((d) => d && d.key).sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, all.length - DEDUPE_CAP);
      for (const d of overflow) await this.store.removeDoc(DEDUPE_COLLECTION, d.key);
    }
  }
}

// HEALTH_POLICY is exported for ONE reason: so a test can assert every subscribable kind has an
// explicit entry. It could not be tested through _healthAction, because an unlisted kind and a kind
// listed as 'drop' both return 'drop' - the coverage gap and the correct answer are indistinguishable
// from outside. That is why the map's own claim that "the regression test asserts every scheduled
// kind is gated" was not true when it was written. Read-only by contract; nothing mutates it.
module.exports = { Notifier, DEDUPE_COLLECTION, DEDUPE_CAP, HEALTH_POLICY, scopeMatches, remindApproachingBanner };
