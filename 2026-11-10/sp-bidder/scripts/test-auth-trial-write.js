'use strict';
/**
 * AUTH LATCH RECOVERY - the trial-write design, its clocks and its alerts.
 *
 * Companion to scripts/test-auth-fail-closed.js, which pins the DETECTION half of the 2026-08-04
 * session-death class (a 401 is not a price refusal, two consecutive ones latch the account, a
 * latched account does not churn the fire point). This file pins the RECOVERY half, which is where
 * two successive attempts at this fix went wrong:
 *
 *   attempt 1 - any success cleared the latch, so a write-scope revocation oscillated
 *               `latch -> login 200 -> unlatch -> write 401 -> write 401 -> latch` forever.
 *   attempt 2 - the latch was CLASSIFIED read-triggered or write-triggered from whichever failure
 *               happened to be second in the streak. Writes outnumber reads ~5:1 during a real
 *               outage, so a genuine full session death was overwhelmingly likely to be misfiled as
 *               write-scope and sealed permanently against its own self-heal probe.
 *
 * The shipped design does not classify. It PROVES: a latched account lets exactly ONE write per
 * authWriteTrialIntervalMs reach the wire, and only an ACCEPTED write clears the latch.
 *
 * What this file pins, in one sentence each:
 *   1. a latched account lets exactly one trial write per interval reach the wire, never more
 *   2. FULL SESSION DEATH that recovers: the trial write clears the latch and raises the all-clear
 *   3. WRITE-SCOPE-ONLY revocation: the latch never self-clears - and reads keep working, which is
 *      what stops "only a proven write clears" from being a deadlock
 *   4. two failures further apart than authStreakWindowMs do NOT latch (mocked clock)
 *   5. the outage identity survives a clear -> re-latch flap, and re-stamps for a genuinely new one
 *   6. the engine's 2h suppression clock cannot be rewound by a flap, and stops the moment the
 *      account is alive again
 *   7. a token inside its own final 60s cannot seal the account (a scheduled expiry is not a refusal)
 *   8. the probe cannot be re-armed on a discarded adapter, including mid-login()
 *   9. account_unresolved does not take the session-death fork
 *  10. the account-down alert is re-offered while the latch holds, so a dropped send is not final
 *  11. the all-clear reaches the notifier end-to-end through buildRealStack's own wiring shape
 *  12. the refusal-priority guard holds in both directions (ceiling kept; stale auth reason replaced)
 *  13. a shadow monitor never carries a session_logged_out reason to close
 *  14. a 90-second outage does not silence an unrelated load's alarm for the next two hours
 *
 * MOCK POLICY. Two harnesses, both offline and deterministic, and the same ones test-auth-fail-closed
 * uses: the REAL RealSuperProcureAdapter over a stubbed fetchImpl, and the REAL BidEngine over a
 * programmable fake adapter. Date.now is stubbed where a test needs elapsed time, so nothing sleeps.
 * This is live-money code: nothing here reaches a network and no real bid is ever placed.
 *
 *   node scripts/test-auth-trial-write.js
 */

process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter, PLACE_BID_ENVELOPE_KEYS } = require('../src/platform/realAdapter');
const { raiseAuthDead, raiseAuthRestored, raiseAuthConfirming } = require('../src/notify/authAlert');
const { templateFor, renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered above every check and fired on process exit.
// scripts/run-tests.js grades this file by EXIT CODE ALONE, so an async file that ends early - a
// swallowed rejection, a stray return - reaches exit 0 having asserted nothing and reads as a silent
// green. Registering the handler first is what makes it fire on every path out of the process.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 14;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `auth-trial-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// ------------------------------------------------------------------------------------------------
// DETERMINISTIC CLOCK. Every instant the latch machinery takes comes from Date.now(), so overriding
// it is what turns "two failures 61 seconds apart" and "the trial interval elapsed" into assertions
// rather than sleeps. Always paired with realClock() so one check can never leak a frozen clock into
// the next - a frozen clock is exactly the kind of cross-test coupling that reads as a flake.
// ------------------------------------------------------------------------------------------------
const REAL_NOW = Date.now;
let CLOCK = 0;

// VIRTUAL TIMERS, on the same clock. The resolve-side settle window and the liveness heartbeat are
// setTimeout-based, so a frozen Date.now() alone cannot reach them - and a test that reached them by
// sleeping 180 real seconds would not be run. The adapter takes its timer functions by injection for
// exactly this reason: the boundaries of the settle window are the thing this design turns on, and
// "nothing tests clock cross-products" is the diagnosed root cause of all three previous rounds.
//
// advance() moves the clock WITHOUT firing anything, which is what most checks want (a dormant probe
// must not inject login() calls into a wire-count assertion). advanceFiring() moves it and fires
// every timer that comes due, in due order, with the clock set to each timer's own instant.
const TIMERS = new Map();
let timerSeq = 0;
const vSetTimeout = (fn, ms) => { const id = ++timerSeq; TIMERS.set(id, { at: CLOCK + ms, fn }); return id; };
const vClearTimeout = (id) => { TIMERS.delete(id); };
const pendingTimers = () => TIMERS.size;

const freezeClock = (at) => {
  TIMERS.clear(); // never let one check's dormant timer fire inside the next one
  CLOCK = at != null ? at : REAL_NOW(); Date.now = () => CLOCK; return CLOCK;
};
const advance = (ms) => { CLOCK += ms; return CLOCK; };
const advanceFiring = (ms) => {
  const target = CLOCK + ms;
  for (;;) {
    let nextId = null, nextAt = Infinity;
    for (const [id, t] of TIMERS) if (t.at <= target && t.at < nextAt) { nextId = id; nextAt = t.at; }
    if (nextId == null) break;
    const t = TIMERS.get(nextId); TIMERS.delete(nextId);
    CLOCK = t.at;
    t.fn();
  }
  CLOCK = target;
  return CLOCK;
};
const realClock = () => { Date.now = REAL_NOW; TIMERS.clear(); };

const REVOKED_BODY = 'Token is invalid.';

// Imported rather than hand-copied - a local list is exactly what went stale here across a rebase
// that picked up #151's envelope change (bidRate). PLACE_BID_ENVELOPE_KEYS is the one place this
// project pins the shape; see its own doc comment for why widening it needs a deliberate decision.
const ENVELOPE_KEYS = PLACE_BID_ENVELOPE_KEYS;
const keysOf = (o) => Object.keys(o).sort();

// ================================================================================================
// HARNESS A - the REAL adapter over a stubbed transport. Routes by URL; any other path is a hard
// failure, so nothing can silently reach the network. `answer` is flipped by the checks to model
// SuperProcure changing its mind about this session.
// ================================================================================================
// The two /sp/base/ calls login() makes. carrierBranches + branchList are what let it resolve an
// identity; without them it fails account_unresolved (which check 9 drives deliberately).
const IDENTITY_BODY = JSON.stringify({ data: {
  currentTime: null, isCarrier: true,
  userInfo: { name: 'Test User', companyName: 'Best Roadways' },
  carrierBranches: [2667], branchList: { 956055: { branchId: 956055 } },
} });

function transport({ bid, list, base } = {}) {
  const calls = { bid: [], list: [], base: [] };
  const okBid = async () => ({ status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) });
  const okList = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { loadDetails: [] } }) });
  const okBase = async () => ({ status: 200, headers: { get: () => null }, text: async () => IDENTITY_BODY });
  const impl = async (url, init) => {
    const u = String(url);
    if (u.includes('/sp/bids/createV2')) { calls.bid.push({ url: u, init }); return (bid || okBid)(u, init); }
    if (u.includes('/sp/loads/v4')) { calls.list.push({ url: u, init }); return (list || okList)(u, init); }
    if (u.includes('/sp/base/')) { calls.base.push({ url: u, init }); return (base || okBase)(u, init); }
    throw new Error('AUTH TRIAL TEST made an unexpected request: ' + u);
  };
  return { impl, calls };
}

const plaintext = (status, body) => async () => ({ status, headers: { get: () => null }, text: async () => body });

function mkAdapter(fetchImpl, opts = {}) {
  const a = new RealSuperProcureAdapter(Object.assign({
    token: 'auth-trial-token', fetchImpl, accountId: 'primary', accountLabel: 'Primary',
    setTimeoutImpl: vSetTimeout, clearTimeoutImpl: vClearTimeout,
  }, opts));
  // A live-enough session so placeBid clears ensureSession and buildBidPayload resolves a carrier.
  // No login() is performed and no credential is real.
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  a.writeEnabled = true;
  return a;
}

const bid = (a) => a.placeBid(23795726, 26_000, { floor: 20_000 });

/** Latch an adapter with two back-to-back write 401s and assert it took. */
async function latch(a) {
  await bid(a); await bid(a);
  assert.strictEqual(a.isAuthDead(), true, 'precondition: the adapter is latched');
}

// ================================================================================================
// HARNESS B - the REAL engine over a programmable fake adapter (the platform seam is the only thing
// stubbed; no engine internal is touched). Byte-identical in shape to test-auth-fail-closed's.
// ================================================================================================
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
    box.placed.push(price);
    return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
  };
  return box;
}

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

/** A latch-capable adapter stub for the engine harness, driven by plain flags. */
function fakeLatch({ dead = false, deadSince = null, outageSince = null, held = null } = {}) {
  return {
    isAuthDead: () => dead,
    authDeadSince: () => deadSince,
    // BOTH episode accessors, matching scripts/lib/auth-harness.js's stub exactly. Without
    // authEpisodeSince every suppression-clock check in this file fell through to the SECOND rung of
    // _authDeadWithinBound's fallback chain (authEpisodeSince -> authOutageSince -> authDeadSince),
    // so the checks below asserted real behaviour on a path the live adapter never takes - the
    // primary rung was never exercised here at all. The two return the same fact by construction (the
    // episode IS the outage), so this changes no expectation, only which rung produces it.
    authEpisodeSince: () => outageSince,
    authOutageSince: () => outageSince,
    authWriteHeld: () => (held == null ? dead : held),
  };
}

(async () => {
  // ==============================================================================================
  // 1. ONE TRIAL WRITE PER INTERVAL - never zero, never two.
  //    This is the whole recovery mechanism. Zero trials is the round-2 bug (a sealed account with
  //    no way to ever obtain the proof that would unseal it); more than one per interval would put
  //    the 360-refusal incident back on the wire under a new name.
  // ==============================================================================================
  {
    freezeClock();
    try {
      const t = transport({ bid: plaintext(401, REVOKED_BODY) });
      const a = mkAdapter(t.impl);
      await latch(a);
      assert.strictEqual(t.calls.bid.length, 2, 'the two latching writes reached the wire');

      // Immediately after the latch: every write is refused locally, nothing touches the platform.
      for (let i = 0; i < 20; i++) await bid(a);
      assert.strictEqual(t.calls.bid.length, 2,
        'a freshly latched account issues NO further write - 20 attempts, zero wire calls');

      // ...and the first trial is a FULL interval away, not immediate: a trial the instant we latch
      // would only re-observe the two failures that just latched us.
      advance(a.authWriteTrialIntervalMs - 1);
      await bid(a);
      assert.strictEqual(t.calls.bid.length, 2, 'one millisecond short of the interval is still held');

      advance(1);
      const trial = await bid(a);
      assert.strictEqual(t.calls.bid.length, 3, 'the interval elapsed, so exactly ONE trial write reaches the wire');
      assert.deepStrictEqual(keysOf(trial), ENVELOPE_KEYS,
        'and a refused trial answers with the SAME envelope key set as every other rejection');
      assert.strictEqual(a.isAuthDead(), true, 'a trial that 401s leaves the account latched');

      // ...and the allowance is spent: the next 20 attempts are held again.
      for (let i = 0; i < 20; i++) await bid(a);
      assert.strictEqual(t.calls.bid.length, 3, 'the trial is spent - the next 20 attempts are held again');

      // Over the 38-minute 2026-08-04 window this is ~25 writes rather than the 360 that happened.
      advance(a.authWriteTrialIntervalMs); await bid(a);
      advance(a.authWriteTrialIntervalMs); await bid(a);
      assert.strictEqual(t.calls.bid.length, 5, 'and the cadence repeats: one further trial per interval');

      // CONCURRENCY. "One per interval" rests on the claim that the peek at the engine's gate and the
      // claim at the wire are one uninterrupted synchronous run, so two monitors ticking in the same
      // turn cannot both spend it. That is an assertion about the event loop, so it is EXECUTED here
      // rather than reasoned about: ten writes started before any of them awaits.
      advance(a.authWriteTrialIntervalMs);
      const before = t.calls.bid.length;
      await Promise.all(Array.from({ length: 10 }, () => bid(a)));
      assert.strictEqual(t.calls.bid.length, before + 1,
        'ten writes issued in the same turn spend the interval\'s ONE trial between them, not ten');
      a._stopAuthProbe();

      // ...and the same holds through the engine, where the peek and the claim sit in different files:
      // two monitors on one account, both ticking while the trial is due, still yield one wire write.
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m1 = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'C1' });
      const m2 = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'C2' });
      for (const m of [m1, m2]) { m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000; }
      const wire = { n: 0 };
      const shared = mkAdapter(transport({ bid: plaintext(401, REVOKED_BODY) }).impl);
      await latch(shared);
      advance(shared.authWriteTrialIntervalMs);
      eng.adapter.isAuthDead = () => shared.isAuthDead();
      eng.adapter.authWriteHeld = () => shared.authWriteHeld();
      eng.adapter.placeBid = async (id, price) => {
        // the real claim, at the real seam - only a claim that wins reaches the "wire"
        if (!shared._claimAuthWriteTrial()) {
          return { accepted: false, status: 401, myRank: null, revisionsLeft: null, reason: 'session_logged_out',
            text: REVOKED_BODY, latencyMs: 0, raw: null, carrierSent: null, bidVehicleCount: null,
            amountPMT: null, bidQuantity: null };
        }
        wire.n += 1;
        return { accepted: false, status: 401, myRank: null, revisionsLeft: null, reason: 'session_logged_out',
          text: REVOKED_BODY, latencyMs: 12, raw: REVOKED_BODY, carrierSent: 2667, bidVehicleCount: null,
          amountPMT: null, bidQuantity: null };
      };
      await Promise.all([eng._maybeBid(m1, state(50_000, 2)), eng._maybeBid(m2, state(50_000, 2))]);
      assert.strictEqual(wire.n, 1,
        'two monitors ticking together on one latched account produce exactly ONE trial write, not two');
      assert.strictEqual(m1.snipeFired, false, 'and the loser\'s fire-point spend is fully restored...');
      assert.strictEqual(m1.bidTimes.length, 0, '...including its runaway-cap slot');
      assert.strictEqual(m2.bidTimes.length, 0, 'for both of them');
      shared._stopAuthProbe();
    } finally { realClock(); }
    ok('a latched account lets exactly one trial write per interval reach the wire, never more');
  }

  // ==============================================================================================
  // 2. FULL SESSION DEATH THAT RECOVERS. Reads and writes both 401; SuperProcure later restores
  //    everything. The trial write is what discovers that, and an ACCEPTED write is the one
  //    observation that clears the latch - fully, unconditionally, once.
  // ==============================================================================================
  {
    freezeClock();
    try {
      let alive = false;
      const dead401 = { status: 401, headers: { get: () => null }, text: async () => REVOKED_BODY };
      const t = transport({
        bid: async () => (alive
          ? { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) }
          : dead401),
        list: async () => (alive
          ? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { loadDetails: [] } }) }
          : dead401),
        // login()'s own two GETs die with everything else - that is what "full session death" means.
        base: async () => (alive
          ? { status: 200, headers: { get: () => null }, text: async () => IDENTITY_BODY }
          : dead401),
      });
      const restored = [];
      const a = mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
      await latch(a);
      const outage = a.authOutageSince();
      assert.ok(Number.isFinite(outage), 'the outage identity is stamped at the latch');

      // Reads fail too - the shape of a genuine full death - and confirm nothing changes state.
      let readThrew = null;
      try { await a.listAuctions(); } catch (e) { readThrew = e; }
      assert.ok(readThrew && readThrew.code === 'AUTH', 'a read against a dead session still throws code AUTH');
      assert.strictEqual(a.authOutageSince(), outage, 'and does NOT re-stamp the outage identity');

      // A read success alone must NOT clear it - login() is two GETs and proves only that the token
      // authenticates. This is the round-1 bug, pinned in the direction it actually failed.
      alive = true;
      await a.login();
      assert.strictEqual(a.isAuthDead(), true,
        'THE ROUND-1 BUG: a login() success is a READ and cannot clear the latch on its own');
      assert.strictEqual(restored.length, 0, 'and raises no all-clear');

      // The trial write is what settles it.
      advance(a.authWriteTrialIntervalMs);
      const res = await bid(a);
      assert.strictEqual(res.accepted, true, 'the trial write is accepted now that the session is back');
      assert.strictEqual(a.isAuthDead(), false, 'THE CLEAR: a proven WRITE unlatches the account');
      assert.strictEqual(a.authDeadSince(), null, 'and drops the latch instant');
      assert.strictEqual(a._authProbeTimer, null, 'and stops the liveness heartbeat');

      // ...but the DESK is not told yet. The all-clear is debounced on the RESOLVE edge: it is
      // emitted only after the account has held CLEAR for the whole settle window, so a session that
      // is about to flap cancels a message that was never sent rather than contradicting a sent one.
      assert.strictEqual(restored.length, 0, 'no all-clear yet - the settle window has not elapsed');
      assert.strictEqual(a.authEpisodeSince(), outage,
        'and the EPISODE is still open, because an episode closes only when its all-clear is emitted');

      advanceFiring(a.authSettleMs - 1);
      assert.strictEqual(restored.length, 0, 'one millisecond short of the settle window: still silent');
      advanceFiring(1);

      // Exactly one all-clear, keyed to the EPISODE the down-alert named.
      assert.strictEqual(restored.length, 1, 'exactly one all-clear fires, once the window has fully elapsed');
      assert.strictEqual(restored[0].since, outage,
        'keyed to the EPISODE instant the down-alert used, so the pair closes the same message');
      assert.strictEqual(restored[0].accountId, 'primary', 'and carries the account id for the contact lookup');
      assert.strictEqual(restored[0].accountLabel, 'Primary', 'and the HUMAN label the desk copy renders');
      assert.strictEqual(a.authEpisodeSince(), null, 'and THAT emit is what closes the episode');

      // ...and normal bidding resumes with no trial gate in the way.
      const before = t.calls.bid.length;
      await bid(a); await bid(a);
      assert.strictEqual(t.calls.bid.length, before + 2, 'once clear, every write reaches the wire again');
    } finally { realClock(); }
    ok('a full session death that recovers clears on the trial write and raises exactly one all-clear');
  }

  // ==============================================================================================
  // 3. WRITE-SCOPE-ONLY REVOCATION. Reads keep working, writes do not. The latch must NEVER
  //    self-clear here - and, just as importantly, READS MUST KEEP WORKING while it holds.
  //
  //    The read half is not a nicety. If the latch sealed reads too, then: no reads -> no discovery
  //    -> no armed loads -> no write can ever be attempted -> the trial can never fire -> the latch
  //    can never clear. "Only a proven write clears" is a deadlock unless reads stay open. That is
  //    why ensureSession no longer checks the latch, and this is the check that says so.
  // ==============================================================================================
  {
    freezeClock();
    try {
      const t = transport({ bid: plaintext(401, REVOKED_BODY) }); // reads default to 200
      const restored = [];
      const a = mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
      await latch(a);
      const outage = a.authOutageSince();

      // Drive everything that could plausibly be mistaken for proof of recovery, repeatedly.
      for (let cycle = 0; cycle < 5; cycle++) {
        const loads = await a.listAuctions();
        assert.ok(Array.isArray(loads),
          'THE DEADLOCK-BREAKER: discovery keeps reading while the write latch holds');
        await a.login();
        assert.strictEqual(a.isAuthDead(), true, 'a login() success never clears a latch on any cycle');
        advance(a.authWriteTrialIntervalMs);
        await bid(a);                       // the trial write - still refused
        assert.strictEqual(a.isAuthDead(), true, 'and a refused trial write leaves it latched');
      }

      assert.strictEqual(restored.length, 0,
        'THE ROUND-2 REGRESSION, INVERTED: not one all-clear is minted across five full cycles');
      assert.strictEqual(a.authOutageSince(), outage,
        'the outage identity never moves, so the suppression clock keeps running down toward the bound');
      assert.strictEqual(a.authDeadSince(), outage, 'and the latch instant is never re-stamped either');
      assert.strictEqual(t.calls.bid.length, 2 + 5,
        'the wire saw the two latching writes plus exactly one trial per cycle - not one refusal more');
      a._stopAuthProbe();
    } finally { realClock(); }
    ok('a write-scope-only revocation stays sealed forever, while reads keep working (no deadlock)');
  }

  // ==============================================================================================
  // 4. THE STREAK WINDOW. Two auth responses further apart than authStreakWindowMs are two FIRST
  //    observations, not a confirmation. Without the window the streak is an unbounded counter reset
  //    only by a proven success, so on a quiet account "two consecutive" degrades to "two ever" and
  //    two unrelated transient 401s hours apart stop a healthy account exactly as a real revocation
  //    does. test-auth-fail-closed fires its pair back-to-back and structurally cannot see this.
  // ==============================================================================================
  {
    freezeClock();
    try {
      const t = transport({ bid: plaintext(401, REVOKED_BODY) });
      const a = mkAdapter(t.impl);

      await bid(a);
      assert.strictEqual(a.isAuthDead(), false, 'one 401 does not latch');

      advance(a.authStreakWindowMs + 1);
      await bid(a);
      assert.strictEqual(a.isAuthDead(), false,
        'THE WINDOW: a second 401 more than authStreakWindowMs later is a fresh first observation, not a latch');

      advance(a.authStreakWindowMs + 1);
      await bid(a);
      assert.strictEqual(a.isAuthDead(), false, 'and a third, equally far apart, still does not latch');

      // ...while a genuine revocation - two inside the window - still latches immediately.
      advance(1_000);
      await bid(a);
      assert.strictEqual(a.isAuthDead(), true,
        'but two failures INSIDE the window still latch, so the guard costs no detection speed');
      a._stopAuthProbe();
    } finally { realClock(); }
    ok('two auth failures further apart than the streak window do NOT latch the account');
  }

  // ==============================================================================================
  // 5. THE OUTAGE IDENTITY. Both alert dedupe keys and the engine's suppression clock hang off this
  //    one value, and it has to answer two OPPOSITE questions correctly:
  //      - a clear -> re-latch flap inside one outage is the SAME outage (one message pair, and a
  //        clock that cannot be rewound), and
  //      - a genuinely later revocation is a NEW outage (its own message, its own full 2h budget).
  //    Keying off the per-latch instant gets the first wrong; never re-stamping gets the second
  //    wrong. Both directions are asserted here.
  // ==============================================================================================
  {
    freezeClock();
    try {
      let answer = 'auth';
      const t = transport({ bid: async () => (answer === 'auth'
        ? { status: 401, headers: { get: () => null }, text: async () => REVOKED_BODY }
        : { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) }) });
      const dead = [], restored = [];
      const a = mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p), onAuthRestored: (p) => restored.push(p) });

      await latch(a);
      const outage1 = a.authEpisodeSince();
      assert.strictEqual(dead.length, 1, 'the episode opens with one down-alert');

      // --- FLAP: clear on a trial write, then re-latch before the settle window elapses.
      //
      // THIS IS THE STRUCTURAL POINT OF THE RESOLVE-SIDE DEBOUNCE. The clear ARMS an all-clear; the
      // re-latch CANCELS it. There is therefore no delivered "back online" for the re-latch to
      // contradict, and no sent-marked all-clear key for a later message to collide with. The
      // previous shape emitted on the clear and then had to reason about what a re-latch did to an
      // already-delivered message - which is where it went wrong.
      advance(a.authWriteTrialIntervalMs);
      answer = 'ok';
      await bid(a);
      assert.strictEqual(a.isAuthDead(), false, 'the trial write cleared it');
      assert.ok(pendingTimers() > 0, 'and ARMED an all-clear rather than sending one');
      answer = 'auth';
      advance(5_000);
      await bid(a); await bid(a);
      assert.strictEqual(a.isAuthDead(), true, 're-latched five seconds later');
      assert.strictEqual(restored.length, 0,
        'THE COLLISION CLASS, STRUCTURALLY ABSENT: the flap cancelled a message that was never sent');
      assert.strictEqual(a.authEpisodeSince(), outage1,
        'SAME EPISODE: the identity never moved, so the suppression clock cannot be rewound');
      assert.notStrictEqual(a.authDeadSince(), outage1,
        '...even though this is genuinely a different LATCH, with its own instant');

      // ...and letting the full settle window run from HERE still emits nothing, because the account
      // is latched again: the timer was cancelled, not merely deferred.
      advanceFiring(a.authSettleMs * 2);
      assert.strictEqual(restored.length, 0, 'and no all-clear appears later either - it was cancelled outright');

      // The dedupe keys the raisers build are what the guarantee actually rides on.
      const sent = [];
      const fakeNotifier = { alert: async (kind, payload, opts) => { sent.push({ kind, payload, opts }); } };
      for (const p of dead) raiseAuthDead(fakeNotifier, p);
      const deadKeys = new Set(sent.filter((s) => s.payload.authDead).map((s) => s.opts.dedupeKey));
      assert.strictEqual(deadKeys.size, 1,
        'every down-alert in one episode shares ONE dedupe key, so the notifier collapses the flap to one message');

      // --- A GENUINELY NEW EPISODE. It requires the first one to have CLOSED, which means its
      //     all-clear was actually emitted - the episode's whole definition.
      advance(a.authWriteTrialIntervalMs);
      answer = 'ok';
      await bid(a);
      assert.strictEqual(a.isAuthDead(), false, 'cleared again');
      advanceFiring(a.authSettleMs);
      assert.strictEqual(restored.length, 1, 'this time the window elapses undisturbed and the all-clear goes out');
      assert.strictEqual(restored[0].since, outage1, 'closing the SAME episode the down-alert opened');
      assert.strictEqual(a.authEpisodeSince(), null, 'which closes the episode');

      advance(60_000);
      answer = 'auth';
      await bid(a); await bid(a);
      assert.strictEqual(a.isAuthDead(), true, 'and latched again much later');
      const outage2 = a.authEpisodeSince();
      assert.notStrictEqual(outage2, outage1,
        'NEW EPISODE: a latch after the previous one closed gets its own identity, so its own alert...');
      assert.ok(outage2 > outage1, '...and a full, fresh suppression budget rather than an inherited spent one');
      assert.strictEqual(dead.length, 2, 'and exactly one further down-alert - two episodes, two messages');

      const sent2 = [];
      const n2 = { alert: async (kind, payload, opts) => { sent2.push(opts.dedupeKey); } };
      raiseAuthDead(n2, dead[0]); raiseAuthDead(n2, dead[dead.length - 1]);
      assert.strictEqual(new Set(sent2).size, 2,
        'and its key differs from the first episode\'s, so the permanent sent-mark cannot swallow it');
      a._stopAuthProbe();
    } finally { realClock(); }
    ok('the episode identity folds a flap into one outage and opens a fresh one only after the all-clear');
  }

  // ==============================================================================================
  // 6. THE SUPPRESSION CLOCK, at the engine. Two independent failure modes, both real:
  //      (a) measured against the per-latch instant, an oscillating latch restarts it forever and
  //          the zero-bid alarm NEVER resumes - the 2026-07-13 silence, re-created by the backstop
  //          written to prevent it;
  //      (b) with no liveness conjunct it keeps suppressing for up to 2h after the account is
  //          demonstrably healthy, silencing loads that closed for entirely unrelated reasons.
  // ==============================================================================================
  {
    const finalizeWith = async (adapterStub, { blocked = true } = {}) => {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      Object.assign(eng.adapter, adapterStub);
      eng.adapter.getAuctionState = async () => ({ ok: false });
      m.authBlockedLast = blocked;
      await eng._finalize(m, state(0, null));
      return eng;
    };
    const now = Date.now();

    // (a) A flap cannot rewind the clock: the latch instant is seconds old, the OUTAGE is 2h+ old,
    //     and the alarm must resume off the outage.
    const flapped = await finalizeWith(fakeLatch({
      dead: true, deadSince: now - 5_000, outageSince: now - (7_200_000 + 60_000),
    }));
    assert.strictEqual(alertsOfKind(flapped, 'never_bid_before_close').length, 1,
      'THE ROUND-2 BUG: the bound is measured against the OUTAGE, so a fresh re-latch cannot rewind it');

    // ...and inside the bound it still suppresses, so the fix did not simply disable the feature.
    const young = await finalizeWith(fakeLatch({
      dead: true, deadSince: now - 5_000, outageSince: now - 60_000,
    }));
    assert.strictEqual(alertsOfKind(young, 'never_bid_before_close').length, 0,
      'a genuinely young outage still suppresses - 56 symptom messages still become one cause message');

    // (b) The liveness conjunct: a stale monitor flag on a HEALTHY account suppresses nothing.
    const healed = await finalizeWith(fakeLatch({
      dead: false, deadSince: null, outageSince: now - 60_000,
    }));
    assert.strictEqual(alertsOfKind(healed, 'never_bid_before_close').length, 1,
      'THE LIVENESS GAP: a stale authBlockedLast on a recovered account no longer buys a 2h blackout');

    // ...and an adapter with no latch surface at all is completely unaffected (feature detection
    // fails toward the ALARM), which is what keeps every other zero-bid test in the suite green.
    const plain = await finalizeWith({});
    assert.strictEqual(alertsOfKind(plain, 'never_bid_before_close').length, 1,
      'an adapter without the latch methods suppresses nothing');
    ok('the suppression clock cannot be rewound by a flap, and stops the moment the account is alive');
  }

  // ==============================================================================================
  // 7. A SCHEDULED TOKEN EXPIRY IS NOT A SUPERPROCURE REFUSAL.
  //    ensureSession throws inside a token's final 60s. Routed through the failure streak as a
  //    write-origin failure, TWO ordinary bid attempts in that final minute permanently sealed the
  //    account - deterministic, needing no external condition, and with no automatic recovery. The
  //    condition already has its own alert path (src/notify/tokenExpiry.js); it must not also latch.
  // ==============================================================================================
  {
    freezeClock();
    try {
      const t = transport({ bid: plaintext(201, JSON.stringify({ data: { rank: 1 } })) });
      const dead = [];
      const a = mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p) });
      a.account.tokenExp = Date.now() + 30_000; // inside the 60s pre-expiry guard

      const r1 = await bid(a);
      const r2 = await bid(a);

      assert.strictEqual(r1.accepted, false, 'the write is still refused - an expiring token cannot bid');
      assert.deepStrictEqual(keysOf(r1), ENVELOPE_KEYS,
        'and it is the NON-THROWING rejection envelope, so the engine cannot fabricate a landed bid');
      assert.strictEqual(r2.accepted, false, 'and so is the second attempt');
      assert.strictEqual(a.isAuthDead(), false,
        'THE SELF-INFLICTED DoS: two bid attempts in a token\'s final minute must NOT seal the account');
      assert.strictEqual(a._writeStreak, 0, 'the scheduled expiry never entered the WRITE streak at all');
      assert.strictEqual(a._readStreak, 0, 'nor the read streak - it is not evidence about either capability');
      assert.strictEqual(dead.length, 0, 'and raised no session-death alarm about a token nobody revoked');
      assert.strictEqual(t.calls.bid.length, 0, 'no payload was built and no write reached the wire');

      // ...and the READ path keeps its throwing contract for the same condition, which discovery and
      // getAuctionState both already handle, and which tokenExpiry.js alerts on separately.
      let threw = null;
      try { await a.ensureSession(); } catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'AUTH', 'the read path still gets a thrown code AUTH');
      assert.strictEqual(threw.authReason, 'token_expiring',
        'tagged with the reason that keeps it out of the streak - an untagged future condition still latches');
    } finally { realClock(); }
    ok('a token inside its own final 60s refuses writes without ever sealing the account');
  }

  // ==============================================================================================
  // 8. THE PROBE CANNOT BE RE-ARMED ON A DISCARDED ADAPTER.
  //    `tick` nulls the timer handle BEFORE awaiting login(), so for up to ~12s a handle-only stop is
  //    a silent no-op and the completion handler re-arms a probe on a stack the operator has already
  //    reconnected away from - a discarded adapter re-authenticating a known-dead token every 90s for
  //    the life of the pm2 process, on a live shared account.
  // ==============================================================================================
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // The REAL timer drives this, on a 1ms cadence, with login() held open by a promise the check
    // releases. Simulating the window by hand (nulling the handle and never running `tick`) asserts
    // nothing at all: the re-arm lives in `tick`'s own .then(), so the tick has to actually run.
    // A shortened cadence is also what makes a re-arm LOUD - if the probe comes back it ticks again
    // within milliseconds and the login counter moves.
    const mkStalled = async () => {
      // REAL timers here on purpose: this check is about what `tick` does across its own await, so
      // the tick has to actually run on the event loop rather than be stepped by hand.
      const a = mkAdapter(transport({ bid: plaintext(401, REVOKED_BODY) }).impl,
        { setTimeoutImpl: null, clearTimeoutImpl: null });
      a.authProbeIntervalMs = 1;
      let release;
      const inFlight = new Promise((r) => { release = r; });
      const calls = { login: 0 };
      a.login = () => { calls.login += 1; return inFlight.then(() => { throw new Error('still dead'); }); };
      await latch(a);
      assert.ok(a._authProbeTimer, 'the liveness heartbeat is armed while latched');
      await sleep(15);
      assert.strictEqual(calls.login, 1, 'the heartbeat ticked and its login() is in flight');
      assert.strictEqual(a._authProbeTimer, null,
        'THE WINDOW: `tick` nulls the handle BEFORE awaiting, so a handle-only stop has nothing to clear here');
      return { a, calls, release };
    };

    // (i) teardownStack, mid-login. This is r1 Finding 5's exact scenario: reconnect is precisely the
    //     action an operator takes BECAUSE the account is latched, so teardown and the probe cycle
    //     are not independent events.
    {
      const { a, calls, release } = await mkStalled();
      a._stopAuthProbe({ permanent: true });
      release();
      await sleep(20);
      assert.strictEqual(calls.login, 1,
        'THE LEAK: a torn-down adapter must NOT issue another login - it would re-authenticate a '
        + 'known-dead token every cycle for the life of the pm2 process, on a live shared account');
      assert.strictEqual(a._authProbeTimer, null, 'and no timer is left armed on it');
      a._startAuthProbe();
      assert.strictEqual(a._authProbeTimer, null, 'a discarded adapter can never be re-armed at all');
    }

    // (ii) a PLAIN stop, mid-login, with the latch still set - so neither `authProbeEnabled` nor the
    //      derived-state test can be what holds it. The stop flag alone has to.
    {
      const { a, calls, release } = await mkStalled();
      a._stopAuthProbe();
      assert.strictEqual(a.authProbeEnabled, true, 'a plain stop does not revoke the permission...');
      assert.strictEqual(a.isAuthDead(), true, '...and the latch that would justify a re-arm is still set');
      release();
      await sleep(20);
      assert.strictEqual(calls.login, 1,
        'yet the stopped probe stays stopped - the FLAG, not the handle, is what a mid-login stop rides on');
      assert.strictEqual(a._authProbeTimer, null, 'with no timer left behind');
      a._stopAuthProbe({ permanent: true });
    }

    // ...but a NON-permanent stop (what a latch clear does) must still allow a later, genuine latch
    // to arm a fresh heartbeat, or the second outage on a long-lived adapter runs blind.
    const b = mkAdapter(transport({ bid: plaintext(401, REVOKED_BODY) }).impl);
    await latch(b);
    b._noteWriteSuccess();                        // a clear stops the probe, non-permanently
    assert.strictEqual(b.isAuthDead(), false, 'cleared');
    assert.strictEqual(b._authProbeTimer, null, 'and the heartbeat stopped');
    await bid(b); await bid(b);
    assert.strictEqual(b.isAuthDead(), true, 'a later outage latches again');
    assert.ok(b._authProbeTimer, 'and DOES arm a fresh heartbeat - the stop flag is per-cycle, not permanent');
    b._stopAuthProbe();
    ok('the probe cannot be re-armed on a discarded adapter, and a later latch still re-arms a live one');
  }

  // ==============================================================================================
  // 9. account_unresolved IS NOT A DEAD SESSION.
  //    login() reaches that branch only after BOTH prior calls returned 200 with valid JSON - the
  //    session provably authenticated twice - so it is a data/permissions problem. Coded AUTH it
  //    routed into the boot path's session-death copy ("SuperProcure has logged this account out ...
  //    quote these loads from the portal"), pointing the reader at a Reconnect that cannot fix it.
  // ==============================================================================================
  {
    // Both /sp/base/ calls answer 200 with valid JSON - the session provably authenticates twice -
    // but getHeader carries no carrierBranches and no branchList, so no identity can be resolved.
    const noScope = async () => ({
      status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ data: { isCarrier: true, userInfo: { name: 'X' } } }),
    });
    const a = mkAdapter(transport({ base: noScope }).impl);
    a.account = null;
    let threw = null;
    try { await a.login(); } catch (e) { threw = e; }
    assert.ok(threw, 'an account that resolves no carrierId and no branchIds still fails loudly');
    assert.ok(/account_unresolved/.test(threw.message), 'and still says why');
    assert.strictEqual(threw.code, 'ACCOUNT_UNRESOLVED',
      'THE WRONG-REMEDY ALERT: it carries its own code, so the boot fork sends the generic alarm...');
    assert.notStrictEqual(threw.code, 'AUTH',
      '...not the "your login is logged out, reconnect it" copy for a mapping problem a reconnect cannot fix');
    assert.strictEqual(a.isAuthDead(), false, 'and it latches nothing');
    ok('account_unresolved carries its own error code and never takes the session-death fork');
  }

  // ==============================================================================================
  // 10. THE DOWN-ALERT IS RE-OFFERED WHILE THE LATCH HOLDS.
  //     raiseAuthDead is edge-triggered once per outage and rides HEALTH_POLICY 'drop' - skip and
  //     discard, no retry - so if the Maytapi sender is logged out at the instant the latch trips (a
  //     documented recurring incident on this deployment) the ONE message replacing 56 symptom
  //     messages is lost outright, while the 2h suppression it authorises holds anyway.
  //
  //     The re-offer costs nothing when the first message landed: the dedupe key is keyed to the
  //     OUTAGE and is therefore identical, and notifier._markSent writes its permanent sent-mark only
  //     when a send actually reached somebody - so a delivered message dedupes the retry to zero.
  // ==============================================================================================
  {
    freezeClock();
    try {
      const t = transport({ bid: plaintext(401, REVOKED_BODY) });
      const dead = [];
      const a = mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p) });
      await latch(a);
      assert.strictEqual(dead.length, 1, 'the latch raises exactly one alert');

      // Refusals inside the cadence do not re-offer - 360 of them still raise once.
      for (let i = 0; i < 50; i++) await bid(a);
      advance(a.authDeadReAlertMs - 1);
      await bid(a);
      assert.strictEqual(dead.length, 1, 'and stays edge-triggered inside the re-alert cadence');

      advance(2);
      await bid(a);
      assert.strictEqual(dead.length, 2, 'past the cadence the alert is RE-OFFERED, so a dropped send is not final');
      assert.strictEqual(dead[1].since, dead[0].since,
        'with the SAME outage key - a delivered first message dedupes this to nothing, an undelivered one does not');

      // The dedupe key proves it: the raiser builds one key for both offers.
      const sent = [];
      const n = { alert: async (kind, payload, opts) => { sent.push(opts.dedupeKey); } };
      for (const p of dead) raiseAuthDead(n, p);
      assert.strictEqual(new Set(sent).size, 1, 'both offers build the identical dedupe key');
      a._stopAuthProbe();
    } finally { realClock(); }
    ok('the account-down alert is re-offered on a bounded cadence, under one outage-keyed dedupe key');
  }

  // ==============================================================================================
  // 11. THE ALL-CLEAR REACHES THE NOTIFIER, END TO END, through the SAME wiring shape buildRealStack
  //     uses. Every other alert surface in this change has an assertion; without this one a typo in
  //     templateFor's flag check, a wrong placeholder index or broken wiring ships silently and the
  //     desk never gets the "back online" message until a live outage exposes the silence.
  // ==============================================================================================
  {
    let answer = 'auth';
    const t = transport({ bid: async () => (answer === 'auth'
      ? { status: 401, headers: { get: () => null }, text: async () => REVOKED_BODY }
      : { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) }) });

    const sent = [];
    const notifier = { alert: async (kind, payload, opts) => { sent.push({ kind, payload, opts }); } };
    // Byte-for-byte the closure shape src/web/server.js buildRealStack installs.
    const a = mkAdapter(t.impl, {
      onAuthDead: (p) => raiseAuthDead(notifier, p),
      onAuthRestored: (p) => raiseAuthRestored(notifier, p),
    });

    let back, down;
    freezeClock();
    try {
      await latch(a);
      advance(120_000);                       // past the trial interval, and a downtime worth rendering
      answer = 'ok';
      const res = await bid(a);
      assert.strictEqual(res.accepted, true, 'the proven write lands');
      assert.strictEqual(sent.filter((s) => s.payload && s.payload.authRestored).length, 0,
        'and still nothing is sent - the all-clear waits out the settle window');
      advanceFiring(a.authSettleMs);
      back = sent.find((s) => s.payload && s.payload.authRestored);
      down = sent.find((s) => s.payload && s.payload.authDead);
    } finally { realClock(); }

    assert.ok(back, 'an all-clear reaches the notifier');
    assert.strictEqual(back.kind, 'error',
      "it routes as the EXISTING 'error' kind - a new subscription kind would reach strictly fewer people");
    assert.strictEqual(back.payload.accountId, 'primary', 'the payload carries the account id...');
    assert.strictEqual(back.payload.accountLabel, 'Primary', '...and the HUMAN label the copy renders');
    assert.strictEqual(back.payload.downForMs, 120_000,
      'and the downtime measured from the EPISODE to the ACCEPTED WRITE that proved recovery - not '
      + 'to this emit, which sits a further authSettleMs later. The settle window is our own '
      + 'confidence-building delay; billing it to the outage adds a flat three minutes to every '
      + 'number the desk reads, and on a short blip that is most of the number');
    assert.ok(down, 'the down-alert reached it too');
    assert.strictEqual(back.opts.dedupeKey, `sp_auth_restored_primary_${down.payload.since}`,
      'and the all-clear key is tied to the SAME episode instant the down-alert was keyed to');
    assert.ok(sent.every((s) => s.payload.shipper === undefined && s.payload.auctionId === undefined),
      'neither message carries load or shipper scope keys - these are account facts, not a customer\'s load');

    // ...and the template layer actually selects and renders the all-clear copy.
    assert.strictEqual(templateFor('error', back.payload), 'account_auth_restored',
      'templateFor resolves the authRestored flag to the all-clear template');
    assert.strictEqual(templateFor('error', down.payload), 'account_auth_dead', 'and the dead flag to its counterpart');
    const body = renderMessage('account_auth_restored', back.payload);
    assert.ok(/Primary/.test(body), 'the rendered message names the account by its human label');
    assert.ok(/2 min/.test(body), 'and states the downtime in whole minutes rather than an epoch');
    assert.ok(!/undefined|NaN|\{\{/.test(body), 'with no unresolved placeholder, undefined or NaN reaching the desk');

    // ...and so does the PROVISIONAL message, the third surface in this family and the one a RECONNECT
    // sends. It must not read as an all-clear: a reconnect proves a login and not a write, so the
    // hand-quoting instruction has to stay up until an accepted bid retracts it.
    const confirmSent = [];
    raiseAuthConfirming({ alert: async (kind, payload, opts) => { confirmSent.push({ kind, payload, opts }); } },
      { accountId: 'primary', accountLabel: 'Primary', since: down.payload.since });
    assert.strictEqual(confirmSent.length, 1, 'the provisional reconnect message reaches the notifier');
    assert.strictEqual(confirmSent[0].kind, 'error', "and rides the same existing 'error' kind");
    assert.strictEqual(confirmSent[0].opts.dedupeKey, `sp_auth_confirming_primary_${down.payload.since}`,
      'keyed to the EPISODE, so a second reconnect attempt inside one outage does not re-send it');
    assert.strictEqual(templateFor('error', confirmSent[0].payload), 'account_auth_reconnecting',
      'templateFor resolves the authConfirming flag to the provisional template');
    const cbody = renderMessage('account_auth_reconnecting', confirmSent[0].payload);
    assert.ok(/keep quoting/i.test(cbody),
      'and the copy KEEPS the hand-quoting instruction - a reconnect is not evidence a bid will land');
    assert.ok(!/no more manual quoting/i.test(cbody), 'it must never read as the all-clear it is not');
    // 2026-09-16 length trim: the client flagged this one as too long and formal.
    assert.ok(!/until we confirm a bid lands/i.test(cbody), 'and drops the old wordier phrasing');
    assert.ok(cbody.indexOf('undefined') < 0 && cbody.indexOf('NaN') < 0 && cbody.indexOf('{{') < 0,
      'with nothing unresolved reaching the desk');
    ok('the all-clear reaches the notifier and renders, through buildRealStack\'s own wiring shape');
  }

  // ==============================================================================================
  // 12. THE REFUSAL-PRIORITY GUARD, both directions. monitor.noBid is last-writer-wins and drives the
  //     desk's close-time receipt - the one artifact this whole change exists to keep honest.
  //       forward:  an account-wide outage must not erase a load's own terminal price refusal;
  //       backward: a stale session_logged_out must not outlive the outage and mislabel a load that
  //                 later closed on price.
  //     Also pinned: a load with real wire history is never stamped session_logged_out at all, because
  //     ordinary price/state rejections (HTTP 400) never record a refusal and so have nothing for the
  //     `!monitor.noBid` guard to protect.
  // ==============================================================================================
  {
    // --- forward: a recorded ceiling stand-down survives an outage that outlasts it
    {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      const box = program(eng, ['ok']);
      Object.assign(eng.adapter, fakeLatch({ dead: true }));
      m.noBid = { reason: 'ceiling_below_floor', ceiling: 26_000, floor: 27_000 };

      await eng._maybeBid(m, state(50_000, 2));
      await eng._maybeBid(m, state(9_000, 2));

      assert.strictEqual(box.calls, 0, 'the account gate held the load');
      assert.strictEqual(m.noBid.reason, 'ceiling_below_floor',
        'THE GUARD: the load\'s own terminal refusal is NOT overwritten by the account-wide condition');
      assert.strictEqual(m.noBid.ceiling, 26_000, 'and the ceiling fact the desk receipt renders survives...');
      assert.strictEqual(m.noBid.floor, 27_000, '...along with the floor it was compared against');
    }

    // --- backward: a stale session_logged_out is replaced by the reason that is actually true at close
    {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
      const box = program(eng, ['reject-other']);
      const live = fakeLatch({ dead: true });
      Object.assign(eng.adapter, live);

      await eng._maybeBid(m, state(50_000, 2));
      assert.ok(m.noBid && m.noBid.reason === 'session_logged_out', 'the outage records its cause');
      assert.strictEqual(m.authBlockedLast, true, 'and marks the load');

      // recover, then refuse on genuine price grounds
      eng.adapter.isAuthDead = () => false;
      eng.adapter.authWriteHeld = () => false;
      await eng._maybeBid(m, state(50_000, 2));

      assert.strictEqual(box.calls, 1, 'the load bids on the first tick after recovery');
      assert.strictEqual(m.authBlockedLast, false, 'the auth mark is dropped');
      assert.ok(!m.noBid,
        'THE STICKY RECORD: the stale session_logged_out is gone, so the receipt cannot report a cause that ended');
      await eng._finalize(m, state(0, null));
      const outcome = eng._events.filter((e) => e.type === 'auction_result')[0];
      assert.strictEqual(outcome.noBidReason, null,
        'and the close-time receipt no longer blames a session outage for a load refused on price');
    }

    // --- a load with real wire history is never stamped with the account-wide cause at all
    {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
      program(eng, ['reject-other']);

      await eng._maybeBid(m, state(50_000, 2));            // a real HTTP 400 price refusal
      assert.ok(m.ownBidAttempts > 0, 'the load really used the wire');
      assert.ok(!m.noBid, 'and an ordinary price rejection records no refusal at all (nothing to protect)');

      Object.assign(eng.adapter, fakeLatch({ dead: true }));
      await eng._maybeBid(m, state(9_000, 2));
      assert.ok(!m.noBid,
        'THE OVERWRITE: a load with real wire history is not stamped session_logged_out - "the rate was '
        + 'not the problem" is a lie on a load whose rate was exactly the problem');

      // ONE PREDICATE, BOTH FIELDS. The suppression flag is decided by the SAME test as the record, so
      // a load whose receipt correctly does NOT blame the outage also does not have its alarm silenced
      // by the outage. Guarding only the record left the two disagreeing about the same load: the desk
      // got a correct non-auth receipt and no alarm to go with it.
      assert.strictEqual(m.authBlockedLast, false,
        'THE DECOUPLING: the suppression flag follows the record, so this load is not silenced either');

      // ...and end-to-end, that means it still alarms. This is the whole point of the coupling.
      await eng._finalize(m, state(0, null));
      assert.strictEqual(alertsOfKind(eng, 'never_bid_before_close').length, 1,
        'so a load that tried, was refused on price, and closed empty still raises its own alarm '
        + 'even though the account happened to be latched at close');
    }

    // --- ...while a load whose OWN write hit the auth wall IS marked, from direct per-load evidence
    //     rather than an account-wide inference. Same predicate, the `direct` arm.
    {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
      program(eng, ['reject-other', '401']);

      await eng._maybeBid(m, state(50_000, 2));            // a real HTTP 400 price refusal first
      assert.ok(m.ownBidAttempts > 0, 'the load has genuine wire history...');
      assert.strictEqual(m.authBlockedLast, false, '...and is not auth-blocked by it');

      await eng._maybeBid(m, state(9_000, 2));             // ...then its own write hits the auth wall
      assert.ok(m.noBid && m.noBid.reason === 'session_logged_out',
        'DIRECT evidence outranks the wire history: this load\'s own write was refused at the auth wall');
      assert.strictEqual(m.authBlockedLast, true, 'and the flag agrees with the record, as it must');
    }
    ok('the refusal-priority guard holds in both directions and spares a load with real wire history');
  }

  // ==============================================================================================
  // 13. A SHADOW MONITOR NEVER CARRIES A session_logged_out REASON.
  //     Shadow is the default mode for every freshly-enrolled soft-close shipper and performs ZERO
  //     wire writes by construction, so an account-wide WRITE latch says nothing about it. The shadow
  //     branch returns without ever reaching the fire point where the auth record is cleared, so a
  //     monitor that touched even a brief blip carried a permanently stale reason - and _refusalAtClose
  //     checks monitor.noBid BEFORE the shadow_strategy fallback, so the stale reason always won at
  //     close. That is the exact bug class PR #115 (SIKA 23534893) was built to close.
  // ==============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'shadow', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.softStrategy = 'shadow';
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['ok']);
    Object.assign(eng.adapter, fakeLatch({ dead: true }));

    await eng._maybeBid(m, state(50_000, 2));

    assert.strictEqual(box.calls, 0, 'shadow places nothing, outage or not - that is its whole definition');
    assert.ok(!m.noBid,
      'THE PR #115 REGRESSION: an account-wide WRITE latch records nothing on a monitor that never writes');
    assert.ok(!m.authBlockedLast, 'nor marks it as auth-blocked');
    assert.ok(eng._events.some((e) => e.type === 'shadow_decision'),
      'and the validation harness keeps observing through the outage instead of going dark');

    await eng._finalize(m, state(0, null));
    const outcome = eng._events.filter((e) => e.type === 'auction_result')[0];
    assert.strictEqual(outcome.noBidReason, 'shadow_strategy',
      'so the close-time reason is the true one, not a stale session_logged_out that outlived the blip');
    assert.strictEqual(alertsOfKind(eng, 'never_bid_before_close').length, 0,
      'and a shadow close is still a deliberate zero-bid, not an alarm');
    ok('a shadow monitor is untouched by the account write latch and closes as shadow_strategy');
  }

  // ==============================================================================================
  // 14. A 90-SECOND OUTAGE MUST NOT SILENCE AN UNRELATED LOAD FOR THE NEXT TWO HOURS.
  //     monitor.authBlockedLast was set at the auth gate but cleared only at the fire point, which is
  //     one specific way out of _maybeBid among several a load can legitimately take for the rest of
  //     its life. A load that ticked during a brief blip and afterwards returned at an intervening
  //     gate (here: no revisions left) carried the flag to close, and with a pure time bound the
  //     alarm stayed suppressed for the full two hours on a demonstrably healthy account.
  // ==============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    const outageAt = Date.now() - 60_000;              // well inside the 2h bound
    Object.assign(eng.adapter, fakeLatch({ dead: true, deadSince: outageAt, outageSince: outageAt }));
    eng.adapter.getAuctionState = async () => ({ ok: false });
    program(eng, ['ok']);

    await eng._maybeBid(m, state(50_000, 2));
    assert.strictEqual(m.authBlockedLast, true, 'the load ticked during the outage and was marked');

    // The account recovers - and this load never reaches the fire point again, because its budget is
    // now gone. That intervening gate is the whole point of the check.
    eng.adapter.isAuthDead = () => false;
    eng.adapter.authWriteHeld = () => false;
    m.revisionsLeft = 0;
    await eng._maybeBid(m, state(9_000, 2));
    assert.strictEqual(m.authBlockedLast, false,
      'THE CLEAR SITE: the mark is dropped at the TOP of _maybeBid, not only at a fire point this load never reaches');

    await eng._finalize(m, state(0, null));
    assert.strictEqual(alertsOfKind(eng, 'never_bid_before_close').length, 1,
      'so a load that closed with zero bids for an unrelated reason still raises its alarm');
    const outcome = eng._events.filter((e) => e.type === 'auction_result')[0];
    assert.strictEqual(outcome.noBidReason, null,
      'and its receipt does not blame a session outage that ended long before the load closed');
    ok('a brief outage does not silence an unrelated load\'s alarm for the rest of the bound');
  }

  cleanup();
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); realClock(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
