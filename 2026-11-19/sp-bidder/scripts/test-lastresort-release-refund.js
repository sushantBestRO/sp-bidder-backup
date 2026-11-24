'use strict';
/**
 * THE NEVER-FORFEIT FLOOR RELEASE MUST NOT SPEND ITS BUDGET ON A WRITE THAT PLACED NOTHING.
 *
 * Regression target: T5 F3 (BH-STATE-3 + BH-INV-1), bug-hunt bidcmd-2026-09-16, dispositions row F3.
 *
 * _lastResortFloor owns a per-load cap, softCfg.lastResortFloorAttempts (default 3, "one shot plus
 * two retries - enough for a transient refusal to clear"). It spends that cap at DECISION time,
 * inside _decide, by bumping monitor._lastResortFloorAttempts - upstream of the fire point's
 * _captureFirePriors snapshot. So when the write comes back as an outcome the engine itself says
 * placed nothing - a returned 401, a thrown AUTH, a 429 - the auth undo and the 429 arm restore
 * everything else and keep the spent release. Three such ticks inside the last-chance window
 * exhaust the cap, and when the session or the throttle clears the reserved floor shot never goes
 * out: the load closes with nothing on the board and its revisions in hand.
 *
 * Checks 1-5 and 10 are the defect and fail until it is fixed. Check 10 is the production path the
 * disposition names first: the token_expiring GRACE BAND refuses the write while leaving the account
 * CLEAR, so no account gate holds and every hot tick in the 2.5 s window re-enters _decide.
 *
 * Check 5 is conservation over the outcomes the engine ITSELF classifies as nothing-placed - 401,
 * 403, grace-band 401, 429 - and only those. Whether a 5xx, a NETWORK throw the read-back disproves,
 * or a pre-wire COST_TYPE_UNMATCHED refusal should spend the release is an open policy question and
 * is deliberately not pinned here. Its oracle for "the platform ruled on it" is the fake adapter's
 * own wire log.
 *
 * Checks 1, 3, 4 and 5 read the private counter monitor._lastResortFloorAttempts. Controls 6 and 7
 * assert that same counter reads 1 after a spent release, so a fix that renames or moves it turns
 * the controls red instead of letting 1/3/4/5 pass vacuously on an always-zero read.
 *
 * WHAT MUST NOT MOVE (checks 6-9 and 11-13 pass today and must keep passing after the fix):
 *   - an accepted release spends exactly one attempt and lands the floor (6);
 *   - a release the platform refused ON ITS MERITS (non-cap 400) still spends its attempt (7), and
 *     after `bound` of those the release stops writing (8) - a fix that refunds every refusal
 *     un-bounds the stream the cap exists to stop;
 *   - a floor shot whose placeBid threw NETWORK, with a read-back that proves it did not land, is
 *     retried through _lastResortFloor and lands (9). This is the uncertain-outcome oracle defect
 *     (dispositions F1, BH-LOGIC-2), promoted here from its fix-flip control because its retry runs
 *     through the same release: a fix that moves where the attempt is spent must keep it green;
 *   - the 429 arm's own contract (11): a throttle is not an auth event, so authBlockedLast stays
 *     false, noBid is untouched and ownBidAttempts advances as it does today. A fix that routes the
 *     429 arm through _undoAuthRefusedFire wholesale breaks it;
 *   - a refund gives back only a release THIS write spent. Nothing-placed refusals of ordinary
 *     (non-release) writes never move the counter - not below zero from an untouched release (12),
 *     and not down from 1 after a ruled-on release, on the extension/defend path (13). In both the
 *     release still stops at exactly `bound` ruled-on floor writes. An unguarded or clamp-only
 *     refund (one not keyed on the decision being the release) breaks them.
 *
 * Offline and deterministic: fake adapter at the platform seam, real engine, real DurableScheduler
 * on a temp file, frozen injected clock, no network, no RNG.
 *
 *   node scripts/test-lastresort-release-refund.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 13;
let ran = 0;
const failures = [];

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `lastresort-refund-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const REAL_NOW = Date.now;
let CLOCK = 1_770_000_000_000;
Date.now = () => CLOCK;

process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${ran} checks, expected ${EXPECTED_CHECKS}`
      + ' - the file exited early, or checks were removed without updating the count');
    process.exitCode = 1;
  }
});

const LADDER = [60_000, 58_000, 56_000, 54_000];
const FLOOR = LADDER[LADDER.length - 1];
const SOFT = { enabled: true, mode: 'live', shippers: ['Havells'] };

const OUTCOMES = {
  accept: () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  // realAdapter._authRejection's envelope, key for key.
  auth401: () => ({ accepted: false, status: 401, myRank: null, revisionsLeft: null, bidVehicleCount: null,
    amountPMT: null, bidRate: null, bidQuantity: null, reason: 'session_logged_out', carrierSent: 2667,
    text: 'Token is invalid.', latencyMs: 12, raw: 'Token is invalid.' }),
  auth403: () => Object.assign(OUTCOMES.auth401(), { status: 403, text: 'Forbidden', raw: 'Forbidden' }),
  // The same returned 401; what makes it the grace band is the rig adapter reporting
  // authTokenGrace() true for this tick while the account stays CLEAR.
  grace401: () => OUTCOMES.auth401(),
  throwAuth: () => { const e = new Error('token_expired'); e.code = 'AUTH'; throw e; },
  rate429: () => ({ accepted: false, status: 429, myRank: null, revisionsLeft: null, reason: 'rate_limited',
    retryAfterMs: 500, latencyMs: 5, raw: null, carrierSent: 2667, text: null }),
  refuse400: () => ({ accepted: false, status: 400, myRank: null, revisionsLeft: null,
    reason: 'Bid amount should be less than previous bid', text: 'Bid amount should be less than previous bid',
    latencyMs: 5 }),
};
// Outcomes the platform actually ruled on. 401/403 are refused at SuperProcure's edge and a 429
// is a throttle - neither is a ruling on the offer.
const RULED_ON = new Set(['accept', 'refuse400']);

function rig({ softClose, config, grace = false } = {}) {
  const wire = [];
  const adapter = {
    next: 'accept',
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'unknown', biddingEnabled: true, platformLabel: 'Scripted',
      partialVehicleCountSupported: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => {
      wire.push({ price, kind: adapter.next });
      return OUTCOMES[adapter.next]();
    },
  };
  if (grace) {
    // test-auth-reversibility R8's grace-band shape: never dead, never write-held, so the account
    // gate lets every tick through to the fire point.
    Object.assign(adapter, { isAuthDead: () => false, authWriteHeld: () => false,
      authTokenGrace: () => adapter.next === 'grace401' });
  }
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, config || {}),
    softClose: Object.assign({}, SOFT, softClose || {}),
    onEvent: () => {},
  });
  const m = eng.arm({ id: `LR${seq}`, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
    equipment: '32ft', companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 },
  { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  // The state the release exists for: every rung offered and refused, nothing landed, the decisive
  // shot still owed, a live soft-close load with extensions outstanding.
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = 30;
  m.triggerWindowMs = 100_000;
  for (const i of [0, 1, 2, 3]) m.firedRungs.add(i);
  m.currentRungIndex = 3;
  m.landedBids = 0;
  m.snipeFired = false;
  m.ownBidAttempts = 4;
  m.everBid = true;
  return { eng, m, wire, adapter, bound: eng.softCfg.lastResortFloorAttempts };
}

// 1200 ms from close is inside floorWindowMs (2500), so _isLastChance holds; rank 2 means outranked.
// The clock moves 600 ms per tick so a retryAfterMs of 500 can never be what holds a retry.
async function tick(r, kind, closesInMs = 1_200, stepMs = 600, myRank = 2) {
  r.adapter.next = kind;
  const before = r.wire.length;
  await r.eng._maybeBid(r.m, { closesInMs, myRank, minDecrement: 100, standingL1Price: null,
    measuredRttMs: 50, revisionsLeft: null, revisionLimit: null, closeModel: 'soft' });
  CLOCK += stepMs;
  return r.wire.length - before;
}

const spent = (m) => m._lastResortFloorAttempts || 0;

async function check(n, name, fn) {
  try {
    await fn();
    console.log(`  ok  ${n}. ${name}`);
  } catch (e) {
    failures.push(n);
    console.error(`  FAIL ${n}. ${name}: ${e && e.message ? e.message : e}`);
  } finally {
    ran += 1;
  }
}

(async () => {
  await check(1, 'a returned 401 or 403 on the release gives the release attempt back', async () => {
    const kept = [];
    for (const kind of ['auth401', 'auth403']) {
      const r = rig();
      const before = spent(r.m);
      const wrote = await tick(r, kind);
      assert.strictEqual(wrote, 1, `FIXTURE (${kind}): the last-resort release did not reach the wire`);
      assert.strictEqual(r.wire[0].price, FLOOR, `FIXTURE (${kind}): the write was not the floor rung`);
      if (spent(r.m) !== before) kept.push(`${kind}: _lastResortFloorAttempts ${before} -> ${spent(r.m)}`);
    }
    assert.deepStrictEqual(kept, [],
      `the auth-refused release kept its spent attempt (${kept.join('; ')}):`
      + ' _undoAuthRefusedFire does not give back the budget _lastResortFloor spent at decision time');
  });

  await check(2, 'after `bound` 401-refused releases the recovered session still sends the floor', async () => {
    const r = rig();
    for (let i = 0; i < r.bound; i++) await tick(r, 'auth401');
    assert.strictEqual(r.wire.length, r.bound, `FIXTURE: expected ${r.bound} auth-refused writes, saw ${r.wire.length}`);
    const outage = r.wire.length;
    for (let i = 0; i < 3; i++) await tick(r, 'accept');
    const afterRecovery = r.wire.slice(outage).map((w) => w.price);
    const why = afterRecovery.length === 0
      ? `${r.bound} writes that placed nothing exhausted the release (_lastResortFloorAttempts=${spent(r.m)}`
        + ` of ${r.bound}) while ownBidAttempts=${r.m.ownBidAttempts}, revisionsLeft=${r.m.revisionsLeft} were restored`
      : `${afterRecovery.length} send(s) after recovery (_lastResortFloorAttempts=${spent(r.m)}, landedBids=${r.m.landedBids})`;
    assert.deepStrictEqual(afterRecovery, [FLOOR],
      `wire sends after the session returned: [${afterRecovery}], expected exactly [${FLOOR}] - ${why}`);
  });

  await check(3, 'a thrown AUTH on the release gives the release attempt back', async () => {
    const r = rig();
    const before = spent(r.m);
    const wrote = await tick(r, 'throwAuth');
    assert.strictEqual(wrote, 1, 'FIXTURE: the last-resort release did not reach the wire');
    assert.strictEqual(spent(r.m), before,
      `the thrown-AUTH release kept its spent attempt (_lastResortFloorAttempts ${before} -> ${spent(r.m)}):`
      + ' the catch-site _undoAuthRefusedFire does not give back the release budget');
  });

  await check(4, 'a 429 on the release gives the attempt back and the floor lands once the throttle clears', async () => {
    const r = rig();
    const before = spent(r.m);
    await tick(r, 'rate429');
    const afterFirst = spent(r.m);
    for (let i = 1; i < r.bound; i++) await tick(r, 'rate429');
    assert.strictEqual(r.wire.length, r.bound, `FIXTURE: expected ${r.bound} throttled writes, saw ${r.wire.length}`);
    const throttled = r.wire.length;
    for (let i = 0; i < 3; i++) await tick(r, 'accept');
    const afterClear = r.wire.slice(throttled).map((w) => w.price);
    assert.strictEqual(afterFirst, before,
      `the 429-throttled release kept its spent attempt (_lastResortFloorAttempts ${before} -> ${afterFirst}):`
      + ` the rate_limited arm does not refund it; wire sends after the throttle cleared: [${afterClear}]`);
    assert.deepStrictEqual(afterClear, [FLOOR],
      `wire sends after the throttle cleared: [${afterClear}], expected exactly [${FLOOR}]`);
  });

  await check(5, 'over nothing-placed outcomes (401/403/grace/429), release attempts spent never exceed offers ruled on', async () => {
    const violations = [];
    for (const kind of ['auth401', 'auth403', 'grace401', 'rate429']) {
      const pinned = [kind, kind, kind, 'accept'];
      const r = rig({ grace: kind === 'grace401' });
      for (const k of pinned) await tick(r, k);
      assert.deepStrictEqual(r.wire.slice(0, 3).map((w) => w.kind), [kind, kind, kind],
        `FIXTURE (${kind}): the three nothing-placed releases did not all reach the wire`);
      const ruledOn = r.wire.filter((w) => RULED_ON.has(w.kind)).length;
      if (spent(r.m) > ruledOn) {
        violations.push(`${JSON.stringify(pinned)}: spent ${spent(r.m)} of ${r.bound} while the platform ruled on`
          + ` ${ruledOn} (wire: ${JSON.stringify(r.wire.map((w) => w.kind))})`);
      }
    }
    assert.deepStrictEqual(violations, [], `release budget spent on writes that placed nothing - ${violations.join('; ')}`);
  });

  await check(6, 'CONTROL: an accepted release spends exactly one attempt and lands the floor', async () => {
    const r = rig();
    await tick(r, 'accept');
    assert.deepStrictEqual(r.wire.map((w) => w.price), [FLOOR]);
    assert.strictEqual(spent(r.m), 1);
    assert.strictEqual(r.m.landedBids, 1);
  });

  await check(7, 'CONTROL: a release the platform refused on its merits still spends its attempt', async () => {
    const r = rig();
    const wrote = await tick(r, 'refuse400');
    assert.strictEqual(wrote, 1, 'FIXTURE: the last-resort release did not reach the wire');
    assert.strictEqual(spent(r.m), 1, 'a ruled-on refusal of the release must consume one attempt');
  });

  await check(8, 'CONTROL: after `bound` ruled-on refusals the release stops writing', async () => {
    // refusedPriceAttempts lifted above the release bound so the fire point's refused-price hold
    // (default 3, keyed on the same floor price) cannot be what stops the fourth write.
    const r = rig({ config: { refusedPriceAttempts: 10 } });
    for (let i = 0; i < r.bound; i++) await tick(r, 'refuse400');
    assert.strictEqual(r.wire.length, r.bound, `FIXTURE: expected ${r.bound} refused writes, saw ${r.wire.length}`);
    const wrote = await tick(r, 'accept');
    assert.strictEqual(wrote, 0, `the release wrote again after ${r.bound} ruled-on refusals - it no longer bounds itself`);
  });

  await check(9, 'POSITIVE PIN: a NETWORK-thrown floor shot, read back as not landed, is retried and lands', async () => {
    const ladder = [41_420, 40_736, 39_600, 38_684, 38_000];
    const r = rig({ softClose: { reserve: 1 } });
    r.m.ladder = ladder.slice();
    r.m.floor = ladder[ladder.length - 1];
    r.m.ownBidAttempts = 0;
    r.m.everBid = false;
    const attempted = [];
    const accepted = [];
    r.eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (attempted.length === 1) { const e = new Error('bid_network_error'); e.code = 'NETWORK'; throw e; }
      accepted.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    // revisionsLeft unchanged at 30 is the platform's positive proof the thrown write never landed.
    r.eng.adapter.getAuctionState = async () => ({ ok: true, myRank: 4, revisionsLeft: 30 });
    for (let rem = 30_000, ticks = 0; rem >= 0 && ticks < 20_000; ticks++) {
      await r.eng._maybeBid(r.m, { closesInMs: rem, myRank: 4, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
      const step = Math.max(1, r.eng._cadence(rem, r.m));
      rem -= step;
      CLOCK += step;
    }
    assert.deepStrictEqual(accepted, [38_000],
      `floor shot after a disproved NETWORK throw: attempted [${attempted}], accepted [${accepted}]`);
  });

  await check(10, 'grace-band 401s through the floor window leave the release unspent and the floor goes out once the band clears', async () => {
    // Production write throttle (src/config.js defaults) on the engine's 200 ms hot tick, so the
    // grace-band undo's deliberately-spent lastFireAt/bidTimes are exercised as they are live.
    const r = rig({ grace: true, config: { minInterFireMs: 150, maxBidsPerMin: 20 } });
    let attemptsAtClear = null;
    let graceWrites = 0;
    let bidTimesAtClear = null;
    for (let rem = 6_000; rem >= 0; rem -= 200) {
      const inBand = rem > 1_000;
      if (!inBand && attemptsAtClear == null) {
        attemptsAtClear = spent(r.m);
        graceWrites = r.wire.length;
        bidTimesAtClear = r.m.bidTimes.length;
      }
      await tick(r, inBand ? 'grace401' : 'accept', rem, 200);
    }
    assert.ok(graceWrites >= 1, 'FIXTURE: no grace-refused release reached the wire');
    // Only the grace-band undo leaves the runaway-cap slots spent; a full undo would read 0 here.
    assert.strictEqual(bidTimesAtClear, graceWrites, 'FIXTURE: the refusals did not take the grace-band undo branch');
    assert.ok(r.wire.slice(0, graceWrites).every((w) => w.kind === 'grace401' && w.price === FLOOR),
      `FIXTURE: the in-band writes were not all grace-refused floor releases: ${JSON.stringify(r.wire)}`);
    const afterClear = r.wire.slice(graceWrites).map((w) => w.price);
    assert.strictEqual(attemptsAtClear, 0,
      `${graceWrites} grace-band-refused releases left _lastResortFloorAttempts at ${attemptsAtClear} of ${r.bound}`
      + ` when the band cleared (account CLEAR throughout, so every hot tick re-entered _decide);`
      + ` wire sends after the band cleared: [${afterClear}]`);
    assert.deepStrictEqual(afterClear, [FLOOR],
      `wire sends after the grace band cleared: [${afterClear}], expected exactly [${FLOOR}]`);
    assert.ok(graceWrites <= r.eng.cfg.maxBidsPerMin,
      `${graceWrites} grace-refused writes in the band exceed the runaway cap maxBidsPerMin=${r.eng.cfg.maxBidsPerMin}`);
  });

  await check(11, 'CONTROL: a 429 on the release is a throttle, not an auth event, and still counts the attempt', async () => {
    const r = rig();
    const noBidBefore = r.m.noBid === undefined ? undefined : JSON.parse(JSON.stringify(r.m.noBid));
    const ownBefore = r.m.ownBidAttempts;
    const wrote = await tick(r, 'rate429');
    assert.strictEqual(wrote, 1, 'FIXTURE: the last-resort release did not reach the wire');
    assert.strictEqual(r.m.authBlockedLast, false, 'a 429 marked the load auth-blocked');
    assert.deepStrictEqual(r.m.noBid, noBidBefore, 'a 429 rewrote the load\'s recorded refusal');
    assert.strictEqual(r.m.ownBidAttempts, ownBefore + 1,
      'the 429 site must not give ownBidAttempts back - the wire was used (bidEngine.js fire-point subset comment)');
  });

  await check(12, 'CONTROL: nothing-placed refusals of NON-release writes never refund the release below zero', async () => {
    // refusedPriceAttempts lifted above the release bound for the same reason as check 8.
    const r = rig({ grace: true, config: { refusedPriceAttempts: 10 } });
    r.m.firedRungs.clear();
    for (const i of [0, 1]) r.m.firedRungs.add(i);
    r.m.currentRungIndex = 1;
    const seen = [];
    for (const [kind, from] of [['grace401', 20_000], ['rate429', 15_000]]) {
      for (let rem = from; rem > from - 3_000; rem -= 600) {
        await tick(r, kind, rem, 600);
        seen.push(r.m._lastResortFloorAttempts);
      }
    }
    const early = r.wire.slice();
    for (const kind of ['grace401', 'rate429']) {
      assert.ok(early.some((w) => w.kind === kind), `FIXTURE: no ${kind} non-release write reached the wire: ${JSON.stringify(early)}`);
    }
    assert.ok(early.every((w) => w.price !== FLOOR), `FIXTURE: an out-of-window write was the floor: ${JSON.stringify(early)}`);
    const problems = [];
    if (!seen.every((v) => v === undefined || v === 0)) {
      problems.push(`nothing-placed refusals of non-release writes moved the release counter: ${JSON.stringify(seen)}`);
    }

    for (const i of [0, 1, 2, 3]) r.m.firedRungs.add(i);
    r.m.currentRungIndex = 3;
    for (let i = 0; i < r.bound; i++) await tick(r, 'refuse400');
    const refused = r.wire.slice(early.length);
    assert.deepStrictEqual(refused.map((w) => w.price), Array(r.bound).fill(FLOOR),
      `FIXTURE: expected ${r.bound} refused floor releases, saw ${JSON.stringify(refused)}`);
    if (await tick(r, 'accept') !== 0) {
      problems.push(`the release wrote a ${r.bound + 1}th time after ${r.bound} ruled-on refusals`
        + ` (_lastResortFloorAttempts=${spent(r.m)}) - earlier non-release refusals were refunded into the release budget`);
    }
    assert.deepStrictEqual(problems, [], problems.join('; '));
  });

  await check(13, 'CONTROL: after a ruled-on release, nothing-placed refusals of a defend write leave the release spent', async () => {
    const r = rig({ grace: true, config: { refusedPriceAttempts: 10 } });
    r.m.firedRungs.clear();
    for (const i of [0, 1]) r.m.firedRungs.add(i);
    r.m.currentRungIndex = 1;
    // This round's defend already went, so in the window the hold routes to the release.
    r.m._lastDefendAtExtend = r.m.extendsObserved;
    // Named re-pin: T4, owner ruling Q5 (ruling 54). Outranked at a pre-cap buzzer, T4 sends the next
    // middle price and keeps the floor, so the release is reached with the rank unread.
    await tick(r, 'refuse400', 1_200, 600, null);
    assert.deepStrictEqual(r.wire.map((w) => [w.kind, w.price]), [['refuse400', FLOOR]],
      'FIXTURE: the first in-window write was not a ruled-on floor release (named re-pin: T4, owner ruling Q5 / ruling 54 - the first tick reads no rank)');
    assert.strictEqual(spent(r.m), 1, 'FIXTURE: the ruled-on release did not spend one attempt');

    r.m.extendsObserved += 1;
    const seen = [];
    let rem = 20_000;
    for (const kind of ['grace401', 'rate429', 'auth401']) {
      const wrote = await tick(r, kind, rem);
      rem -= 600;
      const w = r.wire[r.wire.length - 1];
      assert.ok(wrote === 1 && w.kind === kind && w.price !== FLOOR,
        `FIXTURE: the ${kind} defend write did not reach the wire as a non-release rung: ${JSON.stringify(r.wire)}`);
      seen.push(`${kind}:${r.m._lastResortFloorAttempts}`);
    }
    const problems = [];
    if (!seen.every((s) => s.endsWith(':1'))) {
      problems.push(`nothing-placed refusals of non-release defend writes moved the spent release: ${seen.join(', ')} (expected 1 each)`);
    }

    for (const i of [0, 1, 2, 3]) r.m.firedRungs.add(i);
    r.m.currentRungIndex = 3;
    for (let i = 0; i < r.bound + 2; i++) await tick(r, 'refuse400');
    const ruledFloor = r.wire.filter((w) => w.kind === 'refuse400' && w.price === FLOOR).length;
    if (ruledFloor !== r.bound) {
      problems.push(`${ruledFloor} ruled-on floor writes against bound ${r.bound} (_lastResortFloorAttempts=${spent(r.m)})`);
    }
    if (await tick(r, 'accept') !== 0) problems.push('the release wrote again after its bound');
    assert.deepStrictEqual(problems, [], problems.join('; '));
  });

  if (failures.length) {
    console.error(`\n${failures.length} of ${EXPECTED_CHECKS} checks FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nUNEXPECTED ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
