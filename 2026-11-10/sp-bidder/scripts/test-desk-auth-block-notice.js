'use strict';
/**
 * The per-load, still-open half of the dead-session story - the one auth message that arrives while
 * a human can still act on it. Pins, end to end:
 *
 *   1. the kind routes as a DESK NOTICE, not an error, and the two sets stay disjoint
 *   2. it is keyed per LOAD, so N held loads produce N notices rather than one swallowed by dedupe,
 *      and per (LOAD, EPISODE, STATE) - held / standing / clear are three keys and never more
 *   3. the rendered copy tells the desk the rate was fine and to bid on the portal - and does NOT
 *      ask for a second bid when one of ours is already standing
 *   4. the engine emits it exactly ONCE per monitor per state, however many ticks re-enter the auth
 *      gate; never before the adapter has corroborated the outage; never on a tick that still has a
 *      trial write to spend; and always keyed on the EPISODE, so a flapping latch cannot re-mint it
 *   5. the short-lived token ladder warns ONCE, at 30m, and the cadence leads that rung; a lapsed
 *      session gets its own distinct disconnect alert, both routed to the admin channel and the
 *      account's own customer group (see test-session-expiry-alert.js for the full pin)
 *   6. THE RETRACTION: a load told to be hand-bid is told to stop once the account recovers, on the
 *      same shipper-scoped channel; a flap inside one episode says nothing new; a genuinely second
 *      outage speaks again
 *   7. the retraction survives the ~3-minute window in which the account reads alive while its
 *      episode is still open - driven through the real adapter's own settle timer, not a stub, so
 *      the recovery standard under test is the accepted-write standard that actually ships
 *
 *   node scripts/test-desk-auth-block-notice.js
 */
const assert = require('assert');
const { toNotification, notifyEngineEvent, ERROR_KINDS, DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');
const { checkTokenExpiry, expiryCheckIntervalMs, SHORT_WARN_MS } = require('../src/notify/tokenExpiry');
const { BidEngine } = require('../src/engine/bidEngine');
const H = require('./lib/auth-harness');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}`); }
}

// run-tests.js grades by EXIT CODE ALONE, so a file that ends early - a swallowed rejection, a stray
// return - reaches exit 0 having asserted nothing and reads as a silent green.
const EXPECTED_CHECKS = 141;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS && fail === 0) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks (${fail} failed), expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const RALLIS_LIFE_MS = Math.round(8.16 * HOUR);

function authEvent(over = {}) {
  return {
    type: 'alert', level: 'warn', kind: 'session_logged_out', auctionId: 23803049,
    lane: { origin: 'Bharuch', destination: 'Pune' }, companyName: 'Safex Chemicals India Ltd.',
    branchName: 'Bharuch', ...over,
  };
}

(async () => {
  // ============================================================================================
  // 1. ROUTING - a desk notice, never an error, and the sets stay disjoint
  // ============================================================================================
  {
    ok(DESK_NOTICE_KINDS.has('session_logged_out'), 'session_logged_out is a desk notice kind');
    // The disjointness is asserted rather than assumed: toNotification checks the desk branch
    // BEFORE the error branch, so a kind in both would silently never page - the failure mode
    // would be an alert that quietly downgrades itself.
    ok(!ERROR_KINDS.has('session_logged_out'),
      'session_logged_out is NOT also an error kind - the two sets stay disjoint');
    const both = [...DESK_NOTICE_KINDS].filter((k) => ERROR_KINDS.has(k));
    ok(both.length === 0, `no kind is in both sets (found: ${both.join(',') || 'none'})`);

    const n = toNotification(authEvent());
    ok(n && n.kind === 'desk_notice', 'a session_logged_out alert becomes a desk_notice');
    ok(n.data.shipper === 'Safex Chemicals India Ltd.',
      'the shipper scope key rides the payload so the notice can reach that customer group');
    ok(n.data.branch === 'Bharuch', 'the branch scope key rides the payload');
  }

  // ============================================================================================
  // 2. KEYED PER LOAD - an account-wide cause must not collapse into one message
  // ============================================================================================
  {
    // This is the assertion that distinguishes this notice from the account-level alert it sits
    // beside. The cause is shared across every armed load, so a kind-only dedupe key would deliver
    // ONE notice and leave the desk unaware of the other N-1 loads it is holding.
    const a = toNotification(authEvent({ auctionId: 1001 }));
    const b = toNotification(authEvent({ auctionId: 1002 }));
    ok(a.dedupeKey !== b.dedupeKey, 'two held loads produce two distinct dedupe keys');
    ok(/1001/.test(a.dedupeKey) && /session_logged_out/.test(a.dedupeKey),
      'the dedupe key carries both the load and the kind');
    const again = toNotification(authEvent({ auctionId: 1001 }));
    ok(again.dedupeKey === a.dedupeKey, 'the same load re-notified keeps one key, so it is idempotent');

    // r1 Finding 2, second half. The notifier's sent-mark is a PERMANENT store document with no TTL,
    // so a key that does not name the outage delivers once per load ever - a long-lived load caught
    // by a second outage would be silently swallowed even with the engine latch correctly reset.
    const o1 = toNotification(authEvent({ auctionId: 1001, authSince: 1786000000000 }));
    const o2 = toNotification(authEvent({ auctionId: 1001, authSince: 1786099999999 }));
    ok(o1.dedupeKey !== o2.dedupeKey,
      'the SAME load in two different outages gets two keys - the episode start rides the key');
    ok(/1786000000000/.test(o1.dedupeKey), 'the dedupe key carries the outage start');
    const noSince = toNotification(authEvent({ auctionId: 1001 }));
    ok(typeof noSince.dedupeKey === 'string' && noSince.dedupeKey.length > 0,
      'a missing authSince still yields a usable key rather than undefined');

    // r3 Finding 3. The episode is STABLE across a flap by design, which is what makes it the right
    // identity - and is exactly why it cannot be the whole identity. The copy branches on landedBids,
    // so a trial write landing mid-episode produces a DIFFERENT message under the same episode; with
    // the episode alone that correction carries an identical key and the notifier drops it, leaving
    // the desk acting on "go bid it by hand" for a load we are already holding.
    const EP = 1786000000000;
    const held = toNotification(authEvent({ auctionId: 1001, authSince: EP }));
    const standing = toNotification(authEvent({ auctionId: 1001, authSince: EP, landedBids: 1 }));
    const cleared = toNotification(authEvent({ auctionId: 1001, authSince: EP, authCleared: true }));
    const keys = new Set([held.dedupeKey, standing.dedupeKey, cleared.dedupeKey]);
    ok(keys.size === 3,
      `held, standing and clear are three distinct keys inside one episode (got ${keys.size})`);
    // ...and exactly three. The ceiling is what stops this from becoming a per-event channel.
    const clearedStanding = toNotification(authEvent({ auctionId: 1001, authSince: EP, landedBids: 4, authCleared: true }));
    ok(clearedStanding.dedupeKey === cleared.dedupeKey,
      'the clear key does not split again on landedBids - three keys per (load, episode) is the ceiling');

    // THE STANDING TOKEN IS A BOOLEAN, NEVER THE COUNT. Keying on the count mints a fresh key per
    // landed bid, so a load bid down four rungs during one outage would send four identical-reading
    // messages to the customer's group. This is the assertion that catches that substitution.
    const one = toNotification(authEvent({ auctionId: 1001, authSince: EP, landedBids: 1 }));
    const seven = toNotification(authEvent({ auctionId: 1001, authSince: EP, landedBids: 7 }));
    ok(one.dedupeKey === seven.dedupeKey,
      'landedBids of 1 and of 7 mint the SAME key - the token is a boolean, not the count');

    // THE HELD KEY IS BYTE-IDENTICAL to the literal this line produced before the state split, so a
    // load already notified across a deploy is not told the same thing twice under a renamed key.
    ok(held.dedupeKey === `1001_notice_session_logged_out_${EP}`,
      'the held key is unchanged by the split - the empty-string token is load-bearing');

    // BOTH NEW FIELDS HAVE TO REACH `data`, not just the key. The key decides whether the message is
    // sent; `data` is what the template reads, so a field that keys correctly and never lands in
    // data selects the wrong copy under the right key - the worst of both.
    ok(cleared.data.authCleared === true && held.data.authCleared === false,
      'authCleared reaches the template data, which is what selects the retraction copy');
    const withClose = toNotification(authEvent({ auctionId: 1001, authSince: EP, closesAt: 1786000900000 }));
    ok(withClose.data.closesAt === 1786000900000 && held.data.closesAt === null,
      'the close time reaches the template data, and degrades to null rather than undefined');
    // ...and the enter-cost-by cutoff does NOT, which is why the close-time copy renders the bare
    // close. deadlineAt is a price_needed fact off the price request; it has no route onto an engine
    // alert. A field added here later would make the richer fmtCloseWithCutoff renderable again, and
    // this is the check that says so rather than leaving a call site whose argument is always absent.
    ok(!('deadlineAt' in withClose.data),
      'desk_notice data carries no enter-cost-by cutoff, so the copy renders the bare close time');
  }

  // ============================================================================================
  // 3. THE COPY - what the desk actually reads
  // ============================================================================================
  {
    const body = renderMessage('desk_notice', {
      reason: 'session_logged_out', shipper: 'Safex Chemicals India Ltd.',
      auctionId: 23803049, lane: 'Bharuch -> Pune',
    });
    ok(/logged out/i.test(body), 'the notice says the login is logged out');
    // The headline is the WhatsApp chat-list preview, so it has to be true on its own. The default
    // WHAT ("this load cannot be bid") is false here in the way that matters: a person CAN bid it.
    ok(!/this load cannot be bid/i.test(body),
      'it does NOT claim the load cannot be bid - a human can still bid it on the portal');
    ok(/portal/i.test(body), 'it names the portal as the workaround');
    // Absolving the rate is what stops the desk hunting a pricing mistake that does not exist -
    // the same reason every sibling desk notice carries the line.
    ok(/rate was not the problem/i.test(body), 'it absolves the rate');
    // Re-pricing does nothing while the session is dead, and the generic no-bid wording implies it.
    ok(!/re-price/i.test(body), 'it does NOT tell the desk to re-price, which would change nothing');
    // 2026-09-16 length trim: the client flagged this notice as too long. Pins the trim actually
    // happened without losing the facts asserted above.
    ok(/our bids cannot land/i.test(body), 'the trimmed copy states bids cannot land, not the old filler');
    ok(!/reconnecting the login is being handled separately/i.test(body),
      'and drops the old closing sentence');

    // r2 Finding 6. The portal instruction is the RIGHT advice on a load we never bid and the WRONG
    // advice on one we did: bot and desk share the master account, and SuperProcure counts both
    // against the load's bid cap, so a second bid placed on this advice can cost us our own rungs.
    const standing = renderMessage('desk_notice', {
      reason: 'session_logged_out', shipper: 'Safex Chemicals India Ltd.',
      auctionId: 23803049, lane: 'Bharuch -> Pune', landedBids: 1,
    });
    ok(/bid stands/i.test(standing), 'with a bid standing the headline says our bid stands');
    ok(!/bid it directly on the SuperProcure portal/i.test(standing),
      'and it does NOT ask the desk to bid the load again on the portal');
    ok(/still on the board/i.test(standing), 'it says the bid we already placed survives');
    ok(/rate was not the problem/i.test(standing), 'and still absolves the rate');

    // The hand-bid instruction is only good while the load is open, and a retraction is not
    // guaranteed to reach this group, so the message names its own expiry instead of standing
    // until somebody closes it.
    const closesAt = new Date(2026, 7, 11, 14, 45).getTime();
    const timed = renderMessage('desk_notice', {
      reason: 'session_logged_out', shipper: 'Safex Chemicals India Ltd.',
      auctionId: 23803049, lane: 'Bharuch -> Pune', closesAt,
    });
    ok(/This load closes 11-08-2026 02:45 PM/.test(timed), 'the open notice prints the load\'s own close time');
    ok(!/This load is still open/i.test(timed), 'and drops the open-ended wording it replaces');
    ok(/This load is still open/i.test(body),
      'a payload with no close time degrades to the old wording rather than a dangling sentence');

    // r3 Finding 2 - THE RETRACTION. Without it the desk keeps hand-quoting after the bot resumes,
    // and both bids count against SuperProcure's shared per-load cap.
    const clear = renderMessage('desk_notice', {
      reason: 'session_logged_out', shipper: 'Safex Chemicals India Ltd.',
      auctionId: 23803049, lane: 'Bharuch -> Pune', authCleared: true,
    });
    // Line one is the WhatsApp chat-list preview, so it has to be true read entirely on its own.
    ok(clear.split('\n')[0].includes('Login is back - Safex Chemicals India Ltd.: no need to bid this load by hand'),
      'the retraction headline stands alone: the login is back and the hand-bid ask is withdrawn');
    ok(/no need to bid it by hand/i.test(clear), 'it withdraws the hand-bid instruction explicitly');
    // AND IT PROMISES NOTHING ABOUT THIS LOAD. The emit sits above the multi-vehicle hold, the
    // no-revisions-left gate, the bids/min cap and _decide, so whether a bid actually follows is
    // decided after this message is already written. A monitor with revisionsLeft 0 provably never
    // bids again and would have carried the claim anyway.
    ok(!/bidding this load again/i.test(clear),
      'and it never claims we are bidding this load again - that is not this message\'s to know');
    ok(/problem that made us ask you to bid this load by hand is fixed/i.test(clear),
      'it withdraws the ask by naming the REASON that is gone, which is true whatever the gates below decide');
    ok(/same per-load limit/i.test(clear),
      'and says why a hand bid still matters - SuperProcure counts theirs and ours against one cap');
    ok(/tell us/i.test(clear), 'it ASKS about a bid already placed rather than assuming there was none');
    ok(!/bid it directly on the SuperProcure portal/i.test(clear),
      'and never carries the open-time instruction it exists to cancel');
    // It can land in a group that never received the open notice (desk_notice rides a 'drop' health
    // policy), so it restates the outage instead of referring back to a message that may not exist.
    ok(/was logged out for a while and is connected again/i.test(clear),
      'it is self-contained, so an orphaned retraction reads as redundant rather than confusing');
    // The retraction supersedes the standing-bid split: once the login is back the answer to "should
    // I hand-bid this" is no either way, so the copy must not fork again underneath it.
    const clearStanding = renderMessage('desk_notice', {
      reason: 'session_logged_out', shipper: 'Safex Chemicals India Ltd.',
      auctionId: 23803049, lane: 'Bharuch -> Pune', authCleared: true, landedBids: 3,
    });
    ok(clearStanding === clear, 'the retraction reads the same whether or not a bid of ours is standing');
  }

  // ============================================================================================
  // 4. THE ENGINE LATCH - one notice per load, not one per tick
  // ============================================================================================
  {
    // The auth gate is re-entered on EVERY tick for the life of the outage and _markAuthBlocked is
    // called on each. Without the latch a single load would emit a notice every ~200ms in the hot
    // window. Exercised through the prototype against a minimal `this` so the assertion is about
    // the latch itself and not about booting a whole engine.
    // An adapter that reports a live outage is now a PRECONDITION of the notice, not scenery: the
    // emit resolves its dedupe identity off the episode and returns early when there is none. A stub
    // without one models "the adapter has not corroborated the failure yet", which must stay silent.
    function fakeAdapter({ deadSince = null, episodeSince = null, episodeAccessors = true } = {}) {
      const a = { authDeadSince: () => deadSince };
      if (episodeAccessors) a.authEpisodeSince = () => episodeSince;
      return a;
    }
    function stubEngine(adapter) {
      const seen = [];
      const eng = Object.create(BidEngine.prototype);
      eng.emit = (e) => seen.push(e);
      eng._authAttributable = () => true;
      eng._recordRefusal = () => {};
      eng.adapter = adapter;
      return { eng, seen };
    }
    const T0 = 1786000000000;

    // Built off the real prototype, not a bare object literal: _alertAuthBlocked resolves the outage
    // identity through a sibling method, so a hand-rolled `this` would be testing a different shape.
    const { eng: self, seen: emitted } = stubEngine(fakeAdapter({ deadSince: T0, episodeSince: T0 }));
    const monitor = { auctionId: 23803049, meta: { lane: { origin: 'Bharuch' }, companyName: 'Safex', branchName: 'Bharuch' } };

    BidEngine.prototype._alertAuthBlocked.call(self, monitor);
    BidEngine.prototype._alertAuthBlocked.call(self, monitor);
    BidEngine.prototype._alertAuthBlocked.call(self, monitor);
    ok(emitted.length === 1, 'three passes through the auth gate emit exactly one notice');
    ok(emitted[0].kind === 'session_logged_out' && emitted[0].auctionId === 23803049,
      'the emitted event carries the kind and the load');
    ok(emitted[0].companyName === 'Safex',
      'the emitted event carries the shipper, without which no scoped group can match');

    // A SECOND load in the same outage must still speak - the latch is per monitor, not per engine.
    const other = { auctionId: 23803050, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    BidEngine.prototype._alertAuthBlocked.call(self, other);
    ok(emitted.length === 2, 'a second held load still emits - the latch is per load, not per outage');

    // r2 Finding 6. Without landedBids on the payload every one of these notices renders as "not
    // bidding" and tells the desk to go bid a load we may already have a bid standing on.
    const CLOSES = T0 + 900_000;
    const mLanded = { auctionId: 23803060, landedBids: 2, meta: { lane: {}, companyName: 'Safex', branchName: null, closesAt: CLOSES } };
    BidEngine.prototype._alertAuthBlocked.call(self, mLanded);
    ok(emitted[2].landedBids === 2, 'the emitted event carries landedBids so the copy can see a standing bid');
    // The hand-bid instruction expires with the load, so the load's own close time has to leave the
    // engine - the notify layer has no other route to it.
    ok(emitted[2].closesAt === CLOSES, 'and the load\'s close time, so the instruction names its own expiry');
    ok(emitted[0].closesAt === null, 'degrading to null on a load armed without one');

    // r2 Findings 2+3. The adapter latches only after a SECOND failure inside the streak window, so
    // on the first 401 there is no outage identity at all. Emitting there both cries wolf on one
    // transient failure and burns a permanent, outage-less dedupe key that swallows every later
    // outage for this load. The correct behaviour is silence until the adapter corroborates.
    const preLatch = stubEngine(fakeAdapter({ deadSince: null, episodeSince: null }));
    const mPre = { auctionId: 23803061, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    BidEngine.prototype._alertAuthBlocked.call(preLatch.eng, mPre);
    ok(preLatch.seen.length === 0, 'no notice before the adapter has latched - one 401 is not an outage');
    ok(mPre._authNotice == null,
      'and no record is written by the silent pass, or the real outage could never speak - and the '
      + 'engine would owe a retraction for a message nobody received');
    preLatch.eng.adapter = fakeAdapter({ deadSince: T0, episodeSince: T0 });
    BidEngine.prototype._alertAuthBlocked.call(preLatch.eng, mPre);
    ok(preLatch.seen.length === 1, 'the same load speaks on the tick the adapter does latch');

    // r2 Finding 1, the whole point. authDeadSince is the LATCH instant and moves on every
    // clear -> re-latch inside ONE outage; authEpisodeSince does not. Keying on the former re-sends
    // the notice per flap, which is the ~60-messages-in-95-minutes incident authAlert.js records.
    const flap = stubEngine(fakeAdapter({ deadSince: T0, episodeSince: T0 }));
    const mFlap = { auctionId: 23803062, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    BidEngine.prototype._alertAuthBlocked.call(flap.eng, mFlap);
    flap.eng.adapter = fakeAdapter({ deadSince: T0 + 45000, episodeSince: T0 });  // re-latched, same episode
    BidEngine.prototype._alertAuthBlocked.call(flap.eng, mFlap);
    ok(flap.seen.length === 1 && flap.seen[0].authSince === T0,
      'a re-latch inside one outage says nothing new - the record is keyed on the episode, which the '
      + 'flap does not move');

    // ...and a load that LANDS a bid mid-episode does speak again, once, because the copy it needs
    // has changed from "go bid it by hand" to "our bid stands, do not". This is the transition the
    // boolean latch swallowed.
    mFlap.landedBids = 1;
    BidEngine.prototype._alertAuthBlocked.call(flap.eng, mFlap);
    ok(flap.seen.length === 2 && flap.seen[1].landedBids === 1,
      'a trial write landing mid-episode emits the corrected copy rather than being swallowed');
    mFlap.landedBids = 5;
    BidEngine.prototype._alertAuthBlocked.call(flap.eng, mFlap);
    ok(flap.seen.length === 2,
      'and every further landed bid inside that episode is silent - the state is a boolean, not a count');

    // A stub predating the episode accessors must behave exactly as it did before - authDeadSince
    // stays the feature-detect key and the last fallback.
    const legacy = stubEngine(fakeAdapter({ deadSince: T0, episodeAccessors: false }));
    const mLegacy = { auctionId: 23803063, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    BidEngine.prototype._alertAuthBlocked.call(legacy.eng, mLegacy);
    ok(legacy.seen.length === 1 && legacy.seen[0].authSince === T0,
      'an adapter with no episode accessors falls back to authDeadSince');

    // THE WIRING, not just the helper. Everything above would still pass if _markAuthBlocked had
    // stopped calling _alertAuthBlocked altogether, because it exercises the helper directly - a
    // suite that green-lights a disconnected function. This drives the real _markAuthBlocked over
    // the real prototype so the call site itself is pinned, and asserts the notice lands beside the
    // two marks it is supposed to be written with rather than under some other condition.
    const wired = [];
    const eng = Object.create(BidEngine.prototype);
    eng.emit = (e) => wired.push(e);
    eng._authAttributable = () => true;
    eng.adapter = fakeAdapter({ deadSince: T0, episodeSince: T0 });
    const recorded = [];
    eng._recordRefusal = (mon, reason) => recorded.push(reason);
    const m3 = { auctionId: 23803051, meta: { lane: {}, companyName: 'Safex', branchName: null } };

    const applied = BidEngine.prototype._markAuthBlocked.call(eng, m3, { direct: true });
    ok(applied === true && m3.authBlockedLast === true, '_markAuthBlocked still sets the suppression flag');
    ok(recorded.length === 1 && recorded[0] === 'session_logged_out', 'and still records the receipt reason');
    ok(wired.length === 1 && wired[0].kind === 'session_logged_out',
      'and emits the desk notice from the same single condition - the call site is wired, not orphaned');

    // When the load owns a better explanation of its own silence, _authAttributable refuses and
    // NOTHING is written - the notice must not escape that guard either.
    const wired2 = [];
    const eng2 = Object.create(BidEngine.prototype);
    eng2.emit = (e) => wired2.push(e);
    eng2._authAttributable = () => false;
    eng2._recordRefusal = () => { throw new Error('must not record when not attributable'); };
    const m4 = { auctionId: 23803052, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    ok(BidEngine.prototype._markAuthBlocked.call(eng2, m4, {}) === false && wired2.length === 0,
      'a load that is not auth-attributable gets no notice - the guard covers the emit too');

    // r1 Finding 1. A grace-band decline is NOT an auth failure - realAdapter._tokenPhase calls the
    // session "still valid", and it has its own alert path. The marks are internal and reversible so
    // they may apply; a WhatsApp message to the CUSTOMER's group saying our login is logged out, on
    // every token rollover, cannot be retracted. Ships one false alarm per armed load per rollover.
    const graceEmits = [];
    const eng3 = Object.create(BidEngine.prototype);
    eng3.emit = (e) => graceEmits.push(e);
    eng3._authAttributable = () => true;
    eng3.adapter = fakeAdapter({ deadSince: T0, episodeSince: T0 });
    const graceRecorded = [];
    eng3._recordRefusal = (mon, reason) => graceRecorded.push(reason);
    const m5 = { auctionId: 23803053, meta: { lane: {}, companyName: 'Safex', branchName: null } };

    const graceApplied = BidEngine.prototype._markAuthBlocked.call(eng3, m5, { direct: true, graceBand: true });
    ok(graceApplied === true && m5.authBlockedLast === true && graceRecorded.length === 1,
      'a grace-band decline still applies the internal marks - those are reversible');
    ok(graceEmits.length === 0,
      'but sends NO desk notice on the grace band - the session is still valid, nothing is logged out');

    // r1 Finding 2, first half. The latch has to be per OUTAGE. Cleared alongside authBlockedLast
    // wherever the account reads alive again, so a load held through a second outage is told again.
    const m6 = { auctionId: 23803054, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    const eng4 = Object.create(BidEngine.prototype);
    const outage = [];
    eng4.emit = (e) => outage.push(e);
    eng4._authAttributable = () => true;
    eng4._recordRefusal = () => {};
    eng4.adapter = fakeAdapter({ deadSince: T0, episodeSince: T0 });
    BidEngine.prototype._markAuthBlocked.call(eng4, m6, { direct: true });
    ok(outage.length === 1, 'first outage notifies');
    BidEngine.prototype._markAuthBlocked.call(eng4, m6, { direct: true });
    ok(outage.length === 1, 'still latched while that outage lasts');
    // What the recovery path now does: the suppression flag is dropped, the notice RECORD is not -
    // it is the retraction debt, and dropping it here is what destroyed the retraction before
    // recovery was observable. The re-notify below therefore has to work off the episode alone.
    m6.authBlockedLast = false;
    eng4.adapter = fakeAdapter({ deadSince: T0 + 7200000, episodeSince: T0 + 7200000 });  // a genuinely new episode
    BidEngine.prototype._markAuthBlocked.call(eng4, m6, { direct: true });
    ok(outage.length === 2, 'a SECOND outage on the same load notifies again - the latch is per outage');
    ok(outage[0].authSince !== outage[1].authSince,
      'and the two carry different episode identities, so the notifier delivers the second');

    // r2 Finding 7. The account gate marks one line ABOVE the write-held check, so on a tick that
    // still has a trial write to spend the load may go on to land a bid. Telling the desk to hand-bid
    // it in that same tick is a duplicate bid against the shared per-load cap - the marks may apply,
    // the message may not.
    const trial = stubEngine(fakeAdapter({ deadSince: T0, episodeSince: T0 }));
    const m7 = { auctionId: 23803064, meta: { lane: {}, companyName: 'Safex', branchName: null } };
    const trialApplied = BidEngine.prototype._markAuthBlocked.call(trial.eng, m7, { direct: false, notice: false });
    ok(trialApplied === true && m7.authBlockedLast === true,
      'a trial-write tick still applies the internal marks');
    ok(trial.seen.length === 0,
      'but sends NO desk notice while a trial write may still land a bid this tick');

    // r2 Finding 4. The grace band records the reason but deliberately sends no notice. That record
    // must not then lock the load out of being marked when the token GENUINELY expires - which is
    // what _authAttributable's !monitor.noBid guard did, silencing the one path this feature exists
    // for. The guard still protects a terminal refusal that carries ceiling/floor facts.
    const engA = Object.create(BidEngine.prototype);
    const mStaleAuth = { noBid: { reason: 'session_logged_out' }, ownBidAttempts: 0 };
    ok(BidEngine.prototype._authAttributable.call(engA, mStaleAuth, { direct: false }) === true,
      'a stale grace-band session_logged_out record does not block the real outage from being marked');
    const mTerminal = { noBid: { reason: 'ceiling_below_floor' }, ownBidAttempts: 0 };
    ok(BidEngine.prototype._authAttributable.call(engA, mTerminal, { direct: false }) === false,
      'but a terminal price refusal still owns its own explanation and is left alone');

    // GREP GATE - now a DECOUPLING gate, and the inversion is the fix. It used to require every
    // authBlockedLast clear to clear the notice latch beside it. That coupling is what destroyed the
    // retraction: both clear sites run while the account reads alive and the episode is still open,
    // roughly three minutes before recovery is observable, so the debt was gone before anything could
    // discharge it. The gate is kept, pointed the other way, because the same argument that made it
    // necessary still holds - the clear sites live deep inside _maybeBid and section 6's engine-driven
    // checks would still pass if a future edit re-added the coupling on a path they do not reach.
    const engineSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/engine/bidEngine.js'), 'utf8');
    const srcLines = engineSrc.split(/\r?\n/);
    const clearSites = [];
    srcLines.forEach((l, i) => { if (/monitor\.authBlockedLast\s*=\s*false\s*;/.test(l)) clearSites.push(i); });
    ok(clearSites.length >= 2, `found the authBlockedLast clear sites (${clearSites.length})`);
    const recoupled = clearSites.filter((i) => srcLines.slice(i, i + 6).some((l) => /monitor\._authNotice\s*=\s*(null|false)\s*;/.test(l)));
    ok(recoupled.length === 0,
      `no site clearing authBlockedLast also drops the notice record (recoupled at line(s): ${recoupled.map((i) => i + 1).join(', ') || 'none'})`);
    ok(!/_authBlockAlerted/.test(engineSrc),
      'the boolean latch the record replaces is gone from the engine entirely, so nothing can read a stale one');

    // SECOND GREP GATE, same justification as the first and found the same way. The trial-write
    // suppression is decided at the account gate's CALL SITE, not inside _markAuthBlocked, so the
    // notice:false assertion earlier in this section passes whether or not the call site still
    // computes it - a mutation run flipping that call site to `notice: true` left all 183 files
    // green. What has to hold is that ONE value decides both the notice and the early return: if
    // they can disagree, the desk gets "go bid it on the portal" on a tick that then lands our bid.
    const gateIdx = srcLines.findIndex((l) => /const writeHeld = this\._authWriteHeldNow\(\);/.test(l));
    ok(gateIdx !== -1, 'the account gate computes the write-held answer once, into a name');
    const gateWindow = srcLines.slice(gateIdx, gateIdx + 4).join('\n');
    ok(/_markAuthBlocked\(monitor, \{ direct: false, notice: writeHeld \}\)/.test(gateWindow),
      'and passes that same value as the notice gate rather than a literal');
    ok(/if \(writeHeld\) return;/.test(gateWindow),
      'and returns on it, so the notice and the early return can never disagree');
  }

  // ============================================================================================
  // 5. THE SHORT-LIVED LADDER - ONE rung, at 30m (owner ask, 2026-09-10: the 2h and 15m rungs this
  //    used to carry are gone). Full pin of the disconnect alert + its desk-group routing lives in
  //    test-session-expiry-alert.js; this section keeps the ladder/cadence properties this file
  //    already covered.
  // ============================================================================================
  {
    function fakeNotifier() {
      const calls = [];
      return { calls, alert: async (level, payload, opts = {}) => { calls.push({ level, payload, opts }); } };
    }
    ok(SHORT_WARN_MS.length === 1 && SHORT_WARN_MS[0] === 30 * MINUTE, 'the ladder carries exactly one rung, at 30 minutes');

    // 20 minutes left crosses the one rung (30m) - fires once on the admin channel, once on the desk.
    const n1 = fakeNotifier();
    const now = Date.now();
    await checkTokenExpiry({ tokenExp: now + 20 * MINUTE, notifier: n1, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
    const n1err = n1.calls.filter((c) => c.level === 'error');
    ok(n1err.length === 1 && /_30m$/.test(n1err[0].opts.dedupeKey), '20 minutes left fires the 30m rung, once');

    // 10 minutes left still crosses only the 30m rung - there is no more-urgent rung left to escalate to.
    const n2 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 10 * MINUTE, notifier: n2, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
    const n2err = n2.calls.filter((c) => c.level === 'error');
    ok(n2err.length === 1 && /_30m$/.test(n2err[0].opts.dedupeKey),
      '10 minutes left fires the SAME 30m rung, once - not a second, more urgent alert');

    // The cadence has to be finer than the smallest rung or a rung can be stepped over entirely -
    // this is the property that made the original 24h check useless on an 8h token.
    ok(expiryCheckIntervalMs(RALLIS_LIFE_MS) < Math.min(...SHORT_WARN_MS),
      'the check cadence still leads the smallest rung');

    // THE EMPTY-FILTER FALLBACK. The one rung is filtered out for a token shorter than 30 minutes,
    // so a token shorter than the rung would otherwise arm nothing and warn never.
    const n0 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 4 * MINUTE, notifier: n0, now, accountLabel: 'rallis', tokenLifetimeMs: 10 * MINUTE });
    const n0err = n0.calls.filter((c) => c.level === 'error');
    ok(n0err.length === 1, 'a token shorter than the rung still gets exactly one warning, not none');
    ok(/_30m$/.test(n0err[0].opts.dedupeKey), 'and the warning it gets is the one rung, kept by the fallback');

    // A 365-day token must be byte-identical to before: the day ladder, not the hour ladder.
    const n3 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 10 * DAY, notifier: n3, now, accountLabel: 'primary', tokenLifetimeMs: 365 * DAY });
    ok(n3.calls.every((c) => !/_30m$/.test(c.opts.dedupeKey)),
      'a long-lived token never touches the hour ladder');

    // THE LAPSED SESSION is a distinct branch from the warning, not a re-fire of it - and the clock
    // raises only the DESK half there. The admin copy belongs to the wire rail this file's sections
    // 1-4 cover (raiseAuthDead -> account_auth_expired), so raising one here too would be the same
    // outage announced to ops twice. With no customer mapped to the account, nothing is raised at
    // all, which is the fail-closed direction.
    const n4 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now - HOUR, notifier: n4, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
    ok(n4.calls.length === 0,
      'a lapsed session raises no admin error from the clock, and no desk notice with no customer mapped');
    const n5 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now - HOUR, notifier: n5, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
    ok(n5.calls.length === 1 && n5.calls[0].level === 'desk_notice',
      'with a customer mapped it raises exactly one desk_notice and still no second admin alert');
  }

  // ============================================================================================
  // 6. THE RETRACTION - driven through the real _maybeBid, because the emit site IS a branch
  // ============================================================================================
  // Section 4 exercises the helpers directly, which cannot see where they are called from. The whole
  // defect being fixed here was structural: the retraction had no reachable call site at all. So
  // every check below drives eng._maybeBid and lets the branch decide.
  {
    const T0 = 1_770_000_000_000;
    const armed = () => H.state(50_000, 2);
    const notices = (eng) => H.alertsOfKind(eng, 'session_logged_out');

    // ------------------------------------------------------------------------------------------
    // 6a. THE ALL-CLEAR REACHES THE SCOPED CHANNEL. raiseAuthRestored sends an UNSCOPED payload and
    //     scopeMatches requires a shipper, so no scoped recipient can ever match it - every group
    //     that was told to hand-bid a load is shipper-scoped. Without this emit the instruction
    //     stands forever, and desk plus bot both count against SuperProcure's per-load bid cap.
    // ------------------------------------------------------------------------------------------
    H.freezeClock(T0);
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    Object.assign(eng.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    eng.adapter.getAuctionState = async () => ({ ok: false });
    H.program(eng, ['ok']);

    await eng._maybeBid(m, armed());
    ok(notices(eng).length === 1 && !notices(eng)[0].authCleared,
      'the outage tick tells the desk to hand-bid this load');
    ok(m._authNotice && m._authNotice.state === 'held' && m._authNotice.episode === T0,
      'and records the debt against the episode it spoke under');

    // The account recovers, and this load never reaches a fire point again - its budget is gone. That
    // intervening gate is deliberate: the retraction must not depend on the load bidding again, and it
    // is why the copy withdraws the ask instead of promising a bid (section 3) - this monitor provably
    // cannot bid, and the message it sends has to be true anyway.
    Object.assign(eng.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    m.revisionsLeft = 0;
    await eng._maybeBid(m, H.state(9_000, 2));
    const afterClear = notices(eng);
    ok(afterClear.length === 2 && afterClear[1].authCleared === true,
      'and the account reading alive again retracts it on that same shipper-scoped channel');
    ok(afterClear[1].authSince === T0,
      'keyed on the RECORDED episode - _authOutageIdentity() is already null by the time this runs');
    ok(afterClear[1].companyName === 'Havells',
      'and it carries the shipper, without which no scoped group can match it');
    ok(toNotification(afterClear[1]).dedupeKey.endsWith('_clear'),
      'so the notifier sees a key of its own rather than the one the open notice already burned');

    // ------------------------------------------------------------------------------------------
    // 6b. THE SECOND OUTAGE. Deleting both _authBlockAlerted clears re-opens a line an earlier
    //     review round validated, so this is proved rather than argued: the record is now the only
    //     thing carrying "already told", and it must not silence a genuinely new episode.
    // ------------------------------------------------------------------------------------------
    const T2 = T0 + 7_200_000;
    H.setClock(T2);
    Object.assign(eng.adapter, H.fakeLatch({ dead: true, deadSince: T2, episodeSince: T2 }));
    await eng._maybeBid(m, armed());
    const afterSecond = notices(eng);
    ok(afterSecond.length === 3 && !afterSecond[2].authCleared && afterSecond[2].authSince === T2,
      'a load caught by a genuinely NEW outage is told again, under that outage\'s own identity');

    // ------------------------------------------------------------------------------------------
    // 6c. THE FLAP. authState oscillating inside ONE episode must say nothing new. Reintroducing a
    //     per-flap key is the ~60-messages-in-95-minutes incident authAlert.js records - and the
    //     retraction doubles the surface for it, because now BOTH directions can mint a message.
    // ------------------------------------------------------------------------------------------
    const eng2 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m2 = H.armFine(eng2, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng2.adapter.getAuctionState = async () => ({ ok: false });
    Object.assign(eng2.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng2._maybeBid(m2, armed());
    ok(notices(eng2).length === 1, 'the flap load is told once when the outage starts');
    // No budget left, so nothing below the auth gate can fire and change landedBids under us - the
    // check is about the gate alone.
    m2.revisionsLeft = 0;
    for (let i = 0; i < 50; i += 1) {
      const dead = i % 2 === 0;
      // The EPISODE is unchanged throughout - that is what a flap is. Only the latch moves.
      Object.assign(eng2.adapter, H.fakeLatch({ dead, deadSince: dead ? T0 + i * 1000 : null, episodeSince: T0 }));
      H.advance(30_000);
      await eng2._maybeBid(m2, armed());
    }
    ok(notices(eng2).length === 1,
      '50 ticks of latch flapping inside one episode emit NOTHING new, in either direction');

    // ------------------------------------------------------------------------------------------
    // 6d. THE BOUNDED RE-OFFER. desk_notice rides HEALTH_POLICY 'drop', and this is the one message
    //     whose absence costs money, so a single attempt is not enough. Same shape as
    //     realAdapter._maybeReRaiseDown: identical key, so a delivered retraction dedupes every
    //     re-offer to nothing and only a dropped one is actually re-sent.
    // ------------------------------------------------------------------------------------------
    const eng3 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m3 = H.armFine(eng3, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng3.adapter.getAuctionState = async () => ({ ok: false });
    Object.assign(eng3.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng3._maybeBid(m3, armed());
    Object.assign(eng3.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    m3.revisionsLeft = 0;
    await eng3._maybeBid(m3, armed());
    ok(notices(eng3).length === 2, 'the retraction goes out once on the tick the episode closes');
    H.advance(30_000);
    await eng3._maybeBid(m3, armed());
    ok(notices(eng3).length === 2, 'a tick inside the re-offer cadence adds nothing');
    H.advance(31_000);
    await eng3._maybeBid(m3, armed());
    const reoffered = notices(eng3);
    ok(reoffered.length === 3
      && toNotification(reoffered[2]).dedupeKey === toNotification(reoffered[1]).dedupeKey,
      'and the next one re-offers the IDENTICAL key - a delivery retry, never a second message');
    // THE CADENCE IS RE-ARMED ON EVERY OFFER, not measured from the first one. Stamping offeredAt
    // once leaves every later tick past the 60s mark eligible, so the offer runs at TICK rate until
    // the cap absorbs it - and the cap alone makes the totals above identical either way. This is the
    // check that separates the two: 30s after the SECOND offer is still inside the window.
    H.advance(30_000);
    await eng3._maybeBid(m3, armed());
    ok(notices(eng3).length === 3, 'the window is measured from the LAST offer, not from the first');
    for (let i = 0; i < 40; i += 1) { H.advance(61_000); await eng3._maybeBid(m3, armed()); }
    ok(notices(eng3).length === 11,
      'the re-offer is bounded at 10 attempts, so it cannot run for the life of the auction');

    // ------------------------------------------------------------------------------------------
    // 6e. THE FIRE POINT DOES NOT DROP THE DEBT. The other deleted `_authBlockAlerted = false` sat
    //     at the fire point, and it is protected by a grep gate that a behavioural edit could route
    //     around. A latched adapter lets one trial write per interval through, so a held load really
    //     does reach that line mid-outage - and if the debt dies there the desk is never told to stop.
    // ------------------------------------------------------------------------------------------
    const eng4 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m4 = H.armFine(eng4, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng4.adapter.getAuctionState = async () => ({ ok: false });
    H.program(eng4, ['ok']);
    Object.assign(eng4.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0, held: true }));
    await eng4._maybeBid(m4, armed());
    ok(notices(eng4).length === 1 && m4._authNotice && m4._authNotice.state === 'held',
      'the held tick tells the desk and records the debt');

    Object.assign(eng4.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0, held: false }));
    await eng4._maybeBid(m4, armed());
    ok(m4.landedBids === 1,
      'PRECONDITION: the trial write is due, so this tick runs through the gate to the fire point and lands');
    ok(m4._authNotice && m4._authNotice.episode === T0,
      'and the fire point leaves the retraction debt standing - it clears the auth MARKS, never the record');

    Object.assign(eng4.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    m4.revisionsLeft = 0;
    await eng4._maybeBid(m4, armed());
    const afterTrial = notices(eng4);
    ok(afterTrial.length === 2 && afterTrial[1].authCleared === true,
      'so a load that landed a trial write mid-outage is still retracted when the episode closes');
    ok(afterTrial[1] && afterTrial[1].landedBids === 1,
      'and the retraction carries the same participation fact the open notice did, rather than a bare flag');

    // ------------------------------------------------------------------------------------------
    // 6f. THE LIVE RE-PRICE. setBidOverride on an armed load is stop + armFromRequest, so the monitor
    //     holding the debt is DELETED and a fresh one installed. Every other durable fact here
    //     (landedBids, everBid, revisionsLeft) is threaded across that rebuild; this one has to be
    //     too, and it is the only one whose loss is unsafe rather than wasteful - it drops the STOP
    //     signal, leaving the desk hand-quoting against SuperProcure's shared per-load cap.
    // ------------------------------------------------------------------------------------------
    const eng5 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m5 = H.armFine(eng5, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng5.adapter.getAuctionState = async () => ({ ok: false });
    Object.assign(eng5.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng5._maybeBid(m5, armed());
    ok(notices(eng5).length === 1, 'the load is told to hand-bid under the outage');

    eng5.stop('F');
    const m5b = H.armFine(eng5, [9_000, 8_700, 8_400]);
    ok(m5b !== m5, 'PRECONDITION: the re-price really did build a new monitor object');
    ok(m5b._authNotice && m5b._authNotice.episode === T0 && m5b._authNotice.state === 'held',
      'and the rebuilt monitor still owes the retraction for the episode the desk was told about');

    Object.assign(eng5.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    m5b.revisionsLeft = 0;
    await eng5._maybeBid(m5b, armed());
    const afterReprice = notices(eng5);
    ok(afterReprice.length === 2 && afterReprice[1] && afterReprice[1].authCleared === true && afterReprice[1].authSince === T0,
      'THE REBUILD: a re-priced load is still retracted, under the original episode\'s identity');

    // ------------------------------------------------------------------------------------------
    // 6g. THE CLOSE TIME FOLLOWS AN EXTENSION. meta.closesAt is the ARM-time close and a confirmed
    //     extension moves believedCloseAt alone. Havells runs soft-close branches, so reading meta
    //     puts a time already past in front of the desk during the one window a hand bid can still
    //     win the load - the error is always in the direction that suppresses the workaround.
    // ------------------------------------------------------------------------------------------
    const eng6 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m6 = H.armFine(eng6, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng6.adapter.getAuctionState = async () => ({ ok: false });
    const EXTENDED = m6.meta.closesAt + 900_000;
    m6.believedCloseAt = EXTENDED;
    Object.assign(eng6.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng6._maybeBid(m6, armed());
    const extended = notices(eng6)[0];
    ok(extended.closesAt === EXTENDED,
      'the desk is told the EXTENDED close, not the one the load armed against');
    const closesClause = (s) => (String(s).match(/This load closes (.+?) - please/) || [])[1] || null;
    const renderedExt = renderMessage('desk_notice', toNotification(extended).data);
    const renderedStale = renderMessage('desk_notice',
      toNotification(Object.assign({}, extended, { closesAt: m6.meta.closesAt })).data);
    ok(closesClause(renderedExt) && closesClause(renderedExt) !== closesClause(renderedStale),
      'and the rendered copy prints that later time rather than the arm-time one');

    // ------------------------------------------------------------------------------------------
    // 6h. NOT-BIDDABLE IS NOT A REASON TO GO SILENT. The loadNotBiddable stand-down sits above the
    //     auth branch, so a load told to be hand-bid and THEN refused by SuperProcure would never
    //     reach the retraction again. The desk's instruction outlives the load's biddability.
    // ------------------------------------------------------------------------------------------
    const eng7 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m7 = H.armFine(eng7, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng7.adapter.getAuctionState = async () => ({ ok: false });
    Object.assign(eng7.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng7._maybeBid(m7, armed());
    ok(notices(eng7).length === 1, 'the load is told to hand-bid under the outage');
    m7.loadNotBiddable = true;
    Object.assign(eng7.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    for (let i = 0; i < 20; i += 1) await eng7._maybeBid(m7, armed());
    const afterNotBiddable = notices(eng7);
    ok(afterNotBiddable.length === 2 && afterNotBiddable[1] && afterNotBiddable[1].authCleared === true,
      'a load that goes not-biddable after being told to be hand-bid is still retracted');
    ok(m7._authNotice && m7._authNotice.state === 'clear'
      && afterNotBiddable[1] && afterNotBiddable[1].authSince === T0,
      'once over those 20 ticks, keyed on the episode the desk was told about - the stand-down\'s '
      + 'silence still bounds everything else on this path');

    // ------------------------------------------------------------------------------------------
    // 6i. THE FALSE ALL-CLEAR. 6h's call site is the one place the retraction runs with the account
    //     DEAD, and "the identity moved" is not "the account recovered" - a SECOND outage moves it
    //     too. _alertAuthBlocked, which on the biddable path overwrites the record with the new
    //     episode and disposes of the debt, is below this return and never runs here. Emitting is
    //     strictly worse than the gap it closed: it tells the desk to stop hand-bidding at the exact
    //     moment the bot cannot bid.
    // ------------------------------------------------------------------------------------------
    const eng8 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m8 = H.armFine(eng8, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng8.adapter.getAuctionState = async () => ({ ok: false });
    Object.assign(eng8.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng8._maybeBid(m8, armed());
    ok(notices(eng8).length === 1 && m8._authNotice.episode === T0,
      'the load is told to hand-bid under episode E1');
    m8.loadNotBiddable = true;
    const E2 = T0 + 900_000;
    H.setClock(E2);
    Object.assign(eng8.adapter, H.fakeLatch({ dead: true, deadSince: E2, episodeSince: E2 }));
    for (let i = 0; i < 20; i += 1) { H.advance(61_000); await eng8._maybeBid(m8, armed()); }
    ok(notices(eng8).length === 1 && m8._authNotice.state === 'held',
      'A NOT-BIDDABLE LOAD UNDER A SECOND LIVE OUTAGE SAYS NOTHING - no all-clear while the account '
      + 'is still dead, and the debt is still owed');

    // THE GATE IS THE ACCOUNT FACT, NOT THE PER-TICK WRITE HOLD. A latched adapter with a trial write
    // due reads authWriteHeld() === false while isAuthDead() stays true - the narrower predicate is
    // "may THIS tick use the wire", and one permitted trial is not a recovery. Gating on it would
    // all-clear on any tick that happened to have a trial to spend, mid-outage.
    Object.assign(eng8.adapter, H.fakeLatch({ dead: true, deadSince: E2, episodeSince: E2, held: false }));
    H.advance(61_000);
    await eng8._maybeBid(m8, armed());
    ok(notices(eng8).length === 1 && m8._authNotice.state === 'held',
      'and a tick with a TRIAL WRITE due is still an outage - the retraction reads isAuthDead, never '
      + 'the narrower write hold');

    // ------------------------------------------------------------------------------------------
    // 6j. THE SAME ON THE SHADOW PATH. `authDead && softStrategy !== 'shadow'` sends a DEAD shadow
    //     monitor into the else branch, which is the other unconditional call site. It predates the
    //     not-biddable one and needs an operator config flip mid-flight to reach, but the account is
    //     just as dead when it evaluates the retraction.
    // ------------------------------------------------------------------------------------------
    const eng9 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m9 = H.armFine(eng9, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng9.adapter.getAuctionState = async () => ({ ok: false });
    H.setClock(T0);
    Object.assign(eng9.adapter, H.fakeLatch({ dead: true, deadSince: T0, episodeSince: T0 }));
    await eng9._maybeBid(m9, armed());
    ok(notices(eng9).length === 1, 'a shipper load is told to hand-bid under E1');
    m9.softStrategy = 'shadow';
    H.setClock(E2);
    Object.assign(eng9.adapter, H.fakeLatch({ dead: true, deadSince: E2, episodeSince: E2 }));
    for (let i = 0; i < 20; i += 1) { H.advance(61_000); await eng9._maybeBid(m9, armed()); }
    ok(notices(eng9).length === 1 && m9._authNotice.state === 'held',
      'A DEAD SHADOW MONITOR SAYS NOTHING EITHER - it is routed past the auth gate, not out of the '
      + 'outage');

    // And the retraction is still REACHABLE on both paths once the account is genuinely alive, so
    // the gate above is a liveness test rather than a mute.
    Object.assign(eng8.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    Object.assign(eng9.adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    H.advance(61_000);
    await eng8._maybeBid(m8, armed());
    await eng9._maybeBid(m9, armed());
    const clr8 = notices(eng8); const clr9 = notices(eng9);
    ok(clr8.length === 2 && clr8[1].authCleared === true && clr8[1].authSince === T0
      && clr9.length === 2 && clr9[1].authCleared === true && clr9[1].authSince === T0,
      'both retract on the first alive tick, keyed on E1 - the episode the desk was actually told '
      + 'about, not the one that came after it');
    H.realClock();
  }

  // ============================================================================================
  // 6b. THE LIVENESS GATE ITSELF - a dead account with NO identity at all
  // ============================================================================================
  // The second route to the same false clear, and it needs no second episode. realAdapter.authState()
  // derives EXPIRED from (tokenExp, now) alone - pure arithmetic, no bookkeeping - while _episodeSince
  // is opened only by _noteTokenExpired, which runs only when something actually touches the wire.
  // Between a token lapsing on the clock and the next call that observes it, isAuthDead() is true and
  // all three fallbacks in _authOutageIdentity resolve through a null _episodeSince. A null-identity
  // test alone would therefore all-clear into a provably dead token, race-free and on the first tick.
  {
    const T0 = 1_770_000_000_000;
    H.freezeClock(T0);
    const t = H.transport({});
    const adapter = H.mkAdapter(t.impl, { tokenLifeMs: 60_000 });
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    eng.adapter = adapter;

    const E1 = T0 - 500_000;
    m._authNotice = { episode: E1, state: 'held' };
    m.loadNotBiddable = true;

    H.advance(60_001); // the token lapses; nothing has called the wire, so no episode is open
    ok(adapter.authState() === 'EXPIRED' && adapter.isAuthDead() === true
      && adapter.authEpisodeSince() == null && eng._authOutageIdentity() == null,
      'THE WINDOW: the real adapter is EXPIRED and dead while its episode identity is still null');

    await eng._maybeBid(m, H.state(50_000, 2));
    ok(H.alertsOfKind(eng, 'session_logged_out').length === 0,
      'and nothing is retracted into it - the gate reads the LIVE state, not the identity');

    // Recovery here is a new token, i.e. a new adapter (realAdapter: "no local behaviour can un-lapse
    // a JWT"). The debt survives on the monitor and is paid on the first tick that reads alive.
    eng.adapter = Object.assign({}, adapter, H.fakeLatch({ dead: false, deadSince: null, episodeSince: null }));
    await eng._maybeBid(m, H.state(50_000, 2));
    const paid = H.alertsOfKind(eng, 'session_logged_out');
    ok(paid.length === 1 && paid[0].authCleared === true && paid[0].authSince === E1,
      'the debt is not lost by the wait - a fresh token pays it under the episode the desk was told');

    // THE CARRY MAP IS BOUNDED. Entries are consumed only by a later arm() of the same auctionId, so
    // a load stopped and never re-armed - the ordinary end of any auction that closed mid-outage -
    // leaks one for the life of the process.
    const engC = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    for (let i = 0; i < 250; i += 1) {
      engC.monitors.set(i, { auctionId: i, timer: null, _authNotice: { episode: T0, state: 'held' } });
      engC.stop(i);
    }
    ok(engC._authNoticeCarry.size === 200,
      'a stopped-and-never-re-armed load cannot grow the carry map without bound');
    ok(engC._authNoticeCarry.has(249) && !engC._authNoticeCarry.has(0),
      'and eviction is oldest-first, so the debt a re-price is about to collect is the one kept');
    H.realClock();
  }

  // ============================================================================================
  // 7. THE RECOVERY WINDOW, THROUGH THE REAL ADAPTER'S OWN TIMER SEAM
  // ============================================================================================
  // Every check above drives a hand-rolled latch stub, where the episode vanishes the instant the
  // stub reports alive. The real adapter does not work that way and the difference is the entire
  // bug: _noteWriteSuccess unlatches immediately on an accepted write and only then arms the
  // authSettleMs timer, and _emitAllClear - which that timer fires - is the sole site that closes an
  // episode. So the account reads ALIVE for ~3 minutes while the episode is still open. A suite
  // proving recovery only against stubs would go green while testing a weaker standard than ships.
  {
    const T0 = 1_770_000_000_000;
    H.freezeClock(T0);
    let bidAnswer = H.DEAD;
    const t = H.transport({ bid: (...args) => bidAnswer(...args) });
    const adapter = H.mkAdapter(t.impl);

    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    // Swapped in AFTER arm, so capabilities came off the same fake seam every other check here uses;
    // what is under test is the auth state machine, not the real adapter's pricing surface.
    eng.adapter = adapter;

    await H.latchWrites(adapter);
    const episode = adapter.authEpisodeSince();
    ok(adapter.isAuthDead() === true && episode != null,
      'two refused writes latch the REAL adapter and open an episode');

    await eng._maybeBid(m, H.state(50_000, 2));
    ok(H.alertsOfKind(eng, 'session_logged_out').length === 1,
      'the load is told to be hand-bid while the real adapter is latched');

    // THE TRIAL WRITE THAT LANDS. A latched adapter lets exactly one write per interval reach the
    // wire, and only an accepted one clears - this is the accepted-write recovery standard itself.
    bidAnswer = H.OK_BID;
    H.advance(adapter.authWriteTrialIntervalMs + 1);
    await H.bid(adapter);
    ok(adapter.isAuthDead() === false && adapter.authEpisodeSince() === episode,
      'THE WINDOW: the accepted write unlatches immediately while the episode stays open');

    // The load never bids again - its budget is gone - so the retraction cannot ride a fire point.
    m.revisionsLeft = 0;
    await eng._maybeBid(m, H.state(9_000, 2));
    ok(H.alertsOfKind(eng, 'session_logged_out').length === 1,
      'and nothing is retracted inside that window - the episode we spoke under has not ended');

    H.advanceFiring(adapter.authSettleMs + 1);
    ok(adapter.authEpisodeSince() == null, 'the settle timer fires and the episode closes');

    await eng._maybeBid(m, H.state(9_000, 2));
    const real = H.alertsOfKind(eng, 'session_logged_out');
    ok(real.length === 2 && real[1].authCleared === true && real[1].authSince === episode,
      'THE REGRESSION: the load recovers through the real settle timer and IS retracted, on a tick '
      + 'long after the one where the account first read alive');
    H.realClock();
  }

  // ============================================================================================
  // 8. THE RETRACTION THROUGH THE REAL NOTIFIER - the defect was a ROUTING defect
  // ============================================================================================
  // Every check above stops at the emitted event or the rendered string, and the thing that was
  // broken is neither: raiseAuthRestored's all-clear is UNSCOPED, scopeMatches requires data.shipper,
  // and every group told to hand-bid a load is shipper-scoped - so the account-wide recovery message
  // could not reach the one audience holding the instruction. An emit nobody receives is the original
  // bug with a new shape, so this drives the engine's own event through toNotification, the real
  // Notifier, its real scope matching and the real WhatsApp client, and asserts the GROUP got it.
  {
    const GROUP = '120363111111111111@g.us';
    const sends = [];
    const transport = async (url, opts) => {
      sends.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
    };
    const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
    // The Havells group as it is actually configured: shipper-scoped, subscribed to desk_notice. The
    // unscoped ops DM beside it is the control - it is who the account-wide all-clear DOES reach, and
    // reaching only them is exactly the failure this message exists to fix.
    const recipients = [
      { name: 'Havells group', phone: GROUP, alerts: ['desk_notice'], scope: { shippers: ['Havells'] } },
      { name: 'Ops', phone: '+919000000001', alerts: ['desk_notice'] },
    ];
    const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(), recipientsProvider: async () => recipients, healthProvider: async () => true });

    const EP = 1_786_000_000_000;
    const evt = authEvent({ auctionId: 23803049, companyName: 'Havells India Ltd.', branchName: null,
      authSince: EP, landedBids: 0 });
    await notifyEngineEvent(notifier, evt);
    ok(sends.length === 1 && sends[0].to_number === GROUP,
      'the open-time notice reaches the shipper-scoped group, and only it - a scoped group is its '
      + 'customer\'s sole channel, so the DM is suppressed');

    await notifyEngineEvent(notifier, Object.assign({}, evt, { level: 'info', authCleared: true }));
    const retracted = sends[1] || {};
    ok(sends.length === 2 && retracted.to_number === GROUP,
      'THE ROUTING FIX: the retraction reaches that SAME shipper-scoped group. The account-wide '
      + 'all-clear carries no shipper and can never match it, which is why this message exists');
    ok(/no need to bid it by hand/i.test(retracted.message || ''),
      'and what lands there is the withdrawal, not the instruction');
    ok(!/please bid it directly on the SuperProcure portal/i.test(retracted.message || ''),
      'with the open-time instruction gone from it entirely');

    // THE SENT-MARK IS PER STATE, not per episode. Delivering the open notice must not burn the key
    // the retraction needs - that is the swallow this whole state token exists to prevent, and it is
    // only observable here, at the layer that actually holds the marks.
    await notifyEngineEvent(notifier, Object.assign({}, evt, { level: 'info', authCleared: true }));
    ok(sends.length === 2,
      'a second identical retraction is deduped by the notifier - the re-offer is a delivery retry, '
      + 'never a second message');
  }

  // ============================================================================================
  // 9. WHAT THE DESK IS ACTUALLY HOLDING WHEN A RETRACTION IS DROPPED
  // ============================================================================================
  // desk_notice rides HEALTH_POLICY 'drop', so a logged-out Maytapi sender at the wrong instant loses
  // the retraction outright - the failure the bounded re-offer exists to cover. Everything above
  // stops at the emit, and an emit nobody receives leaves the instruction standing just as surely as
  // no emit at all. This drives the whole arc through the real Notifier and asserts on the group's
  // received messages: whether a dropped retraction is BLOCKING (the key is burnt and no later
  // message can withdraw the instruction) or LATENT (recoverable by the engine's own re-offer).
  {
    const GROUP = '120363222222222222@g.us';
    const sends = [];
    const transport = async (url, opts) => {
      sends.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
    };
    const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
    let healthy = true;
    const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(),
      recipientsProvider: async () => [
        { name: 'Havells group', phone: GROUP, alerts: ['desk_notice'], scope: { shippers: ['Havells'] } }],
      healthProvider: async () => healthy });

    const E1 = 1_787_000_000_000;
    const E2 = E1 + 3_600_000;
    const at = (over) => authEvent({ auctionId: 23803049, companyName: 'Havells India Ltd.',
      branchName: null, landedBids: 0, ...over });
    const isInstruction = (s) => /bid it directly on the SuperProcure portal/i.test(s.message || '');
    const isWithdrawal = (s) => /no need to bid it by hand/i.test(s.message || '');

    await notifyEngineEvent(notifier, at({ authSince: E1 }));
    ok(sends.length === 1 && sends[0].to_number === GROUP && isInstruction(sends[0]),
      'the desk is instructed to hand-bid the load under E1');

    healthy = false;
    await notifyEngineEvent(notifier, at({ authSince: E1, level: 'info', authCleared: true }));
    ok(sends.length === 1,
      'THE DROP: the sender is down when the retraction is offered, and desk_notice is policy-drop, '
      + 'so nothing reaches the group');

    // A SECOND OUTAGE, and the desk has still never been told to stop. This is the state that makes
    // the engine's liveness gate load-bearing rather than pedantic: the only honest message here is
    // another instruction, and an all-clear would be false on the wire as well as in the engine.
    healthy = true;
    await notifyEngineEvent(notifier, at({ authSince: E2 }));
    ok(sends.length === 2 && isInstruction(sends[1]),
      'a second episode re-instructs the desk on the same group - a fresh episode is a fresh key, so '
      + 'the swallowed retraction did not consume it');
    ok(!sends.some((s) => isWithdrawal(s)),
      'and across the whole arc the group has received NO withdrawal - the instruction it is holding '
      + 'is the true state of the account');

    await notifyEngineEvent(notifier, at({ authSince: E2, level: 'info', authCleared: true }));
    ok(sends.length === 3 && isWithdrawal(sends[2]) && !isInstruction(sends[2]),
      'and when E2 genuinely recovers the withdrawal does land');

    // THE VERDICT: LATENT, NOT BLOCKING. notifier._markSent writes only when a send actually reached
    // somebody, so the dropped E1 retraction burnt nothing and the engine's bounded re-offer can
    // still deliver it. Offered here after E2's own retraction to prove the key survived the drop
    // rather than merely the ordering.
    await notifyEngineEvent(notifier, at({ authSince: E1, level: 'info', authCleared: true }));
    ok(sends.length === 4 && isWithdrawal(sends[3]),
      'A DROPPED RETRACTION IS RECOVERABLE, not lost: the drop leaves no sent-mark, so the same '
      + 'message re-offered on the 60s cadence still reaches the group');
  }

  H.cleanup();
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { H.realClock(); H.cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
