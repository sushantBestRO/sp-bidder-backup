'use strict';
/**
 * THE LOWEST PRICE THE ENGINE SENDS IS THE BAND'S LOWEST PRICE - never the minimum-margin guard.
 *
 * Regression target: branch fix/margin-floor-is-a-guard. A Borosil load on SuperProcure, band
 * [15.3, 10.8, 4.5] with a 3% minimum margin, 3-bid cap, hard close.
 *
 * The desk's band margins ARE the bids. The minimum margin is a guard - no price may go below
 * cost x (1 + min/100) - and is never a bid price of its own. buildBandLadder appends the guard as an
 * extra last rung whenever it sits below the band's lowest margin, so at cost 100,000 the engine arms
 * [115300, 110800, 104500, 103000]. Two things follow:
 *   - the never-forfeit release and the final snipe both fire ladder[last], which is the guard;
 *   - with 3 bids and 4 prices, the step-down spends the cap walking to 104,500 mid-auction and the
 *     bids run out ~23s before the close. The decisive last shot never goes out.
 *
 * WHAT MUST NOT MOVE:
 *   - a band whose minimum equals its lowest margin (Syngenta [12.6, 7.2, 6.3] min 6.3) releases and
 *     snipes its lowest price exactly as today (check 3, green now and after the fix);
 *   - no price below the guard passes the fire-point belt or reaches the adapter (check 4).
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, no network, rand pinned to 0, and the
 * countdown driven through the real _tick on a virtual clock stepped by the delay the engine itself
 * schedules. No real sleeps.
 *
 *   node scripts/test-lowest-price-shot-is-band-bottom.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { assertAboveFloor } = require('../src/engine/pricing');

const COST = 100_000;
const BOROSIL = { marginsPct: [15.3, 10.8, 4.5], minMarginPct: 3 };
const BOROSIL_BAND_PRICES = [115_300, 110_800, 104_500];
const BOROSIL_BOTTOM = 104_500;
const BOROSIL_GUARD = 103_000;
const SYNGENTA = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
const SYNGENTA_BAND_PRICES = [112_600, 107_200, 106_300];
const SYNGENTA_BOTTOM = 106_300;
const FLOOR_WINDOW_MS = 2_500;
const BID_CAP = 3;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `band-bottom-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

function mkEngine(adapter) {
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, cadenceJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

const idleAdapter = () => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => { throw new Error('placeBid must not be reached here'); },
});

function armOn(eng, companyName, band, closesAt) {
  const meta = { id: String(900_000 + seq++), lane: { origin: 'Jaipur', destination: 'Pune' }, units: 1,
    companyName, branchName: 'MAIN', closesAt,
    rules: { revisionLimit: BID_CAP, minDecrement: 100, pricingMode: 'flat' } };
  const m = eng.arm(meta, { cost: COST, ...band });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

// Drives one hard-close SuperProcure load from 70s out to the close through the real _tick. Rank is
// null until our first bid lands, then 2 (losing) for the rest of the auction.
async function runToClose(companyName, band) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    const closeAt = vnow + 70_000;
    const sent = [];
    let rank = null;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: closeAt - vnow > 0 ? 'live' : 'closed', myRank: rank,
        totalBidders: 5, standingL1Price: null, closesInMs: closeAt - vnow, revisionLimit: BID_CAP,
        closeModel: 'hard', minDecrement: 100, measuredRttMs: 80 }),
      placeBid: async (id, price) => {
        sent.push({ price, remainingMs: closeAt - vnow });
        rank = 2;
        return { accepted: true, ok: true, myRank: 2, revisionsLeft: null };
      },
    };
    const eng = mkEngine(adapter);
    let nextDelay = null;
    eng._schedule = (mon, d) => { nextDelay = d; };
    const m = armOn(eng, companyName, band, closeAt);
    for (let ticks = 0; !m.finalized && ticks < 5_000; ticks++) {
      nextDelay = null;
      await eng._tick(m);
      if (m.finalized) break;
      assert.ok(nextDelay != null, 'the engine scheduled no next tick');
      vnow += Math.max(1, nextDelay);
    }
    assert.ok(m.finalized, 'the load never reached its close');
    return sent;
  } finally { Date.now = REAL_NOW; }
}

function releaseOn(companyName, band) {
  const eng = mkEngine(idleAdapter());
  const m = armOn(eng, companyName, band, Date.now() + 900_000);
  m.closeModel = 'hard';
  const remaining = 2_000;
  return eng._lastResortFloor(m, { closesInMs: remaining, myRank: 2, minDecrement: 100, standingL1Price: null },
    remaining, m.ladder.length - 1);
}

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 4;
process.on('exit', (code) => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nlowest price shot is band bottom: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - the minimum-margin guard is being priced as a bid`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('lowest price shot is band bottom');

  await check('1 last-resort-is-band-bottom: the never-forfeit release offers the band bottom, not the guard', () => {
    const d = releaseOn('Borosil', BOROSIL);
    assert.ok(d, 'the release must fire on the last tick when outranked with nothing standing');
    assert.notStrictEqual(d.price, BOROSIL_GUARD,
      `the release offered ${d.price}, the minimum-margin guard, as a bid - the guard must never be a bid price`);
    assert.strictEqual(d.price, BOROSIL_BOTTOM, `the release must offer the band's lowest price ${BOROSIL_BOTTOM}`);
  });

  await check('2 decisive-shot-is-band-bottom: on a 3-bid cap the band bottom goes out as the final shot', async () => {
    const sent = await runToClose('Borosil', BOROSIL);
    const prices = sent.map((s) => s.price);
    assert.ok(sent.length > 0, 'no bid was sent at all');
    assert.ok(sent.length <= BID_CAP, `sent ${sent.length} bids against a ${BID_CAP}-bid cap: ${prices}`);
    assert.ok(!prices.includes(BOROSIL_GUARD), `the guard ${BOROSIL_GUARD} was sent as a bid: ${prices}`);
    for (const p of prices) assert.ok(BOROSIL_BAND_PRICES.includes(p), `sent ${p}, which is not a band price: ${prices}`);
    const lastShot = sent[sent.length - 1];
    assert.strictEqual(lastShot.price, BOROSIL_BOTTOM, `the last shot must be the band bottom ${BOROSIL_BOTTOM}: ${prices}`);
    assert.ok(lastShot.remainingMs <= FLOOR_WINDOW_MS,
      `the band bottom ${BOROSIL_BOTTOM} went out at ${lastShot.remainingMs}ms remaining, not as the final shot `
      + `(<= ${FLOOR_WINDOW_MS}ms): the ${BID_CAP}-bid cap was spent walking a ladder that carries the guard as `
      + `an extra price, so the bids ran out before the close. Sent: `
      + sent.map((s) => `${s.price}@${s.remainingMs}ms`).join(', '));
  });

  await check('3 control-min-equals-bottom: a band whose minimum is its lowest margin releases and snipes that price', async () => {
    const d = releaseOn('Syngenta', SYNGENTA);
    assert.ok(d && d.price === SYNGENTA_BOTTOM, `the release must offer ${SYNGENTA_BOTTOM}, got ${d && d.price}`);
    const sent = await runToClose('Syngenta', SYNGENTA);
    const prices = sent.map((s) => s.price);
    assert.deepStrictEqual(prices, SYNGENTA_BAND_PRICES, `Syngenta must walk its band exactly: ${prices}`);
    const lastShot = sent[sent.length - 1];
    assert.ok(lastShot.remainingMs <= FLOOR_WINDOW_MS,
      `Syngenta's last shot went out at ${lastShot.remainingMs}ms remaining, outside the final window`);
  });

  await check('4 belt-still-holds: no price below the minimum-margin guard passes the fire-point belt or reaches the adapter', async () => {
    const adapter = idleAdapter();
    let wrote = 0;
    adapter.placeBid = async () => { wrote++; return { accepted: true, ok: true, myRank: 2 }; };
    const eng = mkEngine(adapter);
    const m = armOn(eng, 'Borosil', BOROSIL, Date.now() + 900_000);
    const belowGuard = BOROSIL_GUARD - 1;
    assert.ok(eng._bidOpts(m).floor >= BOROSIL_GUARD,
      `the adapter belt floor ${eng._bidOpts(m).floor} sits below the guard ${BOROSIL_GUARD}`);
    assert.throws(() => assertAboveFloor(belowGuard, eng._bidOpts(m).floor), (e) => e.code === 'FLOOR');
    eng._decide = () => ({ price: belowGuard, rungIndex: 0 });
    m.closeModel = 'hard';
    await assert.rejects(
      eng._maybeBid(m, { closesInMs: 20_000, myRank: 2, minDecrement: 100, standingL1Price: null, measuredRttMs: 80 }),
      (e) => e.code === 'FLOOR');
    assert.strictEqual(wrote, 0, `a price below the guard reached the adapter ${wrote} time(s)`);
  });
})().catch((e) => { console.error(e); process.exitCode = 1; });
