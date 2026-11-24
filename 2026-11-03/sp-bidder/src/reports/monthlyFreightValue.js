'use strict';

const { platformOf, effectiveCloseAt, ARCHIVE_STREAM } = require('../pricing/priceRequests');
const { reportedCloseAt } = require('../util/reportedClose');
const { isTruckBasis, loadKey } = require('../notify/eodReport');
const { istMonthStamp } = require('../notify/dailyTask');
const config = require('../config');

/**
 * BC-28 / CW-241: freight value Bid Command has handled, month by month since launch, on the
 * ALL-LOADS basis Sid set 24 Sep - every discovered load counts toward "enquiries", not only the
 * ones we bid on or won (the earlier #233 fix only reached the participated-loads basis).
 *
 * BASIS (truck vs PMT), tri-state, never guessed. `resolveQuoteType` prefers the live/archived
 * request's own `load.quoteType` (freshest) and falls back to `doc.quoteType`, now carried onto
 * closedBids at arm time (bidEngine's emit -> bidLogger._onArmed) for exactly this reason: a
 * closedBids-only row (its price request long pruned, no archive row either - true for every
 * record older than the 2026-09-25 archive stream) used to have NO way to tell a 3-truck FTL load
 * from a per-tonne one, and always fell through to "unknown", which the old code treated as PMT.
 * `null` means genuinely unrecorded on every source this row has - never coerced to a guess.
 *
 * Per-load value, in priority order:
 *   1. OUR RATE - the final bid we actually placed (closedBids.lastBidPrice), whether the load was
 *      won or lost. On a known truck basis, scaled by the record's own unit count (doc.units, else
 *      the discovered load's own units - never a bare 1 once a real count exists anywhere). On a
 *      known PMT basis, the rate alone (a per-tonne figure is already the whole per-unit price,
 *      never multiplied by a tonnage quantity). On an UNKNOWN basis: no value, rather than the old
 *      silent fall-through to "PMT-shaped", which understated every multi-truck load whose record
 *      predates quoteType being carried onto closedBids.
 *   2. LANE AVERAGE - SuperProcure's own published lane-freight anchor, for a load with no rate of
 *      ours (never priced, or armed and then never actually bid). `loadAvgLaneFreightFTL` is a
 *      PER-VEHICLE figure (proven: a real SP capture's FTL/PMT ratio equals its weight/vehicleCount
 *      ratio), so it is scaled by the same resolved unit count as the our-rate path; `PMT` is used
 *      as-is, matching the our-rate PMT treatment. An UNKNOWN basis skips the anchor entirely - the
 *      old code defaulted every unknown-basis row to the PMT anchor unscaled, which is wrong in
 *      both directions (a real PMT figure understated if the anchor is genuinely per-vehicle, and a
 *      truck load's whole-fleet value collapsed to one vehicle's rate if it is not).
 *   3. NO VALUE - neither exists, or the basis needed to use what exists is unknown. The load still
 *      counts in `enquiries`; it is named in `noValueLoads` rather than silently dropped or
 *      defaulted to 0.
 *
 * COVERAGE. Only closedBids reaches back to launch. priceRequestArchive exists only from
 * 2026-09-25 (v2.15.0), backfilled just once from whatever the live ~7-day priceRequests store
 * still held at that moment - so a month entirely before the archive's earliest row has no source
 * for a load that was discovered and never armed; only armed loads survive for it, via closedBids.
 * `collectSinceLaunch` computes `allLoadsFrom` as the earliest date among the archive rows it
 * actually loaded (the row's own `endedAt`, not the day-FILE's name - archive files are written
 * ~7 days after an auction ends, so the file dated 2026-09-25 already holds rows reaching back to
 * roughly 2026-09-18). `buildMonthlyReport` marks a month `complete` only when it falls entirely
 * after `allLoadsFrom`'s own month; the archive-start month itself, and everything before it, is
 * `partial` - every discovered-but-never-armed load in that stretch is invisible forever, and nothing
 * in this report can recover it. This is a statement about what the DATA covers, not a second
 * counting rule: a partial month's rows are exactly whatever collectSinceLaunch could find for it,
 * unchanged - closedBids-only, because that is genuinely all there is.
 */

// The truck/PMT basis, preferring the freshest source. Returns the raw uppercased quoteType
// string, or null when neither `load` nor `doc` has ever recorded one - the caller decides what
// "unknown" means for its own branch; this function never guesses a default.
function resolveQuoteType(load, doc) {
  const fromLoad = load && load.quoteType != null && load.quoteType !== '' ? String(load.quoteType).trim().toUpperCase() : '';
  if (fromLoad) return fromLoad;
  const fromDoc = doc && doc.quoteType != null && doc.quoteType !== '' ? String(doc.quoteType).trim().toUpperCase() : '';
  return fromDoc || null;
}

// The unit count to scale a per-vehicle figure by, on a known truck basis: the record's own bid
// (doc.units - the count actually armed/bid, most precise when it exists) else the discovered
// load's own nominal count (load.units - SP's vehicleCount, mandatory on every listing, so this is
// the right fallback for a load that was never armed at all). null when neither carries a usable
// positive number - the caller must not fall back to a bare 1, which is a guess in the same
// direction the old code's bug already proved costly.
function resolveUnits(load, doc) {
  const fromDoc = doc ? Number(doc.units) : NaN;
  if (Number.isFinite(fromDoc) && fromDoc > 0) return fromDoc;
  const fromLoad = load ? Number(load.units) : NaN;
  if (Number.isFinite(fromLoad) && fromLoad > 0) return fromLoad;
  return null;
}

function valueForLoad({ load, doc, platformKey } = {}) {
  const quoteType = resolveQuoteType(load, doc);
  // null (genuinely unrecorded) is its own state - isTruckBasis would coerce it to false, which is
  // exactly the "unknown treated as PMT" bug this rewrite fixes, so it is not reused here.
  // GoComet has no per-tonne basis, so an unrecorded one there is per truck.
  const truckBasis = quoteType != null ? quoteType !== 'PMT' : (platformKey === config.gocomet.platformKey ? true : null);

  if (doc && Array.isArray(doc.ourBids) && doc.ourBids.length) {
    const bid = Number(doc.lastBidPrice);
    if (Number.isFinite(bid)) {
      if (truckBasis === false) return { value: bid, source: 'our_rate' };
      const units = resolveUnits(load, doc);
      if (truckBasis === true && units != null) return { value: bid * units, source: 'our_rate' };
      // Unknown basis on a single unit (or no count at all): per truck and per tonne give the same number.
      if (truckBasis === null && (units == null || units <= 1)) return { value: bid, source: 'our_rate' };
      // truckBasis === true with no usable unit count, or truckBasis === null (unknown
      // altogether): fall through to no value rather than fabricate a count or a basis.
      return { value: null, source: 'none' };
    }
  }

  if (truckBasis != null) {
    const anchor = (load && load.laneFreight) || (doc && doc.laneFreight) || null;
    if (anchor) {
      if (truckBasis) {
        const rate = Number.isFinite(Number(anchor.ftl)) && Number(anchor.ftl) > 0 ? Number(anchor.ftl) : null;
        const units = resolveUnits(load, doc);
        if (rate != null && units != null) return { value: rate * units, source: 'lane_average' };
      } else {
        const rate = Number.isFinite(Number(anchor.pmt)) && Number(anchor.pmt) > 0 ? Number(anchor.pmt) : null;
        if (rate != null) return { value: rate, source: 'lane_average' };
      }
    }
  }
  return { value: null, source: 'none' };
}

/**
 * Group already-merged load rows into one bucket per IST calendar month.
 * `rows`: [{ loadId, platformKey, anchorAt, load, doc }] - anchorAt is the epoch ms the row is
 * dated by (the auction's own close, same field the console's History page sorts on); a row with
 * no anchorAt cannot be placed in a month and is skipped rather than guessed into one.
 * `allLoadsFrom`: epoch ms of the earliest load the archive actually covers (collectSinceLaunch
 * computes this), or null when no archive data exists at all - every month is then `partial`.
 */
function buildMonthlyReport(rows, { allLoadsFrom = null } = {}) {
  const archiveStartMonth = allLoadsFrom != null ? istMonthStamp(allLoadsFrom) : null;
  const byMonth = new Map();
  for (const row of rows || []) {
    if (!row || row.anchorAt == null) continue;
    const month = istMonthStamp(row.anchorAt);
    if (!byMonth.has(month)) {
      byMonth.set(month, {
        month,
        // A full calendar month strictly AFTER the archive-start month is complete: everything
        // discovered in it either is still in the live ~7-day store or has already been archived,
        // by construction of collectSinceLaunch's two sources. The archive-start month itself is
        // only complete from allLoadsFrom onward within it, so it is conservatively 'partial' too.
        complete: archiveStartMonth != null && month > archiveStartMonth,
        enquiries: 0, freightValueRs: 0, ourRateLoads: 0, laneAverageLoads: 0, noValueLoads: [],
      });
    }
    const bucket = byMonth.get(month);
    bucket.enquiries += 1;
    const { value, source } = valueForLoad(row);
    if (value != null) {
      bucket.freightValueRs += value;
      if (source === 'our_rate') bucket.ourRateLoads += 1;
      else bucket.laneAverageLoads += 1;
    } else {
      bucket.noValueLoads.push({ loadId: row.loadId, platformKey: row.platformKey });
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Merge the three stores into one row per load, keyed by (platform, loadId) so a load that
 * appears in more than one source (a still-live request that has also closed, say) is counted
 * once. Sources, per CW-241: closedBids (full history, never pruned) for the load's own rate;
 * priceRequestArchive + the live priceRequests store for every OTHER discovered load, priced or
 * not, so "enquiries" is not silently capped at the ~7-day request-store window.
 *
 * The archive read is bounded to days the stream actually has a file for (store.listStreamDays -
 * ONE async directory listing), never `from: 0`: readEvents' day-loop probes one file per day in
 * range with synchronous existsSync/readFileSync, and epoch 0 to now is ~20,700 empty probes on a
 * stream that has existed for a few weeks - hundreds of milliseconds on the process that also runs
 * the bid engine's own timers, for an endpoint a page load can trigger.
 */
async function collectSinceLaunch({ requests, bidLogger }) {
  const archiveDays = await requests.store.listStreamDays(ARCHIVE_STREAM);
  const [liveReqs, archiveRows, closedDocs] = await Promise.all([
    requests.listAll(),
    archiveDays.length
      ? requests.store.readEvents(ARCHIVE_STREAM, { from: archiveDays[0], to: archiveDays[archiveDays.length - 1] + 86_399_999 })
      : Promise.resolve([]),
    bidLogger.listClosed({}),
  ]);

  const byKey = new Map();
  const rowFor = (key) => {
    if (!byKey.has(key)) byKey.set(key, { loadId: null, platformKey: null, anchorAt: null, load: null, doc: null });
    return byKey.get(key);
  };

  for (const r of (liveReqs || [])) {
    if (!r) continue;
    const row = rowFor(loadKey(r, r.loadId));
    row.loadId = r.loadId;
    row.platformKey = platformOf(r);
    row.load = r.load || row.load;
    const anchor = effectiveCloseAt(r.load) || r.createdAt || null;
    if (anchor != null) row.anchorAt = anchor;
  }

  // The earliest date any archive row actually covers - by the row's own endedAt (the auction it
  // describes), never the day-FILE's write-time name (archive files are written ~7 days after an
  // auction ends, so a file dated 2026-09-25 already holds rows reaching back to ~2026-09-18).
  let allLoadsFrom = null;
  for (const a of (archiveRows || [])) {
    if (!a) continue;
    const row = rowFor(loadKey(a, a.loadId));
    row.loadId = row.loadId || a.loadId;
    row.platformKey = row.platformKey || platformOf(a);
    // The archive row's own fields (quoteType, units, weight, ...) mirror `load`'s field names -
    // it can stand in as `load` directly wherever the live snapshot is gone. It never carries
    // laneFreight (see the module doc), so a fallback to it can only ever supply the truck-basis
    // check, never a lane-average value.
    if (!row.load) row.load = a;
    const at = a.endedAt != null ? a.endedAt : a.createdAt;
    if (row.anchorAt == null) row.anchorAt = at;
    if (at != null && (allLoadsFrom == null || at < allLoadsFrom)) allLoadsFrom = at;
  }

  for (const c of (closedDocs || [])) {
    if (!c) continue;
    const row = rowFor(loadKey(c, c.auctionId));
    row.loadId = row.loadId || c.auctionId;
    row.platformKey = row.platformKey || platformOf(c);
    row.doc = c;
    if (row.anchorAt == null) row.anchorAt = reportedCloseAt(c) || c.closedAt || null;
  }

  return { rows: [...byKey.values()], allLoadsFrom };
}

module.exports = { valueForLoad, buildMonthlyReport, collectSinceLaunch };
