'use strict';

const { ALERT_KINDS } = require('../admin/configStore');
const { normalizeRecipient, recipientId } = require('./normalizePhone');

/**
 * PersonStore - a Person is an alert recipient, replacing the anonymous config.recipients[] rows.
 * Usually a branch employee, addressed by their mobile; belongs to an Account (their branch
 * login). alertPrefs is the kinds they want; alertAll (empty legacy scope) = every load;
 * originScope carries a legacy origin filter. Store-injected, no fs.
 *
 * A Person's `phone` may also be a WhatsApp GROUP JID ('<digits>@g.us'), which is how a
 * per-customer group is modelled - one "recipient" that happens to be a whole team. Nothing else
 * in the model needs to know: assignments scope it to its customer, toRecipientRows dedupes it by
 * phone like any other row, and the notifier sends to it like any other recipient. Deliberately
 * NOT a separate entity type - a parallel "channels" concept would have to re-implement scoping,
 * alert-kind subscription and dedupe from scratch, for no behavioural gain.
 */

const COLLECTION = 'people';
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;

const bad = (m) => { const e = new Error(m); e.code = 'BAD_INPUT'; throw e; };
const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);

function validatePerson(input, { accountIds, existing = null } = {}) {
  if (!input || typeof input !== 'object') bad('person must be an object');
  // Preserve-unless-explicit: a caller that never mentions a field carries forward whatever the
  // stored record already had, instead of falling back to that field's hard default. `key in
  // input` (not `input[key] !== undefined`) so an explicit `null` still counts as "this run said
  // so". Without this, upsert() - which REPLACES the whole doc (FileStore.putDoc is a full
  // overwrite, not a merge) - silently erases every field a caller does not know to send: the
  // 2026-08-31 rename reset accountId/branchScope/originScope on live routing records.
  const field = (key, fallback) => (key in input ? input[key] : (existing ? existing[key] : fallback));

  const name = String(field('name', '') || '').trim();
  const phone = normalizeRecipient(field('phone', undefined)); // a mobile OR a group JID; throws BAD_INPUT otherwise
  // target-derived id by default (unique -> no same-name collision; idempotent re-migration).
  // 'p<digits>' for a person, 'g<digits>' for a group. The UI can pass an explicit personId.
  const personId = String(input.personId || (existing && existing.personId) || recipientId(phone));
  const emailRaw = field('email', null);
  const email = emailRaw ? String(emailRaw).trim() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('email is not valid');
  const accountId = String(field('accountId', null) || 'primary');
  if (accountIds && !accountIds.has(accountId)) bad(`unknown account '${accountId}' for person '${personId}'`);
  const alertPrefsRaw = field('alertPrefs', undefined);
  const alertPrefs = alertPrefsRaw === 'all'
    ? 'all'
    : (Array.isArray(alertPrefsRaw) ? alertPrefsRaw.filter((k) => ALERT_KINDS.includes(k)) : []);
  // Spread `existing` first so a field neither this schema nor this run knows about (added later,
  // read by some other writer) survives too - the known fields below are the only ones a rename
  // is allowed to change, and only when the caller actually said so.
  const out = Object.assign({}, existing, {
    personId, name, phone, email, accountId, alertPrefs,
    alertAll: !!field('alertAll', false),
    originScope: strList(field('originScope', undefined)),
    // Optional per-recipient branch filter, used by a per-customer GROUP to narrow to ONE branch of
    // its shipper (e.g. a Havells-Alwar group carrying ["Alwar Cable (1350)"]). Projected into
    // scope.branches by toRecipientRows and matched by the notifier (src/notify/branchRouting.js).
    // Empty for every existing recipient, so routing is unchanged until a group is deliberately
    // narrowed. Same shape/handling as originScope.
    branchScope: strList(field('branchScope', undefined)),
    enabled: field('enabled', true) !== false,
  });
  for (const [k, v] of Object.entries(out)) if (typeof v === 'string' && JWT_RE.test(v)) bad(`person field '${k}' looks like a token`);
  return out;
}

class PersonStore {
  // accountsProvider: optional async () => account records, for referential validation of accountId.
  constructor({ store, accountsProvider = null, log = () => {} }) { this.store = store; this.accountsProvider = accountsProvider; this.log = log; }
  async _accountIds() {
    if (!this.accountsProvider) return null;
    const list = (await this.accountsProvider()) || [];
    return new Set(['primary', ...list.map((a) => a && a.accountId).filter(Boolean)]);
  }
  async list() { return (await this.store.listDocs(COLLECTION)) || []; }
  async get(personId) { return this.store.getDoc(COLLECTION, String(personId)); }
  async upsert(input) {
    if (!input || typeof input !== 'object') bad('person must be an object');
    // Look up the stored record BEFORE validatePerson rebuilds the doc, so the preserve-unless-explicit
    // merge above has something to merge against. A write without a personId resolves to the same
    // phone-derived id validatePerson would assign, so a phone-only re-save merges too.
    const personId = input.personId || recipientId(normalizeRecipient(input.phone));
    const existing = await this.get(String(personId));
    const doc = validatePerson(input, { accountIds: await this._accountIds(), existing });
    doc.updatedAt = Date.now();
    if (input.createdAt != null) doc.createdAt = input.createdAt;
    await this.store.putDoc(COLLECTION, doc.personId, doc);
    this.log(`[person] upsert ${doc.personId} (${doc.name || doc.phone})`);
    return doc;
  }
  async remove(personId) { return this.store.removeDoc(COLLECTION, String(personId)); }
}

module.exports = { PersonStore, validatePerson, COLLECTION };
