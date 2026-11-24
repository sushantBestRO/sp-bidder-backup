'use strict';
/**
 * Config-change audit trail (deterministic, offline): field-level diff, the actor
 * + before/after the store persists, and that a no-op change records nothing.
 */
const { createStore } = require('../src/store');
const { defaultsFrom } = require('../src/admin/configStore');
const { diffConfig, recordConfigChange, STREAM } = require('../src/admin/auditLog');

// Every assertion below must run. Without this, a `return` added above the tail would exit 0
// and the runner - which grades on exit status alone - would score a zero-assertion file GREEN.
const EXPECTED_CHECKS = 22;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const before = {
  marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  allowlist: { shippers: [], lanes: [], hardCloseOnly: false },
  recipients: [], discoveryIntervalMs: 30000, priceDeadlineLeadMs: 90000,
  notifyMode: 'dashboard', antiDetection: { enabled: true, cadenceJitterMs: 250, maxBidsPerMin: 20, minInterFireMs: 150 },
};
const after = {
  ...before,
  minMarginPct: 5,
  allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true },
};

(async () => {
  // ---- diffConfig ----
  const d = diffConfig(before, after);
  ok(!!d.find((c) => c.field === 'minMarginPct'), 'diff detects the minMarginPct change');
  ok(!!d.find((c) => c.field === 'allowlist'), 'diff detects the allowlist change');
  ok(!d.find((c) => c.field === 'marginsPct'), 'an unchanged field is not in the diff');
  ok(diffConfig(before, before).length === 0, 'identical snapshots -> empty diff');
  const mm = d.find((c) => c.field === 'minMarginPct');
  ok(mm.before === 6.3 && mm.after === 5, 'diff carries the before/after values');

  // ---- recordConfigChange persists through the store seam ----
  const store = createStore({ backend: 'memory' });
  const rec = await recordConfigChange(store, { actor: 'admin', before, after, ip: '127.0.0.1' });
  ok(rec && rec.actor === 'admin' && rec.action === 'config_save', 'record carries actor + action');
  ok(rec.changed.includes('minMarginPct') && rec.changed.includes('allowlist'), 'record lists the changed fields');
  const events = await store.readEvents(STREAM);
  ok(events.length === 1, 'one audit event persisted');
  ok(events[0].changes.find((c) => c.field === 'minMarginPct').after === 5, 'persisted after-value is correct');
  ok(typeof events[0].ts === 'number', 'audit event is timestamped');

  // ---- a no-op change records nothing ----
  const noop = await recordConfigChange(store, { actor: 'admin', before, after: before });
  ok(noop === null, 'no-op change returns null');
  ok((await store.readEvents(STREAM)).length === 1, 'no-op did not append a second event');

  // ---- REGRESSION 2026-08-02: a soft-close enrolment change wrote NO audit entry ----
  // diffConfig walked a hand-kept include-list that never had `softClose` on it, so adding a
  // shipper to config.softClose.shippers - the switch deciding which customers the engine bids
  // for - produced an empty diff, and recordConfigChange returned null without erroring. Live
  // on the box: enrolling KEI left no record of who did it or when.
  const scBefore = { ...before, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } };
  const scAfter = { ...scBefore, softClose: { enabled: true, shippers: ['Havells', 'KEI'], mode: 'live', reserve: 1 } };
  const scDiff = diffConfig(scBefore, scAfter);
  ok(!!scDiff.find((c) => c.field === 'softClose'), 'a soft-close shipper enrolment IS in the diff');
  ok(scDiff.length === 1, 'and it is the ONLY field reported for that change');
  const scRec = await recordConfigChange(store, { actor: 'admin', before: scBefore, after: scAfter });
  ok(scRec !== null, 'a soft-close-only change actually writes an audit entry');
  ok(scRec && scRec.changed.includes('softClose'), 'the entry names softClose as changed');
  ok(scRec && scRec.changes[0].after.shippers.includes('KEI'), 'the entry carries the new shipper list');

  // reminderLeadMs was missing from the same list, for the same reason
  ok(diffConfig(before, { ...before, reminderLeadMs: 60000 }).some((c) => c.field === 'reminderLeadMs'),
    'reminderLeadMs is audited');

  // ---- THE INVARIANT: every field configStore persists is audited ----
  // Read at RUNTIME off the real persisted shape, so the next field added to the config and
  // forgotten here fails HERE rather than silently going unrecorded in production.
  const persisted = defaultsFrom({});
  const mutate = (v) => {
    if (Array.isArray(v)) return [...v, '__audit_probe__'];
    if (v && typeof v === 'object') return { ...v, __audit_probe__: 1 };
    if (typeof v === 'number') return v + 1;
    if (typeof v === 'boolean') return !v;
    if (typeof v === 'string') return `${v}__audit_probe__`;
    return '__audit_probe__';
  };
  const unaudited = Object.keys(persisted).filter((k) => {
    const d2 = diffConfig(persisted, { ...persisted, [k]: mutate(persisted[k]) });
    return !d2.some((c) => c.field === k);
  });
  ok(unaudited.length === 0, `every persisted config field is audited (unaudited: ${unaudited.join(', ') || 'none'})`);
  ok(Object.keys(persisted).length >= 10, 'the persisted shape still has all its fields (sanity on the probe)');

  // a field APPEARING or DISAPPEARING is itself a change worth recording
  ok(diffConfig({ a: 1 }, { a: 1, b: 2 }).some((c) => c.field === 'b'), 'an added field is a change');
  ok(diffConfig({ a: 1, b: 2 }, { a: 1 }).some((c) => c.field === 'b'), 'a removed field is a change');

  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`\nINCOMPLETE RUN: ${pass + fail} checks ran, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
