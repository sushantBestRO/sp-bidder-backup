'use strict';

const { tokenMatch } = require('../util/tokenMatch');

/**
 * Margin resolution - the ONE place the override precedence lives.
 *
 * For a load, the effective bid band is chosen highest-priority first:
 *   1. bid-level override  (a per-load override; applied on the request doc by
 *      priceRequests - NOT here. This resolver owns tiers 2-3.)
 *   2. customer-level      (a saved profile whose customerLabel matches the load's
 *      companyName on this platform)
 *   3. default band        (the house/global default)
 *
 * Pure function: it takes the profile list in (no I/O), so it is unit-testable and
 * the caller owns the store read. `platformKey` scopes profiles to a portal
 * (SuperProcure today; GoComet etc. later) - a profile for another portal never
 * applies, so the same customer can carry a different band per portal.
 *
 * When several profiles match one companyName, the tie-break is deterministic:
 * an exact (case-insensitive) label match wins; else the LONGEST matching label
 * (most specific); else lexicographic by customerKey (stable).
 */
function resolveBand({ platformKey, companyName, profiles, defaults }) {
  const name = String(companyName || '');
  const def = {
    marginsPct: Array.isArray(defaults && defaults.marginsPct) ? defaults.marginsPct.slice() : [],
    minMarginPct: defaults ? defaults.minMarginPct : undefined,
    source: 'default',
  };
  const matches = (profiles || []).filter((p) =>
    p && p.enabled !== false && p.platformKey === platformKey
    && p.customerLabel && tokenMatch(name, p.customerLabel));
  if (matches.length === 0) return def;
  matches.sort((a, b) => {
    const ea = a.customerLabel.toLowerCase() === name.toLowerCase() ? 1 : 0;
    const eb = b.customerLabel.toLowerCase() === name.toLowerCase() ? 1 : 0;
    if (ea !== eb) return eb - ea;                                                       // exact match first
    if (b.customerLabel.length !== a.customerLabel.length) return b.customerLabel.length - a.customerLabel.length; // longest (most specific)
    return a.customerKey < b.customerKey ? -1 : a.customerKey > b.customerKey ? 1 : 0;  // stable
  });
  const p = matches[0];
  return { marginsPct: p.marginsPct.slice(), minMarginPct: p.minMarginPct, source: `customer:${p.customerKey}` };
}

module.exports = { resolveBand };
