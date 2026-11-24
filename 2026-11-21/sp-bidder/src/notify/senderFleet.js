'use strict';

/**
 * SENDER FLEET - the ordered set of Maytapi phones this system may send from, and the two questions
 * the price-ask failover has to answer before it uses one: is this sender's session alive, and is it
 * actually IN the group we are about to post into.
 *
 * WHY THIS EXISTS. The Notifier was built around ONE sender (config.whatsapp.phoneId, baked into the
 * WhatsAppClient's URL path). When that session logs out - three times now on 128023, most recently
 * 2026-08-06 07:04Z - every price ask for every customer is skipped at the health gate. On that day 8
 * asks expired undelivered and 10 more sat undelivered with live deadlines. The reason no fallback
 * fired is recorded in notifier.js's HEALTH_POLICY: a DM can be rerouted to any live channel, but a
 * GROUP broadcast supposedly cannot, because "a sibling phone cannot post into a group it is not a
 * member of". That premise is true. The CONCLUSION drawn from it was wrong, because a second
 * controlled number IS already a member of most of those groups.
 *
 * MEASURED, live read-only census 2026-08-06 (getGroups per slot, no writes):
 *   - 128023 / 918882034647 - member of all 18 live "BRL Bids" groups, admin of all 18.
 *   - 136151 / 919594964196 - member of 16 of 18, admin of 7 of 18.
 *                             NOT a member of: Cords Cable, Shriji Polymers.
 *   - 127918, 128026, 128025 - active sessions, member of ZERO "BRL Bids" groups.
 *   - 135719 - getGroups answers success:false; not usable.
 * So a second sender can carry 16 of 18 customers TODAY with no group mutation at all, and the two
 * it cannot carry fall through to the desk-owner DM and then email.
 *
 * MEMBERSHIP IS NOT ADMIN, and this module only needs the weaker one. Posting a message requires
 * PARTICIPATION; only promoting/adding/removing requires admin. That is why this ships at 16/18 while
 * MODULE_3_SCOPE's M3.8 (admin-sender recovery) correctly reports 7 of 18 - the two figures describe
 * different rights and both are right. Nothing here promotes, adds, removes or reconfigures anything.
 *
 * ORDERED AND N-DEEP, NOT PRIMARY-PLUS-ONE. The chain is `clients` in order, so a third and fourth
 * controlled number is a config entry (SP_MAYTAPI_FLEET_PHONE_IDS) and not a code change. Position 0
 * is the primary; it is NOT special-cased anywhere below - it is health-checked like every other
 * candidate, so a primary that recovers mid-outage is simply picked again.
 *
 * ZERO COST WHEN THE PRIMARY IS HEALTHY. Nothing in this module is called on the healthy path. The
 * Notifier consults the fleet only after _healthAction has already returned a non-'send' disposition
 * for a down sender, so a healthy system makes exactly the same number of WhatsApp operations it made
 * before this existed.
 *
 * READS ONLY, AND READS ARE THE CHEAP ONE. The membership probe is getGroups - a GET. The measured
 * logout hazard on this account is on MUTATING ops (the budget documented in provision-group.js:
 * MIN_INTERVAL_MS 60s, MAX_OPS_PER_RUN 6); no read has ever been implicated in a logout. The result
 * is cached anyway (see below) so a burst of asks during an outage costs one getGroups per candidate,
 * not one per ask.
 */

const DEFAULT_MEMBERSHIP_TTL_MS = 10 * 60 * 1000;

// A group JID compares by its DIGIT CORE, so '1203...@g.us' and a bare '1203...' are the same group.
// getGroups returns ids with the @g.us suffix and recipient rows carry it too, but the two have
// disagreed before across this codebase's surfaces and a false "not a member" here would silently
// send the ask to nobody - the exact failure this module exists to remove.
function groupKey(jid) {
  const d = String(jid == null ? '' : jid).replace(/\D/g, '');
  return d || null;
}

class SenderFleet {
  /**
   * `clients` is the ORDERED candidate list, primary first - each a WhatsAppClient (or anything with
   * the same enabled()/sessionHealthy()/getGroups()/sendText() surface, which is what the tests
   * inject). `membershipTtlMs` bounds how long a getGroups read is reused.
   */
  constructor({ clients = [], membershipTtlMs = DEFAULT_MEMBERSHIP_TTL_MS, log = () => {} } = {}) {
    this.clients = (clients || []).filter(Boolean);
    this.membershipTtlMs = membershipTtlMs;
    this.log = log;
    this._membership = new Map();   // phoneId -> { at, keys:Set<string> | null }
  }

  // How many candidates exist at all. 0 or 1 means there is no sibling to fail over to, which the
  // Notifier reports rather than silently behaving as if there were.
  size() { return this.clients.length; }

  /**
   * The set of group keys `client` is a participant of, or null when it CANNOT BE READ.
   *
   * null is load-bearing and is not the same as an empty set. getGroups is deliberately fail-CLOSED
   * (it throws on any HTTP/parse/success:false error - see whatsapp.js), and this preserves that: an
   * unreadable membership must never be rendered as "not a member" (which would skip a sender that
   * could have delivered) NOR as "is a member" (which would post into a group it may not be in). The
   * caller treats null as "cannot verify" and moves to the next candidate, which is the only posture
   * that cannot post into the wrong place.
   *
   * A failed read is cached like a successful one, deliberately: without that, every ask in an outage
   * burst would re-probe a slot that is answering errors, turning a broken candidate into a retry
   * storm against Maytapi at exactly the wrong moment.
   */
  async membershipOf(client) {
    const id = client && client.phoneId != null ? String(client.phoneId) : null;
    if (!id) return null;
    const now = Date.now();
    const hit = this._membership.get(id);
    if (hit && now - hit.at < this.membershipTtlMs) return hit.keys;
    let keys = null;
    try {
      const groups = await client.getGroups();
      if (Array.isArray(groups)) {
        keys = new Set(groups.map((g) => groupKey(g && g.id)).filter(Boolean));
      }
    } catch (e) {
      this.log(`[fleet] membership read failed for sender ${id}: ${e && e.message}`);
      keys = null;
    }
    this._membership.set(id, { at: now, keys });
    return keys;
  }

  /**
   * The first candidate that is BOTH session-healthy AND a VERIFIED participant of `jid`, or null.
   *
   * Both guards are mandatory and neither is inferred from config. Health first because it is the
   * cheap cached check (sessionHealthy caches ~45s) and because posting onto a dead session is the
   * accept-and-queue hazard the whole breaker exists for. Membership second, read from getGroups -
   * never from a config list, never from "we added it at birth", because the census proves the config
   * assumption is wrong for two groups today.
   */
  async pickForGroup(jid) {
    const key = groupKey(jid);
    if (!key) return null;
    for (const c of this.clients) {
      if (!c || !c.enabled || !c.enabled()) continue;
      let healthy = false;
      try { healthy = (await c.sessionHealthy()) !== false; } catch (_) { healthy = false; }
      if (!healthy) continue;
      const keys = await this.membershipOf(c);
      if (!keys || !keys.has(key)) continue;   // null (unreadable) and absent both mean "do not use"
      return c;
    }
    return null;
  }

  /**
   * The first session-healthy candidate, for an INDIVIDUAL recipient. No membership test - a DM has
   * no group to be a participant of. Anyone can DM anyone on WhatsApp, so the only question is
   * whether the session is alive.
   */
  async pickForDm() {
    for (const c of this.clients) {
      if (!c || !c.enabled || !c.enabled()) continue;
      let healthy = false;
      try { healthy = (await c.sessionHealthy()) !== false; } catch (_) { healthy = false; }
      if (healthy) return c;
    }
    return null;
  }
}

module.exports = { SenderFleet, DEFAULT_MEMBERSHIP_TTL_MS, groupKey };
