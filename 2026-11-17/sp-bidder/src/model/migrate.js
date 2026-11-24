'use strict';

const { CustomerStore, slugifyLabel } = require('./customerStore');
const { PersonStore } = require('./personStore');
const { AssignmentStore } = require('./assignmentStore');
const { normalizeRecipient } = require('./normalizePhone');

/**
 * Behavior-preserving, idempotent migration of the legacy encodings into the model. Runs ONCE at
 * boot: only when customers/people/assignments are ALL empty AND legacy data exists. Never deletes
 * legacy this release (rollback + keeps the guard meaningful).
 *   - marginProfiles -> customers (margin-bearing; alias = the profile label)
 *   - config.recipients -> people (+ alertAll/originScope for empty/origin scope) + assignments
 *     from each scope.shipper (customers created by slug as needed, margin null -> default band)
 *   - config.allowlist is KEPT as the global union fallback (not migrated) so nothing narrows.
 * Natural keys (customerId=slug(label), personId=phone, assignmentId=person::customer) make it converge.
 */
async function migrateLegacyModel({ store, log = () => {} }) {
  const customers = new CustomerStore({ store });
  const people = new PersonStore({ store });
  const assignments = new AssignmentStore({ store, people, customers });

  const [c0, p0, a0] = await Promise.all([customers.list(), people.list(), assignments.list()]);
  if (c0.length || p0.length || a0.length) return { ran: false, reason: 'model already populated' };

  const savedConfig = (await store.getDoc('config', 'current')) || {};
  const recipients = Array.isArray(savedConfig.recipients) ? savedConfig.recipients : [];
  const profiles = (await store.listDocs('marginProfiles')) || [];
  if (!recipients.length && !profiles.length) return { ran: false, reason: 'no legacy data to migrate' };

  const counts = { customers: 0, people: 0, assignments: 0 };

  // 1. marginProfiles -> customers (do FIRST so recipient shippers reuse them and preserve margin)
  for (const pr of profiles) {
    if (!pr || !pr.customerLabel) continue;
    const margin = { marginsPct: pr.marginsPct, minMarginPct: pr.minMarginPct };
    await customers.upsert({
      label: pr.customerLabel, aliases: [pr.customerLabel], margin, enabled: pr.enabled !== false,
    }, { storedMargin: margin });
    counts.customers += 1;
  }

  // 2. recipients -> people + assignments
  for (const r of recipients) {
    if (!r || !r.phone) continue;
    let phone;
    // normalizeRecipient, not normalizePhoneIN: the legacy config.recipients validator now accepts
    // a WhatsApp group id, so the strict mobile-only rule here would silently `continue` past every
    // group row on a fresh box or a DR restore - the groups would simply vanish from the model and
    // nobody would be alerted that they had.
    try { phone = normalizeRecipient(r.phone); } catch (_) { continue; } // skip an un-normalizable legacy row
    const shippers = (r.scope && Array.isArray(r.scope.shippers)) ? r.scope.shippers.filter(Boolean) : [];
    const origins = (r.scope && Array.isArray(r.scope.origins)) ? r.scope.origins.filter(Boolean) : [];
    const person = await people.upsert({
      name: r.name || '', phone, accountId: 'primary',
      alertPrefs: Array.isArray(r.alerts) ? r.alerts : [],
      alertAll: shippers.length === 0 && origins.length === 0, // legacy fully-empty scope = all loads
      originScope: origins,
    });
    counts.people += 1;
    for (const s of shippers) {
      const id = slugifyLabel(s);
      let cust = await customers.get(id);
      if (!cust) { cust = await customers.upsert({ label: s, aliases: [s], enabled: true }); counts.customers += 1; }
      else if (!(cust.aliases || []).includes(s)) { cust = await customers.upsert({ ...cust, aliases: [...(cust.aliases || []), s] }); } // preserves margin
      await assignments.upsert({ personId: person.personId, customerId: cust.customerId, enabled: true });
      counts.assignments += 1;
    }
  }

  log(`[migrate] model created from legacy: ${counts.customers} customers, ${counts.people} people, ${counts.assignments} assignments`);
  return { ran: true, counts };
}

module.exports = { migrateLegacyModel };
