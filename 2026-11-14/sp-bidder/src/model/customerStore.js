'use strict';

const { validateMargins } = require('../pricing/marginValidate');
const { validateCustomerRules } = require('./rulesConfig');
const { CLOSE_TYPES: CLOSE_MODELS } = require('./rulesConstants');

/**
 * CustomerStore - a Customer (principal/shipper) is identity + the aliases a load's companyName
 * is matched on + an optional margin (absorbs marginProfiles) + optional auction rules (captured
 * from the branch survey; not yet wired into the engine). Mirrors MarginProfileStore. Store-injected,
 * no fs. Reuses validateMargins so every band rejects identically.
 */

const COLLECTION = 'customers';
// close-model enum: the single source of truth is rulesConstants.CLOSE_TYPES (imported above as
// CLOSE_MODELS), shared with the per-customer rules schema so the two can never diverge.
// three dot-separated base64url-ish segments = a JWT; the canary that a token was smuggled in.
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;

const bad = (m) => { const e = new Error(m); e.code = 'BAD_INPUT'; throw e; };
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const strList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
const dedupe = (a) => [...new Set(a)];

function assertNoSecret(rec) {
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && JWT_RE.test(v)) bad(`customer field '${k}' looks like a token - never store secrets`);
  }
}

function validateCustomer(input, { storedMargin = null } = {}) {
  if (!input || typeof input !== 'object') bad('customer must be an object');
  const label = String(input.label || '').trim();
  if (!label) bad('customer needs a label');
  const customerId = String(input.customerId || slug(label));
  if (!customerId) bad('customer label must contain a letter or number');
  const aliases = dedupe([label, ...strList(input.aliases)]); // the label always matches
  let margin = null;
  if (input.margin != null) {
    const m = validateMargins(input.margin.marginsPct, input.margin.minMarginPct, storedMargin);
    margin = { marginsPct: m.marginsPct, minMarginPct: m.minMarginPct };
  }
  let marginByPlatform = null;
  if (input.marginByPlatform != null) {
    if (typeof input.marginByPlatform !== 'object' || Array.isArray(input.marginByPlatform)) bad('marginByPlatform must be an object keyed by portal');
    marginByPlatform = {};
    for (const [portal, band] of Object.entries(input.marginByPlatform)) {
      if (!/^[a-z0-9_-]+$/.test(portal)) bad(`marginByPlatform: '${portal}' is not a portal key`);
      if (band == null) continue;
      const m = validateMargins(band.marginsPct, band.minMarginPct);
      marginByPlatform[portal] = { marginsPct: m.marginsPct, minMarginPct: m.minMarginPct };
    }
    if (!Object.keys(marginByPlatform).length) marginByPlatform = null;
  }
  let auction = null;
  if (input.auction != null) {
    const a = input.auction;
    const attemptsAllowed = a.attemptsAllowed != null ? Number(a.attemptsAllowed) : null;
    if (attemptsAllowed != null && !(attemptsAllowed > 0)) bad('auction.attemptsAllowed must be > 0');
    const closeModel = a.closeModel != null ? String(a.closeModel) : null;
    if (closeModel != null && !CLOSE_MODELS.includes(closeModel)) bad(`auction.closeModel must be one of ${CLOSE_MODELS.join(', ')}`);
    auction = { attemptsAllowed, closeModel };
  }
  // Per-customer RULES config (Module 2): schema-validated customer-level policy (pricingMode, unit,
  // closeModel, softCloseOptIn). Optional - a customer with no rules block is the norm today. An
  // invalid block is REFUSED here (a typo'd key or a bad enum never silently becomes a wrong bid);
  // boot re-validates every persisted doc (assertCustomerRulesValid). Inert until a mechanic reads it.
  let rules = null;
  if (input.rules != null) rules = validateCustomerRules(input.rules, customerId);
  const out = { customerId, label, aliases, margin, auction, enabled: input.enabled !== false };
  // previousIds: the slugs this customer was KEYED BY before a rename (written by
  // scripts/migrate-customer-slugs.js; read by getByAnyId so stale URLs/params keep
  // resolving). Carried through every edit so a console round-trip can't drop the
  // compat trail; omitted entirely when there is none, so pre-rename docs stay
  // byte-identical to today. The current id is never its own previous id.
  const previousIds = dedupe(strList(input.previousIds)).filter((s) => s !== customerId);
  if (previousIds.length) out.previousIds = previousIds;
  if (rules != null) out.rules = rules;
  if (marginByPlatform) out.marginByPlatform = marginByPlatform;
  // Omitted entirely when absent, so a customer without one stays byte-identical.
  if (input.roundPolicy != null) out.roundPolicy = validateRoundPolicy(input.roundPolicy);
  // T9 W9: GoComet sends the lowest band price at the buzzer of a confirmed final round even at rank 1.
  // Stored only when on, so a customer without it stays byte-identical.
  if (input.preEmptiveFloorAtRankOne != null) {
    if (typeof input.preEmptiveFloorAtRankOne !== 'boolean') bad('Lowest price at rank 1 (final-window bidding) must be on or off.');
    if (input.preEmptiveFloorAtRankOne) out.preEmptiveFloorAtRankOne = true;
  }
  assertNoSecret(out);
  return out;
}

const finalAfter = (v, where) => {
  if (v === null || (Number.isInteger(v) && v >= 0)) return v;
  return bad(`${where}.finalAfterExtensions must be null (no cap) or a whole number of extensions, 0 or more`);
};

/**
 * Per-plant GoComet round cap: { finalAfterExtensions, byOrigin: [{ match: [tokens], finalAfterExtensions }] }.
 * finalAfterExtensions null = the plant is uncapped. Tokens match case-folded inside the load's origin.
 */
function validateRoundPolicy(rp) {
  if (typeof rp !== 'object' || Array.isArray(rp)) bad('roundPolicy must be an object');
  const out = { finalAfterExtensions: finalAfter(rp.finalAfterExtensions, 'roundPolicy') };
  if (rp.byOrigin != null) {
    if (!Array.isArray(rp.byOrigin)) bad('roundPolicy.byOrigin must be a list');
    out.byOrigin = rp.byOrigin.map((e, i) => {
      const where = `roundPolicy.byOrigin[${i}]`;
      if (!e || typeof e !== 'object') bad(`${where} must be an object`);
      if (!Array.isArray(e.match) || !e.match.length
          || !e.match.every((t) => typeof t === 'string' && t.trim())) {
        bad(`${where}.match must be a non-empty list of place names`);
      }
      return { match: e.match.map((t) => t.trim()), finalAfterExtensions: finalAfter(e.finalAfterExtensions, where) };
    });
  }
  return out;
}

class CustomerStore {
  constructor({ store, log = () => {} }) { this.store = store; this.log = log; }
  async list() { return (await this.store.listDocs(COLLECTION)) || []; }
  async get(customerId) { return this.store.getDoc(COLLECTION, String(customerId)); }
  /**
   * get() by the CURRENT id, else by a PREVIOUS id - a slug this customer was renamed away
   * from (previousIds, maintained by scripts/migrate-customer-slugs.js). For URL/param
   * consumers (console routes, legacy margin-profile keys) so an in-flight reference from
   * before a rename still resolves instead of 404ing. Writers must key every write off the
   * RETURNED doc's customerId, never off the alias they looked up with.
   */
  async getByAnyId(customerId) {
    const id = String(customerId);
    const hit = await this.get(id);
    if (hit) return hit;
    return (await this.list()).find((c) => c && Array.isArray(c.previousIds) && c.previousIds.includes(id)) || null;
  }
  async upsert(input, { storedMargin } = {}) {
    const id = input && (input.customerId || slug(input.label));
    const existing = id ? await this.get(id) : null;
    const doc = validateCustomer(input, { storedMargin: storedMargin || (existing && existing.margin) });
    doc.updatedAt = Date.now();
    doc.updatedBy = input.updatedBy || null;
    if (input.createdAt != null) doc.createdAt = input.createdAt;
    await this.store.putDoc(COLLECTION, doc.customerId, doc);
    this.log(`[customer] upsert ${doc.customerId} (${doc.label})`);
    return doc;
  }
  async remove(customerId) { return this.store.removeDoc(COLLECTION, String(customerId)); }
}

module.exports = { CustomerStore, validateCustomer, slugifyLabel: slug, COLLECTION };
