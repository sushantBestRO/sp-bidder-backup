'use strict';

/**
 * The ONE raiser for "SuperProcure has logged this account out".
 *
 * Two independent paths detect the same condition - the adapter's runtime latch (a 401/403 while the
 * box is running) and the boot path (login() failing with code AUTH on startup) - and before this
 * they said different things about it. Boot rendered the generic error template with a raw
 * `auth_failed_401` on it; runtime said nothing at all. Routing both through this function is what
 * makes the convergence structural rather than a copy-paste agreement that drifts on the next edit.
 *
 * WHY IT RAISES THE 'error' KIND rather than a new one. `account_auth_dead` is a TEMPLATE selected
 * inside `error` by the `authDead` flag on the payload (see waTemplates.templateFor), the same way
 * `no_bid` lives inside `lost`. Minting a new configStore.ALERT_KINDS member would reach strictly
 * FEWER people: the Director's alert list is an explicit literal array that a new kind would not be
 * in, and the customer groups are shipper-scoped while this payload deliberately carries no shipper.
 * A new kind would deliver this to nobody until every recipient record was migrated.
 *
 * WHY THE PAYLOAD CARRIES NO SCOPE KEYS. There is no origin, shipper or branch here on purpose: this
 * is an account-wide operational fact, not a customer's load. scopeMatches then filters out every
 * shipper-scoped recipient, so the 11 customer groups never see it and it lands only with the
 * unscoped operator recipients - which is exactly the audience the 56 symptom messages went to, and
 * exactly the audience that can act on it.
 *
 * WHY THE DEDUPE KEY CARRIES BOTH THE ACCOUNT AND THE INSTANT. The notifier's sent-mark is a
 * PERMANENT store document with no TTL, so a bare `sp_auth_dead_<accountId>` would fire once ever and
 * every later revocation of that account would be silent - the exact failure class this work exists
 * to close. The account id keeps five accounts revoked in the same second from swallowing each
 * other's messages; the instant makes each EPISODE its own key.
 *
 * `since` IS THE EPISODE ID, and nothing else may be passed for it. The episode opens at the first
 * latch of an outage and closes only when the all-clear is actually emitted, so it is stable across
 * an arbitrary number of latch/clear cycles inside one outage - which is what makes "one message per
 * outage" true. Keying off the per-latch instant instead is what produced ~60 alternating
 * "logged out" / "back online" messages in 95 minutes. Repeat raises inside one episode are DELIVERY
 * RETRIES: identical key, and the notifier sent-marks only a send that reached somebody, so a
 * delivered message dedupes the retry to nothing while a dropped one gets another chance.
 *
 * WHY `affectedCustomers` IS CARRIED THROUGH AS-IS, NEVER DERIVED HERE. This raiser is the wrong
 * layer to compute it: it has no access to priceRequests, closedBids, the customer list, or which
 * other accounts are currently live, and it must never throw or block regardless. The caller (the
 * boot loop and the runtime latch, both in server.js) already has all of that and derives the list
 * through `src/model/coverage.js` - the module built specifically to avoid the stale-registration
 * trap (`person.accountId`) that would misreport a customer like Durian as affected after its
 * loads migrated to a different, live account. An absent/non-array value degrades to `[]`, which
 * the templates render as "no customers are affected" - the safe default when the caller could not
 * compute it, not a claim that nothing is actually affected.
 *
 * WHY `reason` IS CARRIED THROUGH. Two different conditions reach this raiser and they have two
 * different remedies, so they get two different templates - see account_auth_expired in
 * waTemplates.js. Dropping the fact here (which is what this function did) rendered the revocation
 * copy for both. It is surfaced on the payload as `authReason`, NOT `reason`: plain `reason` is
 * already the no-bid outcome key that waTemplates' noBidWhy branch reads off a load payload, and
 * reusing the name on an account payload invites the two to be conflated by the next person editing
 * either side.
 *
 * THE DEDUPE KEY IS UNCHANGED BY IT. The key is the episode, and an episode that latches on refusals
 * and later runs past its own exp is still ONE outage with one message owed - a reason-keyed variant
 * would mint a second message for the same thing.
 *
 * It never throws and never blocks: both are non-negotiable, because the runtime caller is on the
 * bid path.
 */
function raiseAuthDead(notifier, { accountId, accountLabel, since, reason, affectedCustomers } = {}) {
  if (!notifier || typeof notifier.alert !== 'function') return;
  try {
    const p = notifier.alert('error', {
      authDead: true,
      // accountId is load-bearing beyond identification: notifier._whatsapp looks up the account's
      // login contact and appends "Account: <email>" for free when one is on file, which is exactly
      // the handle whoever reconnects needs.
      accountId: accountId || null,
      accountLabel: accountLabel || accountId || null,
      since: since || null,
      authReason: reason || null,
      affectedCustomers: Array.isArray(affectedCustomers) ? affectedCustomers : [],
      // null is the raiser saying the lookup failed; undefined is a caller that never looked.
      affectedUnknown: affectedCustomers === null,
    }, { dedupeKey: authDeadKey(accountId, since) });
    return Promise.resolve(p).catch(() => {});
  } catch (_) { /* alerting must never break a bid/read path */ }
  return Promise.resolve();
}

function authDeadKey(accountId, since) {
  return `sp_auth_dead_${accountId || 'unknown'}_${since || 0}`;
}

/**
 * The all-clear counterpart to raiseAuthDead - "SuperProcure signed this account back in."
 *
 * Without this, the desk keeps operating on the auth_dead alert's "quote these loads from the
 * SuperProcure portal in the meantime" instruction for as long as nobody happens to notice the bot
 * resumed. On this account the bot and the desk share one SuperProcure per-load bid cap, so a desk
 * still hand-quoting after the bot is back double-counts against that cap and starts costing the
 * bot's own bids on low-cap loads - a known collision mode, not a hypothetical one.
 *
 * Same 'error' kind, same reasoning as raiseAuthDead (no new ALERT_KINDS member, no scope keys, never
 * throws/blocks). The dedupe key ties to the SAME episode id the down-alert used, so this message
 * closes that exact message rather than minting an unrelated one.
 *
 * THE CALLER GUARANTEES THE EVIDENCE, and there is exactly one standard: an accepted write. This is
 * reached only from the adapter's resolve-side settle timer, which fires only after the account has
 * held CLEAR continuously since a bid of ours was accepted. No other layer may call it - in
 * particular the composition root must not, because everything it can complete on a reconnect is a
 * READ and a read says nothing about write scope. A reconnect says "confirming" instead; see
 * raiseAuthConfirming.
 *
 * `deskCustomer` ADDS THE CUSTOMER-CHANNEL RETRACTION, and it is raised HERE for that same evidence
 * standard. tokenExpiry's disconnect notice tells the customer's own group that bidding stopped on
 * their loads; a standing claim with no withdrawal leaves that desk hand-quoting indefinitely, and
 * the desk and this system share one per-load SuperProcure bid cap - so a hand quote placed after
 * we are bidding again costs us our own bid. Absent (a shared account with no single customer, or
 * a caller that does not resolve one) it is simply not raised: the admin half is unchanged, and an
 * unnamed customer key would fan out rather than fail closed (see notifier.scopeMatches).
 */
function raiseAuthRestored(notifier, { accountId, accountLabel, since, downForMs, deskCustomer } = {}) {
  if (!notifier || typeof notifier.alert !== 'function') return;
  try {
    const p = notifier.alert('error', {
      authRestored: true,
      accountId: accountId || null,
      accountLabel: accountLabel || accountId || null,
      since: since || null,
      downForMs: downForMs || null,
    }, { dedupeKey: `sp_auth_restored_${accountId || 'unknown'}_${since || 0}` });
    if (p && typeof p.catch === 'function') p.catch(() => {});
    if (deskCustomer) {
      const d = notifier.alert('desk_notice', {
        shipper: deskCustomer,
        accountWide: true,
        sessionAlert: 'restored',
        detail: `Bidding has resumed for ${deskCustomer} - our SuperProcure access is back.`
          + ' No more manual quoting needed on it.',
      }, { dedupeKey: `sp_auth_restored_desk_${accountId || 'unknown'}_${since || 0}` });
      if (d && typeof d.catch === 'function') d.catch(() => {});
    }
  } catch (_) { /* alerting must never break a bid/read path */ }
}

/**
 * The PROVISIONAL middle state - "we are back on this account and confirming; keep quoting by hand."
 *
 * It exists because the composition root has real news and no proof. A reconnect or a restart puts a
 * live session on the account and the desk deserves to know somebody acted, but that evidence is all
 * reads (see raiseAuthRestored). Announcing "back online" off it is how the desk was told to stop
 * hand-quoting an account that still could not bid.
 *
 * So the reconnect says this instead, and does NOT close the episode: the fresh adapter inherits the
 * open episode and closes it later through the one recovery standard - an accepted bid - at which
 * point the real all-clear goes out with the same episode id and the desk is told to stop.
 *
 * Keyed to the episode, so a second reconnect attempt inside one outage does not re-send it.
 */
function raiseAuthConfirming(notifier, { accountId, accountLabel, since } = {}) {
  if (!notifier || typeof notifier.alert !== 'function') return;
  try {
    const p = notifier.alert('error', {
      authConfirming: true,
      accountId: accountId || null,
      accountLabel: accountLabel || accountId || null,
      since: since || null,
    }, { dedupeKey: `sp_auth_confirming_${accountId || 'unknown'}_${since || 0}` });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* alerting must never break a bid/read path */ }
}

module.exports = { raiseAuthDead, raiseAuthRestored, raiseAuthConfirming, authDeadKey };
