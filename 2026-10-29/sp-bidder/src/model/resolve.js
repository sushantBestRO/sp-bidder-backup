'use strict';

const { tokenMatch } = require('../util/tokenMatch');
const { resolveBand } = require('../pricing/marginResolver');
const { isGroupJid } = require('./normalizePhone');

/**
 * The PURE derivation layer - collections in, no I/O (mirrors resolveBand). Bidding targets,
 * and margin all fall out of the model here; the callers (discovery getter, priceRequests) pass
 * the load's companyName and get back the exact shapes they already consume.
 */

/**
 * companyName -> the winning Customer (or null). Generalises resolveBand's customerLabel match
 * over [label, ...aliases]; SAME word-boundary tokenMatch and SAME tie-break (exact alias, then
 * longest alias = most specific, then stable by customerId) so it agrees with the margin resolver.
 */
function matchCustomer(companyName, customers) {
  const name = String(companyName || '');
  let best = null; // { customer, alias }
  for (const c of (customers || [])) {
    if (!c || c.enabled === false) continue;
    for (const alias of (c.aliases || [])) {
      if (!alias || !tokenMatch(name, alias)) continue;
      if (!best) { best = { customer: c, alias }; continue; }
      const exNew = alias.toLowerCase() === name.toLowerCase() ? 1 : 0;
      const exOld = best.alias.toLowerCase() === name.toLowerCase() ? 1 : 0;
      if (exNew !== exOld) { if (exNew > exOld) best = { customer: c, alias }; continue; }
      if (alias.length !== best.alias.length) { if (alias.length > best.alias.length) best = { customer: c, alias }; continue; }
      if (String(c.customerId) < String(best.customer.customerId)) best = { customer: c, alias };
    }
  }
  return best ? best.customer : null;
}

/**
 * An account's effective bidding targets, shaped EXACTLY like config.allowlist so
 * discovery.matchesAllowlist consumes it unchanged. shippers = UNION of the kept global fallback
 * AND the aliases of every customer assigned via an enabled person on this account. An empty base
 * contributes nothing (fail closed - empty = match nothing, in lockstep with matchesAllowlist), so
 * the effective targets are exactly the assigned customers. lanes + hardCloseOnly pass through from
 * the fallback (the hard-close gate is never moved into the model).
 */
function resolveTargets({ account, customers, people, assignments, fallbackAllowlist }) {
  const fb = fallbackAllowlist || {};
  const accountId = account && account.accountId;
  const custById = new Map((customers || []).filter((c) => c && c.enabled !== false).map((c) => [c.customerId, c]));
  const peopleOnAccount = new Set(
    (people || []).filter((p) => p && p.enabled !== false && (accountId == null || p.accountId === accountId)).map((p) => p.personId),
  );
  const fbShippers = (fb.shippers || []).map((s) => String(s).trim()).filter(Boolean);
  const lanes = (fb.lanes || []).slice();
  const hardCloseOnly = !!fb.hardCloseOnly;
  // Empty shipper base = match NOTHING (fail closed), agreeing with discovery.matchesAllowlist: a
  // cleared/unset base no longer silently bids everything (the 2026-07-14 flood footgun). The
  // assigned-customer aliases ARE the account's positive targets, so they are unioned in even on an
  // empty base - empty base + assignments bids EXACTLY those customers; empty base + no assignments
  // bids nothing. This function and matchesAllowlist MUST agree on what [] means, or an account that
  // scopes purely through the model (empty base) would silently price zero loads.
  const shippers = [...fbShippers];
  for (const a of (assignments || [])) {
    if (!a || a.enabled === false || !peopleOnAccount.has(a.personId)) continue;
    const c = custById.get(a.customerId);
    if (c) shippers.push(...(c.aliases || []));
  }
  return {
    shippers: [...new Set(shippers.map((s) => String(s).trim()).filter(Boolean))],
    lanes, hardCloseOnly,
  };
}

/**
 * Effective margin band for a load: bid-override (tier 1, applied by the caller) >
 * assignment.marginOverride > customer.margin > default. Resolves the matching customer ONCE via
 * matchCustomer (same alias/tie-break rules as resolveBand) over ALL enabled customers - not just
 * margin-bearing ones - so an assignment override still applies even when its customer carries no
 * base margin. That's the common post-migration shape: migration creates every recipient-scope
 * shipper as a margin:null customer, and an operator can still set a per-pairing override on it via
 * the Assignments page with no guard against that. Falls through to resolveBand (with no profiles)
 * only to inherit its default-band shape when there's no customer match at all.
 */
// A band with no rung list (a hand-edited store file; the stores refuse one on write) is passed over
// so the next tier resolves, rather than throwing on the price page and on every new request.
const hasRungs = (m) => !!m && Array.isArray(m.marginsPct) && m.marginsPct.length > 0;

function resolveMargin({ platformKey, companyName, customers, assignments, defaults }) {
  const customer = matchCustomer(companyName, customers);
  if (customer) {
    let ov = null;
    for (const a of (assignments || [])) {
      if (!a || a.enabled === false || a.customerId !== customer.customerId || !hasRungs(a.marginOverride)) continue;
      if (!ov || (a.updatedAt || 0) > (ov.updatedAt || 0)) ov = a; // most-recent override wins (deterministic)
    }
    if (ov) return { marginsPct: ov.marginOverride.marginsPct.slice(), minMarginPct: ov.marginOverride.minMarginPct, source: `assignment:${ov.assignmentId}` };
    // The customer tier has a platform dimension: a band tuned for this portal (GoComet's 3-revision
    // budget and Rs 1,000 minimum gap are not SuperProcure's) stands in for the shared band. The tier
    // order around it is unchanged, and without one nothing below changes.
    const own = customer.marginByPlatform && customer.marginByPlatform[platformKey];
    if (hasRungs(own)) return { marginsPct: own.marginsPct.slice(), minMarginPct: own.minMarginPct, source: `customer:${customer.customerId}:${platformKey}` };
    if (hasRungs(customer.margin)) return { marginsPct: customer.margin.marginsPct.slice(), minMarginPct: customer.margin.minMarginPct, source: `customer:${customer.customerId}` };
  }
  return resolveBand({ platformKey, companyName, profiles: [], defaults });
}

/**
 * A provisional-close load's round cap, per plant: null when no customer matches or the customer
 * carries no roundPolicy (the engine's default then applies). Otherwise the first byOrigin entry,
 * in list order, with a token found case-folded inside the load's origin, else the customer's
 * top-level value. finalAfterExtensions null means the plant is uncapped.
 */
function resolveRoundPolicy({ companyName, origin, customers }) {
  const customer = matchCustomer(companyName, customers);
  const rp = customer && customer.roundPolicy;
  if (!rp) return null;
  const where = String(origin || '').toLowerCase();
  const entries = Array.isArray(rp.byOrigin) ? rp.byOrigin : [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && Array.isArray(e.match) && e.match.some((t) => t && where.includes(String(t).toLowerCase()))) {
      return { finalAfterExtensions: e.finalAfterExtensions, source: `customer:${customer.customerId}:byOrigin[${i}]` };
    }
  }
  return { finalAfterExtensions: rp.finalAfterExtensions, source: `customer:${customer.customerId}` };
}

/** Whether the load's customer has the walk's pre-emptive lowest price at rank 1 switched on (T9 W9). */
function resolvePreEmptiveFloor({ companyName, customers }) {
  const customer = matchCustomer(companyName, customers);
  return !!(customer && customer.preEmptiveFloorAtRankOne === true);
}

/**
 * The humans who own a load's customer - i.e. who to @-mention when the bot posts that load into
 * a "BRL Bids" group. BRL staff do not all know which branch owns which customer, so an
 * unaddressed message in a 12-person group is a message nobody picks up.
 *
 * Pure, like everything else here: collections in, no I/O, no store. Resolution is deliberately
 * re-run at SEND time rather than read off the price-request's `customer` snapshot, because that
 * snapshot's contract is display-only ("NEVER feeds routing, margin, or scope") and a mention IS
 * routing - so a re-assignment must take effect on in-flight requests, exactly as margin and scope
 * already do.
 *
 * Four rules, each load-bearing:
 *  - Only an assignment explicitly marked `owner:true` counts. Assignments answer "who receives
 *    this customer's alerts", which is NOT "who owns this desk" - on live data the Director and
 *    the developer carry an assignment to nearly every customer for oversight. Walking all of them
 *    would tag 5 people including the Director on a single Durian load and name nobody
 *    accountable, which is strictly worse than the unaddressed message this feature exists to fix.
 *    Since `owner` defaults false, an undesignated customer yields [] and renders exactly as today.
 *  - A person whose `phone` is a GROUP JID is skipped. Groups are modelled as person-records
 *    (personStore's header spells this out) and are assigned to their own customer, so an
 *    unfiltered walk would try to @-mention the group inside itself.
 *  - Deduped by dialable number, mirroring toRecipientRows' dedupe, so one human holding two
 *    assignments to the same customer is never tagged twice in one message.
 *  - Ordered stably by personId so the rendered text is byte-reproducible across sends - this repo
 *    tests messages by golden output, and an unstable order would make those tests flap.
 *
 * No customer match, no enabled assignment, or no non-group person -> [] , which every caller must
 * treat as "render the message exactly as it renders today". A missing tag is a cosmetic loss; a
 * dropped price ask on a live auction is money.
 */
function resolveOwners({ companyName, customers, people, assignments }) {
  const customer = matchCustomer(companyName, customers);
  if (!customer) return [];
  const byId = new Map(
    (people || []).filter((p) => p && p.enabled !== false && p.personId != null).map((p) => [p.personId, p]),
  );
  const out = [];
  const seen = new Set();
  for (const a of (assignments || [])) {
    if (!a || a.enabled === false || a.owner !== true || a.customerId !== customer.customerId) continue;
    const p = byId.get(a.personId);
    if (!p || isGroupJid(p.phone)) continue;
    const key = String(p.phone == null ? '' : p.phone).replace(/\D/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ personId: p.personId, name: p.name || '', phone: p.phone });
  }
  out.sort((x, y) => (String(x.personId) < String(y.personId) ? -1 : String(x.personId) > String(y.personId) ? 1 : 0));
  return out;
}

/**
 * A stored phone -> the Maytapi mention token. Maytapi has NO `mentions` array (the shape every
 * search result confidently describes belongs to a DIFFERENT vendor); a mention is purely an
 * `@<digits>` token inside the ordinary `message` string, and their server converts it into a real
 * WhatsApp mention. So this is the entire wire format, and `whatsapp.js` needs no change at all.
 *
 * Country code is RETAINED and the `+` stripped (`+919594963428` -> `@919594963428`). This is
 * VERIFIED, not assumed - a live probe on the test group (2026-07-25, eyeballed in the WhatsApp
 * client because Maytapi returns success:true for sends that rendered nothing) showed:
 *   - country-coded token  -> resolves to the participant's DISPLAY NAME and pings them;
 *   - bare 10-digit token  -> does NOT resolve; the raw digits render, so the person is not tagged
 *                             and never notified. The country code is mandatory, not cosmetic.
 *   - non-participant      -> raw digits render, no error, send unaffected (harmless degrade);
 *   - two tokens in one message -> both resolve.
 * Anything that reduces to no digits yields '' so a malformed record can never emit a bare '@'
 * into a customer-facing message.
 */
function mentionToken(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  return digits ? `@${digits}` : '';
}

module.exports = { matchCustomer, resolveTargets, resolveMargin, resolveRoundPolicy, resolvePreEmptiveFloor, resolveOwners, mentionToken };
