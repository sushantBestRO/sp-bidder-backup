'use strict';
/**
 * THE LOWEST PRE-WIRE THROW SITES: THE PER-LINE FLOOR, A MOVING QUOTE, AND WHERE THE NOTICE GOES.
 *
 * Regression target: the pre-wire give-back (the engine arm keyed on an adapter error marked
 * `placed: false`) at the throw sites that sit furthest from the top of placeBid, and the routing
 * key on the notice it raises.
 *
 * THE MECHANISM, in plain words.
 *   - GoComet checks each freight line against that line's own floor in the submit loop, after the
 *     confirming quote read and just before the PUT. On a load the desk priced per truck type, the
 *     line floor is the type's own cost, so a per-type cost that sits above the rung being bid
 *     throws FLOOR there. That throw is still above the write and must book nothing; the flag that
 *     says "dispatched" has to sit below this loop, not merely below the confirming read.
 *   - A quote that moves between the first read and the confirming read throws QUOTE_CHANGED on
 *     every attempt, and each attempt puts two real quote reads on the wire. Only a throttle may
 *     give its per-minute cap slot back; this loop must stay inside maxBidsPerMin.
 *   - The bid_not_sent notice carries the load's branch, and the desk notice routes on it, so a
 *     customer with branch-scoped groups hears about the right load in the right group.
 *   - A SuperProcure `_request` that throws while building its headers, before fetch, books
 *     nothing, and the error the engine sees is that fault itself, not a gate further up.
 *
 * OWNER-OPEN: check 3 pins the current retry volume design - a non-throttle pre-wire refusal
 * retries until the per-minute cap stops it. It asserts only the bound, so a future per-load retry
 * ceiling at or under maxBidsPerMin still passes; a change that lets this loop exceed the cap needs
 * a deliberate decision and a change to this check.
 *
 * WHAT MUST NOT MOVE: check 1. The same per-type load with a cost vector consistent with the rung
 * reads the quote twice and puts exactly one PUT on the wire, so the FLOOR result in check 2 is the
 * line belt and not a harness that never reached the submit loop.
 *
 * Offline and deterministic: the REAL GoComet and SuperProcure adapters over an injected counting
 * fetchImpl, the REAL engine over a temp-file DurableScheduler, a virtual clock, a fixed jitter
 * source, no sleeps, no network.
 *
 *   node scripts/test-prewire-lower-throw-sites.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { chargeMatchToken } = require('../src/platform/gocometCargo');
const { toNotification } = require('../src/notify/engineAlerts');

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
const tmp = () => { const f = path.join(os.tmpdir(), `prewire-lower-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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
const FLOOR = LADDER[LADDER.length - 1];
const ARMED_REVISIONS = 30;
const BRANCH = 'Alwar Cable';

// GoComet transport. `mode.get`: 'ok', 'throw' (the quote read never lands) or 'moving' (successive
// reads alternate between two documents, so every confirming read disagrees with the first).
function gocomet(mode) {
  const wire = { gets: 0, puts: [] };
  let reads = 0;
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {}, log: silentLog,
    now: () => Date.now(),
    fetchImpl: async (url, init) => {
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'PUT') {
        wire.puts.push(JSON.parse(String(init.body)).quote.charges_list['11_freight_charges']
          .freight_charges_custom_charge_40ft.price);
        return httpResponse(200, { data: { quote_rank: 4 } });
      }
      wire.gets += 1;
      reads += 1;
      if (mode.get === 'throw') throw new Error('ECONNRESET');
      return httpResponse(200, [quoteDoc(mode.get === 'moving' && reads % 2 === 0 ? 43_000 : 44_000)]);
    } });
  return { gc, wire };
}

function mkEngine(placeBid, storePath = tmp()) {
  const events = [];
  const calls = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      const call = { at: Date.now(), price, code: null, message: null };
      calls.push(call);
      try { return await placeBid(id, price, opts); } catch (e) { call.code = e && e.code; call.message = e && e.message; throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(storePath), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });
  return { eng, events, calls, storePath };
}

function arm(eng, id) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: BRANCH, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = ARMED_REVISIONS;
  m.triggerWindowMs = 100_000;
  return m;
}

// The desk priced the load per truck type. `typeCost` is what it typed for the one 40ft type; the
// engine hands meta.rules to placeBid, which is how a per-type vector reaches the adapter.
function pricePerType(m, typeCost) {
  m.meta.rules = Object.assign({}, m.meta.rules, { costByType: { cost: typeCost,
    types: [{ match: chargeMatchToken('40ft'), label: '40ft', count: 1, cost: typeCost }] } });
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

const booked = (m) => ({ landedBids: m.landedBids, lastBidPrice: m.lastBidPrice, revisionsLeft: m.revisionsLeft });
const durable = (storePath, id) => {
  const intent = new DurableScheduler(storePath).get(id) || {};
  return {
    landedBids: Number(intent.landedBids || 0),
    landedBidPrice: intent.landedBidPrice == null ? null : intent.landedBidPrice,
    everBid: !!intent.everBid,
    revisionsLeft: intent.revisionsLeft == null ? ARMED_REVISIONS : intent.revisionsLeft,
  };
};
const NOTHING = { landedBids: 0, lastBidPrice: null, revisionsLeft: ARMED_REVISIONS };
const NOTHING_DURABLE = { landedBids: 0, landedBidPrice: null, everBid: false, revisionsLeft: ARMED_REVISIONS };

(async () => {
  // ----------------------------------------------- 1. CONTROL: a consistent per-type load reaches the PUT
  await check('CONTROL: a per-type load whose cost fits the rung reads the quote twice and puts one PUT on the wire', async () => {
    const { gc, wire } = gocomet({ get: 'ok' });
    await gc.login();
    const { eng, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'PT-OK');
    pricePerType(m, 40_000);
    await drive(eng, m, { from: 126_739, to: 125_000 });
    assert.deepStrictEqual(calls.map((c) => c.code), [null], 'control: one attempt, and it must not throw');
    assert.strictEqual(wire.gets, 2, 'control: the adapter reads the quote and then confirms it');
    assert.deepStrictEqual(wire.puts, [LADDER[0]], 'control: the establish price goes on the wire exactly once');
    assert.strictEqual(m.landedBids, 1, 'control: the landed bid is booked');
  });

  // ----------------------------------------------- 2. per-line floor below the confirming read
  await check('a per-type line that breaches its own floor in the submit loop books nothing', async () => {
    const { gc, wire } = gocomet({ get: 'ok' });
    await gc.login();
    const { eng, calls, storePath } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'PT-FLOOR');
    pricePerType(m, 100_000);
    await drive(eng, m, { from: 126_739, to: 125_000 });
    assert.deepStrictEqual(calls.map((c) => c.code), ['FLOOR'], 'harness: the line belt refused the one attempt');
    assert.strictEqual(wire.gets, 2, 'harness: the refusal came after the confirming read, in the submit loop');
    assert.strictEqual(wire.puts.length, 0, 'harness: no PUT was issued');
    assert.deepStrictEqual(booked(m), NOTHING,
      'FLOOR: the engine booked a landed bid that never left the box - the per-line floor belt sits '
      + 'above the PUT but was not marked as never sent, so it fell into the uncertain-outcome handler '
      + 'and spent a revision on a bid the portal never saw');
    assert.deepStrictEqual(durable(storePath, 'PT-FLOOR'), NOTHING_DURABLE,
      'FLOOR: the durable intent records a bid the portal never saw, so a restart rehydrates it');
  });

  // ----------------------------------------------- 3. a moving-quote loop stays inside the cap
  await check('a QUOTE_CHANGED retry loop stays within maxBidsPerMin per rolling minute', async () => {
    const { gc, wire } = gocomet({ get: 'moving' });
    await gc.login();
    const { eng, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const cap = eng.cfg.maxBidsPerMin;
    const m = arm(eng, 'QC-LOOP');
    await drive(eng, m, { from: 126_739, to: 0 });
    const moved = calls.filter((c) => c.code === 'QUOTE_CHANGED').length;
    assert.strictEqual(calls[0] && calls[0].code, 'QUOTE_CHANGED', 'harness: the first attempt saw the quote move');
    assert.ok(moved >= 2, `harness: the load retried after the first refusal (${moved} QUOTE_CHANGED attempts)`);
    assert.ok(wire.gets >= 2 * moved, 'harness: each QUOTE_CHANGED attempt put two quote reads on the wire');
    assert.strictEqual(wire.puts.length, 0, 'harness: no PUT was issued');
    let maxIn60 = 0;
    for (let i = 0; i < calls.length; i++) {
      let k = i;
      while (k < calls.length && calls[k].at - calls[i].at < 60_000) k++;
      maxIn60 = Math.max(maxIn60, k - i);
    }
    assert.ok(maxIn60 <= cap,
      `${maxIn60} attempts in one 60 s window against maxBidsPerMin ${cap} on a quote that keeps moving, each `
      + 'QUOTE_CHANGED with two real quote reads: only a throttle may give its cap slot back. Current design bounds this loop by the '
      + 'cap alone - if the owner rules otherwise, change this pin deliberately');
  });

  // ----------------------------------------------- 4. the notice carries the branch it routes on
  await check('bid_not_sent carries the load branch and the desk notice routes on it', async () => {
    const { gc } = gocomet({ get: 'throw' });
    await gc.login();
    const { eng, events } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'BRANCH');
    await drive(eng, m, { from: 126_739, to: 120_000 });
    const bns = events.filter((e) => e.type === 'alert' && e.kind === 'bid_not_sent');
    assert.strictEqual(bns.length, 1, `harness: one bid_not_sent for the failed attempt, got ${bns.length}`);
    assert.strictEqual(bns[0].branchName, BRANCH,
      `the notice must carry the load's branch (${BRANCH}), got ${JSON.stringify(bns[0].branchName)}; `
      + 'without it a branch-scoped customer group never hears about its own load');
    const n = toNotification(bns[0]);
    assert.ok(n && n.kind === 'desk_notice', 'harness: the notice routes as a desk_notice');
    assert.strictEqual(n.data.branch, BRANCH,
      `the desk notice routes on data.branch, got ${JSON.stringify(n.data.branch)}`);
  });

  // ----------------------------------------------- 5. SuperProcure headers fault before fetch
  await check('a SuperProcure headers fault inside _request books nothing and is the error the engine sees', async () => {
    const wire = { total: 0 };
    const sp = new RealSuperProcureAdapter({ token: 'x', sleep: async () => {}, authProbeEnabled: false,
      accountId: 'primary', accountLabel: 'Primary',
      fetchImpl: async () => { wire.total += 1; return httpResponse(0, ''); } });
    sp.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
    sp.writeEnabled = true;
    sp._headers = () => { throw new Error('headers unavailable'); };
    const { eng, calls, storePath } = mkEngine((i, p, o) => sp.placeBid(i, p, o));
    const m = arm(eng, 'SP-HDR');
    await drive(eng, m, { from: 126_739, to: 125_000 });
    assert.strictEqual(calls.length, 1, 'harness: one attempt ran');
    assert.strictEqual(calls[0].message, 'headers unavailable',
      `harness: the attempt must fail on the headers fault itself, got ${calls[0].code || ''} ${calls[0].message}`);
    assert.strictEqual(wire.total, 0, 'harness: _request threw before fetch was called');
    assert.deepStrictEqual(booked(m), NOTHING,
      'a throw out of _request before fetch was booked as a landed bid; only the mark in _request\'s '
      + 'own catch can say it was never sent');
    assert.deepStrictEqual(durable(storePath, 'SP-HDR'), NOTHING_DURABLE,
      'the durable intent records a bid SuperProcure never received');
  });

  if (failures.length) throw failures[0];
  cleanup();
  const EXPECTED = 5;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - the lowest pre-wire throw sites book nothing and stay capped`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - a low pre-wire throw site booked a bid, ran past the cap, or lost its branch\n' + ((e && e.stack) || e));
  process.exit(1);
});
