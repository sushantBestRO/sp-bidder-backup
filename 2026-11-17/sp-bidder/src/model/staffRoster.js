'use strict';

const { normalizePhoneIN } = require('./normalizePhone');

/**
 * StaffRoster - the explicit, operator-editable allowlist of BRL-staff mobile numbers
 * that the daily membership audit (src/notify/heartbeat.js -> collectMembership) diffs
 * every customer "BRL Bids" WhatsApp group against. Those groups are registered
 * alertPrefs:'all', so they carry BRL's cost/bid/margin per load - they are staff-only,
 * forever, and any participant NOT on this roster is margin economics leaking to an
 * outsider. This roster is what "staff" means to that audit.
 *
 * Deliberately NOT derived from the people collection: `people` is alert ROUTING (who
 * gets which alert kind for which customer), which is a different question from "who is
 * authorized to sit in a staff-only group". A person can drop off the alert list yet stay
 * legitimately in a group, and a staff member can be in a group without ever being an alert
 * recipient - conflating the two would make the tripwire both miss real intruders and cry
 * wolf on real staff. So it is its own explicit list.
 *
 * Store-injected, no fs (the same store seam customerStore/personStore ride; the grep-gate
 * test in test-store.js forbids fs for app state outside src/store/). One document holds the
 * whole list: collection 'staffRoster', id 'allowlist', shape
 *   { numbers: ['+91XXXXXXXXXX', ...], updatedAt, updatedBy }
 * On disk that is data/staffRoster.json === { "allowlist": { "numbers": [...], ... } }, which
 * an operator can also hand-edit; every write here re-normalizes so a pasted-in number in any
 * common shape lands as the canonical +91 form.
 *
 * Numbers are validated as Indian MOBILES (normalizePhoneIN, strict) - a staff member is a
 * person, never a group JID; letting a group id onto the allowlist would let a whole group
 * silently authorize itself, which is exactly the leak this list exists to catch.
 */

const COLLECTION = 'staffRoster';
const DOC_ID = 'allowlist';

const dedupe = (a) => [...new Set(a)];

class StaffRoster {
  constructor({ store, log = () => {} }) { this.store = store; this.log = log; }

  // The current allowlist as an array of normalized '+91XXXXXXXXXX' strings. Empty (never null)
  // when unconfigured - the audit reads an empty list as "unconfigured", never as "everyone is
  // an intruder", so this must not throw on a fresh box.
  async list() {
    const doc = await this.store.getDoc(COLLECTION, DOC_ID).catch(() => null);
    const nums = doc && Array.isArray(doc.numbers) ? doc.numbers : [];
    return nums.map((n) => String(n)).filter(Boolean);
  }

  // Replace the whole allowlist. Each entry is re-normalized as an Indian mobile; a bad entry
  // throws BAD_INPUT (via normalizePhoneIN) rather than silently landing a mangled number on the
  // allowlist - a wrong allowed-number would blind the audit to a real intruder.
  async replace(rawNumbers, { updatedBy = null } = {}) {
    const numbers = dedupe((Array.isArray(rawNumbers) ? rawNumbers : [])
      .map((r) => String(r).trim()).filter(Boolean).map((r) => normalizePhoneIN(r)));
    const doc = { numbers, updatedAt: Date.now(), updatedBy: updatedBy || null };
    await this.store.putDoc(COLLECTION, DOC_ID, doc);
    this.log(`[staffRoster] set ${numbers.length} allowed number(s)`);
    return numbers;
  }

  async add(rawNumber, opts = {}) {
    const cur = await this.list();
    return this.replace([...cur, rawNumber], opts);
  }

  async remove(rawNumber, opts = {}) {
    const drop = normalizePhoneIN(String(rawNumber).trim());
    const cur = await this.list();
    return this.replace(cur.filter((n) => n !== drop), opts);
  }
}

module.exports = { StaffRoster, COLLECTION, DOC_ID };
