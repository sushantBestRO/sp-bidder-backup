'use strict';

const crypto = require('crypto');
const { createLogger } = require('../logging/logger');

/**
 * Session scope-refresh guard (the 2026-07-16 branch-mapping incident, generalized).
 *
 * SuperProcure resolves an account's branch scope SERVER-SIDE at login time
 * (getHeader -> branchList), and listAuctions() only ever queries the branchIds
 * the LAST login captured. When BRL's SP admin maps new branches onto the master
 * account (2026-07-16: 249 -> 276 overnight), a long-running process keeps
 * listing against the stale set - a live, biddable auction on any new branch is
 * simply invisible to the bot, while a FRESH login with the SAME bearer token
 * sees it immediately. Auction 23188358 (Tata) was caught 29 minutes before
 * close only because a human happened to pm2-restart. More branch mappings are
 * already queued client-side, so this cannot stay a restart-only fix.
 *
 * Two cooperating pieces behind one seam:
 *
 *  - checkScopeChange(): fingerprint the branch scope every successful login
 *    yields, persist it per account, and route a change through the existing
 *    notifier ('error' template - the same context/detail delivery tokenExpiry
 *    and boot failures use, so it reaches whoever already subscribes to
 *    operational alerts). Scope growth is BUSINESS-relevant, not just an ops
 *    detail: a new customer's branches showing up on the account IS the news.
 *
 *  - ScopeRefresher: re-run adapter.login() on a conservative cadence (hours,
 *    not minutes - login is two authenticated GETs riding the same coherent
 *    header + 429-aware retry stack every other request uses, but there is no
 *    reason to look eager) and on operator demand, so new scope flows into
 *    discovery WITHOUT a pm2 restart. A refresh NEVER runs while the engine has
 *    an armed/active monitor, and a FAILED re-login keeps the working session
 *    untouched (login() only assigns adapter.account as its final step - the
 *    refresher restores the one field a partial failure can nudge).
 *
 * Note on what "re-login" means here: the bearer token IS the session -
 * adapter.login() mints nothing and invalidates nothing, it re-reads the
 * account's server-side identity (views + header) with the same credential.
 * That is exactly why a refresh is safe to repeat and safe to fail.
 */

const log = createLogger('scopeRefresh');

// The per-account branch-scope fingerprint persists in its OWN collection, not on the
// account record: loadAccounts() returns the implicit 'primary' account only while the
// accounts collection is empty, so writing a doc there to hold a fingerprint would quietly
// promote the implicit account to an explicit one - the same reason accountContacts got
// its own collection (see server.js rememberAccountContact).
const SCOPE_COLLECTION = 'accountScope';

/**
 * Fingerprint a branch-id set: order-insensitive, duplicate-insensitive. The COUNT alone
 * would miss a same-size swap (one branch unmapped, one mapped - still 276), so the hash
 * of the sorted unique ids is the identity; the count is what humans read in the alert.
 */
function branchFingerprint(branchIds) {
  const ids = [...new Set((branchIds || []).map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const hash = crypto.createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
  return { count: ids.length, hash, ids };
}

// D052: branchId -> customer name, off the login's own branch list (realAdapter.collectBranches,
// which already carries `customer` = the branch's freighterName). Persisted alongside the
// fingerprint so a REMOVED branch's customer can still be named later, even though a removed
// branch no longer appears in that login's own branch list.
function customerByBranch(branches) {
  const out = {};
  for (const b of (branches || [])) {
    const id = Number(b && b.branchId);
    if (Number.isFinite(id) && b.customer) out[id] = String(b.customer);
  }
  return out;
}

function namesFor(branchIdList, map) {
  const names = new Set();
  for (const id of branchIdList) { const n = map[id]; if (n) names.add(n); }
  return [...names].sort();
}

/**
 * Compare this login's branch scope against the persisted fingerprint and make a change
 * impossible to miss: one structured warn line + the notifier's 'error' alert
 * ("account X branch scope changed: 249 -> 276"). First-ever sighting records the
 * baseline silently (info only - there is nothing to compare against). Dedupe rides the
 * notifier's store seam keyed on the TRANSITION (oldHash -> newHash), so a restart
 * between changes never re-fires the same alert while every distinct change alerts again.
 *
 * Best-effort by contract: this runs inside login/refresh paths that must never fail
 * because scope BOOKKEEPING failed - it throws nothing and returns a result either way.
 */
async function checkScopeChange({ store, notifier, accountId, accountLabel, branchIds, branches = [], now = Date.now() } = {}) {
  const label = accountLabel || accountId || 'default';
  const next = branchFingerprint(branchIds);
  const nextCustomers = customerByBranch(branches);
  if (!store || !accountId) return { checked: false, changed: false, count: next.count };
  try {
    const prev = await store.getDoc(SCOPE_COLLECTION, accountId);
    // branchIds are persisted alongside count/hash so the NEXT change can say how many
    // were added vs removed, not just that the total moved. customerByBranch rides along so a
    // FUTURE removal can still name the customer that branch belonged to.
    const persist = () => store.putDoc(SCOPE_COLLECTION, accountId, {
      accountId, count: next.count, hash: next.hash, branchIds: next.ids, customerByBranch: nextCustomers,
      updatedAt: now, prevCount: prev ? prev.count : null,
    });
    if (!prev) {
      await persist();
      log.info(`sp-scope-${label} baseline recorded (${next.count} branches)`,
        { accountId, count: next.count, hash: next.hash });
      return { checked: true, first: true, changed: false, count: next.count };
    }
    if (prev.hash === next.hash) {
      // unchanged - re-persist anyway so updatedAt records when the scope was last CONFIRMED.
      await persist();
      return { checked: true, first: false, changed: false, count: next.count };
    }
    const before = new Set(Array.isArray(prev.branchIds) ? prev.branchIds : []);
    const after = new Set(next.ids);
    const addedIds = next.ids.filter((id) => !before.has(id));
    const removedIds = [...before].filter((id) => !after.has(id));
    const added = addedIds.length;
    const removed = removedIds.length;
    // D052: name the customer(s) actually affected, not just a bare count - a 259->13 collapse and
    // a routine 1-branch drift look identical without this, and that identical shape is exactly why
    // a 36-branch, one-customer drop went unnoticed for 26 days. Added branches are named off THIS
    // login's own branch list; removed branches are named off the PREVIOUS fingerprint's map, since
    // a removed branch is no longer in this login's list at all.
    const addedNames = namesFor(addedIds, nextCustomers);
    const removedNames = namesFor(removedIds, (prev && prev.customerByBranch) || {});
    const namesNote = [
      addedNames.length ? `added - ${addedNames.join(', ')}` : null,
      removedNames.length ? `removed - ${removedNames.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    const detail = `account ${label} branch scope changed: ${prev.count} -> ${next.count} branches`
      + ` (${added} added, ${removed} removed). New branches flow into discovery on the next poll.`
      + (namesNote ? ` Customers affected: ${namesNote}.` : '');
    log.warn(`sp-scope-${label} ${detail}`,
      { accountId, prevCount: prev.count, count: next.count, added, removed, prevHash: prev.hash, hash: next.hash });
    if (notifier) {
      // Alert BEFORE persisting: if the alert throws, the old fingerprint survives and the
      // next login retries the whole comparison instead of silently swallowing the change.
      await notifier.alert('error', { context: `sp-scope-${label}`, detail },
        { dedupeKey: `scope_change_${accountId}_${prev.hash}_${next.hash}` });
    }
    await persist();
    return { checked: true, first: false, changed: true,
      count: next.count, prevCount: prev.count, added, removed };
  } catch (e) {
    log.error(`sp-scope-${label} fingerprint check failed (the session itself is unaffected)`,
      { accountId, err: e });
    return { checked: false, changed: false, count: next.count, error: String(e && e.message) };
  }
}

/**
 * Is this failure count an escalation rung? True at the threshold and at each doubling of it
 * (3, 6, 12, 24, ...), false everywhere else. Geometric rather than every-multiple so an
 * outage nobody can fix today escalates a handful of times instead of once per deferMs
 * forever - see the call site for the incident this closes.
 */
function isAlertRung(count, threshold) {
  if (!(count > 0) || !(threshold > 0)) return false;
  let rung = threshold;
  while (rung < count) rung *= 2;
  return rung === count;
}

/**
 * Did THIS refresh fail because SuperProcure REFUSED the session, rather than for any of the other
 * reasons a request can fail? login() codes every non-200 as `AUTH` - a 500, a 429 and a timeout
 * arrive indistinguishable from a 401 unless the status is read - so `err.code` cannot answer this.
 * `authReason` covers the adapter's own synthetic refusal, which never reaches the wire and so
 * carries no status. The message regex is the fallback for an error thrown somewhere that does not
 * stamp one; it drifts toward NOT matching, which costs an extra page rather than silence.
 */
function isAuthRefusal(err) {
  if (!err) return false;
  if (err.authReason === 'token_expired') return true;
  const status = Number(err.status);
  if (status === 401 || status === 403) return true;
  return /_(401|403)$/.test(String(err.message || ''));
}

const REFRESH_DEFAULTS = {
  intervalMs: 6 * 60 * 60 * 1000, // scheduled cadence: hours by design (anti-detection posture; see header)
  deferMs: 5 * 60 * 1000,         // short come-back cadence after a deferral or a failure
  failureAlertThreshold: 3,       // consecutive failed refreshes before a human is paged (then each DOUBLING)
  pageReofferMs: 15 * 60 * 1000,  // re-offer an undelivered rung page this often (authDeadReAlertMs)
};

/**
 * ScopeRefresher - one per account stack (the tokenExpiryTimer precedent), started by
 * activateRealStack and stopped by teardownStack. Self-rescheduling setTimeout chain
 * rather than setInterval, so the NEXT delay is picked per-outcome:
 *
 *   refreshed OK       -> wait the full conservative interval
 *   deferred (armed)   -> come back at deferMs; a due refresh should not wait 6h
 *                         behind a 20-minute auction
 *   failed             -> come back at deferMs; a transient failure must not leave
 *                         scope stale for another full interval, and the repeated-
 *                         failure alert has to be able to escalate within a shift
 *
 * The manual trigger (POST /api/accounts/:id/refresh-scope) runs the SAME refresh()
 * and resets the same clock - a just-refreshed account doesn't need another pass in
 * five minutes.
 */
class ScopeRefresher {
  constructor({ adapter, engine, store = null, notifier = null,
    accountId = 'primary', accountLabel = 'Primary',
    intervalMs, deferMs, failureAlertThreshold, pageReofferMs, onRefreshed = null } = {}) {
    this.adapter = adapter;
    this.engine = engine;
    this.store = store;
    this.notifier = notifier;
    this.accountId = accountId;
    this.accountLabel = accountLabel;
    this.intervalMs = intervalMs != null ? Number(intervalMs) : REFRESH_DEFAULTS.intervalMs;
    this.deferMs = deferMs != null ? Number(deferMs) : REFRESH_DEFAULTS.deferMs;
    this.failureAlertThreshold = failureAlertThreshold != null
      ? Number(failureAlertThreshold) : REFRESH_DEFAULTS.failureAlertThreshold;
    this.pageReofferMs = pageReofferMs != null ? Number(pageReofferMs) : REFRESH_DEFAULTS.pageReofferMs;
    // async (acct, scopeResult) => void; server.js uses it to cache the derived identity
    // (carrierId/branchIds) back onto the account record + surface a dashboard event.
    this.onRefreshed = onRefreshed;
    this.timer = null;
    this.running = false;    // start()ed and not stop()ed - gates all self-rescheduling
    this._inFlight = false;  // one refresh at a time (a manual poke can collide with the schedule)
    this.consecutiveFailures = 0;
    this._failStreakStartedAt = null; // keys the repeated-failure dedupe so each streak re-alerts
    // The ladder counts failures that were ELIGIBLE to page, not every failure. consecutiveFailures
    // stays the honest streak for the message, the log and the dedupe key; this drives the rungs.
    this._pageableFailures = 0;
    // The rung page awaiting delivery. Held so an undelivered one can be re-offered on the same
    // dedupeKey; cleared the moment the notifier reports anything but the retryable skip, superseded
    // by the next rung, and dropped by a successful refresh.
    this._pageKey = null;
    this._pageOfferedAt = 0;
    this.lastRefreshAt = null;        // last SUCCESSFUL refresh
  }

  /** Arm the periodic chain. Idempotent; the first pass waits a full interval (boot just logged in). */
  start() {
    this.running = true;
    this._schedule(this.intervalMs);
    log.info(`scope refresher started for ${this.accountLabel}`,
      { accountId: this.accountId, intervalMs: this.intervalMs, deferMs: this.deferMs });
  }

  /** Halt the chain (stack teardown). An in-flight refresh finishes but reschedules nothing. */
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer); // one pending wake, ever - a manual poke replaces it
    this.timer = setTimeout(() => { this.refresh({ trigger: 'scheduled' }).catch(() => {}); }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Does an already-announced auth outage own this failure? When SuperProcure revokes the session,
   * raiseAuthDead sends ONE message per episode - the correct alert, already delivered, already
   * saying the bot cannot see or bid this account. A repeated-failure page on top of that is the
   * same outage restated. So the streak page is left for the case it was written for: a refresh
   * failing while the session is usable (a 500, a timeout, a rate limit).
   *
   * THREE FACTS, NOT TWO. The episode says the desk was told, the live state says it is still true,
   * and the ERROR says this failure is that same outage rather than an unrelated one. The third is
   * load-bearing, not belt-and-braces: `_latch()` always opens an episode and no all-clear can fire
   * while latched, so conditions 1 and 2 collapse into each other in every latched state. Without
   * the error test, a write-scope revocation silences the read-path page for a wholly independent
   * 500/timeout run - the exact case this alert exists for.
   *
   * The first two still diverge from each other, so both are kept:
   *   - episode open, session usable - a reconnect INHERITS the open episode, and only a proven
   *     write ever closes one (see _expireStaleInheritedEpisode). An account that reconnects and
   *     has no load to bid carries that episode for days on a perfectly good token; suppressing
   *     on the episode alone would silence real 500s for exactly that long.
   *   - session unusable, no episode - EXPIRED is derived from tokenExp, so the latch reads dead
   *     before anything has opened an outage or told anyone. Nobody was paged; we must page.
   * Every condition added here strictly SHRINKS what is suppressed, so none of them can introduce
   * silence - the direction that matters, because a missed page means a load closing with no bid.
   *
   * Fails OPEN by design - an adapter that cannot answer (neither method, or one that throws), or a
   * failure whose cause cannot be read, leaves the page enabled.
   */
  _suppressedByAuthOutage(err) {
    try {
      const a = this.adapter;
      if (!a) return false;
      if (!isAuthRefusal(err)) return false;
      const since = typeof a.authEpisodeSince === 'function' ? a.authEpisodeSince()
        : (typeof a.authOutageSince === 'function' ? a.authOutageSince() : undefined);
      const dead = typeof a.isAuthDead === 'function' ? !!a.isAuthDead() : undefined;
      if (since === undefined) return dead === undefined ? false : dead;
      if (dead === undefined) return since != null;
      return since != null && dead;
    } catch (_) { return false; }
  }

  /**
   * Armed/active auctions on THIS account's engine. snapshot() is the same public read
   * the console uses; a monitor stays in the map after it finalizes (won/lost/stopped),
   * so only the non-finalized ones count - those are the live-money monitors a re-login
   * must never race. Pre-start 'scheduled' wakes deliberately do NOT defer: nothing is
   * bidding yet, and a scheduled intent can sit hours away - exactly the window in which
   * a refresh is both harmless and most useful.
   */
  armedCount() {
    try { return this.engine ? this.engine.snapshot().filter((m) => !m.finalized).length : 0; }
    catch (_) { return 0; }
  }

  /**
   * One refresh attempt. Never throws. Returns exactly one of:
   *   { ok:true,  branches, changed, prevCount, trigger }
   *   { ok:false, deferred:true, armedCount, trigger }   - armed auction(s); nothing was touched
   *   { ok:false, inFlight:true }                        - another refresh is mid-run
   *   { ok:false, error, consecutiveFailures, trigger }  - re-login failed; OLD session intact
   */
  async refresh({ trigger = 'manual' } = {}) {
    if (this._inFlight) return { ok: false, inFlight: true };
    const armed = this.armedCount();
    if (armed > 0) {
      // NEVER interrupt live bidding: hold the refresh and come back on the short cadence.
      log.info(`scope refresh deferred (${trigger}): ${armed} armed auction(s) on ${this.accountLabel}`,
        { accountId: this.accountId, armedCount: armed, trigger });
      this._schedule(this.deferMs);
      return { ok: false, deferred: true, armedCount: armed, trigger };
    }
    this._inFlight = true;
    // FAIL SAFE: login() assigns adapter.account only as its LAST step, so a failure has
    // torn nothing down - but it CAN have nudged serverTimeOffsetMs off getAvailableViews
    // before getHeader failed. Snapshot both and restore on failure so a failed refresh
    // leaves the adapter exactly as it was (the old session keeps listing and bidding).
    const prevAccount = this.adapter.account;
    const prevOffset = this.adapter.serverTimeOffsetMs;
    const prevOffsetError = this.adapter.serverTimeErrorMs;
    try {
      const acct = await this.adapter.login();
      const recovered = this.consecutiveFailures;
      this.consecutiveFailures = 0;
      this._failStreakStartedAt = null;
      this._pageableFailures = 0;
      this._pageKey = null;
      this.lastRefreshAt = Date.now();
      if (recovered > 0) {
        log.info(`scope refresh recovered after ${recovered} consecutive failure(s)`,
          { accountId: this.accountId, recoveredAfter: recovered });
      }
      const scope = await checkScopeChange({
        store: this.store, notifier: this.notifier,
        accountId: this.accountId, accountLabel: this.accountLabel, branchIds: acct.branchIds,
        branches: acct.branches,
      });
      log.info(`scope refresh ok (${trigger}): ${acct.branchIds.length} branches${scope.changed ? ` (scope CHANGED from ${scope.prevCount})` : ''}`,
        { accountId: this.accountId, branchCount: acct.branchIds.length, changed: !!scope.changed, trigger });
      if (this.onRefreshed) {
        // identity caching / dashboard events are best-effort - never fail the refresh over them.
        try { await this.onRefreshed(acct, scope); }
        catch (e) { log.warn('scope refresh onRefreshed hook failed', { accountId: this.accountId, err: e }); }
      }
      this._schedule(this.intervalMs);
      return { ok: true, branches: acct.branchIds.length, changed: !!scope.changed,
        prevCount: scope.prevCount != null ? scope.prevCount : null, trigger };
    } catch (e) {
      this.adapter.account = prevAccount;
      this.adapter.serverTimeOffsetMs = prevOffset;
      this.adapter.serverTimeErrorMs = prevOffsetError;
      const suppressed = this._suppressedByAuthOutage(e);
      this.consecutiveFailures += 1;
      // A suppressed failure is not a rung that was spent, it is a rung that never came up, so the
      // ladder is exactly as it would have been had those passes not happened - a silenced stretch
      // is skipped over, never replayed and never restarted. That is what makes an outage which
      // hides an entire streak page one threshold after it clears instead of at the next doubling
      // above the hidden count, and what stops a flapping episode from restarting at the bottom
      // rung on every crossing, which would rebuild the every-15-minutes storm one cycle at a time.
      // It is NOT a bound on post-outage latency: if rungs had already fired before the outage, the
      // next one is a full rung away, which at height 96 is 96 passes - the ladder's own cadence.
      if (!suppressed) this._pageableFailures += 1;
      if (this._failStreakStartedAt == null) this._failStreakStartedAt = Date.now();
      log.warn(`scope refresh failed (${trigger}); keeping the existing session`,
        { accountId: this.accountId, consecutiveFailures: this.consecutiveFailures,
          pageableFailures: this._pageableFailures, err: e });
      // Repeated-failure paging (the tokenExpiry pattern: quiet on a blip, loud on a
      // pattern). Fires at the threshold and then at each DOUBLING of it, never at every
      // multiple: deferMs is 5 minutes, so multiples meant a message every 15 minutes for as
      // long as the streak ran, and a streak runs until a human fixes it. Doubling still
      // escalates forever, so a long outage can neither storm nor be silently forgotten. The
      // dedupe key carries the streak start + count so each escalation is exactly one alert,
      // restart-safe through the notifier's store seam. The message says the important part
      // out loud: the bot is still bidding, but on the LAST KNOWN scope.
      const isRung = this.failureAlertThreshold > 0 && !suppressed
        && isAlertRung(this._pageableFailures, this.failureAlertThreshold);
      if (isRung) {
        // A new rung SUPERSEDES any earlier one still undelivered: it describes the same outage for
        // longer, so the older key would only carry staler news.
        this._pageKey = `scope_refresh_fail_${this.accountId}_${this._failStreakStartedAt}_${this.consecutiveFailures}`;
        this._pageOfferedAt = 0;
      }
      // DELIVERY RETRY - the shape realAdapter._maybeReRaiseDown already uses, for the same reason.
      // This page rides HEALTH_POLICY 'error' -> 'drop', so a send into a logged-out Maytapi sender
      // is skipped and deliberately NOT marked sent: the one message is lost outright, and under a
      // doubling ladder the next rung can be hours away. Re-offering the SAME dedupeKey instead of
      // minting a new one is what makes a retry safe here - the notifier's sent-mark short-circuits
      // every offer after the one that actually lands, so this adds at most one DELIVERED message
      // per rung. Minting a new key per attempt is precisely how the 167-message storm happened.
      const now = Date.now();
      const reOfferDue = !isRung && !suppressed && this._pageKey != null
        && (now - this._pageOfferedAt) >= this.pageReofferMs;
      if (this.notifier && (isRung || reOfferDue)) {
        this._pageOfferedAt = now;
        // Rendered NOW rather than frozen at the rung: a re-offer that lands an hour later has to
        // describe the streak and the error in play when a human READS it. Only the dedupeKey stays
        // pinned to the rung, because that is the delivery identity the dedupe turns on.
        const disposition = await this.notifier.alert('error', {
          context: `sp-scope-${this.accountLabel}`,
          detail: `scope refresh for ${this.accountLabel} has failed ${this.consecutiveFailures}x in a row`
            + ` (${e && e.message}). Bidding continues on the LAST known session/scope, but branch`
            + ` changes on SuperProcure's side stay invisible until a refresh or reconnect succeeds.`,
        }, { dedupeKey: this._pageKey }).catch(() => false);
        // Retire the rung only on evidence it LANDED. The disposition alone is not that evidence:
        // false is the sender-down skip, but true also covers "every recipient's send failed" and a
        // swallowed send error, and the notifier leaves both UNMARKED precisely so a later offer can
        // still deliver them. Trusting true there drops a page that one transient 500 delayed.
        // When the notifier cannot answer at all (no dedupe store) its disposition is the only
        // signal left, and taking it is what keeps the retry bounded on that shape.
        const landed = this.notifier.wasDelivered
          ? await this.notifier.wasDelivered(this._pageKey).catch(() => null) : null;
        if (landed === true || (landed === null && disposition !== false)) this._pageKey = null;
      }
      this._schedule(this.deferMs);
      return { ok: false, error: String(e && e.message),
        consecutiveFailures: this.consecutiveFailures, trigger };
    } finally {
      this._inFlight = false;
    }
  }
}

module.exports = { SCOPE_COLLECTION, branchFingerprint, checkScopeChange, ScopeRefresher, REFRESH_DEFAULTS, isAlertRung, isAuthRefusal };
