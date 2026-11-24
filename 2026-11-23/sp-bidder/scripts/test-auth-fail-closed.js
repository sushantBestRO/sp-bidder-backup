'use strict';
/**
 * AUTH FAIL-CLOSED - the session-death class, end to end.
 *
 * Regression target: 2026-08-04. SuperProcure revoked BRL's sessions at 12:07 IST. realAdapter's
 * only session check was the JWT `exp` claim, which had a year to run, so every bid write went out
 * and came back `401 Token is invalid.`. The engine had no AUTH class, read each 401 as a PRICE
 * refusal, and walked the ladder to the floor against a wall - 88 attempts on one load, 360 across
 * ten loads in 38 minutes, zero landed. The desk was told nothing actionable and got 56 post-mortem
 * messages instead.
 *
 * What this file pins, in one sentence each:
 *   1. a 401 gives back EVERYTHING the fire point spent, so the decisive shot survives it
 *   2. a 403 is the same class, on the defend latch
 *   3. an HTTP 400 is still a PRICE refusal and still walks the ladder (the regression guard)
 *   4. the account latches on the SECOND consecutive auth response, never the first
 *   5. a read success does NOT clear the streak; a proven write DOES
 *   6. a latched account never reaches the wire again (the _maybeBid gate)
 *   7. one alert per account per outage, and a second account still gets its own
 *   8. a THROWN auth error never fabricates a landed bid
 *   9. the zero-bid alarm is suppressed while the session is dead - and RESUMES past the time bound
 *  10. the latch cannot survive a reconnect (it is per-adapter-instance, never persisted)
 *
 * MOCK POLICY. Two harnesses, both offline and deterministic. The engine checks drive the REAL
 * BidEngine over a programmable fake adapter (the platform seam is the only thing stubbed - no
 * engine internal is touched). The adapter checks drive the REAL RealSuperProcureAdapter over a
 * stubbed fetchImpl, so the latch, the envelope and the wire-call count are all the real ones. This
 * is live-money code: nothing here reaches a network and no real bid is ever placed.
 *
 *   node scripts/test-auth-fail-closed.js
 */

// Set before the requires so no module caches a threshold above it: this file deliberately drives
// many refusals and the adapter/engine error lines would bury the check output.
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter, PLACE_BID_ENVELOPE_KEYS } = require('../src/platform/realAdapter');
const { raiseAuthDead } = require('../src/notify/authAlert');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered above every check and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE, so an async file that ends early - a
// swallowed rejection, a stray return - reaches exit 0 having asserted nothing and reads as a silent
// green. A count assertion at the BOTTOM does not close that hole; it sits downstream of everything
// it guards. Registering the handler first is what makes it fire on every path out of the process.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 10;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `auth-fail-closed-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const keysOf = (o) => Object.keys(o).sort();

// The rejection envelope key set realAdapter.placeBid returns, pinned identically in
// scripts/test-rejection-classify-contract.js. An auth refusal must be key-for-key the same object:
// the engine classifies on `status`, which is already there, so it needs nothing new - and a new key
// here is a wire-contract change that the contract test's deepStrictEqual would fail on.
//
// THE LIST IS NO LONGER COPIED HERE. It used to be, and the cost is on the record: the per-MT wire
// fix added `bidRate` to placeBid's own return while this branch added _authRejection, and when the
// two were rebased together the auth envelope was left one key short. Both suites stayed green -
// this file's private 12-key copy still matched the 12-key auth envelope it was asserting, and the
// contract suite's 13-key copy never drives a 401 - so the shapes diverged in silence. Four copies
// of one invariant are four chances for a copy to agree with the bug.
//
// It now comes from realAdapter, which OWNS the envelope, and all four assertions across the two
// suites read that one definition. A field added at one construction site and not another therefore
// fails somewhere. See PLACE_BID_ENVELOPE_KEYS for what that does and does not buy.
const ENVELOPE_KEYS = PLACE_BID_ENVELOPE_KEYS;

// SuperProcure's own body on the incident day, verbatim from the 2026-08-04 bid log.
const REVOKED_BODY = 'Token is invalid.';

// ================================================================================================
// HARNESS A - the REAL engine over a programmable fake adapter.
// ================================================================================================

// Note what this adapter does NOT have: isAuthDead / authDeadSince. That is deliberate and is the
// same shape every other engine test's stub has, so these checks also prove the engine's two
// feature-detected reads degrade to "not dead" rather than throwing on an adapter without them.
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

// Per-call programmable placeBid. Each call pops the next outcome off `kinds`; past the end it
// repeats the last. '401' / '403' return the exact shape realAdapter now returns for a dead session.
function program(eng, kinds) {
  const box = { placed: [], calls: 0 };
  let i = 0;
  eng.adapter.placeBid = async (id, price) => {
    box.calls += 1;
    const kind = kinds[Math.min(i, kinds.length - 1)];
    i += 1;
    if (kind === 'throw-auth') { const e = new Error('session_dead'); e.code = 'AUTH'; throw e; }
    if (kind === '401' || kind === '403') {
      return { accepted: false, status: kind === '401' ? 401 : 403, myRank: null, revisionsLeft: null,
        bidVehicleCount: null, amountPMT: null, bidQuantity: null, reason: 'session_logged_out',
        carrierSent: 2667, text: REVOKED_BODY, latencyMs: 12, raw: REVOKED_BODY };
    }
    if (kind === 'reject-other') {
      return { accepted: false, status: 400, reason: 'Bid difference too small.', text: 'Bid difference too small.' };
    }
    box.placed.push(price); // 'ok'
    return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
  };
  return box;
}

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

// ================================================================================================
// HARNESS B - the REAL adapter over a stubbed transport. Routes by URL; any other path is a hard
// failure, so nothing can silently reach the network.
// ================================================================================================
function transport({ bid, list } = {}) {
  const calls = { bid: [], list: [] };
  const defaultBid = async () => ({ status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) });
  const defaultList = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { loadDetails: [] } }) });
  const impl = async (url, init) => {
    const u = String(url);
    if (u.includes('/sp/bids/createV2')) { calls.bid.push({ url: u, init }); return (bid || defaultBid)(u, init); }
    if (u.includes('/sp/loads/v4')) { calls.list.push({ url: u, init }); return (list || defaultList)(u, init); }
    throw new Error('AUTH TEST made an unexpected request: ' + u);
  };
  return { impl, calls };
}

const plaintext = (status, body) => async () => ({ status, headers: { get: () => null }, text: async () => body });

function mkAdapter(fetchImpl, { accountId = 'primary', accountLabel = 'Primary', onAuthDead } = {}) {
  const a = new RealSuperProcureAdapter({ token: 'auth-test-token', fetchImpl, accountId, accountLabel, onAuthDead });
  // A live-enough session so placeBid clears ensureSession and buildBidPayload resolves a carrier.
  // No login() is performed and no credential is real.
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  a.writeEnabled = true;
  return a;
}

const bid = (a) => a.placeBid(23795726, 26_000, { floor: 20_000 });

(async () => {
  // ==============================================================================================
  // 1. A 401 GIVES BACK EVERYTHING THE FIRE POINT SPENT.
  //    The decisive snipe is the sharp case: the fire point advances snipeFired OPTIMISTICALLY
  //    before the await, so a 401 that never reached SuperProcure would otherwise consume the one
  //    shot the auction has - leaving a pristine ladder and still losing the load. This also pins
  //    the bidTimes refund (a refused write placed nothing and must not eat the runaway cap that the
  //    floor shot draws its reserve from) and the ladder markers.
  // ==============================================================================================
  {
    // Arrange - extensions exhausted (extendCap 0) so the decision at 1.5s out IS the decisive snipe
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0, revisionsLeft: 5 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const before = { fired: [...m.firedRungs], rung: m.currentRungIndex, snipe: m.snipeFired,
      defend: m._lastDefendAtExtend, times: m.bidTimes.length, revs: m.revisionsLeft };
    const box = program(eng, ['401', 'ok']);

    // Act
    await eng._maybeBid(m, state(1_500, 2));

    // Assert - the four fire-point markers are byte-identical to their pre-fire values
    assert.deepStrictEqual([...m.firedRungs], before.fired, 'firedRungs is unchanged - nothing was ever banked');
    assert.strictEqual(m.currentRungIndex, before.rung, 'the ladder position is unchanged');
    assert.strictEqual(m.snipeFired, before.snipe,
      'THE ONE THAT MATTERS: the decisive snipe latch is restored, so the shot is not consumed by a request that never landed');
    assert.strictEqual(m._lastDefendAtExtend, before.defend, 'and the defend round latch with it');
    assert.strictEqual(m.bidTimes.length, before.times, 'the runaway-cap slot is refunded - a refused write placed nothing');
    assert.strictEqual(m.revisionsLeft, before.revs, 'the per-load budget is untouched - auth is not a cap refusal');
    assert.strictEqual(m.landedBids, 0, 'and nothing is recorded as landed');

    // The auth facts, and the classes it must NOT have borrowed
    assert.strictEqual(m.authBlockedLast, true, 'the load is marked as last-blocked-by-auth (what the close-time alarm reads)');
    assert.ok(m.noBid && m.noBid.reason === 'session_logged_out',
      "the refusal is recorded with the literal the desk copy keys on, never the mock adapter's 'auth'");
    assert.strictEqual(m.capExhausted, false, 'it does not borrow the terminal CAP class');
    assert.strictEqual(m.loadNotBiddable, false, 'nor the terminal LOAD class - auth is account-wide and transient');

    // ...and the shot genuinely survives: the very next poll re-fires the SAME rung and lands
    await eng._maybeBid(m, state(1_400, 2));
    assert.deepStrictEqual(box.placed, [9_700], 'the next poll re-fires the same decisive rung and it lands');
    assert.strictEqual(m.authBlockedLast, false, 'and the fire point clears the auth fact on any non-auth outcome');
    ok('a 401 restores the snipe latch, the ladder and the rate slot - the decisive shot survives it');
  }

  // ==============================================================================================
  // 2. A 403 IS THE SAME CLASS. Driven on the DEFEND path so the once-per-round latch is the marker
  //    under test. SuperProcure has never been observed distinguishing "revoked" from "forbidden" on
  //    this endpoint, and the response to both is identical: hold everything, change nothing.
  // ==============================================================================================
  {
    // Arrange - extensions remain, rank 2 inside the trigger window -> the soft defend owns this tick
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['403', 'ok']);

    // Act
    await eng._maybeBid(m, state(50_000, 2));

    // Assert
    assert.strictEqual(m._lastDefendAtExtend, null, 'a 403 restores the once-per-round defend latch - the round is not spent');
    assert.deepStrictEqual([...m.firedRungs], [0], 'the refused rung is not banked');
    assert.strictEqual(m.currentRungIndex, 0, 'and the ladder position is held');
    assert.strictEqual(m.bidTimes.length, 0, 'the rate slot is refunded');
    assert.ok(m.noBid && m.noBid.reason === 'session_logged_out', 'and 403 records the same refusal reason as 401');

    // the defend retries inside the SAME extension round once the session is back
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(box.placed, [9_700], 'the refused defend retries the same rung within the same round and lands');
    ok('a 403 is the same class as a 401: the defend round latch is restored and the rung retries');
  }

  // ==============================================================================================
  // 3. REGRESSION GUARD - an HTTP 400 is STILL a PRICE refusal.
  //    The AUTH arm is keyed on status 401/403 only, and every existing rejection test fires with
  //    400. If the predicate ever widens, the whole measured price/state taxonomy - the walk-down,
  //    the cap class, the not-biddable class - silently changes behaviour on live money. This is the
  //    check that fails first if that happens.
  // ==============================================================================================
  {
    // Arrange
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['reject-other', 'ok']);

    // Act
    await eng._maybeBid(m, state(50_000, 2));

    // Assert - the price/state class, unchanged in every particular
    assert.ok(!m.noBid, 'a 400 records NO refusal - the load may still be bid');
    assert.strictEqual(m.authBlockedLast, false, 'and is not marked as auth-blocked');
    assert.ok(m.firedRungs.has(1), 'the refused rung STAYS banked above the floor - the fired-rung history IS the walk-down');
    assert.strictEqual(m.currentRungIndex, 0, 'while the ladder position rolls back (the D3 repair), reopening the establish branch');
    assert.strictEqual(m.bidTimes.length, 1, 'and the rate slot is NOT refunded - the wire really was used');

    // the walk-down still happens: the next poll steps DOWN a rung rather than re-offering the same one
    await eng._maybeBid(m, state(50_000, 2));
    assert.deepStrictEqual(box.placed, [9_400], 'the next poll walks DOWN the ladder, exactly as it did before the AUTH class existed');
    ok('an HTTP 400 still classifies as a PRICE refusal and still walks the ladder down');
  }

  // ==============================================================================================
  // 4. THE LATCH NEEDS TWO CONSECUTIVE AUTH RESPONSES.
  //    One spurious 401 - a transient edge-node blip, a mid-rotation race - must never stop an
  //    entire account. Confirmation costs exactly one extra failed write and zero latency, which is
  //    why it is a counter and not a probe: re-issuing the write to be sure is a live-money
  //    double-bid, and re-issuing a read can burn ~12s of backoff inside a 2.5s write window.
  // ==============================================================================================
  {
    // Arrange
    const t = transport({ bid: plaintext(401, REVOKED_BODY) });
    const a = mkAdapter(t.impl);

    // Act + Assert - the FIRST 401 refuses the bid but does not latch the account
    const r1 = await bid(a);
    assert.deepStrictEqual(keysOf(r1), ENVELOPE_KEYS,
      'the auth rejection is the SAME envelope key set as every other rejection - a new key here is a wire-contract change');
    assert.strictEqual(r1.accepted, false, 'a 401 is not an accept');
    assert.strictEqual(r1.status, 401, 'the real HTTP status is surfaced unmodified - it is the classifier key');
    assert.strictEqual(r1.reason, 'session_logged_out', "reason is the reserved literal, never SuperProcure's own body text");
    assert.strictEqual(r1.text, REVOKED_BODY, 'while the raw body survives on `text` for forensics');
    assert.strictEqual(a.isAuthDead(), false, 'ONE 401 does not stop the account');
    assert.strictEqual(a.authDeadSince(), null, 'and stamps no instant');

    // the SECOND, with no proven success between them, latches it
    await bid(a);
    assert.strictEqual(a.isAuthDead(), true, 'the second consecutive auth response latches the account');
    const since = a.authDeadSince();
    assert.ok(Number.isFinite(since), 'and stamps the instant the session went dead');

    // a THIRD write touches no wire at all and never re-stamps the instant
    const r3 = await bid(a);
    assert.strictEqual(t.calls.bid.length, 2, 'a latched adapter issues NO further write - the wire is untouched');
    assert.strictEqual(r3.accepted, false, 'it still answers with a rejection rather than throwing');
    assert.strictEqual(a.authDeadSince(), since,
      'and the instant is STABLE: it is the dedupe key\'s uniqueness and the suppression clock, so re-stamping would re-arm the alert on every refusal');
    a._stopAuthProbe();
    ok('the account latches on the SECOND consecutive auth response, never the first, and the instant never re-stamps');
  }

  // ==============================================================================================
  // 5. A READ SUCCESS DOES NOT CLEAR THE STREAK. A PROVEN WRITE DOES.
  //    The tempting one-liner is to clear on any 2xx. It is a trap: discovery POSTs a listing every
  //    30s, so if SuperProcure ever revokes WRITE scope while leaving reads working - a real shape
  //    here, because this account is shared between the bot and human desk users - the sequence
  //    becomes 401 / 200 / 401 / 200 and the latch never engages at all. Strictly worse than the bug.
  // ==============================================================================================
  {
    // Arrange - reads answer 200 with an empty listing, writes answer 401
    const t = transport({ bid: plaintext(401, REVOKED_BODY) });
    const a = mkAdapter(t.impl);

    // Act - failed write, successful read, failed write
    await bid(a);
    await a.listAuctions();
    assert.strictEqual(t.calls.list.length, 1, 'the read really happened');
    await bid(a);

    // Assert
    assert.strictEqual(a.isAuthDead(), true,
      'the read success did NOT reset the streak, so the second failed write still latches the account');
    a._stopAuthProbe();

    // ...and the other half: a PROVEN WRITE does clear it
    let answer = 'auth';
    const t2 = transport({ bid: async () => (answer === 'auth'
      ? { status: 401, headers: { get: () => null }, text: async () => REVOKED_BODY }
      : { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) }) });
    const b = mkAdapter(t2.impl);
    await bid(b);                       // streak 1
    answer = 'ok';
    const okRes = await bid(b);         // proven write -> streak 0
    assert.strictEqual(okRes.accepted, true, 'the accepted write is a genuine accept');
    answer = 'auth';
    await bid(b);                       // streak 1 again, NOT 2
    assert.strictEqual(b.isAuthDead(), false,
      'a proven WRITE reset the streak, so the next single 401 is a first observation again, not a latch');
    ok('a read success does NOT clear the auth streak; a proven write does');
  }

  // ==============================================================================================
  // 6. A LATCHED ACCOUNT NEVER REACHES THE WIRE AGAIN.
  //    This is the gate that turns 360 attempts into ~1 per account. It has to live at the TOP of
  //    _maybeBid, not inside placeBid: by the time placeBid is reached the engine has already pushed
  //    a rate slot, incremented ownBidAttempts, set everBid and advanced both endgame latches - all
  //    before the await - so an adapter-only gate would still churn every one of those on every
  //    200ms hot tick for the whole outage.
  // ==============================================================================================
  {
    // Arrange - a SECOND load armed on an account whose session is already dead
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { id: 'SECOND' });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['ok']);
    eng.adapter.isAuthDead = () => true;

    // Act - several polls across the whole auction
    await eng._maybeBid(m, state(50_000, 2));
    await eng._maybeBid(m, state(9_000, 2));
    await eng._maybeBid(m, state(1_500, 2));

    // Assert
    assert.strictEqual(box.calls, 0, 'not one write reached the platform seam');
    assert.strictEqual(m.ownBidAttempts, 0, 'and the fire point was never entered - no attempt counted');
    assert.strictEqual(m.bidTimes.length, 0, 'no rate slot spent');
    assert.strictEqual(m.snipeFired, false, 'the decisive shot is still in hand for when the session returns');
    assert.strictEqual(m.authBlockedLast, true, 'the load is marked so the close-time alarm knows why');
    assert.ok(m.noBid && m.noBid.reason === 'session_logged_out', 'and the desk receipt will name the real cause');
    assert.strictEqual(alertsOfKind(eng, 'no_revisions_left').length, 0,
      'the gate sits ABOVE the budget gate, so an auth-dead load never fires a spurious no-revisions alert');

    // SELF-RESUME: the gate reads the LIVE predicate, so the next tick after it clears simply bids.
    // Reading a monitor flag instead would turn a transient outage into a permanent one for this load.
    eng.adapter.isAuthDead = () => false;
    await eng._maybeBid(m, state(50_000, 2));
    assert.strictEqual(box.calls, 1, 'the first tick after the latch clears bids - no timer, no re-arm, no retry loop');
    ok('a latched account never reaches placeBid, and resumes by itself on the first clear tick');
  }

  // ==============================================================================================
  // 7. ONE ALERT PER ACCOUNT PER OUTAGE - and a second account still gets its own.
  //    On 2026-08-04 five accounts were hit. A per-load alert would have been one message per armed
  //    load; a per-account-id dedupe key would have silenced accounts two through five. The key
  //    carries BOTH the account and the latch instant: the account keeps them independent, and the
  //    instant is what stops the notifier's PERMANENT sent-mark from making the NEXT revocation of
  //    the same account silent forever.
  // ==============================================================================================
  {
    // Arrange - one adapter per account, each with the alert hook wired as server.js wires it
    const raised = [];
    const t1 = transport({ bid: plaintext(401, REVOKED_BODY) });
    const a1 = mkAdapter(t1.impl, { accountId: 'primary', accountLabel: 'Primary', onAuthDead: (p) => raised.push(p) });
    const t2 = transport({ bid: plaintext(401, REVOKED_BODY) });
    const a2 = mkAdapter(t2.impl, { accountId: 'sameer-ambdaskar', accountLabel: 'Sameer Ambdaskar', onAuthDead: (p) => raised.push(p) });

    // Act - ten refusals on the first account (the incident shape), two on the second
    for (let i = 0; i < 10; i++) await bid(a1);
    await bid(a2); await bid(a2);

    // Assert - edge-triggered: one raise per latch transition, not one per refusal
    assert.strictEqual(raised.filter((p) => p.accountId === 'primary').length, 1,
      'ten refusals on one account raise EXACTLY ONE alert - the hook is edge-triggered on the latch');
    assert.strictEqual(raised.filter((p) => p.accountId === 'sameer-ambdaskar').length, 1,
      'and a DIFFERENT account still gets its own - five accounts revoked at once is five messages, not one');
    assert.strictEqual(raised[0].accountLabel, 'Primary',
      'the payload carries the HUMAN label, which is what the desk copy renders');

    // ...and the dedupe key the raiser builds keeps those two apart, and keeps a LATER outage on the
    // SAME account apart from this one
    const sent = [];
    const fakeNotifier = { alert: async (kind, payload, opts) => { sent.push({ kind, payload, opts }); } };
    for (const p of raised) raiseAuthDead(fakeNotifier, p);
    raiseAuthDead(fakeNotifier, { accountId: 'primary', accountLabel: 'Primary', since: raised[0].since + 86_400_000 });
    assert.deepStrictEqual(sent.map((s) => s.kind), ['error', 'error', 'error'],
      "it routes as the EXISTING 'error' kind - a new subscription kind would reach strictly fewer people");
    assert.ok(sent.every((s) => s.payload.authDead === true), 'and flags authDead so templateFor picks the account_auth_dead copy');
    assert.strictEqual(new Set(sent.map((s) => s.opts.dedupeKey)).size, 3,
      'three distinct keys: two accounts in one outage, plus a LATER outage on the same account - the permanent sent-mark can never silence the second one');
    assert.ok(sent.every((s) => s.payload.shipper === undefined && s.payload.auctionId === undefined),
      'the payload carries NO load or shipper scope keys - this is an account fact, and scoped customer groups must not match it');
    a1._stopAuthProbe(); a2._stopAuthProbe();
    ok('one account_auth_dead alert per account per outage, with a key that cannot swallow a later outage');
  }

  // ==============================================================================================
  // 8. A THROWN AUTH ERROR NEVER FABRICATES A LANDED BID.
  //    The engine's uncertain-outcome handler assumes a throw MAY have committed, and on the real
  //    adapter it always concludes that it did: `landed` starts true and the only thing that can
  //    falsify it needs a revisionsLeft that realAdapter.getAuctionState hardcodes to null. The
  //    fabricated bid is durable, it silences never_bid_before_close through everLanded, and it
  //    disables the last-resort floor. That is right for a transport failure and wrong for a 401,
  //    which is refused before processing and provably did not commit.
  // ==============================================================================================
  {
    // Arrange
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0, revisionsLeft: 5 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    // the read-back the uncertain-outcome handler would run: real-shaped, so revisionsLeft is null
    eng.adapter.getAuctionState = async () => ({ ok: true, myRank: 2, revisionsLeft: null, closesInMs: 1_400 });
    program(eng, ['throw-auth']);

    // Act
    await eng._maybeBid(m, state(1_500, 2));

    // Assert
    assert.strictEqual(m.landedBids, 0, 'THE BUG: a thrown auth error must NOT record a bid that never existed');
    assert.strictEqual(m.lastBidPrice, 10_000, 'nor overwrite the last price we actually placed');
    assert.ok(!m.firedRungs.has(1), 'nor bank the rung');
    assert.strictEqual(m.snipeFired, false, 'and the decisive shot is restored, not consumed');
    assert.strictEqual(alertsOfKind(eng, 'bid_submit_error').length, 0,
      'it leaves BEFORE the uncertain-outcome handler - that alert is the tell, and it is absent (a per-tick per-load flood under a misleading name)');
    assert.ok(m.noBid && m.noBid.reason === 'session_logged_out', 'and it takes the same recorded refusal as the returned form');
    ok('a thrown code:AUTH never fabricates a landed bid - it takes the auth path, not the uncertain-outcome path');
  }

  // ==============================================================================================
  // 9. THE ZERO-BID ALARM IS SUPPRESSED WHILE THE SESSION IS DEAD - AND RESUMES PAST THE BOUND.
  //    The second half is the most important assertion in this file. Suppression that depends on a
  //    boolean somebody else owns is only as safe as their clear path, and a stuck latch would
  //    re-create the 2026-07-13 silent zero-bid incident this alarm exists because of. Past
  //    authAlarmSuppressMaxMs the alarm fires again EVEN WITH THE LATCH STILL SET: a latch bug
  //    degrades to the old noise, never to silence.
  // ==============================================================================================
  {
    const closeOut = async ({ deadSinceMs }) => {
      const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
      const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
      eng.adapter.isAuthDead = () => true;
      eng.adapter.authDeadSince = () => deadSinceMs;
      eng.adapter.getAuctionState = async () => ({ ok: false });
      program(eng, ['ok']);
      await eng._maybeBid(m, state(50_000, 2));   // gated: never reaches the wire
      await eng._finalize(m, state(0, null));
      return { eng, m };
    };

    // Arrange + Act - the session died a minute ago
    const fresh = await closeOut({ deadSinceMs: Date.now() - 60_000 });

    // Assert - the ops alarm is held back...
    assert.strictEqual(alertsOfKind(fresh.eng, 'never_bid_before_close').length, 0,
      'the per-load ops alarm is suppressed while the account is known dead - 56 symptom messages become one cause message');
    // ...but the DESK IS NOT SILENCED. This is the crux of the argument for suppressing at all.
    const outcome = fresh.eng._events.filter((e) => e.type === 'auction_result');
    assert.strictEqual(outcome.length, 1, 'the per-load outcome receipt still fires');
    assert.strictEqual(outcome[0].landedBids, 0, 'still saying nothing of ours reached the board');
    assert.strictEqual(outcome[0].noBidReason, 'session_logged_out',
      'and now naming the real cause, so the receipt does not send the desk hunting a pricing mistake that does not exist');

    // ...and the TIME BOUND, the one trigger that is ours rather than someone else's
    const stale = await closeOut({ deadSinceMs: Date.now() - (7_200_000 + 60_000) });
    assert.strictEqual(alertsOfKind(stale.eng, 'never_bid_before_close').length, 1,
      'past authAlarmSuppressMaxMs the alarm RESUMES even with the latch still set - a stuck latch degrades to noise, never to silence');

    // and an adapter with no latch at all (mock/sim/GoComet, and every hand-rolled test stub) is
    // completely unaffected - the typeof guard is what keeps every other zero-bid test green
    const plain = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const pm = armFine(plain, [10_000, 9_700, 9_400, 9_100, 8_000]);
    plain.adapter.getAuctionState = async () => ({ ok: false });
    pm.authBlockedLast = true; // even with the monitor flag set, no adapter latch means no suppression
    await plain._finalize(pm, state(0, null));
    assert.strictEqual(alertsOfKind(plain, 'never_bid_before_close').length, 1,
      'an adapter without authDeadSince suppresses nothing - the feature detection fails toward the ALARM');
    ok('never_bid_before_close is suppressed while the session is dead, and resumes past the time bound');
  }

  // ==============================================================================================
  // 10. THE LATCH CANNOT SURVIVE A RECONNECT. It lives on the adapter INSTANCE and is never
  //     persisted, so the console's reconnect - which tears the stack down and constructs a brand-new
  //     adapter - clears it for free, and so does a process restart. That is deliberate: a persisted
  //     latch would only ever be a stuck-latch generator, and it is what makes "restart it" a real
  //     recovery rather than a hope.
  // ==============================================================================================
  {
    // Arrange - latch an adapter
    const t = transport({ bid: plaintext(401, REVOKED_BODY) });
    const dead = mkAdapter(t.impl);
    await bid(dead); await bid(dead);
    assert.strictEqual(dead.isAuthDead(), true, 'the account is latched');
    assert.ok(dead._authProbeTimer, 'and the liveness probe is running (it no longer clears the latch - login() is a '
      + 'read - but it keeps the streak reset and gives the logs a 90s heartbeat while the account is held)');

    // Act - what rebuildAccountStack does: discard this adapter, build a fresh one on a fresh token
    dead._stopAuthProbe();
    assert.strictEqual(dead._authProbeTimer, null,
      'teardown stops the probe - a discarded adapter must not keep hitting SuperProcure with a dead token forever');
    const fresh = mkAdapter(transport({}).impl);

    // Assert
    assert.strictEqual(fresh.isAuthDead(), false, 'a reconnect clears the latch for free - it is per-adapter-instance');
    assert.strictEqual(fresh.authDeadSince(), null, 'with no instant carried over');
    const r = await bid(fresh);
    assert.strictEqual(r.accepted, true, 'and the fresh adapter bids immediately');
    ok('the latch is per-adapter-instance and never persisted, so a reconnect or a restart clears it');
  }

  cleanup();
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
