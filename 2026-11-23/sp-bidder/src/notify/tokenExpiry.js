'use strict';

const { createLogger } = require('../logging/logger');

/**
 * Proactive bearer-token expiry warning. There is no refresh-token loop for SuperProcure
 * auth (see SUPERPROCURE_API.md / MODULE_1_SCOPE_AND_ARCHITECTURE.md) - a lapsed token is a
 * silent, manual-recovery-only outage, which is exactly what makes an unwatched token
 * dangerous. This never refreshes anything; it only makes the clock impossible to miss.
 *
 * Reused across platforms via `product` (the human label in the alert) + `tokenKind` (the log/
 * context prefix): the defaults reproduce the SuperProcure wording exactly, so existing SP
 * callers are byte-identical, while the GoComet adapter passes product 'GoComet' / tokenKind
 * 'gc-token' for its ~monthly JWT - GoComet's short lifetime makes this rail matter far more
 * there than for SP's ~1yr token.
 *
 * Every threshold the token has already crossed fires once each (dedupe keys off the threshold,
 * not the day) - a box that boots with only 10 days left still gets the 30/14/7 pings on that
 * first check instead of staying silent until 3 days out.
 *
 * ---- SHORT-LIVED TOKENS ----------------------------------------------------------------------
 * A white-label tenant can issue a session that lives HOURS, not months (the SuperProcure Rallis
 * tenant mints 8.16h tokens against SP main's 8,760h). The day ladder is not merely imprecise
 * there, it is degenerate: every rung is longer than the token's whole life, so all five fire on
 * the first check and the operator gets five identical WhatsApp alerts seconds after boot, none
 * of which is a *warning* because the ladder can no longer lead the expiry it is warning about.
 *
 * So when the caller can tell us the token's actual LIFETIME, the rungs are chosen to fit it and
 * only the most urgent crossed rung fires. Two deliberate properties:
 *
 *  - Lifetime unknown, or longer than SHORT_LIFETIME_MS, takes the original path unchanged. SP
 *    main and GoComet callers that pass no lifetime keep byte-identical behaviour, which is why
 *    this is additive rather than a rewrite of a live alerting rail.
 *  - The short-path dedupe key carries the token's own expiry instant. The notifier's sent-mark
 *    has no TTL (it ages out only when the 1000-entry LRU cap evicts it), so the long path's
 *    `<label>_<rung>` key would suppress the warning for every FUTURE token on that account too -
 *    on a token that rotates three times a day that means exactly one warned token, ever, and
 *    silence afterwards.
 *
 * ONE pre-expiry rung, at 30 minutes (owner ask, 2026-09-10): the 2h and 15m rungs this ladder
 * used to carry produced three near-duplicate WhatsApp messages per session instead of one useful
 * warning, and were dropped. Once the session has actually lapsed (msLeft <= 0) the warning does
 * NOT fire again - "expires in ~NOW" restates the warning instead of stating the new fact that
 * bidding has actually stopped.
 *
 * ---- WHO IS TOLD, AND IN WHOSE WORDS ---------------------------------------------------------
 * Two audiences, two strings. The owner's ask (2026-09-10) was explicit that the affected
 * customer's own WhatsApp group hears this too, because the desk quoting that customer has to know
 * bidding stopped. An 'error' payload deliberately carries no scope keys (authAlert.js), so it can
 * never reach a customer group; the desk half is a separate 'desk_notice' raise.
 *
 *  - ADMIN copy names the internal account label, which is what disambiguates one account from
 *    another on a multi-account box, and may say operational things only BRL can act on.
 *  - DESK copy names the CUSTOMER and says only what that desk can act on. It never carries the
 *    account label: an internal slug read back into the customer's own group is jargon there, and
 *    notifier.js:706-713 already settled that convention for the account identifier.
 *
 * The desk half FAILS CLOSED. It goes out only when the caller supplies the single customer this
 * account bids for (accounts.deskCustomerFor); with none, the notice is dropped and logged. It is
 * not routed on the account label, and an absent key is never sent as an empty one - scopeMatches
 * treats an empty scope as "everything", so an unnamed customer channel is a fan-out to every
 * unscoped recipient, not the safe no-op it looks like.
 *
 * WHAT THIS MODULE DOES NOT RAISE: the admin copy for an already-lapsed session. That belongs to
 * the wire rail (realAdapter -> raiseAuthDead -> account_auth_expired), which states the same fact
 * with the login contact, the episode identity, the re-sign-in remedy and a paired all-clear -
 * see the msLeft <= 0 branch below.
 */
const log = createLogger('tokenExpiry');

const WARN_THRESHOLDS_DAYS = [30, 14, 7, 3, 1];

// Below this lifetime the day ladder above has no rung that can lead the expiry, so the hour
// ladder replaces it. 48h keeps every token the system has shipped with to date (SP ~1yr,
// GoComet ~monthly) on the original path.
const SHORT_LIFETIME_MS = 48 * 3600000;
// One rung: runway to find the person holding the handset before the session actually dies.
// Expressed as time-before-expiry rather than as a fraction or a fixed hour of the token's life,
// so it stays correct when a tenant's TTL changes. shortRungsFor drops the rung when it is >= the
// lifetime, so a token shorter than 30 minutes still gets exactly one warning instead of none.
const SHORT_WARN_MS = [30 * 60000];

const IST_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * One definition, deliberately shared by the ladder choice and the cadence choice. They have to
 * agree: a token on the hour ladder but the 24h cadence is born and dies between two checks, which
 * is the exact defect the hour ladder exists to fix. Two copies of this predicate is how that
 * comes back.
 */
function isShortLived(lifetimeMs) {
  return Number.isFinite(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= SHORT_LIFETIME_MS;
}

function rungLabel(ms) {
  return ms >= 3600000 ? `${ms / 3600000}h` : `${ms / 60000}m`;
}

// Called only with ms > 0 - checkTokenExpiry routes an already-lapsed token to the disconnect
// alert below instead, so this never has to render a past-tense "already expired" phrase.
function shortLeft(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `in ~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ~${h}h ${m}m` : `in ~${h}h`;
}

/**
 * The rungs worth arming for a token of this lifetime: any rung at or above the lifetime would
 * fire the instant the token is minted, which is noise rather than warning. Keeping the smallest
 * rung when that filter empties the ladder guarantees a token always has at least one warning,
 * however short it is.
 */
function shortRungsFor(lifetimeMs) {
  const usable = SHORT_WARN_MS.filter((r) => r < lifetimeMs);
  return usable.length ? usable : [SHORT_WARN_MS[SHORT_WARN_MS.length - 1]];
}

/**
 * The desk half of a session alert - the affected customer's own WhatsApp group.
 *
 * Shared by both branches so the routing contract is written once: one payload shape, one
 * fail-closed test, one place to change if the contract moves. The two branches differ only in
 * their wording and their dedupe key.
 *
 * `accountWide` is what makes this reachable at all. scopeMatches ANDs every dimension a recipient
 * sets, and an account fact has no origin and no branch to offer, so a branch- or origin-narrowed
 * group would be structurally unmatchable however exactly its shipper name agrees. The flag tells
 * the notifier to judge this on the shipper dimension alone - and, for the same reason, to refuse a
 * recipient carrying no shipper scope rather than treat the empty scope as "everything".
 */
async function raiseDeskSessionNotice(notifier, { deskCustomer, platformKey, sessionAlert, detail,
  dedupeKey, tokenKind, accountLabel }) {
  if (!deskCustomer) {
    log.info(`${tokenKind}-${accountLabel} desk notice not sent - no single customer maps to this account`,
      { accountLabel, sessionAlert });
    return;
  }
  await notifier.alert('desk_notice', {
    shipper: deskCustomer,
    accountWide: true,
    platformKey,
    sessionAlert,
    detail,
  }, { dedupeKey });
}

async function checkTokenExpiry({ tokenExp, notifier, accountLabel = 'default', now = Date.now(),
  product = 'SuperProcure', tokenKind = 'sp-token', tokenLifetimeMs = null, platformKey = null,
  deskCustomer = null,
  // C078: an admin credential-expiry alarm must never be silenced by a platform's per-LOAD
  // notification-mode setting (gocometNotifyMode exists to cut load-message noise, not to gate
  // ops alarms). Caller-supplied so this stays a no-op for SuperProcure (whose own notifyMode
  // setting IS the operator's real choice for these alerts) and forces WhatsApp only where the
  // caller explicitly asks - see the GoComet expiryArgs in server.js.
  notifyModeOverride = null,
  // C074: SuperProcure's remedy is a real, self-serve reconnect (the console's OTP flow), so the
  // default wording says "reconnect". GoComet has no such page - its "reconnect" routes are the SP
  // OTP flow and never list a GoComet row - so a GoComet caller passes its own remedy phrase
  // (update GC_TOKEN and restart) instead of pointing the desk at a page that does not exist.
  shortRemedy = `Reconnect ${accountLabel}`, longRemedy = 'reconnect the account' }) {
  if (!tokenExp || !notifier) return;
  const daysLeft = (tokenExp - now) / 86400000;
  const expDate = new Date(tokenExp).toISOString().slice(0, 10);
  // Routine visibility for every check, not just the ones that cross a threshold, so
  // `pm2 logs` shows this ran at all rather than only ever speaking up in the final days -
  // the WhatsApp alert below is one delivery path; this is the other, always-on one.
  log.info(`${tokenKind}-${accountLabel} expiry check`, { accountLabel, expDate, daysLeft: Math.floor(daysLeft) });

  if (isShortLived(tokenLifetimeMs)) {
    const msLeft = tokenExp - now;
    const tokenSlug = Math.floor(tokenExp / 1000);

    // THE SESSION HAS ACTUALLY LAPSED, and only the DESK half is raised here.
    //
    // The admin half already has an owner. The first read past exp throws through
    // realAdapter._refuseIfTokenExpired -> _noteTokenExpired -> onAuthDead -> raiseAuthDead, which
    // renders account_auth_expired: the same fact, plus the account's login-contact email, the
    // episode identity, the sign-in-again remedy, and an all-clear keyed to that episode. Raising a
    // second 'error' from the clock put TWO admin WhatsApps on every tenant lapse, which is the
    // noise this change exists to remove. The clock's job is the warning that LEADS the expiry;
    // once the session is gone, the rail that touched the wire states it.
    //
    // The desk notice is keyed off the token's own expiry instant (same rotation-trap reasoning as
    // the warning below), so it fires once per token and a rotated token gets its own message. Its
    // retraction is raised at the accepted-write settle - authAlert.raiseAuthRestored - and never
    // off a reconnect, because a reconnect is a read and says nothing about write scope.
    if (msLeft <= 0) {
      log.warn(`${tokenKind}-${accountLabel} session disconnected`, { accountLabel, expDate, msLeft });
      await raiseDeskSessionNotice(notifier, {
        deskCustomer, platformKey, tokenKind, accountLabel,
        sessionAlert: 'disconnected',
        detail: `Bidding has stopped for ${deskCustomer} - our ${product} access has disconnected.`
          + ' Quote these loads on the portal in the meantime.',
        dedupeKey: `token_expired_desk_${accountLabel}_${tokenSlug}`,
      });
      return;
    }

    const crossed = shortRungsFor(tokenLifetimeMs).filter((r) => msLeft <= r);
    if (!crossed.length) return;
    // Only the most urgent rung. The rung is a dedupe bucket, not information - the message
    // already carries the real time remaining - so firing every crossed rung would deliver the
    // same sentence several times over.
    const rung = Math.min(...crossed);
    const left = shortLeft(msLeft);
    const atIST = `${IST_HM.format(new Date(tokenExp))} IST`;
    log.warn(`${tokenKind}-${accountLabel} within ${rungLabel(rung)} expiry window (${left})`,
      { accountLabel, expDate, msLeft, thresholdMs: rung });
    await notifier.alert('error', {
      context: `${tokenKind}-${accountLabel}`,
      // Absent means SuperProcure at the notifier, so a portal that does not pass its key has its
      // token warnings delivered on SuperProcure's channel.
      platformKey,
      notifyModeOverride,
      detail: `${shortRemedy} soon - ${product} session expires ${left} (${atIST}), then bidding stops.`,
    }, { dedupeKey: `token_expiry_warn_${accountLabel}_${tokenSlug}_${rungLabel(rung)}` });
    await raiseDeskSessionNotice(notifier, {
      deskCustomer, platformKey, tokenKind, accountLabel,
      sessionAlert: 'expiring',
      detail: `Bidding access for ${deskCustomer} runs out ${left} (${atIST}).`
        + ' Quote these loads on the portal if it lapses.',
      dedupeKey: `token_expiry_warn_desk_${accountLabel}_${tokenSlug}_${rungLabel(rung)}`,
    });
    return;
  }

  for (const d of WARN_THRESHOLDS_DAYS) {
    if (daysLeft > d) continue;
    const left = daysLeft <= 0 ? 'TODAY or already past' : `in ~${Math.ceil(daysLeft)}d`;
    log.warn(`${tokenKind}-${accountLabel} within ${d}d expiry window (${left})`,
      { accountLabel, expDate, daysLeft: Math.ceil(daysLeft), thresholdDays: d });
    await notifier.alert('error', {
      context: `${tokenKind}-${accountLabel}`,
      platformKey,
      notifyModeOverride,
      detail: `${product} token (${accountLabel}) expires ${left} (${expDate}) - ${longRemedy} before it lapses.`,
    }, { dedupeKey: `token_expiry_warn_${accountLabel}_${d}` });
  }
}

/**
 * How often the caller should re-run the check for a token of this lifetime. A 24h cadence on an
 * 8h token means the ONLY check that ever runs is the one at activation, so no pre-expiry warning
 * can physically be delivered - the token is born and dies between two ticks.
 */
function expiryCheckIntervalMs(tokenLifetimeMs) {
  return isShortLived(tokenLifetimeMs) ? 5 * 60000 : 24 * 3600000;
}

module.exports = {
  checkTokenExpiry, expiryCheckIntervalMs, isShortLived,
  WARN_THRESHOLDS_DAYS, SHORT_WARN_MS, SHORT_LIFETIME_MS,
};
