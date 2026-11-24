'use strict';

const { raiseAuthConfirming, raiseAuthDead, authDeadKey } = require('../notify/authAlert');

/**
 * THE EPISODE HANDOVER LEDGER: accountId -> the OPEN outage episode for that account.
 *
 * WHAT THIS IS NOT, and the distinction is the whole point. It is NOT authority to declare recovery.
 * An earlier shape treated a successful stack activation as an all-clear and announced "back online"
 * from the composition root, on evidence that is entirely READS - see server.js activateRealStack for
 * the step-by-step, and for why no composition-root step can distinguish a healthy account from one
 * that can still not bid.
 *
 * What it IS: the one place that knows an outage is still open across an adapter's LIFETIME. An
 * adapter dies on every reconnect and at every restart-into-a-fresh-stack, and the outage does not.
 * Two paths depend on that. (a) A boot-failed account's stack is torn down and spliced out of
 * `stacks` before the down-alert is even raised, so there is no adapter left to hold anything. (b)
 * `rebuildAccountStack` - the console Reconnect - constructs a brand-new adapter that starts CLEAR,
 * so it has no latch of its own to clear and would otherwise have forgotten the outage entirely.
 *
 * So the episode is recorded here and HANDED TO the replacement adapter (inheritedEpisodeSince),
 * which closes it through the one recovery standard in the system - an accepted bid. The reconnect
 * itself sends the provisional "we are confirming, keep quoting by hand" message and nothing more.
 *
 * The mark is dropped ONLY when the all-clear is actually emitted, which is the same instant the
 * adapter closes the episode - one fact, one lifetime, two holders that cannot disagree.
 *
 * PERSISTED, and the LATCH deliberately is not - the asymmetry is the whole reasoning. A persisted
 * latch would be a stuck-latch generator: it would hold a fresh process's writes off the wire on
 * evidence about a token that no longer exists. A persisted MARK holds nothing off the wire at all;
 * it only remembers that a message went to the desk and has not been closed yet. Its worst failure
 * is one extra "back online" after a restart, against today's documented silent gap where an outage
 * that ENDS by restarting the process never tells the desk to stop hand-quoting - and on this account
 * the desk and the bot share one per-load bid cap, so hand-quoting that nobody retracts costs the bot
 * its own bids.
 *
 * The in-memory map stays AUTHORITATIVE and every accessor stays SYNCHRONOUS: the writers are the
 * adapter's alert hooks, which sit on the bid path and may never block or throw. The store write is a
 * best-effort mirror on the same fire-and-forget footing as every other store call in server.js, and
 * the map is hydrated back from it once at boot, before any stack is built.
 *
 * WHY IT IS A MODULE AND NOT 150 LINES OF server.js. It is a store-backed, account-keyed, persisted
 * per-account tracker - structurally the same kind of thing as scopeRefresh.js next door, which is
 * already its own file and is imported into the composition root rather than inlined in it. Built as
 * a FACTORY over its collaborators rather than as bare exports, because the map has to be one
 * instance per process while the store, the notifier and the log line are server.js's to own.
 */

const AUTH_DEAD_MARKS_COLLECTION = 'authDeadMarks';

function createAuthDeadMarks({ store, notifier, log = () => {} } = {}) {
  const authDeadMarks = new Map();

  function noteAuthDeadMark({ accountId, accountLabel, since } = {}) {
    if (!accountId) return;
    // `since` must be a real epoch instant. Every raiser passes one, so this branch is a bug signal,
    // not a real input - refusing to record it is safer than falling back to 0: a persisted mark with
    // since:0 would still pass Number.isFinite on reload and hydrate as a genuine open episode dated
    // to the epoch, which is exactly the "garbage episode instant" loadAuthDeadMarks' own comment
    // guards against on the read side. Guard both ends the same way instead of trusting one.
    if (!Number.isFinite(since) || since <= 0) {
      log(`[auth] noteAuthDeadMark called for ${accountId} with an invalid since (${since}) - not persisting`);
      return;
    }
    // NEVER REWIND, but DO follow a genuinely newer episode. The first raise of an episode is the
    // message the desk actually read, and it is that message's key everything downstream has to
    // match - so an equal or older `since` (a delivery retry, a teardown re-park, a boot that
    // re-raises an already-hydrated outage) must not disturb the recorded one.
    //
    // A STRICTLY NEWER one is a different fact: the adapter has released an episode and minted a
    // fresh identity, which it does when an inherited outage it never confirmed goes stale (see
    // realAdapter._expireStaleInheritedEpisode). Refusing that leaves the ledger pointing at an
    // episode nobody is running any more, and the next restart would hydrate it and re-raise the new
    // outage's alert under the OLD, already-sent key - re-opening, one layer down, the exact
    // swallowed-alert hole the fresh identity exists to close.
    const existing = authDeadMarks.get(accountId);
    if (existing && Number.isFinite(existing.since) && since <= existing.since) return;
    const mark = { accountId, since, accountLabel: accountLabel || accountId };
    authDeadMarks.set(accountId, mark);
    // Fire-and-forget: a disk failure must never propagate into the adapter's alert hook, and the
    // in-memory map above has already recorded the fact for this process's lifetime. FileStore logs
    // the failure at its own seam, so it is visible in pm2 logs rather than silent.
    Promise.resolve(store.putDoc(AUTH_DEAD_MARKS_COLLECTION, accountId, mark))
      .catch((e) => log(`[auth] could not persist the outage mark for ${accountId}: ${e && e.message}`));
  }

  /** The open episode for this account, or null. Read when a fresh adapter is built mid-outage. */
  function openAuthEpisodeFor(accountId) {
    const mark = accountId ? authDeadMarks.get(accountId) : null;
    return mark ? mark.since : null;
  }

  /**
   * Drop the mark. Called from ONE place - the adapter's own all-clear hook, i.e. the instant a bid
   * was accepted and the settle window elapsed. Nothing else may clear it, because nothing else has
   * the evidence.
   */
  function clearAuthDeadMark(accountId) {
    if (!accountId) return;
    authDeadMarks.delete(accountId);
    Promise.resolve(store.removeDoc(AUTH_DEAD_MARKS_COLLECTION, accountId))
      .catch((e) => log(`[auth] could not clear the persisted outage mark for ${accountId}: ${e && e.message}`));
  }

  /**
   * Read the persisted marks back into the map. Called ONCE at boot, before any stack is built, so
   * buildRealStack's inheritedEpisodeSince sees an outage that was still open when the process died.
   *
   * Best-effort by design: an unreadable store leaves the map empty, which is exactly the pre-existing
   * behaviour (a restart forgets the outage) rather than a boot failure. A malformed row is skipped
   * rather than seeding an adapter with a garbage episode instant that would key an alert nobody can
   * match.
   */
  async function loadAuthDeadMarks() {
    const docs = await store.listDocs(AUTH_DEAD_MARKS_COLLECTION).catch(() => []);
    let n = 0;
    for (const d of docs || []) {
      if (!d || !d.accountId || !Number.isFinite(d.since) || d.since <= 0) continue;
      authDeadMarks.set(d.accountId, { accountId: d.accountId, since: d.since,
        accountLabel: d.accountLabel || d.accountId, announced: d.announced === true });
      n += 1;
    }
    if (n) log(`[auth] ${n} account(s) had an outage still open when this process last stopped; their episodes carry across the restart`);
    return n;
  }

  /**
   * Tell the desk somebody reconnected this account, WITHOUT claiming it can bid.
   *
   * Fires on a (re)activation that finds an episode still open. It does not clear the mark and does
   * not close the episode - the fresh adapter inherited that episode and will close it by proving a
   * write.
   *
   * `since` is passed by the caller as the episode the STACK ACTUALLY INHERITED, snapshotted when its
   * adapter was built. Re-reading the live ledger here instead would let the two disagree: activation
   * runs a login, a scope check, a socket connect and a rehydrate after the build, and an all-clear
   * landing in that window would clear the mark and make this announce nothing about a stack that is
   * genuinely carrying the episode - or, the other way, announce an episode the adapter never got.
   * Omitting the argument keeps the old read-the-ledger behaviour for callers that hold no stack.
   */
  function announceAuthReconnecting(accountId, accountLabel, since) {
    const episode = since !== undefined ? since : openAuthEpisodeFor(accountId);
    if (episode == null) return false;
    raiseAuthConfirming(notifier, { accountId, accountLabel: accountLabel || accountId, since: episode });
    return true;
  }

  /**
   * Raise "logged out" for an episode unless this ledger already knows the desk received it.
   *
   * The notifier's sent-mark cannot answer that for an outage that outlives it: notifSent keeps the
   * newest 1,000 marks and ordinary traffic turns it over in about a day, so every restart with an
   * account still down re-posted the same message under the same key. Delivery is recorded here, on
   * the mark that lives exactly as long as the episode, and only once the notifier confirms a send
   * reached somebody - a raise skipped on a down sender stays re-offerable.
   */
  async function raiseAuthDeadOnce(down, affectedCustomers) {
    const mark = authDeadMarks.get(down.accountId);
    if (mark && mark.since === down.since && mark.announced) return false;
    // Only the customer lookup is awaited; the send itself stays fire-and-forget on the bid path and
    // in the boot loop, and its outcome is recorded when it lands.
    raiseAuthDead(notifier, { ...down, affectedCustomers: await affectedCustomers() })
      .then(() => recordAnnounced(down.accountId, down.since));
    return true;
  }

  async function recordAnnounced(accountId, since) {
    if (typeof notifier.wasDelivered !== 'function') return;
    const delivered = await Promise.resolve(notifier.wasDelivered(authDeadKey(accountId, since))).catch(() => null);
    const current = authDeadMarks.get(accountId);
    if (delivered !== true || !current || current.since !== since || current.announced) return;
    current.announced = true;
    Promise.resolve(store.putDoc(AUTH_DEAD_MARKS_COLLECTION, accountId, current))
      .catch((e) => log(`[auth] could not persist that the outage for ${accountId} was announced: ${e && e.message}`));
  }

  return {
    noteAuthDeadMark, openAuthEpisodeFor, clearAuthDeadMark, loadAuthDeadMarks,
    announceAuthReconnecting, raiseAuthDeadOnce, AUTH_DEAD_MARKS_COLLECTION,
  };
}

module.exports = { createAuthDeadMarks, AUTH_DEAD_MARKS_COLLECTION };
