'use strict';
/**
 * Shared harness for the round-tracker pins (scripts/test-round-tracker-*.js).
 *
 * The real BidEngine over a real DurableScheduler on a temp file, a scripted fake adapter per portal
 * whose getAuctionState returns the frame the test set for this read, and a virtual clock: Date.now is
 * stubbed to `clock.now` for the life of the process, so closesInMs = close - now exactly as the
 * adapters derive it. Every read goes through _tick, the production path; the engine's own timer is
 * cleared after each one, so nothing runs that the test did not script. No network, no sleeps.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../../src/engine/bidEngine');
const { DurableScheduler } = require('../../src/scheduler/durableScheduler');

const REAL_NOW = Date.now;
const clock = { now: REAL_NOW() };
Date.now = () => clock.now;

const CLEAN = [];
const ENGINES = [];
let seq = 0;
process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill('exit'); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const SP = {
  caps: { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
    closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true },
  config: { openAtMs: 25_000, openJitterMs: 0, softOpenAtMs: 150_000, softOpenJitterMs: 0, floorWindowMs: 2_500,
    cadenceJitterMs: 0, minInterFireMs: 0 },
  softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
  companyName: 'Transrail Lighting Ltd',
  inputs: { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] },
  rules: { revisionLimit: 10, minDecrement: 100 },
};

const GC = {
  caps: { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3, closeModel: 'soft',
    reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 },
  config: { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 0 },
  softClose: { enabled: false, shippers: [], mode: 'live' },
  companyName: 'Waaree',
  inputs: { cost: 70_000, marginsPct: [9, 7.2, 1] },
  rules: { revisionLimit: 3, minDecrement: 500 },
};

// The published read each portal's adapter hands the engine. `f` is the load's scripted frame state.
function spFrame(f) {
  return { ok: true, status: 'live', closeModel: 'soft', closesAtMs: f.close, closesInMs: f.close - Date.now(),
    extendMs: f.extendMs, extendCount: f.cap, triggerWindowMs: f.window, myRank: f.rank, totalBidders: 7,
    standingL1Price: null, revisionsLeft: null, revisionLimit: 10, minDecrement: 100, measuredRttMs: 40 };
}

function gcFrame(f) {
  return { ok: true, status: 'live', closeModel: 'soft', closesAtMs: f.close, closesInMs: f.close - Date.now(),
    extendMs: 300_000, extendCount: null, extensionCeiling: null, minCloseJumpMs: 30_000, myRank: f.rank,
    totalBidders: null, standingL1Price: null, revisionsLeft: f.attempts, revisionLimit: 3, minDecrement: 500,
    measuredRttMs: 20 };
}

function tmpFile(tag) {
  const f = path.join(os.tmpdir(), `round-tracker-${tag}-${process.pid}-${seq++}.json`);
  CLEAN.push(f, `${f}.tmp`);
  return f;
}

function newEngine(load) {
  const p = load.portal;
  const adapter = {
    capabilities: () => ({ ...p.caps }),
    ensureSession: async () => ({}),
    async getAuctionState() { return load.frame.close == null ? { ok: false, error: 'no frame' } : p.frameOf(load.frame); },
    async placeBid(id, price) {
      load.bids.push({ id, price, countdown: load.frame.close - Date.now(), at: Date.now() });
      return { accepted: true, myRank: load.frame.rank, revisionsLeft: null, latencyMs: 20 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(load.file), {
    config: p.config, softClose: p.softClose, rand: () => 0.5,
    onEvent: (e) => load.events.push(e), log: quiet,
  });
  ENGINES.push(eng);
  return eng;
}

function settle(eng) {
  for (const m of eng.monitors.values()) { if (m.timer) { clearTimeout(m.timer); m.timer = null; } }
}

/**
 * Arm one load at `armAt`. With `seed`, a bid of ours is standing (rung 0 landed) the way the
 * accepted-bid path writes it, and the monitor is rebuilt from the durable intent by rehydrate() -
 * the same restore a restart runs - so every test starts from a real durable record.
 *   portal       'sp' | 'gc'
 *   posted       the load's posted close (meta.closesAt unless `closesAt` is given)
 *   closesAt     meta.closesAt at arm (a late arm passes the already-extended close here)
 *   postedCloseAt meta.postedCloseAt (priceRequests sets it on a late arm)
 *   frame        { extendMs, cap, window } for SP; ignored on GoComet
 *   seed         { fired: [0], revisionsLeft }
 */
async function openLoad({ portal, id, posted, closesAt, postedCloseAt, armAt, roundPolicy, frame = {}, seed }) {
  const p = portal === 'gc' ? { ...GC, frameOf: gcFrame } : { ...SP, frameOf: spFrame };
  const load = { portal: p, portalKey: portal, id, file: tmpFile(portal), bids: [], events: [],
    frame: { close: null, rank: null, attempts: null, extendMs: frame.extendMs, cap: frame.cap, window: frame.window } };
  clock.now = armAt;
  const meta = { id, lane: { origin: 'NAGPUR', destination: 'Raipur' }, equipment: '32ft SXL', units: 1, quoteType: 'FTL',
    companyName: p.companyName, branchName: 'NAGPUR', closesAt: closesAt != null ? closesAt : posted,
    platformKey: portal === 'gc' ? 'gocomet' : 'superprocure', rules: p.rules };
  if (postedCloseAt != null) meta.postedCloseAt = postedCloseAt;
  if (roundPolicy !== undefined) meta.roundPolicy = roundPolicy;
  load.meta = meta;
  load.inputs = p.inputs;
  let eng = newEngine(load);
  let m = eng.arm(meta, p.inputs);
  settle(eng);
  load.ladder = m.ladder.slice();
  if (seed) {
    const fired = seed.fired || [0];
    eng.scheduler.update(id, { status: 'bidding', firedRungs: fired, revisionsLeft: seed.revisionsLeft,
      landedBids: fired.length, landedBidPrice: load.ladder[Math.max(...fired)], everBid: true });
    eng.kill('seeded');
    eng = newEngine(load);
    await eng.rehydrate();
    settle(eng);
    m = eng.monitors.get(id);
    if (!m) throw new Error(`HARNESS: ${id} was not re-armed from its seeded intent`);
  }
  load.eng = eng;
  load.m = m;
  return load;
}

/** One platform read at `at`, showing `close` and our `rank`. Returns the bids placed on it. */
async function read(load, { at, close, rank, attempts }) {
  clock.now = at;
  load.frame.close = close;
  if (rank !== undefined) load.frame.rank = rank;
  if (attempts !== undefined) load.frame.attempts = attempts;
  const before = load.bids.length;
  await load.eng._tick(load.m);
  settle(load.eng);
  return load.bids.slice(before);
}

/** Reads at each countdown in `countdowns` (ms before `close`). Returns every bid placed on them. */
async function approach(load, { close, rank, attempts, countdowns }) {
  const out = [];
  for (const cd of countdowns) out.push(...await read(load, { at: close - cd, close, rank, attempts }));
  return out;
}

/** Process restart: kill, a NEW engine over a NEW scheduler on the same file, rehydrate() at `at`. */
async function restart(load, at) {
  load.eng.kill('deploy restart');
  clock.now = at;
  load.eng = newEngine(load);
  await load.eng.rehydrate();
  settle(load.eng);
  load.m = load.eng.monitors.get(load.id) || null;
  return load.m;
}

/** A desk re-price: stop + arm with the same band, exactly what reArmWithNewBand does to the engine. */
function reprice(load, at, closesAt) {
  clock.now = at;
  load.eng.stop(load.id);
  const meta = Object.assign({}, load.meta, { closesAt });
  load.m = load.eng.arm(meta, load.inputs);
  settle(load.eng);
  return load.m;
}

/** The intent as it sits on disk, read by a fresh scheduler (memory is not evidence of a write). */
function diskIntent(load) { return new DurableScheduler(load.file).get(load.id); }

/**
 * The tracker's verdict for this load, through the engine accessor PR-4's walk reads
 * (t9-design s4.1: verdict(monitor, nowMs)). Called only after a check's behavioural assertions,
 * so a missing accessor never stands in for the defect's own mechanism.
 */
function verdictOf(load) {
  if (typeof load.eng.roundVerdict !== 'function') {
    throw new Error('the engine exposes no roundVerdict(monitor, nowMs) accessor for the round tracker verdict');
  }
  return load.eng.roundVerdict(load.m, Date.now());
}

const alerts = (load, kind) => load.events.filter((e) => e.type === 'alert' && (kind == null || e.kind === kind));

const priceName = (load, price) => {
  const i = load.ladder.indexOf(price);
  if (i < 0) return `off-ladder ${price}`;
  return i === load.ladder.length - 1 ? `FLOOR (${price})` : `rung ${i} (${price})`;
};
const fmtBids = (load, bids) => (bids.length
  ? bids.map((b) => `${priceName(load, b.price)} at ${Math.round(b.countdown)}ms`).join(', ') : 'nothing');

/** Runs named checks in order and exits non-zero on any failure or on a short run. */
function runner(title, expected) {
  const results = [];
  const check = async (name, kind, fn) => {
    let failure = null;
    try { await fn(); } catch (e) { failure = (e && e.message) || String(e); }
    results.push({ name, kind, failure });
    console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${name} [${kind}]`);
    if (failure) console.log(`        ${failure.split('\n')[0]}`);
  };
  const done = () => {
    const failed = results.filter((r) => r.failure);
    if (results.length !== expected || failed.length) {
      console.log(`\nFAIL - ${results.length - failed.length}/${expected} checks passed (${results.length} ran): ${title}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nPASS - ${expected} checks: ${title}`);
  };
  console.log(`${title}\n`);
  return { check, done };
}

module.exports = { clock, openLoad, read, approach, restart, reprice, diskIntent, verdictOf, alerts, priceName,
  fmtBids, runner };
