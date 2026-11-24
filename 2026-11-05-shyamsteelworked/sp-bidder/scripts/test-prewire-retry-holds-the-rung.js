'use strict';
/**
 * A BID THAT NEVER LEFT THE BOX HOLDS ITS RUNG AND RETRIES - WITHIN THE RUNAWAY CAP.
 *
 * Regression target: the give-back in the engine's pre-wire arm in the placeBid catch (the arm
 * keyed on an adapter error marked `placed: false`).
 *
 * THE MECHANISM, in plain words. The fire point spends state before the adapter is called: the
 * rung, the snipe latch, the soft-close defend latch, a slot of the per-minute cap, the attempt
 * count. When the adapter throws before its write request is issued, the arm gives back exactly
 * the part that would otherwise stop the retry:
 *   - the rung, snipeFired and _lastDefendAtExtend, so the same decision fires again on a later
 *     tick. Without snipeFired one failed quote read forfeits the decisive floor shot; without
 *     _lastDefendAtExtend it forfeits the defend for the whole extension round.
 *   - the per-minute cap slot, but ONLY for RATE_LIMITED. A GoComet cooldown lasts a minute; if
 *     each throttled attempt spent a slot the cap would fill and starve the floor shot. Every other
 *     pre-wire code either re-throws deterministically or puts a real quote read on the wire each
 *     time, and the cap is the only thing bounding that loop.
 * and it holds the rest: ownBidAttempts, everBid and lastFireAt stay spent, so retries stay paced
 * by minInterFireMs and a close with nothing landed still reports the attempts, and no refusal is
 * recorded, because a recorded refusal is terminal and would outlive a retry that lands.
 *
 * The attempt-facts check (4) pins the shape as built. Whether those facts should be given back
 * and whether a load that failed pre-wire on every attempt should close with a named refusal are
 * open design questions; if they are decided the other way, change that check deliberately.
 *
 * WHAT MUST NOT MOVE: check 1. On a healthy transport the same pre-walked ladder puts the floor
 * shot on the wire exactly once, which is what makes the retry checks attributable to the arm and
 * not to a harness that stopped reaching the wire.
 *
 * Offline and deterministic: the REAL GoComet adapter over an injected counting fetchImpl, the REAL
 * engine over a temp-file DurableScheduler, a virtual clock shared by engine and adapter, a fixed
 * jitter source, no sleeps, no network.
 *
 *   node scripts/test-prewire-retry-holds-the-rung.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
// Every check runs and reports, and only then is the first failure rethrown, so one run shows the
// whole failure profile of a partial change. Anything that is not an assertion is a broken harness
// and stops the file at once.
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    if (!(e instanceof assert.AssertionError)) throw e;
    console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n')[0]);
    failures.push(e);
  }
}
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `prewire-retry-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const REAL_NOW = Date.now;
const clock = { t: 1_700_000_000_000 };
Date.now = () => clock.t;
const cleanup = () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: 4_000_000_000, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const httpResponse = (status, body) => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const quoteDoc = () => ({
  id: 'Q1',
  charges_list: { '11_freight_charges': {
    display_name: 'Freight',
    freight_charges_custom_charge_40ft: { units: 1, unit_name: 'TRUCK', price: 44_000 },
  } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: 44_000 } },
});

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const FLOOR = LADDER[LADDER.length - 1];

// GoComet transport. `mode.get`: 'ok', 'throw' (the quote GET never lands) or '429' (the quote GET
// is throttled, which opens the adapter's own cooldown). The adapter clock is the virtual clock
// plus `adapterClock.off`, so a test can lift the cooldown without moving the engine's countdown.
function gocomet(mode) {
  const wire = { gets: 0, puts: [] };
  const adapterClock = { off: 0 };
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {}, log: silentLog,
    now: () => Date.now() + adapterClock.off,
    fetchImpl: async (url, init) => {
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'PUT') {
        wire.puts.push(JSON.parse(String(init.body)).quote.charges_list['11_freight_charges']
          .freight_charges_custom_charge_40ft.price);
        return httpResponse(200, { data: { quote_rank: 4 } });
      }
      wire.gets += 1;
      if (mode.get === 'throw') throw new Error('ECONNRESET');
      if (mode.get === '429') return httpResponse(429, '');
      return httpResponse(200, [quoteDoc()]);
    } });
  return { gc, wire, adapterClock };
}

function mkEngine(placeBid, cfg = {}) {
  const events = [];
  const calls = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      const call = { at: Date.now(), price, code: null };
      calls.push(call);
      try { return await placeBid(id, price, opts); } catch (e) { call.code = e && e.code; throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfg),
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });
  return { eng, events, calls };
}

function arm(eng, id) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = 30;
  m.triggerWindowMs = 100_000;
  return m;
}

// The late-auction position: every rung above the floor already fired and landed, so the next
// decision the engine makes is the decisive floor shot.
function prewalk(m) {
  for (const i of [0, 1, 2, 3]) m.firedRungs.add(i);
  m.currentRungIndex = 3;
  m.landedBids = 1;
  m.lastBidPrice = LADDER[3];
  m._lastDefendAtExtend = 0;
}

const state = (remaining) => ({ closesInMs: remaining, myRank: 4, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

async function drive(eng, m, { from, to, stopWhen }) {
  let r = from;
  let ticks = 0;
  while (r >= to && ticks++ < 20_000) {
    await eng._maybeBid(m, state(r));
    if (stopWhen && stopWhen()) return;
    const step = Math.max(1, eng._cadence(r, m));
    r -= step;
    clock.t += step;
  }
}

const alerts = (events, kind) => events.filter((e) => e.type === 'alert' && e.kind === kind);

// Throws once, on the first placeBid, by failing that attempt's quote read; every later attempt
// sees a healthy transport.
function failFirstQuoteRead(gc, mode) {
  let armed = true;
  return async (i, p, o) => {
    if (!armed) return gc.placeBid(i, p, o);
    armed = false;
    mode.get = 'throw';
    try { return await gc.placeBid(i, p, o); } finally { mode.get = 'ok'; }
  };
}

(async () => {
  // ----------------------------------------------- 1. CONTROL: the floor shot reaches the wire
  await check('CONTROL: a healthy transport puts the decisive floor shot on the wire exactly once', async () => {
    const { gc, wire } = gocomet({ get: 'ok' });
    await gc.login();
    const { eng } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'CTRL');
    prewalk(m);
    await drive(eng, m, { from: 30_000, to: 0, stopWhen: () => wire.puts.length >= 1 });
    assert.deepStrictEqual(wire.puts, [FLOOR],
      'control: on a healthy transport the pre-walked ladder must put the floor shot on the wire once');
  });

  // ----------------------------------------------- 2. a throttle does not spend the runaway cap
  await check('a GoComet cooldown does not spend the per-minute cap, so the shot after it still goes out', async () => {
    const mode = { get: '429' };
    const { gc, wire, adapterClock } = gocomet(mode);
    await gc.login();
    const { eng, events, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'RL');
    await drive(eng, m, { from: 126_739, to: 2_000 });
    assert.strictEqual(wire.puts.length, 0, 'harness: nothing reached the wire during the cooldown');
    assert.ok(calls.length > eng.cfg.maxBidsPerMin,
      `after a pre-wire throw the engine must hold the rung and keep trying through the cooldown; ${calls.length} `
      + `attempts against a cap of ${eng.cfg.maxBidsPerMin} means the load stopped retrying`);
    assert.ok(calls.every((c) => c.code === 'RATE_LIMITED'), 'harness: every attempt was throttled');
    mode.get = 'ok';
    adapterClock.off += 61_000;
    await drive(eng, m, { from: 1_999, to: 0, stopWhen: () => wire.puts.length >= 1 });
    const capAlerts = alerts(events, 'bids_per_min_cap');
    assert.strictEqual(capAlerts.length, 0,
      `throttled attempts tripped the runaway cap (bids_per_min_cap x${capAlerts.length}); a cooldown that `
      + 'sent nothing must not spend the per-minute budget');
    assert.strictEqual(wire.puts.length, 1,
      `the cooldown lifted 2 s before close and ${wire.puts.length} PUTs reached the wire; the throttled `
      + `attempts filled the per-minute cap (bidTimes ${m.bidTimes.length}) and starved the decisive shot`);
  });

  // ----------------------------------------------- 3. a non-throttle pre-wire loop stays capped
  await check('a repeating NETWORK-on-quote-read loop stays within maxBidsPerMin per rolling minute', async () => {
    const { gc } = gocomet({ get: 'throw' });
    await gc.login();
    const { eng, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const cap = eng.cfg.maxBidsPerMin;
    const m = arm(eng, 'NET');
    await drive(eng, m, { from: 126_739, to: 0 });
    assert.ok(calls.length > cap,
      `after a pre-wire throw the engine must hold the rung and keep trying; ${calls.length} attempts against a `
      + `cap of ${cap} means the load stopped retrying`);
    assert.ok(calls.every((c) => c.code === 'NETWORK'), 'harness: every attempt failed its quote read');
    let maxIn60 = 0;
    for (let i = 0; i < calls.length; i++) {
      let k = i;
      while (k < calls.length && calls[k].at - calls[i].at < 60_000) k++;
      maxIn60 = Math.max(maxIn60, k - i);
    }
    assert.ok(maxIn60 <= cap,
      `${maxIn60} attempts in one 60 s window against maxBidsPerMin ${cap}: each one puts a real quote `
      + 'read on the wire, and the per-minute cap is the only bound on that loop - only RATE_LIMITED may '
      + 'give its slot back');
  });

  // ----------------------------------------------- 4. attempt facts are held; no refusal recorded
  await check('pre-wire attempts stay counted to the close, and no refusal is recorded for them', async () => {
    const { gc } = gocomet({ get: 'throw' });
    await gc.login();
    const { eng, events, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'FACTS');
    await drive(eng, m, { from: 126_739, to: 60_000 });
    assert.ok(calls.length >= 2, `harness: several pre-wire attempts (${calls.length})`);
    const row = eng.snapshot().find((x) => x.auctionId === 'FACTS');
    assert.ok(row, 'harness: the load is on the console snapshot');
    const OWNER = '; current design holds the attempt facts after a pre-wire throw - if the owner rules '
      + 'otherwise, change this pin deliberately';
    assert.strictEqual(row.ownBidAttempts, calls.length,
      `console ownBidAttempts ${row.ownBidAttempts} vs ${calls.length} attempts made` + OWNER);
    assert.strictEqual(row.everBid, true, 'console everBid' + OWNER);
    await eng._finalize(m, { ...state(0), myRank: 4 });
    const nb = alerts(events, 'never_bid_before_close');
    assert.strictEqual(nb.length, 1, 'a close with nothing landed still raises never_bid_before_close');
    assert.strictEqual(nb[0].attempts, calls.length,
      `never_bid_before_close reports ${nb[0].attempts} attempts against ${calls.length} made` + OWNER);
    const results = events.filter((e) => e.type === 'auction_result');
    assert.strictEqual(results.length, 1, 'harness: one auction_result at close');
    assert.strictEqual(results[0].noBidReason, null,
      `the close carries noBidReason ${results[0].noBidReason}; current design records no refusal for a `
      + 'pre-wire throw, because a recorded refusal is terminal and would outlive a retry that lands - '
      + 'if the owner rules otherwise, change this pin deliberately');
  });

  // ----------------------------------------------- 5. retries are paced by minInterFireMs
  await check('pre-wire retries are paced by minInterFireMs', async () => {
    const { gc } = gocomet({ get: 'throw' });
    await gc.login();
    const MIN_GAP = 4_000;
    const { eng, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o), { minInterFireMs: MIN_GAP });
    const m = arm(eng, 'PACE');
    await drive(eng, m, { from: 126_739, to: 20_000 });
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.ok(gaps.length >= 3, `harness: several retries to measure (${calls.length} attempts)`);
    assert.ok(Math.min(...gaps) >= MIN_GAP,
      `pre-wire retries came ${Math.min(...gaps)} ms apart against minInterFireMs ${MIN_GAP}: lastFireAt was `
      + `given back, so the retry loop is no longer paced (gaps ${gaps.join(',')})`);
  });

  // ----------------------------------------------- 6. the decisive floor shot fires again
  await check('a pre-wire throw on the decisive floor shot is retried and the shot reaches the wire', async () => {
    const mode = { get: 'ok' };
    const { gc, wire } = gocomet(mode);
    await gc.login();
    const { eng, calls } = mkEngine(failFirstQuoteRead(gc, mode));
    const m = arm(eng, 'SNIPE');
    prewalk(m);
    await drive(eng, m, { from: 30_000, to: 0, stopWhen: () => wire.puts.length >= 1 });
    assert.strictEqual(calls[0].price, FLOOR, 'harness: the throw landed on the floor shot');
    assert.strictEqual(calls[0].code, 'NETWORK', 'harness: the floor shot failed on its quote read');
    assert.deepStrictEqual(wire.puts, [FLOOR],
      `after one failed quote read the floor shot must fire again and reach the wire once, got PUTs `
      + `[${wire.puts.join(',')}] from ${calls.length} attempts; snipeFired was left spent and the `
      + 'decisive shot was forfeited');
  });

  // ----------------------------------------------- 7. the defend fires again in the same round
  await check('a pre-wire throw on a defend is retried in the same round and the defend reaches the wire', async () => {
    const mode = { get: 'ok' };
    const { gc, wire } = gocomet(mode);
    await gc.login();
    const { eng, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'DEFEND');
    await drive(eng, m, { from: 126_739, to: 120_000, stopWhen: () => wire.puts.length >= 1 });
    assert.deepStrictEqual(wire.puts, [LADDER[0]], 'harness: the establish bid landed');
    const before = calls.length;
    eng.adapter.placeBid = ((orig) => {
      let armed = true;
      return async (i, p, o) => {
        if (!armed) return orig(i, p, o);
        armed = false;
        mode.get = 'throw';
        try { return await orig(i, p, o); } finally { mode.get = 'ok'; }
      };
    })(eng.adapter.placeBid);
    await drive(eng, m, { from: 99_000, to: 60_000, stopWhen: () => wire.puts.length >= 2 });
    assert.strictEqual(calls[before] && calls[before].code, 'NETWORK', 'harness: the first defend failed on its quote read');
    assert.strictEqual(wire.puts.length, 2,
      `after one failed defend the engine must retry in the same extension round and reach the wire; `
      + `got ${wire.puts.length} PUTs from ${calls.length - before} defend attempts - the rung or the defend `
      + 'latch was left spent, or the load was stood down');
    assert.ok(wire.puts[1] > FLOOR && wire.puts[1] < LADDER[0],
      `the retried defend must be a rung between the floor and the establish price, got ${wire.puts[1]}`);
  });

  if (failures.length) throw failures[0];
  cleanup();
  const EXPECTED = 7;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - a bid that never left the box holds its rung and retries within the cap`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - a pre-wire throw did not hold its rung, or retried outside the cap\n' + ((e && e.stack) || e));
  process.exit(1);
});
