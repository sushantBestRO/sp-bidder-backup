'use strict';
/**
 * THE FIVE-SCENARIO PROOF, EXECUTED.
 *
 * The reconciled design was justified by walking five scenarios and arguing that the state machine
 * holds under each. An argument that a design is correct is not evidence that the CODE is - three
 * previous rounds each had a written argument for the thing that then broke - so each of the five is
 * driven here end to end against the real adapter, the real engine and the real composition-root
 * ledger, with only the HTTP transport stubbed.
 *
 *   S1  the 2026-08-04 incident shape, in BOTH its variants: SuperProcure revoking the session, and
 *       the token silently lapsing on its own
 *   S2  write-scope-only revocation that never auto-recovers
 *   S3  a flapping / degrading session producing BOUNDED alert noise
 *   S4  two loads racing one trial slot
 *   S5  reconnect / restart racing an in-flight write
 *
 * The scenarios are about COMPOSED behaviour. Every layer's local property was already correct and
 * even verified in the rounds that failed; what broke was what the layers did together, and nothing
 * owned that. These checks own it.
 *
 *   node scripts/test-auth-scenarios.js
 */
const assert = require('assert');
const H = require('./lib/auth-harness');
const { raiseAuthDead, raiseAuthRestored, raiseAuthConfirming } = require('../src/notify/authAlert');
const { templateFor, renderMessage } = require('../src/notify/waTemplates');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const EXPECTED_CHECKS = 8;
process.on('exit', () => {
  H.cleanup();
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

/**
 * The desk with its REAL delivery stack behind it - the notifier, its permanent sent-mark store and a
 * WhatsApp client over a capturing transport. `deskFeed` below records what was RAISED; this records
 * what was actually SENT, which is a different number precisely when a dedupe key is reused.
 */
const DESK_CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const DESK_RECIPIENTS = [{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }];
function realDesk() {
  const sent = [];
  const transport = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient(Object.assign({ enabled: true, transport }, DESK_CREDS));
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => DESK_RECIPIENTS,
    healthProvider: async () => true });
  // raiseAuthDead is fire-and-forget by contract (it is on the bid path and may never block), so the
  // promise it does not return is captured here instead.
  const inFlight = [];
  const raiser = { alert: (...args) => { const p = notifier.alert(...args); inFlight.push(p); return p; } };
  return {
    sent,
    hooks: { onAuthDead: (p) => raiseAuthDead(raiser, p), onAuthRestored: () => {} },
    settle: async () => { await Promise.all(inFlight.splice(0)); },
  };
}

/** Collect what the desk would actually receive, through the real raisers and templates. */
function deskFeed() {
  const sent = [];
  const notifier = { alert: async (kind, payload, opts) => { sent.push({ kind, payload, opts }); } };
  return {
    notifier,
    sent,
    // Byte-for-byte the closure shape src/web/server.js buildRealStack installs.
    hooks: (ledger) => ({
      onAuthDead: (p) => { if (ledger) ledger.note(p); raiseAuthDead(notifier, p); },
      onAuthRestored: (p) => { if (ledger) ledger.clear(p.accountId); raiseAuthRestored(notifier, p); },
    }),
    keys: (flag) => sent.filter((s) => s.payload && s.payload[flag]).map((s) => s.opts.dedupeKey),
    count: (flag) => sent.filter((s) => s.payload && s.payload[flag]).length,
  };
}

(async () => {
  // ==============================================================================================
  // S1a. THE 2026-08-04 SHAPE, SERVER-REVOCATION VARIANT.
  //
  //      What actually happened: SuperProcure stopped accepting the session, the adapter read the
  //      401s as ordinary price refusals, and 41 loads walked their ladders to the floor and closed
  //      with nothing on the board. 360 write attempts, and 56 WhatsApp messages to ~7 recipients -
  //      every one of them a symptom of a single cause nobody had been told.
  //
  //      The whole point of the design is the arithmetic here: ~1 cause message instead of 56 symptom
  //      messages, and ~25 refused writes instead of 360.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const desk = deskFeed();
      const t = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const a = H.mkAdapter(t.impl, Object.assign({ tokenLifeMs: 10 * 3_600_000 }, desk.hooks(null)));

      // 38 minutes of a live incident, on the engine's real hot cadence.
      const INCIDENT_MS = 38 * 60_000;
      const TICK_MS = 200;
      for (let elapsed = 0; elapsed < INCIDENT_MS; elapsed += TICK_MS) {
        H.advance(TICK_MS);
        if (a.authWriteHeld()) { await H.bid(a); continue; }   // held: never reaches the wire
        await H.bid(a);
      }

      assert.strictEqual(a.isAuthDead(), true, 'the account is latched for the whole incident');
      assert.strictEqual(desk.count('authDead') >= 1, true, 'the desk is told the cause at least once');
      assert.strictEqual(new Set(desk.keys('authDead')).size, 1,
        'THE FLOOD, GONE: every message in the incident shares ONE dedupe key, so the notifier '
        + 'collapses them to a single delivered message - 56 symptom messages become 1 cause message');
      assert.strictEqual(desk.count('authRestored'), 0, 'and no all-clear is invented while it is still dead');

      // The wire arithmetic: two latching writes plus one trial per interval, and nothing else.
      const expectedTrials = Math.floor(INCIDENT_MS / a.authWriteTrialIntervalMs);
      assert.ok(t.calls.bid.length <= 2 + expectedTrials + 1,
        `THE 360 WRITES, GONE: ${t.calls.bid.length} writes reached SuperProcure across 38 minutes, `
        + `not 360 - two to latch plus one trial per ${a.authWriteTrialIntervalMs / 1000}s`);
      assert.ok(t.calls.bid.length >= 2 + expectedTrials - 1,
        'and the trial really did keep firing - a latch that stops probing can never recover');

      // The re-offers are BOUNDED, not per-tick: 38 minutes at 15-minute cadence is 2 further offers.
      assert.ok(desk.count('authDead') <= 4,
        `the bounded delivery retry offered the message ${desk.count('authDead')} times in 38 minutes, `
        + 'not once per refusal - a retry that fired per tick would be the flood wearing new jargon');

      // ...and the message a human actually reads names the account and what to do.
      const body = renderMessage('account_auth_dead', desk.sent.find((s) => s.payload.authDead).payload);
      assert.ok(/Primary/.test(body), 'the message names the account');
      assert.ok(/Sushant/.test(body), 'and the person who can fix it');
      assert.ok(!/401|token/i.test(body), 'without saying 401 or token to a desk and a Director');
      a.discard();
    } finally { H.realClock(); }
    ok('S1a: a server revocation produces ONE cause message and ~25 writes, not 56 messages and 360 writes');
  }

  // ==============================================================================================
  // S1b. THE SAME INCIDENT, SILENT-LOCAL-EXPIRY VARIANT.
  //
  //      This is the variant that actually triggered 2026-08-04: nobody caught the five token-expiry
  //      warnings and the token simply lapsed. There is no SuperProcure response to react to and
  //      there is no revocation - the credential just runs out - which is precisely why the round-3
  //      shape went silent on it. The account must go dead, alert, and touch nothing on the wire.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const desk = deskFeed();
      const t = H.transport();                     // everything would succeed; nothing must be asked
      const a = H.mkAdapter(t.impl, Object.assign({ tokenLifeMs: 5 * 60_000 }, desk.hooks(null)));
      const exp = a.account.tokenExp;

      // Before expiry: entirely normal.
      const r0 = await H.bid(a);
      assert.strictEqual(r0.accepted, true, 'before expiry the account bids normally');
      assert.strictEqual(a.authState(), 'CLEAR', 'and reads CLEAR');
      const wireAtExpiry = t.calls.bid.length;

      // The token lapses. Nothing is called, nothing transitions - the state is DERIVED.
      H.setClock(exp);
      assert.strictEqual(a.authState(), 'EXPIRED',
        'the instant the token lapses the account is EXPIRED, with nobody having had to notice');

      // Discovery's own poll is what feeds the alert loop - the design's stated mechanism.
      let readThrew = null;
      try { await a.listAuctions(); } catch (e) { readThrew = e; }
      assert.ok(readThrew && readThrew.code === 'AUTH', 'discovery gets a thrown code AUTH...');
      assert.strictEqual(readThrew.authReason, 'token_expired', '...tagged as expiry, not as a refusal');
      assert.strictEqual(desk.count('authDead'), 1,
        'THE 2026-08-04 SILENCE, CLOSED: one discovery poll against a lapsed token pages the desk');

      // Every subsequent bid is silent locally and raises nothing new.
      for (let i = 0; i < 200; i++) await H.bid(a);
      assert.strictEqual(t.calls.bid.length, wireAtExpiry,
        'and two hundred further bid attempts put ZERO requests on the wire');
      assert.strictEqual(desk.count('authDead'), 1, 'under one message, not two hundred');

      // THE COPY NAMES THE ACTUAL CAUSE, because the two causes have different remedies. A
      // revocation is SuperProcure's action and the desk can only escalate and wait; a login that ran
      // out of time is fixed by signing the account in again for a fresh code, which is something the
      // reader can start immediately. Rendering the revocation copy here (which is what happened
      // while the raiser dropped this fact) says SuperProcure logged us out when SuperProcure did
      // nothing at all, and points at no remedy.
      const p = desk.sent.find((s) => s.payload.authDead).payload;
      assert.strictEqual(p.authReason, 'token_expired',
        'the cause survives the raiser rather than being destructured away');
      assert.strictEqual(templateFor('error', p), 'account_auth_expired',
        'and selects the expiry copy rather than the generic logged-out copy');
      const ebody = renderMessage('account_auth_expired', p);
      assert.ok(/expired/i.test(ebody), 'which names expiry in the desk\'s own words');
      assert.ok(/sign(ed)? this account in again|signed in again/i.test(ebody),
        'and states the remedy - it has to be signed in again, not merely reported');
      assert.ok(/code sent to/i.test(ebody), 'naming the verification code the sign-in needs');
      assert.ok(/capture (the )?new login/i.test(ebody),
        'and tells whoever signs in to CAPTURE the new login, not just sign in - '
        + 'signing in and handing us the new session are two different actions');
      assert.ok(/quote these loads/i.test(ebody),
        'while KEEPING the hand-quoting instruction, because the account still cannot bid');
      assert.ok(!/401|token/i.test(ebody), 'and without saying 401 or token to a desk and a Director');
      assert.ok(!/undefined|NaN|\{\{/.test(ebody), 'with nothing unresolved reaching the desk');
      // 2026-09-16 length trim: the client flagged this alert as too long.
      assert.ok(!/then quote these loads on the SuperProcure portal for now/i.test(ebody),
        'and drops the old wordier closing');

      // ...and a payload with no cause on it still renders SOMETHING true. A pre-fix persisted event
      // or a hand-rolled stub carries no authReason, and it must degrade to the general copy rather
      // than to a blank or to a claim about expiry nobody made.
      assert.strictEqual(templateFor('error', { authDead: true }), 'account_auth_dead',
        'a down-alert with no recorded cause falls back to the general logged-out copy');
      a.discard();
    } finally { H.realClock(); }
    ok('S1b: a token that silently lapses goes dead, pages the desk once, and touches nothing on the wire');
  }

  // ==============================================================================================
  // S2. WRITE-SCOPE-ONLY REVOCATION THAT NEVER AUTO-RECOVERS.
  //
  //     Reads keep working and writes do not. Three things must all hold at once, and each of them
  //     was broken in a different round:
  //       - it must LATCH, through a completely healthy read path (round 3's prescribed "reset the
  //         streak on any success" would have made this unlatchable);
  //       - it must never SELF-CLEAR on read evidence (round 1);
  //       - reads must KEEP WORKING, or the latch is a deadlock nothing can ever clear (round 2).
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const desk = deskFeed();
      const t = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });  // reads succeed throughout
      const a = H.mkAdapter(t.impl, Object.assign({ tokenLifeMs: 10 * 3_600_000 }, desk.hooks(null)));

      // Interleave healthy reads with the failing writes, so the latch has to happen THROUGH them.
      await H.bid(a);
      await a.listAuctions();
      await a.login();
      H.advance(20_000);
      await H.bid(a);
      assert.strictEqual(a.isAuthDead(), true,
        'IT LATCHES through a perfectly healthy read path - which is the signature of this shape, '
        + 'not evidence against it');
      const episode = a.authEpisodeSince();

      // Two hours of the account being read-healthy and write-dead.
      for (let i = 0; i < 80; i++) {
        H.advance(90_000);
        const loads = await a.listAuctions();
        assert.ok(Array.isArray(loads), 'THE DEADLOCK-BREAKER: discovery keeps reading throughout');
        await a.login();
        await H.bid(a);                                   // this interval's trial - still refused
        assert.strictEqual(a.isAuthDead(), true, 'and it never self-clears on read evidence');
      }

      assert.strictEqual(desk.count('authRestored'), 0,
        'NOT ONE all-clear is minted across two hours of continuous read success');
      assert.strictEqual(a.authEpisodeSince(), episode,
        'the episode never moves, so the suppression clock runs down to its bound as intended');

      // ...and past the bound, the engine's zero-bid alarm comes BACK. A stuck latch has to degrade to
      // noise, never to silence - which is the whole reason the bound exists.
      const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      Object.assign(eng.adapter, H.fakeLatch({
        dead: true, deadSince: H.now() - 5_000, episodeSince: H.now() - (7_200_000 + 1),
      }));
      eng.adapter.getAuctionState = async () => ({ ok: false });
      m.authBlockedLast = true;
      await eng._finalize(m, H.state(0, null));
      assert.strictEqual(H.alertsOfKind(eng, 'never_bid_before_close').length, 1,
        'past the suppression bound the zero-bid alarm resumes - a stuck latch degrades to noise, '
        + 'never to the 2026-07-13 silence');
      a.discard();
    } finally { H.realClock(); }
    ok('S2: write-scope-only revocation latches, never self-clears, keeps reading, and degrades to noise');
  }

  // ==============================================================================================
  // S3. A FLAPPING / DEGRADING SESSION PRODUCES BOUNDED ALERT NOISE.
  //
  //     The failure this replaces produced ~60 alternating "logged out" / "back online" messages in
  //     95 minutes - versus the 56 the whole line of work exists to delete. The resolve-side debounce
  //     is what makes that structurally impossible: an all-clear is emitted only after the account
  //     has been continuously healthy for the settle window, so a session flapping on the trial
  //     cadence never emits one at all.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const desk = deskFeed();
      let answer = 'auth';
      const t = H.transport({ bid: async () => (answer === 'auth' ? H.DEAD() : H.OK_BID()) });
      const a = H.mkAdapter(t.impl, Object.assign({ tokenLifeMs: 10 * 3_600_000 }, desk.hooks(null)));
      await H.latchWrites(a);
      const episode = a.authEpisodeSince();

      // 95 minutes of flapping ON THE TRIAL CADENCE - one accepted write, then straight back to 401.
      // This is not an exotic pattern: the trial interval is half the settle window by design, so it
      // is exactly what a degrading session does.
      for (let i = 0; i < 63; i++) {
        H.advanceFiring(a.authWriteTrialIntervalMs);
        answer = 'ok';
        await H.bid(a);                      // clears, and ARMS an all-clear
        answer = 'auth';
        H.advanceFiring(5_000);
        await H.bid(a); await H.bid(a);      // re-latches, CANCELLING the pending all-clear
      }

      assert.strictEqual(desk.count('authRestored'), 0,
        'THE ~60-MESSAGE BURST, GONE: not one all-clear across 63 flap cycles, because every one of '
        + 'them cancelled a message that had not been sent - there is nothing to collide with');
      assert.strictEqual(new Set(desk.keys('authDead')).size, 1,
        'and every down-alert in the whole 95 minutes rides ONE dedupe key');
      assert.ok(desk.count('authDead') <= 8,
        `with the raiser invoked ${desk.count('authDead')} times on its bounded cadence, not per flap`);
      assert.strictEqual(a.authEpisodeSince(), episode, 'one episode throughout, so the clock never rewinds');

      // ...and when it FINALLY stabilises, exactly one all-clear closes exactly that episode.
      H.advanceFiring(a.authWriteTrialIntervalMs);
      answer = 'ok';
      await H.bid(a);
      H.advanceFiring(a.authSettleMs);
      assert.strictEqual(desk.count('authRestored'), 1, 'a genuine recovery still gets its all-clear...');
      assert.strictEqual(desk.sent.find((s) => s.payload.authRestored).payload.since, episode,
        '...keyed to the episode the down-alert opened, so the pair closes the same message');
      assert.strictEqual(a.authEpisodeSince(), null, 'and the episode closes on the emit, not before');
      a.discard();
    } finally { H.realClock(); }
    ok('S3: a session flapping for 95 minutes produces one down-message and zero premature all-clears');
  }

  // ==============================================================================================
  // S4. TWO LOADS RACING ONE TRIAL SLOT, through the real engine.
  //
  //     Both monitors tick on the same 200ms cadence against one adapter. The peek that lets them
  //     through lives in the engine and the claim that arbitrates them lives in the adapter, so this
  //     is a genuinely composed property - exactly the class that each previous round got locally
  //     right and globally wrong.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      const t = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const a = H.mkAdapter(t.impl, { tokenLifeMs: 10 * 3_600_000 });
      await H.latchWrites(a);
      const base = t.calls.bid.length;

      const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      eng.adapter = a;                    // the REAL adapter behind the REAL engine
      // NUMERIC auction ids, because this check identifies the race winner off the WIRE PAYLOAD and
      // buildBidPayload sends `load` as Number(auctionId) - a non-numeric id reaches the transport as
      // null and identifies nothing.
      const m1 = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 24000001 });
      const m2 = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 24000002 });
      for (const m of [m1, m2]) { m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000; }

      // Held: neither load reaches the wire at all.
      for (let i = 0; i < 10; i++) {
        await Promise.all([eng._maybeBid(m1, H.state(50_000, 2)), eng._maybeBid(m2, H.state(50_000, 2))]);
        H.advance(200);
      }
      assert.strictEqual(t.calls.bid.length, base, 'while the trial is spent, neither load touches the wire');

      // WHO REACHED THE WIRE, read off the requests SuperProcure would actually have seen rather than
      // inferred. Both loads come out of the race fully restored (that is the point), so nothing on
      // the monitors afterwards can identify the loser - and without identifying it, "the loser is
      // not disadvantaged" cannot honestly be asserted about the loser at all.
      const wireLoads = (from) => t.calls.bid.slice(from)
        .map((c) => { try { return JSON.parse(c.init.body).load; } catch (_) { return null; } });

      // The interval elapses, and BOTH tick in the same turn.
      H.advance(a.authWriteTrialIntervalMs);
      await Promise.all([eng._maybeBid(m1, H.state(50_000, 2)), eng._maybeBid(m2, H.state(50_000, 2))]);
      assert.strictEqual(t.calls.bid.length, base + 1,
        'exactly ONE of the two racing loads spends the interval\'s trial - the claim is the arbiter, '
        + 'and it is synchronous, so there is no window for both to pass it');
      assert.deepStrictEqual(wireLoads(base), [m1.auctionId],
        'and it is the FIRST entrant that wins, deterministically: the claim is a synchronous '
        + 'read-modify-write, so on a single-threaded loop the second load cannot interleave into it');

      // The LOSER must be left completely intact - it did not use the wire, so nothing of its
      // auction may have been spent on a slot it never got.
      const spent = [m1, m2].filter((m) => m.ownBidAttempts > 0);
      const lost = [m1, m2].filter((m) => m.ownBidAttempts === 0);
      assert.strictEqual(spent.length, 0,
        'and BOTH loads come out with their bookkeeping fully restored - the winner\'s write was '
        + 'refused and the loser never wrote, so neither auction spent anything');
      assert.strictEqual(lost.length, 2, 'neither load banked an attempt against a bid that never landed');
      for (const m of [m1, m2]) {
        assert.strictEqual(m.currentRungIndex, 0, `${m.auctionId}: ladder position intact`);
        assert.strictEqual(m.bidTimes.length, 0, `${m.auctionId}: runaway-cap slot refunded`);
        assert.strictEqual(m.everBid, false, `${m.auctionId}: everBid not falsely set`);
        assert.strictEqual(m.authBlockedLast, true, `${m.auctionId}: and both know why they are silent`);
      }

      // THE COST OF LOSING IS BOUNDED, AND IT IS LATENCY - never a lost shot. The loser is not
      // penalised, not de-prioritised and not locked out; it simply meets the next interval as an
      // ordinary eligible write. That is what makes the arbitration acceptable on live money: during
      // a dead-account outage the loser's counterfactual was no bid at all, so the whole exposure is
      // one trial interval of extra recovery latency.
      H.advance(a.authWriteTrialIntervalMs);
      await eng._maybeBid(m2, H.state(50_000, 2));
      assert.deepStrictEqual(wireLoads(base + 1), [m2.auctionId],
        'THE LOSER STAYS ELIGIBLE: the load that lost the previous claim takes the very next '
        + 'interval\'s trial, rather than being held out because a slot it never got was spent');
      assert.strictEqual(t.calls.bid.length, base + 2, 'on exactly one further wire write');
      assert.strictEqual(m2.ownBidAttempts, 0, 'and that refusal is fully undone too, as any other would be');
      a.discard();
    } finally { H.realClock(); }
    ok('S4: two loads racing one trial slot yield exactly one wire write and two fully-restored auctions');
  }

  // ==============================================================================================
  // S5. RECONNECT / RESTART RACING AN IN-FLIGHT WRITE, through the REAL composition-root ledger.
  //
  //     This is the scenario with the most moving parts and the one no single layer can get right:
  //     an operator reconnects mid-outage, the old adapter is discarded while a write is still on the
  //     wire, a brand-new adapter is built on a fresh token, and the outage - which belongs to the
  //     ACCOUNT and not to either adapter - has to survive the handover and close on real evidence.
  //
  //     The failure it replaces: the reconnect announced "back online" off a successful LOGIN, which
  //     is a read, and told the desk to stop hand-quoting an account that might still be unable to
  //     bid. On this account the bot and the desk share one per-load bid cap, so a premature all-clear
  //     costs real money in both directions.
  // ==============================================================================================
  {
    const server = require('../src/web/server');
    H.freezeClock();
    try {
      const desk = deskFeed();
      const ledger = {
        note: (p) => server.noteAuthDeadMark(p),
        clear: (id) => server.clearAuthDeadMark(id),
      };
      server.clearAuthDeadMark('primary');   // this suite shares a module-level ledger; start clean

      // --- the outage opens on adapter #1, with a write left in flight across the teardown
      let release;
      const gate = new Promise((r) => { release = r; });
      let gateUsed = false;
      const t1 = H.transport({ bid: async () => {
        if (!gateUsed && t1.calls.bid.length >= 3) { gateUsed = true; await gate; }
        return H.DEAD();
      } });
      const a1 = H.mkAdapter(t1.impl, Object.assign({ tokenLifeMs: 10 * 3_600_000 }, desk.hooks(ledger)));
      await H.latchWrites(a1);
      const episode = a1.authEpisodeSince();
      assert.strictEqual(server.openAuthEpisodeFor('primary'), episode,
        'the composition root records the open episode as the adapter raises it');

      H.advance(a1.authWriteTrialIntervalMs);
      const inFlight = H.bid(a1);          // a trial write, now hanging on the gate

      // --- the operator reconnects: teardownStack discards #1, buildRealStack builds #2
      a1.discard();
      const inheritedAtBuild = server.openAuthEpisodeFor('primary');
      assert.strictEqual(inheritedAtBuild, episode,
        'THE HANDOVER: the episode outlives the adapter that opened it, because the outage belongs '
        + 'to the account and adapters die on every reconnect');

      const t2 = H.transport();            // fresh token; everything works
      const a2 = H.mkAdapter(t2.impl, Object.assign({
        tokenLifeMs: 10 * 3_600_000, inheritedEpisodeSince: inheritedAtBuild,
      }, desk.hooks(ledger)));
      assert.strictEqual(a2.authState(), 'CLEAR',
        'the fresh adapter inherits the EPISODE but not a latch - nothing has refused its new token, '
        + 'so discovery runs and writes flow, which is what lets it obtain the proof');
      assert.strictEqual(a2.authEpisodeSince(), episode, 'while still carrying the open outage');

      // activateRealStack's announcement: provisional, and it does NOT retract the hand-quoting.
      const announced = server.announceAuthReconnecting('primary', 'Primary');
      assert.strictEqual(announced, true, 'a reconnect mid-outage announces something');
      assert.strictEqual(desk.count('authRestored'), 0,
        'THE PREMATURE ALL-CLEAR, GONE: a reconnect proves a LOGIN, which is a read, and this platform '
        + 'can revoke write scope while still serving reads - so it may not claim recovery');

      // ...and the in-flight write from the DISCARDED adapter now resolves 401.
      //
      // a1 was already latched before the race, so "is it dead" is trivially true and proves nothing.
      // The property that matters is that the stale response changed NOTHING: it did not re-enter the
      // state machine, did not move a streak, did not re-arm a probe, and did not speak to anybody.
      const staleBefore = { latchedSince: a1._latchedSince, writeStreak: a1._writeStreak,
        lastDownRaiseAt: a1._lastDownRaiseAt };
      release();
      await inFlight;
      assert.strictEqual(a1._writeStreak, staleBefore.writeStreak,
        'the stale 401 does not even reach the streak - the discard chokepoint returns above it');
      assert.strictEqual(a1._latchedSince, staleBefore.latchedSince, 'nor re-stamp a latch instant');
      assert.strictEqual(a1._lastDownRaiseAt, staleBefore.lastDownRaiseAt, 'nor re-offer an alert');
      assert.strictEqual(a1._authProbeTimer, null, 'nor re-arm a heartbeat on an object nobody holds');
      assert.strictEqual(a1.authProbeEnabled, false, 'whose permission to probe was revoked outright');
      assert.strictEqual(server.openAuthEpisodeFor('primary'), episode,
        'THE CORRUPTED MARK, GONE: and it cannot write into the bookkeeping of the outage the NEW '
        + 'adapter now owns - the discard chokepoint made it inert before it landed');
      assert.strictEqual(desk.count('authDead'), 1, 'and raises no further alarm from a torn-down stack');

      // --- the episode closes ONLY on an accepted write, through the ordinary path
      await H.bid(a2);
      assert.strictEqual(desk.count('authRestored'), 0, 'an accepted bid alone does not announce yet...');
      H.advanceFiring(a2.authSettleMs);
      assert.strictEqual(desk.count('authRestored'), 1,
        'THE PROOF: the all-clear goes out only after a bid of ours was ACCEPTED and the account then '
        + 'held healthy for the settle window');
      assert.strictEqual(desk.sent.find((s) => s.payload.authRestored).payload.since, episode,
        'closing the SAME episode the pre-reconnect adapter opened, across two adapter lifetimes');
      assert.strictEqual(server.openAuthEpisodeFor('primary'), null,
        'and the composition root\'s ledger clears on the same event, so the two cannot disagree');
      assert.strictEqual(a2.authEpisodeSince(), null, 'as does the adapter\'s own episode');

      // The desk's actual reading order: down -> confirming -> back. The middle one must not read as
      // the last one, or the whole exercise was pointless.
      raiseAuthConfirming(desk.notifier, { accountId: 'primary', accountLabel: 'Primary', since: episode });
      const cbody = renderMessage('account_auth_reconnecting',
        desk.sent.find((s) => s.payload.authConfirming).payload);
      assert.ok(/keep quoting/i.test(cbody), 'the provisional message KEEPS the hand-quoting instruction');
      // 2026-09-16 length trim: the client flagged this one as too long and formal.
      assert.ok(!/until we confirm a bid lands/i.test(cbody), 'and drops the old wordier phrasing');
      const rbody = renderMessage('account_auth_restored', desk.sent.find((s) => s.payload.authRestored).payload);
      assert.ok(/No more manual quoting/i.test(rbody), 'and only the proven all-clear retracts it');

      // A later, unrelated outage on the same account must not inherit any of this.
      server.clearAuthDeadMark('primary');
      assert.strictEqual(server.openAuthEpisodeFor('primary'), null, 'the ledger is empty after the outage');
      a2.discard();
    } finally { H.realClock(); }
    ok('S5: a reconnect racing an in-flight write inherits the outage and closes it only on proven evidence');
  }

  // ==============================================================================================
  // S6. A PROCESS RESTART IN THE MIDDLE OF AN OUTAGE.
  //
  //     The sixth scenario, and the one the ledger was in-memory-only for. Restarting the box is the
  //     single most common thing a human does about a stuck account, so "the outage ends by
  //     restarting the process" is the NORMAL recovery path, not an exotic one - and on the old shape
  //     it was the one path that never sent an all-clear. The desk had been told to hand-quote, and
  //     nothing ever retracted it. That is not merely untidy: the desk and this account share ONE
  //     SuperProcure per-load bid cap, so hand-quoting that nobody stops keeps consuming the cap our
  //     own bids need.
  //
  //     The LATCH deliberately does not survive a restart and the MARK now does, and the asymmetry is
  //     the argument: a persisted latch holds a fresh token's writes off the wire on evidence about a
  //     token that no longer exists (a stuck-latch generator), while a persisted mark holds nothing
  //     off the wire at all - it only remembers that the desk is holding a message that has not been
  //     closed. Its worst failure is one extra "back online".
  // ==============================================================================================
  {
    const server = require('../src/web/server');
    const COLL = server.AUTH_DEAD_MARKS_COLLECTION;
    H.freezeClock();
    try {
      const desk = deskFeed();
      const ledger = { note: (p) => server.noteAuthDeadMark(p), clear: (id) => server.clearAuthDeadMark(id) };
      server.clearAuthDeadMark('primary');
      const episode = H.now() - 600_000;

      // --- the outage is marked, exactly as the adapter's down-alert hook marks it
      server.noteAuthDeadMark({ accountId: 'primary', accountLabel: 'Primary', since: episode });
      const persisted = await server.store.getDoc(COLL, 'primary');
      assert.ok(persisted, 'THE MARK IS DURABLE: it reaches the store and not only the in-memory map');
      assert.strictEqual(persisted.since, episode, 'carrying the EPISODE instant, which is the alert identity');
      assert.strictEqual(persisted.accountLabel, 'Primary', 'and the human label the copy renders');

      // --- pm2 restarts the box. A fresh process starts with an empty map and reads the store back.
      //     Modelled by dropping the in-memory copy and putting the row back the way a dead process
      //     leaves it, then running the same hydration boot() runs before it builds any stack.
      server.clearAuthDeadMark('primary');
      assert.strictEqual(server.openAuthEpisodeFor('primary'), null,
        'a fresh process knows nothing until it reads the store - this is the state the old shape stayed in');
      await server.store.putDoc(COLL, 'primary', persisted);
      await server.loadAuthDeadMarks();
      assert.strictEqual(server.openAuthEpisodeFor('primary'), episode,
        'THE RESTART, SURVIVED: the outage the desk is holding a message about is still open, under '
        + 'the SAME identity that message was keyed to');

      // --- boot builds the stack, whose adapter inherits that episode. It is NOT latched: the token
      //     is freshly read and nothing has refused it, so writes flow and it can obtain the proof.
      const t = H.transport();
      const a = H.mkAdapter(t.impl, Object.assign({
        tokenLifeMs: 10 * 3_600_000, inheritedEpisodeSince: server.openAuthEpisodeFor('primary'),
      }, desk.hooks(ledger)));
      assert.strictEqual(a.authState(), 'CLEAR', 'the post-restart adapter starts CLEAR, never latched');
      assert.strictEqual(a.authEpisodeSince(), episode, 'while carrying the pre-restart outage');
      assert.strictEqual(server.announceAuthReconnecting('primary', 'Primary', a.authEpisodeSince()), true,
        'and activation sends the provisional message rather than claiming recovery off a login');
      assert.strictEqual(desk.count('authRestored'), 0, 'so nothing yet retracts the hand-quoting');

      // --- and the ordinary machinery closes it: an accepted bid, then the settle window.
      await H.bid(a);
      H.advanceFiring(a.authSettleMs);
      assert.strictEqual(desk.count('authRestored'), 1,
        'THE ALL-CLEAR THE RESTART USED TO EAT: the desk is finally told to stop hand-quoting');
      assert.strictEqual(desk.sent.find((s) => s.payload.authRestored).payload.since, episode,
        'closing the very message it was sent before the process died, across a restart AND two adapters');
      assert.strictEqual(server.openAuthEpisodeFor('primary'), null, 'the in-memory ledger clears...');
      assert.strictEqual(await server.store.getDoc(COLL, 'primary'), null,
        '...and so does the persisted row, or the next restart would re-announce a closed outage');
      a.discard();
    } finally { H.realClock(); }
    ok('S6: an outage survives a process restart, and the restart-recovery finally sends its all-clear');
  }

  // ==============================================================================================
  // S7. THE RECONNECT THAT SWALLOWED THE NEXT OUTAGE.
  //
  //     S5 establishes the handover: a reconnect INHERITS the open episode rather than forgetting it,
  //     and closes it only on a proven write. That is right, and it has a tail nobody had walked. The
  //     only thing that ever closes an episode is an accepted write - so an account that reconnects
  //     and then simply has no load to bid, which is most of any given day, carries that inherited
  //     episode indefinitely. Every later revocation on that adapter then reads "an episode is
  //     already open", declines to mint a new identity, and raises its down-alert under the OLD
  //     episode's key. The notifier's sent-mark is permanent and has no TTL (D3 in
  //     test-auth-alert-delivery.js), so the first outage's delivered message swallows the second
  //     outage's alert OUTRIGHT - total silence on a live, current, unrelated revocation, which is
  //     the one failure mode this entire line of work exists to remove.
  //
  //     Asserted through the REAL notifier and its REAL dedupe store, because "the alert was raised"
  //     and "the desk was told" are exactly the two things that came apart here.
  // ==============================================================================================
  {
    H.freezeClock();
    try {
      // --- (a) THE BUG'S OWN SHAPE: inherit, stay quiet for hours, then a distinct new revocation.
      const desk = realDesk();
      const t1 = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const a1 = H.mkAdapter(t1.impl, Object.assign({ tokenLifeMs: 100 * 3_600_000 }, desk.hooks));
      await H.latchWrites(a1);
      const episode = a1.authEpisodeSince();
      await desk.settle();
      assert.strictEqual(desk.sent.length, 1, 'the first outage reaches the desk, once');

      // The operator reconnects onto a working token. The episode is handed over (S5); the latch is
      // not, so writes flow and this adapter COULD prove recovery - it just never gets the chance,
      // because no load happens to be armed on this account for the rest of the day.
      a1.discard();
      const a2 = H.mkAdapter(H.transport().impl, Object.assign({
        tokenLifeMs: 100 * 3_600_000, inheritedEpisodeSince: episode,
      }, desk.hooks));
      assert.strictEqual(a2.authState(), 'CLEAR', 'the replacement starts CLEAR...');
      assert.strictEqual(a2.authEpisodeSince(), episode, '...while carrying the inherited outage');

      H.advance(6 * 3_600_000);   // six quiet hours: no bid, no proof, nothing to close the episode

      // Now SuperProcure revokes the session again. This is a new outage by every measure that
      // matters - a different token, a different cause, six hours later - and the desk knows nothing
      // about it.
      a2.fetchImpl = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) }).impl;
      await H.latchWrites(a2);
      await desk.settle();

      assert.notStrictEqual(a2.authEpisodeSince(), episode,
        'THE IDENTITY: an inherited episode this adapter never confirmed cannot absorb a new outage '
        + 'six hours later - the new one gets its own identity');
      assert.strictEqual(desk.sent.length, 2,
        'THE SWALLOWED ALERT, GONE: the desk is actually told about the second revocation. Under the '
        + 'reused identity this was a permanent no-op - one message total, and silence on a live '
        + 'outage for as long as it lasted');
      assert.ok(/logged out/i.test(String(desk.sent[1].message || '')),
        'and what it reads is the account-down copy, not a fragment of the first message');
      a2.discard();

      // --- (b) THE CONTROL, in the direction the handover is FOR. A reconnect that lands into an
      //     account that is still broken re-latches within its first couple of write attempts, and
      //     that is the SAME outage - it must keep the inherited identity and must NOT mint a second
      //     message. Without this the fix above would be indistinguishable from simply deleting the
      //     handover S5 exists to prove.
      const desk2 = realDesk();
      const t3 = H.transport({ bid: H.plaintext(401, H.REVOKED_BODY) });
      const a3 = H.mkAdapter(t3.impl, Object.assign({ tokenLifeMs: 100 * 3_600_000 }, desk2.hooks));
      await H.latchWrites(a3);
      const episode3 = a3.authEpisodeSince();
      await desk2.settle();
      assert.strictEqual(desk2.sent.length, 1, 'one message for the outage so far');

      a3.discard();
      const a4 = H.mkAdapter(t3.impl, Object.assign({
        tokenLifeMs: 100 * 3_600_000, inheritedEpisodeSince: episode3,
      }, desk2.hooks));
      H.advance(30_000);                     // an operator's reconnect, not six hours of quiet
      await H.latchWrites(a4);               // ...onto an account that is still revoked
      await desk2.settle();

      assert.strictEqual(a4.authEpisodeSince(), episode3,
        'THE HANDOVER IS INTACT: a reconnect that fails again immediately is the same outage, and '
        + 'keeps the identity the desk was already told about');
      assert.strictEqual(desk2.sent.length, 1,
        'so it sends NOTHING further - one outage is still one message, which is the whole point of '
        + 'keying the alert to the episode');
      a4.discard();
    } finally { H.realClock(); }
    ok('S7: an inherited episode nobody ever confirmed cannot swallow the next outage, and a genuine reconnect still shares one');
  }

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
