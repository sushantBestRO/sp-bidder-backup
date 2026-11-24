'use strict';
/**
 * A GOCOMET 429 ON THE SUBMIT PUT MUST REACH THE ENGINE AS A THROTTLE, NOT AS A PRICE REFUSAL.
 *
 * Regression target: T5 F2 (BH-CONTRACT-1), docs/bug-hunts/2026-09-16_bidcmd-T5-dispositions.md.
 *
 * gocometAdapter._request flags `rateLimited: status === 429 || status === 503` and opens a cooldown
 * on it, but placeBid's PUT leg only tests `res.status === 0` and then builds
 * `reason = projectSubmitError(res.json) || 'http_' + res.status`. GoComet's 429 has an empty body
 * (2,629 of them in BRL's own GoComet error logs), so the engine receives `reason: 'http_429'`. That
 * matches no classifier, so _maybeBid takes the generic price/state refusal branch: the rung is
 * banked, the ladder walks down (41,420 -> 40,736) on a write the portal never ruled on, a
 * refused-price run opens and is marked unrecognised, the desk gets a bid_rejected, and no
 * bid_rate_limited alert is raised. realAdapter already says the same thing in the word the engine
 * branches on: `reason: 'rate_limited'`.
 *
 * Check 7 is the MERGE GATE for the PUT-429 ENGINE ARM. It needs T5 F3 (that arm refunding the
 * never-forfeit floor release) as well as F2, and stays red with an F2 fix alone.
 *
 * KNOWN LIMIT of check 7. It replays the PUT-429 envelope on consecutive ticks, which one real
 * GoComet adapter cannot produce: the first PUT 429 opens the 60s global cooldown, so the next
 * placeBid throws RATE_LIMITED from the quote GET before any PUT. Once sibling branch
 * fix/gocomet-prewire-throw-books-nothing lands, that throw takes its new `placed:false` arm, and this file does not cover that leg. Check 7 does
 * NOT prove production GoComet keeps the release through a throttled window.
 *
 * Status decides the throttle, not the body: a 429 carrying a JSON message is still rate_limited
 * (check 8), while an empty-bodied 400 or 500 keeps http_<status> (checks 9, 10).
 *
 * WHAT MUST NOT MOVE:
 *   - the engine's own throttle arm, fed realAdapter's envelope (check 4)
 *   - a GoComet non-2xx that is not 429/503 keeps its projected reason, or http_<status> when the
 *     body is empty (checks 5, 9, 10); not every non-2xx is a throttle
 *   - a PUT that never landed (status 0) still throws NETWORK (check 6); the write is never retried
 *
 * Offline and deterministic: real GoCometAdapter over a stubbed fetchImpl, real BidEngine over a
 * fake adapter seam fed the envelope the real adapter built, temp-file scheduler, virtual clock.
 *
 *   node scripts/test-gocomet-submit-429-rate-limited.js
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 10;
const CLOCK_EPOCH = 1_770_000_000_000;
const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];

let ran = 0;
const failures = [];
const TMP = [];
process.on('exit', () => { for (const f of TMP) { try { fs.unlinkSync(f); } catch (_) {} } });

async function check(name, fn) {
  ran++;
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.error('  FAIL ' + name + '\n       ' + String((e && e.message) || e).split('\n').join('\n       '));
  }
}

// ---- adapter half: the REAL GoCometAdapter over a stubbed transport --------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({
  exp: Math.floor(CLOCK_EPOCH / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;

function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

const QUOTE = { id: 'Q9LG', charges_list: { '11_freight_charges': { freight_charges_custom_charge_x: { units: 1, unit_name: 'TRUCK', price: 1 } } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } };

// A fresh adapter per call: a 429 opens a 60s GLOBAL cooldown, and the next call on the same
// instance would be answered by a synthetic 429 with no request issued.
async function submitWith(putResponse) {
  const puts = [];
  const a = new GoCometAdapter({
    token: validToken(), bidEnabled: true, now: () => CLOCK_EPOCH, sleep: async () => {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [QUOTE]);
      if (init.method === 'PUT') { puts.push(url); return putResponse(); }
      throw new Error('unexpected request ' + init.method + ' ' + url);
    },
  });
  await a.login();
  const out = await a.placeBid('Q9LG', 50_000, { floor: 1000 });
  return { out, puts };
}

const put429Empty = () => resp(429, '');

// realAdapter's rate_limited early return, read off realAdapter.js (the throttled-WRITE branch).
const SP_429 = { accepted: false, status: 429, myRank: null, revisionsLeft: null,
  reason: 'rate_limited', retryAfterMs: null, latencyMs: 12, raw: null, carrierSent: 4021, text: null };

// ---- engine half: the REAL BidEngine behind a fake adapter seam ------------------------------

function mkEngine() {
  const f = path.join(os.tmpdir(), `test-gc-429-${process.pid}-${TMP.length}.json`);
  TMP.push(f);
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function armFine(eng) {
  const meta = { id: '2606158TAA', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = LADDER[LADDER.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = 30;
  m.triggerWindowMs = 100_000;
  return m;
}

const state = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });

async function withClock(fn) {
  const REAL_NOW = Date.now;
  const clock = { t: CLOCK_EPOCH };
  Date.now = () => clock.t;
  try { return await fn(clock); } finally { Date.now = REAL_NOW; }
}

// One throttled write, then healthy accepts, down the engine's own cadence.
async function routeOneThrottledWrite(envelope) {
  return withClock(async (clock) => {
    const eng = mkEngine();
    const m = armFine(eng);
    assert.ok('_refusedPriceCount' in m && '_refusedPriceUnrecognised' in m,
      'fixture: the monitor no longer carries _refusedPriceCount/_refusedPriceUnrecognised - update this file, the reads below would match vacuously');
    const wire = [];
    let atNextWrite = null;
    eng.adapter.placeBid = async (_id, price) => {
      wire.push(price);
      if (wire.length === 1) return envelope;
      if (atNextWrite == null) {
        atNextWrite = { firedRungs: [...m.firedRungs].sort((a, b) => a - b),
          refusedPriceCount: m._refusedPriceCount,
          refusedPriceUnrecognised: m._refusedPriceUnrecognised };
      }
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    let r = 126_739;
    for (let ticks = 0; r >= 0 && ticks < 20_000; ticks++) {
      await eng._maybeBid(m, state(r, 4));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      clock.t += step;
    }
    return { wire, atNextWrite,
      alertKinds: eng._events.filter((e) => e.type === 'alert').map((e) => e.kind),
      bidRejected: eng._events.filter((e) => e.type === 'bid_rejected').length };
  });
}

function assertThrottleConsequence(r, who) {
  assert.ok(r.wire.length >= 2 && r.atNextWrite, `${who}: the drive never reached a second write (wire ${JSON.stringify(r.wire)}) - harness, not the defect`);
  assert.deepStrictEqual(
    { firstTwoWirePrices: r.wire.slice(0, 2), firedRungsAtNextWrite: r.atNextWrite.firedRungs,
      refusedPriceCount: r.atNextWrite.refusedPriceCount, refusedPriceUnrecognised: r.atNextWrite.refusedPriceUnrecognised,
      bidRejectedEvents: r.bidRejected, bidRateLimitedAlert: r.alertKinds.includes('bid_rate_limited') },
    { firstTwoWirePrices: [LADDER[0], LADDER[0]], firedRungsAtNextWrite: [],
      refusedPriceCount: 0, refusedPriceUnrecognised: false,
      bidRejectedEvents: 0, bidRateLimitedAlert: true },
    `${who}: a throttled write was not routed to the engine's rate_limited arm - the rung was banked and the ladder walked `
    + 'down on a write the portal never ruled on, and the desk got bid_rejected instead of bid_rate_limited');
}

(async () => {
  await check('1 gocomet_put_429_is_rate_limited', async () => {
    const { out, puts } = await submitWith(put429Empty);
    assert.strictEqual(puts.length, 1, 'the PUT went out exactly once (never retried)');
    assert.deepStrictEqual({ accepted: out.accepted, status: out.status, reason: out.reason },
      { accepted: false, status: 429, reason: 'rate_limited' },
      `GoComet answered the submit PUT with HTTP 429 (empty body) and placeBid reported reason ${JSON.stringify(out.reason)} `
      + 'instead of the rate_limited sentinel the engine branches on');
  });

  await check('2 gocomet_put_503_is_rate_limited', async () => {
    const { out } = await submitWith(() => resp(503, ''));
    assert.deepStrictEqual({ accepted: out.accepted, status: out.status, reason: out.reason },
      { accepted: false, status: 503, reason: 'rate_limited' },
      `_request flags a 503 rateLimited, but placeBid reported reason ${JSON.stringify(out.reason)} instead of rate_limited`);
  });

  await check('3 engine_routes_gocomet_429_to_throttle_arm', async () => {
    const { out } = await submitWith(put429Empty);
    assertThrottleConsequence(await routeOneThrottledWrite(out), `GoComet envelope (reason ${JSON.stringify(out.reason)})`);
  });

  await check('4 CONTROL sp_429_routes_to_throttle_arm', async () => {
    assertThrottleConsequence(await routeOneThrottledWrite(SP_429), 'SuperProcure envelope');
  });

  await check('5 CONTROL gocomet_put_4xx_keeps_projected_reason', async () => {
    const { out } = await submitWith(() => resp(422, { message: 'Quote amount is invalid' }));
    assert.strictEqual(out.accepted, false);
    assert.strictEqual(out.status, 422);
    assert.strictEqual(out.reason, 'Quote amount is invalid',
      `a 422 with a readable body lost its projected reason (got ${JSON.stringify(out.reason)}) - not every non-2xx is a throttle`);
  });

  await check('6 CONTROL gocomet_put_status0_still_network', async () => {
    await assert.rejects(submitWith(() => { throw new Error('ECONNRESET'); }),
      (e) => e && e.code === 'NETWORK',
      'a PUT that never landed must still throw NETWORK - it is not a throttle and is never retried');
  });

  // MERGE GATE: needs T5 F3 AND F2. Red on base; must STAY red with an F2 fix alone, because the
  // 429 arm does not give back the never-forfeit release that _lastResortFloor spends at decision time.
  // Pins the PUT-429 engine arm only - see KNOWN LIMIT in the header for the pre-wire leg.
  await check('7 MERGE-GATE gocomet_put_429_arm_keeps_release', async () => {
    const { out: envelope } = await submitWith(put429Empty);
    await withClock(async (clock) => {
      const eng = mkEngine();
      const m = armFine(eng);
      const last = LADDER.length - 1;
      for (let i = 0; i < last; i++) m.firedRungs.add(i);
      m.currentRungIndex = last - 1;
      const bound = eng.softCfg.lastResortFloorAttempts;
      const wire = [];
      let throttled = 0;
      eng.adapter.placeBid = async (_id, price) => {
        wire.push(price);
        if (throttled < bound) { throttled++; return envelope; }
        return { accepted: true, myRank: 3, revisionsLeft: null, latencyMs: 20 };
      };
      assert.ok(eng._isLastChance(1200), 'fixture: 1200ms must be inside the last-chance window');
      for (let i = 0; i < bound; i++) {
        await eng._maybeBid(m, state(1200, 5));
        clock.t += 200;
      }
      assert.deepStrictEqual(wire, Array(bound).fill(LADDER[last]),
        `fixture: the release did not offer the floor on each of the ${bound} throttled ticks (wire ${JSON.stringify(wire)})`);
      const spentByThrottle = m._lastResortFloorAttempts || 0;
      await eng._maybeBid(m, state(1000, 5));
      clock.t += 200;
      await eng._maybeBid(m, state(800, 5));
      const afterRecovery = wire.slice(bound);
      assert.deepStrictEqual({ releasesSpentByThrottledTicks: spentByThrottle, floorWritesAfterRecovery: afterRecovery },
        { releasesSpentByThrottledTicks: 0, floorWritesAfterRecovery: [LADDER[last]] },
        `${bound} GoComet 429s (reason ${JSON.stringify(envelope.reason)}) spent ${spentByThrottle}/${bound} never-forfeit `
        + 'releases on writes the portal never ruled on, so the floor did not go out once after the throttle cleared');
    });
  });

  await check('8 gocomet_put_429_with_body_is_rate_limited', async () => {
    const { out } = await submitWith(() => resp(429, { message: 'Too many requests' }));
    assert.deepStrictEqual({ accepted: out.accepted, status: out.status, reason: out.reason },
      { accepted: false, status: 429, reason: 'rate_limited' },
      `a 429 carrying a JSON message reported reason ${JSON.stringify(out.reason)} - the status must decide the throttle, `
      + 'ahead of the projected body');
  });

  await check('9 CONTROL gocomet_put_400_empty_body_keeps_http_400', async () => {
    const { out } = await submitWith(() => resp(400, ''));
    assert.deepStrictEqual({ accepted: out.accepted, status: out.status, reason: out.reason },
      { accepted: false, status: 400, reason: 'http_400' },
      `an empty-bodied 400 reported reason ${JSON.stringify(out.reason)} - only 429/503 are a throttle`);
  });

  await check('10 CONTROL gocomet_put_500_empty_body_keeps_http_500', async () => {
    const { out } = await submitWith(() => resp(500, ''));
    assert.deepStrictEqual({ accepted: out.accepted, status: out.status, reason: out.reason },
      { accepted: false, status: 500, reason: 'http_500' },
      `an empty-bodied 500 reported reason ${JSON.stringify(out.reason)} - only 429/503 are a throttle`);
  });

  if (ran !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  if (failures.length) {
    console.error(`\n${failures.length}/${EXPECTED_CHECKS} checks FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS ${EXPECTED_CHECKS}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
