'use strict';

// T9 final-window walk: its settings and the arithmetic of when a step fits. Pure - no I/O, no clock.

const PLATFORMS = ['sp', 'gocomet'];
const STEP_TIME_SOURCES = ['measured', 'manual'];
// The one system-wide bid-timing preset (owner, 26 Sep): which percentile of the measured step
// samples is the step time, from fastest to surest.
const PERCENTILES = [70, 80, 85, 90, 95];
const DEFAULT_PERCENTILE = 85;
// Landing is a tail: the last step has to land, so its time is read further out.
const LAND_PERCENTILE_LIMITS = { min: 90, max: 99 };
const DEFAULT_LAND_PERCENTILE = 95;

const WALK_LIMITS = {
  stepTimeMs: { min: 500, max: 30_000 },
  landMs: { min: 100, max: 30_000 },
  safetyMarginMs: { min: 0, max: 5_000 },
  maxWalkWindowMs: { min: 5_000, max: 60_000 },
  clockErrorMs: { min: 0, max: 5_000 },
  windowDays: { min: 1, max: 30 },
  minSamples: { min: 10, max: 500 },
};
const PROBE_LEAD_LIMITS = { sp: { min: 2_000, max: 10_000 }, gocomet: { min: 5_000, max: 15_000 } };
// The most clock error the engine ever adds: a published value above it is clamped, and an unpublished
// one on SuperProcure is this. A save is checked against it, so what validates is what runs.
const MAX_CLOCK_ERROR_MS = 1_000;

// What the Settings page calls each field; a refusal names these, never the stored key.
const PORTAL_LABELS = { sp: 'SuperProcure', gocomet: 'GoComet' };
const FIELD_LABELS = {
  enabled: 'Final-window bidding', finalShotWithoutRead: 'Last bid without a fresh read in a confirmed final round',
  stepTimeSource: 'Step time from', stepTimeMs: 'Manual step time', landMs: 'Manual landing time',
  safetyMarginMs: 'Safety margin', maxWalkWindowMs: 'Earliest start', clockErrorMs: 'Clock error',
  windowDays: 'Measured over', minSamples: 'Minimum bids measured', probeLeadMs: 'Early-round check bid',
};
const FIELD_UNITS = { windowDays: 'days', minSamples: 'bids' };

const DEFAULT_WALK = {
  percentile: DEFAULT_PERCENTILE,
  landPercentile: DEFAULT_LAND_PERCENTILE,
  measuredSince: null,
  sp: { enabled: false, stepTimeMs: 1_000, landMs: 1_500, safetyMarginMs: 100, maxWalkWindowMs: 6_000,
    stepTimeSource: 'measured', windowDays: 5, minSamples: 50, probeLeadMs: 4_000 },
  gocomet: { enabled: false, stepTimeMs: 2_500, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 10_000, clockErrorMs: 1_000,
    stepTimeSource: 'measured', windowDays: 5, minSamples: 50, probeLeadMs: 9_000, finalShotWithoutRead: true },
};

const NUMERIC_KEYS = ['stepTimeMs', 'landMs', 'safetyMarginMs', 'maxWalkWindowMs', 'windowDays', 'minSamples'];
const SYSTEM_KEYS = ['percentile', 'landPercentile', 'measuredSince'];
const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (n, { min, max }) => Math.min(max, Math.max(min, n));
const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function numericKeys(platform) {
  return platform === 'gocomet' ? NUMERIC_KEYS.concat('clockErrorMs', 'probeLeadMs') : NUMERIC_KEYS.concat('probeLeadMs');
}
function limitFor(platform, k) {
  return k === 'probeLeadMs' ? PROBE_LEAD_LIMITS[platform] : WALK_LIMITS[k];
}
function booleanKeys(platform) {
  return platform === 'gocomet' ? ['enabled', 'finalShotWithoutRead'] : ['enabled'];
}

/** Field-by-field merge of a partial walk block onto a base; unknown keys are dropped. */
function mergeWalk(base, partial) {
  const out = clone(base || DEFAULT_WALK);
  for (const k of SYSTEM_KEYS) if (out[k] === undefined) out[k] = DEFAULT_WALK[k];
  if (!partial || typeof partial !== 'object') return out;
  for (const k of SYSTEM_KEYS) if (partial[k] !== undefined) out[k] = partial[k];
  for (const p of PLATFORMS) {
    const cur = Object.assign(clone(DEFAULT_WALK[p]), out[p] || {});
    const d = partial[p];
    if (d && typeof d === 'object') {
      for (const k of booleanKeys(p).concat('stepTimeSource', numericKeys(p))) if (d[k] !== undefined) cur[k] = d[k];
    }
    out[p] = cur;
  }
  return out;
}

function worstClockErrorMs(p, c) {
  return p === 'gocomet' ? Math.max(MAX_CLOCK_ERROR_MS, c.clockErrorMs) : MAX_CLOCK_ERROR_MS;
}

// The time the probe's own answer takes (about a step) plus a last step that still lands.
function probeNeedsMs(p, c) {
  return c.stepTimeMs + c.landMs + c.safetyMarginMs + worstClockErrorMs(p, c);
}

function walkLimitsMeta() {
  return Object.assign(clone(WALK_LIMITS), { probeLeadMs: clone(PROBE_LEAD_LIMITS) });
}

/** The Settings save's check: out-of-range values are refused with what to change, never coerced. */
function validateWalk(raw) {
  const w = mergeWalk(DEFAULT_WALK, raw);
  if (!PERCENTILES.includes(w.percentile)) bad(`Bid timing must be one of ${PERCENTILES.slice(0, -1).join(', ')} or ${PERCENTILES[PERCENTILES.length - 1]}.`);
  if (!Number.isInteger(w.landPercentile) || w.landPercentile < LAND_PERCENTILE_LIMITS.min || w.landPercentile > LAND_PERCENTILE_LIMITS.max) {
    bad(`Landing time percentile must be from p${LAND_PERCENTILE_LIMITS.min} to p${LAND_PERCENTILE_LIMITS.max}.`);
  }
  if (w.measuredSince !== null && !(Number.isInteger(w.measuredSince) && w.measuredSince >= 0)) {
    bad('Count bids from must be empty or a date.');
  }
  for (const p of PLATFORMS) {
    const c = w[p];
    const name = (k) => `${PORTAL_LABELS[p]}: ${FIELD_LABELS[k]}`;
    for (const k of booleanKeys(p)) if (typeof c[k] !== 'boolean') bad(`${name(k)} must be on or off.`);
    if (!STEP_TIME_SOURCES.includes(c.stepTimeSource)) bad(`${name('stepTimeSource')} must be measured or manual.`);
    for (const k of numericKeys(p)) {
      const n = typeof c[k] === 'string' && c[k].trim() !== '' ? Number(c[k]) : c[k];
      const lim = limitFor(p, k);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < lim.min || n > lim.max) {
        bad(`${name(k)} must be a whole number from ${lim.min} to ${lim.max} ${FIELD_UNITS[k] || 'ms'}.`);
      }
      c[k] = n;
    }
    const clockMs = worstClockErrorMs(p, c);
    const oneStep = c.landMs + c.safetyMarginMs + clockMs;
    if (oneStep > c.maxWalkWindowMs) {
      bad(`${name('maxWalkWindowMs')} (${c.maxWalkWindowMs} ms) must be at least ${oneStep} ms so the last bid lands: `
        + `Manual landing time + Safety margin + up to ${clockMs} ms of clock error.`);
    }
    const probeNeeds = probeNeedsMs(p, c);
    if (c.probeLeadMs < probeNeeds) {
      bad(`${name('probeLeadMs')} (${c.probeLeadMs} ms) is too short: the check bid's answer (Manual step time) and a last `
        + `bid that lands (Manual landing time + Safety margin + up to ${clockMs} ms of clock error) need ${probeNeeds} ms.`);
    }
  }
  return w;
}

/** The engine's copy: never throws; a value the save validator would refuse falls back to its default. */
function normaliseWalk(raw) {
  const w = mergeWalk(DEFAULT_WALK, raw);
  if (!PERCENTILES.includes(w.percentile)) w.percentile = DEFAULT_PERCENTILE;
  if (!Number.isInteger(w.landPercentile) || w.landPercentile < LAND_PERCENTILE_LIMITS.min || w.landPercentile > LAND_PERCENTILE_LIMITS.max) {
    w.landPercentile = DEFAULT_LAND_PERCENTILE;
  }
  if (!(Number.isInteger(w.measuredSince) && w.measuredSince >= 0)) w.measuredSince = null;
  for (const p of PLATFORMS) {
    const c = w[p];
    c.enabled = c.enabled === true;
    if (p === 'gocomet') c.finalShotWithoutRead = c.finalShotWithoutRead !== false;
    if (!STEP_TIME_SOURCES.includes(c.stepTimeSource)) c.stepTimeSource = DEFAULT_WALK[p].stepTimeSource;
    for (const k of numericKeys(p)) {
      const n = Number(c[k]);
      c[k] = Number.isFinite(n) ? clamp(Math.round(n), limitFor(p, k)) : DEFAULT_WALK[p][k];
    }
  }
  return w;
}

/**
 * The step and landing times in force. Measured values count only from a snapshot computed for the
 * same percentiles, window and measuredSince, holding at least minSamples samples; otherwise the
 * manual step and landing times.
 */
function effectiveTiming(cfg, measured, walk) {
  const manual = { stepTimeMs: cfg.stepTimeMs, landMs: cfg.landMs, source: 'manual' };
  const usable = cfg.stepTimeSource === 'measured' && measured && typeof measured === 'object'
    && measured.percentile === walk.percentile && measured.windowDays === cfg.windowDays
    && (measured.measuredSince == null ? null : measured.measuredSince) === walk.measuredSince
    && finite(measured.n) && measured.n >= cfg.minSamples
    && measured.step && finite(measured.step.atPercentile);
  if (!usable) return manual;
  const landN = finite(measured.landN) ? measured.landN : measured.n;
  const landOk = measured.landPercentile === walk.landPercentile && landN >= cfg.minSamples
    && measured.land && finite(measured.land.atPercentile);
  return {
    stepTimeMs: clamp(Math.round(measured.step.atPercentile), WALK_LIMITS.stepTimeMs),
    landMs: landOk ? clamp(Math.round(measured.land.atPercentile), WALK_LIMITS.landMs) : cfg.landMs,
    source: 'measured',
    landSource: landOk ? 'measured' : 'manual',
  };
}

/** Per platform, the step and landing times the engine is using, each with its source and sample count. */
function effectiveSummary(walk, snapshot) {
  const out = {};
  for (const p of PLATFORMS) {
    const cfg = walk[p];
    const m = snapshot && snapshot[p];
    const eff = effectiveTiming(cfg, m, walk);
    out[p] = {
      stepTimeMs: eff.stepTimeMs, stepSource: eff.source, stepN: m && finite(m.n) ? m.n : 0,
      landMs: eff.landMs, landSource: eff.landSource || 'manual', landN: m ? (finite(m.landN) ? m.landN : (finite(m.n) ? m.n : 0)) : 0,
      minSamples: cfg.minSamples, computedAt: m && finite(m.computedAt) ? m.computedAt : null,
    };
  }
  return out;
}

/**
 * How many steps can still be taken with `remaining` ms left: steps before the last each take
 * stepTimeMs (their rank must come back), the last one only has to land. `slackMs` is one expected
 * tick, so a read landing just after a mark does not lose the step the mark was for.
 */
function stepsThatFit(remaining, t) {
  const avail = remaining - t.safetyMs;
  if (!(avail >= t.landMs)) return 0;
  // At or inside the last step's deadline only the last step is left, whatever the step time.
  if (avail <= t.landMs + t.slackMs) return 1;
  return 1 + Math.floor((avail + t.slackMs - t.landMs) / t.stepTimeMs);
}

/** The most steps maxWalkWindowMs holds, at least one. */
function maxWalkSteps(t) {
  return Math.max(1, 1 + Math.floor((t.maxWalkWindowMs - t.safetyMs - t.landMs) / t.stepTimeMs));
}

/** The walk's start as ms before the close: (steps - 1) x stepTime + land + safety, never earlier than maxWalkWindowMs. */
function walkStartMs(steps, t) {
  return Math.min(t.maxWalkWindowMs, (steps - 1) * t.stepTimeMs + t.landMs + t.safetyMs);
}

/**
 * The countdown by which `steps` steps must start if the rank never comes back (D-C): the last
 * moment they still fit, and for the last step one tick early - unless that step goes on the clock
 * without a read (`noReadSlack`).
 */
function stepDeadlineMs(steps, t, { noReadSlack = false } = {}) {
  const slack = noReadSlack ? 0 : t.slackMs;
  return t.safetyMs + Math.max(t.landMs + slack, (steps - 1) * t.stepTimeMs + t.landMs);
}

/**
 * Which of `count` prices (highest first) the first of `steps` evenly spread steps takes, when the
 * last step is always the lowest. Equals D-A on a three-price band; 19 prices over 5 steps walk every
 * 4th price.
 */
function spreadFirstIndex(count, steps) {
  if (steps >= count) return 0;
  return count - 1 - Math.floor(((steps - 1) * count) / steps);
}

module.exports = { WALK_LIMITS, PROBE_LEAD_LIMITS, LAND_PERCENTILE_LIMITS, DEFAULT_WALK, PLATFORMS, STEP_TIME_SOURCES, PERCENTILES,
  MAX_CLOCK_ERROR_MS, mergeWalk, validateWalk, normaliseWalk, effectiveTiming, effectiveSummary, walkLimitsMeta,
  stepsThatFit, maxWalkSteps, walkStartMs, stepDeadlineMs, spreadFirstIndex };
