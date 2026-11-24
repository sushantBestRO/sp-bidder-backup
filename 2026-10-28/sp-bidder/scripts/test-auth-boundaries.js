'use strict';
/**
 * THE CLOCK CROSS-PRODUCTS of the auth state machine, pinned to the exact millisecond.
 *
 * WHY THIS FILE IS THE DELIVERABLE AND NOT AN EXTRA. Three consecutive fix rounds each shipped a
 * confirmed correctness bug, and the diagnosis of why named one cause above the others: nine timing
 * constants, and nothing anywhere that tested a PAIR of them against each other. Every confirmed
 * round-3 defect sat on a pairwise timing boundary - the settle window against the trial cadence, the
 * expiry grace band against the streak window, the streak window against an intervening success.
 * Mutation testing perturbs code; it does not invent the boundary scenario nobody imagined. So the
 * boundaries are enumerated here explicitly, each one asserted on BOTH sides plus the instant itself.
 *
 * Every check in this file is deterministic: the clock is frozen and stepped by hand, and both auth
 * timers run on that same clock through the adapter's injected timer seam. Nothing sleeps, nothing
 * races, and re-running the file cannot produce a different answer.
 *
 *   node scripts/test-auth-boundaries.js
 */
const assert = require('assert');
const H = require('./lib/auth-harness');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// EXPECTED-COUNT SENTINEL, registered first so it fires on every path out of the process.
// run-tests.js grades by EXIT CODE ALONE, so a file that ends early - a swallowed rejection, a stray
// return - reaches exit 0 having asserted nothing and reads as a silent green.
const EXPECTED_CHECKS = 10;
process.on('exit', () => {
  H.cleanup();
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

(async () => {
  // ==============================================================================================
  // B1. THE EXACT EXPIRY INSTANT. Three phases, two boundaries, and no tag may ever cover two
  //     phases - which is exactly what went wrong twice in a row, in opposite directions:
  //       round 2 counted the whole band as an auth failure, so two ordinary bid attempts inside a
  //         token's final minute sealed the account deterministically, with no SuperProcure-side
  //         condition at all;
  //       round 3 exempted the whole band from detection, so a token that had FULLY LAPSED produced
  //         silent, unlatched, unalerted rejections forever - the 2026-08-04 incident, regressed.
  //     Both boundaries are asserted at the instant and one millisecond either side of it.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const a = H.mkAdapter(H.transport().impl);
      const exp = H.now() + 10_000_000;
      a.account.tokenExp = exp;
      const G = a.tokenGraceMs;

      const phaseAt = (t) => { H.setClock(t); return a._tokenPhase(); };

      assert.strictEqual(phaseAt(exp - G - 1), 'normal', 'one ms before the grace band opens: normal');
      assert.strictEqual(phaseAt(exp - G), 'grace',
        'THE GRACE BOUNDARY: at exactly exp - tokenGraceMs the band has opened (>=, not >)');
      assert.strictEqual(phaseAt(exp - 1), 'grace', 'one ms before exp is still grace, never expired');
      assert.strictEqual(phaseAt(exp), 'expired',
        'THE EXPIRY BOUNDARY: at exactly exp the token is EXPIRED, not grace - a token is dead the '
        + 'instant it reaches its own exp, and this is the comparison the 2026-08-04 silence turned on');
      assert.strictEqual(phaseAt(exp + 1), 'expired', 'and one ms past it, obviously');

      // ...and the STATE follows the phase, at the same instants.
      H.setClock(exp - 1);
      assert.strictEqual(a.authState(), 'CLEAR', 'at exp-1 the account is still CLEAR');
      H.setClock(exp);
      assert.strictEqual(a.authState(), 'EXPIRED', 'at exp it is EXPIRED, with no observation required');

      // ...and the two conditions carry DIFFERENT tags, because one is evidence and one is not.
      H.setClock(exp - 1);
      let g = null; try { await a.ensureSession(); } catch (e) { g = e; }
      assert.ok(g && g.code === 'AUTH' && g.authReason === 'token_expiring',
        'the grace band throws code AUTH tagged token_expiring - the tag that keeps it OUT of the streak');
      H.setClock(exp);
      let x = null; try { await a.ensureSession(); } catch (e) { x = e; }
      assert.ok(x && x.code === 'AUTH' && x.authReason === 'token_expired',
        'and a lapsed token throws its OWN tag - one tag can never cover both, by construction');

      // A parsed exp is required for any of this to fire at all; without one there is no local claim
      // to make and the machinery must stay silent rather than guess.
      const b = H.mkAdapter(H.transport().impl);
      b.account.tokenExp = null;
      assert.strictEqual(b._tokenPhase(), 'normal', 'an unparseable exp makes no local expiry claim');
      assert.strictEqual(b.authState(), 'CLEAR', 'and leaves the account CLEAR rather than guessing');
    } finally { H.realClock(); }
    ok('the token-lifetime split is exact at both boundaries and tags the two cases apart');
  }

  // ==============================================================================================
  // B2. EXPIRED DOMINATES LATCHED, and it puts NOTHING on the wire.
  //     Deriving the state rather than storing it is what makes this true by construction: there is
  //     no transition to miss and no flag to leave stale. The wire-silence half is the anti-detection
  //     cost of the alternative - a probe re-authenticating a provably dead credential every 90s for
  //     the life of the pm2 process, on a shared live account.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const t = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const dead = [];
      // A SHORT-LIVED token on purpose: the whole check runs inside one authDeadReAlertMs window, so
      // "exactly one down-alert" measures the episode rather than accidentally measuring the bounded
      // delivery retry. (A longer jump legitimately re-offers, which is a different property - B3.)
      const a = H.mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p), tokenLifeMs: 120_000 });
      await H.latchWrites(a);
      assert.strictEqual(a.authState(), 'LATCHED', 'latched by two write refusals');
      assert.ok(a._authProbeTimer, 'and the liveness heartbeat is armed while latched');
      const episode = a.authEpisodeSince();

      // Now the token lapses underneath the latch.
      H.setClock(a.account.tokenExp);
      assert.strictEqual(a.authState(), 'EXPIRED', 'EXPIRED wins over a latch that is also set');
      assert.strictEqual(a.isAuthDead(), true, 'and the account still reads dead, obviously');

      // The trial write must be unavailable: there is nothing for it to prove.
      assert.strictEqual(a.authWriteTrialDue(), false, 'no trial is ever due in EXPIRED...');
      assert.strictEqual(a.authWriteHeld(), true, '...so every write is held');
      assert.strictEqual(a._claimAuthWriteTrial(), null,
        'and the claim refuses even at the wire - null, so a refusal is never mistaken for a token');

      const wireBefore = t.calls.bid.length;
      const listBefore = t.calls.list.length;
      const baseBefore = t.calls.base.length;
      for (let i = 0; i < 30; i++) await H.bid(a);
      let readThrew = null;
      try { await a.listAuctions(); } catch (e) { readThrew = e; }
      assert.ok(readThrew && readThrew.code === 'AUTH' && readThrew.authReason === 'token_expired',
        'a READ is refused locally too, and says why');
      assert.strictEqual(t.calls.bid.length, wireBefore, 'ZERO further writes reached the wire');
      assert.strictEqual(t.calls.list.length, listBefore, 'ZERO reads reached the wire');

      // ...and the probe is stopped, so time passing cannot put a login() on the wire either.
      H.advanceFiring(a.authProbeIntervalMs * 5);
      assert.strictEqual(t.calls.base.length, baseBefore,
        'and the heartbeat is stopped - no login() re-authenticates a credential that is arithmetically dead');
      assert.strictEqual(a.authEpisodeSince(), episode,
        'the episode carries across the latch -> expiry transition rather than opening a second one');
      assert.strictEqual(dead.length, 1, 'so the desk still gets exactly one down-alert, not two');
    } finally { H.realClock(); }
    ok('EXPIRED dominates LATCHED, holds reads and writes alike, and puts nothing at all on the wire');
  }

  // ==============================================================================================
  // B3. A LAPSED TOKEN LATCHES WITH NO STREAK AND NO CONFIRMATION.
  //     Round 3's regression was structural, not a wrong constant: with the whole band exempted, the
  //     account-auth-dead mechanism became UNREACHABLE once real expiry passed. A single observation
  //     must be enough here, because the observation is arithmetic on our own credential rather than
  //     an inference from somebody else's response.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const t = H.transport();
      const dead = [];
      const a = H.mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p) });
      const exp = a.account.tokenExp;
      H.setClock(exp);

      assert.strictEqual(a._writeStreak, 0, 'no failure has been observed...');
      assert.strictEqual(a._readStreak, 0, '...on either capability');
      const r = await H.bid(a);
      assert.strictEqual(r.accepted, false, 'the write is refused');
      assert.strictEqual(dead.length, 1,
        'THE ROUND-3 REGRESSION: ONE attempt against a lapsed token raises the alarm - it does not '
        + 'need a second observation to corroborate our own arithmetic');
      assert.strictEqual(a.isAuthDead(), true, 'and the account is dead immediately, not after a threshold');
      assert.strictEqual(a._writeStreak, 0,
        'without entering the streak at all - a threshold here would only delay a certainty');
      assert.strictEqual(dead[0].since, a.authEpisodeSince(), 'the alert is keyed to the episode it opened');
      assert.strictEqual(t.calls.bid.length, 0, 'and no payload was built and nothing reached the wire');

      // Repeated attempts do not mint repeated alerts.
      for (let i = 0; i < 50; i++) await H.bid(a);
      assert.strictEqual(dead.length, 1, 'and fifty further attempts raise no second alert');

      // ...but the bounded DELIVERY retry still runs, fed by nothing but ordinary polling.
      H.advance(a.authDeadReAlertMs);
      await H.bid(a);
      assert.strictEqual(dead.length, 2,
        'while the bounded re-offer still fires on cadence, so a dropped first message is not the end of it');
      assert.strictEqual(dead[1].since, dead[0].since,
        'under the SAME episode key, so a delivered message dedupes the retry to nothing');
    } finally { H.realClock(); }
    ok('a lapsed token latches and alerts on ONE observation, bypassing the streak entirely');
  }

  // ==============================================================================================
  // B4. STREAK GAP EXACTLY EQUAL TO THE WINDOW. The comparison is `> window` resets, so a gap of
  //     exactly authStreakWindowMs still counts as a confirmation and a gap one millisecond longer
  //     does not. Pinned so the comparison cannot silently flip to >= (which would make the constant
  //     mean something one millisecond different from what every comment here says it means).
  // ==============================================================================================
  {
    const runGap = async (gap) => {
      H.freezeClock();
      try {
        const a = H.mkAdapter(H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) }).impl);
        await H.bid(a);
        assert.strictEqual(a._writeStreak, 1, 'the first refusal opens a streak of one');
        H.advance(gap);
        await H.bid(a);
        const r = { latched: a.isAuthDead(), streak: a._writeStreak };
        a.discard();
        return r;
      } finally { H.realClock(); }
    };
    const W = 60_000; // authStreakWindowMs

    const below = await runGap(W - 1);
    assert.strictEqual(below.latched, true, 'one ms inside the window: two refusals confirm and latch');

    const at = await runGap(W);
    assert.strictEqual(at.latched, true,
      'THE BOUNDARY: a gap of EXACTLY authStreakWindowMs still confirms - the window is inclusive');
    assert.strictEqual(at.streak, 2, 'and the streak really did reach two rather than latching some other way');

    const past = await runGap(W + 1);
    assert.strictEqual(past.latched, false,
      'one ms past it does NOT latch - a second observation that late is a fresh first observation');
    assert.strictEqual(past.streak, 1, 'and the streak restarted at one rather than merely failing the threshold');
    ok('the streak window is inclusive at exactly authStreakWindowMs and exclusive one ms later');
  }

  // ==============================================================================================
  // B5. THE TWO STREAKS ARE INDEPENDENT, and this is the one place the design deliberately does NOT
  //     follow the previous round's own prescribed fix.
  //
  //     "Reset the streak on any success" is the obvious repair for the round-3 defect where an
  //     intervening healthy read did not protect an account from latching. Executed literally on a
  //     SHARED streak it re-opens the round-1 defect from the other side: a read 200 between two
  //     write 401s is the SIGNATURE of write-scope revocation, so a shared streak reset by it makes
  //     the one shape the trial write exists for structurally unlatchable. Two streaks satisfy both.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      // (a) A read success does NOT protect the write streak - the write-scope-revocation signature.
      {
        let writesDie = true;
        const t = H.transport({ bid: async () => (writesDie ? H.DEAD() : H.OK_BID()) });
        const a = H.mkAdapter(t.impl);
        await H.bid(a);
        assert.strictEqual(a._writeStreak, 1, 'one write refusal');
        H.advance(30_000);
        await a.listAuctions();                       // a genuinely healthy read, mid-window
        assert.strictEqual(a._readStreak, 0, 'the read success clears the READ streak');
        assert.strictEqual(a._writeStreak, 1, '...and deliberately leaves the WRITE streak standing');
        H.advance(30_000);
        await H.bid(a);
        assert.strictEqual(a.isAuthDead(), true,
          'so write-scope revocation still latches through a perfectly healthy read path - which is '
          + 'the entire shape the trial write exists to recover from');
        a.discard();
      }

      // (b) A read success DOES protect the read streak, which is the legitimate half of the round-3
      //     complaint: two transient read 401s either side of a proven read 200 are not a revocation.
      {
        let listDies = true;
        const t = H.transport({ list: async () => (listDies ? H.DEAD() : H.OK_LIST()) });
        const a = H.mkAdapter(t.impl);
        try { await a.listAuctions(); } catch (_) { /* expected */ }
        assert.strictEqual(a._readStreak, 1, 'one read refusal');
        listDies = false;
        H.advance(10_000);
        await a.listAuctions();
        assert.strictEqual(a._readStreak, 0, 'an intervening read success resets it');
        listDies = true;
        H.advance(10_000);
        try { await a.listAuctions(); } catch (_) { /* expected */ }
        assert.strictEqual(a.isAuthDead(), false,
          'so two read refusals around a proven read success do NOT latch, even well inside the window');
        assert.strictEqual(a._readStreak, 1, 'the second is a first observation again');
        a.discard();
      }

      // (c) An ACCEPTED WRITE resets both, because it proves both capabilities at once.
      {
        let writesDie = true;
        let listDies = true;
        const t = H.transport({
          bid: async () => (writesDie ? H.DEAD() : H.OK_BID()),
          list: async () => (listDies ? H.DEAD() : H.OK_LIST()),
        });
        const a = H.mkAdapter(t.impl);
        await H.bid(a);
        try { await a.listAuctions(); } catch (_) { /* expected */ }
        assert.strictEqual(a._writeStreak, 1, 'a write refusal...');
        assert.strictEqual(a._readStreak, 1, '...and a read refusal, neither yet at threshold');
        writesDie = false; listDies = false;
        await H.bid(a);
        assert.strictEqual(a._writeStreak, 0, 'an accepted write clears the write streak...');
        assert.strictEqual(a._readStreak, 0,
          '...and the read streak too: the call authenticated AND carried write scope, so it is '
          + 'evidence about both directions at once');
        a.discard();
      }
    } finally { H.realClock(); }
    ok('the two capability streaks reset independently, and only an accepted write resets both');
  }

  // ==============================================================================================
  // B6. THE SETTLE WINDOW, TO THE MILLISECOND, on both edges.
  //     The all-clear is debounced on the RESOLVE edge. That choice is what structurally eliminates
  //     the collision the previous round guarded against and lost: a re-latch inside the window
  //     cancels a message that was NEVER SENT, so there is no delivered "back online" to contradict
  //     and no sent-marked dedupe key for a later message to be swallowed by.
  // ==============================================================================================
  {
    // (a) The emit instant itself: settleMs - 1 is silent, settleMs emits.
    {
      H.freezeClock();
      try {
        let answer = 'auth';
        const t = H.transport({ bid: async () => (answer === 'auth' ? H.DEAD() : H.OK_BID()) });
        const restored = [];
        const a = H.mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
        await H.latchWrites(a);
        const episode = a.authEpisodeSince();
        H.advance(a.authWriteTrialIntervalMs);
        answer = 'ok';
        await H.bid(a);
        assert.strictEqual(a.authState(), 'CLEAR', 'the trial write cleared the latch');
        assert.strictEqual(restored.length, 0, 'and armed the all-clear rather than sending it');

        H.advanceFiring(a.authSettleMs - 1);
        assert.strictEqual(restored.length, 0, 'THE BOUNDARY: one ms short of the settle window, still silent');
        assert.strictEqual(a.authEpisodeSince(), episode, 'and the episode is still open');
        H.advanceFiring(1);
        assert.strictEqual(restored.length, 1, 'at exactly authSettleMs the all-clear is emitted');
        assert.strictEqual(a.authEpisodeSince(), null, 'and THAT emit - nothing else - closes the episode');
        H.advanceFiring(a.authSettleMs * 3);
        assert.strictEqual(restored.length, 1, 'and it is emitted once, not on a repeating timer');
      } finally { H.realClock(); }
    }

    // (b) A re-latch at settleMs - 1 CANCELS the pending message. Not "collides with", not
    //     "deduped against" - cancels, because nothing was sent.
    {
      H.freezeClock();
      try {
        let answer = 'auth';
        const t = H.transport({ bid: async () => (answer === 'auth' ? H.DEAD() : H.OK_BID()) });
        const restored = [], dead = [];
        const a = H.mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p), onAuthDead: (p) => dead.push(p) });
        await H.latchWrites(a);
        const episode = a.authEpisodeSince();
        H.advance(a.authWriteTrialIntervalMs);
        answer = 'ok';
        await H.bid(a);
        H.advanceFiring(a.authSettleMs - 1);
        assert.strictEqual(restored.length, 0, 'still pending at settleMs - 1');

        answer = 'auth';
        await H.bid(a); await H.bid(a);
        assert.strictEqual(a.isAuthDead(), true, 're-latched with one ms of the window left');
        assert.strictEqual(restored.length, 0, 'and the pending all-clear was cancelled outright');
        H.advanceFiring(a.authSettleMs * 4);
        assert.strictEqual(restored.length, 0,
          'THE COLLISION CLASS, ABSENT BY CONSTRUCTION: it never fires later either - there is no '
          + 'delivered all-clear anywhere for the re-latch to contradict');
        assert.strictEqual(a.authEpisodeSince(), episode,
          'and the episode never closed, so the down-alert key and the suppression clock both still stand');
        assert.strictEqual(dead.length, 1, 'with no second down-alert minted for the same outage');
      } finally { H.realClock(); }
    }

    // (c) The trial cadence is HALF the settle window, which is what makes (b) reachable in normal
    //     operation rather than exotic. Pinned so the two constants cannot drift apart silently -
    //     their relationship is the whole reason the debounce sits on the resolve edge.
    {
      H.freezeClock();
      try {
        const a = H.mkAdapter(H.transport().impl);
        assert.ok(a.authSettleMs > a.authWriteTrialIntervalMs,
          'the settle window must outlast a full trial interval, or a flapping session emits an '
          + 'all-clear between two refusals of the same outage');
        assert.strictEqual(a.authWriteTrialIntervalMs, a.authProbeIntervalMs,
          'and the trial cadence and the liveness heartbeat stay coupled BY TEST, not by comment - '
          + 'a prose-only coupling is one edit away from being untrue');
      } finally { H.realClock(); }
    }
    ok('the settle window is exact on both edges, and a re-latch inside it cancels rather than collides');
  }

  // ==============================================================================================
  // B7. CONCURRENT TRIAL CLAIMS. "One write per interval" is an assertion about the event loop, so it
  //     is EXECUTED rather than reasoned about. Two failure shapes matter: two claims both winning
  //     (the 360-refusal incident returning under a new name), and a claim being CONSUMED by a write
  //     that never reached the wire (which extends the outage by a whole interval for free).
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const t = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const a = H.mkAdapter(t.impl);
      await H.latchWrites(a);
      const base = t.calls.bid.length;

      // The claim instant itself: due - 1 refuses, due succeeds.
      H.advance(a.authWriteTrialIntervalMs - 1);
      await H.bid(a);
      assert.strictEqual(t.calls.bid.length, base, 'one ms short of the interval, the trial is not due');
      H.advance(1);

      // ...and twenty writes issued in ONE turn, before any of them awaits, spend exactly one trial
      // between them. This is the property the synchronous claim exists for.
      const results = await Promise.all(Array.from({ length: 20 }, () => H.bid(a)));
      assert.strictEqual(t.calls.bid.length, base + 1,
        'twenty concurrent writes spend the interval\'s ONE trial between them, not twenty');

      // WHAT THE NINETEEN LOSERS ARE HANDED, which is the half of this that reaches the engine. A
      // claim-race loser must be indistinguishable from an ordinary auth refusal: the engine's undo
      // is keyed off `reason === 'session_logged_out'` via isAuthRejection, so a loser given anything
      // else - a bare null, a throw, a rejection with a different reason - takes a DIFFERENT path and
      // keeps the bookkeeping the fire point spent on a write that never touched the wire. Every one
      // of the twenty answers with the same envelope here, winner included (its write was refused
      // too), so no caller can tell whether it lost a race or was refused by SuperProcure - and both
      // are handled identically, which is why it does not need to.
      assert.strictEqual(results.filter((r) => r && r.accepted).length, 0, 'none of the twenty was accepted');
      assert.strictEqual(results.filter((r) => r && r.reason === 'session_logged_out').length, 20,
        'and all twenty answer with the SAME held/refused envelope, so the engine reverses all twenty '
        + 'through one path rather than nineteen of them silently keeping a spent fire point');
      assert.strictEqual(results.filter((r) => r && r.status === 401).length, 20,
        'each carrying the status the engine classifies on');

      // THE SLOT MUST NOT BE CONSUMED BY A WRITE THAT NEVER REACHES THE WIRE. A claim taken at the
      // top of placeBid was spent by any throw between there and the request - an expiring session, a
      // bad vehicle count, a floor assertion - with nothing sent and no path that gave it back.
      H.advance(a.authWriteTrialIntervalMs);
      let threw = null;
      // vcq 0 is neither the -1 sentinel nor a positive count, so buildBidPayload's assertion throws
      // AFTER the peek and BEFORE the wire - exactly the window the claim must not sit in.
      try { await a.placeBid(23795726, 26_000, { floor: 20_000, vcq: 0 }); } catch (e) { threw = e; }
      assert.ok(threw, 'a payload-build failure still throws, unchanged');
      assert.strictEqual(t.calls.bid.length, base + 1, 'and nothing reached the wire, as expected');
      const afterThrow = t.calls.bid.length;
      await H.bid(a);
      assert.strictEqual(t.calls.bid.length, afterThrow + 1,
        'THE CONSUMED SLOT: the very next write still gets the trial, because a throw before the wire '
        + 'never claimed it - the interval was not silently burned');
      a.discard();
    } finally { H.realClock(); }
    ok('the trial slot is claimed at the wire, exactly once per interval, and never by a write that failed earlier');
  }

  // ==============================================================================================
  // B8. TEARDOWN RACING IN-FLIGHT WORK. A bid write can still be awaiting its response when the
  //     operator reconnects and the stack is discarded. Both outcomes are dangerous and both are
  //     driven here for real, with the discard landing while the response is genuinely in flight:
  //       a 401 would latch a dead adapter, re-arm its probe, and write into the bookkeeping of the
  //         NEWER outage the replacement adapter now owns;
  //       a 201 would emit an all-clear for a stack that no longer exists.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const mkInFlight = (finalResp) => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const t = H.transport({ bid: async () => { await gate; return finalResp(); } });
        return { t, release };
      };

      // (i) a 401 resolving after discard
      {
        const { t, release } = mkInFlight(H.DEAD);
        const dead = [];
        const a = H.mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p) });
        const p1 = H.bid(a);
        const p2 = H.bid(a);
        a.discard();                       // teardownStack, while both writes are on the wire
        release();
        await Promise.all([p1, p2]);
        assert.strictEqual(a.isAuthDead(), false,
          'THE STALE LATCH: a 401 arriving after discard cannot latch the adapter it arrived on');
        assert.strictEqual(a.authEpisodeSince(), null, 'and opens no episode...');
        assert.strictEqual(dead.length, 0, '...so it cannot raise an alert against a newer outage\'s account');
        assert.strictEqual(a._authProbeTimer, null, 'nor re-arm a heartbeat on an object nobody holds');
        assert.strictEqual(a.authProbeEnabled, false, 'the permission itself is revoked, not just the handle');
      }

      // (ii) a 201 resolving after discard - the mirror, and the one that would speak to the desk
      {
        const { t, release } = mkInFlight(H.OK_BID);
        const restored = [];
        const a = H.mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
        // Put it in a latched state with an open episode first, so there is something to wrongly clear.
        a._latchedSince = H.now() - 10_000;
        a._episodeSince = H.now() - 10_000;
        a._trialDueAt = null;
        const p = H.bid(a);
        a.discard();
        release();
        await p;
        H.advanceFiring(a.authSettleMs * 3);
        assert.strictEqual(restored.length, 0,
          'THE PHANTOM ALL-CLEAR: an accepted write resolving after discard tells the desk nothing - '
          + 'the episode belongs to the account and its replacement adapter, not to this corpse');
        assert.strictEqual(H.pendingTimers(), 0, 'and no settle timer is left armed behind it');
      }

      // (iii) AN INHERITED EPISODE IS NEVER SILENT. An adapter built mid-outage carries the episode
      //       but none of the previous instance's raise bookkeeping, so "have we raised for this
      //       episode yet" is null on a genuinely open outage. If the fresh token is ALSO already
      //       dead - a reconnect that reused a stale stored token rather than minting one - the desk
      //       must still hear about it rather than the raise being swallowed by a cadence that never
      //       started. Narrow, but silence is the exact failure mode this mechanism exists to remove.
      {
        const t = H.transport();
        const dead = [];
        const episode = H.now() - 600_000;
        const a = H.mkAdapter(t.impl, { onAuthDead: (p) => dead.push(p), inheritedEpisodeSince: episode,
          tokenLifeMs: 60_000 });
        H.setClock(a.account.tokenExp);          // the inherited-outage account's new token is dead too
        assert.strictEqual(a.authState(), 'EXPIRED', 'the fresh adapter is dead on arrival');
        await H.bid(a);
        assert.strictEqual(dead.length, 1,
          'and it still pages the desk, rather than being swallowed because no raise was recorded yet');
        assert.strictEqual(dead[0].since, episode,
          'under the INHERITED episode id, so it closes the message the desk is already holding');
        a.discard();
      }

      // (iv) discard also cancels an ALREADY-ARMED all-clear, which is the case where the message is
      //       moments away from going out on a stack that is being torn down.
      {
        let answer = 'auth';
        const t = H.transport({ bid: async () => (answer === 'auth' ? H.DEAD() : H.OK_BID()) });
        const restored = [];
        const a = H.mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
        await H.latchWrites(a);
        H.advance(a.authWriteTrialIntervalMs);
        answer = 'ok';
        await H.bid(a);
        assert.ok(H.pendingTimers() > 0, 'an all-clear is armed and pending');
        a.discard();
        assert.strictEqual(H.pendingTimers(), 0, 'discard cancels it');
        H.advanceFiring(a.authSettleMs * 3);
        assert.strictEqual(restored.length, 0, 'so it never fires from a discarded stack');
      }
    } finally { H.realClock(); }
    ok('a discarded adapter is inert to every callback that can still arrive on it');
  }

  // ==============================================================================================
  // B9. THE QUIET ACCOUNT: the settle timer is what emits, and nothing else is required.
  //
  //     Every other settle check here advances the clock and lets the timer run in the same motion,
  //     which would still pass if the emit were secretly being driven by some later auth event
  //     instead of by the armed timer. That distinction is not academic: the account whose recovery
  //     this most affects is the QUIET one - an account with no armed loads has no further writes, no
  //     discovery reads it needs to make, and a probe that was stopped the instant the latch cleared,
  //     so if the timer is not genuinely armed and genuinely sufficient, its all-clear never goes out
  //     and the desk hand-quotes an account that came back minutes ago.
  //
  //     Driven in two steps that the harness can separate and a real clock cannot: time is first
  //     moved WITHOUT running timers (nothing may be emitted - there is no other driver), and only
  //     then are the due timers run (the message goes out). Zero auth calls of any kind in between,
  //     asserted on the transport rather than trusted.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      let answer = 'auth';
      const t = H.transport({ bid: async () => (answer === 'auth' ? H.DEAD() : H.OK_BID()) });
      const restored = [];
      const a = H.mkAdapter(t.impl, { onAuthRestored: (p) => restored.push(p) });
      await H.latchWrites(a);
      const episode = a.authEpisodeSince();

      H.advance(a.authWriteTrialIntervalMs);
      answer = 'ok';
      const provenAt = H.now();
      await H.bid(a);
      assert.strictEqual(a.authState(), 'CLEAR', 'the trial write proved the write scope');
      assert.ok(a._resolveTimer, 'and a settle timer is GENUINELY ARMED, not merely implied by a later flush');
      assert.strictEqual(H.pendingTimers(), 1,
        'exactly one - the liveness probe was stopped by the same accepted write, so the settle timer '
        + 'is the only thing left that could ever speak');

      // From here the account is completely quiet: no bids, no reads, no probe.
      const quiet = { bid: t.calls.bid.length, list: t.calls.list.length, base: t.calls.base.length };

      H.advance(a.authSettleMs * 3);            // time passes; timers do NOT run
      assert.strictEqual(restored.length, 0,
        'TIME ALONE EMITS NOTHING: there is no second driver reading the clock on the side - if the '
        + 'timer were never armed, this account would stay silent forever');
      assert.strictEqual(a.authEpisodeSince(), episode, 'and the episode is still open');

      H.advanceFiring(0);                        // now run what is due, and nothing else
      assert.strictEqual(restored.length, 1,
        'THE TIMER ALONE SETTLES IT: one all-clear, with no later auth event anywhere to flush it');
      assert.strictEqual(a.authEpisodeSince(), null, 'and that emit closes the episode');
      assert.strictEqual(restored[0].since, episode, 'keyed to the episode the down-alert named');
      assert.strictEqual(restored[0].downForMs, provenAt - episode,
        'reporting the outage measured to the write that PROVED recovery, not to this deadline - the '
        + 'settle window is our own caution and the desk must not read it as downtime');

      assert.strictEqual(t.calls.bid.length, quiet.bid, 'not one write was needed to get here...');
      assert.strictEqual(t.calls.list.length, quiet.list, '...nor a read...');
      assert.strictEqual(t.calls.base.length, quiet.base, '...nor a login, so the account really was quiet');
      assert.strictEqual(H.pendingTimers(), 0, 'and nothing is left armed behind it');
      a.discard();
    } finally { H.realClock(); }
    ok('the settle timer fires on its own: a quiet account still gets its all-clear');
  }

  // ==============================================================================================
  // B10. THE PROBE CEILING IN LATCHED - the boundary B2 already pins for EXPIRED.
  //
  //      B2 proves the heartbeat puts nothing on the wire once the token is arithmetically dead. But
  //      EXPIRED is not the state a genuine account-wide REVOCATION produces - LATCHED is, and there
  //      the probe re-armed itself unconditionally, forever, with no attempt counter and no backoff.
  //      A long revocation therefore re-authenticated a known-bad credential every 90s for as long as
  //      it lasted, which is exactly the unattributable traffic on BRL's live shared account that
  //      stopping the probe in EXPIRED exists to avoid.
  //
  //      DRIVEN AS ELAPSED TIME, not as a call to the ceiling's own field. The probe re-arms from
  //      inside its login()'s .then(), so the only way to run N cycles is to let the clock reach each
  //      one and drain the microtasks the re-arm rides on - which is also the only shape in which
  //      "the volume stops growing with elapsed time" is a real claim rather than a restatement of the
  //      constant.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const DEAD_401 = H.plaintext(401, H.REVOKED_BODY);
      const t = H.transport({ bid: DEAD_401, base: DEAD_401, list: DEAD_401 }); // fully revoked
      const a = H.mkAdapter(t.impl, { tokenLifeMs: 100 * 3_600_000 });          // ...but NOT expired
      await H.latchWrites(a);
      assert.strictEqual(a.authState(), 'LATCHED',
        'PRECONDITION: the state a real revocation produces, and the one with no ceiling before this');
      assert.ok(a._authProbeTimer, 'with the heartbeat armed');

      // One probe cadence at a time, draining the microtask turns the re-arm rides on.
      const drain = () => new Promise((r) => setImmediate(r));
      const runFor = async (ms) => {
        for (let left = ms; left > 0; left -= a.authProbeIntervalMs) {
          H.advanceFiring(a.authProbeIntervalMs);
          await drain();
        }
      };
      const HOUR = 60 * 60_000;

      await runFor(HOUR);
      const afterOneHour = t.calls.base.length;
      assert.ok(afterOneHour > 0,
        'PRECONDITION: the heartbeat genuinely ran - a check that measured zero probes would pass '
        + 'against a probe that was never armed at all');

      await runFor(5 * HOUR);
      const afterSixHours = t.calls.base.length;
      assert.strictEqual(afterSixHours, afterOneHour,
        `BOUNDED: five further hours of an unchanged revocation added ZERO logins (${afterOneHour} in `
        + 'total). Before this the volume grew linearly with the outage, forever');

      await runFor(18 * HOUR);
      assert.strictEqual(t.calls.base.length, afterOneHour, 'and a full day changes nothing either');
      assert.strictEqual(a._authProbeTimer, null, 'with no timer left armed to resume on its own');
      assert.strictEqual(a.authState(), 'LATCHED',
        'while the account is still, correctly, latched - the ceiling stands the HEARTBEAT down, it '
        + 'does not declare the outage over');

      // ...AND RECOVERY IS UNAFFECTED, which is the whole reason a hard ceiling is safe here. The
      // probe is a read and never could clear the latch; the trial write is what does, it runs on its
      // own cadence, and it is still due.
      assert.strictEqual(a.authWriteTrialDue(), true,
        'the trial write - the ONLY thing that can ever clear this latch - is still due, so standing '
        + 'the heartbeat down costs nothing an operator or the engine needs');

      // A later outage gets a fresh allowance rather than inheriting a spent one: an accepted write
      // clears the latch, and the next latch re-arms from zero.
      t.calls.base.length = 0;
      a.fetchImpl = H.transport().impl;                       // the session comes back
      await H.bid(a);
      assert.strictEqual(a.authState(), 'CLEAR', 'an accepted write clears the latch');
      a.fetchImpl = t.impl;                                   // ...and is revoked again later
      await H.latchWrites(a);
      assert.strictEqual(a.authState(), 'LATCHED', 're-latched by a genuinely new revocation');
      await runFor(HOUR);
      assert.ok(t.calls.base.length > 0,
        'THE COUNTER IS PER-OUTAGE: the new outage gets its own hour of heartbeat rather than '
        + 'inheriting the previous one\'s exhausted ceiling');
      a.discard();
    } finally { H.realClock(); }
    ok('the liveness heartbeat is bounded in LATCHED too, and a later outage gets a fresh allowance');
  }

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
