'use strict';

const { matchCustomer } = require('./resolve');

// closedBids is observed to hold ~53 days of history on the live box (never explicitly pruned,
// this is just how far back the bot's operational record currently reaches) and is the PRIMARY
// window here because priceRequests.json prunes itself at ~7 days - too short to see a
// low-volume customer that still gets a load every few weeks. Using the same window for both
// sources is harmless for priceRequests: its own file can never hand back a row older than its
// prune horizon anyway, so the wider window only ever binds on closedBids.
const DEFAULT_WINDOW_MS = 53 * 24 * 60 * 60 * 1000;

function customerIdOf(customer) {
  return customer && customer.customerId != null ? String(customer.customerId) : null;
}

/**
 * Which customers has this account ACTUALLY CARRIED, inside the window - never derived from
 * `person.accountId` (see coverage.js's caller for why that field goes stale silently; the
 * Durian case is the proof: its group person is still registered on `sameer-ambdaskar`, but its
 * loads moved to `master` on 2026-08-05 and have bid there ever since).
 *
 * closedBids only carries a raw shipper string (`shipper`), not a customerId, so each row is
 * resolved through `matchCustomer` - the SAME alias/tokenMatch rules margin resolution already
 * uses, so "carried" agrees with what actually got priced. The recency anchor is `armedAt`, not
 * `closedAt`: `closedAt` is null for anything still open, and an account mid-bidding a live
 * auction for a customer is exactly the case this must not drop. `closedAt` is used only as a
 * fallback for a row missing `armedAt` (shape drift, not the expected case).
 *
 * priceRequests is folded in for the same account/window and needs no resolution step - it
 * already carries `customer.customerId`, set at ask time - anchored on `createdAt`.
 */
function customersCarriedBy(accountId, { priceRequests, closedBids, customers, windowMs = DEFAULT_WINDOW_MS, now = Date.now() } = {}) {
  const out = new Set();
  if (!accountId) return out;
  const cutoff = now - windowMs;

  for (const r of (closedBids || [])) {
    if (!r || !r.account || r.account.accountId !== accountId) continue;
    const ts = Number.isFinite(r.armedAt) ? r.armedAt : r.closedAt;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const id = customerIdOf(matchCustomer(r.shipper, customers));
    if (id) out.add(id);
  }

  for (const r of (priceRequests || [])) {
    if (!r || !r.account || r.account.accountId !== accountId) continue;
    if (!Number.isFinite(r.createdAt) || r.createdAt < cutoff) continue;
    const id = customerIdOf(r.customer);
    if (id) out.add(id);
  }

  return out;
}

/**
 * Which customers will actually go unbid because of this set of dead accounts?
 *
 * A customer qualifies only if EVERY account that carried it recently is dead (found by walking
 * `deadAccountIds` through `customersCarriedBy` - a customer this loop never reaches was never
 * carried by a dead account at all) AND no LIVE account has carried it in the same window. That
 * second check is what keeps Durian off the list: its dead account (`sameer-ambdaskar`) still
 * shows up as a recent carrier from its pre-migration closedBids rows (inside the 53-day window),
 * but `master` (live) shows up too, from the loads that moved there on 2026-08-05 - so it fails
 * the "carried live" check and is correctly excluded.
 *
 * This is a WINDOW-based approximation of "since the earliest of those deaths", not a literal
 * per-account-death-instant cutoff - there is no per-account death timestamp on this signature,
 * only a flat dead/live account-id split, so "recently" means "inside windowMs of `now`" for
 * both dead-side and live-side carriers. That is deliberate for the Durian case (both the stale
 * dead-side rows and the fresh live-side rows sit inside one shared window) but is a judgment
 * call the caller should confirm: a customer with genuinely no recent activity anywhere (older
 * than windowMs on every account, dead or live) is treated as not-carried and so never appears as
 * affected, rather than as an unresolved unknown.
 *
 * Returns customer LABELS (falling back to the customerId string if the customer record is gone),
 * sorted so the rendered alert is byte-reproducible.
 */
function affectedCustomers({ deadAccountIds, liveAccountIds, priceRequests, closedBids, customers, windowMs, now } = {}) {
  const dead = [...new Set((deadAccountIds || []).filter(Boolean))];
  if (!dead.length) return [];
  const live = [...new Set((liveAccountIds || []).filter(Boolean))];
  const opts = { priceRequests, closedBids, customers, windowMs, now };

  const carriedByDead = new Set();
  for (const accId of dead) {
    for (const custId of customersCarriedBy(accId, opts)) carriedByDead.add(custId);
  }
  if (!carriedByDead.size) return [];

  const carriedByLive = new Set();
  for (const accId of live) {
    for (const custId of customersCarriedBy(accId, opts)) carriedByLive.add(custId);
  }

  const byId = new Map((customers || []).filter((c) => c && c.customerId != null).map((c) => [String(c.customerId), c]));
  const out = [];
  for (const custId of carriedByDead) {
    if (carriedByLive.has(custId)) continue;
    const c = byId.get(custId);
    out.push((c && c.label) ? c.label : custId);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

module.exports = { customersCarriedBy, affectedCustomers, DEFAULT_WINDOW_MS };
