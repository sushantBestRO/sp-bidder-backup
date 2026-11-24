'use strict';
/**
 * Proactive SP token-expiry warning (src/notify/tokenExpiry.js): fires the 'error'
 * alert at each crossed threshold, dedupes per-threshold (not per-day), and never
 * throws when there's no notifier/tokenExp.
 */
const { checkTokenExpiry, WARN_THRESHOLDS_DAYS } = require('../src/notify/tokenExpiry');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, payload, opts) => { calls.push({ kind, payload, opts }); } };
}

const DAY = 86400000;

(async () => {
  // ---- far from expiry: no alert ----
  {
    const n = fakeNotifier();
    await checkTokenExpiry({ tokenExp: Date.now() + 90 * DAY, notifier: n, now: Date.now() });
    ok(n.calls.length === 0, '90 days out -> no alert');
  }

  // ---- exactly the thresholds already crossed fire (10 days left -> the 30/14-day
  //      thresholds have been crossed; 7/3/1 haven't, since 10 days still exceeds them) ----
  {
    const n = fakeNotifier();
    const now = Date.now();
    await checkTokenExpiry({ tokenExp: now + 10 * DAY, notifier: n, now, accountLabel: 'primary' });
    ok(n.calls.length === 2, `10 days left -> 2 thresholds fire (30,14), got ${n.calls.length}`);
    ok(n.calls.every((c) => c.kind === 'error'), 'all fired as kind=error');
    ok(n.calls.every((c) => c.opts.dedupeKey.startsWith('token_expiry_warn_primary_')), 'dedupeKey scoped to account label');
    const keys = n.calls.map((c) => c.opts.dedupeKey).sort();
    ok(JSON.stringify(keys) === JSON.stringify(['token_expiry_warn_primary_14', 'token_expiry_warn_primary_30'].sort()), 'exact threshold set for 10 days left');
  }

  // ---- booting with very little runway crosses every threshold at once, each dedupes distinctly ----
  {
    const n = fakeNotifier();
    const now = Date.now();
    await checkTokenExpiry({ tokenExp: now + 2 * DAY, notifier: n, now, accountLabel: 'acct2' });
    ok(n.calls.length === WARN_THRESHOLDS_DAYS.filter((d) => d >= 2).length, 'boots-late case fires every already-crossed threshold once each');
  }

  // ---- already expired: still fires (never silently skip a dead token) ----
  {
    const n = fakeNotifier();
    const now = Date.now();
    await checkTokenExpiry({ tokenExp: now - DAY, notifier: n, now, accountLabel: 'primary' });
    ok(n.calls.length === WARN_THRESHOLDS_DAYS.length, 'already-expired token fires every threshold');
    ok(n.calls[0].payload.detail.includes('TODAY or already past'), 'past-expiry wording used, not a negative day count');
  }

  // ---- multi-account labelling: two accounts don't collide on dedupeKey ----
  {
    const n = fakeNotifier();
    const now = Date.now();
    await checkTokenExpiry({ tokenExp: now + 5 * DAY, notifier: n, now, accountLabel: 'acct-a' });
    await checkTokenExpiry({ tokenExp: now + 5 * DAY, notifier: n, now, accountLabel: 'acct-b' });
    const keys = n.calls.map((c) => c.opts.dedupeKey);
    ok(new Set(keys).size === keys.length, 'per-account dedupeKeys are all distinct');
  }

  // ---- never throws on missing tokenExp / notifier ----
  {
    await checkTokenExpiry({ tokenExp: null, notifier: fakeNotifier() });
    await checkTokenExpiry({ tokenExp: Date.now() + DAY, notifier: null });
    ok(true, 'missing tokenExp or notifier never throws');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
