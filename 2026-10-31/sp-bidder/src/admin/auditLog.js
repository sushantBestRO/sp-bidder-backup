'use strict';

/**
 * Config-change audit trail. Every accepted POST /api/config is recorded to an
 * append-only stream through the store seam (same daily-JSONL shape as the bid log),
 * so a money-path change - a floor margin, an allowlist edit - always carries a
 * who/when/before/after. The "who" comes from the authenticated session.
 */

const STREAM = 'configChanges';

// Fields deliberately kept OUT of the trail. Empty today, and that is the point: this module
// used to carry the inverse - a hand-listed set of fields to INCLUDE - and it silently drifted
// from the config schema. `softClose` was added to the persisted config and never added here,
// so every soft-close enrolment change - which decides WHICH CUSTOMERS THE ENGINE BIDS FOR -
// wrote no audit entry at all: diffConfig returned [] and recordConfigChange returned null
// without erroring. `reminderLeadMs` was missing the same way. Found 2026-08-02 when enrolling
// KEI produced a live config change with no trace of who made it.
//
// An audit trail is one of the few places in this fail-closed codebase where the safe default
// is the OPEN one: over-recording an internal field is harmless, under-recording a money-path
// change is the failure we just had. So diffConfig now walks whatever keys the config snapshots
// actually carry, and a new field is audited from the moment it exists. Add a field here only
// to deliberately suppress it (e.g. a future secret), and say why.
const EXCLUDE = new Set([]);

/**
 * Field-level diff of two config snapshots; only the fields that actually changed.
 * Keys come from the snapshots themselves (union of both sides, so an added or removed field
 * is a change), never from a hand-kept list - see EXCLUDE. Sorted for stable output.
 */
function diffConfig(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((f) => !EXCLUDE.has(f))
    .sort();
  const out = [];
  for (const f of keys) {
    const a = JSON.stringify(before ? before[f] : undefined);
    const b = JSON.stringify(after ? after[f] : undefined);
    if (a !== b) out.push({ field: f, before: before ? before[f] : null, after: after ? after[f] : null });
  }
  return out;
}

/** Append one audit entry. Returns null (no write) when nothing actually changed. */
async function recordConfigChange(store, { actor, before, after, ip } = {}) {
  const changes = diffConfig(before, after);
  if (changes.length === 0) return null;
  return store.appendEvent(STREAM, {
    action: 'config_save',
    actor: actor || 'unknown',
    ip: ip || null,
    changed: changes.map((c) => c.field),
    changes,
  });
}

module.exports = { diffConfig, recordConfigChange, STREAM };
