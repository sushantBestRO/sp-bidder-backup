'use strict';

const { withLaneDisplay, laneEndPins, twoPointFacts } = require('../web/laneDisplay');

/**
 * WhatsApp message catalogue. Maytapi (BRL's provider) has no server-side
 * templates and needs no Meta approval, so - unlike the official WABA path -
 * we render the FULL text here and send it as plain text. One entry per kind:
 *   - body: the message text, with {{n}} slots
 *   - placeholders(d): the values for {{1}}, {{2}}, ... in order
 * renderMessage(kind, data) fills the slots and returns the string to send.
 *
 * The four enquiry-lifecycle kinds (price_needed / price_submitted / won / lost)
 * reproduce BRL's Waaree/GoComet notifications - same labels + phrasing - dressed
 * with WhatsApp rich formatting so they read clean and compact:
 *   per-field emoji anchor + *bold* label   (emoji separates fields, so no blank
 *                                             lines are needed between them)
 *   _italic_ on the soft instruction / closing courtesy lines
 * WhatsApp itself auto-links dates + long numbers (the green text) - the client,
 * not us. Fields SP does not expose to the bidder (GID, Expected Transit Time,
 * auto-extend time, Date of Inquiry) are omitted entirely - no slot, no label
 * line - rather than rendered blank; see each entry's own comment for specifics.
 * bid_live / outbid / error / test are our operational extras (no BRL equivalent).
 */

// The vehicle line's leading glyph, named once because a multi-type ask repeats it to open each
// continuation line (vehicleWeightCell). Two copies of the character would let the body and the
// continuation drift apart on the one line where they must match.
const VEHICLE_GLYPH = '\u{1F69B}';
// The rate line's leading glyph, named for the same reason: a receipt for a load priced per truck
// type repeats it to open each continuation line (submittedRateCell).
const RATE_GLYPH = '\u{1F4B0}';

const MESSAGES = [
  // "New enquiry" - the MINIMAL market-rate ask (Director, 2026-07: "minimal messages, less
  // noise"). Six short lines, each kept under ~30 chars so none folds on a phone:
  //   {{1}} header   CUSTOMER . BRANCH  (headerCell - shipperName preferred over the raw shipper)
  //   {{9}} OA line                    (oaLine - the shipper's OWN reference, above the portal key,
  //                                     ONLY on a load that carries one; see oaLine)
  //   {{2}} load number                (loadNumberCell - SP load id + friendly code; the desk's
  //                                     anchor so a threaded edit/reply is never lost - Director ask)
  //   {{3}} pickup   city + PIN        (d.laneFrom - laneEnds; the FULL address is on /price)
  //   {{4}} drop     city + PIN        (d.laneTo - its own labelled line: the two ends sharing one
  //                                     line was unreadable on a GoComet load, Director 2026-08-12)
  //   {{10}} extra stop(s), if any     (twoPointLine - BC-36; city/PIN pairs when GoComet's
  //                                     structured fields have them, else "mentions 2 point" off
  //                                     the shipper's own free text, else nothing)
  //   {{5}} vehicle . weight . size    (vehicleWeightCell - BC-35 adds the truck's own size,
  //                                     when the load carries one)
  //   {{6}} close time                 (d.closesText - keeps the cost-by cutoff: a cost typed too
  //                                     late is silently discarded, load 23128437, 2026-07-14)
  //   {{7}} transit line               (transitLineMin - ONLY when the load's loadIsTransitTimeOn
  //                                     flag is set; SuperProcure 400s a bid with no transit days)
  //   {{8}} the /price link            (👉)
  //   {{12}} per-tonne note            (pmtNoteLine - ONLY on a discovery.isPmtBasis load; tells the
  //                                     desk the vehicle line above is a QUANTITY, not a truck count,
  //                                     and the rate they enter is per MT)
  // Everything the old ask carried and this drops - previous quotes, distance, product, shipper
  // note, portal-attachment note, and the greeting/closing boilerplate - is MOVED to the
  // /price/<token> page, not deleted (distance/product/note/portal are already rendered there; the
  // previous-quotes block still needs adding to that page - see the PR notes). The {{n}} mechanism
  // and the shipperName-vs-shipper distinction are preserved.
  { kind: 'price_needed',
    body: `📩 *{{1}}*{{9}}\n🆔 {{2}}\n📍 *From* - {{3}}\n🎯 *To* - {{4}}{{10}}\n${VEHICLE_GLYPH} {{5}}{{12}}{{13}}\n⏰ {{6}}{{11}}{{7}}\n\n👉 {{8}}`,
    placeholders: (d) => [headerCell(d), loadNumberCell(d), d.laneFrom || '-', d.laneTo || '-', vehicleWeightCell(d), d.closesText || '-', transitLineMin(d), d.link || '-', oaLine(d), twoPointLine(d), closeRuleCell(d), pmtNoteLine(d), rateHintLines(d)] },

  // "Customer wants a lower rate" - the shipper has reopened a load we already quoted, at a price
  // they state, with their own deadline. Rides the price_needed routing kind (same recipients, same
  // scoping) rather than minting a new ALERT_KINDS member, which would reach nobody until every
  // person and assignment record was migrated.
  //
  // It leads with the two numbers because that is the whole decision - what we quoted against what
  // they want - and the desk is being asked for a margin call on money already booked, not for a
  // fresh price. The deadline is the shipper's own and is usually much shorter than an auction:
  // the two observed windows were 14 and 59 minutes, so the countdown is stated in plain minutes
  // rather than as a clock time.
  //
  // {{6}} is the hand-quote warning, present ONLY on a multi-truck-type load, where the target
  // covers all the types at once and we have no evidenced way to split it back across them.
  { kind: 'price_target_rate',
    body: '💬 *{{1}}*\n🆔 {{2}}\n\n*Customer wants Rs {{3}}*\nWe quoted Rs {{4}}\n\n⏰ Reply {{5}}{{6}}\n\n👉 {{7}}',
    placeholders: (d) => [headerCell(d), loadNumberCell(d), fmtNum(d && d.targetPrice),
      fmtNum(d && d.standingPrice), targetReplyClause(d && d.deadlineAt), handQuoteNote(d), d.link || '-'] },

  // The outcome of a target-rate ask. It exists because the ordinary price_submitted receipt
  // promises a ladder ("we'll bid from X, never below Y") and there is no ladder here: one bid was
  // either sent at the customer's number or nothing was sent at all. Saying "armed" on a load that
  // is already finished is the same class of lie the desk auth-notice was fixed for.
  { kind: 'price_target_done',
    body: '{{1}} *{{2}}*\n🆔 {{3}}\n\n{{4}}',
    placeholders: (d) => [targetDoneIcon(d), targetDoneHeadline(d), loadNumberCell(d), targetDoneReason(d)] },

  // Ask-lifecycle noise-reduction copy (group channel only; see notifier._deliverGroup). Both are
  // short and carry the load number so the desk can still track the load in a busy group.
  //   ask_reminder - the approaching-deadline nudge, sent as a REPLY threaded under the original
  //                  ask instead of a full re-send (a reply re-notifies - that IS the point of a
  //                  reminder; an edit would be silent). One line + the load number. {{2}} is the
  //                  minutes-remaining clause (reminderClosingClause) - Director ask, 2026-07-25:
  //                  "can we also mention in how many minutes it's closing". Computed off d.deadlineAt
  //                  (the enter-cost-by cutoff dueForReminder actually fires against - see
  //                  priceRequests.dueForReminder), NOT the raw auction close, and evaluated inside
  //                  the placeholders() call so the minute count is accurate at SEND time, not when
  //                  notifier._priceNeededData built the payload minutes/seconds earlier.
  //                  The clause says "cutoff in N minutes", NOT "closing in N minutes": deadlineAt is
  //                  the enter-cost-by cutoff, not the auction close, and it is deliberately advisory
  //                  rather than a wall - a cost entered after it still counts, best-effort, right up
  //                  to the real close (server.js's /price copy says exactly that). This group bubble
  //                  carries no absolute time to qualify the number, so the noun has to carry it.
  { kind: 'ask_reminder',
    body: '⏰ *Reminder* - still awaiting a price, {{2}}.\n🆔 {{1}}',
    placeholders: (d) => [loadNumberCell(d), reminderClosingClause(d && d.deadlineAt)] },
  //   ask_resolved - what the STATUS BUBBLE is EDITED into once a rate lands (silent, no re-ping): a
  //                  compact "rate in" marker so anyone scrolling the group sees the ask is handled,
  //                  still anchored by the load number. The full receipt (route, bidding contract,
  //                  change-rate footer) remains the separate price_submitted template.
  //
  //                  NOT the ask. This comment said "the ORIGINAL ask message" until 2026-08-04 and
  //                  was simply wrong: notifier._deliverGroup renders this into thread.bubbleId, and
  //                  scripts/test-wa-lifecycle.js pins that the ask (mid-1) is never edited.
  //
  //                  THE COPY. It read "Rate submitted", and BRL staff read that as "the bid is on
  //                  SuperProcure" - it only ever meant the desk's price reached us. The wording now
  //                  says whose number it is and what it is not, and teaches the mechanic that is
  //                  actually true: this same bubble becomes the live bid log. It asserts nothing
  //                  NEGATIVE ("no bid has been placed yet") on purpose, because confirmSubmitted
  //                  also fires on a RE-PRICE, overwriting a bubble that may already hold landed
  //                  bids - a negative would be false there.
  { kind: 'ask_resolved',
    body: `📥 *We have your rate* - 🆔 {{1}}\n${RATE_GLYPH} {{2}}\n_Rate added. Bids show here as they are placed._`,
    placeholders: (d) => [loadNumberCell(d), submittedRateCell(d)] },

  // "Market Rate Submitted" - the receipt after a cost is entered. GID dropped (SP exposes none).
  // The operator's number is the anchor of this receipt (*Your Rate*, not "Market Rate"). Four
  // optional trailers hang off it, each blank when not applicable so a plain single-vehicle receipt
  // reads exactly as before: {{7}} the per-vehicle multiplier note on the SAME Your Rate line right
  // after the amount (perVehicleNote, #51 - a genuine FTL multi-vehicle load only); {{8}} the
  // bidding-contract line ("We'll bid from ... never below ...", biddingContract) that renders the
  // bot's actual plan against the entered rate, so the desk sees what their one number will do -
  // omitted when the armed band isn't known; {{9}} the change-a-mistaken-rate footer (changeLinkFooter,
  // #51 - blank when no link). Order matters: perVehicleNote is inline, biddingContract is its own
  // line, changeLinkFooter is the trailing footer.
  //
  // A LOAD PRICED PER TRUCK TYPE PUTS EVERY ENTERED RATE ON THE RECEIPT, one line each, and never
  // the blended mean. The desk entered 45,000 and 28,000 on 260907C2I8 and this receipt read
  // "Your Rate - 39,333" - a number nobody typed, below both numbers they did (2026-09-08). The
  // blend is the ladder's base and is still the right base (the rung is re-applied to each type's
  // own cost as a multiplier, see gocometAdapter's resolvePerTypePrices), but it is not anyone's
  // rate and must not be printed as one.
  { kind: 'price_submitted',
    body: `✅ *New Market Rate Submitted*\n\n🆔 *OA No* - {{1}}\n⏰ *Bid Close Time* - {{2}}{{10}}\n🛣️ *Route* - {{3}}\n${VEHICLE_GLYPH} *Vehicle Type* - {{4}}\n🕒 *Bid Entered Time* - {{5}}\n${RATE_GLYPH} *Your Rate* - {{6}}{{7}}{{8}}{{9}}`,
    placeholders: (d) => [d.oaNo || d.loadId || '-', d.closingTime || '-', d.route || '-', d.cargoQty || '-', d.enteredTime || '-', submittedRateCell(d), perVehicleNote(d), biddingContract(d) + belowMinimumNote(d), changeLinkFooter(d), closeRuleCell(d)] },

  { kind: 'bid_live',
    body: 'Bidding is live on {{1}} ({{2}}). {{3}}',
    placeholders: (d) => [d.lane, d.shipper || '-', bidLiveDetail(d)] },
  { kind: 'outbid',
    body: 'Outbid on {{1}} ({{2}}) - now rank {{3}}. Revising our bid.',
    placeholders: (d) => [d.lane, d.shipper || '-', fmtRank(d.rank)] },

  // WON receipt. feat/gc-bid-timestamps' 2026-09-16 skeleton cut is the shape: the route rides
  // wonHeader's own line, the From/To block is gone, and the allotment closer is folded into the
  // Final Ranking line. Attempts came back on 24 Sep 2026 (owner: attempts, gap to the actual close
  // and the date on every result) through outcomeTiming, which all five results share.
  //
  // {{1}} is wonHeadline - the win header, then the cost alert, then the route. The alert OUTRANKS
  // the route (owner, 2026-09-16): a load won below a cost the desk has since corrected up is a
  // loss, and that is the first thing a reader must see after the win itself. It cannot sit among
  // the fields below.
  { kind: 'won',
    body: '{{1}}\n\n🆔 *OA No* - {{2}}\n🚛 *Vehicle Type* - {{3}}{{4}}{{5}}{{6}}{{7}}\n\n🏅 *Our Final Ranking* - {{8}}. Complete the allotment on {{9}}.',
    placeholders: (d) => [wonHeadline(d), loadNumberCell(d), d.vehicleType || '-', wonMoney(d), outcomeTiming(d, { won: true }), wonWarning(d), posterContact(d), fmtRank(d.finalRank), platformName(d)] },
  { kind: 'sp_rank_first',
    body: '{{1}}\n\n*OA No* - {{2}}\n*Vehicle Type* - {{3}}{{4}}{{5}}{{6}}{{7}}\n\n*Portal Rank* - {{8}}\nAward not confirmed yet. Check SuperProcure for allotment.',
    placeholders: (d) => [spRankHeadline(d), loadNumberCell(d), d.vehicleType || '-', wonMoney(d).replace('Won Rate', 'Our Quote'), outcomeTiming(d, { won: true }), wonWarning(d), posterContact(d), fmtRank(d.finalRank)] },
  { kind: 'gc_submission_unconfirmed',
    body: '*OA No* - {{1}}\nBid submitted. Please check the position on GoComet.',
    placeholders: d => [loadNumberCell(d)] },
  { kind: 'sp_awarded',
    body: '{{1}}\n\n*OA No* - {{2}}\n*Vehicle Type* - {{3}}{{4}}{{5}}{{6}}{{7}}\n\n*Portal Rank* - {{8}}. Allotment confirmed on SuperProcure.',
    placeholders: (d) => [wonHeadline(d), loadNumberCell(d), d.vehicleType || '-', wonMoney(d), outcomeTiming(d, { won: true }), wonWarning(d), posterContact(d), fmtRank(d.finalRank)] },
  { kind: 'sp_shared_rank',
    body: '*RANK {{1}} - {{2}}*\n\n*OA No* - {{3}}\n*Vehicle Type* - {{4}}{{5}}{{6}}\n\nThis position is from a bid placed by hand from this login. Bid Command placed no bid.\nAward not confirmed yet. Check SuperProcure for allotment.',
    placeholders: (d) => [fmtRank(d.finalRank), headerCell(d), loadNumberCell(d), d.vehicleType || '-', wonMoney(d), outcomeTiming(d)] },
  { kind: 'sp_shared_result_unknown',
    body: '*RESULT UNKNOWN - {{1}}*\n\n*OA No* - {{2}}\n*Vehicle Type* - {{3}}{{4}}\n\nBid Command placed no bid. This shared login was last observed at rank {{5}}; the final portal result could not be verified. Check SuperProcure.',
    placeholders: (d) => [headerCell(d), loadNumberCell(d), d.vehicleType || '-', outcomeTiming(d), fmtRank(d.resultObservedRank)] },

  // "Lost enquiry". {{1}} is a LOUD loss header (lostHeader) as the very
  // first line, so WhatsApp's chat-list preview - which shows only the first line - reads "WE LOST"
  // at a glance instead of burying the outcome at the bottom (Director feedback, 2026-07).
  // Money detail omitted when we have no entered cost. Closing
  // line is neutral: we can't see the winner's (masked) rate, so we don't assert "you gave a very
  // high rate" - and now that the header already shouts the loss, the closing folds to just the
  // forward nudge (the old "We were outbid this time -" prefix restated the header, so it's dropped).
  // The held-price clause rides the LAST slot of the trimmed skeleton. Widened, not contested:
  // the clause is the desk's only channel for a board still holding an older price, and the
  // trimmed body is the shape the owner signed off on 2026-09-16.
  // 2026-09-16 length trim (the GoComet full-postal-address case ran to ~650 chars): the "Dear
  // Manager, / Please note for the given" preamble is gone entirely, and the full postal From/To
  // block is dropped rather than duplicated - lostHeader already carries the same route on its own
  // second line.
  { kind: 'lost',
    body: '{{1}}\n\n🆔 *OA No* - {{2}}\n🚛 *Vehicle Type* - {{3}}{{4}}\n🏅 *Our Final Ranking* - {{5}}{{6}}{{7}}\n\n{{8}}',
    placeholders: (d) => [lostHeader(d), d.oaNo || '-', d.vehicleType || '-', lostMoney(d), fmtRank(d.finalRank), outcomeTiming(d), lostHeldClause(d), lostAdvice(d)] },

  // "Lost enquiry" - the SHORT reply variant, used ONLY when a loss threads as a reply UNDER the
  // pristine group ask (notifier._deliverGroup). Rendered on demand in _deliverGroup, never routed
  // through alert() - so it needs no ALERT_KINDS entry, exactly like ask_reminder / ask_resolved.
  // (The full 'lost' template above is still what a DM subscriber gets, since a DM has no ask above
  // it to lean on.)
  //
  // IT USED TO CARRY ONLY header + rank + our bid, on the argument that the ask right above already
  // states the lane, the vehicle and the close. The Director asked for the missing facts back
  // (2026-08-19, verbatim): the origin, the destination, the vehicle type, the OA number, our
  // ranking - "and of course, the market rate and what was the margin added". Reading a loss should
  // not require scrolling up to the ask, and on the busy Chikhli desk the ask is rarely still on
  // screen. So each of his six facts is a line here, and nothing else is.
  //
  // The lane rides the HEADER rather than its own *From* / *To* pair. WhatsApp's chat-list preview
  // shows only the first line, and with one customer behind ~90% of GoComet loads the customer name
  // alone tells the reader nothing about WHICH load lost - the route is what makes the preview
  // useful. lostHeader now writes it through the same short city+pin cells the ask does (see
  // outcomeContext), which is what the Director was actually objecting to: the header used to
  // interpolate the two RAW GoComet postal addresses, so a loss opened with a 400-character
  // paragraph.
  //
  // The held-price clause rides the LAST slot of the trimmed skeleton. Widened, not contested:
  // the clause is the desk's only channel for a board still holding an older price, and the
  // trimmed body is the shape the owner signed off on 2026-09-16.
  // It carries the bid-timing line ({{7}}) even though it is the deliberately short variant. This
  // reply is what the desk actually reads on a group-scoped loss - notifier._deliverGroup renders
  // the SHORT body whenever an ask thread exists - so a "did the snipe fire" signal that lands only
  // on the long template lands nowhere for most losses, and losses are the case the desk described.
  // A stamped result also carries the dated close here: the close the ask states is the posted one,
  // and on an extended auction that is not when it closed.
  // T6 BH-CONTRACT-1/LOGIC-3: this reply dropped rateChangedLine entirely, unlike lostMoney (the
  // long template), which is yourRateLine + ourBidLine + rateChangedLine - so a re-priced loss
  // reached the desk on this (the one most losses actually render on) with no explanation for why
  // the margin on the bid line does not match today's rate.
  { kind: 'lost_short',
    body: '{{1}}{{2}}{{3}}\n🏅 *Our Final Ranking* - {{4}}{{5}}{{6}}{{7}}{{8}}{{9}}\n\n{{10}}',
    placeholders: (d) => [lostHeader(d), oaLine(d), outcomeVehicleCell(d),
      fmtRank(d.finalRank), yourRateLine(d), ourBidLine(d), rateChangedLine(d), shortOutcomeTiming(d), lostHeldClause(d), lostAdvice(d)] },

  // "No bid placed" - the outcome of a load we ARMED but never got a bid onto the board for (every
  // attempt refused, or the window closed before one fired). It is NOT a loss: we were never in the
  // auction, and telling the desk "LOST ... Our Final Ranking - -" for a load that took no bid is a
  // report they rightly called wrong (load 23484018, 2026-07-25). Selected by templateFor() off the
  // participation fact on the event, INSIDE the existing 'lost' subscription kind - so no recipient
  // record needs migrating (a brand-new kind would have zero subscribers and silently drop the
  // outcome). Mirrors the 'lost' body so the receipt reads familiar, with two deliberate deletions:
  // no Our Final Ranking line (there is no rank to report - that dangling "-" IS the complaint) and
  // no Our Bid line (nothing was bid). Money collapses to the desk's own entered rate. The header is
  // the first line so WhatsApp's chat-list preview reads "NO BID PLACED - Havells (...)" at a glance.
  { kind: 'no_bid',
    body: '{{1}}\n\nDear Manager,\n\nPlease note for the given 🆔 *OA No* - {{2}}\n📍 *From* - {{3}}\n🎯 *To* - {{4}}\n🚛 *Vehicle Type* - {{5}}{{6}}{{7}}\n\n📌 _{{8}}_',
    placeholders: (d) => [noBidHeader(d), d.oaNo || '-', d.from || '-', d.to || '-', d.vehicleType || '-', noBidMoney(d), outcomeTiming(d), noBidWhy(d)] },

  // "No bid placed" - the SHORT reply variant, used ONLY when the outcome threads as a reply UNDER
  // the pristine group ask (notifier._deliverGroup), exactly like lost_short: the ask right above it
  // already carries From/To/Vehicle/Bid-Close, so this need only shout the outcome and the rate that
  // was entered. Rendered on demand, never routed through alert(), so it needs no ALERT_KINDS entry.
  { kind: 'no_bid_short',
    body: '{{1}}{{2}}{{3}}\n\n📌 _{{4}}_',
    placeholders: (d) => [noBidHeader(d), noBidMoney(d), shortOutcomeTiming(d), noBidWhy(d)] },

  // "Result not yet known" - a load we bid on whose final rank the portal had not confirmed when the
  // engine finalized (GoComet: the enquiry record was not yet closed at rank 1). Selected inside the
  // 'lost' kind like no_bid. It must claim neither a win nor a loss: the desk checks the portal
  // before placing a vehicle. The rank line is the last rank we read live, labelled as such.
  { kind: 'result_unknown',
    body: '{{1}}\n\n🆔 *OA No* - {{2}}\n🚛 *Vehicle Type* - {{3}}{{4}}\n🏅 *Our rank when bidding closed* - {{5}}{{6}}\n\n📌 _{{7}}_',
    placeholders: (d) => [unknownHeader(d), d.oaNo || '-', d.vehicleType || '-', lostMoney(d),
      d.finalRank != null ? d.finalRank : '-', outcomeTiming(d), RESULT_UNKNOWN_ADVICE] },
  { kind: 'result_unknown_short',
    body: '{{1}}{{2}}\n🚛 {{3}}\n🏅 *Our rank when bidding closed* - {{4}}{{5}}{{6}}{{7}}\n\n📌 _{{8}}_',
    placeholders: (d) => [unknownHeader(d), oaLine(d), outcomeVehicleCell(d), d.finalRank != null ? d.finalRank : '-',
      yourRateLine(d), ourBidLine(d), shortOutcomeTiming(d), RESULT_UNKNOWN_ADVICE] },

  // The STATUS BUBBLE states - the ONE mutating group message the lifecycle edits in place between
  // the ask and the outcome (silent edits, no per-event ping). Rendered on demand in _deliverGroup
  // (like ask_reminder / ask_resolved), never routed through alert(), so no ALERT_KINDS entry.
  //   bid_placed   - a LIVE, GROWING LOG of the bot's bids on this load. Each bid the engine places
  //                  APPENDS a timestamped line (bidLogLines: "hh:mm AM/PM · Rs X · rank N", the
  //                  field separator a MIDDLE DOT U+00B7), and the same bubble is re-edited in place -
  //                  ONE bubble that grows, never a message per bid (Suyashh's noise budget). The log
  //                  keeps only the most recent lines + a "... N earlier" count so it can't grow
  //                  unbounded (see bidLogLines). The live-status LINK is pinned at the BOTTOM on its
  //                  OWN line (liveLinkCta), because a bid-placed edit past Maytapi's ~15-min window
  //                  silently no-ops (a soft-close auction runs longer) - the link on the last good
  //                  edit is the live-truth fallback, where live rank actually lives (the /price page
  //                  short-polls it). d.bids is the stored bid log, d.bidCount the running total.
  { kind: 'bid_placed',
    body: '*Bids placed (live):*{{1}}{{2}}{{3}}',
    placeholders: (d) => [bidLogLines(d), finalBidLine(d), liveLinkCta(d)] },
  //   bidding_live - the bot is ARMED and watching, no bid yet (fills the soft-close gap between
  //                  "rate received" and the late snipe so the desk isn't left wondering). Same live
  //                  link, pinned at the bottom on its own line. NOTE: this state's production routing
  //                  (off the engine's 'armed' event) is a deferred follow-up - it needs a
  //                  subscribable alert kind, outside this PR's notify-only surface; the template
  //                  exists so enabling it later is a one-line flip. See this PR's description.
  { kind: 'bidding_live',
    body: '*Bidding live* - 🆔 {{1}}\n_On this load - bidding when it counts._{{2}}',
    placeholders: (d) => [loadNumberCell(d), liveLinkCta(d)] },

  // "Not bidding this one" - the NON-PAGING desk notice, for a load we deliberately declined on
  // COMMERCIAL grounds. Today that is only the shipper-ceiling-below-cost case (engineAlerts
  // DESK_NOTICE_KINDS). It goes to the customer's own group, not to anyone's fault DMs, and it is
  // sent the MOMENT the refusal is taken - which on SIKA 23534893 would have been 14:43 against a
  // 15:30 close, i.e. 47 minutes in which the desk could have re-priced and still competed. The
  // load's outcome receipt at close states the same reason; this is the early half of that pair.
  //
  // Both money numbers are named because the desk needs to see the GAP to decide what to do, and a
  // "BRL Bids" group is BRL staff only (see staffRoster) - the same surface that already carries
  // cost, bid and margin per load. States what happens next in the desk's own words, and never
  // asks anyone to open a console.
  //
  // The "Not bidding - " lead used to be HARDCODED into this body. It moved into deskNoticeHeadline
  // on 2026-08-01, when 'last_resort_floor_fired' joined DESK_NOTICE_KINDS: that notice is about a
  // bid we DID place, so a hardcoded refusal lead rendered the self-contradiction
  // "Not bidding - Havells: lowest price sent on this load" no matter what the placeholder said.
  // The refusal wording is byte-identical - the lead simply lives one level down now, where the
  // recorded reason can choose it. WhatsApp's chat-list preview shows only this first line, so it
  // has to be true on its own.
  { kind: 'desk_notice',
    // reprice_unreachable_ladder carries its own full body (repriceUnreachableBody) - none of this
    // template's literal labels ("OA No", the ceiling-notice figure order) match what MESSAGES_REDESIGN
    // CW-225 section 2 says, and every other desk-notice reason keeps this shared body untouched.
    body: (d) => (d && d.reason === 'reprice_unreachable_ladder')
      ? '{{1}}'
      : (d && TERSE_NOTICE[d.reason])
        ? '📌 *{{1}}*\n🆔 *OA No* - {{2}}\n📍 {{3}}'
        : '📌 *{{1}}*\n🆔 *OA No* - {{2}}\n📍 {{3}}{{4}}\n\n_{{5}}_',
    placeholders: (d) => (d && d.reason === 'reprice_unreachable_ladder')
      ? [repriceUnreachableBody(d)]
      : (d && TERSE_NOTICE[d.reason])
        ? [TERSE_NOTICE[d.reason](d), d.oaNo || d.auctionId || '-', deskNoticeLane(d)]
        : [deskNoticeHeadline(d), d.oaNo || d.auctionId || '-', deskNoticeLane(d), deskNoticeMoney(d), deskNoticeAction(d)] },

  // The operator/ops alarm. "Check the console." was dropped on 2026-07-27: the console is an
  // internal tool, this message also reaches the client's Director, and a Director has no console -
  // it read as an instruction he could not follow. The detail line is left to speak for itself
  // rather than pointing anyone at a surface they may not have.
  { kind: 'error',
    body: '⚠️ *Bid Command alert* on {{1}}\n{{2}}',
    placeholders: (d) => [String(d.context || 'this load'), String(d.detail || 'unknown error')] },
  // The desk-facing siblings of the session-expiry alert (tokenExpiry.js) and its all-clear
  // (authAlert.raiseAuthRestored). Selected inside 'desk_notice' by data.sessionAlert (see
  // templateFor), the same flag-on-payload pattern account_auth_dead/_expired already use inside
  // 'error' - a new ALERT_KINDS member would reach strictly fewer people, and this reuses the
  // existing desk_notice routing/subscription instead. The desk_notice template's own OA-No/lane
  // layout does not fit here (this is an account-wide fact, not a load), so these are their own
  // short two-line bodies rather than a reason branch inside deskNoticeHeadline/deskNoticeAction.
  //
  // `detail` IS NOT THE ADMIN SENTENCE. The two audiences get two strings by construction: the
  // admin copy names the internal account label and may ask for something only BRL can do, while
  // these name the CUSTOMER and ask only for what that desk can do. Reading an internal slug back
  // into a customer's own group is the convention notifier.js:706-713 already settled against.
  //
  // session_disconnected MAKES A STANDING CLAIM and is therefore paired: session_restored withdraws
  // it on the same channel. Nothing may send the stop-claim without the retraction being reachable -
  // on this account the desk and this system share one per-load SuperProcure bid cap, so a desk
  // still hand-quoting after bidding resumed costs us our own bid.
  { kind: 'session_expiring_soon',
    body: '⏰ *Session expiring soon*\n{{1}}',
    placeholders: (d) => [String(d.detail || 'Our bidding access on this account is about to run out.')] },
  { kind: 'session_disconnected',
    body: '🚫 *Session disconnected*\n{{1}}',
    placeholders: (d) => [String(d.detail || 'Our bidding access on this account has disconnected.')] },
  { kind: 'session_restored',
    body: '✅ *Session restored*\n{{1}}',
    placeholders: (d) => [String(d.detail || 'Our bidding access on this account is back. No more manual quoting needed on it.')] },
  // The ONE operational alarm worth interrupting the desk for: SuperProcure has ended a login's
  // session, so every load running on that account will close with nothing of ours on the board
  // until a human signs it back in.
  //
  // It is a TEMPLATE inside the existing 'error' routing kind, not a new ALERT_KINDS member, and
  // that is deliberate: a new subscription kind would reach strictly FEWER people. The Director's
  // own alert list is a frozen literal array, and the customer groups are shipper-scoped while this
  // payload carries no shipper - so minting a kind would deliver it to nobody until every recipient
  // record was migrated. Same split 'no_bid' already uses inside 'lost'.
  //
  // The remedy line does NOT promise "press Reconnect". The console's reconnect is a phone-OTP flow
  // that cannot complete for a login mapping to more than one SuperProcure account, and the master
  // login is exactly such a login - so promising it would send the desk at a button that will not
  // work for the account most likely to be affected. It names a person and gives the reader
  // something useful to do in the meantime instead.
  //
  // Named contact is Sushant (BRL IT/Workspace admin, owns the SuperProcure re-login/OTP-capture
  // runbook - docs/runbooks/sp-token-capture.md), not Sid - this alert fires straight into the
  // Director's list every time an account latches, and routing the page through Sid on every
  // outage doesn't scale.
  //
  // Never says "401" or "token": the reader is the desk and the client's Director, not an engineer.
  // The "Account: <login email>" line is appended for free by notifier._whatsapp when the payload
  // carries accountId and a contact email is on file.
  { kind: 'account_auth_dead',
    body: '🚫 *Login logged out - {{1}}*\n_No bid can go out on this account until it is reconnected._\n\n{{2}}\n\n*Tell Sushant, and quote these loads on the SuperProcure portal for now.*',
    placeholders: (d) => [accountName(d), affectedCustomersLine(d)] },
  // THE EXPIRY VARIANT of the same alarm, selected on the payload's authReason (see templateFor).
  //
  // It exists because the two conditions have DIFFERENT REMEDIES and the reader is the one who acts.
  // A revocation is SuperProcure's action: nobody here can undo it and the honest instruction is to
  // raise it and wait. A login that simply ran out of time is ours, it was going to happen on a known
  // date, and it is fixed by signing the account in again for a fresh code - which is a thing the
  // reader can set in motion in the next minute. Rendering the revocation copy for both (which is
  // what happened while this fact was dropped at the raiser) told the desk SuperProcure had logged us
  // out when SuperProcure had done nothing at all, and pointed at no remedy.
  //
  // Same constraints as its sibling above and for the same reasons: same 'error' routing kind, no new
  // ALERT_KINDS member, the hand-quoting instruction stays up because the account genuinely cannot
  // bid, and the named contact is Sushant, who owns the re-login/OTP-capture runbook. It says
  // "expired" and "sign in again" but never "token", "JWT" or a status code - the readers are the
  // desk and the client's Director.
  { kind: 'account_auth_expired',
    body: '🚫 *Login expired - {{1}}*\n_No bid can go out until it is signed in again._\n\n{{2}}\n\n*Ask Sushant to sign in again and capture the new login using the code sent to the branch\'s phone or email. Quote these loads on the portal till then.*',
    placeholders: (d) => [accountName(d), affectedCustomersLine(d)] },
  // The all-clear half of the account_auth_dead pair (raiseAuthRestored). Exists so the desk stops
  // hand-quoting on a stale instruction once the bot has actually resumed - this account's per-load
  // bid cap is shared between the bot and the desk, so a hand-quote placed after the bot is back
  // bidding again starts costing the bot's own bids over-cap. Names the downtime in whole minutes
  // (rounded, floored at 1) rather than showing since/downForMs raw - the reader needs "how long", not
  // an epoch.
  { kind: 'account_auth_restored',
    body: '✅ *Login back - {{1}}*\nDown about {{2}} min. Bidding has resumed - no more manual quoting needed.',
    placeholders: (d) => [accountName(d), Math.max(1, Math.round((Number.isFinite(Number(d.downForMs)) ? Number(d.downForMs) : 0) / 60000))] },
  // THE PROVISIONAL MIDDLE STATE, sent when somebody reconnects an account mid-outage.
  //
  // It deliberately does NOT say "back online" and does NOT retract the hand-quoting instruction. A
  // reconnect proves the login works; it does not prove SuperProcure will accept a bid, and this
  // platform can serve reads on an account whose write scope is gone. The desk keeps quoting by hand
  // until an actual bid of ours is accepted, at which point account_auth_restored goes out and says
  // to stop. Telling them to stop early costs real money here - the bot and the desk share one
  // per-load bid cap, so a premature "all clear" that turns out wrong leaves the load uncovered by
  // both.
  { kind: 'account_auth_reconnecting',
    body: '🔄 *Login reconnected - {{1}}*\n_Confirming - keep quoting for now._',
    placeholders: (d) => [accountName(d)] },
  // Not an ALERT_KIND (never routed by alert()); sent only by the operator's "Send test".
  { kind: 'test',
    body: 'Bid Command: WhatsApp alerts are set up correctly. {{1}}',
    placeholders: (d) => [d.note || 'You are set to receive bid alerts.'] },
];

const BY_KIND = new Map(MESSAGES.map((m) => [m.kind, m]));

const pad2 = (n) => String(n).padStart(2, '0');

// How many bid-log lines the bid_placed bubble renders at most (most recent). Older bids collapse
// to a "... N earlier bids" count so a many-bid soft-close load can't grow the bubble without limit.
const BIDLOG_SHOWN = 5;

// "DD-MM-YYYY hh:mm AM/PM" (server-local time) - the enquiry-template date format.
function fmtDMY(ms) {
  if (!ms) return '';
  try {
    const d = new Date(Number(ms));
    let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(h)}:${pad2(d.getMinutes())} ${ap}`;
  } catch (_) { return ''; }
}
/**
 * The close time, plus the cutoff by which a cost actually has to be entered.
 *
 * These are NOT the same instant and the gap between them (priceDeadlineLeadMs, the configured lead)
 * is the run-up the engine needs to arm and walk its ladder down. The price_needed ask used to
 * name only the close, so the desk priced against it - and a cost typed at 2:44 for a 2:45 close
 * was silently discarded, because the real cutoff was 2:43:30 (load 23128437, 2026-07-14).
 *
 * Degrades to the bare close time when no deadline is known, so an older request snapshot (or a
 * non-real adapter) still renders exactly as before.
 */
function fmtCloseWithCutoff(closesAt, deadlineAt) {
  const closes = fmtDMY(closesAt);
  if (!closes || !deadlineAt || !closesAt || deadlineAt >= closesAt) return closes;
  const d = new Date(Number(deadlineAt));
  let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return `${closes} (enter cost by ${pad2(h)}:${pad2(d.getMinutes())} ${ap})`;
}

/**
 * The remaining-time PHRASE behind the reminder's "how many minutes" number (Director ask,
 * 2026-07-25) - "in 4 minutes", "in under a minute", "in about 1 hour 5 minutes". Just the
 * duration: every surface prepends its OWN noun, so the group clause and the DM banner share one
 * piece of arithmetic without either one having to string-surgery the other's wording.
 *
 * Measured against deadlineAt - the enter-cost-by cutoff dueForReminder actually fires against
 * (priceRequests.js) - not the raw auction close, because the cutoff is the number the desk is
 * being asked to hit and the one already threaded through as request.deadlineAt.
 *
 * `nowMs` defaults to Date.now() evaluated at CALL time, not import time - callers must not
 * pre-compute this into the payload (notifier._priceNeededData builds the payload before the
 * actual send; the reminder can render seconds later, group-lifecycle lookups included), or the
 * printed minutes drift from what was true when the message actually lands. Tests pass nowMs
 * explicitly for determinism.
 *
 * Whole minutes only (floored - "4 minutes" means at least 4 full minutes are left, never a
 * rounded-up overstatement). Returns '' - not a phrase - when there is no usable deadline or it
 * is already at/past now, so callers degrade to their own bare wording instead of rendering a
 * dangling half-sentence or a negative count.
 *
 * The hour branches are above the shipped reminderLeadMs (5 min) and so unreachable at the
 * default config; they exist because the lead is an operator-tunable knob (Settings "Reminder
 * lead" / SP_REMINDER_LEAD_MS take any value), and a raised lead must not print "in 90 minutes".
 */
function reminderRemainingPhrase(deadlineAt, nowMs = Date.now()) {
  const deadline = Number(deadlineAt);
  if (!deadline || !Number.isFinite(deadline)) return '';
  const remainingMs = deadline - Number(nowMs);
  if (!(remainingMs > 0)) return '';
  if (remainingMs < 60_000) return 'in under a minute';
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 60) return `in ${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return mins > 0 ? `in about ${hourPart} ${mins} minute${mins === 1 ? '' : 's'}` : `in about ${hourPart}`;
}

/**
 * The ask_reminder clause - the group bubble's half of the same number: "cutoff in 4 minutes".
 *
 * "cutoff", NOT "closing": deadlineAt is the enter-cost-by cutoff, and the product deliberately
 * treats it as advisory rather than a wall - a cost entered after it still counts, best-effort,
 * right up to the real close (the /price page says so in as many words, and the engine snipes
 * into whatever window is left). "closing in N minutes" would name the wrong timestamp AND
 * promise a hard stop nothing enforces; on a one-line group bubble that carries no absolute time
 * to qualify it, the reader would reasonably conclude the load is gone and skip it.
 *
 * Degrades to the original bare "closing soon" when the deadline is unknown or already past -
 * unchanged wording, so a degraded reminder reads exactly as it did before this clause existed.
 */
function reminderClosingClause(deadlineAt, nowMs = Date.now()) {
  const phrase = reminderRemainingPhrase(deadlineAt, nowMs);
  return phrase ? `cutoff ${phrase}` : 'closing soon';
}

/**
 * The reply window on a shipper target rate. Unlike the auction cutoff this IS a wall - the offer
 * lapses at the stated time and the load goes with it - so the wording says "by" rather than the
 * advisory "cutoff", and it carries the absolute clock time alongside the countdown because on a
 * 14-minute window a reader who opens the message four minutes late needs the real time, not a
 * relative phrase that was true when it was sent.
 */
function targetReplyClause(deadlineAt, nowMs = Date.now()) {
  const phrase = reminderRemainingPhrase(deadlineAt, nowMs);
  const clock = fmtClock(deadlineAt);
  if (!phrase) return clock ? `by ${clock}` : 'as soon as possible';
  return clock ? `${phrase} (by ${clock})` : phrase;
}

// Present only on a multi-truck-type load. The target covers every type at once, and since #214 the
// submit path writes one UNIFORM rate to every line - so answering a summed target automatically
// would mean guessing a per-type split. The desk has to do this one on the portal.
function handQuoteNote(d) {
  const lines = d && Number(d.chargeLineCount);
  if (!(lines > 1)) return '';
  return `\n\n⚠️ ${lines} vehicle types on this load. The customer's price covers all of them, so this one has to be entered on the portal by hand.`;
}

// The cells of the target-rate outcome message. Helpers rather than inlined so the refusal wording
// lives in exactly one place - the desk reads the same sentence here and on the price page.
function targetDoneIcon(d) { return (d && d.targetSubmitted) ? '✅' : '⚠️'; }

function targetDoneHeadline(d) {
  if (d && d.targetSubmitted) return `Quoted Rs ${fmtNum(d && d.targetPrice)}`;
  if (d && d.targetReason === 'submit_failed' && !d.targetSendingOff) return 'Not confirmed';
  return 'Not quoted';
}

function targetDoneReason(d) {
  if (d && d.targetSubmitted) return "Sent at the customer's rate. Nothing else runs on this load.";
  const lines = Number(d && d.chargeLineCount);
  switch (d && d.targetReason) {
    case 'below_cost': return 'Their rate is below what this load costs us, so nothing was sent.';
    case 'below_floor': return 'Their rate is below the lowest price we accept on this load, so nothing was sent.';
    case 'multi_line': return `This load has ${lines > 1 ? lines : 'several'} vehicle types and their rate covers all of them together. Enter it on the portal by hand if you want it.`;
    case 'not_below_quote': return 'Our quote is already at or under their rate, so there is nothing to send. Our quote stands.';
    case 'window_closed': return 'Their offer had already lapsed, so nothing was sent.';
    case 'rejected': return 'The portal refused the bid. Enter it on the portal by hand if you still want the load.';
    case 'submit_failed': return d.targetSendingOff
      ? 'Sending is switched off on this portal, so nothing went to the customer. Accept their rate on the portal by hand if you want the load.'
      : 'We could not confirm it reached the portal. Check the load there and accept their rate by hand if our quote has not changed.';
    case 'target_price_off': return 'Sending target rates is switched off, so nothing went to the customer. Accept their rate on the portal by hand if you want the load.';
    case 'no_target': return 'No usable customer rate could be read for this load, so nothing was sent.';
    case 'bad_band': return 'The price settings on this load could not be read, so nothing was sent.';
    default: return 'Nothing was sent on this load.';
  }
}

// "hh:mm am/pm" - the "Bid Entered Time" clock.
function fmtClock(ms) {
  if (!ms) return '';
  try {
    const d = new Date(Number(ms));
    let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
    return `${pad2(h)}:${pad2(d.getMinutes())} ${ap}`;
  } catch (_) { return ''; }
}
// "hh:mm AM/PM" - the bid-log line clock (upper-case AM/PM), the placement time of one bid on the
// bid_placed bubble. Stamped at notify-receive time (the engine fires bid_placed synchronously at
// placement, so this is placement time to the minute the line displays).
function fmtClockUpper(ms) {
  if (!ms) return '';
  try {
    const d = new Date(Number(ms));
    let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
    return `${pad2(h)}:${pad2(d.getMinutes())} ${ap}`;
  } catch (_) { return ''; }
}
// The "Bid Close Time" value on the won / lost / no-bid receipts: the auction's own closing time,
// then when our last bid landed and how far ahead of that close it was. The desk asked for these
// three together (8 Sep 2026) because a snipe is judged by the gap, not by either clock alone - on
// a healthy close it is a second or two, and minutes mean the last attempt never fired.
//
// It renders as TWO lines (F-D, 2026-09-11). Carrying all three on one ran past a phone's width
// and wrapped mid-parenthesis, so the gap - the one fact this line exists for - was the part that
// broke. The cell interpolates into a labelled line, so the second line brings its own label.
//
// The lead is d.lastBidLeadMs, the countdown the PORTAL published when the bid went on the wire. It
// is deliberately not recomputed here as close-minus-bid-time: the close is on the portal's clock
// and the bid's clock time is on this machine's, so that subtraction would report the drift between
// them as lateness. Each part is dropped when absent, so a no-bid close renders the close time
// alone - no second line - and a record predating the capture renders exactly what it always did.
function closeTimeCell(d) {
  const close = d && d.closeTime ? String(d.closeTime) : '-';
  const at = d && d.lastBidTime ? String(d.lastBidTime) : '';
  const lead = leadPhrase(d && d.lastBidLeadMs);
  if (!at && !lead) return close;
  const value = at ? `${at}${lead ? ` (${lead})` : ''}` : lead;
  return `${close}\n⏱ *Our last bid* - ${value}`;
}
// The bid-timing line for the SHORT loss / no-bid replies - "\n⏱ *Last bid* - 05:58 pm, 2s before
// close". Own line, no full close timestamp (the ask above it already carries Bid Close). Renders
// nothing at all when neither fact is known, so a no-bid close or a pre-capture record is byte
// -identical to what it produced before this line existed.
function shortBidTimingLine(d) {
  const at = d && d.lastBidTime ? String(d.lastBidTime) : '';
  const lead = leadPhrase(d && d.lastBidLeadMs);
  if (!at && !lead) return '';
  if (!at) return `\n⏱ _${lead}_`;
  return `\n⏱ *Last bid* - ${at}${lead ? `, ${lead}` : ''}`;
}
// "58s before close" / "4 min before close" - whole seconds under two minutes, whole minutes above,
// because that is the resolution the two cases are read at. A non-finite or negative lead renders
// nothing rather than "0s": a bid the portal timed at or past the close is a fact this line cannot
// state honestly, and the outcome above it already says what happened. A positive lead that rounds
// to zero seconds reads "under 1s" for the same reason (T6 D7).
function leadPhrase(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 120000) {
    const s = Math.round(n / 1000);
    return s === 0 ? 'under 1s before close' : `${s}s before close`;
  }
  return `${Math.round(n / 60000)} min before close`;
}

// The timing block of all five results. A result the engine stamped with attempts and close
// provenance (resultFacts) gets the dated block; anything recorded before that keeps the lines it
// always had, byte for byte.
function outcomeTiming(d, opts) {
  return d && d.resultFacts ? resultLines(d, opts) : `\n⏰ *Bid Close Time* - ${closeTimeCell(d)}`;
}
function shortOutcomeTiming(d) {
  return d && d.resultFacts ? resultLines(d) : shortBidTimingLine(d);
}
function resultLines(d, { won = false } = {}) {
  const used = d.landedBids != null ? Number(d.landedBids) : null;
  const refused = Number(d.refusedAttempts) || 0;
  let s = won && used === 0 ? handWinLine(d, refused) : '';
  if (used != null) {
    const of = d.attemptsAllowed != null ? `${used} of ${d.attemptsAllowed} used` : `${used} used`;
    s += `\n🔁 *Attempts* - ${of}${refused ? `, ${refused} refused by the portal` : ''}`;
  }
  return s + lastBidLine(d) + closedLines(d);
}
// A win with nothing of ours on the board was taken by a bid we did not place, so no bot rate or
// margin is credited to it (outcomeEnrichment has none to give) and the refusal is named instead.
// SuperProcure only: on GoComet BRL's own autopilot bids from the same vendor login, so "by hand"
// is not known to be true there.
function handWinLine(d, refused) {
  if (d.platformKey === 'gocomet') return '';
  const cap = d.noBidAmountCap != null ? `: it allowed ₹${fmtNum(d.noBidAmountCap)} or less` : '';
  const why = refused
    ? ` Bid Command's ${refused} attempt${refused === 1 ? ' was' : 's were'} refused by SuperProcure${cap}.` : '';
  return `\n✋ Won on a bid placed by hand from this login.${why}`;
}
// One gap per message: to the final close (owner, 24 Sep 2026), or to its own round close when the
// close moved after the bid (CW-267, 29 Sep). None when the final close is unknown.
function lastBidLine(d) {
  if (d.lastBidTs == null) return '';
  const at = fmtClockSecs(d.lastBidTs);
  // Owner ruling (26 Sep 2026, live receipt: GoComet Waaree 260925NP9V) - decided at closesInMs
  // 3,532 but the write took 4,578 ms, so it landed AFTER the shown close. bidGapsMs clamps its
  // gap to a floor of 0 (util/reportedClose.js), which makes "landed exactly on time" and "landed
  // late" the same number here - and the line below reads a falsy (zero/null) gap as "at the final
  // close", printed beside a landing time visibly after the Closed line above it. Detected
  // directly off the two wall-clock facts (never off the clamped gap): when the landing is at or
  // after the shown close, state the DECISION-time countdown instead - the number that actually
  // explains what happened - rather than a claim the timestamps beside it contradict.
  if (d.closeAtMs != null && d.lastBidTs >= d.closeAtMs) {
    // Review correction (26 Sep): the rule above is ABSOLUTE - once the landing is known to be at or
    // after the shown close, this block must always return, never fall through to the "at the final
    // close" wording below (which the timestamps beside it would then contradict). A lead too small
    // for gapPhrase's own floor (<=50ms) still gets an honest "~0.0s", and a genuinely UNKNOWN lead
    // (null) states only the landing time - it makes no "before the close" claim it cannot back up.
    if (d.lastBidLeadMs == null) return `\n⏱ *Last bid* - landed ${at}`;
    const sent = gapPhrase(d.lastBidLeadMs) || '0.0 s';
    return `\n⏱ *Last bid* - sent ${sent} before the close (landed ${at})`;
  }
  if (d.finalCloseUnknown || d.earlyCloseAtMs != null || d.lastBidGapMs == null) return `\n⏱ *Last bid* - ${at}`;
  // CW-267 (owner, 29 Sep 2026): when the close moved after our bid, the gap to the final close counts
  // the extension (260928NXAW read "5 min 4 s" for a bid that landed 5.0 s before its round closed).
  // Such a bid is timed to the close of the round it landed in.
  const round = d.lastBidRoundGapMs;
  // Only a known zero extension count keeps the final-close gap: an unknown count on a moved close
  // would print the extension as the bid's timing again.
  const noExtension = d.extensionsAfterLastBid != null && !(Number(d.extensionsAfterLastBid) > 0);
  if (round != null && !noExtension && d.lastBidGapMs - round >= 1000) {
    const g = gapPhrase(round);
    return `\n⏱ *Last bid* - ${g ? `${g} before the round close` : 'at the round close'} (${at})`;
  }
  const gap = gapPhrase(d.lastBidGapMs);
  return `\n⏱ *Last bid* - ${gap ? `${gap} before the final close` : 'at the final close'} (${at})`;
}
/**
 * Ruling 86-b (owner, 26 Sep 2026): the OBSERVED close-type line, one line directly under Closed,
 * on both the WON and LOST result receipts. Distinct from closeRuleOf/closeRuleCell (the ASK's
 * PUBLISHED rule, stated before the fact, on the price-request/rate receipt) - this states what
 * the round tracker actually OBSERVED happened on THIS load, from d.round (bidEngine._roundRecord:
 * { rounds, cap }) and d.closeModel/d.platformKey. No bids count here - the result already carries
 * "🔁 Attempts - N of M used". Phone-width by construction (well under 40 chars for any realistic
 * round/cap value).
 *
 *   hard              -> "🔒 No extension"
 *   soft, k and cap    -> "⏳ Auto extension · extended {k} of {cap}x"
 *   soft, k, no cap    -> "⏳ Auto extension · extended {k}x"          (cap dropped)
 *   soft, no k         -> "⏳ Auto extension"                          (extended clause dropped)
 *   gocomet, k known   -> "⏳ Auto extension · {k} rounds"
 *   gocomet, k unknown -> ''                                          (nothing else to say)
 *   close type unknown -> ''
 */
// null/undefined must read as unknown, never coerce to 0 (Number(null) is the finite 0, which
// would print "extended 3 of 0x" for a genuinely unpublished cap) - the explicit != null guard is
// load-bearing, not defensive filler.
const finiteOrNull = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

function closeTypeLine(d) {
  if (!d) return '';
  const round = d.round;
  const k = round ? finiteOrNull(round.rounds) : null;
  if (d.platformKey === 'gocomet') {
    return k != null ? `\n⏳ Auto extension · ${k} round${k === 1 ? '' : 's'}` : '';
  }
  // Review correction (26 Sep): a published cap of 0 is a hard window in disguise - the round
  // tracker's own verdict reason is 'hard_close' for exactly this shape (roundTracker.verdict:
  // hardCap === 0 -> reason 'hard_close'), even though closeModel still reads 'soft'. Keyed on the
  // verdict's own reason, not on cap === 0 alone, so a genuine soft load that happens to still read
  // cap 0/rounds 0 for some other reason is never reinterpreted as hard.
  if (d.closeModel === 'hard' || (round && round.reason === 'hard_close')) return '\n🔒 No extension';
  if (d.closeModel !== 'soft') return ''; // close type unknown
  const cap = round ? finiteOrNull(round.cap) : null;
  const extended = k != null ? ` · extended ${k}${cap != null ? ` of ${cap}` : ''}x` : '';
  return `\n⏳ Auto extension${extended}`;
}

function closedLines(d) {
  // The portal refused a write as "already ended" well before the close it published, so that close
  // never happened; state when it did end, as far as the record shows.
  if (d.earlyCloseAtMs != null && d.closeAtMs != null) {
    // The gap is taken from the whole second the line prints, so the two figures on it add up.
    const endedAt = Math.floor(d.earlyCloseAtMs / 1000) * 1000;
    return `\n⚠ Portal closed this auction early at ${fmtClockSecs(endedAt)}, `
      + `${gapPhrase(d.closeAtMs - endedAt)} before its published close (${fmtClock(d.closeAtMs)})`;
  }
  if (d.finalCloseUnknown) {
    const ranPast = d.finalCloseAt != null ? d.finalCloseAt : d.closeAtMs;
    return ranPast == null ? '' : `\n⏰ *Closed* - may have run past ${fmtClock(ranPast)}${closeTypeLine(d)}`;
  }
  if (d.closeAtMs == null) return '';
  const moved = d.postedCloseAt != null && Math.floor(d.postedCloseAt / 1000) !== Math.floor(d.closeAtMs / 1000);
  const n = Number(d.extensionsAfterLastBid);
  const extended = n > 0
    ? `\n⏳ Extended ${n} time${n === 1 ? '' : 's'} ${d.lastBidBeforeTriggerWindow ? 'by other bids after ours' : 'after our last bid'}` : '';
  return `\n⏰ *Closed* - ${fmtClockSecs(d.closeAtMs)}${moved ? ` (posted ${fmtClock(d.postedCloseAt)})` : ''}${closeTypeLine(d)}${extended}`;
}
// The one line of advice under a loss. The margin is named as the cause only when the record shows
// our last bid went out at the desk's lowest band margin and someone still ranked above us; every
// other loss keeps the neutral line, so a bot fault is never worded as a pricing one.
function lostAdvice(d) {
  // Owner ruling (26 Sep 2026): a lost_on_price load names the failure loudly, off the EXISTING
  // loss-cause classifier alone (reportedClose.resultReasonOf, carried as d.resultReason) - never a
  // second, independently-derived "was this really the lowest price" guess. Also requires the
  // actual figures (marginRate/marginPct) to be present: a classifier verdict with no number behind
  // it must not print a claim it cannot back up, so it falls through to the neutral line below.
  if (d && d.resultReason === 'lost_on_price' && d.marginRate != null && d.marginPct != null) {
    // Review correction (26 Sep): a hand-rebuilt sign (`Number(pct) >= 0 ? '+' : ''`) is true for
    // -0, so a pct already carrying its own "-" (a string like "-0.00") got "+-0.00%" - exactly the
    // bug signedPct exists to fix. Use it rather than re-deriving the sign here.
    return `❌ Outbid on price. Our lowest price, ₹${d.marginRate}${signedPct(d.marginPct)}, was on the board and another transporter bid lower. Winning this lane needs a lower margin.`;
  }
  // Owner ruling 91 (26 Sep 2026). Timing and undercut-while-leading losses get no line of their own.
  if (d && d.resultReason === 'hold_undercut') return '❌ Another transporter bid lower while this load was on hold.';
  const beaten = d && d.lastBidAtLowestMargin && d.finalRank != null && Number(d.finalRank) > 1 && d.marginPct != null;
  if (!beaten) return '📉 _A sharper rate on this lane wins the next one._';
  return `📉 Our last bid was at your lowest margin${signedPct(d.marginPct)}. Another transporter bid lower.`;
}
// One decimal under 10 s, whole seconds under 2 min, "X min Y s" above. null under 0.05 s, which
// the caller words as "at the final close" rather than print a zero or a negative gap.
function gapPhrase(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const tenths = Math.round(Number(ms) / 100);
  if (!(tenths > 0)) return null;
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const secs = Math.round(Number(ms) / 1000);
  if (secs < 120) return `${secs} s`;
  return `${Math.floor(secs / 60)} min ${secs % 60} s`;
}
// "hh:mm:ss am/pm", server-local like every other receipt clock.
function fmtClockSecs(ms) {
  const d = new Date(Number(ms));
  let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
  return `${pad2(h)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ap}`;
}
// "DD/MM/YYYY HH:MM" - the previous-quotes row timestamp.
function fmtQDate(ms) {
  try {
    const d = new Date(Number(ms));
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch (_) { return '-'; }
}
function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  try { return Number(n).toLocaleString('en-IN'); } catch (_) { return String(n); }
}
// A margin percent for display, trimmed of trailing-zero noise: 12 -> "12", 12.6 -> "12.6",
// 12.60 -> "12.6". These come straight off the configured band (marginsPct / minMarginPct), so
// this only tidies the printed form - it never recomputes a percent from a rounded price (which
// would drift). Non-finite input drops the figure rather than rendering "NaN"/"Infinity".
function fmtPct(p) {
  if (p == null || p === '') return '';
  const n = Number(p);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(2)));
}
// Guards a rank/finalRank slot the same way fmtNum guards a money slot - null AND finite, so a
// NaN/Infinity value (never producible by a real portal payload today) cannot reach the body.
function fmtRank(r) {
  return (r != null && Number.isFinite(Number(r))) ? r : '-';
}
function fmtVehicle(equipment, units) {
  if (!equipment && units == null) return '-';
  // A MULTI-TRUCK-TYPE equipment string already carries a count per type ("5 x 40 ft, 25 T + 1 x
  // 20 ft ODC, 10 T"), so prefixing the load's total renders "6 x 5 x 40 ft ..." and reads as a
  // rendering fault rather than as two counts. Detected off the STRING, not a portal name: a
  // SuperProcure equipment is a bare type ("32ft SXL") and can never match this.
  if (units != null && equipment && /^\d+(?:\.\d+)?\s*x\s/i.test(String(equipment))) return String(equipment);
  return units != null ? `${units} x ${equipment || '-'}` : String(equipment);
}
// "<n> <unit>" - declared load weight, in the shipper's OWN unit (SuperProcure's brancheUnit,
// captured onto the load as weightUnit - see realAdapter.js). Most BRL branches quote in MT,
// but several (e.g. Ashirvad Pipes) are KG; a hardcoded "MT" suffix mislabeled those numbers
// ~1000x too large (verified against SuperProcure's own weightUtilizationPercentage). Falls
// back to 'MT' only when the unit is genuinely unknown. Shared by this template's loadDetails()
// AND src/web/server.js's price-capture page - single source for the fallback rule so a future
// change to the default can't silently drift between the two surfaces again. '' when weight is
// absent so callers omit the line entirely, never a dangling unit with no number.
function fmtWeight(w, unit) {
  if (w == null || w === '' || !Number.isFinite(Number(w))) return '';
  const n = Number(w);
  const u = unit || 'MT';
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, '')} ${u}`;
}

// Join every point of one kind ('pickup' | 'drop'), '; '-joined - the single shared
// implementation of "every point of this kind". dropAddress (below) wraps it with the
// lane-fallback for message rendering; src/web/exports.js's CSV pointsCols() calls it
// directly, since a CSV cell has no lane to fall back to.
function addressesByKind(points, kind) {
  const pts = Array.isArray(points) ? points.filter((p) => p && p.address && p.kind === kind) : [];
  return pts.map((p) => p.address).join('; ');
}

// Full drop address(es) from the load's point list (they carry the pincode), else the lane city.
// A multi-drop load carries every drop point in L.points - join them all, don't collapse to
// the single lane.destination parseLane() picked (see pickupAddress for the mirrored gap this
// used to leave on the pickup side).
function dropAddress(L) {
  return addressesByKind(L && L.points, 'drop') || (L && L.lane && L.lane.destination) || '';
}

// Full pickup address(es) from the load's point list, else the lane city. Mirrors
// dropAddress(): a multi-pickup load carries every pickup point in L.points, but lane.origin
// (parseLane in realAdapter.js) only ever keeps the FIRST one - so without this, a load with
// 2+ pickup points silently lost every pickup after the first in the "From" line.
function pickupAddress(L) {
  return addressesByKind(L && L.points, 'pickup') || (L && L.lane && L.lane.origin) || '';
}

/**
 * The ask's two lane ends - `{ from, to }`, each "<city> <pin>", one per labelled line.
 *
 * TWO VALUES RATHER THAN ONE ARROW-JOINED STRING. The ask used to render both ends on a single
 * line. On SuperProcure that reads fine, because the portal publishes a city. GoComet publishes no
 * city field at all - the whole postal address IS the lane value - so the same line arrived at the
 * desk as two full addresses run together and the Director asked, in as many words, where the from
 * and the to were in it. Segregating them is his ask; the *From* / *To* labels are the ones the
 * won / lost / no_bid receipts already use, so this reads as the same product rather than a new
 * dialect. The labels stay in the template body, which is where every other label in this file
 * lives, and this returns only the parts.
 *
 * THE CITY IS NOT COMPOSED HERE. src/web/laneDisplay.js is the one rule for how a lane end is
 * written, already governing the price page and the console worklist; reading it here is what
 * makes the message agree with the page it links to instead of becoming a third rendering of the
 * same lane. It also carries the serve-time parse for GoComet records stored before the parser
 * existed, and bounds an address it cannot read down to a label rather than a paragraph.
 *
 * The pin is the disambiguator the Director asked for on 2026-07-27 ("the pin code appears when
 * you click the link but it should also appear in the message if possible") - several Vejalpurs
 * exist and the desk was opening the link to find out which one it was pricing.
 *
 * The FULL pickup/drop addresses are deliberately not here. They are on the /price page this
 * message links to, in its Pickup/Drop rows, where a postal address has room to be read - the same
 * split laneDisplay.js relies on to bound a lane cell at all.
 *
 * Degrades one end at a time: an end with no recoverable pin renders the bare city, and a
 * half-known lane keeps the "?" placeholder. `{from:'',to:''}` when there is no lane at all, so
 * the template's own `|| '-'` fallback still applies.
 */
/**
 * C075/D042/D043: the platform's display name, derived from the load's own platformKey - never a
 * hardcoded "SuperProcure" literal in a shared (both-platform) template. Absent means SuperProcure,
 * the same "absent = SuperProcure" rule every other per-record platform check in this codebase
 * follows (Notifier.notifyModeFor, priceRequests.platformOf).
 */
function platformName(d) {
  return (d && d.platformKey === 'gocomet') ? 'GoComet' : 'SuperProcure';
}

function laneEnds(L, platformKey) {
  const lane = (L && L.lane) || null;
  if (!lane || !(lane.origin || lane.destination)) return { from: '', to: '' };
  const H = withLaneDisplay(L, platformKey);
  const pins = laneEndPins(H);
  const cell = (city, pin) => (pin ? `${city} ${pin}` : city);
  return {
    from: cell(H.laneDisplay.origin, pins.from),
    to: cell(H.laneDisplay.destination, pins.to),
  };
}

// --- price_needed segments ----------------------------------------------------

/**
 * The ask's OA line - the shipper's own reference for this enquiry, above the portal's key.
 *
 * WHICH NUMBER IS WHOSE. The ask named only the portal's key, and that is not the number the desk
 * works by. The client settled it against Best Roadways' own portal notification, which renders
 * `Name:- <ref> (<key>)`: the one next to the name is the OA number, the one in brackets is the
 * portal's ID. So this line goes ABOVE the existing 🆔 line - same two values in the same order as
 * their own notification and as the /price page this message links to - and BOTH render, because
 * the ask is where a reply gets threaded and the desk needs to be able to quote either one.
 *
 * Its own emoji anchor rather than a second 🆔: the file's convention is one anchor per field, and
 * two identical anchors on adjacent lines is exactly what makes two numbers look like one field.
 *
 * LABELLED "OA", not "OA No". The *OA No* label already exists in this file - on price_submitted /
 * won / lost / no_bid / desk_notice - but it renders the PLATFORM LOAD ID there (engineAlerts sets
 * `oaNo: evt.auctionId`), so reusing it would put one label on two different numbers for the same
 * load. "OA" is the client's own word and is what the /price page prints.
 *
 * RENDERED VERBATIM. The client's example is a clean 3260108709, but real captured values include
 * `3262511465-5601270693 (E.com)` and `3260108996-10-12/08` - the shape varies between loads and
 * shippers. Nothing here splits, strips or extracts; a wrong OA number in front of a pricer is
 * worse than no OA number, and the page already passes the whole value through untouched.
 *
 * FIELD-GATED, never portal-gated. SuperProcure publishes no such field, so its ask renders byte
 * for byte as it did before - but that follows from the value being absent, not from a portal-name
 * test, so a portal that starts publishing one needs no change here.
 */
function oaLine(d) {
  const ref = d && d.shipperRef ? String(d.shipperRef).trim() : '';
  return ref ? `\n🔖 *OA* - ${ref}` : '';
}

/**
 * BC-36/GC-2: whether this load has more than one pickup or drop point, on its own line(s) right
 * under *To* since it is a fact about the LANE. Shares laneDisplay.twoPointFacts with the /price
 * page's own tile so the ask and the page cannot state this differently for the same load. An
 * extra pickup and an extra drop each get their OWN labelled line - joining them onto one "Also"
 * line let an extra drop read as an extra pickup, which changes the route the desk prices. Empty
 * string (never a line with nothing after the label) on a single-point load with no free-text
 * signal either - see twoPointFacts for the structured-vs-free-text precedence.
 */
function twoPointLine(d) {
  const facts = twoPointFacts(d);
  if (facts.pickup || facts.drop) {
    return (facts.pickup ? `\n📍 *Also pickup* - ${facts.pickup}` : '')
      + (facts.drop ? `\n📍 *Also drop* - ${facts.drop}` : '');
  }
  return facts.freeText ? `\n📍 *Also* - ${facts.freeText}` : '';
}

// The minimal ask HEADER: "CUSTOMER . BRANCH" (e.g. "Havells . Alwar"). Prefers d.shipperName (the
// matched customer's clean label) over d.shipper (the raw platform string, kept elsewhere as the
// scope-routing key), and appends SP's branch label when the load carries one so the desk knows
// which branch of a multi-branch shipper it is before opening the link. Never a dangling separator.
function headerCell(d) {
  const base = (d && (d.shipperName || d.shipper)) || '-';
  const branch = d && d.branch ? String(d.branch).trim() : '';
  // CUSTOMER · BRANCH - the separator is a MIDDLE DOT (U+00B7), not a period, so "Havells ·
  // Alwar" reads as one label rather than an abbreviation with a full stop (Director, 2026-07).
  return branch ? `${base} · ${branch}` : base;
}

// "vehicle . weight" on one line (e.g. "1 x 32FT . 18 MT"). Weight uses the load's OWN unit
// (fmtWeight reads d.weightUnit - most BRL branches are MT, some like Ashirvad Pipes are KG), and
// the " . <weight>" half is dropped entirely when weight is absent, leaving just the vehicle. A
// 32FT at 7MT vs 25MT prices very differently, so weight earns its place even in the minimal ask.
function vehicleWeightCell(d) {
  const veh = (d && d.cargo) || '-';
  const wt = d ? fmtWeight(d.weight, d.weightUnit) : '';
  // BC-35: the truck's own size ("32'x8'x8'8\""), GoComet's punctuation verbatim, appended when
  // the load carries one and dropped entirely otherwise - the desk asked for dimensions, not a
  // third dash on every load that has none. This scalar belongs to a single-cargo-type load;
  // multi-type sizes stay attached to their respective rows below.
  const dim = (d && d.dimensions) ? String(d.dimensions).trim() : '';
  const base = [veh, wt, dim].filter(Boolean).join(' . ');
  // SEVERAL TRUCK TYPES ON ONE LOAD -> ONE LINE EACH, in the shape the single-type line already
  // uses, so a multi-type load reads as N of a line the desk knows rather than as a new format.
  // Joining them onto one line was the defect: a variable-length list appended to a line that
  // already has content wraps mid-phrase on a phone, and "10" and "T" end up on different lines.
  // Two lines each opening with the truck glyph also say "two truck types" without counting them
  // out, which is why the old "2 truck types - " prefix is gone rather than moved.
  //
  // The weight half is dropped here on purpose. It is a PER-UNIT declared weight with no type
  // attribution, so repeating one figure against both lines would state something about each truck
  // type that the wire never said. In practice readLoadSpec publishes none on a multi-descriptor
  // load anyway - this is the belt for the case where it does.
  const types = Array.isArray(d && d.cargoTypes) ? d.cargoTypes.filter((t) => t && t.label != null && t.count != null) : [];
  if (types.length > 1) return types.map((t) => `${t.count} x ${t.label}${t.dimensions ? ` . ${t.dimensions}` : ''}`).join(`\n${VEHICLE_GLYPH} `);
  return base;
}

// The ask's per-tonne instruction, ONE line right under the vehicle line, ONLY on a load gated by
// discovery.isPmtBasis (d.pmtBasis, set by notifier._priceNeededData off the same predicate the
// page and the engine use). A per-tonne load's vehicle line already dropped the truck-count prefix
// (see fmtVehicle's PMT call site in notifier.js), which on its own reads as a load with no truck
// count at all - this line is what tells the desk the number they type next is a RATE PER MT, not
// the whole-load figure that was landing in that field (Vishal Pipes, 2026-09-28 diagnosis: every
// per-tonne cost typed for that customer was a whole-load magnitude, 20-40x the intended per-MT
// rate). '' on every other load, so the ask renders byte-identically to today.
function pmtNoteLine(d) {
  return d && d.pmtBasis ? '\n⚖️ *Per tonne* - enter your rate per MT, not the truck total' : '';
}

// The same cell for an OUTCOME payload, whose vehicle arrives as `vehicleType` (engineAlerts builds
// it with fmtVehicle) rather than the ask's `cargo`. Routed through vehicleWeightCell rather than
// rendering vehicleType directly so the two surfaces cannot drift on how a vehicle is written -
// today the engine event carries no weight, so this renders the vehicle alone; if weight is ever
// threaded onto the outcome the cell picks it up with no change here.
function outcomeVehicleCell(d) {
  if (!d || !d.vehicleType) return '';
  return `\n${VEHICLE_GLYPH} ${vehicleWeightCell({ cargo: d.vehicleType, weight: d.weight, weightUnit: d.weightUnit })}`;
}

// The transit-required line for the minimal ask - its own short line under the close time, ONLY on a
// load whose loadIsTransitTimeOn rule flag is set (d.needsTransitTime): SuperProcure rejects a bid on
// those unless it carries transit days (proven live on SIKA - null -> HTTP 400), so the ask must say
// "days too, not just the rate"; the capture page then requires the field. '' on every other load, so
// the minimal ask stays five lines for the customers priced today - do NOT lose this line.
// GoComet publishes no per-load limits before bidding: every enquiry auto-extends, allows each vendor 3
// revisions, and is final after the plant's round cap (the engine's default is 3 when none is set).
const GC_REVISIONS = 3;
const GC_DEFAULT_ROUNDS = 3;

/** How a request's auction closes and how many bids it allows, from what the portal published. */
function closeRuleOf(request, platform) {
  const L = (request && request.load) || {};
  const posInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (platform === 'gocomet') {
    const rp = request && request.roundPolicy;
    const rounds = rp && 'finalAfterExtensions' in rp ? rp.finalAfterExtensions : GC_DEFAULT_ROUNDS;
    return { autoExtends: true, extendSeconds: null, extendCount: null, rounds: posInt(rounds),
      bids: posInt(L.revisionLimit) || GC_REVISIONS };
  }
  return { autoExtends: L.closeModelKnown === true ? !!L.softClose : null,
    extendSeconds: posInt(L.extendSeconds), extendCount: posInt(L.extendCount), rounds: null,
    bids: posInt(L.revisionLimit) };
}

// One phone-width line under the close time. A segment the portal does not publish is left out; with
// neither fact there is no line.
function closeRuleCell(d) {
  const r = d && d.closeRule;
  if (!r) return '';
  const parts = [];
  let glyph = '🔁';
  if (r.autoExtends === true) {
    glyph = '⏳';
    parts.push('Auto extension');
    const s = r.extendSeconds;
    const step = s ? `+${s % 60 === 0 ? s / 60 : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`} min` : '';
    const times = r.extendCount ? `${r.extendCount}x` : '';
    if (step || times) parts.push([step, times].filter(Boolean).join(', '));
    if (r.rounds) parts.push(`${r.rounds} rounds`);
  } else if (r.autoExtends === false) {
    glyph = '🔒';
    parts.push('No extension');
  }
  if (r.bids) parts.push(`${r.bids} bids`);
  return parts.length ? `\n${glyph} ${parts.join(' · ')}` : '';
}

function transitLineMin(d) {
  if (!d || !d.needsTransitTime) return '';
  return '\n🚚 Enter transit days with the rate';
}

// The shipper's EXTRA NOTE (SP load note) - shown once, just above the Previous-Quotes block.
// BRL's original template echoed this a second time right under "Hello!" too; dropped as pure
// duplication (same text, no new information, extra vertical space before the fold).
function extraNoteBottom(d) {
  const note = d && d.extraNote ? String(d.extraNote).trim() : '';
  return note ? `\n\n📝 *EXTRA NOTE* - ${note}` : '';
}

// "Load #" is the SP load id (see notifier.js) - SP's own friendly enquiry code is appended
// alongside it, when present, so a won/lost can be correlated back to this enquiry. The ask sets
// `name` (= loadId); the won/lost payload carries the same id as `oaNo` (engineAlerts.toNotification),
// so oaNo is the final fallback - the win/loss OA-No line reuses this cell and picks up the SP code
// too, keeping the "23423905 (HAV-0912)" form consistent between the enquiry ask and its outcome.
function loadNumberCell(d) {
  const base = (d && (d.name || d.loadId || d.oaNo)) || '-';
  return d && d.loadCode ? `${base} (${d.loadCode})` : base;
}

// The SuperProcure account an account-wide alarm is about, in the operator's own words. Prefers the
// human label off the account record (accounts.validateAccount defaults it to the accountId), falls
// back to the id, and finally to a generic phrase so the message still reads as a sentence when it
// is rendered with no data at all - scripts/test-desk-voice.js renders every template against {}.
function accountName(d) {
  const s = d && (d.accountLabel || d.accountId);
  return s ? String(s).trim() : 'a SuperProcure login';
}

// The line that tells the reader whether this outage is an emergency or a no-op, per the
// Director's instruction: name the customers that won't be able to bid, not just the account.
// `d.affectedCustomers` is computed at the raiser (src/model/coverage.js), never here - this is
// pure rendering. Empty/missing (a payload with no list at all, or a genuinely unaffected
// account like the three that were dead-but-zero-impact) reads as reassurance rather than
// silence, so the desk never has to guess whether "no customers" means "we checked" or "we
// forgot to check".
function affectedCustomersLine(d) {
  if (d && d.affectedUnknown) return 'Could not work out which customers this affects - check the Price Requests page for loads on this login before assuming nothing is going unbid.';
  const names = (d && Array.isArray(d.affectedCustomers) ? d.affectedCustomers : []).filter(Boolean);
  if (!names.length) return 'No customers are affected - nothing is going unbid because of this.';
  return `This affects ${names.join(', ')} - their loads will close with no bid until this is fixed.`;
}

// The *Name* line: the shipper's display name, plus - for a multi-branch shipper - SP's branch
// label in parens ("Renewsys India (REN-K)"), so the desk knows WHICH branch before opening the
// link. The branch shown is the RAW SP label the portal displays, not the URL's cleaned slug.
function nameCell(d) {
  const base = (d && (d.shipperName || d.shipper)) || '-';
  return d && d.branch ? `${base} (${d.branch})` : base;
}

// Weight/shipment type/product/distance: captured on the load snapshot (createForLoad) but
// until now silently dropped (weight, shipmentType, productName) or never captured at all
// (distance) before reaching this template. A 32FT truck at 7MT vs 25MT prices completely
// differently, so these are grouped right under Vehicle Type. Each line renders only when SP
// actually sent that field - never a dangling blank label.
// Weight's unit is d.weightUnit (SuperProcure's own brancheUnit) - most BRL branches quote in
// MT, but several (e.g. Ashirvad Pipes) are configured in KG; a hardcoded "MT" suffix
// mislabeled those numbers ~1000x too large (verified against SP's own
// weightUtilizationPercentage). Falls back to 'MT' only when the unit is genuinely unknown.
function loadDetails(d) {
  if (!d) return '';
  let s = '';
  const wt = fmtWeight(d.weight, d.weightUnit);
  if (wt) s += `\n⚖️ *Weight* - ${wt}`;
  if (d.shipmentType) s += `\n📦 *Shipment Type* - ${d.shipmentType}`;
  if (d.productName) s += `\n🏷️ *Product* - ${d.productName}`;
  if (d.distanceKm != null && d.distanceKm !== '') s += `\n📏 *Distance* - ${d.distanceKm} km`;
  return s;
}

// Transit-required loads only (d.needsTransitTime, from the load's own loadIsTransitTimeOn rule
// flag): SuperProcure rejects a bid on these loads unless it carries transit days (proven live on
// SIKA), so the ask itself must say "days too, not just the rate" - the capture page then requires
// the field. Renders as its own field-style line right under Bid Close Time; '' on every other
// load, so nothing changes for the customers priced today.
function transitNote(d) {
  if (!d || !d.needsTransitTime) return '';
  return '\n🚚 *Transit Time* - _required: enter the delivery days along with your rate on the page above_';
}

// The one case where pricing SHOULD open the SP portal before quoting - a rate annexure,
// packing list, or ODC drawing sits there, not in this message. Renders only when SP flagged
// either presence; never a permanent line.
function portalNote(d) {
  if (!d || !(d.hasPortalComments || d.hasPortalAttachments)) return '';
  return '\n\n📎 _More detail on the SP portal (comments/attachments) - check before quoting._';
}

// The "Previous Quotes on the Same Route" section, or '' when there are no quotes (so the header
// never dangles over nothing on a new lane). Laid out TWO lines per bid, with the vehicle stated
// ONCE in a block header:
//   📌 *Previous Quotes on the Same Route*
//   🚛 all 1 x Dala Body LPT - 22Ft
//
//   💵 ₹58,000 → we bid ₹63,780
//   🏅 Rank 2  |  17/07/2026 14:51
// The money line leads with the operator's own entered rate when the row carries both it and a
// distinct placed bid (quoteAmount below); it collapses to the single "₹<amount>" otherwise. One
// blank line separates the header block from the first pair; there is NONE between pairs (the 💵
// emoji is the pair delimiter). `at` may be an epoch (formatted here) or a pre-formatted string.
//
// History of this block's shape:
//  - 2026-07-16: a per-row vehicle label was added between amount and rank, because the Director
//    could not tell Rs 48,692/48,240 were 20ft-container rates surfacing on a 32ft load. That was
//    a one-line row ("💵 ₹16,620  |  1 x 32ft  |  Rank: 2  |  17/04/2026 20:24").
//  - 2026-07-17: on a phone that one-liner ran ~65 chars against WhatsApp's ~35-40 char wrap and
//    folded into unreadable stairs. Re-laid as two lines per bid. The vehicle moves to a single
//    "🚛 all <vehicle>" header line taken from the PRICED LOAD's own vehicle field (d.cargo, the
//    same value the message's Vehicle Type line shows) - NOT the rows: post-#42 routeHistory
//    hard-matches equipment, so every surviving row is guaranteed the load's vehicle and stating
//    it once is truthful. The 🚛 line is omitted entirely when the load's vehicle is absent (the
//    blank line before the first pair is preserved). 🏅 mirrors the lost template's ranking emoji.
//    Per-row equipment stays in the routeHistory projection for other consumers; it is just no
//    longer rendered per row.
function quotesBlock(d) {
  if (d && typeof d.quotesText === 'string') return d.quotesText;
  const rows = d && Array.isArray(d.quotes) ? d.quotes : [];
  if (!rows.length) return '';
  const pairs = rows.map((q) => {
    const rank = q && q.rank != null ? q.rank : '-';
    const at = q && q.at != null ? (typeof q.at === 'number' ? fmtQDate(q.at) : q.at) : '-';
    return `💵 ${quoteAmount(q)}\n🏅 Rank ${rank}  |  ${at}`;
  });
  // The vehicle, stated once, from the PRICED LOAD's own field (d.cargo) - not the rows. Omitted
  // when the load carries no vehicle (fmtVehicle returns '-'), leaving the header directly above
  // the first pair with the separating blank line preserved.
  const vehLine = d && d.cargo && d.cargo !== '-' ? `\n🚛 all ${d.cargo}` : '';
  return `\n\n📌 *Previous Quotes on the Same Route*${vehLine}\n\n${pairs.join('\n')}`;
}

// The money value of one previous-quote row (the part after the 💵 emoji). When the row carries
// BOTH the entered rate and a DISTINCT placed bid, it leads with the operator's own number -
// "₹52,000 → we bid ₹56,300" - so the reference reads as "we quoted 52,000, the bot walked it to
// 56,300", not an unanchored figure. Collapses to the single "₹<amount>" whenever only one number
// is present or the two are equal - a never-bid load (amount = the entered cost) or a legacy row
// that only carries `amount`. Never a dangling arrow with a missing operand.
function quoteAmount(q) {
  const rate = q && q.rate != null ? q.rate : null;
  const bid = q && q.bid != null ? q.bid : null;
  if (rate != null && bid != null && rate !== bid) return `₹${fmtNum(rate)} → we bid ₹${fmtNum(bid)}`;
  const amt = q && q.amount != null ? fmtNum(q.amount) : '-';
  return `₹${amt}`;
}

// The receipt's bidding-contract line: what the bot will actually do with the entered rate - open
// high, ease down, never drop below the operating floor - each rung shown as "your rate + margin%"
// so the number the operator typed stays the anchor they can map every bid back to. Rendered only
// when the armed rung prices AND both band percents are known; a scheduled/legacy capture with no
// ladder, or a rate-model demo that carries no band, omits the whole line so the receipt reads
// exactly as before - never a dangling "₹-" or "+ undefined%". Percents come from the band, never
// recomputed off the rounded prices (see confirmSubmitted).
function biddingContract(d) {
  if (!d) return '';
  const { openingBid, floorBid, openingPct, floorPct } = d;
  if (openingBid == null || floorBid == null || openingPct == null || floorPct == null) return '';
  // On a load priced per truck type the rung prices are the ladder's own blended-base figures, and
  // no truck is quoted at either of them - each line carries the same margin over its OWN rate. So
  // state the margin and drop the two rupee anchors rather than print a pair of numbers that will
  // not appear on any quote.
  //
  // THE PERCENTS ARE DERIVED FROM THE RUNGS AGAINST THE BLENDED BASE. openingPct/floorPct are
  // measured against the blended cost, and no truck is quoted at that cost - price / base is
  // exactly the multiplier resolvePerTypePrices applies to each line, so a figure derived from it is
  // true per line by construction.
  const base = blendedBase(d);
  // One price (a shipper ceiling below the lowest band price, or equal to it): "from X, never below X"
  // describes a walk that does not exist.
  const once = Number(openingBid) === Number(floorBid);
  if (perTypeRates(d) && base) {
    if (once) return `\n📈 *We'll bid once* - +${fmtPct((floorBid / base - 1) * 100)}% on each rate above`;
    return `\n📈 *We'll bid from* - +${fmtPct((openingBid / base - 1) * 100)}% on each rate above, never below +${fmtPct((floorBid / base - 1) * 100)}%`;
  }
  if (once) return `\n📈 *We'll bid once* - ₹${fmtNum(floorBid)} (+${fmtPct(floorPct)}%)`;
  return `\n📈 *We'll bid from* - ₹${fmtNum(openingBid)} (+${fmtPct(openingPct)}%), never below ₹${fmtNum(floorBid)} (+${fmtPct(floorPct)}%)`;
}

// A per-load margin the desk confirmed below the customer's minimum, figures first, so the group can
// see what was set and what it went under without opening the load. '' on every other receipt.
function belowMinimumNote(d) {
  const b = d && d.belowMinimum;
  if (!b || b.marginPct == null || b.customerMinPct == null) return '';
  return `\n⚠️ *${fmtPct(b.marginPct)}% margin* - below this customer's ${fmtPct(b.customerMinPct)}% minimum, confirmed on the price page`;
}

// The "first bid" clause of a bid-live alert. When the entered rate is known it frames the opening
// bid against the operator's own number - "First bid ₹50,400 - your rate ₹45,000 + 12%" - carrying
// the anchor into the live alert too. Falls back byte-identically to "First bid placed at ₹X." when
// the cost or the opening margin pct is absent (a rate-model / mock bid that never carried a band).
function bidLiveDetail(d) {
  const price = d && d.price != null ? fmtNum(d.price) : '-';
  // A LOAD PRICED PER TRUCK TYPE HAS NO SINGLE "your rate", AND NO SINGLE FIRST BID. Both numbers in
  // the clause below are the blended per-unit figure the ladder walks: the adapter re-applies the
  // rung to each type's own cost, so what actually went on the wire is one price per freight line
  // and neither of these appears on any of them. Printing them here is the CW-213 defect on the
  // louder message - the desk reads "your rate ₹39,333" seconds after a receipt showing the 45,000
  // and 28,000 it typed. The margin is the part that IS uniformly true, because the multiplier is
  // the same on every line, so state that and drop the two figures rather than name a quote that
  // does not exist. Same wording as the receipt's biddingContract, so the two bubbles agree.
  const base = blendedBase(d);
  if (perTypeRates(d) && base && d && d.price != null) {
    return `First bid placed at +${fmtPct((Number(d.price) / base - 1) * 100)}% on each of your rates.`;
  }
  if (d && d.cost != null && d.openingPct != null) {
    return `First bid ₹${price} - your rate ₹${fmtNum(d.cost)} + ${fmtPct(d.openingPct)}%.`;
  }
  return `First bid placed at ₹${price}.`;
}

// The desk's OWN entered cost - what BRL calls the market rate, and the anchor every other money
// figure on an outcome is stated against. '' when no cost was captured, so no receipt prints a bare
// "₹-". Shared by the three money blocks below AND by the lost_short reply, which the Director asked
// to carry the rate as well as the margin.
function yourRateLine(d) {
  if (!d || !d.marketRate) return '';
  return `\n💰 *Your Rate* - ₹${d.marketRate}`;
}
// won/lost money detail. Present ONLY when we have an entered cost (a band-model outcome with a
// found closed-bids record); returns '' on the rate-model demo / a missing record - so we never
// print a bare "₹-" or "Market -: -%". Grouped after Vehicle Type.
function wonMoney(d) {
  if (!d || !d.marketRate) return '';
  let s = yourRateLine(d);
  if (d.wonRate) s += `\n🏆 *Won Rate* - ₹${d.wonRate}${signedPct(d.marginPct)}`;
  s += rateChangedLine(d);
  return s;
}
// A win the desk has since priced ABOVE what we won at - a real loss on the books - stated on line 2
// of the receipt, inside the headline block, before any field. Owner's ruling 2026-09-16: "this is
// high priority part can't be hidden inside a message... maybe a tweak in the top part of the
// message?" It used to render mid-body as one of eleven field lines, which is the placement he
// objected to.
//
// The rupee gap, not a percentage: the headline margin is anchored on the bid-time cost (CW-212) and
// stays positive on this very load, so a second, negative percentage beside it would read as a
// contradiction. "Please check on portal" is the only action still open once the auction is closed.
//
// Two tiers, and only this one escalates. A correction the won rate still covers sets neither field
// (engineAlerts.outcomeEnrichment) and stays with the ℹ️ trail in the money block, which explains the
// margin where the margin is. Provenance below, consequence on top - stated once each.
// The headline BLOCK: win header, then the cost alert, then the route. wonHeader returns the header
// alone or header + route on its own line; the alert is SPLICED between the two rather than
// appended, because the owner ruled (2026-09-16) that a below-cost win outranks the route - it is a
// loss, and it is the first thing a reader must see after the win itself.
function wonHeadline(d) {
  const header = wonHeader(d);
  const alert = wonCostAlert(d);
  if (!alert) return header;
  const nl = header.indexOf('\n');
  return nl === -1 ? header + alert : header.slice(0, nl) + alert + header.slice(nl);
}

function spRankHeadline(d) {
  const context = [d.shipperName || d.shipper, d.branch].filter(Boolean).join(' - ').replace(/[\r\n]+/g, ' ');
  const header = context ? `*RANK 1 - ${context}*` : '*RANK 1*';
  const warning = wonCostAlert(d).replace('won amount', 'quote');
  const route = outcomeParts(d).route;
  return header + warning + (route ? `\n${route}` : '');
}

function wonCostAlert(d) {
  if (!d || !d.costCorrectedTo || !d.belowCostBy) return '';
  return `\n⚠️ *Cost increased to* ₹${d.costCorrectedTo} - ₹${d.belowCostBy} above the won amount. Please check on portal.`;
}
function lostMoney(d) {
  if (!d || !d.marketRate) return '';
  return yourRateLine(d) + ourBidLine(d) + rateChangedLine(d);
}
// HOW THE RATE ON THE LINE ABOVE GOT THERE. Rendered directly under the bid line, which is where
// the margin it explains sits - a corrected-cost margin can be negative on a bid that was correct
// when it went out, and a negative figure with its cause on the next line is read as one fact.
// Moving it away from that line is what this copy exists to prevent.
//
// Plain info, no ⚠️ (F-C, owner, 2026-09-11): the desk correcting a rate is the system working,
// and the glyph this replaced read as a fault report. Rides on a loss as well as a win, because
// the margin moved there for the same reason.
function rateChangedLine(d) {
  if (!d || !d.rateChangedFrom || !d.rateChangedTo) return '';
  return `\nℹ️ *Rate changed* - ₹${d.rateChangedFrom} -> ₹${d.rateChangedTo}`;
}
// Our placed bid line. The margin rides INLINE on it rather than on a line of its own: the Your
// Rate line directly above already names the rate, and a separate "Last Bid - Margin% - your rate
// 75,000: 3.60%" made "your rate" the third mention of one number in three consecutive lines
// (F-C / Image 11). Degrades to the bare bid amount when only the amount is known, and to '' with
// no bid. Shared by lostMoney (the full loss note) and the lost_short reply so the two never drift.
function ourBidLine(d) {
  if (!d || !d.marginRate) return '';
  return `\n🧮 *Our Bid* - ₹${d.marginRate}${signedPct(d.marginPct)}`;
}
// The margin as a signed parenthetical. Signed because it is measured against the cost the desk
// LAST entered, so a load re-priced up after the bid landed reports a negative - a hardcoded "+"
// would render "+-16.82%".
function signedPct(pct) {
  if (pct == null) return '';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '';
  // T6 BH-INV-3/LOGIC-5/BOUNDARY-3: `n >= 0` is TRUE for -0 in JS (a fraction just below zero,
  // rounded to "-0.00" by the caller's toFixed(2)), so appending the ORIGINAL string's own "-"
  // after a "+" this check just chose printed "(+-0.00%)". Derive the sign from the string itself,
  // never re-derive one from `n` and then splice it onto text that already carries its own.
  const s = String(pct).trim();
  const negative = s.startsWith('-');
  const magnitude = negative ? s.slice(1) : s;
  return ` (${negative ? '-' : '+'}${magnitude}%)`;
}
// The live-status link, pinned at the BOTTOM of a status-bubble state (bid_placed, bidding_live).
// The call-to-action is plain English on its OWN line and the URL sits on the LINE BELOW it (not
// inline after a colon) - and it deliberately AVOIDS the word "reprice" (Director: unclear jargon).
// It mirrors the intent of the ask's own link CTA - the ask points the desk at the SAME /price page
// (a bare "👉 <link>") to enter their rate - so this reuses the plain "tap the link to ... your
// rate" phrasing and adds "see live rank" (that page short-polls live rank, #72). It doubles as the
// live-truth escape hatch when a bubble edit past Maytapi's ~15-min window silently no-ops. '' when
// no link is known (dashboard-mode / no receipt carried one), so the bubble never dangles a label.
function liveLinkCta(d) {
  const link = d && d.changeLink ? String(d.changeLink).trim() : '';
  return link ? `\n\n👉 _Tap to see live rank and update your rate:_\n${link}` : '';
}
// The bid LOG lines for the bid_placed bubble - one per bid, most-recent-last, "hh:mm AM/PM · Rs X ·
// rank N" with a MIDDLE DOT (U+00B7) field separator. Each engine bid APPENDS a line (the notifier
// stores the running log on the thread; see askThread.appendBubbleBid) and the SAME bubble is
// re-edited, so the desk watches one bubble grow instead of a message per bid. Bounded: only the
// most recent BIDLOG_SHOWN lines render, prefixed with a "... N earlier bids" count when the total
// (d.bidCount) exceeds what's shown, so the bubble can't grow without limit. Each field is dropped
// when absent (a null socket rank omits "· rank N") rather than printing a blank. '' with no bids.
function bidLogLines(d) {
  const bids = d && Array.isArray(d.bids) ? d.bids : [];
  if (!bids.length) return '';
  const recent = bids.slice(-BIDLOG_SHOWN);
  const total = d.bidCount != null && Number.isFinite(Number(d.bidCount)) ? Number(d.bidCount) : bids.length;
  const lines = recent.map((b) => {
    const t = b && b.ts != null ? fmtClockUpper(b.ts) : '';
    const price = b && b.price != null ? `Rs ${fmtNum(b.price)}` : '';
    const rank = b && b.rank != null ? `rank ${b.rank}` : '';
    return [t, price, rank].filter(Boolean).join(' · ');
  });
  const hidden = total - recent.length;
  const head = hidden > 0 ? [`_...${hidden} earlier bid${hidden === 1 ? '' : 's'}_`] : [];
  return '\n' + head.concat(lines).join('\n');
}
// The statement a separate last-resort notice used to make, carried by the bubble that already shows
// the bid. Only while that bid is the latest one: "nothing more goes out" is false under a later bid.
function finalBidLine(d) {
  const bids = d && Array.isArray(d.bids) ? d.bids : [];
  const last = bids[bids.length - 1];
  if (!last || !last.final || last.price == null) return '';
  return `\n\n🏁 *Final bid* - Rs ${fmtNum(last.price)}, our lowest on this load. Nothing more goes out; the result follows at close.`;
}
// The loud loss HEADER - the FIRST line of the lost receipt. WhatsApp's chat-list preview shows
// only a message's first line, so leading with this makes "WE LOST" the glanceable outcome (the
// receipt used to bury it at the very bottom - Director feedback, 2026-07). Names the customer
// (d.shipper) and a short origin -> destination route (d.origin / d.dest, the lane cities, NOT the
// full pincode addresses in from/to) so the preview is self-explanatory about WHICH load we lost.
// Degrades cleanly: customer + route when both are known, either one alone when only one is, and a
// bare "WE LOST THIS ONE" when neither is (a rate-model / point-less load) - never a dangling
// separator or empty parens. Honest and direct, not doom - this is a BRL-staff group. lost-only:
// won has its own celebratory opener and is deliberately left untouched.
function lostHeader(d) {
  // Owner ruling (26 Sep 2026): name the failure point in the headline itself for a lost_on_price
  // load - every other reason (including "unknown") keeps the plain "LOST" verdict unchanged.
  if (d && d.resultReason === 'lost_on_price') {
    return outcomeHeader('🔴', 'LOST ON PRICE', '🔴 *LOST ON PRICE*', d);
  }
  return outcomeHeader('🔴', 'LOST', '🔴 *WE LOST THIS ONE*', d);
}
// The NO-BID HEADER - the FIRST line of the no_bid receipt, the structural twin of lostHeader
// (same customer/route degrade ladder, same chat-list-preview reasoning) with a different verdict.
// Amber, not red: nothing was lost on price here - the load simply never took a bid from us, which
// is an operational miss to go look at, not a competitive defeat. Reuses lostHeader's context
// builder so the two can never drift apart on how a customer + lane is written.
function noBidHeader(d) {
  return outcomeHeader('⚠️', 'NO BID PLACED', '⚠️ *NO BID PLACED*', d);
}
function unknownHeader(d) {
  return outcomeHeader('⏳', 'RESULT NOT YET KNOWN', '⏳ *RESULT NOT YET KNOWN*', d);
}
const RESULT_UNKNOWN_ADVICE = 'The portal has not confirmed the final rank yet. Check the enquiry before placing a vehicle.';
// THE ROUTE GETS ITS OWN LINE when the customer is also known - Director feedback 2026-08-19: a
// bracketed lane opening on the header line and wrapping onto the next reads badly on a phone.
// Customer stays on line 1 so WhatsApp's chat-list preview still shows the verdict and the customer;
// only the lane moves down. When just one of the two is known there is nothing to wrap, so it stays
// in the dash position exactly as before.
function outcomeHeader(icon, verdict, fallback, d) {
  const { customer, route } = outcomeParts(d);
  if (customer && route) return `${icon} *${verdict} - ${customer}*\n${route}`;
  const ctx = customer || route;
  return ctx ? `${icon} *${verdict} - ${ctx}*` : fallback;
}
// "customer (origin → dest)" - the shared context cell behind lostHeader and noBidHeader. Degrades
// cleanly: both when known, either alone when only one is, '' when neither (a rate-model / point-less
// load) - never a dangling separator or empty parens.
//
// THE ROUTE IS THE SHORT CITY+PIN PAIR (laneFrom/laneTo, built by laneEnds - the same one rule the
// ask, the /price page and the console lane column all render through), NOT origin/dest. On
// SuperProcure the two are the same string and nothing changes. On GoComet they are not: the portal
// publishes no city field, so lane.origin/destination ARE the whole postal addresses, and this cell
// interpolated both of them into the first line of every loss - which is the message the Director
// pasted back on 2026-08-19 asking for the addresses out. origin/dest stay the fallback for a
// payload built before laneFrom/laneTo were threaded (engineAlerts.notifyEngineEvent) and for a
// rate-model outcome with no lane to parse.
// '' for a lane end laneEnds could not place, the end's own text otherwise. THE ONE DEFINITION of
// that rule - every surface that joins two ends into a route goes through it, because the third
// hand-rolled copy of the predicate is exactly how a placeholder reached the desk once already.
//
// laneEnds names an end it cannot place '?', then still welds on any pin it recovered separately -
// so an unknown end arrives as '?' OR '? 209304'. Both mean "not placed", and the second is the
// worse of the two to print: a bare pin beside a question mark reads as a located address, and a
// pin with no city is not something the desk can route a truck by. Both are TRUTHY, so a caller
// that tests the raw value takes its two-ended branch and prints them verbatim.
//
// Dropped at the render surfaces rather than in laneEnds because the ask and the /price page render
// that placeholder deliberately, and rather than in engineAlerts because a dropped cell would fall
// through to the raw lane string - re-opening the 400-character address this whole change exists to
// remove.
function placeableEnd(v) {
  const s = String(v || '').trim();
  return (s === '?' || s.startsWith('? ')) ? '' : s;
}
function outcomeParts(d) {
  const customer = d && d.shipper ? String(d.shipper).trim() : '';
  const end = (short, raw) => placeableEnd(d && (d[short] || d[raw]));
  const from = end('laneFrom', 'origin');
  const to = end('laneTo', 'dest');
  return { customer, route: from && to ? `${from} → ${to}` : (from || to) };
}
// The money line on a no-bid outcome: the desk's OWN entered rate and nothing else. Deliberately
// never renders an "Our Bid" line or a margin % - by definition nothing was bid, so there is no
// placed amount and no realized margin, and printing either would contradict the header. '' when no
// cost was captured (a rate-model / mock outcome), so the receipt never shows a bare "₹-".
function noBidMoney(d) {
  // ...with ONE exception, which is why this is not just yourRateLine. On a per-type refusal
  // marketRate is the truck-weighted blend - outcomeEnrichment reads it off the closed-bids record's
  // arm-time `cost` (engineAlerts.js:497) - so printing it under "Your Rate" contradicts this
  // receipt's own sentence saying the load was priced per truck type. The entered rates are on no
  // outcome payload (only bid_live and the submit receipt carry rateByType), so there is nothing
  // true to print in its place and the line is dropped.
  if (d && d.noBidReason === 'per_type_rates_unmatched') return '';
  return yourRateLine(d);
}

// The desk-notice trio. Each degrades to something honest and short when a fact is missing, and
// each keys on the RECORDED reason - never on an inference - exactly like noBidWhy below. A notice
// whose reason we do not recognise still names the load and states plainly that we are not bidding
// it, which is the one thing the desk must not have to guess.
//
// The UNRECOGNISED-reason default is "not bidding", and that default only stays safe while every
// member of DESK_NOTICE_KINDS is a refusal. It stopped being true on 2026-08-01 when
// 'last_resort_floor_fired' joined - a notice about a bid we DID place. A notice about a placed bid
// rendering "we are not bidding this load" would be worse than no notice at all, so that kind is
// named explicitly in both the headline and the action below. Anything added to DESK_NOTICE_KINDS
// that is not a refusal has to be named here too; the fallback cannot be made to cover both.
// Is one of our bids already on the board for this load? Read by both the headline and the action,
// so the two can never tell the customer's group different stories about the same notice.
function bidIsStanding(d) {
  return !!(d && d.landedBids != null && Number(d.landedBids) > 0);
}
// The raise-refused stand-down in the owner-approved terse form (26 Sep): one line, then the OA No and
// route lines. A figure that did not arrive is left out rather than printed as a blank.
function raiseRefusedHeadline(d) {
  const customer = (d && d.shipper) ? String(d.shipper).trim() : '';
  const rs = (v) => (v != null && Number.isFinite(Number(v)) ? ` (₹${fmtNum(Math.round(Number(v)))})` : '');
  const above = d && d.amountCap != null ? `the portal's limit${rs(d.amountCap)}` : `the quote already on our login${rs(d && d.standingQuote)}`;
  return `Not bidding${customer ? ` - ${customer}` : ''}: our lowest price${rs(d && d.floor)} is above ${above}. Check it on the portal.`;
}
// The refused-price hold, same terse pattern: the portal's refusal cut short, and the hand-bid ask.
// The portal's words only when they are plain text: a raw HTML or JSON body, or a bare http_<status>,
// is left out rather than put in front of the customer's group.
function plainRefusal(text) {
  const words = text ? String(text).replace(/\s+/g, ' ').trim() : '';
  if (!words || /[<{[]/.test(words) || /^http_\d+$/.test(words)) return '';
  return words.length > 60 ? `${words.slice(0, 57).trimEnd()}...` : words;
}
function refusedHoldHeadline(d) {
  const customer = (d && d.shipper) ? String(d.shipper).trim() : '';
  const cut = plainRefusal(d && d.refusal);
  const why = cut ? ` (${cut})` : '';
  const who = customer ? ` - ${customer}` : '';
  // A bid of ours still stands (the engine sends no notice when it leads at rank 1).
  if (bidIsStanding(d)) return `Our bid stands${who}: the portal refused our lower price${why}. Bid it by hand if you want it.`;
  return `Not bidding${who}: the portal refused our bid${why}. Bid it by hand if you want it.`;
}
const TERSE_NOTICE = { bid_price_raise_refused: raiseRefusedHeadline, refused_price_bound: refusedHoldHeadline,
  refusal_unrecognised: refusedHoldHeadline };
function deskNoticeHeadline(d) {
  const customer = (d && d.shipper) ? String(d.shipper).trim() : '';
  const reason = (d && d.reason) ? String(d.reason) : '';
  // The LEAD (what happened) plus WHAT (the standing fact). The lead used to be hardcoded in the
  // template body, which made every notice a refusal by construction; it is chosen here now.
  //
  // The refusal wording below is deliberately reason-independent ACROSS THE REFUSALS. It used to
  // read "customer's ceiling is below our cost", which is true only when the ceiling is under the
  // entered COST. Where it sits between the cost and the operating floor the cost fits and the
  // MARGIN is the blocker, so that headline was false on a real and common case - and it is the line
  // the Director reads first. It states the fact every refusal shares, and the two money lines under
  // it (deskNoticeMoney) show the ceiling and our lowest price so the gap speaks for itself.
  // 'vehicle_count_refused' keeps the refusal LEAD but needs its own WHAT: the load CAN be bid, only
  // the count was refused, and telling the desk it is unbiddable stops them taking the one action
  // that works. 'vehicle_count_clamped', and 'no_quantity_remaining' once a bid of ours is standing,
  // are not refusals at all - we bid, we can still win, and "Not bidding" would be flatly false on
  // the line the Director reads first.
  // Flat if-chain, matching the two sibling dispatchers below: the same reason values are dispatched
  // three times in this file and reading them one way is the point.
  let lead = 'Not bidding';
  let what = 'this load cannot be bid';
  // CW-225. Not a refusal at all - the desk put this load back on the ladder - so the default
  // "Not bidding" lead would be flatly false on the line WhatsApp shows in the chat list.
  if (reason === 'bidding_resumed') { lead = 'Bidding resumed'; what = 'we are bidding this load again'; }
  // "Lowest price sent - nothing left in reserve" read as a DIFFERENT STATUS from the load's own
  // bid bubble ("Bids placed (live)"), which had logged the same bid six milliseconds earlier. Both
  // were true and the desk had no way to see that: one message announced a bid, the other announced
  // a reserve running out, and nothing tied them to one event. This says the same thing as the
  // bubble - a bid went in - and then adds the one fact the bubble cannot carry, that it was the
  // last one. "Reserve" is gone with it: it is our own pricing vocabulary, and the desk read the
  // number under it as the customer's ceiling.
  else if (reason === 'last_resort_floor_fired') { lead = 'Final bid placed'; what = 'this was our lowest, nothing more goes out on this load'; }
  else if (reason === 'tick_fault_handoff') { lead = 'Please bid by hand'; what = 'we have stopped bidding this load'; }
  else if (reason === 'vehicle_count_clamped') { lead = 'Bid placed for fewer trucks'; what = 'part of this load is already given out'; }
  else if (reason === 'no_quantity_remaining') {
    if (bidIsStanding(d)) { lead = 'Our bid stands'; what = 'the rest of this load is already given out'; }
    else what = 'this load is fully given out';
  } else if (reason === 'vehicle_count_refused') { what = 'the vehicle count was refused'; }
  // Distinct from the default refusal lead: this fires while the load is still armed and the engine
  // is still going to bid it, so "Not bidding" would be false on the line the Director reads first.
  else if (reason === 'load_not_biddable' && d && d.stillWatching) {
    lead = 'Still watching'; what = `this load stopped showing as open on ${platformName(d)}`;
  }
  // Ruling 46 (Cords / no-schedule loads): the portal never posts a bidding schedule for this
  // account/shipper pairing, so discovery cannot arm it at all - not a pending-schedule race, a
  // structurally different bid mechanic. Bidding these is explicitly OUT; the desk still has to
  // hear about them to bid by hand.
  else if (reason === 'no_schedule') { what = 'no close time on the portal yet'; } // owner: copy too long (26 Sep)
  else if (reason === 'bid_not_sent') {
    const p = (d && d.price != null && Number.isFinite(Number(d.price))) ? `Rs ${fmtNum(Math.round(Number(d.price)))}` : 'our bid';
    lead = d && d.byHand ? 'Please bid by hand' : 'Bid not sent'; what = `${p} did not reach the portal`;
  }
  // reprice_unreachable_ladder does not reach here - it has its own body (repriceUnreachableBody),
  // dispatched before this function is ever called. See the desk_notice MESSAGES entry.
  // Keeps the refusal LEAD but not the default WHAT: this load CAN still be bid, by a person on the
  // portal. It is the one notice in this set with a human workaround - EXCEPT when one of our bids is
  // already standing, where the workaround is itself the harm and the lead has to say the bid survives.
  else if (reason === 'session_logged_out') {
    // The RETRACTION, checked before the standing-bid split because it supersedes it: once the login
    // is back the desk's only question is whether to keep hand-bidding, and the answer is no either
    // way. This line is the WhatsApp chat-list preview, so it has to be true read on its own with
    // nothing under it - which is why it withdraws the instruction instead of promising a bid. The
    // emit sits above the multi-vehicle hold, the revision cap and _decide, so "we are bidding this
    // again" is a claim this message is in no position to make: a load with no revisions left
    // provably never bids again and would say it anyway.
    if (d && d.authCleared) { lead = 'Login is back'; what = 'no need to bid this load by hand'; }
    else if (bidIsStanding(d)) { lead = 'Our bid stands'; what = 'our login for this account is logged out, so we cannot improve it'; }
    else what = 'our login for this account is logged out';
  }
  return customer ? `${lead} - ${customer}: ${what}` : `${lead} - ${what}`;
}
function deskNoticeMoney(d) {
  // reprice_unreachable_ladder does not reach here - see repriceUnreachableBody.
  const ceilingNum = (d && d.ceiling != null && Number.isFinite(Number(d.ceiling))) ? Number(d.ceiling) : null;
  const reason = (d && d.reason) ? String(d.reason) : '';
  const floor = (d && d.floor != null && Number.isFinite(Number(d.floor))) ? fmtNum(Number(d.floor)) : '';
  const costNum = (d && d.cost != null && Number.isFinite(Number(d.cost))) ? Number(d.cost) : null;
  if (reason === 'tick_fault_handoff') return tickFaultHandoffFigures(d);
  let s = '';
  if (ceilingNum != null) s += `\n🚧 *Customer will not pay above* - ₹${fmtNum(ceilingNum)}`;
  // The entered cost, named only when it is itself over the cap - the one case where naming a gap
  // against the ceiling is a true sentence. Where the cost fits and the MARGIN is what refused the
  // load (ceiling sits between cost and floor), this alert carries no reason split to tell the two
  // apart, so the cost is left out entirely rather than risk the false "above the cap" claim
  // ceilingCopy and noBidWhy both warn against on the sibling PAGE and receipt copy.
  if (costNum != null && ceilingNum != null && costNum > ceilingNum) {
    s += `\n🧾 *Our cost* - ₹${fmtNum(costNum)} (₹${fmtNum(Math.round(costNum - ceilingNum))} above that)`;
  }
  // The FLOOR, i.e. the lowest price this load's band allows - not the raw entered cost. It is the
  // number the ceiling is actually compared against, so showing anything else would make the gap
  // look different from the one that caused the refusal.
  //
  // ON A LAST-RESORT FLOOR THE SAME NUMBER MEANS SOMETHING ELSE and has to say so. Everywhere else
  // this line is a price we did NOT send - the hypothetical the refusal is measured against. Here it
  // is the amount that just went on the board, and labelling money we spent as "our lowest price on
  // this load" is what let a desk read Rs 55,577 on the Syngenta notice as a ceiling the customer had
  // set. Same value, different sentence.
  if (floor) {
    s += reason === 'last_resort_floor_fired'
      ? `\n💰 *Bid sent* - ₹${floor}`
      : `\n💰 *Our lowest price on this load* - ₹${floor}`;
  }
  // The POSITION, and it exists so this notice and the load's bid bubble state one thing rather than
  // two. The bubble carries a running log of every bid and the rank each got; the notice used to
  // carry neither, so a desk holding both had no way to see they described one event. Both numbers
  // ride the notice payload now (engineAlerts desk_notice data), and each is omitted rather than
  // guessed when the platform never sent it - the same rule the quantity lines follow.
  if (reason === 'last_resort_floor_fired') {
    const landed = (d && d.landedBids != null && Number.isFinite(Number(d.landedBids))) ? Number(d.landedBids) : null;
    const rank = (d && d.myRank != null && Number.isFinite(Number(d.myRank))) ? Number(d.myRank) : null;
    if (landed != null && landed > 0) s += `\n🧾 *Bids placed on this load* - ${landed}`;
    if (rank != null) s += `\n📊 *Where we stand now* - ${rank}${rank === 1 ? ' (lowest bid)' : ''}`;
  }
  return s;
}
// The hand-off asks the desk to find the load on the portal, so it gets the resolved lane ends
// (notifyEngineEvent) rather than GoComet's two raw postal addresses. Other reasons are unchanged.
function deskNoticeLane(d) {
  if (d && d.reason === 'tick_fault_handoff' && d.laneFrom && d.laneTo) return `${d.laneFrom} -> ${d.laneTo}`;
  return (d && d.lane) || '-';
}
function tickFaultHandoffFigures(d) {
  let s = '';
  const bid = (d && d.standingBidPrice != null && Number.isFinite(Number(d.standingBidPrice))) ? Number(d.standingBidPrice) : null;
  const rank = (d && d.myRank != null && Number.isFinite(Number(d.myRank))) ? Number(d.myRank) : null;
  if (bid != null && bidIsStanding(d)) s += `\n💰 *Our bid on the board* - Rs ${fmtNum(bid)}`;
  if (rank != null) s += `\n📊 *Where we stand now* - ${rank}${rank === 1 ? ' (lowest bid)' : ''}`;
  const closes = fmtDMY(d && d.closesAt);
  if (closes) s += `\n⏰ *Bid Close Time* - ${closes}`;
  return s;
}
function deskNoticeAction(d) {
  const reason = d && d.reason ? String(d.reason) : '';
  if (reason === 'tick_fault_handoff') {
    const first = 'We could not check this load reliably 3 times in a row, so we have stopped bidding on it. ';
    const ask = (bidIsStanding(d) && d.standingBidPrice != null)
      ? 'Our bid above stays on the board. Please bid this load by hand on the portal if you want to go lower. '
      : 'No bid of ours is on this load. Please bid it by hand on the portal before it closes. ';
    return first + ask + 'We will not send a result for this load, so please check it on the portal after it closes.';
  }
  // CW-225. Figures first, because the two numbers ARE the message: what is on the board and what we
  // are now bidding off. Deliberately one line - the desk already saw the decision on the page it
  // made it from, and this is the record of it landing, not an instruction.
  if (reason === 'bidding_resumed') {
    const standing = (d && d.standingBidPrice != null && Number.isFinite(Number(d.standingBidPrice))) ? fmtNum(Number(d.standingBidPrice)) : '';
    const cost = (d && d.resumedCost != null && Number.isFinite(Number(d.resumedCost))) ? fmtNum(Number(d.resumedCost)) : '';
    if (standing && cost) return `Resumed. Bidding continues from Rs ${standing}, cost back to Rs ${cost}.`;
    return 'Resumed. We are bidding this load again.';
  }
  if (reason === 'ceiling_below_floor') {
    return 'Every price we could legally send would be below our own cost, so we are not bidding this one. If the cost can come down, re-price it from the load link and we will bid.';
  }
  if (reason === 'last_resort_floor_fired') {
    // Two facts, and only the two the desk acts on: nothing else is coming, and the answer arrives
    // at close. It does NOT claim we won, does NOT ask anyone to open a console, and asks for no
    // re-price - the price is already sent.
    //
    // Compressed from three sentences (F-E, 2026-09-11), then trimmed again (ship review,
    // 2026-09-16): "nothing more goes out on this load" already opens the headline
    // (deskNoticeHeadline's WHAT for this reason), so repeating it here as the closing line said
    // the same thing twice in one short message. This states only what the headline does not -
    // that the answer arrives at close.
    return 'The result will follow at close.';
  }
  // reprice_unreachable_ladder does not reach here - see repriceUnreachableBody.
  if (reason === 'load_not_biddable') {
    // d.stillWatching: _checkDelisted's own emit, an INFERENCE off a listing cache that stopped
    // refreshing - the auction may still be open and the engine stays armed and will still bid it.
    // The refusal sentence below states as settled fact something the engine's own next action would
    // contradict, so this case gets its own wording that says only what is known.
    if (d && d.stillWatching) {
      return `${platformName(d)} has stopped showing this load as open to bidding, so we cannot be sure it is still open. `
        + 'We are still watching it and will bid if it opens again. No action needed unless you know otherwise.';
    }
    // Says the ONE thing that stops the desk wasting time: the rate is not the problem. The generic
    // no-bid wording this replaces reads as though a price failed to go in, which sends someone
    // hunting a pricing mistake that does not exist. Deliberately does NOT say "re-price" - a new
    // rate changes nothing while the portal has the load closed to bidding.
    return `${platformName(d)} is not accepting bids on this load, so nothing we send can land on it. This is not a problem with the rate - please check the load on ${platformName(d)} if it should still be open.`;
  }
  if (reason === 'session_logged_out') {
    // Open-time half of the pair; noBidWhy carries the close-time half under the same reason.
    // Absolves the rate like every sibling here, names the portal workaround (unlike
    // load_not_biddable there IS one, and it is time-boxed to this load still being open), and says
    // the reconnect is handled so N of these do not each read as a separate request to go fix the
    // login. Deliberately does NOT say "re-price" - that changes nothing while the session is dead.
    // The portal instruction is WITHHELD when a bid of ours is already standing. Bot and desk share
    // the master account and SuperProcure counts both against the load's per-load bid cap, so a
    // second bid placed on this advice can cost us the rungs we still hold - authAlert.js calls that
    // a known collision mode, not a hypothetical one.
    // THE RETRACTION, and it is written to be SELF-CONTAINED rather than as a follow-up. It can
    // arrive at a group that never received the open-time notice (that one is dropped outright when
    // the sender is down - desk_notice rides HEALTH_POLICY 'drop'), so it restates what happened
    // instead of referring back. Read orphaned it is redundant; read as a follow-up it is the stop
    // signal. It ASKS about a hand-bid rather than assuming there was none, because that is the one
    // fact we cannot see and the one that costs money: SuperProcure counts the desk's bid and ours
    // against the same per-load cap, so a hand bid we do not know about can cost us our own rungs.
    // It states the REASON the ask is withdrawn - the login is back - and never that this particular
    // load will be bid. The emit sits above the multi-vehicle hold, the no-revisions-left gate, the
    // bids/min cap and _decide, so it cannot know whether a bid follows; a load whose budget is spent
    // would carry a promise the engine provably cannot keep. The withdrawal itself is NOT softened by
    // that - it is the sentence that stops a second bid landing against the shared per-load cap.
    if (d && d.authCleared) {
      return 'Our SuperProcure login for this account was logged out for a while and is connected again. '
        + 'The problem that made us ask you to bid this load by hand is fixed, so there is no need to bid it by hand. '
        + 'If you already placed a bid on the portal, please tell us and we will hold off on this load - '
        + 'SuperProcure counts your bid and ours against the same per-load limit.';
    }
    if (bidIsStanding(d)) {
      return 'Our SuperProcure login for this account is logged out, so we cannot improve our bid on this load. '
        + 'The rate was not the problem, and the bid we already placed is still on the board. '
        + 'Reconnecting the login is being handled separately.';
    }
    // The close time, not "this load is still open". The instruction is only good while the load is
    // open and a retraction is not guaranteed to reach this group, so the message carries its own
    // expiry. Degrades to the old wording when no close time rode the payload - an older event, or a
    // load armed without one - rather than printing a dangling sentence. The bare close, not
    // fmtCloseWithCutoff: the enter-cost-by cutoff is a price_needed fact and never reaches desk_notice
    // data, so the richer helper could only ever fall through to this same rendering.
    const closes = fmtDMY(d && d.closesAt);
    const window = closes ? `This load closes ${closes}` : 'This load is still open';
    return 'Our SuperProcure login is logged out, so our bids cannot land - the rate was not the problem. '
      + `${window} - please bid it directly on the SuperProcure portal. `
      + 'The login is being reconnected.';
  }
  if (reason === 'vehicle_count_refused') {
    // The ONE desk notice in this set that names an action the desk can complete on its own, so it
    // says the count and asks for the specific change. Absolves the rate first, for the same reason
    // load_not_biddable does: without that line the desk goes hunting a pricing mistake.
    //
    // The count is printed only when it arrived. A notice that says "for 0 trucks" because a field
    // was missing is worse than one that omits the number, and this message reaches the Director.
    const n = (d && d.vcqSent != null && Number.isFinite(Number(d.vcqSent))) ? Number(d.vcqSent) : null;
    const forN = n != null ? ` for ${n} ${n === 1 ? 'truck' : 'trucks'}` : '';
    return `SuperProcure would not accept our bid${forN} - the quantity is more than this load allows. `
      + 'The rate was not the problem. Open the load link, lower how many trucks to bid for, and re-price - we will bid again.';
  }
  if (reason === 'vehicle_count_clamped') {
    // NOT a refusal - we bid, and we can still win. The notice exists because the desk's own
    // commitment shrank, so a later win receipt for fewer trucks than they priced would otherwise
    // arrive unexplained. No action is asked for; there is nothing for them to do.
    const want = (d && d.want != null && Number.isFinite(Number(d.want))) ? Number(d.want) : null;
    const left = (d && d.remaining != null && Number.isFinite(Number(d.remaining))) ? Number(d.remaining) : null;
    if (want != null && left != null) {
      return `The customer has already given out part of this load, so only ${left} `
        + `${left === 1 ? 'truck is' : 'trucks are'} still open instead of ${want}. `
        + `We have bid for ${left}, at the same rate per truck. Nothing to do - we will let you know the result.`;
    }
    return 'Part of this load is already given out, so we bid the trucks still open '
      + 'at the same rate per truck. Nothing to do - result will follow.';
  }
  if (reason === 'bid_not_sent') {
    // The retry variant makes no claim that the next try lands; the byHand variant is the load stood
    // down on a refusal that repeats every time, so it is the one notice here that asks the desk to act.
    const first = bidIsStanding(d)
      ? 'It never left our system, so nothing new was placed on the portal. Our earlier bid on this load still stands.'
      : 'It never left our system, so nothing was placed on the portal.';
    if (d && d.byHand) {
      return `${first} It would be stopped the same way on every try, so we have stopped bidding on this load. `
        + (bidIsStanding(d) ? 'Please bid it by hand on the portal if you want to improve on our bid.' : 'Please bid it by hand on the portal.');
    }
    return `${first} We will try again while the load is open, and the result will follow at close.`;
  }
  if (reason === 'no_quantity_remaining') {
    // Remaining hits zero because the customer ALLOTTED, and the allotment may be ours. On a load
    // where a bid of ours is already on the board, "No bid was placed" is simply false - and this
    // copy goes to the customer's own group, so it is the wrong claim to make in the wrong room.
    if (bidIsStanding(d)) {
      return 'The customer has given out the rest of this load, so there is nothing further to bid for. '
        + 'Our bid is still standing on it. Nothing to do - we will send the result at close.';
    }
    return 'The customer has given out this whole load already, so there is nothing left to bid for. '
      + 'The rate was not the problem. No bid was placed.';
  }
  // Owner: copy too long (26 Sep) - the headline already states the reason (deskNoticeHeadline's
  // "no close time on the portal yet"), so the body drops the restated reason and the closing
  // "no result" sentence entirely, leaving just the one actionable line.
  if (reason === 'no_schedule') {
    return `Bid it by hand on ${platformName(d)} if you want it.`;
  }
  return `We are not bidding this load. Please quote it on ${platformName(d)} if you want it.`;
}

// reprice_unreachable_ladder's own body. Not a slot in the shared desk_notice template above: G10
// proved "floor"/"band"/"lowest price" land on nobody (the client himself could not identify the
// floor field), so this reason drops that vocabulary entirely rather than reuse
// deskNoticeHeadline/Money/Action, which still carry it for every other desk-notice reason. Figure
// leads every money line, bolded, label follows.
//
// The REASON is a plain sentence in the body, not an italic physics clause at the end (F-B,
// 2026-09-11). The owner read the degraded variant - correctedCost absent, so no ledger at all -
// and could not tell what it meant: a "rate saved" headline over a lone board figure states two
// facts and joins neither. So the reason and its consequence are unconditional, rendered whether
// or not any figure survived, and the reverse-auction rule is said once, as the reason this load
// stopped, rather than as a standalone lesson nobody asked for.
function repriceUnreachableBody(d) {
  const oaNo = (d && (d.oaNo || d.auctionId)) || '-';
  const customer = (d && d.shipper) ? String(d.shipper).trim() : '';
  const idLine = customer ? `${oaNo} · ${customer}` : oaNo;
  // The two lane ends the won/lost receipts render, not the raw lane string. On GoComet the whole
  // postal address IS the lane value, so `lane` put two full addresses on the route line and the
  // desk asked what it was looking at. Through placeableEnd, the same sanitiser the receipts use:
  // an unplaced end is truthy ('?' / '? 209304') and would otherwise print as a located origin.
  const from = placeableEnd(d && d.laneFrom);
  const to = placeableEnd(d && d.laneTo);
  const lane = (from && to) ? `${from} -> ${to}` : (from || to || (d && d.lane) || '-');
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const standing = num(d && d.standingBidPrice);
  // correctedCost, not floor - the desk's own number, so the gap is one they typed rather than one
  // the band derived. Absent on fix/reprice-standing-bid (#219) alone; degrades to no figure.
  const corrected = num(d && d.correctedCost);
  const floor = num(d && d.floor);
  // WHICH TWO NUMBERS. `corrected - standing` only answers a question when our bid is genuinely the
  // lower of the two; it is then what the load comes in under if we win it. When the corrected rate
  // sits BELOW our standing bid the hold is the margin's doing, not the rate's, and that subtraction
  // takes a cost from a bid - two numbers that answer nothing, and on 260916V9D7 it printed
  // "*₹-1,000* under your rate" under a sentence it also made false. The negative was the tell that
  // the comparison was wrong, so the line is dropped here rather than clamped downstream.
  const under = (standing != null && corrected != null && corrected > standing) ? corrected - standing : null;
  const marginHeld = under == null && standing != null && corrected != null;
  const figures = [];
  if (standing != null) figures.push(`*₹${fmtNum(standing)}* is our bid on the board`);
  if (corrected != null) figures.push(`*₹${fmtNum(corrected)}* is your corrected rate`);
  if (under != null) figures.push(`*₹${fmtNum(under)}* under your rate if we win it`);
  else if (marginHeld && floor != null) figures.push(`*₹${fmtNum(floor)}* is the lowest we can bid with margin added`);
  const why = marginHeld
    ? 'With margin added, your new rate cannot go below our bid already on the board, so we cannot bid it.'
    : 'Your new rate is not below our bid already on the board, so we cannot bid it.';
  const blocks = [
    `📌 *New rate saved. Bidding stopped on this load.*\n🆔 ${idLine}\n📍 ${lane}`,
    figures.join('\n'),
    `${why}\nNothing further goes out on this load.`,
    '_Do not change this on the portal by hand. It will not lower the bid and it uses up attempts._',
  ].filter(Boolean);
  return blocks.join('\n\n');
}

// The wording used when we have no recorded reason. This is the line the no-bid receipt has always
// carried, kept VERBATIM as the fallback (D042/D043: except the platform name, which is now
// derived rather than hardcoded): an outcome we cannot explain must read exactly as it did before,
// never as a guess dressed up as an explanation.
function NO_BID_REASON_UNKNOWN(d) {
  return `A rate was entered but no bid could be placed before close. Please check this load on ${platformName(d)}.`;
}

/**
 * Was the refused price actually SENT MORE THAN ONCE before the engine held it?
 *
 * The refused-price hold fires at a bound derived from the auction's own attempt budget
 * (bidEngine._refusedPriceBound), and on every tight-budget load that bound is 1 - the price goes on
 * the wire once, the portal refuses it, and the ladder advances instead of repeating it. That is the
 * majority case, not the exotic one: 7 of 12 active SuperProcure customers sit at or below the
 * threshold and GoComet is 3 per vendor per enquiry platform-wide.
 *
 * So the two hold receipts may only claim repetition where the engine recorded it. Missing bound, a
 * pre-fix persisted event, an unparseable value - all answer false and take the neutral wording,
 * which is true at any bound. Nothing here counts anything itself; it reads the fact or drops it.
 */
function repeatedRefusal(d) {
  const bound = (d && d.noBidBound != null) ? Number(d.noBidBound) : NaN;
  return Number.isFinite(bound) && bound > 1;
}

// The one clause a LOST receipt carries that a plain loss does not: on these three reasons a bid of
// ours landed AND a later, corrected or repeated price was refused, so the board closed holding an
// OLDER price than the desk believes it sent. Without it the outcome is an ordinary "we were outbid"
// and the held rate reaches nobody - the engine's alert for these kinds is operator-only, so the
// receipt is the desk's channel (see bidEngine.REASONS_SURVIVING_A_LANDED_BID).
//
// Returns '' - no leading separator, no empty line - on every other reason and on a zero-bid close,
// where noBidWhy already states the whole story on the no_bid template instead.
function lostHeldClause(d) {
  const reason = d && d.noBidReason ? String(d.noBidReason) : '';
  const landed = d && d.landedBids != null ? Number(d.landedBids) : null;
  if (!reason || landed == null || !(landed > 0)) return '';
  if (reason === 'price_raise_refused') {
    const cap = (d && d.noBidAmountCap != null && Number.isFinite(Number(d.noBidAmountCap)))
      ? fmtNum(Number(d.noBidAmountCap)) : '';
    return '\n\n📌 _The portal would not accept a change to a higher rate on this load'
      + (cap ? `, and would only accept ₹${cap} or below` : '')
      + ', so the board still holds our earlier price. Please check this load on the portal._';
  }
  if (reason === 'refused_price_bound' || reason === 'refusal_unrecognised') {
    return '\n\n📌 _The portal refused our last price on this load'
      + (reason === 'refusal_unrecognised' ? ' with a message this system does not recognise yet' : '')
      + (repeatedRefusal(d) ? ' several times over, so we stopped re-sending it' : ', so we did not send it again')
      + ' and the board still holds our earlier price. Please check this load on the portal._';
  }
  return '';
}

/**
 * WHY no bid was placed, in one sentence the desk can act on without looking anything up.
 *
 * The reason was ALWAYS known - the refusal raises its own alert the moment it is taken - but the
 * outcome message never carried it, so on SIKA 23534893 (2026-07-27) the desk got the reason at
 * 14:43 and an unexplained "NO BID PLACED" at 15:30 with nothing joining the two. The client's
 * Director read the second one and asked what it meant. The message was the defect, not the
 * decision: declining a load whose ceiling sits under our cost is the ceiling guard working.
 *
 * Every branch is keyed on a reason the ENGINE RECORDED (bidEngine._recordRefusal) and degrades to
 * NO_BID_REASON_UNKNOWN - the previous wording, unchanged - the moment a fact it needs is missing.
 * Nothing here derives a reason from the absence of bids or fills a blank with a plausible one: an
 * invented explanation on a money receipt is worse than the vague one it replaced.
 *
 * First person plural throughout ("our cost", "we held"), per the settled desk vocabulary - these
 * are messages from a desk acting on BRL's behalf, and they never describe the system to the reader.
 */
function noBidWhy(d) {
  const reason = d && d.noBidReason ? String(d.noBidReason) : '';
  const ceiling = (d && d.noBidCeiling != null && Number.isFinite(Number(d.noBidCeiling)))
    ? fmtNum(Number(d.noBidCeiling)) : '';
  // The desk's OWN entered rate, already formatted by outcomeEnrichment. Absent on a rate-model /
  // mock outcome or a missing closed-bids record, in which case the sentence simply omits it rather
  // than printing a bare "₹-" - the ceiling alone still explains the refusal.
  const cost = (d && d.marketRate) ? String(d.marketRate) : '';
  if (reason === 'ceiling_below_floor' && ceiling) {
    // TWO CASES, never one. "Below our cost" is true ONLY when the ceiling is under the entered
    // cost. When it sits between the cost and the operating floor, the cost fits and the MARGIN is
    // what made the load unbiddable - saying "below our cost" there is false, and it reaches the
    // Director. Same split as the price page's plan.reason; one story, two surfaces.
    //
    // Falls back to the floor-free wording whenever the floor is missing (every event persisted
    // before this field existed), and to the cost-free wording when the cost is missing - the
    // ceiling alone still explains the refusal, and no number is ever invented to complete a
    // sentence.
    const floorNum = (d && d.noBidFloor != null && Number.isFinite(Number(d.noBidFloor)))
      ? Number(d.noBidFloor) : null;
    // The desk's entered rate arrives already FORMATTED (marketRate, e.g. "15,000"), so it is
    // parsed back rather than a second numeric field being threaded through the engine for it.
    // A rate that does not parse leaves costNum null and the sentence falls back - never a case
    // decided on a half-read number.
    const costDigits = cost ? Number(String(cost).replace(/[^0-9.]/g, '')) : NaN;
    const costNum = Number.isFinite(costDigits) && costDigits > 0 ? costDigits : null;
    const ceilNum = Number(d.noBidCeiling);
    if (floorNum != null && costNum != null && ceilNum >= Math.round(costNum)) {
      return `No bid placed - the customer's ceiling on this load was ₹${ceiling} and our lowest price `
        + `was ₹${fmtNum(floorNum)}, so no bid could be placed.`;
    }
    return cost
      ? `No bid placed - the customer's price ceiling (₹${ceiling}) was below our cost (₹${cost}), so any bid would have been at a loss.`
      : `No bid placed - the customer's price ceiling (₹${ceiling}) was below our cost, so any bid would have been at a loss.`;
  }
  if (reason === 'stood_down_below_floor') {
    return 'No bid placed - the price needed to win was below our cost, so we held rather than bid at a loss.';
  }
  if (reason === 'load_not_biddable') {
    // The close-time half of the desk_notice pair, same reason string, same story. What this
    // REPLACES is why it matters: without a recorded reason this close fell through to
    // NO_BID_REASON_UNKNOWN - "A rate was entered but no bid could be placed before close. Please
    // check this load on SuperProcure." - which is not just vague, it is misleading. It reads as a
    // rate that failed to go in and points the desk at a pricing mistake that does not exist, on a
    // load where the rate was fine and SuperProcure simply would not take a bid on it.
    return `No bid placed - ${platformName(d)} would not accept any bid on this load, so nothing could be placed. `
      + `The rate was not the problem; please check this load on ${platformName(d)}.`;
  }
  if (reason === 'not_open_on_portal') {
    // Checked on the portal when the load was armed: it was not being offered for bidding.
    return `No bid placed - ${platformName(d)} was not offering this load for bidding when the rate came in, so nothing could be placed. `
      + `The rate was not the problem; please check this load on ${platformName(d)}.`;
  }
  if (reason === 'vehicle_count_refused') {
    // The close-time half of the desk_notice pair, same reason string, same story. Without it this
    // class fell through to NO_BID_REASON_UNKNOWN - "A rate was entered but no bid could be placed"
    // - which points the desk at a pricing mistake that does not exist. On these loads the rate was
    // fine and went out three times; SuperProcure refused the vehicle COUNT, not the price.
    //
    // The count rides `noBidVcqSent`, recorded by _recordRefusal at the refusal itself, and is
    // omitted when absent rather than defaulted - the receipt never prints a count it did not get.
    const n = (d && d.noBidVcqSent != null && Number.isFinite(Number(d.noBidVcqSent))) ? Number(d.noBidVcqSent) : null;
    const forN = n != null ? ` for ${n} ${n === 1 ? 'truck' : 'trucks'}` : '';
    return `No bid placed - SuperProcure refused our bid${forN} because it says the quantity is more than the load allows. `
      + 'The rate was not the problem. To bid this customer next time, lower how many trucks to bid for on the load link.';
  }
  if (reason === 'no_quantity_remaining') {
    // The close-time half of the no_quantity_remaining pair. The load was fully allotted while we
    // were armed, so there was never a quantity we could quote. Absolves the rate for the same
    // reason every sibling here does: the alternative is the generic wording that sends the desk
    // looking for a pricing mistake.
    return 'No bid placed - the customer had already given out this whole load, so there was nothing '
      + 'left to bid for. The rate was not the problem.';
  }
  if (reason === 'session_logged_out') {
    // The close-time half of the account_auth_dead pair. Without it this class fell through to
    // NO_BID_REASON_UNKNOWN, which points the desk at a pricing mistake that does not exist - the
    // same complaint load_not_biddable was added for. It names the cause in the desk's own words
    // and, critically, absolves the rate: the number they entered was fine and nothing about this
    // load was the problem.
    return 'No bid placed - our SuperProcure login for this account was logged out while this load was open, '
      + 'so no bid could be sent. The rate was not the problem; the login has to be connected again.';
  }
  if (reason === 'transit_time_missing_blocked') {
    return 'No bid placed - the transit days for this load were never entered, and SuperProcure rejects a bid without them. Please add them on the load link and re-price.';
  }
  if (reason === 'per_type_rates_unmatched') {
    // Names no platform: this refusal is raised inside our own write path, and the sibling copy
    // above hardcodes SuperProcure on messages that can only arise there.
    //
    // THE REMEDY IS BY HAND because neither in-product route exists, and the next edit here will be
    // tempted by both. The load link cannot take one rate: the form renders per-type inputs off the
    // stored snapshot's match tokens (server.js:4285), every cost_type_i is required
    // (server.js:4298) and #cost is hidden (server.js:4419), so the bare-cost post setBidOverride
    // needs to drop costByType (priceRequests.js:664) cannot come from it. Re-entering the per-type
    // rates cannot help either: r.load is written once and thereafter only patched with close times
    // (priceRequests.js:339, :495, :850), so the form re-renders the SAME stale types - and those
    // drifting from the live freight lines is the whole mechanism of this refusal.
    return 'No bid placed - the truck types on this load changed after the per-type rates were entered, so none '
      + 'could be matched to a line. Quote this load by hand on the portal if you still want it.';
  }
  if (reason === 'bid_not_sent_by_hand') {
    // The close-time half of the byHand bid_not_sent notice. We cannot see a bid the desk placed by
    // hand, so this says what we did and sends them to the portal for the result.
    return 'No bid placed by us - our bid was stopped before it was sent, the same way on every try, '
      + 'so this load was handed to the desk to bid by hand. Please check this load on the portal.';
  }
  if (reason === 'unsupported_rule_blocked') {
    return `No bid placed - this load is quoted in a way we do not handle here yet. Please quote it manually on ${platformName(d)}.`;
  }
  // THE FIVE CLASSES THE ENGINE RECORDED CORRECTLY AND THE RECEIPT COULD NOT NAME. Each one was
  // already latched, alerted and written to the durable record by bidEngine's rejection handling,
  // and each still closed with NO_BID_REASON_UNKNOWN - "a rate was entered but no bid could be
  // placed before close" - which reads as a rate that failed to go in and sends the desk hunting a
  // pricing mistake that does not exist. Same complaint, and the same fix, as load_not_biddable.
  //
  // The wording rule every one of them follows: name what the PORTAL did, absolve the rate where the
  // rate was genuinely not the problem, and never mention a console, a file, an internal name or a
  // portal error string. These reach the client's Director.
  if (reason === 'bid_cap_exhausted') {
    // SuperProcure's per-load revision cap is counted against the whole carrier account, and BRL's
    // own desk bids manually on that same account - so the honest sentence names the shared budget
    // rather than implying the bot spent it. Actionable: it tells the desk why a load they may have
    // quoted by hand went quiet.
    return 'No bid placed - the portal says the number of bids allowed on this load was already used up, '
      + 'so no further bid could be sent. The rate was not the problem.';
  }
  if (reason === 'price_raise_refused') {
    // STATE WHAT THE PORTAL DID, NOT WHY IT DID IT. An earlier draft said the raise was refused
    // "because an earlier and lower bid of ours is still standing on this load" - flatly, on every
    // close. raiseRefusal's own docstring records that the cap is NOT always our own standing bid:
    // BRL's records carry the same portal wording for a shipper CEILING too, "a ceiling that reaches
    // here is mislabelled" is a named occurrence, and it closes with "nothing here infers it". The
    // engine declines the inference; the receipt may not make it on the engine's behalf, because the
    // desk acts on it - reading "our bid is standing" they leave the load alone, and where the cap
    // was a ceiling the load closes with nothing of BRL's on the board.
    //
    // So the sentence names the refusal and the number, and hands the desk the two readings. It still
    // has to warn that a quote may be standing, or "no bid placed" reads as the load being free.
    const cap = (d && d.noBidAmountCap != null && Number.isFinite(Number(d.noBidAmountCap)))
      ? fmtNum(Number(d.noBidAmountCap)) : '';
    // GoComet names no number, so the cap-less wording cannot lean on one - "that limit" with nothing
    // to point at reads as a dropped figure. Each variant is written whole rather than patched.
    return (cap
      ? `No bid placed at the new rate - the portal would not accept a change to a higher price, and would only accept ₹${cap} or below. That limit is `
      : 'No bid placed at the new rate - the portal would not accept a change to a higher price on this load. The limit it held us to is ')
      + 'either a quote of ours already standing on this load or the customer\'s own ceiling, and the '
      + 'portal does not say which. Please check this load on the portal.';
  }
  if (reason === 'submission_window_closed') {
    // The base branch's wording is kept over this branch's reword: it names what the portal SAID
    // rather than asserting the window had closed as our own finding, and it carries the same
    // "please check this load on the portal" ask every sibling here ends on.
    return "No bid placed - the portal said this load's submission window was already closed, "
      + 'so nothing further could be sent. The rate was not the problem; please check this load on the portal.';
  }
  if (reason === 'refused_price_bound') {
    // The wall. Deliberately does NOT absolve the rate: unlike its neighbours, this class cannot tell
    // whether the price was the problem - the portal refused it and the refusal named no cause the
    // receipt may repeat. Claiming "the rate was not the problem" here would be a guess on a message
    // a Director acts on. (An earlier draft's comment described the UNRECOGNISED case here - "did not
    // say why in a way the bidder could read" - on the branch taken when a classifier DID recognise
    // the wording. That is the sibling below.)
    //
    // BOUND-AWARE, because the bound decides whether the sentence is even true. On every tight-budget
    // load the bound is 1: the price goes out ONCE and is never re-sent, so "kept refusing" and
    // "stopped re-sending" would describe an auction that did not happen, and an operator reading it
    // concludes the portal is malfunctioning and misjudges how much of the budget was spent. The
    // repetition clause is added only where a count was actually recorded and exceeds one; absent the
    // fact, the neutral wording is used, which is true at any bound.
    return 'No bid placed - the portal refused our bid at this price'
      + (repeatedRefusal(d) ? ' several times over, so we stopped re-sending it' : ', so we did not send that price again')
      + ' rather than use up the load\'s remaining attempts on an answer it had already given. '
      + 'Please check this load on the portal.';
  }
  if (reason === 'refusal_unrecognised') {
    // The unmapped remainder. The desk gets the same honest hedge the engine has: something refused
    // us and we could not read it. The portal's own words are deliberately NOT interpolated - they
    // are on the operator alert and the durable record, which is where a new classifier gets written
    // from, not on a message the client's Director reads. Bound-aware for the same reason as its
    // sibling above: at a bound of 1 nothing was "kept" sending.
    return 'No bid placed - the portal refused our bid with a message this system does not recognise yet, '
      + (repeatedRefusal(d) ? 'so it stopped re-sending. ' : 'so it did not send that price again. ')
      + 'The rate may not be the problem; please check this load on the portal.';
  }
  return NO_BID_REASON_UNKNOWN(d);
}

/**
 * Which TEMPLATE renders a routing kind, given the event's data.
 *
 * The subscription kinds are a FIXED set (configStore.ALERT_KINDS) that every recipient record
 * enumerates, so a new outcome must not mint a new kind: recipients subscribe to 'lost', and a
 * brand-new 'no_bid' kind would have zero subscribers until every record was migrated - silently
 * dropping the outcome message for everyone in the meantime. So the KIND stays 'lost' (routing,
 * scope-matching and dedupe all unchanged) and the participation fact on the event picks the
 * template. This is the same split lost_short already uses for the group reply; templateFor is
 * just the single place that decision now lives, instead of being inlined at each render site.
 *
 * `landedBids` absent (null/undefined) means the event carries no participation fact at all - a
 * pre-fix persisted event, a mock adapter, a rate-model arm - and MUST degrade to the previous
 * behaviour, never to no_bid. Only an explicit zero selects the no-bid variant.
 */
function templateFor(kind, data, { short = false } = {}) {
  if ((kind === 'won' || kind === 'lost') && data && data.unconfirmedCount > 0 && !(data.landedBids > 0)) return 'gc_submission_unconfirmed';
  if (data && Number(data.landedBids) === 0) {
    if (data.resultBasis === 'verified_closed_portal_rank' && data.awardConfirmed !== true) return 'sp_shared_rank';
    if (data.resultBasis === 'socket_rank_unverified' && data.resultObservedRank != null) return 'sp_shared_result_unknown';
  }
  if (kind === 'won' && data && data.resultBasis === 'verified_closed_portal_rank') {
    return data.awardConfirmed === true ? 'sp_awarded' : 'sp_rank_first';
  }
  // Account-wide session death, and its all-clear counterpart, both ride the 'error' kind (see the
  // account_auth_dead / account_auth_restored entries in MESSAGES for why templates rather than new
  // subscription kinds) and are selected by a flag on the payload, exactly the way the no_bid split
  // below reads landedBids. Every other 'error' payload - engine alerts, boot failures, the
  // token-expiry warning - carries neither flag and is untouched.
  // ...and inside the down-alert, the CAUSE picks between two remedies. Only the one cause we can
  // state with local certainty gets its own copy: `token_expired` is arithmetic on our own credential
  // (now >= exp), so the expiry message can never be sent about an account that did not expire. Every
  // other cause - a refusal streak, an unclassified latch, a payload with no authReason at all
  // (a pre-fix persisted event, a hand-rolled stub) - falls through to the general copy, which is
  // true of all of them from the reader's side: the account is logged out and cannot bid.
  if (kind === 'error' && data && data.authDead) {
    return data.authReason === 'token_expired' ? 'account_auth_expired' : 'account_auth_dead';
  }
  // A shipper target rate rides price_needed's routing but is a different question - "they want a
  // lower number on a load we already quoted", not "price this load" - so it selects its own copy
  // off a payload flag, the same mechanism the error split above uses.
  if (kind === 'price_needed' && data && data.targetRate) return 'price_target_rate';
  // Same mechanism as the ask above: the target-rate OUTCOME rides price_submitted's routing but is
  // a different statement, so it selects its own copy off a payload flag.
  if (kind === 'price_submitted' && data && data.targetDone) return 'price_target_done';
  if (kind === 'error' && data && data.authRestored) return 'account_auth_restored';
  if (kind === 'error' && data && data.authConfirming) return 'account_auth_reconnecting';
  // The desk_notice sibling of the session-expiry alert (tokenExpiry.js) - see the two entries'
  // own comment in MESSAGES for why this is a flag-selected template rather than a reason branch.
  if (kind === 'desk_notice' && data && data.sessionAlert === 'expiring') return 'session_expiring_soon';
  if (kind === 'desk_notice' && data && data.sessionAlert === 'disconnected') return 'session_disconnected';
  if (kind === 'desk_notice' && data && data.sessionAlert === 'restored') return 'session_restored';
  if (kind === 'lost') {
    const landed = data && data.landedBids != null ? Number(data.landedBids) : null;
    if (landed === 0) return short ? 'no_bid_short' : 'no_bid';
    if (data && data.resultUnknown === true) return short ? 'result_unknown_short' : 'result_unknown';
    return short ? 'lost_short' : 'lost';
  }
  return kind;
}

// The loud WIN HEADER - the FIRST line of the won receipt, the celebratory mirror of lostHeader.
// WhatsApp's chat-list preview shows only a message's first line, so leading with this makes
// "WON - <customer> . <branch>" the glanceable outcome (the win used to open with a generic
// "Congratulations," that told the desk nothing about WHICH load). Names CUSTOMER . BRANCH exactly
// like the ask's headerCell: prefers d.shipperName (the matched customer's clean label) over
// d.shipper (the raw platform string), and appends SP's branch label when the load carries one.
// Degrades cleanly: customer . branch when both are known, customer alone when the branch is
// absent (the live engine path today carries only the raw shipper), and a bare "WE WON THIS ONE"
// when neither is (a point-less / rate-model load) - never a dangling separator. won keeps the
// celebratory 🎉 where lost shouts a red 🔴; won-only, lost has its own header.
// 2026-09-16: the route now rides its own second line here too, same as lostHeader/noBidHeader
// (outcomeParts) - it is what lets the won body drop the full postal From/To block entirely
// instead of duplicating the lane on both the header and the body.
// T6 BH-BOUNDARY-5/INV-10: a raw portal customer/branch label carrying an embedded newline (seen on
// malformed SP/GoComet data) broke the bold header - `*...*` markdown cannot bold across a literal
// newline WhatsApp's own renderer inserts there, and the chat-list preview (first line only) cut
// off mid-header with an unclosed asterisk. wonHeadline's own splice (header.indexOf('\n')) then
// found the SPURIOUS embedded newline instead of the real header/route boundary and spliced the
// cost alert into the middle of the customer name. Collapsed to a single space before use.
function wonHeader(d) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
  const base = (d && (d.shipperName || d.shipper)) ? clean(d.shipperName || d.shipper) : '';
  const branch = d && d.branch ? clean(d.branch) : '';
  // CUSTOMER · BRANCH with a MIDDLE DOT (U+00B7), same as the ask's headerCell (not a period).
  const ctx = base && branch ? `${base} · ${branch}` : base;
  const head = ctx ? `🎉 *WON - ${ctx}*` : '🎉 *WE WON THIS ONE*';
  const route = outcomeParts(d).route;
  return route ? `${head}\n${route}` : head;
}
// WHO POSTED THE LOAD - the shipper-side contact BRL's own manager rings to get the vehicle placed.
// Suyashh's ask, verbatim (2026-07-28): "in the won message also, the manager who posted, the manager
// of the company, his name and number should come so that our manager can coordinate with them and
// place the vehicle". Rendered directly above the allotment CTA because it serves that one action.
//
// WON-ONLY, deliberately. A loss has no vehicle to place and nobody to coordinate with, so the same
// contact on a lost receipt would be an unexplained shipper phone number sitting in a staff group.
//
// The number renders in the canonical '+91XXXXXXXXXX' form (normalizePhone's own output shape) so
// WhatsApp linkifies it into a tappable call - acting on it from the message, without retyping, is
// the entire point. It is NOT written 5+5 the way the /price card writes it: that spacing is exactly
// what stops WhatsApp linkifying a number.
//
// Fail-closed on the digits, mirroring the /price card (server.renderLoadCard): the adapter already
// rejected SuperProcure's placeholders (the "System" poster, the 1000000000-class mobile,
// displayPartyDetails switched off) and priceRequests snapshotted only the survivor, so anything
// arriving here is a real person - but this reads a STORED snapshot, so require exactly the ten
// digits dialableDigits produces and print no number at all otherwise. Never a half-number the
// manager might dial. A name with an unusable number still renders: knowing who to ask for is most
// of the value. '' when no poster rode the load at all (mock/sim, a snapshot predating the field, a
// guard-rejected poster), so the win never dangles a "Posted by" label with nothing after it.
function posterContact(d) {
  const p = d && d.poster;
  const name = (p && typeof p.name === 'string') ? p.name.trim() : '';
  if (!name) return '';
  const digits = p.mobile != null ? String(p.mobile).replace(/\D/g, '') : '';
  return `\n\n📞 *Posted by* - ${name}${digits.length === 10 ? ` · +91${digits}` : ''}`;
}
// Nag on a win ONLY when the margin landed at/below the lowest band margin - the lowest bid the plan
// allowed, i.e. we barely squeezed in. The minimum margin is never bid, so it is only the threshold
// where a legacy band sits below it (the clamp bid the minimum's price there), or where no band is on
// the record; 5% when neither is. A healthy-margin win says nothing. A NEGATIVE margin is not a thin
// win and takes its own line.
// THE CORRECTION CASE IS NOT HERE ANY MORE. It said "₹N under your corrected rate" off a subtraction
// with no gate on its sign, so a healthy win whose correction sat BELOW the won rate (correction
// 1,20,000, won 1,31,000) printed a spurious ⚠️ about being ₹-7,000 under. The escalated correction
// alert owns that message now, with the gate this one never had - one warning, correctly gated,
// rather than two of which one is wrong.
function wonWarning(d) {
  if (!d || d.marginPct == null) return '';
  // Never on a load already standing under its corrected cost. wonCostAlert has already said so at
  // the top of the receipt, and "place at a lower rate" is the wrong instruction on a load we are
  // committed to below cost - it fired on three real below-cost wins.
  if (d.costCorrectedTo) return '';
  // That same wrong instruction reaches here by a second route. A row with no bid-time snapshot
  // anchors its margin on the doc cost, so a below-cost win surfaces as a negative margin with
  // costCorrectedTo never set - which is every pre-snapshot row and every rate-model arm. The
  // auction is over, so bidding lower is impossible as well as self-harming; the rupee gap is what
  // the desk can still act on.
  //
  // Gated on belowRateBy rather than the sign of marginPct. The percent is rendered through
  // toFixed(2), so a shortfall under 0.005% prints as "-0.00", Number('-0.00') < 0 is false, and a
  // genuinely below-cost win fell past this escape into "Margin low - only -0.00%. Squeeze the
  // vendor and place at a lower rate" on a closed auction. belowRateBy comes off the unrounded
  // comparison, so it is the signal that survives the rounding.
  if (d.belowRateBy != null) {
    return `\n\n⚠️ _This load stands ₹${d.belowRateBy} below your rate of ₹${d.marketRate}. The auction is closed, so squeeze the vendor before allotment._`;
  }
  if (Number(d.marginPct) < 0) return '';
  const min = d.minMarginPct != null ? Number(d.minMarginPct) : null;
  const lowest = d.lowestMarginPct != null ? Number(d.lowestMarginPct) : null;
  const threshold = lowest != null ? (min != null ? Math.max(lowest, min) : lowest) : (min != null ? min : 5);
  if (Number(d.marginPct) > threshold) return '';
  return `\n\n⚠️ _Margin low - only ${d.marginPct}%. Squeeze the vendor and place at a lower rate; we can do better._`;
}

// price_submitted per-vehicle note: SuperProcure charges the bid `amount` PER VEHICLE and
// multiplies it by the load's truck count, so on a genuine FTL multi-vehicle load the entered rate
// is a per-truck number. Echo the multiplier on the Market Rate line - " (per vehicle x N vehicles)"
// - so the receipt shows the desk what the rate is charged per and against how many trucks. Like
// every other optional segment here it returns '' when absent, so a single-vehicle / PMT / unknown-
// basis load renders the line byte-identically to before. The multi-vehicle DECISION lives once in
// discovery.isMultiVehicle (notifier.confirmSubmitted resolves d.vehicleCount from it); this only
// formats a count already proven > 1 and stays quiet on anything else (null / NaN / <= 1).
function perVehicleNote(d) {
  // A per-truck-type receipt states the unit on each rate line itself (submittedRateCell) and
  // carries that line's own count, so this trailer would be a third count on a line that has two,
  // against a rate no line was priced at. Suppressed for the COUNT only - the unit is not optional,
  // and dropping it here without stating it there is what put an unmarked per-truck rupee figure on
  // the receipt.
  if (perTypeRates(d)) return '';
  const n = Number(d && d.vehicleCount);
  return Number.isFinite(n) && n > 1 ? ` (per vehicle x ${n} vehicles)` : '';
}

/**
 * The blended per-unit cost the ladder was built from - the denominator every per-line price is
 * scaled by. Taken from the payload's own `cost` where the sender carries one (the engine events
 * do), and otherwise recomputed from the vector by the same weighted mean normalizeCostByType
 * used (the price_submitted receipt carries no cost). Null when neither is available.
 */
function blendedBase(d) {
  const carried = Number(d && d.cost);
  if (Number.isFinite(carried) && carried > 0) return carried;
  const types = perTypeRates(d);
  if (!types) return null;
  let weighted = 0;
  let units = 0;
  for (const t of types) { weighted += Number(t.cost) * Number(t.count); units += Number(t.count); }
  return units > 0 ? Math.round(weighted / units) : null;
}

/** The desk's entered rate per truck type, or null on the single-rate path. */
function perTypeRates(d) {
  const t = d && d.rateByType;
  return Array.isArray(t) && t.length > 1 && t.every((r) => r && r.cost != null && r.label != null && r.count != null)
    ? t : null;
}

// *Your Rate* - one entered rate per truck type, each on its own line opening with the rate glyph,
// in the shape the multi-type ask already uses (vehicleWeightCell). The single-rate path returns
// `submittedRate` untouched, so an ordinary receipt is byte-identical.
//
// "per truck" rides EVERY line rather than a block header, because each line has to be true read on
// its own: the figure really is a per-truck rate (priceRequests.js:1087 weights it by the count),
// and without the unit "₹60,000 . 40 ft, 25 T x3" reads equally as that line's total - a 3x error on
// the one message the desk checks its own entry against. Same words the desk typed it under
// (server.js:4289, "Your cost per truck, by type"), so the two surfaces state one fact.
function submittedRateCell(d) {
  const types = perTypeRates(d);
  if (!types) return (d && d.submittedRate) || '-';
  return types.map((t) => `₹${fmtNum(t.cost)} per truck . ${t.label} x${t.count}`).join(`\n${RATE_GLYPH} `);
}

// price_submitted footer: a blank line then an italic one-liner pointing back to the SAME /price
// link (which doubles as the re-price surface while the bot is armed), so the desk can correct a
// mistaken rate without waiting for anyone. Rendered ONLY when a link is present - a dashboard-mode
// or older-snapshot receipt carries none, and a bare "- " with no URL would look broken. Added so
// the receipt is also an acknowledgement the desk can act on (the Rs 2 -> Rs 22,000 fat-finger,
// 2026-07-16): the same receipt now fires on a re-price too, confirming the corrected rate landed.
function changeLinkFooter(d) {
  const link = d && d.changeLink ? String(d.changeLink).trim() : '';
  return link ? `\n\n_Wrong rate? Tap to change it:_ ${link}` : '';
}

// Optional rate hints under the vehicle line (src/notify/rateHints.js): the newest closed quote on this lane
// and vehicle, and FR8's published guide for it. Display only - nothing reads them back. Returns '' when no
// hints were attached, so the ask is byte-identical while both switches (RATE_LINE_*) are off.
function rateHintLines(d) {
  const h = d && d.rateHints;
  if (!h || typeof h !== 'object') return '';
  let out = '';
  const q = h.lastQuote;
  if (q && typeof q === 'object') {
    const when = q.at != null ? (typeof q.at === 'number' ? fmtQDate(q.at) : String(q.at)) : '';
    const meta = [q.rank != null ? `Rank ${q.rank}` : '', when.split(' ')[0]].filter(Boolean).join(' | ');
    out += `\n💵 *Last quote* - ${quoteAmount(q)}${meta ? `\n🏅 ${meta}` : ''}`;
  }
  const f = h.fr8;
  if (f && f.rate != null && Number.isFinite(Number(f.rate))) {
    const range = f.low != null && f.high != null ? ` (₹${fmtNum(f.low)}–${fmtNum(f.high)})` : '';
    out += `\n📊 *FR8 guide*${Array.isArray(f.via) && f.via.length ? ' (' + f.via.join(', ') + ')' : ''} - ${f.approx ? '~' : ''}₹${fmtNum(f.rate)}${range}`;
  }
  return out;
}

/** kind + payload -> the full message string to send; null if the kind is unknown. */
function renderMessage(kind, data = {}) {
  const m = BY_KIND.get(kind);
  if (!m) return null;
  // `body` is a plain string on every entry except desk_notice, whose reprice_unreachable_ladder
  // reason needs a structurally different message (MESSAGES_REDESIGN CW-225 section 2) than the
  // shared 5-slot template every other desk-notice reason still uses byte-identically.
  const body = typeof m.body === 'function' ? m.body(data) : m.body;
  const ph = m.placeholders(data).map((v) => (v == null ? '-' : String(v)));
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const i = Number(n) - 1;
    return i >= 0 && i < ph.length ? ph[i] : '-';
  });
}

module.exports = { MESSAGES, renderMessage, templateFor, closeRuleOf, closeTypeLine, fmtDMY, closeTimeCell, fmtCloseWithCutoff, reminderClosingClause, reminderRemainingPhrase, fmtClock, fmtNum, fmtVehicle, fmtWeight, dropAddress, pickupAddress, addressesByKind, laneEnds, vehicleWeightCell };
