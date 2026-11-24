'use strict';
/**
 * Price-request prune test (deterministic, offline). pruneEnded() bounds the collection
 * by dropping requests whose auction ended > retention ago, keyed off closesAt (with a
 * createdAt fallback) so a still-open auction is never removed. Memory store, no network.
 */
const { createStore } = require('../src/store');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86_400_000;

(async () => {
  const now = Date.now();
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5 });

  // Seed docs directly for precise control over closesAt / createdAt.
  const seed = (id, status, closesAt, createdAt) =>
    store.putDoc(COLLECTION, id, { id, loadId: id, status, createdAt, load: { closesAt } });

  await seed('old-armed', 'armed', now - 10 * DAY, now - 10 * DAY);            // ended 10d ago -> prune
  await seed('old-skipped', 'skipped_no_price', now - 8 * DAY, now - 8 * DAY); // ended 8d ago -> prune
  await seed('old-awaiting', 'awaiting_price', now - 9 * DAY, now - 9 * DAY);  // stale, long past -> prune
  await seed('live-armed', 'armed', now + 2 * DAY, now - 1 * DAY);             // auction still open -> keep
  await seed('recent-skipped', 'skipped_no_price', now - 2 * DAY, now - 2 * DAY); // within 7d -> keep
  await seed('no-close', 'armed', null, now - 10 * DAY);                       // no closesAt, old createdAt -> prune (fallback)
  await seed('unageable', 'armed', null, null);                               // no close/created time -> keep

  ok((await requests.listAll()).length === 7, 'seeded 7 requests');

  const removed = await requests.pruneEnded(now); // default 7-day retention
  ok(removed === 4, `pruned 4 ended-long-ago requests, got ${removed}`);

  const remaining = new Set((await requests.listAll()).map((r) => r.id));
  ok(remaining.size === 3, `3 requests remain, got ${remaining.size}`);
  ok(remaining.has('live-armed'), 'still-open auction (closesAt in future) is kept');
  ok(remaining.has('recent-skipped'), 'recently-ended request within retention is kept');
  ok(remaining.has('unageable'), 'request with no closesAt/createdAt is kept (cannot age safely)');
  ok(!remaining.has('old-armed'), 'armed request ended 10d ago is pruned');
  ok(!remaining.has('no-close'), 'no closesAt but old createdAt -> pruned via fallback');

  // ---- boundary: strict >, so exactly-at-retention survives ----
  const s2 = createStore({ backend: 'memory' });
  const r2 = new PriceRequestStore({ store: s2, marginsPct: [10], minMarginPct: 5 });
  await s2.putDoc(COLLECTION, 'exact', { id: 'exact', loadId: 'e', status: 'armed', createdAt: now, load: { closesAt: now - 7 * DAY } });
  await s2.putDoc(COLLECTION, 'justover', { id: 'justover', loadId: 'j', status: 'armed', createdAt: now, load: { closesAt: now - 7 * DAY - 1 } });
  const rem2 = await r2.pruneEnded(now, 7 * DAY);
  ok(rem2 === 1, `boundary: only the just-over request pruned, got ${rem2}`);
  ok(!!(await r2.getByToken('exact')), 'exactly at retention is kept (strict >)');
  ok(!(await r2.getByToken('justover')), 'just past retention is pruned');

  // ---- integration: prune runs inside a discovery tick; live loads survive ----
  const s3 = createStore({ backend: 'memory' });
  const r3 = new PriceRequestStore({ store: s3, marginsPct: [10], minMarginPct: 5 });
  await s3.putDoc(COLLECTION, 'stale', { id: 'stale', loadId: 'stale', status: 'skipped_no_price', createdAt: now - 30 * DAY, load: { closesAt: now - 30 * DAY } });
  const liveLoad = { id: 'LIVE', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: now + 10 * 60000, startsAt: now - 1000, status: 'live' };
  const discovery = new DiscoveryPoller({
    adapter: { listAuctions: async () => [liveLoad] },
    requests: r3,
    notifier: new Notifier({ mode: 'dashboard', baseUrl: 'http://t' }),
    config: { allowlist: { shippers: ['syngenta'] }, priceDeadlineLeadMs: 90_000 },
  });
  const res = await discovery.tick();
  ok(res.created === 1, `tick created the live-load request, got ${res.created}`);
  ok(res.pruned === 1, `tick pruned the 30-day-stale request, got ${res.pruned}`);
  ok(!!(await r3.getByLoad('LIVE')), 'after tick: live load kept'); // doc id is a random token, key by loadId
  ok(!(await r3.getByToken('stale')), 'after tick: stale request gone');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
