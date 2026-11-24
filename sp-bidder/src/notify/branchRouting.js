'use strict';

/**
 * Branch-level routing for per-customer WhatsApp groups.
 *
 * Today alert routing keys on CUSTOMER (shipper) only: a group carries scope.shippers and a load
 * matches by its shipper, so a high-volume customer's EVERY branch lands in one group. This module
 * adds an OPTIONAL second dimension - scope.branches - so a group can be narrowed to one branch of a
 * shipper (e.g. Havells' Alwar branch) without disturbing any customer that has no branch filter. A
 * group with an empty branch scope behaves exactly as before (backward-compatible).
 *
 * The branch label is the RAW SuperProcure string the portal shows and the bot already prints in the
 * *Name* line ("Alwar Cable (1350)": a human name plus SP's numeric branch id in parens). That id is
 * the one stable, unique key for a branch, so branch matching keys on it whenever present and falls
 * back to a normalized full-label compare otherwise:
 *
 *   "Alwar Cable (1350)"  -> id:1350          (the parenthesized SP branch id - the strong key)
 *   "1350"                -> id:1350          (a bare id an operator may configure instead)
 *   "Alwar Cable"         -> name:alwar cable (no id present -> exact normalized name compare)
 *
 * Keying on the id is deliberately NOT a loose "contains alwar" test: that would also swallow a
 * DIFFERENT branch in the same town ("Alwar Steel (1400)" -> id:1400, no match) and misroute it.
 * The rule pins ONE branch, never a family of same-town branches.
 */

// A canonical, comparable key for a branch label, or null for an empty/absent label. A missing
// branch must never accidentally satisfy a branch filter (a load with no branch is not an Alwar
// load), which is why null is returned rather than an empty-string key.
function branchKey(label) {
  const s = String(label == null ? '' : label).trim();
  if (!s) return null;
  const paren = s.match(/\((\d+)\)\s*$/);          // trailing "(1350)" - SP's numeric branch id
  if (paren) return `id:${paren[1]}`;
  if (/^\d+$/.test(s)) return `id:${s}`;            // a bare branch id ("1350")
  return `name:${s.toLowerCase().replace(/\s+/g, ' ')}`;
}

// Does a load's branch label match a group's configured branch filter? Both sides are normalized to
// a key first, so casing, surrounding whitespace and the human-name half of the label do not matter -
// only the branch identity does. A null on either side (no branch on the load, or an empty filter
// value) is never a match.
function branchMatches(filterLabel, loadBranch) {
  const fk = branchKey(filterLabel);
  const lk = branchKey(loadBranch);
  if (!fk || !lk) return false;
  return fk === lk;
}

// Precedence: a branch-scoped group WINS over the general (branch-less) group of the SAME customer
// for a load it matches. The input is the channel groups that ALREADY matched this load (scopeMatches
// enforced shipper + any branch filter). Drop every branch-LESS group whose shipper scope overlaps a
// matched branch-scoped group's shipper scope, so the Alwar load reaches the Alwar group ONLY - never
// both, and never as an individual-DM fallback.
//
// Backward-compatible by construction: when no matched group carries a branch filter the input array
// is returned unchanged, so a deployment with no branch groups routes exactly as before. Deterministic
// - a pure filter over the input order, no sort and no tie-break.
function applyBranchPrecedence(channelGroups) {
  const groups = channelGroups || [];
  const branchScoped = groups.filter((g) => g && g.scope && (g.scope.branches || []).length > 0);
  if (branchScoped.length === 0) return groups;   // nothing more specific in play - unchanged
  const shippersOf = (g) => new Set((((g && g.scope) || {}).shippers || []).map((s) => String(s).toLowerCase()));
  const branchShipperSets = branchScoped.map(shippersOf);
  return groups.filter((g) => {
    if (g && g.scope && (g.scope.branches || []).length > 0) return true;   // keep the specific group
    const gShippers = shippersOf(g);
    // a general group is superseded iff a matched branch-scoped group shares ANY shipper alias with it
    const superseded = branchShipperSets.some((set) => [...gShippers].some((s) => set.has(s)));
    return !superseded;
  });
}

module.exports = { branchKey, branchMatches, applyBranchPrecedence };
