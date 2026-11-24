'use strict';
/**
 * Session scope-refresh guard (src/auth/scopeRefresh.js) - offline, no token, no network.
 * The 2026-07-16 incident spec, pinned:
 *   A. branchFingerprint is order/duplicate-insensitive and catches same-count swaps.
 *   B. checkScopeChange records a baseline silently, stays quiet on no-change, and fires
 *      the 'error' alert ("branch scope changed: 249 -> 276") exactly once per transition.
 *   C. ScopeRefresher re-login flows scope in; a change during a refresh alerts.
 *   D. refresh is DEFERRED while any auction is armed (fake engine AND a real BidEngine
 *      with a live monitor) - login is never even attempted.
 *   E. a FAILED re-login preserves the old session byte-identical (account object identity
 *      + serverTimeOffsetMs) and pages a human on a failure streak, tokenExpiry-style.
 *
 *   node scripts/test-scope-refresh.js
 */
const os = require('os');
const path = require('path');
const { branchFingerprint, checkScopeChange, ScopeRefresher, SCOPE_COLLECTION, isAlertRung,
  REFRESH_DEFAULTS } = require('../src/auth/scopeRefresh');
const { MemoryStore } = require('../src/store/memoryStore');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// EXPECTED-COUNT SENTINEL. run-tests.js grades by EXIT CODE ALONE, so a file that returns early
// reaches exit 0 having asserted nothing and reads as a silent green. Bump with the check count.
const EXPECTED_CHECKS = 90;
process.on('exit', () => {
  const ran = pass + fail;
  if (ran === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${ran} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, payload, opts) => { calls.push({ kind, payload, opts: opts || {} }); } };
}

// Minimal real-adapter stand-in: same login() contract (assigns .account LAST, throws on
// failure) plus the two fields a failed refresh must not disturb. failNext>0 makes the next
// N logins fail AFTER nudging serverTimeOffsetMs - the exact partial-failure the restore
// path in ScopeRefresher.refresh() exists for (getAvailableViews ok, getHeader failed).
// `failWith`/`failStatus` are LOAD-BEARING, not scenery: login() codes every non-200 as AUTH, so a
// fixture that only ever throws a 500 cannot tell a refusal apart from an unrelated outage, and any
// suppression assertion written against it passes for the wrong reason. Default stays a 500 - the
// non-auth failure this alert exists for - so a block that wants suppression must ask for a refusal.
function fakeAdapter({ branchIds = [1, 2], failWith = 'header_fetch_failed_500',
  failStatus = 500, failAuthReason = null } = {}) {
  const a = {
    account: null, serverTimeOffsetMs: 0, loginCalls: 0, failNext: 0, branchIds,
    failWith, failStatus, failAuthReason,
    async login() {
      a.loginCalls += 1;
      if (a.failNext > 0) {
        a.failNext -= 1;
        a.serverTimeOffsetMs = 99_999; // the mid-login nudge a failure must roll back
        const e = new Error(a.failWith); e.code = 'AUTH';
        if (a.failStatus != null) e.status = a.failStatus;
        if (a.failAuthReason) e.authReason = a.failAuthReason;
        throw e;
      }
      a.account = { carrierId: 2667, userId: 9, branchIds: a.branchIds.slice(), tokenExp: Date.now() + 86_400_000 };
      return a.account;
    },
  };
  return a;
}

// Notifier stand-in modelling the two real behaviours F04 turns on, both read off notifier.js:
// a send while the Maytapi sender is DOWN is skipped and deliberately NOT marked sent
// (HEALTH_POLICY error -> 'drop', and `if (sent > 0) await this._markSent(...)`), and an offer whose
// dedupeKey is already marked sent short-circuits at _alreadySent. `offers` counts what reached the
// notifier; `delivered` counts what a human would actually have received.
// `down` = sender session down (skip, return false). `wireFails` = sender healthy but every
// recipient's send failed: notifier.js returns TRUE there and deliberately does NOT mark, which is
// why the disposition alone cannot retire a rung. `noStore` models a notifier with no dedupe store,
// whose wasDelivered can only answer null.
// SENDING and MARKING are separate, independently-failing steps in notifier.js, so this models them
// separately or it cannot represent the state that matters. `down` = sender session down (skip,
// false, unmarked). `wireFails` = sender healthy but every recipient's send failed: returns TRUE and
// marks nothing. `markFails` = the message GOES OUT and the dedupe write throws - a full disk - which
// is the one state in which reading the store alone would report a delivered page as never sent and
// re-offer it on every tick. `noStore` = no dedupe store to consult at all.
function fakeDedupingNotifier({ down = false, wireFails = false, markFails = false, noStore = false } = {}) {
  const marked = new Set(), sentHere = new Set(), delivered = [], offers = [];
  const n = { down, wireFails, markFails, delivered, offers, marked, sentHere,
    alert: async (kind, payload, opts) => {
      const key = opts && opts.dedupeKey;
      offers.push({ key, detail: payload && payload.detail });
      if (key && !noStore && marked.has(key)) return true;  // _alreadySent -> done
      if (n.down) return false;                             // health-skip -> the ONE retryable false
      if (n.wireFails) return true;                         // sent === 0: true, and NOT marked
      delivered.push({ kind, payload, key });                // it is on the wire from here on
      if (key) sentHere.add(key);                            // recorded BEFORE the write can throw
      if (key && !n.markFails) marked.add(key);              // _markSent, which can fail on its own
      return true;
    },
    // Mirrors the real predicate: what this process SENT first, then the store, then "cannot answer".
    wasDelivered: async (key) => {
      if (sentHere.has(key)) return true;
      return noStore ? null : marked.has(key);
    } };
  return n;
}

// Engine stand-in: only the snapshot() read the refresher consumes.
const fakeEngine = (rows) => ({ snapshot: () => rows });

// n sequential branch ids [1..n] - readable stand-ins for the incident's 249/276.
const idsUpTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

(async () => {
  // ---- A. branchFingerprint ----
  {
    const a = branchFingerprint([3, 1, 2]);
    const b = branchFingerprint([2, 3, 1]);
    ok(a.hash === b.hash && a.count === 3, 'fingerprint is order-insensitive');
    const c = branchFingerprint([1, 1, 2]);
    ok(c.count === 2 && c.hash === branchFingerprint([2, 1]).hash, 'fingerprint dedupes');
    // same COUNT, different set - the swap case the count alone would miss
    ok(branchFingerprint([1, 2, 3]).hash !== branchFingerprint([1, 2, 4]).hash, 'same-count swap changes the hash');
    ok(branchFingerprint([]).count === 0 && branchFingerprint(null).count === 0, 'empty/null input fingerprints as zero branches');
  }

  // ---- B. checkScopeChange: baseline -> quiet -> the incident (249 -> 276) ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const base = { store, notifier: n, accountId: 'primary', accountLabel: 'Primary' };

    const first = await checkScopeChange({ ...base, branchIds: idsUpTo(249) });
    ok(first.checked && first.first && !first.changed, 'first login records a baseline, not a change');
    ok(n.calls.length === 0, 'baseline recording fires NO alert');
    const doc0 = await store.getDoc(SCOPE_COLLECTION, 'primary');
    ok(doc0 && doc0.count === 249 && Array.isArray(doc0.branchIds), 'baseline persisted with count + ids');

    const same = await checkScopeChange({ ...base, branchIds: idsUpTo(249).reverse() });
    ok(!same.changed && n.calls.length === 0, 'same scope (any order) stays quiet');

    // THE incident: SuperProcure maps 27 new branches server-side overnight.
    const grew = await checkScopeChange({ ...base, branchIds: idsUpTo(276) });
    ok(grew.changed && grew.prevCount === 249 && grew.count === 276 && grew.added === 27 && grew.removed === 0,
      `249 -> 276 detected with add/remove counts (got ${JSON.stringify(grew)})`);
    ok(n.calls.length === 1 && n.calls[0].kind === 'error', 'scope change fires exactly one error alert');
    ok(n.calls[0].payload.detail.includes('249 -> 276'), `alert names the transition ("${n.calls[0].payload.detail}")`);
    ok(n.calls[0].payload.context === 'sp-scope-Primary', 'alert context is account-scoped (sp-scope-<label>)');
    ok(String(n.calls[0].opts.dedupeKey).startsWith('scope_change_primary_'), 'dedupeKey is keyed on the transition');
    const doc1 = await store.getDoc(SCOPE_COLLECTION, 'primary');
    ok(doc1.count === 276 && doc1.prevCount === 249, 'new fingerprint persisted after alerting');

    // a same-count SWAP still alerts (hash moved, count did not)
    const swapped = await checkScopeChange({ ...base, branchIds: [...idsUpTo(275), 9999] });
    ok(swapped.changed && swapped.added === 1 && swapped.removed === 1, 'same-count branch swap is detected');
    ok(n.calls.length === 2, 'the swap fires its own alert');
    const keys = n.calls.map((c) => c.opts.dedupeKey);
    ok(new Set(keys).size === keys.length, 'each transition gets a distinct dedupeKey');

    // best-effort contract: no store/accountId -> no throw, no alert
    const r = await checkScopeChange({ notifier: n, branchIds: [1] });
    ok(r.checked === false && n.calls.length === 2, 'missing store/accountId never throws and never alerts');
  }

  // ---- C. ScopeRefresher: refresh flows scope in; a change during refresh alerts ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const adapter = fakeAdapter({ branchIds: idsUpTo(249) });
    const refreshed = [];
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store, notifier: n,
      accountId: 'primary', accountLabel: 'Primary',
      onRefreshed: async (acct, scope) => refreshed.push({ branches: acct.branchIds.length, changed: scope.changed }) });

    const r1 = await sr.refresh({ trigger: 'manual' });
    ok(r1.ok && r1.branches === 249 && r1.changed === false, 'first refresh logs in and records the baseline');
    ok(adapter.loginCalls === 1, 'refresh performed exactly one login');
    ok(refreshed.length === 1 && refreshed[0].branches === 249, 'onRefreshed hook ran with the fresh identity');

    adapter.branchIds = idsUpTo(276); // SuperProcure maps the new branches server-side
    const r2 = await sr.refresh({ trigger: 'scheduled' });
    ok(r2.ok && r2.changed === true && r2.prevCount === 249 && r2.branches === 276,
      `refresh detected the grown scope (got ${JSON.stringify(r2)})`);
    ok(n.calls.length === 1 && n.calls[0].payload.detail.includes('249 -> 276'), 'refresh-time change fired the incident alert');
    ok(adapter.account.branchIds.length === 276, 'the live adapter session now carries the 276-branch scope');
  }

  // ---- D1. deferred while armed (fake engine): login is never attempted ----
  {
    const n = fakeNotifier();
    const adapter = fakeAdapter();
    const armedRow = { auctionId: '23188358', finalized: false };
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([armedRow]), store: new MemoryStore(), notifier: n });
    const r = await sr.refresh({ trigger: 'scheduled' });
    ok(r.ok === false && r.deferred === true && r.armedCount === 1, 'armed auction defers the refresh');
    ok(adapter.loginCalls === 0, 'deferred refresh never even calls login()');
    ok(n.calls.length === 0, 'a deferral is routine - no alert');
    // finalized (closed/stopped) monitors linger in the engine map - they must NOT defer
    const sr2 = new ScopeRefresher({ adapter, engine: fakeEngine([{ auctionId: 'x', finalized: true }]), store: new MemoryStore(), notifier: n });
    const r2 = await sr2.refresh();
    ok(r2.ok === true && adapter.loginCalls === 1, 'finalized-only monitors do not defer a refresh');
  }

  // ---- D2. deferred while armed, against the REAL BidEngine (the seam the server wires) ----
  {
    const adapter = fakeAdapter();
    // platform stand-in for the ENGINE side (BidEngine needs capabilities + state reads);
    // far from close so the monitor just watches - no bid path is exercised here.
    const engineAdapter = {
      writeEnabled: false,
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: null, totalBidders: 0,
        standingL1Price: null, closesInMs: 60_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
      placeBid: async () => { throw new Error('must not bid in this test'); },
    };
    const scheduler = new DurableScheduler(path.join(os.tmpdir(), `scope-refresh-${process.pid}.json`));
    const engine = new BidEngine(engineAdapter, scheduler, { config: { minInterFireMs: 0 } });
    engine.arm({ id: '23188358', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 60_000 },
      { cost: 40_000, marginsPct: [12.6, 7.2, 6.3] });
    await sleep(30); // let the first tick run so the monitor is genuinely live
    const sr = new ScopeRefresher({ adapter, engine, store: new MemoryStore(), notifier: fakeNotifier() });
    const held = await sr.refresh({ trigger: 'manual' });
    ok(held.deferred === true && held.armedCount === 1 && adapter.loginCalls === 0,
      'real BidEngine with an armed monitor defers the refresh (no login attempted)');
    engine.stop('23188358'); // operator stop retires the monitor
    const after = await sr.refresh({ trigger: 'manual' });
    ok(after.ok === true && adapter.loginCalls === 1, 'refresh proceeds once the engine has no live monitor');
  }

  // ---- E. failed re-login: old session preserved; streak paging; recovery reset ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const adapter = fakeAdapter({ branchIds: idsUpTo(249) });
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store, notifier: n,
      accountId: 'primary', accountLabel: 'Primary', failureAlertThreshold: 3 });

    await sr.refresh(); // establish a working session (the one a failure must keep)
    const workingSession = adapter.account;
    adapter.serverTimeOffsetMs = 7; // a known-good offset the failed login must not clobber

    adapter.failNext = 2;
    const f1 = await sr.refresh();
    ok(f1.ok === false && f1.consecutiveFailures === 1, 'failed refresh reports the failure');
    ok(adapter.account === workingSession, 'failed refresh keeps the OLD session object (identity, not just shape)');
    ok(adapter.serverTimeOffsetMs === 7, 'failed refresh rolls back the mid-login serverTimeOffsetMs nudge');
    ok(n.calls.length === 0, 'one failure is a blip - below the paging threshold');

    await sr.refresh(); // failure #2 - still quiet
    ok(n.calls.length === 0, 'two failures still below the threshold');
    adapter.failNext = 4;
    await sr.refresh(); // failure #3 -> page
    ok(n.calls.length === 1 && n.calls[0].kind === 'error', 'third consecutive failure pages a human');
    ok(n.calls[0].payload.detail.includes('3x in a row'), 'failure alert says how long the streak is');
    ok(n.calls[0].payload.detail.includes('LAST known'), 'failure alert says the bot still bids on the last known scope');
    await sr.refresh(); await sr.refresh(); await sr.refresh(); // #4 #5 #6 -> escalate once more
    ok(n.calls.length === 2, 'streak escalates again at the next rung (6), not every failure');
    ok(n.calls[0].opts.dedupeKey !== n.calls[1].opts.dedupeKey, 'escalations carry distinct dedupeKeys');
    adapter.failNext = 6;
    for (let i = 0; i < 6; i += 1) await sr.refresh(); // #7..#12 -> exactly ONE more, at 12
    ok(n.calls.length === 3, 'rungs DOUBLE (3, 6, 12) - #9 is not a rung, so a long streak cannot storm');
    ok(n.calls[2].payload.detail.includes('12x in a row'), 'the third page is the 12th failure, not the 9th');

    const rec = await sr.refresh(); // failNext exhausted -> success
    ok(rec.ok === true && sr.consecutiveFailures === 0, 'a success resets the failure streak');
    ok(adapter.account !== workingSession && adapter.account.branchIds.length === 249, 'recovered refresh installs a fresh session');
    adapter.failNext = 1;
    await sr.refresh();
    ok(n.calls.length === 3, 'post-recovery single failure starts a NEW quiet streak (no instant page)');
  }

  // ---- E2. an open auth-dead episode owns the outage: no streak page on top of it ----
  // The Ludhiana revocation of 2026-08-18: raiseAuthDead had already sent its one-per-episode
  // message, and the streak page then restated it every 15 minutes for 43 hours.
  {
    const n = fakeNotifier();
    const adapter = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    adapter.isAuthDead = () => true;
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store: new MemoryStore(), notifier: n,
      accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3 });
    adapter.failNext = 12;
    for (let i = 0; i < 12; i += 1) await sr.refresh();
    ok(sr.consecutiveFailures === 12, 'the streak still counts while auth is dead (the endpoint still reports it)');
    ok(n.calls.length === 0, 'no scope page while an auth-dead episode is open - raiseAuthDead already sent it');

    // ...and the page comes back the moment auth is fine again, for the case it was written for.
    const n2 = fakeNotifier();
    const a2 = fakeAdapter({ branchIds: idsUpTo(5) });
    a2.isAuthDead = () => false;
    const sr2 = new ScopeRefresher({ adapter: a2, engine: fakeEngine([]), store: new MemoryStore(), notifier: n2,
      accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3 });
    a2.failNext = 3;
    for (let i = 0; i < 3; i += 1) await sr2.refresh();
    ok(n2.calls.length === 1, 'a non-auth failure streak still pages (500s/timeouts are what this alert is for)');

    // An adapter with no latch at all must FAIL OPEN - losing an alert beats repeating one.
    const n3 = fakeNotifier();
    const a3 = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr3 = new ScopeRefresher({ adapter: a3, engine: fakeEngine([]), store: new MemoryStore(), notifier: n3,
      accountId: 'x', accountLabel: 'X', failureAlertThreshold: 3 });
    a3.failNext = 3;
    for (let i = 0; i < 3; i += 1) await sr3.refresh();
    ok(n3.calls.length === 1, 'an adapter with no isAuthDead() fails OPEN and still pages');

    // The gate reads BOTH facts, because they disagree in both directions: realAdapter clears the
    // latch on one proven write while the outage stays open until the all-clear, and derives
    // EXPIRED from tokenExp before anything opens an episode. The episode says the desk was told;
    // isAuthDead says it is still true. Either one alone suppresses a page it should have sent.
    const n4 = fakeNotifier();
    const a4 = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    a4.isAuthDead = () => true;        // the latch reads dead...
    a4.authEpisodeSince = () => null;  // ...but no outage was ever opened, so nobody was paged
    const sr4 = new ScopeRefresher({ adapter: a4, engine: fakeEngine([]), store: new MemoryStore(), notifier: n4,
      accountId: 'x', accountLabel: 'X', failureAlertThreshold: 3 });
    a4.failNext = 3;
    for (let i = 0; i < 3; i += 1) await sr4.refresh();
    ok(n4.calls.length === 1, 'no open episode means the read-path page still fires, latch or no latch');

    // THE RECONNECT SHAPE. A rebuilt stack inherits the open episode from the ledger, and only a
    // proven write ever closes one - an account with no load to bid carries it for days on a
    // perfectly good token. Suppressing on the episode alone would silence real 500s for that
    // whole time, so a usable session pages regardless of the outage's paperwork.
    const n5 = fakeNotifier();
    const a5 = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    a5.isAuthDead = () => false;                    // fresh token, reads and writes both flow...
    a5.authEpisodeSince = () => 1_700_000_000_000;  // ...but the inherited outage never closed
    const sr5 = new ScopeRefresher({ adapter: a5, engine: fakeEngine([]), store: new MemoryStore(), notifier: n5,
      accountId: 'x', accountLabel: 'X', failureAlertThreshold: 3 });
    a5.failNext = 6;
    for (let i = 0; i < 6; i += 1) await sr5.refresh();
    ok(n5.calls.length === 2, 'a reconnected session pages normally - an unclosed episode alone never silences it');

    // THE WRITE-SCOPE REVOCATION HOLE. A latch always opens an episode and no all-clear can fire
    // while latched, so "episode open" and "session unusable" are the SAME fact here - they cannot
    // narrow each other. The account is genuinely revoked (both true), but the scope refresh is
    // failing on an unrelated 500, which is precisely what this alert was written for. Only the
    // error's own cause separates the two outages.
    const n6 = fakeNotifier();
    const a6r = fakeAdapter({ branchIds: idsUpTo(5) });   // default failure kind: a 500
    a6r.isAuthDead = () => true;
    a6r.authEpisodeSince = () => 1_700_000_000_000;
    const sr6r = new ScopeRefresher({ adapter: a6r, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n6, accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3 });
    a6r.failNext = 12;
    for (let i = 0; i < 12; i += 1) await sr6r.refresh();
    ok(n6.calls.length === 3,
      'a revoked account whose READS are 500ing still pages - the revocation does not own that failure');

    // ...and the same account failing on the revocation itself stays silent, which is the 18 Aug
    // incident: raiseAuthDead owns it and the streak page would only restate it 167 times.
    const n7 = fakeNotifier();
    const a7 = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    a7.isAuthDead = () => true;
    a7.authEpisodeSince = () => 1_700_000_000_000;
    const sr7 = new ScopeRefresher({ adapter: a7, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n7, accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3 });
    a7.failNext = 501;
    for (let i = 0; i < 501; i += 1) await sr7.refresh();
    ok(n7.calls.length === 0,
      'while the 18 Aug shape - revoked, and the refresh failing ON the revocation - stays silent across 501 passes');

    // The adapter's synthetic EXPIRED refusal never reaches the wire, so it carries no status; it
    // is still the outage refusing, and must suppress the same way.
    const n8 = fakeNotifier();
    const a8 = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'token_expired', failStatus: null,
      failAuthReason: 'token_expired' });
    a8.isAuthDead = () => true;
    a8.authEpisodeSince = () => 1_700_000_000_000;
    const sr8 = new ScopeRefresher({ adapter: a8, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n8, accountId: 'e', accountLabel: 'E', failureAlertThreshold: 3 });
    a8.failNext = 12;
    for (let i = 0; i < 12; i += 1) await sr8.refresh();
    ok(n8.calls.length === 0, 'a statusless token_expired refusal suppresses on authReason alone');
  }

  // ---- E4. a silenced stretch is skipped over by the ladder, not replayed and not restarted ----
  // Only failures eligible to page advance the rungs, so an outage that hides an ENTIRE streak
  // costs one threshold once it clears (the alternative charged the next doubling above the hidden
  // count - 192 failures, ~7.6h at a 5m cadence, where the pre-ladder code paged in 15 minutes),
  // while the true consecutive count still reaches the human and a flap cannot restart the ladder.
  {
    const n = fakeNotifier();
    const adapter = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    let episode = 1_700_000_000_000;
    adapter.authEpisodeSince = () => episode;
    adapter.isAuthDead = () => episode != null;
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store: new MemoryStore(), notifier: n,
      accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3 });
    adapter.failNext = 200; // the outage outlives the episode - nothing here ever logs back in
    for (let i = 0; i < 100; i += 1) await sr.refresh();
    ok(n.calls.length === 0 && sr.consecutiveFailures === 100,
      '100 failures inside an open episode page zero times and still count');

    episode = null; // the all-clear went out; the outage is closed but the refresh keeps failing
    await sr.refresh();
    ok(sr.consecutiveFailures === 101 && n.calls.length === 0,
      'the streak keeps its true count across the boundary - the human is never told 1 when it is 101');
    await sr.refresh();
    ok(n.calls.length === 0, 'two pageable failures is still below the threshold');
    await sr.refresh();
    ok(n.calls.length === 1 && n.calls[0].payload.detail.includes('103x in a row'),
      'the page lands one threshold after the outage clears, and states the REAL streak, not 3');

    // A flapping outage must not restart the ladder each time it crosses the boundary: that
    // rebuilds the every-15-minutes storm the ladder exists to stop.
    episode = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) await sr.refresh();
    ok(n.calls.length === 1, 'reopening the outage silences it again without spending rungs');
    episode = null;
    for (let i = 0; i < 3; i += 1) await sr.refresh();
    ok(n.calls.length === 2, 'and the next page is the 6-rung, not another bottom-rung restart');

    // A stretch silenced AFTER the ladder has already climbed is skipped over, NOT reset: the next
    // page is the next rung. That is the ladder's own cadence (96 passes at height 96), not a
    // threshold bound - the operator doc must not promise one, so pin the real number here.
    const n6 = fakeNotifier();
    const a6 = fakeAdapter({ branchIds: idsUpTo(5), failWith: 'auth_failed_401', failStatus: 401 });
    let ep6 = null;
    a6.authEpisodeSince = () => ep6;
    a6.isAuthDead = () => ep6 != null;
    const sr6 = new ScopeRefresher({ adapter: a6, engine: fakeEngine([]), store: new MemoryStore(), notifier: n6,
      accountId: 'y', accountLabel: 'Y', failureAlertThreshold: 3 });
    a6.failNext = 500;
    for (let i = 0; i < 12; i += 1) await sr6.refresh();   // pageable 12 -> rungs 3, 6, 12
    ok(n6.calls.length === 3, 'three rungs fire before the outage opens');
    ep6 = 1_700_000_000_000;
    for (let i = 0; i < 50; i += 1) await sr6.refresh();   // silenced: 50 passes, 0 rungs spent
    ok(n6.calls.length === 3, 'the outage silences 50 passes without spending or resetting a rung');
    ep6 = null;
    for (let i = 0; i < 11; i += 1) await sr6.refresh();   // pageable 13..23 - rung 24 not reached
    ok(n6.calls.length === 3, 'recovery does NOT restart at the threshold - the ladder resumes where it was');
    await sr6.refresh();                                   // pageable 24
    ok(n6.calls.length === 4 && n6.calls[3].payload.detail.includes('74x in a row'),
      'the page lands at rung 24 and still states the true 74-pass streak');
  }

  // ---- E3. isAlertRung: the rung ladder itself ----
  {
    const rungs = [];
    for (let i = 1; i <= 100; i += 1) if (isAlertRung(i, 3)) rungs.push(i);
    ok(JSON.stringify(rungs) === JSON.stringify([3, 6, 12, 24, 48, 96]),
      `threshold 3 doubles: 3,6,12,24,48,96 (got ${rungs.join(',')})`);
    ok(!isAlertRung(0, 3) && !isAlertRung(-1, 3), 'zero and negative counts are never a rung');
    ok(!isAlertRung(5, 0) && !isAlertRung(5, -3), 'a non-positive threshold disables the ladder');
    ok(isAlertRung(1, 1) && isAlertRung(2, 1) && isAlertRung(4, 1) && !isAlertRung(3, 1),
      'threshold 1 doubles from 1 (1,2,4,8) and skips 3');
    // 501 failures - the real Ludhiana streak - would have paged 167 times at every-multiple.
    let pages = 0;
    for (let i = 1; i <= 501; i += 1) if (isAlertRung(i, 3)) pages += 1;
    ok(pages === 8, `the 501-failure Ludhiana streak pages 8 times, not 167 (got ${pages})`);
  }

  // ---- E5. an undelivered rung page is re-offered until it lands, and lands at most once ----
  // The page rides HEALTH_POLICY 'error' -> 'drop', so a send into a logged-out sender is skipped
  // and never marked - the message is lost outright while the ladder moves the next one a doubling
  // further away. The retry re-offers the SAME dedupeKey and stops the instant the notifier reports
  // anything but its retryable skip, so it can never become the storm by another route.
  {
    const n = fakeDedupingNotifier({ down: true });
    const adapter = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store: new MemoryStore(), notifier: n,
      accountId: 'ludhiana', accountLabel: 'Ludhiana', failureAlertThreshold: 3, pageReofferMs: 0 });
    adapter.failNext = 200;
    for (let i = 0; i < 3; i += 1) await sr.refresh();  // rung 3, offered into a DOWN sender
    ok(n.offers.length === 1 && n.delivered.length === 0,
      'the rung page is offered and LOST - a down sender skips it without marking it sent');
    const rungKey = n.offers[0].key;
    await sr.refresh();
    ok(n.offers.length === 2 && n.delivered.length === 0, 'an undelivered rung is re-offered');
    ok(n.offers[1].key === rungKey,
      'the re-offer carries the ORIGINAL key - a new key per attempt is how the storm happened');
    n.down = false;
    await sr.refresh();                                 // failure 5 delivers the rung-3 page
    ok(n.delivered.length === 1 && n.delivered[0].key === rungKey,
      'and it lands once the sender is back - the page the ladder would not have repeated is not lost');
    ok(n.delivered[0].payload.detail.includes('has failed 5x in a row'),
      'the delivered text is rendered at SEND time, not frozen at the rung it was minted on');
    for (let i = 0; i < 20; i += 1) await sr.refresh();
    ok(n.offers.filter((o) => o.key === rungKey).length === 3,
      'once delivered the key is dropped - a failing dedupe store cannot make one rung page twice');
    ok(sr._pageableFailures === 25, 'the delivery retry never touches the ladder counter');

    // The cadence production actually runs. Pinned by value, because every other case here sets it
    // to 0 and a default that never comes due would leave the whole retry dead on the box.
    const n2 = fakeDedupingNotifier({ down: true });
    const a2 = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr2 = new ScopeRefresher({ adapter: a2, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n2, accountId: 'z', accountLabel: 'Z', failureAlertThreshold: 3 });
    ok(sr2.pageReofferMs === 15 * 60 * 1000 && REFRESH_DEFAULTS.pageReofferMs === 15 * 60 * 1000,
      'the default re-offer cadence is 15 minutes, matching the sibling auth re-raise');
    a2.failNext = 20;
    for (let i = 0; i < 4; i += 1) await sr2.refresh();
    ok(n2.offers.length === 1,
      'and on that cadence a failure 5 minutes later is NOT yet a re-offer - the retry is paced, not per-pass');

    // A successful refresh drops a still-undelivered key: the streak it described is over, and
    // paging about it later would report an outage that has already been fixed.
    const n3 = fakeDedupingNotifier({ down: true });
    const a3 = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr3 = new ScopeRefresher({ adapter: a3, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n3, accountId: 'w', accountLabel: 'W', failureAlertThreshold: 3, pageReofferMs: 0 });
    a3.failNext = 3;
    for (let i = 0; i < 3; i += 1) await sr3.refresh();   // rung 3 minted, lost to the down sender
    const staleKey = n3.offers[0].key;
    await sr3.refresh();                                  // succeeds - streak over
    ok(sr3._pageKey === null, 'a successful refresh drops the undelivered page key');
    n3.down = false;
    a3.failNext = 1;
    await sr3.refresh();                                  // a brand-new streak begins
    ok(n3.offers.filter((o) => o.key === staleKey).length === 1 && n3.delivered.length === 0,
      'so a recovered account never pages about the streak it already recovered from');

    // A HEALTHY sender whose sends all fail returns TRUE and marks nothing - notifier.js leaves it
    // unmarked exactly so a later offer can still land it. Retiring the rung on that boolean would
    // drop a page one transient 500 merely delayed.
    const n4 = fakeDedupingNotifier({ wireFails: true });
    const a4 = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr4 = new ScopeRefresher({ adapter: a4, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n4, accountId: 'v', accountLabel: 'V', failureAlertThreshold: 3, pageReofferMs: 0 });
    a4.failNext = 20;
    for (let i = 0; i < 3; i += 1) await sr4.refresh();   // rung 3: offered, wire fails, unmarked
    ok(n4.offers.length === 1 && n4.delivered.length === 0 && sr4._pageKey !== null,
      'a failed wire send does not retire the rung, even though the notifier answered true');
    n4.wireFails = false;
    await sr4.refresh();
    ok(n4.delivered.length === 1 && n4.delivered[0].key === n4.offers[0].key,
      'so the page still lands when the wire recovers on the very next pass');

    // A notifier with no dedupe store cannot answer wasDelivered. Its disposition is then the only
    // signal, and taking it is what stops the retry re-offering forever on that shape.
    const n5 = fakeDedupingNotifier({ noStore: true });
    const a5 = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr5 = new ScopeRefresher({ adapter: a5, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n5, accountId: 'u', accountLabel: 'U', failureAlertThreshold: 3, pageReofferMs: 0 });
    a5.failNext = 40;
    for (let i = 0; i < 24; i += 1) await sr5.refresh();  // rungs 3, 6, 12 and 24 only
    ok(n5.offers.length === 4 && sr5._pageKey === null,
      'a store-less notifier retires each rung on its disposition - one offer per rung, no re-offer storm');

    // THE STORM BY THE OTHER ROUTE. The page goes out and the dedupe write throws (a full disk).
    // Reading the store alone would answer "never delivered" and re-offer on every tick - and each
    // re-offer finds no mark either, so it SENDS AGAIN. Measured at 172 messages over a 43h streak,
    // worse than the 167 that started all this. The delivery fact has to come from the send itself.
    const n6 = fakeDedupingNotifier({ markFails: true });
    const a6d = fakeAdapter({ branchIds: idsUpTo(5) });
    const sr6d = new ScopeRefresher({ adapter: a6d, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: n6, accountId: 't', accountLabel: 'T', failureAlertThreshold: 3, pageReofferMs: 0 });
    a6d.failNext = 200;
    for (let i = 0; i < 5; i += 1) await sr6d.refresh();   // rung 3 lands; its mark never persists
    ok(n6.delivered.length === 1 && n6.marked.size === 0,
      'the page is on the wire even though nothing was marked - the two steps fail independently');
    ok(sr6d._pageKey === null,
      'and the rung retires on the SEND, not on the mark, so a failed dedupe write cannot re-send it');
    for (let i = 0; i < 60 && a6d.failNext > 0; i += 1) await sr6d.refresh();
    ok(n6.delivered.filter((d) => d.key === n6.offers[0].key).length === 1,
      'across 65 passes with a permanently broken dedupe store, rung 3 still delivered exactly once');
  }

  // ---- F. cadence wiring: start() runs scheduled refreshes; stop() halts them ----
  {
    const adapter = fakeAdapter();
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store: new MemoryStore(),
      notifier: fakeNotifier(), intervalMs: 25, deferMs: 10 });
    sr.start();
    await sleep(120);
    ok(adapter.loginCalls >= 1, `scheduled cadence performed refreshes (got ${adapter.loginCalls})`);
    sr.stop();
    const after = adapter.loginCalls;
    await sleep(80);
    ok(adapter.loginCalls === after, 'stop() halts the cadence (no further logins)');
  }

  // ---- G. one refresh at a time (a manual poke colliding with the schedule) ----
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const adapter = { account: null, serverTimeOffsetMs: 0, loginCalls: 0,
      async login() { this.loginCalls += 1; await gate; this.account = { carrierId: 1, branchIds: [1], tokenExp: Date.now() + 1000 }; return this.account; } };
    const sr = new ScopeRefresher({ adapter, engine: fakeEngine([]), store: new MemoryStore(), notifier: fakeNotifier() });
    const p1 = sr.refresh({ trigger: 'scheduled' });
    const p2 = await sr.refresh({ trigger: 'manual' }); // second entry while the first awaits login
    ok(p2.ok === false && p2.inFlight === true && adapter.loginCalls === 1, 'concurrent refresh is refused, not doubled');
    release();
    const r1 = await p1;
    ok(r1.ok === true, 'the original in-flight refresh completes normally');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
