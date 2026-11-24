'use strict';
/**
 * EVERY THROW ABOVE THE WRITE REQUEST IS MARKED PRE-WIRE - NOT JUST THE FIRST ONE.
 *
 * Regression target: where each adapter's placeBid sets its "the write was dispatched" flag, and
 * the explicit pre-wire mark in realAdapter's `_request` catch.
 *
 * THE MECHANISM, in plain words. Both adapters wrap placeBid so that any throw raised before the
 * write request is issued carries `placed: false`, and the engine books nothing for it. The mark is
 * decided by call site, not by error code, because NETWORK is thrown on both sides of the write.
 * That makes the POSITION of the flag the whole contract: every throw site between the top of
 * placeBid and the request must sit above it. The first throw site is not enough:
 *   - GoComet reads the quote twice. The second, confirming read throws QUOTE_CHANGED when another
 *     writer on the same vendor identity moved the quote in between. It sits well below the first
 *     read, next to the PUT.
 *   - SuperProcure runs ensureSession, builds the payload and applies the vehicle-count, floor and
 *     ceiling belts after its write gate and before the createV2 request.
 *   - SuperProcure's `_request` can throw before it calls fetch (building the headers). The flag is
 *     already set by then, so only the explicit mark in that catch keeps it pre-wire.
 * A flag set too early turns each of these into an "uncertain outcome": the engine books a landed
 * bid, spends a revision and the rung, and persists the phantom onto the durable intent, so every
 * later price at or above it is refused on a live load.
 *
 * WHAT MUST NOT MOVE: check 1. With the same harness and no belt or fault in the way, each adapter
 * reaches its write request exactly once, so a zero-request result below is the belt or fault
 * under test and not a harness that never got that far.
 *
 * Offline and deterministic: the REAL GoComet and SuperProcure adapters over an injected counting
 * fetchImpl, the REAL engine over a temp-file DurableScheduler, a virtual clock, a fixed jitter
 * source, no sleeps, no network.
 *
 *   node scripts/test-prewire-mark-by-call-site.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

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
const tmp = () => { const f = path.join(os.tmpdir(), `prewire-mark-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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

const quoteDoc = (price) => ({
  id: 'Q1',
  charges_list: { '11_freight_charges': {
    display_name: 'Freight',
    freight_charges_custom_charge_40ft: { units: 1, unit_name: 'TRUCK', price },
  } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: price } },
});

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const ARMED_REVISIONS = 30;

// GoComet transport. With `moving` set, successive quote reads alternate between two documents,
// so the confirming read inside one placeBid never matches the first.
function gocomet({ moving }) {
  const wire = { gets: 0, puts: 0 };
  let reads = 0;
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {}, log: silentLog,
    now: () => Date.now(),
    fetchImpl: async (url, init) => {
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'PUT') { wire.puts += 1; return httpResponse(200, { data: { quote_rank: 4 } }); }
      wire.gets += 1;
      reads += 1;
      return httpResponse(200, [quoteDoc(moving && reads % 2 === 0 ? 43_000 : 44_000)]);
    } });
  return { gc, wire };
}

// SuperProcure transport. Every request is counted here, outside the adapter; the createV2 write
// comes back status 0.
function superprocure() {
  const wire = { total: 0, submits: 0 };
  const sp = new RealSuperProcureAdapter({ token: 'x', sleep: async () => {}, authProbeEnabled: false,
    accountId: 'primary', accountLabel: 'Primary',
    fetchImpl: async (url) => {
      wire.total += 1;
      if (String(url).includes('/sp/bids/createV2')) wire.submits += 1;
      return httpResponse(0, '');
    } });
  sp.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  sp.writeEnabled = true;
  return { sp, wire };
}

// Arms one load, drives it into a single bid attempt, and reads back what the engine booked,
// including the durable intent through a fresh scheduler - what a restart would rehydrate.
async function attempt(id, placeBid) {
  const storePath = tmp();
  const codes = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, myRank: 4, revisionsLeft: null }),
    placeBid: async (i, p, o) => {
      try { return await placeBid(i, p, o); } catch (e) { codes.push(e && e.code); throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(storePath), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: () => {},
    log: silentLog,
    rand: () => 0.5,
  });
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = LADDER[LADDER.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = ARMED_REVISIONS;
  m.triggerWindowMs = 100_000;
  let r = 126_739;
  let ticks = 0;
  while (r >= 125_000 && ticks++ < 1_000) {
    await eng._maybeBid(m, { closesInMs: r, myRank: 4, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
    const step = Math.max(1, eng._cadence(r, m));
    r -= step;
    clock.t += step;
  }
  const intent = new DurableScheduler(storePath).get(id) || {};
  return {
    codes,
    booked: { landedBids: m.landedBids, lastBidPrice: m.lastBidPrice, revisionsLeft: m.revisionsLeft },
    durable: {
      landedBids: Number(intent.landedBids || 0),
      landedBidPrice: intent.landedBidPrice == null ? null : intent.landedBidPrice,
      everBid: !!intent.everBid,
      revisionsLeft: intent.revisionsLeft == null ? ARMED_REVISIONS : intent.revisionsLeft,
    },
  };
}

const NOTHING = { landedBids: 0, lastBidPrice: null, revisionsLeft: ARMED_REVISIONS };
const NOTHING_DURABLE = { landedBids: 0, landedBidPrice: null, everBid: false, revisionsLeft: ARMED_REVISIONS };
const PHANTOM = 'the engine booked a landed bid that never left the box: the throw came from above the '
  + 'write request but was not marked as never sent, so it fell into the uncertain-outcome handler';

(async () => {
  // ----------------------------------------------- 1. CONTROL: both adapters reach the write
  await check('CONTROL: with nothing in the way each adapter reaches its write request exactly once', async () => {
    const { gc, wire } = gocomet({ moving: false });
    await gc.login();
    const gcRun = await attempt('GC-CTRL', (i, p, o) => gc.placeBid(i, p, o));
    assert.deepStrictEqual(gcRun.codes, [], 'control: a stable quote must not throw');
    assert.strictEqual(wire.gets, 2, 'control: GoComet reads the quote and then confirms it');
    assert.strictEqual(wire.puts, 1, 'control: a stable quote reaches the PUT exactly once');
    const sp = superprocure();
    await attempt('SP-CTRL', (i, p, o) => sp.sp.placeBid(i, p, o));
    assert.strictEqual(sp.wire.total, 1, 'control: with no belt or fault, SuperProcure issues exactly one request');
    assert.strictEqual(sp.wire.submits, 1, 'control: that request is the createV2 write');
  });

  // ----------------------------------------------- 2. GoComet QUOTE_CHANGED on the confirming read
  await check('a GoComet QUOTE_CHANGED on the confirming read books nothing and spends no revision', async () => {
    const { gc, wire } = gocomet({ moving: true });
    await gc.login();
    const run = await attempt('GC-QC', (i, p, o) => gc.placeBid(i, p, o));
    assert.deepStrictEqual(run.codes, ['QUOTE_CHANGED'], 'harness: the confirming read saw a moved quote');
    assert.strictEqual(wire.gets, 2, 'harness: the throw came from the second, confirming quote read');
    assert.strictEqual(wire.puts, 0, 'harness: no PUT was issued');
    assert.deepStrictEqual(run.booked, NOTHING, `QUOTE_CHANGED: ${PHANTOM}`);
    assert.deepStrictEqual(run.durable, NOTHING_DURABLE,
      `QUOTE_CHANGED: the durable intent records a bid the portal never saw, so a restart rehydrates it`);
  });

  // ----------------------------------------------- 3. SuperProcure ceiling belt
  await check('a SuperProcure ceiling-belt refusal books nothing', async () => {
    const { sp, wire } = superprocure();
    const run = await attempt('SP-CEIL', (i, p, o) => sp.placeBid(i, p, Object.assign({}, o, { ceilingPrice: 30_000 })));
    assert.strictEqual(run.codes.length, 1, 'harness: the belt threw on the attempt');
    assert.strictEqual(run.codes[0], 'CEILING', `harness: the ceiling belt refused, got ${run.codes[0]}`);
    assert.strictEqual(wire.total, 0, 'harness: nothing reached the transport');
    assert.deepStrictEqual(run.booked, NOTHING, `CEILING: ${PHANTOM}`);
    assert.deepStrictEqual(run.durable, NOTHING_DURABLE,
      'CEILING: the durable intent records a bid the portal never saw, so a restart rehydrates it');
  });

  // ----------------------------------------------- 4. SuperProcure _request throws before fetch
  await check('a SuperProcure _request that throws before fetch books nothing', async () => {
    const { sp, wire } = superprocure();
    sp._headers = () => { throw new Error('headers unavailable'); };
    const run = await attempt('SP-HDR', (i, p, o) => sp.placeBid(i, p, o));
    assert.strictEqual(run.codes.length, 1, 'harness: the attempt threw');
    assert.strictEqual(wire.total, 0, 'harness: _request threw before fetch was called');
    assert.deepStrictEqual(run.booked, NOTHING,
      `a throw out of _request before fetch: ${PHANTOM}; only the mark in _request's own catch can say it was never sent`);
  });

  if (failures.length) throw failures[0];
  cleanup();
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - every throw above the write request is marked pre-wire`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - a throw above the write request was booked as a landed bid\n' + ((e && e.stack) || e));
  process.exit(1);
});
