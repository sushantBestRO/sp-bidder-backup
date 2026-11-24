'use strict';
/**
 * Pins D034 and D051 (fix/ops-alerting-divergences).
 *
 * D034: an allowlist rejection was a bare `continue` with no trace anywhere - a shipper whose
 * loads are ALWAYS dropped there reads identically to "posts no loads at all". _tick() now
 * counts rejections per shipper and surfaces the total (and per-shipper breakdown) in its
 * return value and its debug summary line.
 *
 * D051: the existing empty-allowlist guard only fires on a TOTAL wipe. Removing (or typo-
 * mutating) one shipper name out of an otherwise non-empty list tripped nothing. _tick() now
 * diffs each tick's resolved shipper scope against the previous tick's and warns (log + notifier
 * alert) the moment a previously-in-scope shipper drops out, as long as the list is still
 * non-empty (a full wipe is the existing, more urgent signal).
 *
 * @requires-summary-line
 *   node scripts/test-d034-d051-allowlist-rejection-count-and-dropout-warn.js
 */
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const MIN = 5, MARGINS = [10];
const now = Date.now();
const future = now + 10 * 60_000;
const loadFor = (id, companyName) => ({
  id, companyName, lane: { origin: 'A', destination: 'B' }, closesAt: future,
  softClose: false, closeModelKnown: true, quoteType: 'FTL', units: 1,
});

// A real Notifier (dashboard mode -> price_needed/etc. no-op safely, matching
// test-allowlist-and-prune.js's own pattern), with .alert spied so D051's alerts are observable.
function fakeNotifier() {
  const n = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
  const calls = [];
  const origAlert = n.alert.bind(n);
  n.alert = async (kind, payload, opts) => { calls.push({ kind, payload, opts }); return origAlert(kind, payload, opts); };
  n.calls = calls;
  return n;
}

(async () => {
  // ---- D034: allowlist rejections are counted, per shipper, in the tick's own return value ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => [loadFor('L1', 'Havells'), loadFor('L2', 'Havells'), loadFor('L3', 'OutOfScope Ltd')] },
      requests: rq, notifier: fakeNotifier(),
      config: { allowlist: { shippers: ['Havells'] }, priceDeadlineLeadMs: 90_000 },
    });
    const r = await poller.tick();
    ok(r.created === 2, 'the two in-scope loads (Havells) still create price requests');
    ok(r.allowlistRejected === 1, `D034: the one out-of-scope load is counted as an allowlist rejection, got ${r.allowlistRejected}`);
  }

  // ---- D034: zero rejections when everything is in scope (no false counting) ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => [loadFor('L1', 'Havells')] },
      requests: rq, notifier: fakeNotifier(),
      config: { allowlist: { shippers: ['Havells'] }, priceDeadlineLeadMs: 90_000 },
    });
    const r = await poller.tick();
    ok(r.allowlistRejected === 0, 'D034: zero rejections when every load is in scope');
  }

  // ---- D051: a shipper dropping out of an otherwise non-empty allowlist warns ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const notifier = fakeNotifier();
    const cfg = { allowlist: { shippers: ['Havells', 'Syngenta'] }, priceDeadlineLeadMs: 90_000 };
    const poller = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq, notifier, config: cfg });
    await poller.tick(); // establishes the baseline scope (Havells, Syngenta)
    ok(notifier.calls.length === 0, 'control: no warning on the first (baseline) tick');

    // Syngenta drops out of the config - simulating a config edit / typo, WITHOUT the list going empty.
    cfg.allowlist.shippers = ['Havells'];
    await poller.tick();
    ok(notifier.calls.length === 1, `D051: a shipper dropping out of a non-empty allowlist fires exactly one alert, got ${notifier.calls.length}`);
    const detail = notifier.calls[0] && notifier.calls[0].payload && notifier.calls[0].payload.detail;
    ok(!!detail && /Syngenta/.test(detail), `D051: the alert names the dropped shipper: got "${detail}"`);
  }

  // ---- D051: no re-warning on a stable (already-dropped) scope ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const notifier = fakeNotifier();
    const cfg = { allowlist: { shippers: ['Havells', 'Syngenta'] }, priceDeadlineLeadMs: 90_000 };
    const poller = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq, notifier, config: cfg });
    await poller.tick();
    cfg.allowlist.shippers = ['Havells'];
    await poller.tick();
    notifier.calls.length = 0;
    await poller.tick(); // scope unchanged since the last tick - nothing new dropped
    ok(notifier.calls.length === 0, 'D051: no repeat alert when the scope is unchanged from the last tick');
  }

  // ---- D051: a FULL wipe still routes through the existing empty-allowlist warning, not this one ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const notifier = fakeNotifier();
    const cfg = { allowlist: { shippers: ['Havells'] }, priceDeadlineLeadMs: 90_000 };
    const poller = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq, notifier, config: cfg });
    await poller.tick();
    cfg.allowlist.shippers = [];
    await poller.tick();
    // The empty-allowlist path is a plain log warning (not a notifier.alert call), so the dropout
    // alert (which DOES call notifier.alert) must stay silent here - a full wipe is not "one shipper
    // dropped out of a non-empty list".
    ok(notifier.calls.length === 0, 'control: a full wipe to empty does not also fire the per-shipper dropout alert');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (!fail) console.log(`${pass}/${pass} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
