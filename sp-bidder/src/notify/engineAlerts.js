'use strict';

const { fmtNum, fmtVehicle, fmtDMY, fmtClock, dropAddress, pickupAddress, laneEnds } = require('./waTemplates');
const { bidTimeBand, resolveBidTimeCost } = require('./bidTimeCost');
const { reportedCloseAt, lastPlacedBid, bidGapsMs, hasResultFacts, lastBidAtLowestMargin, earlyPortalCloseAt } = require('../util/reportedClose');
const { createLogger } = require('../logging/logger');

const log = createLogger('engineAlerts');

/**
 * Maps an engine event to a recipient-facing notification (kind + dedupe key +
 * template data). Only the ALERT_KINDS reach WhatsApp; anything else -> null
 * (stays a dashboard/log event). The kind <-> recipient routing happens in the
 * Notifier; this is purely "which operator-facing alert, if any, does this event mean".
 *
 * won/lost carry BRL's enquiry-template fields (OA No / From / To / Vehicle Type /
 * market rate / margin / ranking / close time). The event gives the load basics;
 * the finalized closed-bids record (via outcomeEnrichment) fills the money detail.
 */

const laneStr = (lane) => (lane && lane.origin ? `${lane.origin} -> ${lane.destination}` : '?');

// Engine alert kinds that are worth telling a human about (collapse to one 'error' notification).
// 'multi_vehicle_held'    - Layer A fail-closed: an FTL multi-vehicle load the engine will NOT
//                           auto-bid. Multi-vehicle bidding is default-on, so this fires only for the
//                           exceptions - the off-switch (SP_MULTI_VEHICLE_BID=0) or an unverified
//                           count basis - where an auto-bid would risk a wrong count ("-1 vehicles",
//                           unallottable, or an unproven vcq:N); the desk must quote it manually.
// 'vehicle_count_mismatch' - the read-back oracle: SuperProcure recorded a bidVehicleCount that
//                           differs from the count we meant to send (e.g. it kept -1 on a
//                           multi-vehicle bid, or Layer B's vcq:N did not take) - the detector that
//                           would have surfaced the 23167278 "-1 vehicles" allotment failure.
// The two fail-closed refusals also belong here: each one is a load the bot is deliberately NOT
// bidding (unbuilt mechanic / transit days never captured) - invisible from the console alone until
// the auction is already lost, and both have a human fix (handle manually / re-price with days).
//
// 'auth_error_mid_auction' is NOT here, and was removed on 2026-08-04 rather than left as it was.
// The engine still emits it (bidEngine's read-failure path) and it is still a dashboard/log event;
// what it must not be is a WhatsApp kind. It was dormant only because realAdapter set state.authError
// exclusively when ensureSession threw, and ensureSession checked nothing but the JWT expiry - which
// a REVOKED but unexpired token passes. The moment the read path started classifying 401/403 (the
// same change that added this note), that rail woke up - and its dedupe key is built from the
// AUCTION ID, so it is one message per load, rendering as raw jargon through the generic error
// template. That is a second flood replacing the first one this change exists to remove. The
// account-wide fact now has exactly one message: account_auth_dead, raised once per account per
// outage by the adapter itself.
const ERROR_KINDS = new Set([
  'killed', 'floor_breach_blocked', 'tick_error', 'repeated_read_failures',
  'multi_vehicle_held', 'vehicle_count_mismatch',
  // Per-tonne sibling of vehicle_count_mismatch: SuperProcure echoed a different per-MT rate
  // (amountPMT / bidRate) than the one we put on the wire, so our rate did not land as sent. Same
  // class, same human fix (check the load on SuperProcure), so it belongs on the same channel.
  'pmt_amount_mismatch',
  'unsupported_rule_blocked', 'transit_time_missing_blocked',
  // The structural belt backstop if an over-ceiling amount ever reached the adapter. Its sibling
  // 'ceiling_below_floor' is NOT here any more - see DESK_NOTICE_KINDS below for why the two split.
  'ceiling_breach_blocked',
  // Engine armed and ticked all the way to close without ever landing a single bid (see
  // bidEngine.js _finalize's everBid check) - a distinct, more alarming failure than a normal
  // fought loss, and must reach a human the same way any other error-class alert does.
  'never_bid_before_close',
  // A load reached an arm path carrying a floor margin of 0 or below, which would have put its lowest
  // bid at exactly the desk's cost; the house default was substituted instead. OPS,
  // not a desk notice: the remedy is a customer/config record the desk cannot edit, and the load
  // itself arms and bids normally. It sits here rather than log-only because the seven weeks this ran
  // unnoticed were seven weeks of a log line nobody read.
  'zero_floor_margin_substituted',
  // A durable write failed after the portal took (or may have taken) a bid, at close, or of the round
  // count. The engine carries on from memory, but a restart or a re-price would read the stale record.
  'bid_record_failed', 'close_record_failed', 'round_record_failed',
  // The deferred-arm failures (2026-08-05). These are OPS kinds, not desk notices, and the split is
  // deliberate: unlike a ceiling or a vehicle count, the desk cannot do anything about a close time
  // that moved or a wake that landed after the auction ended. What they represent is the engine's
  // frozen view of a load disagreeing with the platform's - a system fault, and one that will keep
  // silently forfeiting loads until someone looks at it.
  //
  //   armed_into_closed_auction  - the scheduled wake found the auction already over. This is the
  //                                silent zero-bid itself, now named at the moment it happens.
  //   close_time_moved_earlier   - SuperProcure served an earlier close than the one captured at
  //                                pricing time. The single fact no artifact in this system could
  //                                previously report; it is what separates "the close moved" from
  //                                "we were late", which used to be indistinguishable.
  //   wake_retired_past_close    - a rate was entered and the load was retired without ever arming.
  //
  // 'wake_arm_failed' is on the same channel for the same audience but NOT for the same cause: it is
  // arm() itself throwing inside the scheduled wake, which leaves a priced load un-armed, un-retired
  // and with nothing left to revisit it. Its detail is deliberately cause-free prose - both
  // reachable arm() throws name rupee figures, and this channel reaches the client's Director.
  //
  // 'rehydrate_arm_failed' is wake_arm_failed's restart-path twin: arm() throwing inside
  // rehydrate()'s per-intent loop, so a load that was live before the restart does not come back.
  // It is now a per-load alert rather than a crash because the throw is contained there - without a
  // message the load is simply absent from the resumed set, which nothing else reports.
  'armed_into_closed_auction', 'close_time_moved_earlier', 'wake_retired_past_close',
  'wake_arm_failed', 'rehydrate_arm_failed',
  // A desk re-price whose re-arm failed twice - on the new plan and on the prior one put back - so
  // the load is parked on its prior cost with nothing bidding it.
  'reprice_arm_failed',
  // 'close_unknown_held' is their sibling for a durable intent whose close is absent or implausible,
  // or a live read that carries no countdown: the engine holds it rather than bid on a countdown it
  // cannot trust, so the desk must quote it.
  'close_unknown_held',
  // 'wake_retire_failed' follows wake_arm_failed when the stranded load's retire could not be
  // written: the intent stays active, so a restart can re-arm a load the desk is quoting by hand.
  'wake_retire_failed',
  // rehydrate()'s own retirement sweep can leave the same durable-write failure behind on a
  // RESTART rather than a scheduled wake - retirePastClose() already names those intents as
  // `failed`, but until now that fact reached nobody past the info-level restart_with_live_auctions
  // message. Mirrors the GoComet writes-off branch's equivalent alert in server.js.
  'rehydrate_retire_failed',
  // The read path's own terminal case, and a sibling of the three above: the engine's view of a load
  // and the platform's have diverged so far that it can no longer see the load at all. It reaches
  // this channel rather than staying a log line because the alternative is what it replaces - after
  // repeated_read_failures fires at exactly the fifth failure, nothing else ever spoke again, so a
  // load could be abandoned in silence. Its detail is fixed prose for the same reason
  // wake_arm_failed's is: this channel reaches the client's Director.
  'unreadable_past_close_retired',
  // A tick threw past its own handlers; the load is still watched. Once per run of consecutive
  // faults (bidEngine._tickFaulted), keyed per run so a later run is not swallowed as a duplicate.
  'tick_fault',
  // The tick-fault hand-off could not be saved, so a restart would re-arm a load the desk now bids
  // by hand. Its own kind, keyed per run like tick_fault: sharing tick_error's per-load key let any
  // earlier tick_error on the load swallow it.
  'tick_fault_handoff_unsaved',
  // Our last live read of a priced load was over 3 s before its close (bidEngine _finalize): the last
  // seconds went unseen, so a timing loss would otherwise read as an ordinary result (2026-09-25,
  // Waaree 260925RP1C). OPS: the fix is ours, not the desk's.
  'stale_read_at_close',
]);

// Error kinds keyed per fault run (evt.faultSince) rather than per load.
const RUN_KEYED_ERRORS = new Set(['tick_fault', 'tick_fault_handoff_unsaved']);

// THE UNMAPPED REMAINDER IS DELIBERATELY NOT ON THIS CHANNEL. `refusal_unrecognised` follows its
// nearest sibling (refused_price_bound) to the operator event ring and the close receipt, and stays off
// the Director's error channel, which carries one DM per load.
//
// An earlier draft of this change put it in ERROR_KINDS on a rarity argument - "the entire remainder
// over two box snapshots is 4 refusals across 2 loads". That figure counts only the one NAMED member
// of the remainder, and two docstrings in this same change say the opposite of the set it would
// actually route: isRecognisedRefusal and _refusedPriceBound both record that only six refusals
// carry a named regex, so the whole healthy price/state population - min-decrement mismatches above
// all, the most common refusal there is - answers "unrecognised". The volume is unmeasured, and the
// same change drops the hold's trigger from three refusals to one on the 7-of-12 SuperProcure
// customers sitting at a tight attempt budget, so a single floor refusal now reaches the hold where
// three used to. That is the alert-storm shape that moved ceiling_below_floor off this channel on
// 2026-07-27, and rarity is the one claim that cannot be checked before it ships.
//
// So the routing decision is made the other way and the class earns the channel only once the
// unmapped-remainder volume has been counted off the box snapshots. Nothing is lost in the meantime:
// the close receipt names the cause to the desk (waTemplates.js's `refusal_unrecognised` noBidWhy
// branch), and the portal's verbatim words ride the event to the operator surfaces and the durable
// record, which is where the next classifier gets written from.

// Error kinds the engine emits in the SAME _finalize as an auction_result, mapped to the ROUTING
// KIND of that paired outcome - today just never_bid_before_close -> 'lost', which fires exactly when
// a close had zero landed bids and therefore renders the 'no_bid' outcome template.
//
// THE DEDUPE (and why it is here rather than a dropped alert kind). Both messages are wanted, but by
// DIFFERENT readers: the error is the ops alarm ("a load we armed took no bid - go look"), the
// outcome tells the desk the load's result. They are 1:1 by construction, so anyone who receives
// BOTH would get two WhatsApp messages about one close within seconds. Rather than drop the alarm
// from ERROR_KINDS (that would silence ops entirely, and this alert was added precisely so a
// zero-bid close reaches a human), the Notifier drops the ERROR copy only for the recipients the
// OUTCOME will actually be delivered to - so nobody gets both, and, more importantly, nobody gets
// neither. The suppressed one is always the redundant one, never the outcome.
//
// The value is the outcome's kind, not a boolean, because the Notifier has to RESOLVE that outcome's
// real recipient set (scope match + group precedence + DM suppression) to know who is genuinely
// covered. Inferring it from subscription alone is what broke: an error payload carries no shipper,
// so no shipper-scoped group ever matches the alarm, while the outcome DOES carry one - a scoped
// group takes the outcome and suppresses the individual DMs, and an unscoped all-alerts ops
// recipient ends up filtered out of the alarm AND suppressed out of the outcome. Zero messages, on
// exactly the audience this alarm exists for.
const PAIRED_WITH_OUTCOME = new Map([['never_bid_before_close', 'lost']]);

/**
 * NON-PAGING desk notices: a load we deliberately declined for a COMMERCIAL reason.
 *
 * 'ceiling_below_floor' - the shipper's price ceiling sits below our cost floor, so no bid that
 * respects the ceiling can clear the floor and every legal bid would lose money. That is the L5
 * ceiling guard doing exactly its job, and it is a normal outcome of quoting freight, not a fault.
 * It sat in ERROR_KINDS until 2026-07-27, which meant it routed as 'error' - and after the client's
 * Director narrowed his own alert list to ["error","won","lost"] to cut DM volume, 'error' became
 * one of the few kinds still reaching him, so the noise reduction had the perverse effect of making
 * these his main traffic (13 DMs on 27-Jul, opened by SIKA 23534893).
 *
 * TWO things change together, and both are load-bearing:
 *   1. the routing KIND becomes 'desk_notice' - a class no operator subscribes to for outages, so
 *      it stops paging anyone who signed up for faults.
 *   2. the payload carries the load's SCOPE KEYS (origin / shipper / branch) at the top of `data`,
 *      which an 'error' payload deliberately does not. That is what lets a per-customer group match
 *      it: without a shipper on the payload no shipper-scoped group can ever match (the reason the
 *      old alarm could only ever reach unscoped all-loads recipients - i.e. the Director).
 * Doing only (1) would move it to a kind nobody could route; doing only (2) to an 'error' payload
 * would silently start matching customer groups against EVERY error kind, which is a different and
 * unrequested routing change (see the note on pairedWithOutcome below).
 *
 * NOT here, deliberately, though they are also deliberate refusals: 'unsupported_rule_blocked',
 * 'transit_time_missing_blocked', 'multi_vehicle_held'. Each of those is a load waiting on a HUMAN
 * ACTION (quote it by hand, enter the transit days) rather than a commercial dead end, and quietly
 * demoting an action item on a money path with no evidence it is causing noise is not a trade worth
 * making. They keep paging.
 *
 * 'never_bid_before_close' is NOT here either, and that is the sharper call. Once the engine stops
 * raising it for refusals it already explained (bidEngine._finalize's deliberateZeroBid, widened in
 * the same change), what remains under that kind is only the GENUINE failure - armed and tried and
 * nothing ever landed, or armed and never fired for a reason nobody recorded. That is precisely the
 * case the alarm was added for, so it stays an error and keeps paging. Demoting it would be the
 * blanket silence this change is careful not to become.
 *
 * ONE EXCEPTION was added on 2026-08-04 and it is stated here because the paragraph above would
 * otherwise read as forbidding it. When the account's SuperProcure session is dead, _finalize holds
 * this emit back per load (bidEngine's authSuppressed) - NOT by demoting the kind, and not by
 * dropping the log line, which still prints at error with an authDeadSuppressed field on it. The
 * defence is that this is not blanket silence: it is conditioned on a positively detected platform
 * state, it self-clears on the first non-auth fire outcome, it is bounded in time so a stuck latch
 * degrades to noise rather than silence, and the cause gets its own single account_auth_dead
 * message naming the account. The desk keeps its per-load receipt either way, because the
 * PAIRED_WITH_OUTCOME mapping below still delivers the 'lost' outcome with landedBids 0. What is
 * suppressed is only the duplicate ops fan-out: 56 symptom messages replaced by one cause message.
 *
 * 'last_resort_floor_fired' - every soft-close defend path held on the genuinely-last tick with the
 * reserved floor rung still unspent, so the engine released it rather than let the load close having
 * never been bid (bidEngine._lastResortFloor). It joined on 2026-08-01, and it is the FIRST member of
 * this set that is not a refusal - which is the point. It is a commercial decision the desk needs to
 * know about on the load's own thread: we just spent our lowest price on this load, and we spent it
 * because everything else was holding.
 *
 * It routes HERE rather than through ERROR_KINDS, and that is the whole of the change:
 *   - it is not an outage. Nothing failed, no read broke, no session died. Paging the on-call class
 *     for a bid the engine placed correctly is the noise that trains people to stop reading alerts -
 *     the same mistake 'ceiling_below_floor' made until it was moved off that channel.
 *   - it needs the customer's own group, not a fault DM. The desk is the audience: the load, the
 *     price, and what to do next. That requires the SCOPE KEYS (origin / shipper / branch) on the
 *     payload, which is exactly what this branch attaches and the error branch deliberately does not.
 * Its detail names our own floor price, which is why this channel and not a wider one: a "BRL Bids"
 * group is BRL staff only (waTemplates, staffRoster) and already carries cost, bid and margin per
 * load, so the number is at home there and nowhere else.
 *
 * Read it as SMOKE, not fire. It should be rare. Each occurrence means a load came within one tick of
 * being silently forfeited - the way three Havells Alwar loads were lost (Rs 1,25,000). If it starts
 * firing routinely, the upstream hold is the bug and this notice is only how you found out.
 */
// 'load_not_biddable' joined on 2026-08-01. SuperProcure refused the bid because the LOAD is not
// open to bidding - a per-load state at their end, proven persistent (14 such loads, not one ever
// landed a bid, retries minutes apart refused alike; see bidEngine.isLoadNotBiddableRejection). It
// belongs here rather than in ERROR_KINDS on the same two grounds ceiling_below_floor was moved for:
// there is no fault on our side to page anyone about and nothing an operator can restart or redeploy
// to fix it, and the desk DOES want to know - it is their load, and the one useful action ("check it
// on SuperProcure") is theirs. It also needs the scope keys a desk_notice payload carries and an
// error payload deliberately does not, or no customer group could ever match it.
//
// Ops is NOT left blind by that: the load still closes with zero landed bids, so _finalize's
// never_bid_before_close - an ERROR kind - still fires on it (ownBidAttempts is 1, not 0, so
// deliberateZeroBid stays false and the alarm is not suppressed). The split is deliberate: the desk
// gets the actionable notice the moment the platform says so, ops still gets the zero-bid alarm at
// close. Neither audience loses a message.
// The three quantity kinds belong here for a sharper version of the same reason: none is an ops
// fault and none has an ops remedy, so routing them to ops sends them to the one audience that
// cannot act. 'vehicle_count_refused' is the one refusal class the DESK CAN FIX - the remedy is a
// control they already have, lowering "how many trucks to bid for" on the price page. The other two
// report the desk's own commitment changing under them as the shipper partially allots: clamped =
// we bid for fewer trucks than they chose (still a bid, still winnable); no_quantity_remaining =
// nothing further is open. Scope keys ride each payload so they land in the customer's group.
// 'session_logged_out' is the only member whose CAUSE is account-wide rather than load-specific; it
// is here because the ACTION is per-load. Not an error for the same reason ceiling_below_floor is
// not - nothing is broken in the engine, and account_auth_dead already carries the paging half.
// 'reprice_unreachable_ladder': after a desk correction, no price the new band can build is below
// our own standing bid, so the engine has stood the load down. Registered so the notice can be
// built, but the server sends it only when the page that took the save did NOT show the hold
// (web/server.js unshownCorrectionHold, owner ruling 26 Sep): a hold the page showed is the page's,
// and one with no correction behind it is no hold at all.
//
// The raw `bid_rejected` event is deliberately NOT registered. It is per ATTEMPT: 42 on load
// 260908LD2Z alone and 10,563 all time. Routing it would swap this silence for the flood this file
// has twice been rewritten to remove. The engine's classified, once-per-load refusal is the
// consumer point; the per-attempt event stays a log line.
// 'bid_not_sent': a bid the engine decided on was refused before its request was issued (a GoComet
// quote read that failed or was throttled, a belt, a write gate), so nothing reached the portal and
// either the rung is held for a retry (once per load) or, when the refusal would repeat on every
// try, the load is stood down and the desk asked to bid it by hand (byHand). A desk notice rather
// than an error because nothing here pages anyone into a fix; ops still gets never_bid_before_close
// if the load closes empty.
// The two sets must stay disjoint: the desk branch is checked first, so a kind in both would
// silently never page.
// 'tick_fault_handoff': ticks kept faulting, so the engine stopped watching the load and the desk
// must bid it by hand. The desk group is the audience; ops gets the same fact through
// OPS_MIRRORED_NOTICES below, from this one event.
// 'bid_price_raise_refused': the portal will only take a price below a quote already standing on this
// login (GoComet's words) or at or below a cap (SuperProcure's number), and no price in our band is
// below it, so the load has stood down with no bid it can send. A no-bid outcome under the price-page
// gate, so the desk hears it now, once per load per round (260925SQRC, owner ruling 26 Sep).
const DESK_NOTICE_KINDS = new Set(['ceiling_below_floor', 'last_resort_floor_fired', 'load_not_biddable',
  'vehicle_count_refused', 'vehicle_count_clamped', 'no_quantity_remaining', 'session_logged_out',
  'reprice_unreachable_ladder', 'tick_fault_handoff', 'bid_not_sent', 'bid_price_raise_refused',
  // The refused-price hold: the engine stopped sending a price the portal refused (a known wall, or
  // wording no classifier knows). Told live so the desk can bid by hand, once per load per round.
  'refused_price_bound', 'refusal_unrecognised']);

// Desk notices ops must also see on the error channel. One engine event, two messages.
const OPS_MIRRORED_NOTICES = new Set(['tick_fault_handoff']);

// Notices that must still be delivered while the WhatsApp sender is down. desk_notice and error drop
// then, because a receipt at close repeats them; the hand-off stops the load, so no receipt follows
// and nothing re-sends it. They take the price ask's failover route instead (notifier._whatsapp).
const DELIVER_WHEN_SENDER_DOWN = new Set(['tick_fault_handoff']);

// A by-hand bid_not_sent (W1-8 F2) shares tick_fault_handoff's exact reason: the stand-down stops
// the load, so no later close receipt repeats the fact, and a copy dropped under a down sender is
// gone for good rather than merely late. The retry notice (byHand:false) is deliberately NOT here -
// the load keeps retrying, so its close receipt is still coming.
const deliverWhenSenderDown = (evt) => DELIVER_WHEN_SENDER_DOWN.has(evt.kind)
  || (evt.kind === 'bid_not_sent' && evt.byHand === true);

// The SCOPE-ROUTING keys of an auction's outcome message, off the engine event. Factored out so the
// auction_result notification and the paired-error's routing mirror below are built from one
// expression and cannot drift - the mirror is only useful if it resolves to the same recipients the
// outcome resolves to. These are exactly the keys scopeMatches reads for an outcome, so the mirror
// keeps reproducing the outcome's routing rather than "improving" on it.
//
// `branch` joined them on 2026-07-25. It was absent, and that absence was not harmless: a
// branch-scoped group never matched an outcome, so a branch-split load's won/lost landed in the
// customer's GENERAL group while its ask sat in the branch group - one load's lifecycle split
// across two groups. Blank-when-absent, so a load with no branch (and every customer with no
// branch group) matches exactly as it did before.
const outcomeScopeKeys = (evt) => ({
  origin: (evt.lane && evt.lane.origin) || '',
  shipper: evt.companyName || '',
  branch: evt.branchName || '',
});

// A customer's identity in a dedupe key: the shipper name as scope routing reads it (case- and
// spacing-blind), plus the branch when the load has one. Null when the load names no shipper, so a
// caller can fall back to a per-load key rather than fold unrelated loads together.
const normKeyPart = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const customerKey = (shipper, branch) => {
  const s = normKeyPart(shipper);
  if (!s) return null;
  const b = normKeyPart(branch);
  return b ? `${s}|${b}` : s;
};

/**
 * The participation fact for one close, from BOTH durable sources, taking the larger.
 *
 * `eventLanded` is the engine's own landedBids off auction_result - durable since it is persisted on
 * the bid intent and restored on re-arm. `rec` is the finalized closed-bids record, whose ourBids is
 * the array exportModel.deriveStatus classifies on. Reading both is what makes the WhatsApp template
 * and the funnel share one source of truth rather than merely agree today: the notify layer is
 * chained off bidLogger.handle (server.js), so by the time this runs the record has settled and
 * every earlier bid_placed write has committed through the logger's single serializing tail.
 *
 * MAX, not either alone, because the two can legitimately differ in one direction each and the safe
 * answer is always "something landed":
 *   - record > event: an intent written before landedBids was persisted, rehydrated mid-auction.
 *   - event > record: a transport throw whose read-back could not disprove the write committed - the
 *     engine counts it (money may be on the board) but no bid_placed was ever emitted, so ourBids
 *     stays empty. Shouting NO BID PLACED over a possibly-committed bid is the one unacceptable miss.
 * null in -> null out: an event with NO participation fact at all (pre-fix persisted event, mock
 * adapter, rate-model arm) must degrade to the previous templates, never to no_bid.
 */
function landedEvidence(eventLanded, rec) {
  if (eventLanded == null) return null;
  const fromEvent = Number(eventLanded);
  const fromRecord = rec && Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean).length : 0;
  return Math.max(Number.isFinite(fromEvent) ? fromEvent : 0, fromRecord);
}

// DELIBERATELY ABSENT from BOTH routing sets - two engine alert kinds. They are in neither
// ERROR_KINDS (which would push them onto WhatsApp as a fault, where the recipient set includes the
// client's director) nor DESK_NOTICE_KINDS (which would push them onto the customer's own group);
// whether an alert of this class should reach any recipient surface at all is an open product
// question and not a decision this map should make by default. Leave them out until that is settled.
//
// 'ladder_below_min_decrement' - a load's ladder has a rung the platform's minimum bid difference
//   would refuse. A pricing-CONFIGURATION mismatch a human fixes at their own pace (re-price the
//   load, or re-cut the band), not a live-money refusal in progress like the fail-closed kinds
//   above. Its detail string also embeds exact ladder prices, which is our own margin structure.
// 'blind_rank_hold' - the engine held rather than take a discretionary step-down, because our own
//   rank had not arrived yet. Emitted at most once per load (bidEngine._alertBlindRankHold), but it is the
//   NORMAL case on every soft-close auction, not a fault - so it is routine traffic by nature and
//   is exactly the kind of thing that must never become a recipient-facing message.
//
// NOT in this list, though it was until 2026-08-01: 'last_resort_floor_fired'. It reads like a
// sibling of 'blind_rank_hold' - same engine, adjacent code - but the two are opposites. A blind-rank
// hold is the normal case on every soft auction and spends nothing. A last-resort floor is rare and
// spends our lowest price on the load. That is a commercial fact with an audience, so it now routes
// as a desk notice; see DESK_NOTICE_KINDS above for the reasoning.
//
// Both of these stay engine-event + log only. Note what that means concretely, so nobody re-describes
// it as richer than it is: the emit reaches the /api/state `events` ring, and nothing renders that
// ring today (the React console's getState() has no call sites), so the log line is the channel an
// operator actually reads.

// The engine paces these per load itself (bidEngine _recordWriteFailed) and stamps each alert with
// its episode. Without it in the key, the mark a delivered first episode leaves would silently drop
// every later one on the same load.
// close_unknown_held and reprice_arm_failed carry an episode on the triggers that can recur for one
// load; a restart's close_unknown_held has none and keeps its per-load key.
const EPISODIC_ERROR_KINDS = new Set(['bid_record_failed', 'close_record_failed', 'round_record_failed',
  'close_unknown_held', 'reprice_arm_failed']);
const episodeSuffix = (evt) => (EPISODIC_ERROR_KINDS.has(evt.kind) && evt.episode != null ? `_${evt.episode}` : '');

function toNotification(evt) {
  if (!evt || !evt.type) return null;

  if (evt.type === 'auction_result') {
    // The SUBSCRIPTION kind stays binary (won/lost) on purpose: recipients enumerate kinds in their
    // own config, so a third kind would reach nobody until every record was migrated. A close with
    // ZERO LANDED bids is still routed as 'lost' - it is the same audience, the same scope match and
    // the same dedupe - but it carries landedBids so waTemplates.templateFor can render the no_bid
    // variant instead of telling the desk it lost an auction it never entered (load 23484018).
    const kind = evt.won ? 'won' : 'lost';
    // scope-routing key - single collapsed point (Notifier.scopeMatches reads this substring-wise).
    const { origin, shipper, branch } = outcomeScopeKeys(evt);
    // DISPLAYED From - every pickup point a multi-pickup load has (mirrors dropAddress for To,
    // and price_needed/confirmSubmitted's own from/route - a load's won/lost message must not
    // disagree with its own enquiry/submission messages about which points it picked up from).
    const from = pickupAddress(evt);
    const to = dropAddress(evt);
    return {
      // Keyed on the close, not on won/lost (T2 D6): a restart that re-arms a close whose record did not
      // save must not send a second receipt, and its second finalize can read another rank.
      kind, dedupeKey: evt.round && evt.finalCloseAt !== undefined
        ? `${evt.auctionId}:${evt.finalCloseAt}:${evt.round.rounds}` : `${evt.auctionId}_${kind}`,
      data: {
        // BRL enquiry-template fields (money detail is layered on by outcomeEnrichment).
        oaNo: evt.auctionId, from, to,
        vehicleType: fmtVehicle(evt.equipment, evt.units),
        finalRank: evt.finalRank,
        // origin/dest are the portal's RAW lane strings. On SuperProcure that is a city; on GoComet
        // it is the whole postal address, which is why the lost header reads laneFrom/laneTo
        // (threaded in notifyEngineEvent) in preference and keeps these only as its fallback.
        origin, dest: (evt.lane && evt.lane.destination) || '', shipper, auctionId: evt.auctionId,
        // The shipper's OWN reference for this enquiry (GoComet's enquiry.name) - the number the
        // desk and the customer both work by, as against auctionId which is the portal's key.
        // Carried from the load snapshot along monitor.meta, exactly like poster/branchName, so the
        // loss reply can name it. Rendered VERBATIM (oaLine): real values include
        // "3262511465-5601270693 (E.com)", so nothing splits or extracts it. null on SuperProcure,
        // which publishes no such field, and on every pre-fix persisted intent.
        shipperRef: evt.shipperRef || null,
        // routing key for a branch-scoped group - keeps the outcome in the SAME group the ask
        // anchored on. Blank when the load carries no branch (then no branch group can match it).
        branch,
        // Participation fact: bids that actually reached the board (rejections excluded), from the
        // engine's _finalize. null/absent on a pre-fix or mock event -> templateFor degrades to the
        // previous templates, so nothing changes for anything that does not carry it.
        landedBids: evt.landedBids != null ? evt.landedBids : null,
        unconfirmedCount: (evt.gcUnconfirmedSubmissions || []).length,
        // The engine finalized without the portal confirming the result (won null). Routed under the
        // 'lost' subscription like no_bid, and templateFor renders it as not yet known, never a loss.
        resultUnknown: evt.won === null,
        resultBasis: evt.resultBasis,
        resultObservedRank: evt.resultObservedRank,
        resultTab: evt.resultTab,
        resultVerifiedAt: evt.resultVerifiedAt,
        awardConfirmed: evt.awardConfirmed,
        // {name, mobile, createdBy} | null - who posted the load on the shipper's side. The WON
        // template renders it (waTemplates.posterContact) so the desk knows who to ring to place the
        // vehicle; the lost/no_bid templates deliberately ignore it (nothing to coordinate on a load
        // we did not win). Carried on BOTH kinds regardless because the KIND is decided above and
        // this data object is shared - the template, not the router, is what selects it. DISPLAY-ONLY:
        // it sits alongside the scope keys but scopeMatches never reads it. null on a mock/sim event
        // and on any load whose poster the adapter's guards rejected.
        poster: evt.poster || null,
        // WHY nothing was bid, when nothing was - a refusal we RECORDED at the moment we took it
        // (_recordRefusal), carried here so the no-bid receipt states the reason in the SAME message
        // as the outcome. The reason was always known; it was simply sent as a separate alert with
        // nothing joining the two, which is how a correct, intentional decision reached the client's
        // Director as an unexplained "NO BID PLACED" (SIKA 23534893, 2026-07-27).
        //
        // ABSENT is a real and common state (a pre-fix persisted event, a mock adapter, a close whose
        // refusal nobody recorded) and it MUST degrade to the previous wording. waTemplates.noBidWhy
        // owns that fallback; nothing here invents a reason it was not given.
        noBidReason: evt.noBidReason || null,
        noBidCeiling: evt.noBidCeiling != null ? evt.noBidCeiling : null,
        // The operating floor the ceiling was compared against. Absent on every pre-fix persisted
        // event, so noBidWhy must degrade without it - see the two-case split there.
        noBidFloor: evt.noBidFloor != null ? evt.noBidFloor : null,
        // The vehicle count sent on a vehicle_count_refused close. Absent on every other reason and
        // on every pre-fix persisted event; noBidWhy omits the number rather than defaulting it.
        noBidVcqSent: evt.noBidVcqSent != null ? evt.noBidVcqSent : null,
        // The cap the portal named on a price_raise_refused close. Distinct from noBidCeiling, which
        // is the SHIPPER's ceiling - on the SuperProcure form this number is usually our own standing
        // bid minus the branch decrement. Absent on every other reason; noBidWhy drops the clause
        // rather than printing a figure it was not given.
        noBidAmountCap: evt.noBidAmountCap != null ? evt.noBidAmountCap : null,
        // How many writes one price was allowed before the refused-price hold took it. The receipt's
        // refused_price_bound / refusal_unrecognised wording turns on it: a bound of 1 means the price
        // went out once and was never re-sent. Absent on every other reason and on every pre-fix
        // persisted event; noBidWhy drops the clause rather than assuming a count.
        noBidBound: evt.noBidBound != null ? evt.noBidBound : null,
        // Only on a result the engine stamped with them, so a result recorded before they existed
        // renders exactly as it always did.
        ...(hasResultFacts(evt) ? {
          resultFacts: true,
          attemptsAllowed: evt.attemptsAllowed != null ? evt.attemptsAllowed : null,
          extensionsAfterLastBid: evt.extensionsAfterLastBid != null ? evt.extensionsAfterLastBid : null,
          postedCloseAt: evt.postedCloseAt != null ? evt.postedCloseAt : null,
          finalCloseUnknown: evt.finalCloseUnknown === true,
          lastBidBeforeTriggerWindow: evt.lastBidBeforeTriggerWindow === true,
          finalCloseAt: evt.finalCloseAt != null ? evt.finalCloseAt : null,
          // Ruling 86-b: the OBSERVED close-type line (waTemplates.closeTypeLine) - what the round
          // tracker actually saw on this load (round.rounds/round.cap), plus the close model that
          // picks its wording (hard/soft/gocomet). Absent on a pre-fix persisted event, same as
          // every field above; closeTypeLine degrades to no line at all rather than guessing.
          round: evt.round || null,
          closeModel: evt.closeModel || null,
        } : {}),
      },
    };
  }

  if (evt.type === 'bid_placed') {
    // rungIndex rides through so the notifier can route it: the ESTABLISHING rung (0) is the DM
    // "first bid" ping AND the first line of the group's bid log; every LATER rung (step-downs on a
    // descending ladder / a soft-close snipe) appends another line to that ONE group bubble and is
    // NOT re-sent to DMs (notifier._whatsapp). The dedupeKey is per-rung so those later appends are
    // not swallowed as duplicates of the first. `rank` is the LIVE SOCKET rank we held when we fired
    // (evt.socketRank - the REST `rank` is null on every SP response), shown on the bid-log line.
    // cost + openingPct (the band's top margin) still ride so the DM first-bid message can frame the
    // opening against the operator's number; both null on a rate-model/mock arm, and it falls back.
    return {
      kind: 'bid_live', dedupeKey: `${evt.auctionId}_bid_live_${evt.rungIndex != null ? evt.rungIndex : 'x'}`,
      data: { lane: laneStr(evt.lane), origin: (evt.lane && evt.lane.origin) || '', shipper: evt.companyName || '', price: evt.price, auctionId: evt.auctionId,
        // ROUTING key for a branch-scoped group. Without it this alert resolves to the customer's
        // GENERAL group, where the load has no ask thread, so _deliverGroup skips it and (on a
        // step-down rung, which strips the DM fallback) the alert reaches NOBODY - the 2026-07-25
        // Havells Alwar blackout. Blank when absent, matching price_needed/price_submitted.
        branch: evt.branchName || '',
        cost: evt.cost != null ? evt.cost : null, openingPct: evt.openingPct != null ? evt.openingPct : null,
        // The desk's own rates, where it priced each truck type. Without these the alert states the
        // blended mean under the words "your rate" (bidLiveDetail) - the CW-213 figure, on the louder
        // of the two messages. `match` is dropped: it is the adapter's freight-line join key and has
        // no business in a message payload. Null/absent on a single-type load -> unchanged copy.
        rateByType: Array.isArray(evt.costByType && evt.costByType.types)
          ? evt.costByType.types.map((t) => ({ label: t.label, count: t.count, cost: t.cost }))
          : null,
        rungIndex: evt.rungIndex != null ? evt.rungIndex : null, rank: evt.socketRank != null ? evt.socketRank : null,
        // Whether this write is the load's ESTABLISHING bid, carried because rungIndex alone cannot
        // say: a bid banked after its monitor was retired drops the index (the ladder it counted
        // against is gone) and Number(null) reads as rung 0 in the notifier's DM filter. Every
        // ordinary rung leaves it true and routes exactly as before.
        establishing: evt.establishing !== false },
    };
  }

  if (evt.type === 'alert') {
    if (evt.kind === 'outranked') {
      return {
        kind: 'outbid', dedupeKey: `${evt.auctionId}_outbid`,
        // `branch` routes this to the branch-scoped group when the load has one (same key, same
        // blank-when-absent convention as bid_live above).
        data: { lane: laneStr(evt.lane), origin: (evt.lane && evt.lane.origin) || '', shipper: evt.companyName || '', branch: evt.branchName || '', rank: evt.rank, auctionId: evt.auctionId },
      };
    }
    // NON-PAGING desk notice (see DESK_NOTICE_KINDS). Checked BEFORE the error branch so a kind can
    // never be both - the two sets are disjoint by construction and this ordering keeps it that way
    // even if someone later adds a kind to both.
    if (DESK_NOTICE_KINDS.has(evt.kind)) {
      const { origin, shipper, branch } = outcomeScopeKeys(evt);
      // The count is part of the key on the two kinds here that are DESIGNED to fire more than once
      // on a load: the shipper can allot twice, so the engine bids - or is refused at - a lower count
      // each time, and a kind-only key would let the notifier swallow the follow-up and leave the
      // desk holding the first number. Each keys on the count that identifies its own event: what is
      // still open for a clamp, what went on the wire for a refusal.
      let countKey = '';
      if (evt.kind === 'vehicle_count_clamped' && evt.remaining != null) countKey = `_${evt.remaining}`;
      else if (evt.kind === 'vehicle_count_refused' && evt.vcqSent != null) countKey = `_${evt.vcqSent}`;
      // Same mechanism, different identity: session_logged_out can legitimately fire twice on one
      // load because the OUTAGE is what repeats, not the load. The sent-mark is a permanent store
      // document with no TTL, so without the episode start a load reaching a second outage is
      // silently swallowed. authAlert.js keys sp_auth_dead the same way and for the same reason.
      //
      // THREE KEYS PER (LOAD, EPISODE) AND NO MORE, one per thing the copy can say: we are not
      // bidding it (held), our bid stands and cannot be improved (standing), the login is back
      // (clear). The episode alone is not enough - a trial write landing mid-episode flips the copy
      // from held to standing under an identical key, and the notifier drops the correction, leaving
      // the desk hand-bidding a load we already hold against the shared per-load cap.
      //
      // The standing token is a BOOLEAN off landedBids, NEVER the count. A count mints a fresh key
      // per landed bid, which turns one correction into a message per rung.
      //
      // The HELD key keeps the empty-string token so it stays byte-identical to the literal this
      // line produced before the split. That buys nothing on this first deploy - no held key has
      // been minted under the new code yet - but it is what stops a load already notified across a
      // restart from being told the same thing twice under a renamed key, and it costs one branch.
      else if (evt.kind === 'session_logged_out' && evt.authSince != null) {
        countKey = `_${evt.authSince}${evt.authCleared ? '_clear' : (evt.landedBids > 0 ? '_standing' : '')}`;
      }
      // The STANDING BID identifies this notice, not the load: the engine latches the alert per
      // MONITOR and a re-price builds a new one, so a load re-priced twice into unreachability
      // emits twice. Both messages state the same fact about the same standing price, so a
      // load-only key correctly swallows the repeat - but if a bid does land in between, the price
      // the desk is being told about has changed and the correction must not be swallowed as a
      // duplicate of the number it replaces.
      else if (evt.kind === 'reprice_unreachable_ladder' && evt.standingBidPrice != null) {
        countKey = `_${evt.standingBidPrice}`;
      }
      // A re-priced load can be handed off again by a later monitor; that is a new message.
      else if (evt.kind === 'tick_fault_handoff' && evt.faultSince != null) countKey = `_${evt.faultSince}`;
      // A retry notice and the hand-off that may follow it on the same load say different things,
      // so the second must not be swallowed as a duplicate of the first. Keyed on the stand-down
      // instant, not just the load: a re-price stops the monitor and rebuilds a new one, and if the
      // rebuilt monitor stands down again on the same refusal that is a second stand-down the desk
      // has to be told about, not a duplicate of the first. Falls back to the load-only key when the
      // event carries no stamp (a pre-fix persisted event), unchanged from before this field existed.
      else if (evt.kind === 'bid_not_sent' && evt.byHand) {
        countKey = evt.standDownAt != null ? `_by_hand_${evt.standDownAt}` : '_by_hand';
      }
      // The early "still watching" notice and a later refusal of the same load say opposite things.
      else if (evt.kind === 'load_not_biddable' && evt.stillWatching === true) countKey = '_watching';
      // Once per load per ROUND: an extension clears the stand-down and the engine re-derives it.
      else if (evt.kind === 'bid_price_raise_refused') countKey = `_r${evt.round != null ? evt.round : 0}`;
      // The held price joins the key: after a desk re-price a hold at the new floor in the same round
      // is a new message, not a duplicate of the first (as reprice_unreachable_ladder keys on its price).
      else if (evt.kind === 'refused_price_bound' || evt.kind === 'refusal_unrecognised') {
        countKey = `_r${evt.round != null ? evt.round : 0}_${evt.price != null ? evt.price : ''}`;
      }
      // ONE NOTICE PER RATE-LIMIT COOLDOWN PER CUSTOMER PER PLANT (ruling 58). A GoComet cooldown is
      // adapter-wide, so it refuses every load it holds off at once, and a per-load key sends one
      // customer's group the same "Bid not sent" once per load. Keyed instead on the customer, the
      // load's origin plant and the cooldown's identity (the engine carries it as rateLimitEpisode):
      // the first load of a customer AT A GIVEN PLANT refused in a cooldown is the one named, the
      // rest of that plant's loads in the same cooldown are covered by it, another plant of the same
      // customer gets its own message, another customer's load gets its own message, and a later
      // cooldown tells the desk again. The branch is part of the customer: a branch-scoped group is a
      // different audience (branchRouting). Only the retry notice: a hand-off is always per load.
      // No customer on the load, or no episode on the event, keeps the per-load key - a notice sent
      // twice is the safe side of that trade, one never sent is not.
      //
      // The origin joins the key because a real customer's groups can be split BY PLANT, not just by
      // customer - the 2026-09-24 Waaree snapshot has three GoComet groups (main, Samakhiyali, Noida),
      // each scoped to its own origins. A per-customer-only key is written by whichever plant's load
      // is routed first, and every other plant's group hears nothing for the rest of the cooldown -
      // a silent miss on an audience that exists on the box today. The cost is the over-notify side:
      // a group scoped to many plants (the main Waaree group covers 11) can get one message per plant
      // per cooldown instead of one for the whole cooldown, which is still "one notice per 429
      // cooldown" per audience.
      let keyOwner = evt.auctionId || 'global';
      if (evt.kind === 'bid_not_sent' && !evt.byHand && evt.rateLimitEpisode != null) {
        const customer = customerKey(shipper, branch);
        if (customer) {
          keyOwner = `customer_${customer}|o:${normKeyPart(origin)}`;
          countKey = `_rl_${evt.rateLimitEpisode}`;
        }
      }
      return {
        kind: 'desk_notice', dedupeKey: `${keyOwner}_notice_${evt.kind}${countKey}`,
        // These sit at the TOP of `data` on purpose - the exact opposite of the error branch below.
        // scopeMatches reads them, which is the whole point: this notice is FOR the customer's group,
        // so it must resolve to the same recipients that customer's other per-load messages do. The
        // keys are built from outcomeScopeKeys, the same expression the outcome uses, so a notice and
        // the load's eventual won/lost/no-bid receipt can never route to different groups.
        data: { origin, shipper, branch, dest: (evt.lane && evt.lane.destination) || '',
          lane: laneStr(evt.lane), auctionId: evt.auctionId, oaNo: evt.auctionId,
          reason: evt.kind,
          ceiling: evt.ceiling != null ? evt.ceiling : null,
          floor: evt.floor != null ? evt.floor : null,
          // The entered cost, present only on 'ceiling_below_floor' - lets that notice name the
          // rupee exposure (cost vs ceiling) instead of leaving the desk to subtract the two figures
          // above themselves.
          cost: evt.cost != null ? evt.cost : null,
          // What this load already has on the portal. It is the comparand that makes the refusal
          // legible - the floor alone says nothing about why it cannot be sent - and on
          // 'reprice_unreachable_ladder' its presence is also what proves a bid is standing, since
          // that alert carries no landedBids count for bidIsStanding to read.
          standingBidPrice: evt.standingBidPrice != null ? evt.standingBidPrice : null,
          // The price that did not go out, on 'bid_not_sent'. Null on every other kind.
          price: evt.kind === 'bid_not_sent' && evt.price != null ? evt.price : null,
          // On 'bid_price_raise_refused': SuperProcure's stated cap, or GoComet's quote standing on the
          // login that every price must go below. Null on every other kind.
          amountCap: evt.kind === 'bid_price_raise_refused' && evt.amountCap != null ? evt.amountCap : null,
          standingQuote: evt.kind === 'bid_price_raise_refused' && evt.standingQuote != null ? evt.standingQuote : null,
          // The portal's own refusal on the refused-price hold, shown cut short. Null on every other kind.
          refusal: (evt.kind === 'refused_price_bound' || evt.kind === 'refusal_unrecognised') && evt.refusal ? String(evt.refusal) : null,
          // On 'bid_not_sent': the load was stood down and the desk must bid it by hand.
          byHand: evt.kind === 'bid_not_sent' ? !!evt.byHand : null,
          // The desk's own corrected rate on 'reprice_unreachable_ladder' - the redesigned copy's
          // figure, not the derived floor. Set by feat/reprice-record-and-hold; absent on #219 alone.
          correctedCost: evt.correctedCost != null ? evt.correctedCost : null,
          // The quantity vocabulary, shared by all three quantity notices: what went on the wire
          // (vcqSent, absent when nothing did), what the desk committed to (want), what SuperProcure
          // still has left (remaining), and the load's original requirement (units). Null on every
          // kind that is not a quantity notice, and the templates omit a number rather than
          // inventing one - a desk notice never prints a count it did not receive.
          vcqSent: evt.vcqSent != null ? evt.vcqSent : null,
          units: evt.units != null ? evt.units : null,
          want: evt.want != null ? evt.want : null,
          remaining: evt.remaining != null ? evt.remaining : null,
          // Whether one of our bids is already standing on this load. Decides the copy on
          // 'no_quantity_remaining': remaining hits zero because the shipper allotted, and the
          // allotment may be ours, so "No bid was placed" is false whenever this is above zero.
          landedBids: evt.landedBids != null ? evt.landedBids : null,
          // Our position on the load at the moment of the notice. It was received and stored all
          // along - finalRank 9 sat in closedBids and socketRank 9 on the bids themselves - and was
          // dropped right here, so the one message telling the desk we had spent our last price
          // could not say where that price left us. Null when the platform never sent a rank; a
          // desk notice states a position it was given or none at all.
          myRank: evt.myRank != null ? evt.myRank : null,
          // Flips session_logged_out from the open-time instruction to its retraction. It selects the
          // copy as well as the key, so the two can never disagree about which message this is.
          authCleared: evt.authCleared === true,
          // The close time of the load the desk is being asked to bid by hand, so the instruction
          // names its own expiry instead of standing until somebody retracts it.
          closesAt: evt.closesAt != null ? evt.closesAt : null,
          // True only on _checkDelisted's inference-off-a-stale-listing emit, never on a real
          // platform refusal of this same kind - lets the 'load_not_biddable' copy tell the two apart
          // without a second kind or a routing change.
          stillWatching: evt.stillWatching === true,
          detail: evt.detail || evt.reason || evt.kind },
      };
    }
    if (ERROR_KINDS.has(evt.kind)) {
      const lane = laneStr(evt.lane);
      const pairedKind = PAIRED_WITH_OUTCOME.get(evt.kind);
      // A kill naming folded loads is their only announcement; on the shared kill key the sent-mark
      // of any earlier kill, or of another engine stopped by the same tap, would swallow it.
      const foldKey = evt.kind === 'killed' && evt.foldedFirstId != null ? `_${evt.foldedFirstId}` : '';
      const runKey = RUN_KEYED_ERRORS.has(evt.kind) && evt.faultSince != null ? `_${evt.faultSince}` : '';
      return {
        kind: 'error', dedupeKey: `${evt.auctionId || 'global'}_error_${evt.kind}${episodeSuffix(evt)}${runKey}${foldKey}`,
        data: { context: lane !== '?' ? lane : (evt.auctionId || 'bidder'), detail: evt.detail || evt.reason || evt.kind, auctionId: evt.auctionId,
          // See PAIRED_WITH_OUTCOME. never_bid_before_close is emitted in the SAME _finalize as the
          // auction_result whose no-participation outcome states the same fact with far more context,
          // so anyone who receives both would get two messages about one close, seconds apart.
          //
          // NESTED on purpose. These are the paired OUTCOME's routing keys, handed to the Notifier so
          // it can resolve who that outcome actually reaches. They must NOT sit at the top of `data`,
          // where scopeMatches would read them and start matching shipper-scoped groups against the
          // ERROR alert itself - that is a different, unrequested routing change. Here they are inert
          // to the error's own matching and used only to compute the suppression set.
          pairedWithOutcome: pairedKind ? { kind: pairedKind, data: outcomeScopeKeys(evt) } : undefined },
      };
    }
  }

  return null;
}

/**
 * Our-side money detail for a won/lost alert, from the finalized closed-bids record.
 * Fills BRL's template fields from what WE actually have:
 *   marketRate     = the cost that priced our last bid  (the "Your Rate" anchor on won/lost)
 *   marginRate     = the margin-added rate we placed     ("Our Bid", lost)
 *   marginPct      = our bid over that cost, 2dp, signed (rendered inline on the bid line)
 *   attempts       = bids we made
 *   closeTime      = when the auction ended
 *   vehicleType/from/to/finalRank = refined from the fuller record (units, full drop addr)
 * The competitor "won rate" (clearing price) is NOT here - masked on rank-only loads
 * (+60k winning-engine slice) - so the won template's Won Rate stays blank and its inline margin
 * reports our-over-cost margin, which is the number we can stand behind.
 */
function outcomeEnrichment(rec) {
  if (!rec) return {};
  const band = bidTimeBand(rec);
  const cost = resolveBidTimeCost(rec);
  // T6 BH-BOUNDARY-7: a non-numeric lastBidPrice (persisted junk, a hand-edited record) made
  // Number(...) NaN, which `!= null` does not catch - NaN then survived into the inline
  // marginPct arithmetic below (never routed through fmtNum/fmtPct, which both guard it) and
  // printed the literal string "NaN" into "Margin low - only NaN%". Number.isFinite here makes an
  // unreadable lastBidPrice degrade to "unknown" (marginRate/marginPct both absent), matching
  // fmtNum's own rule: never render NaN/Infinity, drop the figure instead.
  const ourRateNum = rec.lastBidPrice != null ? Number(rec.lastBidPrice) : NaN;
  const ourRate = Number.isFinite(ourRateNum) ? ourRateNum : null;
  const bidCount = Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean).length : null;
  const out = {};
  out.unconfirmedCount = (rec.gcUnconfirmedSubmissions || []).length;
  out.accountQuote = (rec.gcUnconfirmedSubmissions || []).map(r => r.accountQuoteVerified).filter(Boolean).slice(-1)[0] || null;
  // Owner ruling (26 Sep 2026): the LOST receipt names its failure point off THIS classifier
  // (reportedClose.resultReasonOf, stamped onto the record by bidLogger) - never a second,
  // independently-derived guess. null when the record predates the field or resultReasonOf could
  // not settle a reason (both read the same as "say nothing new").
  if (rec.resultReason) out.resultReason = rec.resultReason;
  if (rec.equipment) out.vehicleType = fmtVehicle(rec.equipment, rec.units);
  const to = dropAddress(rec);
  if (to) out.to = to;
  if (rec.lane && rec.lane.origin) {
    out.origin = rec.lane.origin;   // scope-routing key - single collapsed point
    out.from = pickupAddress(rec);  // DISPLAYED From - every pickup point, mirrors dropAddress
  }
  // dest = the short destination lane city, refined from the record to mirror origin (the lost
  // header pairs origin -> dest for its preview line). won carries it too but never renders it.
  if (rec.lane && rec.lane.destination) out.dest = rec.lane.destination;
  if (rec.finalRank != null) out.finalRank = rec.finalRank;
  if (cost != null) out.marketRate = fmtNum(cost);
  if (ourRate != null) out.marginRate = fmtNum(ourRate);
  // On a WIN we are rank 1, so the winning rate IS our own placed bid (not the masked
  // competitor clearing price). Only populate on a win - on a loss the winner is someone
  // else and their amount is masked by SP (that stays the +60k winning-engine slice).
  if (rec.won && ourRate != null) out.wonRate = fmtNum(ourRate);
  if (bidCount != null) out.attempts = bidCount;
  if (cost != null && cost > 0 && ourRate != null) out.marginPct = (((ourRate - cost) / cost) * 100).toFixed(2);
  // The same position in rupees, off the same two numbers marginPct just used, so it lands on every
  // row that can report a margin at all - including the ~3,136 carrying no bid-time snapshot and any
  // rate-model arm, where the block below (gated on `band`) cannot fire. wonWarning prints this
  // INSTEAD of telling a below-cost win to bid lower. Wins only: a loss commits nothing.
  //
  // An anchored row is on the cost that priced the bid, and the floor invariant (assertAboveFloor)
  // keeps a placed price at or above that cost, so this can only fire here on a row with NO
  // snapshot and no correction anchoring the standing bid (`cost` fell back to the doc-level
  // figure, which the desk may have moved upward after the historical bid with nothing to prove it).
  if (rec.won === true && cost != null && cost > 0 && ourRate != null && ourRate < cost) {
    out.belowRateBy = fmtNum(cost - ourRate);
  }
  // the band's minimum-margin floor, so the won template can nag only when we barely squeezed in.
  // Whichever epoch the cost came from, the floor comes from the same one - never a mix. When the
  // bid carries a band but no floor (nothing writes that pair today) the field is omitted rather
  // than filled from the doc, so wonWarning falls back to its own default instead of judging a
  // bid-time margin against a corrected floor.
  if (band) { if (band.minMarginPct != null) out.minMarginPct = band.minMarginPct; }
  else if (rec.minMarginPct != null) out.minMarginPct = Number(rec.minMarginPct);
  // The lowest band margin, from the same epoch as the floor above. A snapshot written before the
  // field existed leaves it out, and wonWarning falls back to the minimum as before.
  if (band) { if (band.lowestMarginPct != null) out.lowestMarginPct = band.lowestMarginPct; }
  else if (Array.isArray(rec.marginsPct)) {
    const ms = rec.marginsPct.map(Number).filter(Number.isFinite);
    if (ms.length) out.lowestMarginPct = Math.min(...ms);
  }
  // HOW THE RATE GOT HERE, and WHERE THE LOAD STANDS NOW - both derived from comparing the
  // bid-time snapshot against the doc's current cost. marginPct answers "was this bid priced right
  // when it went out"; these answer "and has the desk moved the goalposts since". Plain info, no
  // glyph (owner, 2026-09-11 F-C): the desk correcting a rate is the system working, and it rides on
  // a loss as well as a win, because the rate moved there for the same reason.
  //
  // Gated on the resolved anchor rather than the snapshot alone: a pre-snapshot row whose cost
  // correction is on record has a "from" figure too, and suppressing its escalation is what made a
  // profitable win read as a loss with no headline. A row with neither anchor resolves `cost` TO
  // `costNow`, so the inequality below still keeps it out - it cannot evidence a drift.
  {
    const costNow = rec.cost != null ? Number(rec.cost) : null;
    if (cost != null && Number.isFinite(costNow) && costNow > 0 && costNow !== cost) {
      out.rateChangedFrom = fmtNum(cost);
      out.rateChangedTo = fmtNum(costNow);
      // WIN ONLY, and only when the corrected rate now sits ABOVE what we won at: the factual
      // rupee consequence, restored per the owner's 2026-09-11 ruling - a rupee gap, never a
      // second (negative) percentage. wonWarning suppresses its own "place at a lower rate" nag
      // whenever this is set - that advice is impossible after close and self-harming besides.
      if (rec.won === true && ourRate != null && ourRate < costNow) {
        out.costCorrectedTo = fmtNum(costNow);
        out.belowCostBy = fmtNum(costNow - ourRate);
      }
    }
  }
  const lastBid = lastPlacedBid(rec);
  // Through the SHARED resolver, which the History/outcomes export calls too - the two surfaces
  // state a close time for the same load and must not each decide what it is.
  const closeAt = reportedCloseAt(rec);
  if (closeAt != null) out.closeTime = fmtDMY(closeAt);
  if (lastBid && lastBid.ts != null) out.lastBidTime = fmtClock(lastBid.ts);
  // The gap, ONLY when the bid's countdown and the reported close describe the same deadline.
  // lastBid.closesInMs was measured against the close in force when that bid fired; closeAt is the
  // close after every later extension. On a load that extended after our last bid those are two
  // different deadlines, and printing one as the gap to the other says "2s before close" on a load
  // where nothing of ours fired in the final round - the desk's reported failure rendered as its
  // opposite. The record stores each bid's own believed close (budgetContext), so the two are
  // comparable: emit the lead only when they agree, and otherwise let the line carry the close and
  // the bid time alone rather than a number measured against a deadline that no longer exists.
  if (lastBid && lastBid.closesInMs != null && closeMatchesBid(closeAt, lastBid)) {
    out.lastBidLeadMs = Number(lastBid.closesInMs);
  }
  if (hasResultFacts(rec)) {
    out.closeAtMs = closeAt;
    out.refusedAttempts = Array.isArray(rec.rejectedBids) ? rec.rejectedBids.filter(Boolean).length : 0;
    out.earlyCloseAtMs = earlyPortalCloseAt(rec);
    if (lastBid && lastBid.ts != null) {
      const gaps = bidGapsMs(lastBid, rec.finalCloseAt);
      out.lastBidTs = Number(lastBid.ts);
      out.lastBidGapMs = gaps.toFinalMs;
      out.lastBidRoundGapMs = gaps.landingMs;
      out.lastBidAtLowestMargin = rec.won !== true && lastBidAtLowestMargin(rec) === true;
    }
  }
  return out;
}

// How far apart two close readings may be and still count as the same deadline. One second covers
// GoComet's minute-truncated publication and ordinary rounding; anything wider is a real extension.
const CLOSE_AGREEMENT_MS = 1000;

/** Whether `closeAt` is the same deadline the bid's stored countdown was measured against. */
function closeMatchesBid(closeAt, lastBid) {
  if (closeAt == null) return false;
  const believed = lastBid.believedCloseAt != null ? Number(lastBid.believedCloseAt) : null;
  // A bid recorded before per-bid believedCloseAt existed cannot be compared. Treat it as
  // unmatched: an omitted gap costs the desk a detail, a wrong one costs them the judgement.
  if (believed == null || !Number.isFinite(believed)) return false;
  return Math.abs(Number(closeAt) - believed) <= CLOSE_AGREEMENT_MS;
}

/**
 * Fire-and-forget routing from the engine's onEvent. Never throws (Notifier swallows
 * send errors). `account` ({accountId, label} | null) tags the payload with the owning
 * SP account; it is only ever set when more than one account runs, so single-account
 * messages stay byte-identical (no label noise).
 *
 * `getRecord` (optional) is an async lookup of the closed-bids record by auctionId,
 * used to enrich won/lost with our-side money detail. The caller MUST invoke this only
 * after the bid-logger has finalized that record (chain it off bidLogger.handle) so the
 * lookup reads a complete record race-free. Enrichment is best-effort: a miss or a throw
 * degrades to the lean message, never blocks the alert.
 *
 * `platformKey` is which PORTAL the emitting engine belongs to, and it is what lets the Notifier
 * resolve the channel per record (notifyModeFor) instead of off a global. It comes from the STACK
 * rather than the event because only a handful of the engine's ~30 emit sites carry the tag, while
 * a stack is per-portal by construction - so threading it at the router covers every alert kind
 * uniformly. The event's own `platformKey` is the fallback for a caller that threads nothing.
 * Neither present -> the field is left OFF the payload entirely, which reads as SuperProcure
 * downstream and keeps every existing payload byte-identical.
 */
// bid_live deliveries still in flight, per notifier and load. The last-resort notice for the same bid
// is emitted a few ms after its bid_placed and must see the bubble write that bid made, or it cannot
// fold into it and the desk gets two messages about one bid.
const bidLiveInFlight = new WeakMap();

async function notifyEngineEvent(notifier, evt, account = null, getRecord = null, platformKey = null) {
  const n = toNotification(evt);
  if (!n) return;
  if (!bidLiveInFlight.has(notifier)) bidLiveInFlight.set(notifier, new Map());
  const inFlight = bidLiveInFlight.get(notifier);
  const loadKey = evt.auctionId != null ? String(evt.auctionId) : null;
  if (n.kind === 'bid_live' && loadKey != null) {
    let release;
    const done = new Promise((r) => { release = r; });
    inFlight.set(loadKey, done);
    try { return await deliverEngineNotification(notifier, evt, n, account, getRecord, platformKey); }
    finally { release(); if (inFlight.get(loadKey) === done) inFlight.delete(loadKey); }
  }
  if (n.kind === 'desk_notice' && evt.kind === 'last_resort_floor_fired' && loadKey != null && inFlight.has(loadKey)) {
    await inFlight.get(loadKey);
  }
  return deliverEngineNotification(notifier, evt, n, account, getRecord, platformKey);
}

async function deliverEngineNotification(notifier, evt, n, account, getRecord, platformKey) {
  const platform = platformKey || evt.platformKey || null;
  if (platform) n.data.platformKey = platform;
  // The lane's two ends written the way every other surface writes them - "<city> <pin>", via
  // waTemplates.laneEnds -> web/laneDisplay. Resolved HERE rather than in toNotification because
  // laneEnds needs the portal to decide whether a GoComet address needs the serve-time parse, and
  // the portal is known only once the stack has been threaded (see the platformKey note above).
  // won ignores these; the lost/no-bid headers read them, and so does the reprice hold notice, whose
  // route line was still rendering the raw lane - two full postal addresses on GoComet.
  if (n.kind === 'won' || n.kind === 'lost'
    || (n.kind === 'desk_notice' && (evt.kind === 'reprice_unreachable_ladder' || evt.kind === 'tick_fault_handoff'))) {
    // The cells resolved at ARM off the whole load snapshot, which is the same object and the same
    // call the ask rendered through - so the two agree by construction.
    //
    // Re-resolving from `evt` is the fallback for an intent armed before the cells were carried
    // (a GoComet auction still open across the deploy that ships them) and for a rate-model outcome
    // with no request behind it. It is NOT equivalent: it cannot see the shipper note, and on
    // GoComet it re-parses the lane strings with no zip hint, so it can name a pin a few digits off
    // the one the ask showed. Closing that would mean putting laneParsed on the intent, which
    // gocometLane.js rules out. Narrow and transitional - the next arm resolves cells again.
    const lane = (evt.laneCells && (evt.laneCells.from || evt.laneCells.to))
      ? evt.laneCells
      : laneEnds(evt, platform);
    if (lane.from) n.data.laneFrom = lane.from;
    if (lane.to) n.data.laneTo = lane.to;
  }
  if (account && account.label) {
    n.data.accountId = account.accountId;
    n.data.accountLabel = account.label;
  }
  if ((n.kind === 'won' || n.kind === 'lost') && typeof getRecord === 'function' && evt.auctionId != null) {
    try {
      const rec = await getRecord(evt.auctionId);
      Object.assign(n.data, outcomeEnrichment(rec));
      // SECOND, INDEPENDENT read of the participation fact - the durable closed-bids record, which is
      // the same array exportModel.deriveStatus classifies on. Applied AFTER the enrichment assign so
      // it is the last word on landedBids, and only when a record was actually loaded (a miss leaves
      // the engine's own durable count untouched). See landedEvidence for why it takes the max.
      if (rec) n.data.landedBids = landedEvidence(n.data.landedBids, rec);
    } catch (err) {
      // Best-effort by design (the alert must still go out) - but a silent failure here leaves
      // no trace anywhere, so log it at the seam rather than dropping it (see fileStore._saveColl
      // for the same discipline on the same class of problem).
      log.warn('outcome enrichment failed', { kind: n.kind, auctionId: evt.auctionId, err });
    }
  }
  // The engine emits a bid_placed for EVERY descending-ladder rung (bidEngine.js). ALL of them now
  // flow through so the group's bid-log bubble grows a line per bid (the notifier appends + re-edits
  // the ONE bubble). The DM path is protected in notifier._whatsapp, NOT here: only the establishing
  // rung (rungIndex 0) reaches DM subscribers (the single "First bid" ping framed against openingPct -
  // the band's TOP margin); every later rung (rungIndex > 0) is restricted to the scoped group bubble,
  // so no DM ever gets a mislabeled "First bid" for a step-down. Per-rung dedupeKeys (set in
  // toNotification) keep the later appends from being swallowed as duplicates of the first.
  const failover = deliverWhenSenderDown(evt);
  if (failover) n.data.failoverWhenSenderDown = true;
  await notifier.alert(n.kind, n.data, { dedupeKey: n.dedupeKey });
  if (n.kind === 'desk_notice' && OPS_MIRRORED_NOTICES.has(evt.kind)) {
    // The error payload's shape, scope keys left off, so it reaches the unscoped ops recipients and
    // not the customer group that already has the notice.
    const lane = laneStr(evt.lane);
    const ops = { context: lane !== '?' ? lane : (evt.auctionId || 'bidder'), detail: evt.detail || evt.kind,
      auctionId: evt.auctionId };
    for (const k of ['platformKey', 'accountId', 'accountLabel']) if (n.data[k] != null) ops[k] = n.data[k];
    if (failover) ops.failoverWhenSenderDown = true;
    await notifier.alert('error', ops, { dedupeKey: `${n.dedupeKey}_ops` });
  }
}

module.exports = { toNotification, notifyEngineEvent, outcomeEnrichment, landedEvidence, ERROR_KINDS, DESK_NOTICE_KINDS, PAIRED_WITH_OUTCOME, laneStr };
