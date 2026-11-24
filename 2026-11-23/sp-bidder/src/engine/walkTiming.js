'use strict';

// The walk's measured step and landing times, from the P6 stamps on every bid in closedBids.

const COLLECTION = 'walkTiming';
const KEY = 'current';
const FINAL_WINDOW_MS = 60_000;
const DAY_MS = 86_400_000;
const PLATFORMS = ['sp', 'gocomet'];

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Nearest-rank percentile of `values` (unsorted, not mutated); null for no values. */
function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarise(values, p) {
  return { p50: percentile(values, 50), p85: percentile(values, 85), p95: percentile(values, 95), p99: percentile(values, 99),
    atPercentile: percentile(values, p) };
}

/**
 * Per platform: step = rankVisibleAt - decidedAt and land = writeLandedAt - decidedAt, over bids decided
 * within FINAL_WINDOW_MS of their close, inside that platform's windowDays and at or after
 * walk.measuredSince. Step is read at walk.percentile, land at walk.landPercentile. `platformOf(record)`
 * answers 'sp' or 'gocomet'.
 */
function computeWalkTiming(records, walk, { nowMs, platformOf }) {
  const samples = { sp: { step: [], land: [] }, gocomet: { step: [], land: [] } };
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !Array.isArray(rec.ourBids)) continue;
    const p = platformOf(rec) === 'gocomet' ? 'gocomet' : 'sp';
    const since = Math.max(nowMs - ((walk[p] && walk[p].windowDays) || 0) * DAY_MS,
      Number.isFinite(walk.measuredSince) ? walk.measuredSince : -Infinity);
    for (const b of rec.ourBids) {
      if (!b || !finite(b.decidedAt) || b.decidedAt < since || b.decidedAt > nowMs) continue;
      if (!finite(b.closesInMs) || b.closesInMs <= 0 || b.closesInMs > FINAL_WINDOW_MS) continue;
      if (finite(b.writeLandedAt) && b.writeLandedAt >= b.decidedAt) samples[p].land.push(b.writeLandedAt - b.decidedAt);
      if (finite(b.rankVisibleAt) && b.rankVisibleAt >= b.decidedAt) samples[p].step.push(b.rankVisibleAt - b.decidedAt);
    }
  }
  const out = {};
  const pct = walk.percentile;
  const landPct = walk.landPercentile;
  for (const p of PLATFORMS) {
    const cfg = walk[p] || {};
    const s = samples[p];
    out[p] = {
      n: s.step.length, landN: s.land.length, windowDays: cfg.windowDays, percentile: pct, landPercentile: landPct,
      measuredSince: Number.isFinite(walk.measuredSince) ? walk.measuredSince : null, minSamples: cfg.minSamples,
      step: summarise(s.step, pct), land: summarise(s.land, landPct), computedAt: nowMs,
      source: s.step.length >= cfg.minSamples ? 'measured' : 'fallback-insufficient-samples',
    };
  }
  return out;
}

function wellFormed(doc) {
  if (!doc || typeof doc !== 'object') return false;
  return PLATFORMS.some((p) => doc[p] && typeof doc[p] === 'object')
    && PLATFORMS.every((p) => doc[p] == null || (typeof doc[p] === 'object' && finite(doc[p].n)
      && doc[p].step && typeof doc[p].step === 'object'));
}

/**
 * The saved snapshot, or null - one warn - when the file is missing, unreadable or malformed, so the
 * walk runs on its manual step time until the next computation lands.
 */
async function loadWalkTiming(store, log) {
  let doc = null;
  let why = null;
  try {
    doc = await store.getDoc(COLLECTION, KEY);
    const corrupt = typeof store.takeCorrupt === 'function' && store.takeCorrupt(COLLECTION);
    if (doc == null && corrupt) why = 'walk timing file was corrupt; using manual times';
    else if (doc == null) why = 'no saved walk timing; the walk uses its manual times until the next computation';
    else if (!wellFormed(doc)) why = 'the saved walk timing is malformed; the walk uses its manual times until the next computation';
  } catch (e) {
    why = `the saved walk timing could not be read (${e && e.message}); the walk uses its manual times until the next computation`;
  }
  if (why) {
    if (log) log.warn(why, { collection: COLLECTION });
    return null;
  }
  return doc;
}

async function saveWalkTiming(store, doc) {
  await store.putDoc(COLLECTION, KEY, doc);
  return doc;
}

module.exports = { COLLECTION, KEY, FINAL_WINDOW_MS, percentile, computeWalkTiming, loadWalkTiming, saveWalkTiming };
