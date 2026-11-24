'use strict';
/**
 * Shared rig for the final-window walk (T9) suites. One load, driven through the production path:
 * scripted frames reach the real BidEngine through _tick, a fake adapter answers getAuctionState and
 * placeBid, the real DurableScheduler writes a temp file, and Date.now is stubbed so the countdown is
 * closesAtMs - now exactly as the adapters derive it. No sleeps: every engine timer is cleared after
 * each tick.
 *
 * Every suite runs each scenario twice, walk on and walk off, so the walk-off control is the same
 * script with the switch down.
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../../src/engine/bidEngine');
const { DurableScheduler } = require('../../src/scheduler/durableScheduler');

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;
const setNow = (t) => { vnow = t; };
const now = () => vnow;

const CLEAN = [];
const ENGINES = [];
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill('test done'); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };
const GC_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };

// Mirrors src/config.js engine timing, with the jitters at 0 so marks are exact.
const ENGINE_CONFIG = { openAtMs: 25_000, openJitterMs: 0, softOpenAtMs: 150_000, softOpenJitterMs: 0,
  floorWindowMs: 2_500, cadenceJitterMs: 0 };

const WALK_OFF = { sp: { enabled: false }, gocomet: { enabled: false } };

/**
 * One load. opts:
 *   platform 'sp' | 'gc'
 *   walk      engine walk settings (omitted = the engine's own default, i.e. no walk config at all)
 *   band      { cost, marginsPct, minMarginPct }
 *   company   shipper name
 *   softClose engine softClose block (SP allowlist)
 *   sp: { closeModel, extendMs, extendCount, triggerWindowMs, revisionLimit, clockErrorMs, socket }
 *   gc: { attempts, roundPolicy, preEmptiveFloorAtRankOne }
 *   minDecrement
 */
function load(opts = {}) {
  const gc = opts.platform === 'gc';
  const writes = [];
  const events = [];
  const logs = { warn: [], info: [], error: [] };
  const posted = REAL_NOW() + 3_600_000;
  const spo = Object.assign({ closeModel: 'hard', extendMs: null, extendCount: null, triggerWindowMs: null,
    revisionLimit: 3, clockErrorMs: 200, socket: true }, opts.sp || {});
  const gco = Object.assign({ attempts: 3 }, opts.gc || {});
  const ctrl = {
    close: posted, rank: null, myAmount: null, attempts: gc ? gco.attempts : null,
    refuse: [], defer: false, release: null, rankAfterBid: undefined, bidClosingInMs: undefined,
    readFails: false, clockErrorMs: spo.clockErrorMs, reads: 0, prepares: [], gcClockErrorMs: gco.clockErrorMs,
  };
  const minDecrement = opts.minDecrement != null ? opts.minDecrement : (gc ? 500 : 100);
  const frame = () => {
    const base = { ok: true, status: 'live', closesAtMs: ctrl.close, closesInMs: Math.max(0, ctrl.close - vnow),
      myRank: ctrl.rank, totalBidders: 4, standingL1Price: null, minDecrement, measuredRttMs: 40 };
    if (gc) {
      const f = Object.assign(base, { closeModel: 'soft', extendMs: 300_000, extendCount: null, extensionCeiling: null,
        revisionsLeft: ctrl.attempts, revisionLimit: 3, serverOffsetMs: 0 });
      if (ctrl.gcClockErrorMs !== undefined) f.clockErrorMs = ctrl.gcClockErrorMs;
      return f;
    }
    const f = Object.assign(base, { closeModel: spo.closeModel, extendMs: spo.extendMs, extendCount: spo.extendCount,
      triggerWindowMs: spo.triggerWindowMs, revisionLimit: spo.revisionLimit, revisionsLeft: null,
      clockErrorMs: ctrl.clockErrorMs });
    if (spo.socket) f.myAmount = ctrl.myAmount;
    return f;
  };
  const adapter = {
    capabilities: () => ({ ...(gc ? GC_CAPS : SP_CAPS) }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      ctrl.reads += 1;
      if (ctrl.readDefer) {
        await new Promise((resolve) => { ctrl.releaseRead = resolve; });
        ctrl.readDefer = false;
      }
      return ctrl.readFails ? { ok: false } : frame();
    },
    placeBid: async (_id, price, bidOpts) => {
      const w = { price, cd: ctrl.close - vnow, floor: bidOpts && bidOpts.floor };
      writes.push(w);
      if (ctrl.defer) await new Promise((resolve) => { ctrl.release = resolve; });
      const refusal = ctrl.refuse.shift();
      if (refusal) { w.refused = true; return Object.assign({ accepted: false, status: 400 }, refusal); }
      if (gc && ctrl.attempts != null) ctrl.attempts -= 1;
      ctrl.myAmount = price;
      if (ctrl.rankAfterBid !== undefined) ctrl.rank = ctrl.rankAfterBid;
      const res = { accepted: true, myRank: null, revisionsLeft: gc ? ctrl.attempts : null, latencyMs: 40 };
      if (gc) res.bidClosingInMs = ctrl.bidClosingInMs !== undefined ? ctrl.bidClosingInMs : Math.max(0, ctrl.close - vnow);
      return res;
    },
  };
  if (gc) adapter.prepareQuote = async (id) => { ctrl.prepares.push({ id, cd: ctrl.close - vnow }); };
  const file = path.join(os.tmpdir(), `walk-rig-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const log = {
    debug() {}, info: (m, f) => logs.info.push({ m, f }), warn: (m, f) => logs.warn.push({ m, f }),
    error: (m, f) => logs.error.push({ m, f }),
  };
  const engineOpts = {
    config: Object.assign({}, ENGINE_CONFIG, opts.config || {}),
    softClose: opts.softClose || { enabled: false },
    rand: () => 0.5,
    onEvent: (e) => events.push(e),
    log,
  };
  if (opts.walk !== undefined) engineOpts.walk = opts.walk;
  const eng = new BidEngine(adapter, new DurableScheduler(file), engineOpts);
  ENGINES.push(eng);
  vnow = posted - 900_000;
  const meta = { id: `WALK-${seq++}`, lane: { origin: gc ? 'Chikhli' : 'Govindgarh', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: opts.company || (gc ? 'Waaree Energies Ltd' : 'Durian Industries'),
    closesAt: posted, platformKey: gc ? 'gocomet' : 'superprocure',
    rules: { revisionLimit: gc ? 3 : spo.revisionLimit, minDecrement } };
  if (gc && gco.roundPolicy !== undefined) meta.roundPolicy = gco.roundPolicy;
  if (gc && gco.preEmptiveFloorAtRankOne) meta.preEmptiveFloorAtRankOne = true;
  const band = opts.band || { cost: 87_400, marginsPct: [15.3, 10.8, 4.5], minMarginPct: 3 };
  let m = eng.arm(meta, band);
  // Engine timers never run on the real clock here: a check that needs one calls it by hand.
  const clear = () => {
    if (opts.keepTimers) return;
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    if (m._walkClockTimer) { clearTimeout(m._walkClockTimer); m._walkClockTimer = null; }
    if (m._walkPrepTimer) { clearTimeout(m._walkPrepTimer); m._walkPrepTimer = null; }
  };
  clear();

  const r = {
    eng, m, ctrl, writes, events, logs, ladder: m.ladder.slice(), file, adapter, engineOpts, meta, schedule: [],
    get close() { return ctrl.close; },
    /** A bid of ours already standing at `rungIndex` (as if landed earlier), with `left` bids to spend. */
    seedStanding(rungIndex, left) {
      m.firedRungs.add(rungIndex);
      m.currentRungIndex = rungIndex;
      m.landedBids = Math.max(1, m.landedBids);
      m.lastBidPrice = m.ladder[rungIndex];
      m.everBid = true;
      m.ownBidAttempts = Math.max(1, m.ownBidAttempts);
      ctrl.myAmount = m.ladder[rungIndex];
      if (left !== undefined) {
        m.revisionsLeft = left;
        if (gc) ctrl.attempts = left;
      }
    },
    /** Process restart: a new engine over the same intent file rehydrates the load. */
    async restart() {
      try { r.eng.kill('test: process restart'); } catch (_) {}
      const next = new BidEngine(adapter, new DurableScheduler(file), engineOpts);
      ENGINES.push(next);
      await next.rehydrate();
      r.eng = next;
      m = next.monitors.get(meta.id);
      r.m = m;
      if (!m) throw new Error(`HARNESS: rehydrate did not re-arm ${meta.id}`);
      clear();
      return m;
    },
    /** One tick at countdown `cd`. Returns the prices written on it. */
    async at(cd, { rank, myAmount } = {}) {
      vnow = ctrl.close - cd;
      if (rank !== undefined) ctrl.rank = rank;
      if (myAmount !== undefined) ctrl.myAmount = myAmount;
      const before = writes.length;
      await r.eng._tick(m);
      // The next tick the engine asked for, so walk-off identity covers the tick schedule, not only writes.
      r.schedule.push(m.timer && Number.isFinite(m.timer._idleTimeout) ? m.timer._idleTimeout : null);
      clear();
      return writes.slice(before).map((w) => w.price);
    },
    /** Tick every `stepMs` from `fromCd` down to `toCd` inclusive; returns [{cd, prices}] with writes. */
    async sweep(fromCd, toCd, stepMs, rankAt = () => undefined) {
      const out = [];
      for (let cd = fromCd; cd >= toCd; cd -= stepMs) {
        const prices = await r.at(cd, { rank: rankAt(cd) });
        if (prices.length) out.push({ cd, prices });
      }
      return out;
    },
    /** Move the close forward by `ms` and read once at countdown `cd` of the new close. */
    async extend(ms, cd, opts2 = {}) {
      ctrl.close += ms;
      return r.at(cd, opts2);
    },
    trace() { return writes.map((w) => `${w.price}@${w.cd}${w.refused ? 'x' : ''}`); },
    done() { try { r.eng.kill('test done'); } catch (_) {} },
  };
  return r;
}

/**
 * Engine timers on the virtual clock: setTimeout/clearTimeout are replaced for this process, and
 * advanceTo(t) runs every timer due by t in order, moving the clock to each. Use with load({ keepTimers: true }).
 */
function useFakeTimers() {
  const queue = [];
  let id = 0;
  global.setTimeout = (fn, ms, ...args) => {
    const t = { id: ++id, at: vnow + Math.max(0, Number(ms) || 0), fn, args, unref() { return t; }, ref() { return t; }, hasRef() { return false; } };
    queue.push(t);
    return t;
  };
  global.clearTimeout = (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); };
  async function advanceTo(target) {
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = queue[0];
      if (!t || t.at > target) break;
      queue.shift();
      vnow = t.at;
      // Not awaited: a tick parked on a read that never answers must not stall the clock.
      Promise.resolve().then(() => t.fn(...t.args)).catch(() => {});
      for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    }
    vnow = target;
  }
  return { advanceTo, queue };
}

/** Run `script(r)` twice - walk off and walk on - on fresh loads built from the same opts. */
async function pair(opts, walkOn, script) {
  const off = load(Object.assign({}, opts, { walk: WALK_OFF }));
  await script(off);
  off.done();
  const on = load(Object.assign({}, opts, { walk: walkOn }));
  await script(on);
  on.done();
  return { off, on };
}

// WALK_RECORD=1 prints each walk-off trace instead of comparing, to (re)record goldens on the base tree.
function offMatches(label, got, golden) {
  if (process.env.WALK_RECORD) { console.log(`    RECORD ${label}: ${JSON.stringify(got)}`); return null; }
  return same(got, golden) ? null : `walk-off control moved for ${label}: base ${JSON.stringify(golden)}, now ${JSON.stringify(got)}`;
}

let ran = 0;
let pass = 0;
const FAILURES = [];

async function check(name, fn) {
  ran++;
  let failure = null;
  try {
    const res = await fn();
    if (typeof res === 'string') failure = res;
  } catch (e) {
    failure = (e && e.stack) || String(e);
  }
  if (failure) {
    FAILURES.push({ name, failure });
    console.log(`  not ok  ${name}\n          ${failure.split('\n').join('\n          ')}`);
  } else {
    pass++;
    console.log(`  ok  ${name}`);
  }
}

// The summary line is exactly "N/N checks passed", as the runner requires of a file carrying the
// @requires-summary-line marker (scripts/run-tests.js); the title follows on its own line.
function finish(title, expected) {
  const total = expected != null ? expected : ran;
  if (ran === total && pass === total) {
    console.log(`\n${pass}/${total} checks passed\n${title}`);
    return;
  }
  console.log(`\n${pass}/${total} checks passed\n${title}`);
  for (const f of FAILURES) console.log(`FAIL ${f.name}`);
  process.exitCode = 1;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The suites' own fixed settings: the landing time equals the step time unless a check sets it (so
// start = steps x stepTime + safety holds as the design states it), and the probe leads of the design
// (6 s / 12 s). The shipped defaults are pinned separately.
function walkCfg(platform, over = {}) {
  const base = platform === 'gc'
    ? { enabled: true, stepTimeMs: 6_000, safetyMarginMs: 500, maxWalkWindowMs: 20_000, clockErrorMs: 1_000, stepTimeSource: 'manual',
      probeLeadMs: 12_000 }
    : { enabled: true, stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000, stepTimeSource: 'manual', probeLeadMs: 6_000 };
  const block = Object.assign(base, over);
  if (block.landMs === undefined) block.landMs = block.stepTimeMs;
  return platform === 'gc' ? { sp: { enabled: false }, gocomet: block } : { sp: block, gocomet: { enabled: false } };
}

module.exports = { load, pair, offMatches, check, finish, same, walkCfg, WALK_OFF, setNow, now, REAL_NOW, SP_CAPS, GC_CAPS,
  quiet, ENGINE_CONFIG, useFakeTimers };
