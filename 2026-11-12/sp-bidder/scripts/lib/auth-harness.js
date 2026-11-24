'use strict';
/**
 * Shared harness for the auth state-machine tests (boundaries / reversibility / scenarios).
 *
 * WHY THIS EXISTS AT ALL. The diagnosis of three failed fix rounds named one root cause above the
 * others: nine timing constants and nothing that tested their CROSS-PRODUCTS. Every confirmed defect
 * in round 3 sat at a pairwise timing boundary - the settle window against the trial cadence, the
 * expiry grace against the streak window, the streak window against an intervening success. Those are
 * unreachable without a clock you can put on an exact millisecond AND timers that fire on that same
 * clock, so the machinery for both lives here once instead of being re-improvised per file.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');
const { BidEngine } = require('../../src/engine/bidEngine');
const { DurableScheduler } = require('../../src/scheduler/durableScheduler');

// ------------------------------------------------------------------------------------------------
// DETERMINISTIC CLOCK + TIMERS ON THE SAME CLOCK
//
// advance() moves time WITHOUT firing timers, which is what a check wants when a dormant liveness
// probe would otherwise inject login() calls into a wire-count assertion. advanceFiring() moves it
// and runs every timer that comes due, in due order, with Date.now() set to each timer's own instant
// while its callback runs - so a callback that reads the clock sees the instant it was scheduled for
// rather than the end of the jump. That distinction is the difference between pinning a boundary and
// approximating it.
// ------------------------------------------------------------------------------------------------
const REAL_NOW = Date.now;
let CLOCK = 0;
const TIMERS = new Map();
let timerSeq = 0;

const vSetTimeout = (fn, ms) => { const id = ++timerSeq; TIMERS.set(id, { at: CLOCK + ms, fn }); return id; };
const vClearTimeout = (id) => { TIMERS.delete(id); };
const pendingTimers = () => TIMERS.size;

function freezeClock(at) {
  TIMERS.clear(); // never let one check's dormant timer fire inside the next one
  CLOCK = at != null ? at : 1_770_000_000_000;
  Date.now = () => CLOCK;
  return CLOCK;
}
const now = () => CLOCK;
const setClock = (t) => { CLOCK = t; return CLOCK; };
const advance = (ms) => { CLOCK += ms; return CLOCK; };

function advanceFiring(ms) {
  const target = CLOCK + ms;
  for (;;) {
    let nextId = null, nextAt = Infinity;
    for (const [id, t] of TIMERS) if (t.at <= target && t.at < nextAt) { nextId = id; nextAt = t.at; }
    if (nextId == null) break;
    const t = TIMERS.get(nextId);
    TIMERS.delete(nextId);
    CLOCK = t.at;
    t.fn();
  }
  CLOCK = target;
  return CLOCK;
}
const realClock = () => { Date.now = REAL_NOW; TIMERS.clear(); };

// ------------------------------------------------------------------------------------------------
// TRANSPORT STUB. Routes by URL; anything unrecognised is a hard failure, so no test can silently
// reach the network.
// ------------------------------------------------------------------------------------------------
const REVOKED_BODY = 'Token is invalid.';
const IDENTITY_BODY = JSON.stringify({ data: {
  currentTime: null, isCarrier: true,
  userInfo: { name: 'Test User', companyName: 'Best Roadways' },
  carrierBranches: [2667], branchList: { 956055: { branchId: 956055 } },
} });

const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => body });
const plaintext = (status, body) => async () => resp(status, body);
const OK_BID = () => resp(201, JSON.stringify({ data: { rank: 1 } }));
const OK_LIST = () => resp(200, JSON.stringify({ data: { loadDetails: [] } }));
const OK_BASE = () => resp(200, IDENTITY_BODY);
const DEAD = () => resp(401, REVOKED_BODY);

function transport({ bid, list, base } = {}) {
  const calls = { bid: [], list: [], base: [] };
  const impl = async (url, init) => {
    const u = String(url);
    if (u.includes('/sp/bids/createV2')) { calls.bid.push({ url: u, init }); return (bid || OK_BID)(u, init); }
    if (u.includes('/sp/loads/v4')) { calls.list.push({ url: u, init }); return (list || OK_LIST)(u, init); }
    if (u.includes('/sp/base/')) { calls.base.push({ url: u, init }); return (base || OK_BASE)(u, init); }
    throw new Error('AUTH HARNESS made an unexpected request: ' + u);
  };
  return { impl, calls };
}

/**
 * A real adapter over a stubbed transport, on the virtual clock and virtual timers.
 * `tokenLifeMs` sets how far the token's own exp sits from the current instant - the expiry tests
 * move it explicitly.
 */
function mkAdapter(fetchImpl, opts = {}) {
  const a = new RealSuperProcureAdapter(Object.assign({
    token: 'auth-harness-token', fetchImpl, accountId: 'primary', accountLabel: 'Primary',
    setTimeoutImpl: vSetTimeout, clearTimeoutImpl: vClearTimeout,
  }, opts));
  // A live-enough session so placeBid clears ensureSession and buildBidPayload resolves a carrier.
  // No login() is performed and no credential is real.
  a.account = { carrierId: 2667, tokenExp: Date.now() + (opts.tokenLifeMs != null ? opts.tokenLifeMs : 3_600_000),
    branchIds: [956055] };
  a.writeEnabled = true;
  return a;
}

const bid = (a) => a.placeBid(23795726, 26_000, { floor: 20_000 });

/** Latch an adapter with two back-to-back write 401s. */
async function latchWrites(a) { await bid(a); await bid(a); }

// ------------------------------------------------------------------------------------------------
// ENGINE HARNESS - the REAL engine over a programmable fake adapter. Only the platform seam is
// stubbed; no engine internal is touched.
// ------------------------------------------------------------------------------------------------
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `auth-harness-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } } };

function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function armFine(eng, ladder, { companyName = 'Havells', revisionsLeft = 30, extendCap = 5,
  triggerWindowMs = 100_000, id = 'F' } = {}) {
  const meta = { id, lane: { origin: 'A', destination: 'B' }, units: 1, companyName, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = triggerWindowMs;
  return m;
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

/** Program the engine's adapter seam with a scripted sequence of bid outcomes. */
function program(eng, kinds) {
  const box = { placed: [], calls: 0 };
  let i = 0;
  eng.adapter.placeBid = async (id, price) => {
    box.calls += 1;
    const kind = kinds[Math.min(i, kinds.length - 1)];
    i += 1;
    if (kind === '401') {
      return { accepted: false, status: 401, myRank: null, revisionsLeft: null,
        bidVehicleCount: null, amountPMT: null, bidQuantity: null, reason: 'session_logged_out',
        carrierSent: 2667, text: REVOKED_BODY, latencyMs: 12, raw: REVOKED_BODY };
    }
    if (kind === 'reject-other') {
      return { accepted: false, status: 400, reason: 'Bid difference too small.', text: 'Bid difference too small.' };
    }
    if (kind === 'throw-auth') { const e = new Error('token_expired'); e.code = 'AUTH'; throw e; }
    box.placed.push(price);
    return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
  };
  return box;
}

/** A latch-capable adapter stub for the engine harness, driven by plain flags. */
function fakeLatch({ dead = false, deadSince = null, episodeSince = null, held = null } = {}) {
  return {
    isAuthDead: () => dead,
    authDeadSince: () => deadSince,
    authEpisodeSince: () => episodeSince,
    authOutageSince: () => episodeSince,
    authWriteHeld: () => (held == null ? dead : held),
  };
}

module.exports = {
  freezeClock, realClock, advance, advanceFiring, now, setClock, pendingTimers,
  vSetTimeout, vClearTimeout,
  transport, plaintext, mkAdapter, bid, latchWrites,
  REVOKED_BODY, IDENTITY_BODY, OK_BID, OK_LIST, OK_BASE, DEAD, resp,
  mkEngine, armFine, state, alertsOfKind, program, fakeLatch, tmp, cleanup,
};
