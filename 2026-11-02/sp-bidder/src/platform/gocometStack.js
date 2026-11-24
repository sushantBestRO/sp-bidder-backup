'use strict';

/**
 * The GoComet stack - a sibling of server.js's buildRealStack, producing the same five-part record
 * { account, tag, adapter, scheduler, engine, discovery } for a SECOND portal. It reuses the
 * existing machinery wholesale (the caller's makeEngine, DurableScheduler, DiscoveryPoller, the
 * shared discovery gate); nothing here is a parallel implementation of anything.
 *
 * It lives under src/platform/ rather than inside server.js because the portal-specific identifiers
 * it must name - the account id, the env var holding the token, the capability gaps below - are not
 * allowed outside this directory (docs/MULTI_PLATFORM_ARCHITECTURE.md invariant 1), and because a
 * module can be composed in a test without booting Express.
 *
 * THE ACCOUNT RECORD IS LOAD-BEARING, NOT DECORATION. server.js's stackForRequest resolves a price
 * request's owning stack by `reqDoc.account.accountId` and FALLS BACK TO `stacks[0]`, which is a
 * SuperProcure stack. The record - and the `tag` that stamps it onto every request discovery
 * creates - are jointly what make that lookup land here. Without them every GoComet price capture
 * would arm the SuperProcure engine against a GoComet load id, which is precisely the defect a
 * previous attempt shipped. The record goes through the same validateAccount as a SuperProcure one
 * (slug-checked id, env-var-NAME token reference, no secret anywhere on it).
 */

const { validateAccount } = require('../auth/accounts');
const { DiscoveryPoller } = require('../discovery/discovery');

/**
 * The capability keys src/engine/bidEngine.js actually reads off `adapter.capabilities()`, with the
 * site that reads each. Checked at construction because the alternative - MULTI_PLATFORM_ARCHITECTURE.md
 * invariant 8 - is that an undeclared capability degrades to a fallback nothing logs.
 *
 * Presence is tested with `!== undefined`, never truthiness: `revisionLimit: null` is a legitimate
 * declaration meaning "unlimited/unknown" (the SuperProcure adapter declares exactly that), and
 * `standingPriceVisible: false` is the honest GoComet value. Only an ABSENT key is a gap.
 */
const ENGINE_CAPABILITY_READS = Object.freeze([
  'minDecrement',         // ladder step guard + every _decide() decrement floor
  // TWO consumers, ONE entry. The engine seeds monitor.revisionsLeft from it (arm()); the desk page
  // states it as the bid budget (server.js portalFactsFor -> the "Only N bids on this load" note).
  // It is listed here rather than in both lists because one fact gets one entry - a key in two lists
  // is two places to remove it from, and the second is the one that gets missed.
  'revisionLimit',        // arm(): seeds monitor.revisionsLeft; ALSO the desk page's bid budget
  'closeModel',           // arm(): seeds monitor.closeModel
  'standingPriceVisible', // _decide(): whether a standing L1 PRICE can be read at all, or only rank
  // Also two consumers: the arm refusal and the desk page's refusal card, which exists so the desk
  // learns the portal cannot bid BEFORE typing a cost rather than from the arm's 409 afterwards.
  'biddingEnabled',       // priceRequests.armFromRequest: refuse the arm outright when false
  // Intake/pricing consumer, like biddingEnabled above: it is the ONLY bound on how far one
  // observation may move a load's close, so discovery refuses every refresh without it and the
  // sweeps go back to retiring a still-running auction off the worklist. Silent, and on a portal
  // observed running 22 extension rounds it is the whole mechanism.
  'extensionIncrementMs', // discovery: bounds a live close-time refresh (priceRequests.refreshLiveClose)
]);

/**
 * The capability keys the PRODUCT SURFACE reads - src/web/server.js `portalFactsFor`, which decides
 * what the /price desk page tells a person before they type a number. Sibling of the list above,
 * deliberately NOT merged into it: the two answer different questions, and an operator reading a
 * boot warning at 2am needs "the page will misstate this" to look nothing like "the engine will
 * misprice this". A merged list makes a web-layer omission read as an engine fault.
 *
 * Same presence rule, and here it is not a detail but the entire mechanism: `extensionCeiling: null`
 * is the DECLARATION that no cap exists, so a truthiness check would read the most load-bearing
 * value in this list as an omission and invert its meaning.
 *
 * Why these need a construction-time assert at all - each omission is silent and none of them
 * throws:
 *   platformLabel           the portal badge simply does not render. On a box working two portals
 *                           from one worklist that leaves an unlabelled row on a shared operator
 *                           surface, which MULTI_PLATFORM_ARCHITECTURE.md invariant 5 calls the one
 *                           wrong answer.
 *   extensionCeiling        THE DANGEROUS ONE. Absent reads as "cap unknown", so the close badge
 *                           falls back to "Soft - limited" - SuperProcure's BOUNDED anti-snipe
 *                           wording - on an auction that has been observed running 22 extension
 *                           rounds. The desk is then told something false about the exact fact the
 *                           revision-budget note exists to convey, and nothing anywhere says so.
 *                           The budget note is gated on this key too, so one omission removes the
 *                           warning AND the correction together.
 *   multiCargoBidSupported  the multi-cargo refusal card never renders, so a load the write path
 *                           will refuse gets priced first - the take-a-cost-then-discard-it shape
 *                           this integration has already shipped once.
 *   partialVehicleCountSupported  absent reads as "a partial count is expressible", so a
 *                           multi-truck load renders an EDITABLE count control on a portal whose
 *                           write path refuses every partial. The desk lowers it, every rung throws
 *                           PARTIAL_VEHICLE_COUNT before the wire, and the load closes with no bid.
 */
const SURFACE_CAPABILITY_READS = Object.freeze([
  'platformLabel',          // portalFactsFor: the portal badge, and the portal named in a refusal
  'extensionCeiling',       // portalFactsFor: capped vs uncapped close wording + the budget-note gate
  'multiCargoBidSupported', // loadWillNotBid: whether a several-cargo-line load is refused at render
  'partialVehicleCountSupported', // renderPriceForm: whether the truck-count control is editable
]);

/**
 * Engine mechanisms that are INERT on this adapter, and why. These are not capabilities() fields -
 * they are getAuctionState() state fields - so no construction-time inspection can find them; they
 * are declared here and logged loudly instead, which is the whole of invariant 8's complaint
 * ("nothing logs that the mechanism is off").
 *
 * Kept honest by scripts/test-gocomet-stack.js, which asserts the adapter really does omit each
 * field on a mapped state. When the adapter starts publishing one, that test fails and this entry
 * comes out - the declaration cannot rot silently into a lie.
 */
const INERT_MECHANISMS = Object.freeze([
  {
    field: 'triggerWindowMs',
    mechanism: 'fire-above-the-anti-snipe-window (_softFinalShotBand / _decisiveBandFor)',
    effect: 'degrades to the flat floor window; the mechanism built for the 4-of-4 self-extension incident does not run',
  },
]);

/**
 * Undeclared keys out of a given read list. Presence only (`!== undefined`) - see both list
 * docblocks for why a truthiness test would be wrong in each.
 */
function gapsAgainst(caps, keys) {
  const declared = caps || {};
  return keys.filter((k) => declared[k] === undefined);
}

/** Every capability key the engine reads that this adapter does not declare. */
function capabilityGaps(caps) {
  return gapsAgainst(caps, ENGINE_CAPABILITY_READS);
}

/** Every capability key the desk page reads that this adapter does not declare. */
function surfaceCapabilityGaps(caps) {
  return gapsAgainst(caps, SURFACE_CAPABILITY_READS);
}

/**
 * The stack's account record. `allowlist` is set unconditionally so discoveryConfigFor's
 * `(account && account.allowlist) || config.allowlist` picks THIS scope rather than SuperProcure's
 * global one - two portals' shipper lists are not interchangeable.
 *
 * hardCloseOnly is FALSE, and that is a deliberate, portal-shaped decision rather than a relaxation
 * of a safety default. Every GoComet enquiry is soft by construction (the adapter declares
 * closeModel 'soft' and sets softClose true on every mapped load), so discovery.isOutOfHardCloseScope
 * excludes all of them from a hard-close-only allowlist and the poller would surface nothing at all.
 * Note this is NOT the same lever as enrolling the shipper in config.softClose.shippers: that list
 * also drives bidEngine._resolveSoftStrategy and would change SuperProcure-side endgame semantics
 * for any SP shipper whose name token-matches.
 */
function gocometAccount(gc) {
  return validateAccount({
    accountId: gc.accountId,
    label: gc.accountLabel,
    tokenEnv: gc.tokenEnv,
    enabled: true,
    allowlist: {
      shippers: (gc.allowlistShippers || []).slice(),
      lanes: (gc.allowlistLanes || []).slice(),
      hardCloseOnly: false,
    },
  });
}

/**
 * Compose the stack around an ALREADY-REGISTERED, already-logged-in GoComet adapter. The adapter is
 * passed in rather than built here because registration (offline JWT adoption + the token-expiry
 * rail) happens under its own gate and must keep working when this stack is switched off.
 *
 * Starts nothing. The caller owns whether discovery runs, because that is the console-toggleable
 * gate and it has to survive a live Settings save.
 */
function buildGoCometStack({
  adapter, gc, makeEngine, makeScheduler, discoveryConfigFor,
  requests, notifier, gate = null, log = null, onExpire = () => {},
  healthcheckUrl = null, healthcheckPeers = null, // D003
}) {
  const account = gocometAccount(gc);
  // The tag is NOT conditional on how many accounts run, unlike the SuperProcure stacks' (which
  // stay null on a single-account box so their output is byte-identical to the pre-multi-account
  // days). It is what stamps the owning account onto every price request this poller creates, and
  // an untagged request resolves to stacks[0] - the SuperProcure engine.
  const stack = {
    account,
    tag: { accountId: account.accountId, label: account.label },
    platformKey: gc.platformKey,
    adapter,
  };
  stack.capabilityGaps = capabilityGaps(adapter.capabilities());
  stack.surfaceCapabilityGaps = surfaceCapabilityGaps(adapter.capabilities());
  stack.inertMechanisms = INERT_MECHANISMS.map((m) => m.field);
  stack.scheduler = makeScheduler(account.accountId);
  stack.engine = makeEngine(adapter, stack.scheduler, stack);
  stack.discovery = new DiscoveryPoller({
    adapter, requests, notifier,
    config: discoveryConfigFor(account),
    account: stack.tag, gate,
    platformKey: gc.platformKey,
    log,
    onExpire,
    healthcheckUrl, healthcheckPeers, // D003
    engine: stack.engine, // D012
  });
  return stack;
}

/** Boot lines for what the engine will silently do without. Empty array when there is nothing to say. */
function capabilityWarnings(stack) {
  const out = [];
  for (const k of stack.capabilityGaps || []) {
    out.push(`[gocomet] capability '${k}' is NOT declared by the adapter - the engine falls back silently. Declare it or the fallback is the strategy.`);
  }
  // Kept as its own loop with its own sentence, not folded into the one above. The layer named in
  // the line IS the diagnosis: an engine gap means a price may be wrong, a surface gap means the
  // desk is being told something the adapter never said.
  for (const k of stack.surfaceCapabilityGaps || []) {
    out.push(`[gocomet] capability '${k}' is NOT declared by the adapter - the desk price page falls back silently and STATES something it cannot know. Declare it or the page's wording is a guess.`);
  }
  for (const m of INERT_MECHANISMS) {
    out.push(`[gocomet] no '${m.field}' on this adapter's state: ${m.mechanism} is INERT - ${m.effect}.`);
  }
  return out;
}

module.exports = {
  buildGoCometStack, gocometAccount, capabilityGaps, surfaceCapabilityGaps, capabilityWarnings,
  ENGINE_CAPABILITY_READS, SURFACE_CAPABILITY_READS, INERT_MECHANISMS,
};
