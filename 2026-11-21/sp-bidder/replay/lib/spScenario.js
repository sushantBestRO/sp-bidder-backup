'use strict';
/**
 * SuperProcure scenario builder — real loads, declared parameters, scripted extension depth.
 *
 * A NAMING DISTINCTION THAT MATTERS, AND IS LOAD-BEARING FOR HOW RESULTS MAY BE READ:
 *
 *   GoComet auctions here are `reconstructed-timeline` — every extension in them WAS OBSERVED,
 *   rebuilt from BRL's own recorded bids. The clock movement is real history.
 *
 *   SuperProcure auctions here are `declared-parameter-scenario` — the load fields are real (a
 *   genuine 2026-07-13 OPEN-tab capture of 58 loads across 20 branch cells), but there is NO
 *   recorded per-tick SP timeline anywhere on this laptop. The capture is a single snapshot. So
 *   extension ROUNDS are scripted by the caller, not observed, and every SP result must be read as
 *   "given this real load's own declared close parameters and N rounds, the engine did X" — never
 *   as "this is what happened on 13 July".
 *
 * Neither kind can yield a counterfactual win rate or clearing price. SP masks external competitor
 * amounts entirely (`bidDetails` on the capture contains only Best Roadways Limited, verified: 8 of
 * 8 rows), and the GoComet logs are BRL's own bot's output. Nothing here estimates a rival's price.
 */

// Repo-wide plausibility bound on a parsed close/open time. SuperProcure ships a year-2100
// placeholder that parses as a valid Date, so a Number.isFinite check misses it (fix #58,
// 60db7080). The canonical constant is declared per platform file — src/platform/realAdapter.js:62
// and src/platform/gocometAdapter.js:53 — as `30 * 86_400_000`; declared locally here so the pure
// scenario builder does not have to pull the whole adapter require-graph into replay/ and CI.
const MAX_PLAUSIBLE_DEADLINE_MS = 30 * 86_400_000; // +30 days

/** SuperProcure encodes durations as 'HH:MM:SS'. Returns seconds, or 0 when absent/unparseable. */
function parseHMS(v) {
  if (typeof v !== 'string') return 0;
  const m = v.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read the close model a single SP load DECLARES.
 *
 * Three fields govern it and they can disagree:
 *   branchAuctionExtendTime   'HH:MM:SS' — how far each extension pushes the close
 *   branchExtendAuction       0|1        — whether extension is switched on at all
 *   branchExtendAuctionCount  N          — how many extensions are permitted
 *
 * `extendTimeSetButExtensionOff` flags the disagreement: a non-zero extend TIME on a load whose
 * extension is switched OFF. Those loads look soft-close to any check that reads the extend time
 * alone, and hard-close to the platform. The capture contains 4 such loads.
 */
function readCloseModel(load) {
  const extendSeconds = parseHMS(load.branchAuctionExtendTime);
  const extendEnabled = num(load.branchExtendAuction) === 1;
  const extendCount = num(load.branchExtendAuctionCount);
  const triggerWindowSec = num(load.branchAuctionRemainingTime);
  return {
    extendSeconds,
    extendEnabled,
    extendCount,
    triggerWindowSec,
    // What the PLATFORM will actually do.
    actuallySoftCloses: extendSeconds > 0 && extendEnabled && (extendCount == null || extendCount > 0),
    // What a check that reads only branchAuctionExtendTime concludes.
    softByExtendTimeAlone: extendSeconds > 0,
    extendTimeSetButExtensionOff: extendSeconds > 0 && !extendEnabled,
  };
}

/**
 * Build a replayable scenario from one real SP load.
 *
 * @param {object} load           a raw load object from the 2026-07-13 capture
 * @param {object} opts
 *   opts.extensionRounds  how many extension rounds actually fire (default: the declared cap when
 *                         extension is genuinely enabled, else 0). Scripted, never observed.
 *   opts.tickMs           observation cadence (default 1000). Deterministic.
 */
function buildSpScenario(load, opts = {}) {
  const cm = readCloseModel(load);
  const openMs = Date.parse(load.biddingStartTime);
  const postedCloseMs = Date.parse(load.biddingCloseTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(postedCloseMs)) return null;
  // Reject a placeholder window: an inverted window (open at/after close) or an implausibly wide one
  // (SP's year-2100 placeholder blows past the +30-day bound). Both parse as valid Dates but are not
  // real auctions; return null so run-replay excludes them — exactly as it does an unparseable
  // window — rather than materialising a multi-million-tick schedule or reporting false silence.
  if (postedCloseMs <= openMs || postedCloseMs - openMs > MAX_PLAUSIBLE_DEADLINE_MS) return null;

  // A load the platform genuinely soft-closes but whose extension COUNT is unknown (extendCount
  // null) cannot be scripted to a definite depth. `cap` falls to 0 for that case, so `rounds` is 0
  // even though the census labels the load SOFT. Flag it so run-replay surfaces the mismatch instead
  // of silently replaying a SOFT-labelled load as hard-close.
  const capUnknown = cm.actuallySoftCloses && cm.extendCount == null && opts.extensionRounds == null;
  const cap = cm.extendCount == null ? 0 : cm.extendCount;
  const rounds = opts.extensionRounds != null
    ? opts.extensionRounds
    : (cm.actuallySoftCloses ? cap : 0);
  const tickMs = opts.tickMs || 1000;

  // Each scripted round pushes the close out by the declared extend time. Rounds fire inside the
  // trigger window, so each one lands at (current close - triggerWindow/2) — a deterministic
  // stand-in for "a late bid arrived", never a claim about who bid or at what price.
  const triggerWindowMs = (cm.triggerWindowSec || 0) * 1000;
  const extensions = [];
  let closeMs = postedCloseMs;
  for (let i = 0; i < rounds; i++) {
    const firedAt = closeMs - Math.max(1000, Math.floor(triggerWindowMs / 2));
    const to = closeMs + cm.extendSeconds * 1000;
    extensions.push({ atMs: firedAt, fromMs: closeMs, toMs: to, slideSec: cm.extendSeconds, impliedRounds: 1, onGrid: true, gridErrSec: 0 });
    closeMs = to;
  }

  return {
    kind: 'declared-parameter-scenario',
    platform: 'superprocure',
    scenarioId: `sp-${load.id}-x${rounds}`,
    loadId: load.id,
    loadCode: load.loadCode || null,
    companyName: load.companyName || null,
    branchName: load.branchName || null,
    openMs,
    postedCloseMs,
    originalCloseMs: postedCloseMs,
    finalCloseMs: closeMs,
    tickMs,
    extensions,
    observedSlides: 0,           // nothing was OBSERVED on SP; these rounds are scripted
    scriptedRounds: rounds,
    capUnknown,                  // SOFT on the platform but extension count unknown -> scripted 0 rounds
    closeModel: cm,
    limits: {
      revisionLimit: num(load.branchBidCountAllowed) || num(load.loadBidCountAllowed) || null,
      minDecrement: num(load.loadBidDifference) || num(load.loadMinBid) || null,
      bidDifferenceLogic: load.loadBidDifferenceLogic || null,
      ceilingPrice: num(load.ceilingPrice),
      laneFreightFTL: num(load.loadAvgLaneFreightFTL),
      laneFreightPMT: num(load.loadAvgLaneFreightPMT),
      units: num(load.vehicleCount) || 1,
      weight: num(load.weight),
      rateBasis: load.rateBasis || null,
    },
    biddingOn: num(load.biddingOn),
    ourBids: [],
  };
}

/**
 * Census of the capture, one row per DISTINCT CLOSE CONFIGURATION.
 *
 * Grouping by company alone is wrong and hides the finding: a single customer can carry several
 * different close configurations across its branches. Ashirvad in the 2026-07-13 capture has 20
 * loads at extendTime 0 AND 4 loads at extendTime 60s, both with extension switched off — collapse
 * those into one company row and the 4 anomalous loads vanish behind the majority's settings.
 * The group key is therefore the full close configuration, not the name.
 */
function censusByCloseModel(loads) {
  const byKey = new Map();
  for (const L of loads) {
    const cm = readCloseModel(L);
    const co = L.companyName || '(unknown)';
    const key = [co, cm.extendSeconds, cm.extendEnabled ? 1 : 0, String(cm.extendCount), String(cm.triggerWindowSec)].join('|');
    if (!byKey.has(key)) {
      byKey.set(key, {
        company: co, loads: 0, branches: new Set(),
        extendSeconds: cm.extendSeconds,
        extendEnabled: cm.extendEnabled,
        extendCount: cm.extendCount,
        triggerWindowSec: cm.triggerWindowSec,
        actuallySoftCloses: cm.actuallySoftCloses,
        softByExtendTimeAlone: cm.softByExtendTimeAlone,
        extendTimeSetButExtensionOff: cm.extendTimeSetButExtensionOff,
        loadIds: [],
      });
    }
    const e = byKey.get(key);
    e.loads += 1;
    e.branches.add(L.branchName || '(none)');
    e.loadIds.push(L.id);
  }
  return [...byKey.values()]
    .map((e) => Object.assign({}, e, { branches: e.branches.size, loadIds: e.loadIds.sort((a, b) => a - b) }))
    .sort((a, b) => (a.company < b.company ? -1 : a.company > b.company ? 1
      : (b.loads - a.loads) || (a.extendSeconds - b.extendSeconds)));
}

module.exports = { parseHMS, readCloseModel, buildSpScenario, censusByCloseModel };
