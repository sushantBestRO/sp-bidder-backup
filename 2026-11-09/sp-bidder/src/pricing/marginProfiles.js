'use strict';

const { validateMargins } = require('./marginValidate');

/**
 * MarginProfileStore - per-(platform, customer) margin overrides, store-backed
 * through the same seam as PriceRequestStore. One doc per profile, keyed
 * `${platformKey}:${customerKey}`. A profile overrides the DEFAULT band for loads
 * whose shipper/companyName matches its customerLabel (the resolver decides the
 * match, using the same word-boundary rule as the discovery allowlist).
 *
 * Keyed by platform from day one (only 'sp' exists now); GoComet etc. are new rows,
 * no schema change. The customerKey is a URL/key-safe slug of the label; the label
 * is what the resolver matches on and what the UI shows.
 */

const COLLECTION = 'marginProfiles';
const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };

// URL/doc-key-safe slug of a customer label: lowercase, non-alphanumerics -> '-'.
// "Syngenta" -> "syngenta", "Tata Steel" -> "tata-steel".
function slugifyCustomer(label) {
  return String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function normPlatform(p) {
  const k = String(p || '').trim().toLowerCase();
  if (!k) bad('platformKey is required');
  return k;
}

class MarginProfileStore {
  constructor({ store, log = () => {} }) { this.store = store; this.log = log; }

  _key(platformKey, customerKey) { return `${platformKey}:${customerKey}`; }

  async list(platformKey) {
    const all = await this.store.listDocs(COLLECTION);
    return platformKey ? all.filter((p) => p && p.platformKey === normPlatform(platformKey)) : all;
  }
  async get(platformKey, customerKey) {
    return this.store.getDoc(COLLECTION, this._key(normPlatform(platformKey), String(customerKey)));
  }

  /** Create or update a customer profile. Validates the band; normalizes label -> key. */
  async upsert(input) {
    const platformKey = normPlatform(input.platformKey || input.platform);
    const customerLabel = String(input.customer ?? input.customerLabel ?? '').trim();
    if (!customerLabel) bad('customer name is required');
    const customerKey = slugifyCustomer(customerLabel);
    if (!customerKey) bad('customer name must contain a letter or number');
    const { marginsPct, minMarginPct } = validateMargins(input.marginsPct, input.minMarginPct);
    const doc = {
      platformKey, customerKey, customerLabel,
      marginsPct, minMarginPct,
      enabled: input.enabled !== false,
      updatedAt: Date.now(),
      updatedBy: input.updatedBy || null,
    };
    await this.store.putDoc(COLLECTION, this._key(platformKey, customerKey), doc);
    this.log(`[margin-profile] upsert ${platformKey}:${customerKey} (${customerLabel}) band ${marginsPct.join('/')}% floor ${minMarginPct}%`);
    return doc;
  }

  async remove(platformKey, customerKey) {
    const removed = await this.store.removeDoc(COLLECTION, this._key(normPlatform(platformKey), String(customerKey)));
    if (removed) this.log(`[margin-profile] removed ${platformKey}:${customerKey}`);
    return removed;
  }
}

module.exports = { MarginProfileStore, slugifyCustomer, COLLECTION };
