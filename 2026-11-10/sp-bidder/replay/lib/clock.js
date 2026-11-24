'use strict';
/**
 * VirtualClock — the only source of "now" inside a replay.
 *
 * This machine's wall clock drifts materially and the drift SIGN flips day to day, so any
 * harness that reads real time produces irreproducible results. Every time value inside a
 * replay therefore comes from here, seeded from the corpus timestamps, never from Date.now().
 *
 * WallClockGuard supports that discipline by COUNTING reads of the global clock primitives
 * (Date.now, setTimeout, setInterval, process.hrtime) for the duration of a replay, so a decision
 * path that sneaks one in is caught by a test. It does NOT cover `new Date()` (see the note on
 * install() below), so the definitive determinism check is byte-identical output across two runs,
 * not a zero count from this guard alone.
 */

class VirtualClock {
  constructor(startMs) {
    if (!Number.isFinite(startMs)) throw new Error('VirtualClock: startMs must be finite');
    this._now = startMs;
    this._start = startMs;
    this.ticks = 0;
  }

  now() { return this._now; }

  /** Move forward to an absolute epoch-ms instant. Never backwards — a replay is monotone. */
  advanceTo(ms) {
    if (!Number.isFinite(ms)) throw new Error('VirtualClock.advanceTo: non-finite');
    if (ms < this._now) {
      throw new Error(`VirtualClock.advanceTo: refusing to move backwards (${this._now} -> ${ms})`);
    }
    this._now = ms;
    this.ticks += 1;
    return this._now;
  }

  advanceBy(deltaMs) { return this.advanceTo(this._now + deltaMs); }

  reset() { this._now = this._start; this.ticks = 0; }
}

/**
 * Counts reads of the real clock while a replay runs.
 *
 * install() wraps Date.now, setTimeout, setInterval and process.hrtime with counting stubs. It does
 * NOT intercept the `Date` constructor: `new Date()` reads the host clock directly in V8 and does not
 * route through Date.now, so it is not counted (nor are Date.parse or performance.now). The count
 * therefore covers Date.now / timer / hrtime reads only — a decision path that relied on `new Date()`
 * would slip past it. Nothing is blocked; the harness records the count so a test can assert on what
 * it does cover.
 */
class WallClockGuard {
  constructor() {
    this.counts = { dateNow: 0, setTimeout: 0, setInterval: 0, hrtime: 0 };
    this._saved = null;
  }

  install() {
    if (this._saved) throw new Error('WallClockGuard already installed');
    const self = this;
    this._saved = {
      dateNow: Date.now,
      setTimeout: global.setTimeout,
      setInterval: global.setInterval,
      hrtime: process.hrtime,
    };
    Date.now = function () { self.counts.dateNow += 1; return self._saved.dateNow.call(Date); };
    global.setTimeout = function (...a) { self.counts.setTimeout += 1; return self._saved.setTimeout.apply(global, a); };
    global.setInterval = function (...a) { self.counts.setInterval += 1; return self._saved.setInterval.apply(global, a); };
    const hr = function (...a) { self.counts.hrtime += 1; return self._saved.hrtime.apply(process, a); };
    hr.bigint = self._saved.hrtime.bigint;
    process.hrtime = hr;
    return this;
  }

  restore() {
    if (!this._saved) return this;
    Date.now = this._saved.dateNow;
    global.setTimeout = this._saved.setTimeout;
    global.setInterval = this._saved.setInterval;
    process.hrtime = this._saved.hrtime;
    this._saved = null;
    return this;
  }

  total() {
    return this.counts.dateNow + this.counts.setTimeout + this.counts.setInterval + this.counts.hrtime;
  }

  snapshot() { return Object.assign({}, this.counts); }
}

module.exports = { VirtualClock, WallClockGuard };
