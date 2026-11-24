'use strict';

/**
 * backfill-price-request-archive - ONE-OFF. Seed the durable archive from whatever is still in
 * data/priceRequests.json on the day the archive ships. From then on pruneEnded keeps it fed and
 * this script has no further use.
 *
 *   node scripts/backfill-price-request-archive.js              # DRY-RUN (default)
 *   node scripts/backfill-price-request-archive.js --apply
 *   node scripts/backfill-price-request-archive.js --data-dir=./data --expect=1500
 *
 * Only records whose auction has ALREADY ENDED are taken. A still-open one would be frozen here in
 * a pre-close state and the dedupe would then stop pruneEnded ever writing its real, final row -
 * the prune will archive it correctly in its own time. Writes through PriceRequestStore.archiveOne,
 * so re-running is a no-op and a row the prune already wrote is never duplicated.
 *
 * Reads and appends only. The live priceRequests collection is not touched: this recovers the
 * ~7-day window that would otherwise be pruned away, it does not change retention.
 */

const path = require('path');
const { FileStore } = require('../src/store');
const { PriceRequestStore, COLLECTION, ARCHIVE_STREAM, effectiveCloseAt } = require('../src/pricing/priceRequests');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dataDir = (args.find((a) => a.startsWith('--data-dir=')) || '').split('=')[1] || path.join(__dirname, '..', 'data');
const expect = Number((args.find((a) => a.startsWith('--expect=')) || '').split('=')[1]);

(async () => {
  const store = new FileStore({ dataDir, logDir: path.join(dataDir, 'logs') });
  const requests = new PriceRequestStore({ store, marginsPct: [], minMarginPct: 0, log: (m) => console.log(m) });
  const now = Date.now();

  const all = await store.listDocs(COLLECTION);
  const already = new Set((await store.readEvents(ARCHIVE_STREAM, { from: 0 })).map((r) => r.id));

  const eligible = [];
  let open = 0, unageable = 0, dup = 0;
  for (const r of all) {
    const endedAt = effectiveCloseAt(r.load) || r.createdAt;
    if (endedAt == null) { unageable += 1; continue; }
    if (endedAt > now) { open += 1; continue; }
    if (already.has(r.id)) { dup += 1; continue; }
    eligible.push({ r, endedAt });
  }

  console.log(`[backfill] ${dataDir}`);
  console.log(`[backfill] ${all.length} live request(s): ${eligible.length} to archive, ${open} still open (left for the prune), ${unageable} with no usable time, ${dup} already archived`);
  if (Number.isFinite(expect) && expect !== eligible.length) {
    console.error(`[backfill] REFUSING: expected ${expect} record(s), found ${eligible.length}`);
    process.exit(2);
  }
  if (!apply) {
    console.log('[backfill] dry run - nothing written. Re-run with --apply.');
    process.exit(0);
  }

  let written = 0, failed = 0;
  for (const { r, endedAt } of eligible) {
    try { if (await requests.archiveOne(r, endedAt, now)) written += 1; } catch (err) { failed += 1; console.error(`[backfill] FAILED ${r.loadId}: ${err && err.message}`); }
  }
  console.log(`[backfill] wrote ${written} row(s), ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('[backfill] crashed:', e); process.exit(1); });
