'use strict';
/**
 * Price-request archive test (deterministic, offline). pruneEnded() appends every record it is
 * about to drop to the append-only ARCHIVE_STREAM, exactly once, and prunes regardless of whether
 * that append worked. Memory store for the logic, a real temp-dir FileStore for the on-disk
 * exactly-once + restart path. No network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, FileStore } = require('../src/store');
const { PriceRequestStore, COLLECTION, ARCHIVE_STREAM } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86_400_000;
const now = Date.now();

const seed = (store, id, extra) => store.putDoc(COLLECTION, id, Object.assign({
  id, loadId: 'L-' + id, status: 'closed', createdAt: now - 10 * DAY, price: null,
  load: { closesAt: now - 10 * DAY, companyName: 'Havells', branchName: 'Alwar Cable (1350)', lane: { origin: 'Alwar', destination: 'Pune' } },
}, extra));

const mk = (store) => new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5 });

(async () => {
  // ---- crossing the retention boundary archives exactly the pruned records ----
  {
    const store = createStore({ backend: 'memory' });
    const requests = mk(store);
    await seed(store, 'ended-priced', { price: 41000, capturedAt: now - 10 * DAY, status: 'closed' });
    await seed(store, 'ended-unpriced', { status: 'closed' });          // closed but never priced
    await seed(store, 'ended-skipped', { status: 'skipped_no_price' });
    await seed(store, 'still-live', { load: { closesAt: now + 2 * DAY }, createdAt: now - 1 * DAY });
    await seed(store, 'recent', { load: { closesAt: now - 2 * DAY }, createdAt: now - 2 * DAY });

    ok(await requests.pruneEnded(now) === 3, 'pruned the 3 records past retention');
    const rows = await store.readEvents(ARCHIVE_STREAM, { from: 0, to: now + DAY });
    ok(rows.length === 3, `archive holds 3 rows, got ${rows.length}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    ok(byId.has('ended-priced') && byId.has('ended-unpriced') && byId.has('ended-skipped'), 'archived exactly the pruned ids');
    ok(!byId.has('still-live') && !byId.has('recent'), 'records inside retention are not archived');

    const live = new Set((await requests.listAll()).map((r) => r.id));
    ok(live.size === 2 && live.has('still-live') && live.has('recent'), 'live store still drops the pruned records');

    // Participation is price-not-null, and the row must carry it independently of status.
    ok(byId.get('ended-priced').priced === true && byId.get('ended-priced').price === 41000, 'priced row records priced=true + the cost');
    ok(byId.get('ended-unpriced').priced === false && byId.get('ended-unpriced').status === 'closed',
      'a closed-but-never-priced row records priced=false, so status can never overstate participation');
    const row = byId.get('ended-priced');
    ok(row.loadId === 'L-ended-priced' && row.companyName === 'Havells' && row.branchName === 'Alwar Cable (1350)' && row.platformKey === 'sp',
      'row carries the join key, customer/branch identity and the portal');
    ok(row.closesAt != null && row.createdAt != null && row.capturedAt != null && row.endedAt != null && row.ts != null,
      'row carries the funnel timestamps and its own write time');
    ok(!('poster' in row) && !('notes' in row), 'third-party contact/free-text is not carried onto the permanent surface');
  }

  // ---- a repeated prune, and a failed removeDoc, do not double-archive ----
  {
    const store = createStore({ backend: 'memory' });
    const requests = mk(store);
    await seed(store, 'x1', {});
    await requests.pruneEnded(now);
    await requests.pruneEnded(now); // collection is empty now - the real repeat risk is below
    ok((await store.readEvents(ARCHIVE_STREAM, { from: 0, to: now + DAY })).length === 1, 'repeated prune of an empty collection adds no row');

    // removeDoc fails -> the record survives into the next tick and must not be archived twice.
    const store2 = createStore({ backend: 'memory' });
    const requests2 = mk(store2);
    await seed(store2, 'x2', {});
    let allowRemove = false;
    const realRemove = store2.removeDoc.bind(store2);
    store2.removeDoc = async (c, id) => (allowRemove ? realRemove(c, id) : false);
    await requests2.pruneEnded(now);
    await requests2.pruneEnded(now);
    allowRemove = true;
    await requests2.pruneEnded(now);
    const rows2 = await store2.readEvents(ARCHIVE_STREAM, { from: 0, to: now + DAY });
    ok(rows2.length === 1, `a record the prune could not remove is archived once across 3 ticks, got ${rows2.length}`);
    ok((await requests2.listAll()).length === 0, 'once removeDoc works the record leaves the live store');
  }

  // ---- exactly-once survives a process restart (fresh store object, same files) ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-archive-'));
  try {
    const opts = { dataDir: tmp, logDir: path.join(tmp, 'logs') };
    const s1 = new FileStore(opts);
    const r1 = mk(s1);
    await seed(s1, 'restart', {});
    // Archive lands, then the "crash": the removeDoc never runs, so the doc is still there.
    ok(await r1.archiveOne(await s1.getDoc(COLLECTION, 'restart'), now - 10 * DAY, now) === true, 'first archive writes the row');

    const r2 = mk(new FileStore(opts)); // fresh process: empty in-memory dedupe cache
    ok(await r2.pruneEnded(now) === 1, 'after restart the surviving record is still pruned');
    const rows = await new FileStore(opts).readEvents(ARCHIVE_STREAM, { from: 0, to: now + DAY });
    ok(rows.length === 1, `restart re-reads the archive and does not write a second row, got ${rows.length}`);

    const files = fs.readdirSync(path.join(tmp, 'logs'));
    ok(files.length === 1 && /^priceRequestArchive-\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]),
      `archive is a day-partitioned jsonl beside the bids stream, got ${files.join(',')}`);
    const raw = fs.readFileSync(path.join(tmp, 'logs', files[0]), 'utf8');
    ok(raw.endsWith('\n') && raw.trim().split('\n').length === 1, 'one newline-terminated JSON line per record');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- an archive-write failure must not break the prune or crash the tick ----
  {
    const store = createStore({ backend: 'memory' });
    const logs = [];
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, log: (m) => logs.push(m) });
    await seed(store, 'boom', {});
    await seed(store, 'boom2', {});
    store.appendEventAsync = async () => { throw new Error('ENOSPC: no space left on device'); };

    let removed = null;
    try { removed = await requests.pruneEnded(now); } catch (e) { ok(false, `prune threw on an archive failure: ${e.message}`); }
    ok(removed === 2, `prune still removed both records with the archive broken, got ${removed}`);
    ok((await requests.listAll()).length === 0, 'live store is still bounded when the archive cannot be written');
    ok(logs.some((m) => m.includes('ARCHIVE FAILED') && m.includes('ENOSPC')), 'the failure is logged loudly, with the reason');
    ok(logs.some((m) => m.includes('2 NOT archived')), 'the prune summary reports how many records were lost');
  }

  // ---- a broken dedupe seed is also survivable ----
  {
    const store = createStore({ backend: 'memory' });
    const requests = mk(store);
    await seed(store, 'seedfail', {});
    store.readEvents = async () => { throw new Error('EACCES'); };
    ok(await requests.pruneEnded(now) === 1, 'prune survives an unreadable archive');
  }

  // Completion sentinel: the runner grades by exit code only, so an early return or an unref'd
  // timer would otherwise score a zero-assertion run as a pass.
  if (pass < 20) { console.error(`  FAIL - only ${pass} assertions ran; the file did not reach the end`); fail += 1; }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
