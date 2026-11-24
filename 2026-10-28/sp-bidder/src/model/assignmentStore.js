'use strict';

const { validateMargins } = require('../pricing/marginValidate');
const { ALERT_KINDS } = require('../admin/configStore');

/**
 * AssignmentStore - the JOIN: "this person covers this customer." The single source of truth from
 * which bidding targets, alert routing, and margin derive. Natural key personId::customerId (one
 * per pair -> idempotent upsert). Referential: personId + customerId must exist. Store-injected, no fs.
 */

const COLLECTION = 'assignments';
const bad = (m) => { const e = new Error(m); e.code = 'BAD_INPUT'; throw e; };
const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);

// Shared with AssignmentStore.upsert(), which must look up the existing record BEFORE
// validateAssignment rebuilds it (see the `owner` preserve-unless-explicit comment below) - kept as
// one function so the natural-key derivation can never drift between the two call sites.
function deriveAssignmentId(input) {
  const personId = String((input && input.personId) || '').trim();
  const customerId = String((input && input.customerId) || '').trim();
  return String((input && input.assignmentId) || `${personId}::${customerId}`);
}

function validateAssignment(input, { personIds, customerIds, existing } = {}) {
  if (!input || typeof input !== 'object') bad('assignment must be an object');
  const personId = String(input.personId || '').trim();
  const customerId = String(input.customerId || '').trim();
  if (!personId) bad('assignment needs a personId');
  if (!customerId) bad('assignment needs a customerId');
  if (personIds && !personIds.has(personId)) bad(`assignment references an unknown person '${personId}'`);
  if (customerIds && !customerIds.has(customerId)) bad(`assignment references an unknown customer '${customerId}'`);
  const assignmentId = String(input.assignmentId || `${personId}::${customerId}`);

  // Preserve-unless-explicit for the rest of the record, generalizing the `owner` fix below (PR
  // #83 review, finding F1) to every field: `key in input` (not `input[key] !== undefined`) so an
  // explicit `null` still counts as "this run said so" and genuinely clears a field.
  const field = (key, fallback) => (key in input ? input[key] : (existing ? existing[key] : fallback));

  const marginRaw = field('marginOverride', null);
  let marginOverride = null;
  if (marginRaw != null) {
    // The stored-band exemption belongs to the pairing that stored it. `existing` is found by
    // assignmentId while personId/customerId come from the body, so a mismatched pair must not
    // carry a below-minimum band across to itself.
    const samePairing = !!existing && existing.personId === personId && existing.customerId === customerId;
    const m = validateMargins(marginRaw.marginsPct, marginRaw.minMarginPct, samePairing ? existing.marginOverride : null);
    marginOverride = { marginsPct: m.marginsPct, minMarginPct: m.minMarginPct };
  }
  const alertKindsRaw = field('alertKinds', null);
  const alertKinds = alertKindsRaw == null
    ? null
    : (Array.isArray(alertKindsRaw) ? alertKindsRaw.filter((k) => ALERT_KINDS.includes(k)) : []);
  const lanesRaw = field('lanes', null);

  // Spread `existing` first so a field neither this schema nor this run knows about survives too -
  // the known fields below are the only ones an update is allowed to change, and only when the
  // caller actually said so.
  return Object.assign({}, existing, {
    assignmentId, personId, customerId,
    lanes: lanesRaw == null ? null : strList(lanesRaw),
    marginOverride, alertKinds,
    // enabled: same preserve-unless-explicit-boolean shape as `owner` below. Before this, an
    // update that never mentioned `enabled` (e.g. provision-group.js's plain re-registration)
    // defaulted it to true via `input.enabled !== false`, silently RE-ENABLING a deliberately
    // disabled desk.
    enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing ? existing.enabled !== false : true),
    // Is this person the DESK OWNER for this customer, as opposed to someone who merely receives
    // its alerts? The distinction did not exist before @-mention routing needed it, and the two are
    // genuinely different questions: the Director and the developer are assigned to nearly every
    // customer for oversight, but neither prices a load. Tagging every assignee would spray the
    // Director on every bid and name nobody accountable - worse than no tag at all.
    // Defaults FALSE for a BRAND-NEW record (no existing doc), so a customer nobody has ever
    // designated stays a non-owner and the mention layer stays silent until a human deliberately
    // designates one. Fail-safe direction, matching the rest of this codebase.
    //
    // validateAssignment REBUILDS the record on every call (upsert() is the only write path), so a
    // naive `owner: input.owner === true` silently ERASES an existing owner:true the instant ANY
    // writer that doesn't know about this field saves the assignment - the console (whose TS type
    // predates `owner`), migrate.js's legacy re-derivation, and the demo seed path all do exactly
    // that (PR #83 review, finding F1). Preserve-unless-explicitly-set fixes it: an omitted or
    // non-boolean `owner` on the input carries forward whatever the STORED record already had;
    // only an input that explicitly sends a boolean - true or false - writes through. This is why
    // upsert() below reads the existing doc and passes it in as `existing` before rebuilding.
    owner: typeof input.owner === 'boolean' ? input.owner : (existing ? existing.owner === true : false),
  });
}

class AssignmentStore {
  constructor({ store, people = null, customers = null, log = () => {} }) {
    this.store = store; this.people = people; this.customers = customers; this.log = log;
  }
  async _refs() {
    const personIds = this.people ? new Set((await this.people.list()).map((x) => x && x.personId).filter(Boolean)) : null;
    const customerIds = this.customers ? new Set((await this.customers.list()).map((x) => x && x.customerId).filter(Boolean)) : null;
    return { personIds, customerIds };
  }
  async list() { return (await this.store.listDocs(COLLECTION)) || []; }
  async get(assignmentId) { return this.store.getDoc(COLLECTION, String(assignmentId)); }
  async upsert(input) {
    // Read the existing record (if any) by its natural key BEFORE validateAssignment rebuilds the
    // doc from `input` alone - the `owner` preserve-unless-explicit rule needs it (see the comment
    // in validateAssignment). A bad personId/customerId still fails validation exactly as before;
    // this lookup on a not-yet-validated id is a harmless miss (returns null) either way.
    const existing = await this.get(deriveAssignmentId(input));
    const doc = validateAssignment(input, { ...(await this._refs()), existing });
    doc.updatedAt = Date.now();
    if (input.createdAt != null) doc.createdAt = input.createdAt;
    await this.store.putDoc(COLLECTION, doc.assignmentId, doc);
    this.log(`[assignment] upsert ${doc.assignmentId}`);
    return doc;
  }
  async remove(assignmentId) { return this.store.removeDoc(COLLECTION, String(assignmentId)); }
}

module.exports = { AssignmentStore, validateAssignment, COLLECTION };
