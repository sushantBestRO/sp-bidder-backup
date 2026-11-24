'use strict';

/**
 * Server-clock offset normalisation, shared by the two SuperProcure clock surfaces: realAdapter's
 * getAvailableViews `currentTime` (REST) and spSocket's `current` heartbeat (live). Both feed a
 * serverNow() that snipe timing and the year-2100 placeholder guard read off, so the two must not
 * drift apart - and they were hand-copied line-for-line, magic numbers included, because spSocket
 * cannot require realAdapter (realAdapter requires spSocket). A third neutral module has no such
 * cycle, which is the same shape src/util/redactToken.js and src/util/tokenMatch.js already take.
 *
 * No require of either caller, no logging, no clock reads: the functions are pure, and the one
 * stateful piece, ServerClockEstimator, is handed every timestamp it uses. A refusal returns a
 * reason and leaves the decision to the caller - the previous offset is always a better estimate
 * than one derived from a frame that was just refused.
 */

// Below this a Unix timestamp is SECONDS, not milliseconds (1e12 ms is 2001-09-09, while a
// seconds-epoch value stays four orders of magnitude smaller for the next thirty millennia).
const SECONDS_EPOCH_CEILING = 1e12;

// The largest local-vs-server divergence accepted as a real clock reading rather than a bad frame.
const MAX_CLOCK_SKEW_MS = 90_000;

/**
 * -> {ok:true, offsetMs} | {ok:false, reason:'unusable'} | {ok:false, reason:'skew', offsetMs}
 *
 * 'unusable' is every shape that cannot be a timestamp at all - non-numeric, NaN, Infinity, zero or
 * negative (Number([]) is 0, Number({}) is NaN, and a date STRING is NaN). 'skew' is a well-formed
 * time too far from nowMs to believe. Callers diagnose those two differently, so they are separate
 * reasons rather than one bare false.
 */
function normalizeServerOffset(rawTime, nowMs, maxSkewMs = MAX_CLOCK_SKEW_MS) {
  let t = Number(rawTime);
  if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: 'unusable' };
  if (t < SECONDS_EPOCH_CEILING) t = t * 1000;
  const offsetMs = t - nowMs;
  if (Math.abs(offsetMs) >= maxSkewMs) return { ok: false, reason: 'skew', offsetMs };
  return { ok: true, offsetMs };
}

// A whole-second reading (REST getAvailableViews.currentTime is one) says only that the server was
// somewhere inside that second, so it is worth its midpoint, +/- half a second.
function readingResolutionMs(rawTime) {
  const t = Number(rawTime);
  return t < SECONDS_EPOCH_CEILING && Number.isInteger(t) ? 1000 : 0;
}

/**
 * Offset from a reading taken inside a request/response round trip: the server stamped it somewhere
 * between sentAt and receivedAt, so it is read against their midpoint.
 * -> normalizeServerOffset's refusals, or {ok:true, offsetMs, errorMs}.
 */
function roundTripServerOffset(rawTime, sentAt, receivedAt, maxSkewMs = MAX_CLOCK_SKEW_MS) {
  const r = normalizeServerOffset(rawTime, (sentAt + receivedAt) / 2, maxSkewMs);
  if (!r.ok) return r;
  const resolutionMs = readingResolutionMs(rawTime);
  return { ok: true, offsetMs: Math.round(r.offsetMs + resolutionMs / 2),
    errorMs: Math.ceil((resolutionMs + receivedAt - sentAt) / 2) };
}

const CLOCK_WINDOW_MS = 300_000;
const MAX_CLOCK_SAMPLES = 64;
const MAX_ROUND_TRIPS = 64;
// A sample this far above the estimate is held until a second one agrees with it: a real change in
// either clock repeats on the next heartbeat, a wrong reading does not. Only while the estimate has
// RISE_GUARD_SUPPORT agreeing samples behind it - one resting on fewer is as likely to be the late
// one (the first heartbeat after a restart or an outage), and the punctual reading must replace it.
const UNCONFIRMED_RISE_MS = 1_000;
const RISE_GUARD_SUPPORT = 3;
// The other direction: this many heartbeats in a row more than UNCONFIRMED_RISE_MS below the estimate
// is a clock change, not delay (in the replay below, the best of any six consecutive heartbeats was
// never more than 328 ms late), so the older, higher samples are dropped instead of aging out.
const DROP_CONFIRM_SAMPLES = 6;
// Delay still left in the best of the last n heartbeats: p99.9 against the best of the surrounding
// ten minutes, over ~1,600 heartbeats replayed from the production box's per-tick countdowns
// (1-24 Sep 2026). Index n-1; the last entry covers every larger n.
const RESIDUAL_MS_BY_SAMPLES = [6_750, 3_100, 1_250, 600, 350, 350, 350, 200, 200, 200, 50];
const DRIFT_PPM = 100;

/**
 * The server clock as a set of one-way samples (server stamp minus local receipt). A sample can only
 * ever arrive late, never early, so each one under-reads the offset by its own delay: the estimate is
 * the highest sample of the last CLOCK_WINDOW_MS (a minimum-delay filter), corrected by half the
 * smallest measured round trip to the same host for the transit that even the best sample carries.
 * The window is anchored at the newest sample, so when samples stop arriving the estimate is kept and
 * only its error grows.
 *
 * errorMs bounds |estimate - true offset|: half the round trip (the path may be asymmetric), half the
 * reading's resolution, the delay that may remain in the best of n samples, clock drift since it, and
 * the readings the rules above set aside - a held rise, or a drop taken as a clock change - since
 * either could be the truth.
 */
class ServerClockEstimator {
  constructor({ windowMs = CLOCK_WINDOW_MS, assumedRttMs = 200 } = {}) {
    this.windowMs = windowMs;
    this.assumedRttMs = assumedRttMs;
    this.samples = [];
    this.roundTrips = [];
    this._carried = null;
    this._drop = null;
  }

  addSample(offsetMs, atMs, resolutionMs = 0) {
    const s = { offsetMs: offsetMs + resolutionMs / 2, atMs, resolutionMs, confirmed: true };
    this.samples = this.samples.filter((o) => o.atMs > atMs - this.windowMs);
    const best = this._best();
    if (best && s.offsetMs > best.offsetMs + UNCONFIRMED_RISE_MS && this._support(best) >= RISE_GUARD_SUPPORT) {
      const twin = this.samples.find((o) => !o.confirmed && Math.abs(o.offsetMs - s.offsetMs) <= UNCONFIRMED_RISE_MS);
      if (twin) twin.confirmed = true;
      else s.confirmed = false;
    }
    this.samples.push(s);
    this.samples = this.samples.slice(-MAX_CLOCK_SAMPLES);
    const recent = this.samples.slice(-DROP_CONFIRM_SAMPLES);
    if (best && recent.length === DROP_CONFIRM_SAMPLES
        && recent.every((o) => o.offsetMs < best.offsetMs - UNCONFIRMED_RISE_MS)) {
      this.samples = recent;
      this._drop = { ms: best.offsetMs - Math.max(...recent.map((o) => o.offsetMs)), atMs };
    }
    const next = this._best();
    if (next) this._carried = next;
  }

  addRoundTrip(rttMs, atMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.roundTrips.push({ rttMs, atMs });
    this.roundTrips = this.roundTrips.filter((o) => o.atMs > atMs - this.windowMs).slice(-MAX_ROUND_TRIPS);
  }

  _confirmed() { return this.samples.filter((o) => o.confirmed); }

  _support(best) {
    return this._confirmed().filter((o) => o.offsetMs >= best.offsetMs - UNCONFIRMED_RISE_MS).length;
  }

  _best() {
    let best = null;
    for (const o of this._confirmed()) if (!best || o.offsetMs > best.offsetMs) best = o;
    return best || this._carried;
  }

  _minRttMs() {
    return this.roundTrips.length ? Math.min(...this.roundTrips.map((o) => o.rttMs)) : null;
  }

  offsetMs() {
    const best = this._best();
    if (!best) return null;
    const rtt = this._minRttMs();
    return Math.round(best.offsetMs + (rtt == null ? 0 : rtt / 2));
  }

  errorMs(nowMs) {
    const best = this._best();
    if (!best) return null;
    const rtt = this._minRttMs();
    const n = Math.max(1, this._confirmed().length);
    const residual = RESIDUAL_MS_BY_SAMPLES[Math.min(n, RESIDUAL_MS_BY_SAMPLES.length) - 1];
    const drift = Math.max(0, nowMs - best.atMs) * DRIFT_PPM / 1e6;
    let setAside = this._drop && nowMs - this._drop.atMs < this.windowMs ? this._drop.ms : 0;
    for (const o of this.samples) if (!o.confirmed) setAside = Math.max(setAside, o.offsetMs - best.offsetMs);
    return Math.ceil((rtt == null ? this.assumedRttMs : rtt) / 2 + best.resolutionMs / 2 + residual + drift + setAside);
  }
}

module.exports = { normalizeServerOffset, roundTripServerOffset, readingResolutionMs, ServerClockEstimator,
  MAX_CLOCK_SKEW_MS, SECONDS_EPOCH_CEILING, CLOCK_WINDOW_MS };
