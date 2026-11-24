'use strict';
// What a branch login can SEE - the branch list SuperProcure already returns at login, kept
// instead of discarded.
//
// `getHeader`.branchList carries the branch NAME and its customer (`freighterName`) alongside the
// id; collectBranchIds() reduced all of it to integers, which is why nobody could answer "which
// login sees Havells?" without an SSH session while four customers sat dark for 27 hours on
// 2026-09-18.
//
// Deliberately NOT here: any judgement about which customers we OUGHT to cover. That question
// spans accounts and needs the customer model, so it belongs on the Customers tab. This module
// answers "what does this login see", nothing more.

const BRANCHES_COLLECTION = 'accountBranches';

/** Branches for one account, as captured at its last login. [] when none were recorded. */
async function loadBranches(store, accountId) {
  const doc = await store.getDoc(BRANCHES_COLLECTION, accountId).catch(() => null);
  return (doc && Array.isArray(doc.branches)) ? doc.branches : [];
}

/**
 * Persist what login() saw, and remember a SHRINK across confirmations.
 *
 * `shrankFrom` exists because the obvious source for it does not work. `accountScope.prevCount`
 * means "the count at the previous CHECK", not "the count before the change": checkScopeChange
 * re-persists on the unchanged branch too (so `updatedAt` records the last confirmation), which
 * rewrites prevCount to the current count. Reading it as a shrink signal makes that signal erase
 * itself at the next 6h confirmation, on any restart, or when the operator clicks Refresh scope -
 * so the collapse the panel exists to show reads as a healthy steady state again.
 *
 * Carried forward on an UNCHANGED write, raised (never lowered) on a DECREASE to the highest count
 * seen before the drop, and cleared only once the count is back at or above that baseline - a
 * partial re-map that lands in batches must not read as recovered while most of it is still dark.
 * The count and the list therefore come from this one document, so the header can never disagree
 * with the rows beneath it.
 *
 * An EMPTY array is persisted, not skipped: a login that genuinely sees nothing must be able to
 * say so. Skipping it left the previous list on screen under a "0 branches" header - the exact
 * count-versus-list contradiction this module exists to remove. Only a non-array (a parse failure,
 * an adapter that never populated it) is refused, and that case is distinguishable in the log.
 *
 * Best-effort by contract: this runs inside login paths that must never fail because bookkeeping
 * failed.
 */
async function saveBranches(store, accountId, branches, log = null) {
  if (!store || !accountId) return;
  if (!Array.isArray(branches)) {
    if (log && log.warn) log.warn('branch capture skipped: adapter returned no branch array', { accountId });
    return;
  }
  const prev = await store.getDoc(BRANCHES_COLLECTION, accountId).catch(() => null);
  const prevCount = prev && Array.isArray(prev.branches) ? prev.branches.length : null;
  let shrankFrom = prev && prev.shrankFrom != null ? prev.shrankFrom : null;
  if (prevCount != null) {
    if (branches.length < prevCount) {
      // new or deepening shrink - keep the highest baseline seen, so a partial re-map (batches
      // land one login at a time) can't clear the warning while most of the loss is still dark
      shrankFrom = shrankFrom != null ? Math.max(shrankFrom, prevCount) : prevCount;
    } else if (shrankFrom != null && branches.length >= shrankFrom) {
      shrankFrom = null; // back at or above the level it shrank from - warning is spent
    }
    // else: unchanged, or a partial recovery still below the baseline - carry shrankFrom forward
  }
  await store.putDoc(BRANCHES_COLLECTION, accountId, {
    accountId, branches, count: branches.length, shrankFrom, updatedAt: Date.now(),
  }).catch(() => {});
}

/**
 * The branch-scope reading for one account's card, from the SAME document the panel lists, so the
 * two can never disagree. Null when this login has never been captured.
 */
function scopeFor(doc) {
  if (!doc || !Array.isArray(doc.branches)) return null;
  return {
    count: doc.count != null ? doc.count : doc.branches.length,
    shrankFrom: doc.shrankFrom != null ? doc.shrankFrom : null,
    confirmedAt: doc.updatedAt || null,
  };
}

module.exports = { BRANCHES_COLLECTION, loadBranches, saveBranches, scopeFor };
