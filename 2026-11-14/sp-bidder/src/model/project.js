'use strict';

const { ALERT_KINDS } = require('../admin/configStore');
const { isGroupJid } = require('./normalizePhone');

/**
 * project - PURE projection of the model back into the LEGACY recipient-row shape the notifier
 * already consumes, so notifier._whatsapp + scopeMatches stay byte-for-byte unchanged (only the
 * source of the rows changes). One row per person (deduped by phone) so a person never double-sends.
 *
 * Routing semantics reproduced: scope.shippers empty = all shippers (a person with no shipper
 * assignments, or alertAll); else the union of the assigned customers' aliases (which, on migrated
 * data, are exactly the recipient's original scope tokens). originScope carries the legacy origins.
 * branchScope (per-recipient, used by a group) narrows a group to one branch of its shipper; empty =
 * no branch constraint, so a group without it routes exactly as before.
 */
function toRecipientRows(customers, people, assignments) {
  const custById = new Map((customers || []).map((c) => [c.customerId, c]));
  const byPerson = new Map();
  for (const a of (assignments || [])) {
    // An assignment to a customer that no longer exists scopes nothing, so it must not count as a
    // restriction either: kept, it left a group "restricted" with no aliases, which is every load.
    if (!a || a.enabled === false || !custById.has(a.customerId)) continue;
    if (!byPerson.has(a.personId)) byPerson.set(a.personId, []);
    byPerson.get(a.personId).push(a);
  }
  const rows = [];
  const seen = new Set();
  for (const p of (people || [])) {
    if (!p || p.enabled === false || seen.has(p.phone)) continue;
    seen.add(p.phone);
    const prefs = p.alertPrefs === 'all' ? ALERT_KINDS.slice() : (Array.isArray(p.alertPrefs) ? p.alertPrefs.slice() : []);
    const mine = byPerson.get(p.personId) || [];

    // A GROUP exists to carry exactly ONE customer's loads. The legacy fallback below reads "no
    // assignments = no scope = every load", which is right for a human central desk and exactly
    // WRONG for a group: disabling a group's only assignment - the natural way an operator says
    // "stop sending Syngenta's loads here" - would not silence it, it would widen it to EVERY
    // customer, spraying every shipper's pricing into that one group. Fail CLOSED instead: an
    // unassigned group is sent nothing. `alertAll` stays the explicit, deliberate opt-in for a
    // group that really is meant to see every load.
    if (isGroupJid(p.phone) && !p.alertAll && mine.length === 0) continue;

    const restricted = !p.alertAll && mine.length > 0;

    let alerts;
    if (!restricted) alerts = prefs;
    else {
      const set = new Set();
      for (const a of mine) { const ks = Array.isArray(a.alertKinds) ? a.alertKinds : prefs; for (const k of ks) set.add(k); }
      alerts = [...set];
    }

    const shippers = [];
    if (restricted) for (const a of mine) shippers.push(...(custById.get(a.customerId).aliases || []));

    rows.push({
      name: p.name || '',
      phone: p.phone,
      alerts,
      scope: { origins: (p.originScope || []).slice(), shippers: [...new Set(shippers)], branches: (p.branchScope || []).slice() },
    });
  }
  return rows;
}

module.exports = { toRecipientRows };
