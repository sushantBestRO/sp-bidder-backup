'use strict';

// Round tracker (piece A): counts anti-snipe rounds from forward moves of the close and answers
// whether the current round is final. Pure: no I/O, no timers, no clock of its own.

const GC_DEFAULT_CAP = 3;
const GC_MAX_ROUND_JUMP_MS = 3_600_000;
const FROZEN_AFTER_MS = 3_000;
const PROBE_OBSERVE_MS = 2_500;
const LEDGER_MAX = 32;
const REST_BACK_AGREE_MS = 30_000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const tol = (k) => 2_000 + 1_000 * k;

const DURABLE_KEYS = ['v', 'postedCloseAt', 'rounds', 'seq', 'anchorSeq', 'closeAt', 'closeSource', 'extendMs',
  'triggerWindowMs', 'cap', 'publishedCap', 'gridDoubt', 'finalFor', 'probe', 'ledger'];

function copy(x) { return JSON.parse(JSON.stringify(x)); }

/**
 * `restored` is the durable blob from the intent. Without one, `closeAt` is the close armed against;
 * a posted close earlier than it seeds a late arm, and `resumed` (an intent that predates the
 * tracker) seeds the same way, or with restart_gap when no posted close is on record.
 */
function createTracker({ platform, closeModel, softStrategy, postedCloseAt, restored, capPrior, closeAt, resumed,
  nowMs } = {}) {
  const live = { platform: platform === 'gc' ? 'gc' : 'sp', closeModel, softStrategy, lastObservedAt: null,
    zeroSince: null, frozenAfterMs: FROZEN_AFTER_MS, seed: null, dirty: false, feedCloseAt: null, feedChangedAt: null,
    lastCountdown: null, sourcesDisagree: false, restBack: null, frozen: null };
  if (restored && typeof restored === 'object' && restored.v === 1) {
    return Object.assign(copy(restored), live, { seed: { reason: 'restart_gap', unbounded: false, zeroOnOffGrid: false } });
  }
  const posted = finite(postedCloseAt) ? postedCloseAt : null;
  const armClose = finite(closeAt) ? closeAt : null;
  let cap;
  if (live.platform === 'gc') {
    cap = capPrior === undefined ? { value: GC_DEFAULT_CAP, source: 'default' } : { value: capPrior, source: 'roundPolicy' };
  } else cap = { value: 'unknown', source: 'default' };
  const t = Object.assign({ v: 1, postedCloseAt: posted, rounds: 0, seq: 0, anchorSeq: 0, closeAt: armClose,
    closeSource: 'posted', extendMs: null, triggerWindowMs: null, cap, publishedCap: null, gridDoubt: null,
    finalFor: null, probe: null, ledger: [] }, live);
  if (posted != null && armClose != null && posted < armClose) {
    t.closeAt = posted;
    t.seed = { reason: resumed ? 'restart_gap' : 'late_arm', unbounded: true, zeroOnOffGrid: true };
  } else if (resumed && posted == null) {
    t.gridDoubt = { reason: 'restart_gap', sinceSeq: 0 };
  }
  if (t.closeAt != null) t.ledger.push({ seq: 0, closeAt: t.closeAt, seenAt: finite(nowMs) ? nowMs : null, source: 'posted', kind: 'anchor', k: 0 });
  return t;
}

function append(t, entry) {
  t.ledger.push(entry);
  if (t.ledger.length > LEDGER_MAX) t.ledger.splice(0, t.ledger.length - LEDGER_MAX);
}

function adopt(t, c, now, kind, k) {
  t.seq += 1;
  t.closeAt = c;
  t.anchorSeq = t.seq;
  t.dirty = true;
  append(t, { seq: t.seq, closeAt: c, seenAt: now, source: t.closeSource, kind, k });
}

const roundIdOf = (t, rounds = t.rounds) => `${t.postedCloseAt != null ? t.postedCloseAt : 'na'}:${rounds}:${t.anchorSeq}`;

function capCheck(t, out) {
  if (Number.isInteger(t.cap.value) && t.rounds > t.cap.value) {
    out.events.push({ type: 'cap_exceeded', rounds: t.rounds, cap: t.cap.value });
    t.cap = { value: null, source: 'r_exceeds_cap' };
  }
}

// A close moved earlier: the round in progress ends at the new close, so it is the final one.
function backward(t, c, now, source) {
  t.closeSource = source;
  adopt(t, c, now, 'backward', 0);
  t.finalFor = { roundId: roundIdOf(t), reason: 'backward_move' };
  t.sourcesDisagree = false;
  t.restBack = null;
}

/**
 * A forward move of the close to `c`, seen at `now`, from `source`: a reschedule before the old
 * close's window opened, otherwise the rounds that fit the increment grid and could have run by now.
 */
function classify(t, c, now, { inc, W, lo, source }, out) {
  const gc = t.platform === 'gc';
  const jump = c - t.closeAt;
  const seed = t.seed;
  t.seed = null;
  t.closeSource = source;
  out.changed = true;
  if (now < lo) {
    adopt(t, c, now, 'reschedule', 0);
    out.kind = 'reschedule';
    return out;
  }
  if (gc && jump > GC_MAX_ROUND_JUMP_MS) {
    adopt(t, c, now, 'reschedule_in_war', 0);
    t.gridDoubt = { reason: 'off_grid_move', sinceSeq: t.seq };
    out.kind = 'reschedule_in_war';
    return out;
  }
  const kmax = W === Infinity || (seed && seed.unbounded) ? Infinity : 1 + Math.floor((now - lo) / inc);
  let k;
  let onGrid;
  let add;
  if (gc) {
    k = Math.max(1, Math.round(jump / inc));
    onGrid = Math.abs(jump - k * inc) <= tol(k) && k <= kmax;
    add = Math.min(k, kmax);
  } else {
    k = Math.round(jump / inc);
    onGrid = k >= 1 && Math.abs(jump - k * inc) <= tol(k) && k <= kmax;
    add = onGrid ? k : 1;
  }
  if (!onGrid && seed && seed.zeroOnOffGrid) add = 0;
  t.rounds += add;
  adopt(t, c, now, onGrid ? 'round' : 'offgrid', add);
  if (!onGrid) t.gridDoubt = { reason: seed ? seed.reason : 'off_grid_move', sinceSeq: t.seq };
  else if (k === 1) t.gridDoubt = null;
  out.counted = add;
  out.kind = 'round';
  if (add > 0) out.events.push({ type: 'round', rounds: t.rounds, counted: add });
  capCheck(t, out);
  return out;
}

function observe(t, obs, now) {
  const pending = t.probe && t.probe.state === 'pending' ? t.probe : null;
  const out = observeFeed(t, obs, now);
  if (pending) {
    if (out.counted > 0) {
      pending.state = 'moved';
      pending.openedRoundId = roundIdOf(t);
      t.dirty = true;
    } else if (now >= pending.observeUntil && finite(obs.closeAt) && finite(obs.closesInMs) && obs.closesInMs > 0) {
      // A read at or past the close cannot show whether our shot extended the round: the frozen-zero
      // check answers that instead.
      pending.state = 'no_move';
      t.finalFor = { roundId: pending.roundId, reason: 'probe_no_move' };
      t.dirty = true;
    }
  }
  return out;
}

/**
 * One read. `obs`: { closeAt, closesInMs, extendMs, published, triggerWindowMs, extendCount, minCloseJumpMs,
 * clockErrorMs, readGapMs, closeModel?, zeroSinceMs?, frozenAfterMs? }. Returns { changed, counted, kind, events }.
 */
function observeFeed(t, obs, now) {
  const out = { changed: false, counted: 0, kind: null, events: [] };
  const gc = t.platform === 'gc';
  t.lastObservedAt = now;
  if (obs.closeModel) t.closeModel = obs.closeModel;
  if (finite(obs.frozenAfterMs)) t.frozenAfterMs = obs.frozenAfterMs;
  if (obs.zeroSinceMs !== undefined) t.zeroSince = finite(obs.zeroSinceMs) ? obs.zeroSinceMs : null;
  else if (finite(obs.closesInMs)) t.zeroSince = obs.closesInMs <= 0 ? (t.zeroSince != null ? t.zeroSince : now) : null;
  const inc = finite(obs.extendMs) && obs.extendMs > 0 ? obs.extendMs : null;
  if (inc != null && inc !== t.extendMs) { t.extendMs = inc; t.dirty = true; }
  if (finite(obs.triggerWindowMs) && obs.triggerWindowMs !== t.triggerWindowMs) { t.triggerWindowMs = obs.triggerWindowMs; t.dirty = true; }
  if (!gc && finite(obs.extendCount) && obs.extendCount >= 0 && (t.publishedCap == null || obs.extendCount > t.publishedCap)) {
    t.publishedCap = obs.extendCount;
    if (t.cap.source !== 'r_exceeds_cap') t.cap = { value: obs.extendCount, source: 'published' };
    t.dirty = true;
  }
  const prevCountdown = t.lastCountdown;
  if (gc && finite(obs.closesInMs)) t.lastCountdown = { at: now, ms: obs.closesInMs };
  const c = obs.closeAt;
  if (!finite(c)) return out;
  const source = gc ? 'gc_countdown' : 'socket';
  const prevFeed = t.feedCloseAt;
  if (c !== prevFeed) {
    t.feedCloseAt = c;
    t.feedChangedAt = now;
    t.restBack = null;
  }
  if (t.closeAt == null || t.closeModel !== 'soft') {
    if (t.closeAt !== c) {
      t.closeSource = source;
      adopt(t, c, now, 'anchor', 0);
      out.changed = true;
    }
    return out;
  }
  const b = t.closeAt;
  const jump = c - b;
  if (jump === 0 || inc == null) return out;
  // The listing moved the close earlier and the socket still shows the one it always did: not a move.
  if (jump > 0 && c === prevFeed && t.closeSource === 'rest') return out;
  // Ruling 56 (e): GoComet's close is derived from the server's stamp, so a stamp that steps moves it
  // without the countdown. Only a move the countdown itself makes, net of the time between the two
  // reads, is the platform's. A countdown already at zero is clamped and measures nothing.
  const countdownMove = gc && prevCountdown && prevCountdown.ms > 0 && finite(obs.closesInMs)
    ? obs.closesInMs - prevCountdown.ms + (now - prevCountdown.at) : null;
  if (jump < 0) {
    if (!gc && t.softStrategy === 'off') return out;
    const minBack = finite(obs.minCloseJumpMs) && obs.minCloseJumpMs > 0 ? obs.minCloseJumpMs : 0.5 * inc;
    if (prevFeed == null || prevFeed - c < minBack) return out;
    if (countdownMove != null && countdownMove > 0.5 * (c - prevFeed)) return out;
    backward(t, c, now, source);
    out.changed = true;
    out.kind = 'backward';
    return out;
  }
  const slack = 2_000 + (finite(obs.clockErrorMs) ? obs.clockErrorMs : 0);
  let W = Infinity;
  if (gc) W = inc;
  else if (finite(t.triggerWindowMs)) W = t.triggerWindowMs;
  const lo = b - W - slack;
  const inWindow = now >= lo;
  // Ruling 56 (b): inside a known SuperProcure window any real move counts; a published floor wins.
  let minJump = 0.5 * inc;
  if (finite(obs.minCloseJumpMs) && obs.minCloseJumpMs > 0) minJump = obs.minCloseJumpMs;
  else if (!gc && W !== Infinity && inWindow) minJump = Math.min(slack, minJump);
  if (jump < minJump) return out;
  if (countdownMove != null && countdownMove < 0.5 * jump) {
    t.closeAt = c;
    t.closeSource = source;
    t.dirty = true;
    out.changed = true;
    out.kind = 'belief';
    return out;
  }
  return classify(t, c, now, { inc, W, lo, source }, out);
}

/**
 * The close the SuperProcure listing last showed and when it was read. Ahead of the
 * tracker's close: classified like a socket move; a counted round reads UNCERTAIN until the socket agrees.
 * Behind the tracker's close: a backward move, taken only on two agreeing reads REST_BACK_AGREE_MS
 * apart, both newer than the socket's last change, and still ahead of the read that showed it.
 */
function observeRest(t, { restCloseAt, restSeenAt }, now) {
  const out = { changed: false, counted: 0, kind: null, events: [] };
  const inc = t.extendMs;
  if (!finite(restCloseAt) || !finite(restSeenAt) || !finite(inc) || t.closeModel !== 'soft' || t.closeAt == null) return out;
  const minJump = 0.5 * inc;
  const feed = t.feedCloseAt != null ? t.feedCloseAt : t.closeAt;
  if (Math.abs(restCloseAt - feed) < minJump) {
    t.sourcesDisagree = false;
    t.restBack = null;
    return out;
  }
  if (t.feedChangedAt != null && restSeenAt <= t.feedChangedAt) return out;
  if (restCloseAt - t.closeAt >= minJump) {
    const W = finite(t.triggerWindowMs) ? t.triggerWindowMs : Infinity;
    classify(t, restCloseAt, restSeenAt, { inc, W, lo: t.closeAt - W - 2_000, source: 'rest' }, out);
    if (out.kind === 'round') t.sourcesDisagree = true;
    return out;
  }
  if (t.closeAt - restCloseAt < minJump || restCloseAt <= restSeenAt) {
    t.restBack = null;
    return out;
  }
  const prev = t.restBack;
  const agrees = prev && Math.abs(prev.closeAt - restCloseAt) <= tol(0);
  if (agrees && restSeenAt - prev.seenAt >= REST_BACK_AGREE_MS) {
    backward(t, restCloseAt, restSeenAt, 'rest');
    out.changed = true;
    out.kind = 'backward';
    return out;
  }
  if (!agrees) t.restBack = { closeAt: restCloseAt, seenAt: restSeenAt };
  return out;
}

// The one check a countdown frozen past the close gets, keyed on the close it froze at.
function frozenCheck(t) {
  return t && t.frozen && t.frozen.closeAt === t.closeAt ? t.frozen : null;
}

function startFrozenCheck(t, now) {
  t.frozen = { closeAt: t.closeAt, state: 'pending', since: now };
  return t.frozen;
}

/**
 * The frozen close check's answer: { kind: 'later', closeAt, source } re-enters as the next round;
 * 'open' (GoComet still open at the same close) opens a round at that close; 'same' and 'unanswered'
 * record the answer. A later close is taken even after the check timed out.
 */
function answerFrozenCheck(t, closeAt, answer, now) {
  const out = { changed: false, counted: 0, kind: null, events: [] };
  const f = frozenCheck(t);
  if (!f || f.closeAt !== closeAt) return out;
  if (answer.kind !== 'later' && f.state !== 'pending') return out;
  out.changed = true;
  if (answer.kind === 'later' || answer.kind === 'open') {
    const c = answer.kind === 'later' ? answer.closeAt : closeAt;
    const onGrid = answer.kind === 'later' && t.platform !== 'gc' && finite(t.extendMs)
      && Math.abs(c - closeAt - t.extendMs) <= tol(1);
    t.rounds += 1;
    t.closeSource = answer.source;
    adopt(t, c, now, 'reopen', 1);
    t.gridDoubt = onGrid ? null : { reason: 'off_grid_move', sinceSeq: t.seq };
    out.counted = 1;
    out.kind = 'reopen';
    out.events.push({ type: 'round', rounds: t.rounds, counted: 1 });
    capCheck(t, out);
  }
  if (answer.kind === 'later') t.frozen = null;
  else f.state = answer.kind;
  return out;
}

/**
 * One accepted write of ours (piece C). `countdownAtLandMs` is the close's countdown when it landed.
 * SuperProcure: a write landing inside the trigger window starts a probe; a counted move answers
 * NOT_FINAL, and the first read carrying a close at or after `observeUntil` with no move answers FINAL.
 * Until then the round is UNCERTAIN. GoComet: the submit response's own countdown answers at once.
 */
function observeOwnWrite(t, { acceptedAt, roundId, countdownAtLandMs, submitResponse, triggerWindowMs, extendMs,
  observeMs } = {}) {
  const out = { changed: false, counted: 0, kind: null, events: [] };
  if (!t || !finite(acceptedAt) || !finite(countdownAtLandMs) || typeof roundId !== 'string') return out;
  const probe = { roundId, placedAt: acceptedAt, observeUntil: acceptedAt, closeAtAtPlacement: t.closeAt };
  if (t.platform === 'gc') {
    const inc = finite(extendMs) && extendMs > 0 ? extendMs : t.extendMs;
    const after = submitResponse && finite(submitResponse.bidClosingInMs) ? submitResponse.bidClosingInMs : null;
    if (after == null || !finite(inc) || countdownAtLandMs > inc) return out;
    const jump = after - countdownAtLandMs;
    out.changed = true;
    if (jump > inc / 2) {
      const from = finite(t.closeAt) ? t.closeAt : acceptedAt + countdownAtLandMs;
      t.rounds += 1;
      t.closeSource = 'submit_response';
      adopt(t, Math.round((from + jump) / 1000) * 1000, acceptedAt, 'round', 1);
      t.probe = Object.assign(probe, { state: 'moved', openedRoundId: roundIdOf(t) });
      out.counted = 1;
      out.kind = 'round';
      out.events.push({ type: 'round', rounds: t.rounds, counted: 1 });
      if (Number.isInteger(t.cap.value) && t.rounds > t.cap.value) {
        out.events.push({ type: 'cap_exceeded', rounds: t.rounds, cap: t.cap.value });
        t.cap = { value: null, source: 'r_exceeds_cap' };
      }
    } else {
      t.probe = Object.assign(probe, { state: 'no_move' });
      t.finalFor = { roundId, reason: 'gc_submit_no_move' };
      t.cap = { value: t.rounds, source: 'gc_submit' };
      t.dirty = true;
    }
    return out;
  }
  const W = finite(triggerWindowMs) ? triggerWindowMs : t.triggerWindowMs;
  if (!finite(W) || W <= 0 || countdownAtLandMs > W) return out;
  t.probe = Object.assign(probe, { observeUntil: acceptedAt + (finite(observeMs) ? observeMs : PROBE_OBSERVE_MS),
    state: 'pending' });
  t.dirty = true;
  out.changed = true;
  return out;
}

/**
 * The RoundVerdict the final-window walk reads. `over` lets the engine supply R, C, the close model
 * and the close from the monitor it decides on (ruling 56 (a)); without it the tracker's own values
 * answer. `t` may be null (a monitor that never armed a tracker).
 */
function verdict(t, nowMs, over = {}) {
  const s = t || { platform: 'sp', rounds: 0, anchorSeq: 0, postedCloseAt: null, closeAt: null, closeSource: 'posted',
    extendMs: null, triggerWindowMs: null, cap: { value: 'unknown', source: 'default' }, gridDoubt: null,
    finalFor: null, lastObservedAt: null, zeroSince: null, frozenAfterMs: FROZEN_AFTER_MS };
  const gc = s.platform === 'gc';
  const rounds = over.rounds !== undefined ? over.rounds : s.rounds;
  const exceeded = s.cap.source === 'r_exceeds_cap';
  let cap = over.cap !== undefined ? over.cap : s.cap.value;
  if (exceeded) cap = null;
  const closeModel = over.closeModel !== undefined ? over.closeModel : s.closeModel;
  const roundId = roundIdOf(s, rounds);
  const p = s.probe && (s.probe.roundId === roundId || s.probe.openedRoundId === roundId) ? s.probe : null;
  const pending = p && p.state === 'pending' && p.roundId === roundId;
  const base = { roundId, rounds, cap, closeAt: over.closeAt !== undefined ? over.closeAt : s.closeAt,
    closeSource: s.closeSource, asOf: s.lastObservedAt != null ? s.lastObservedAt : nowMs,
    triggerWindowMs: gc ? s.extendMs : s.triggerWindowMs, extendMs: s.extendMs,
    probe: p ? { placedAt: p.placedAt, observeUntil: p.observeUntil, state: p.state } : null };
  const mk = (v, confidence, reason, extra) => Object.assign({ verdict: v, confidence, reason }, base, extra);
  const hardCap = over.cap !== undefined ? over.cap : (s.publishedCap != null ? s.publishedCap : s.cap.value);
  if (closeModel !== 'soft' || (!gc && hardCap === 0)) return mk('FINAL', 'HIGH', 'hard_close', { rounds: 0, cap: 0 });
  let out;
  if (s.finalFor && s.finalFor.roundId === roundId) out = mk('FINAL', 'HIGH', s.finalFor.reason);
  else if (pending) out = mk('UNCERTAIN', 'LOW', 'probe_pending');
  else if (exceeded) out = mk('FINAL', 'HIGH', 'r_exceeds_cap');
  else if (s.gridDoubt) out = mk('UNCERTAIN', 'LOW', s.gridDoubt.reason);
  else if (s.sourcesDisagree) out = mk('UNCERTAIN', 'LOW', 'sources_disagree');
  else if (cap === 'unknown' || cap === null) out = mk('UNCERTAIN', 'LOW', 'uncapped_no_evidence');
  else if (rounds >= cap) out = mk('FINAL', 'HIGH', 'cap_reached');
  else if (p && p.state === 'moved' && p.openedRoundId === roundId) out = mk('NOT_FINAL', 'HIGH', gc ? 'gc_submit_moved' : 'probe_moved');
  else out = mk('NOT_FINAL', 'HIGH', 'below_cap');
  const frozen = s.zeroSince != null && nowMs - s.zeroSince >= s.frozenAfterMs;
  const checking = s.frozen && s.frozen.closeAt === s.closeAt && s.frozen.state === 'pending';
  if (frozen && out.verdict !== 'FINAL') out = mk('UNCERTAIN_AFTER_CLOSE', 'LOW', checking ? 'rest_check_pending' : 'frozen_zero');
  return out;
}

// Ruling 56 (a): R, the published C and the close are read from the monitor's mirrors, so a value set
// there (only ever by this tracker in src) is taken before the next read is classified. A pending
// seed keeps its own close: the first read is classified against it.
function syncMirrors(t, { rounds, publishedCap, closeAt }) {
  if (Number.isInteger(rounds) && rounds >= 0 && rounds !== t.rounds) { t.rounds = rounds; t.dirty = true; }
  const c = finite(closeAt) ? closeAt : null;
  if (closeAt !== undefined && c !== t.closeAt && !t.seed) { t.closeAt = c; t.dirty = true; }
  if (t.platform !== 'gc' && Number.isInteger(publishedCap) && publishedCap >= 0
      && (t.publishedCap == null || publishedCap > t.publishedCap)) {
    t.publishedCap = publishedCap;
    if (t.cap.source !== 'r_exceeds_cap') t.cap = { value: publishedCap, source: 'published' };
    t.dirty = true;
  }
}

function durable(t) {
  const out = {};
  for (const k of DURABLE_KEYS) out[k] = t[k] === undefined ? null : t[k];
  return copy(out);
}

const isDirty = (t) => !!(t && t.dirty);
function markClean(t) { if (t) t.dirty = false; }

module.exports = { createTracker, observe, observeRest, observeOwnWrite, verdict, syncMirrors, durable, isDirty, markClean,
  frozenCheck, startFrozenCheck, answerFrozenCheck };
