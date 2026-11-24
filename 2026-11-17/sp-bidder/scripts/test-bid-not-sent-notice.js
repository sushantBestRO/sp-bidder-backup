'use strict';
/**
 * A BID THAT NEVER LEFT THE BOX TELLS THE DESK ONCE - AND ONLY WHEN IT REALLY NEVER LEFT.
 *
 * Regression target: the bid_not_sent desk notice raised by the engine's pre-wire arm in the
 * placeBid catch (the arm keyed on an adapter error marked `placed: false`).
 *
 * THE MECHANISM, in plain words. When an adapter throws before its write request is issued - a
 * GoComet quote read that failed or was throttled, a belt, a write gate - the engine books nothing,
 * holds the rung and retries. Without a notice that is invisible: the desk priced a load, the
 * engine decided a price, and nothing reached the portal. So the arm emits one `bid_not_sent` alert
 * per load (level warn, carrying the price that did not go out and how many of our bids already
 * stand), engineAlerts routes it as a desk_notice with that price on the payload, and waTemplates
 * renders "Bid not sent - <customer>: Rs <price> did not reach the portal" with an action line that
 * says nothing new was placed and whether an earlier bid still stands.
 *
 * What each check pins:
 *   2. repeated pre-wire throws on one load raise exactly one notice, with the price and a zero
 *      standing count, and never the uncertain-outcome alert.
 *   3-4. a load retired (finalized) or an engine killed while the attempt was in flight stays
 *      silent - "we will try again" would be false.
 *   5. the notice routes to the desk and renders the headline and the nothing-placed action line.
 *   6. after a bid of ours has landed, the notice carries that count and says the earlier bid
 *      still stands.
 *   7. a write that WAS dispatched and then failed must never be reported as not sent.
 *
 * WHAT MUST NOT MOVE: check 1 (the harness places a real PUT on a healthy transport and raises no
 * notice) and check 7 (the dispatched path). Telling the desk "nothing was placed" over a write
 * that may be committed is the dangerous direction: a person would re-quote the load by hand on
 * top of our own live bid.
 *
 * Offline and deterministic: the REAL GoComet and SuperProcure adapters over an injected counting
 * fetchImpl, the REAL engine over a temp-file DurableScheduler, a virtual clock, a fixed jitter
 * source, no sleeps, no network.
 *
 *   node scripts/test-bid-not-sent-notice.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

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
const tmp = () => { const f = path.join(os.tmpdir(), `bid-not-sent-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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

// Shaped after the observed GoComet payload: one 11_freight_charges group with one
// freight_charges_custom_charge* line, plus the total_charges block the basis check reads.
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

// GoComet transport. `mode.get` is 'ok' or 'throw' (a quote GET that never lands). PUTs are
// recorded here, outside the adapter, so "reached the portal" is measured rather than assumed.
function gocomet(mode) {
  const wire = { gets: 0, puts: [] };
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
      if (mode.get === 'throw') throw new Error('ECONNRESET');
      return httpResponse(200, [quoteDoc()]);
    } });
  return { gc, wire };
}

// SuperProcure transport whose createV2 comes back status 0: _request folds the failure into
// status 0 and returns, so placeBid raises NETWORK from BELOW the dispatched write.
function superprocure() {
  const wire = { submits: 0, unexpected: [] };
  const sp = new RealSuperProcureAdapter({ token: 'x', sleep: async () => {}, authProbeEnabled: false,
    accountId: 'primary', accountLabel: 'Primary',
    fetchImpl: async (url) => {
      if (String(url).includes('/sp/bids/createV2')) { wire.submits += 1; return httpResponse(0, ''); }
      wire.unexpected.push(String(url));
      return httpResponse(500, '');
    } });
  sp.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  sp.writeEnabled = true;
  return { sp, wire };
}

function mkEngine(placeBid) {
  const events = [];
  const calls = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => { calls.push(price); return placeBid(id, price, opts); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
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
const render = (evt) => {
  const n = toNotification(evt);
  return { n, body: n ? renderMessage(templateFor(n.kind, n.data), n.data) : null };
};

(async () => {
  // ----------------------------------------------- 1. CONTROL: a healthy transport places the bid
  await check('CONTROL: a healthy GoComet transport puts the establish price on the wire and raises no notice', async () => {
    const { gc, wire } = gocomet({ get: 'ok' });
    await gc.login();
    const { eng, events } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-OK');
    await drive(eng, m, { from: 126_739, to: 60_000, stopWhen: () => wire.puts.length >= 1 });
    assert.deepStrictEqual(wire.puts, [LADDER[0]],
      'control: on a healthy transport the same drive must put the establish price on the wire once');
    assert.strictEqual(m.landedBids, 1, 'control: the landed establish bid is booked');
    assert.strictEqual(alerts(events, 'bid_not_sent').length, 0,
      'control: a bid that reached the portal raises no bid_not_sent');
  });

  // ----------------------------------------------- 2. one notice per load, with the price
  let plainEvent;
  await check('repeated pre-wire throws on one load raise exactly one bid_not_sent, carrying the price', async () => {
    const { gc, wire } = gocomet({ get: 'throw' });
    await gc.login();
    const { eng, events, calls } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-NET');
    await drive(eng, m, { from: 126_739, to: 60_000 });
    assert.strictEqual(wire.puts.length, 0, 'harness: the quote read failed, so no PUT can have gone out');
    assert.ok(calls.length >= 2,
      `after a pre-wire throw the engine must hold the rung and try again; ${calls.length} attempt(s) over 66 s `
      + 'means the load stopped bidding after one quote read failed');
    const bns = alerts(events, 'bid_not_sent');
    assert.strictEqual(bns.length, 1,
      `${calls.length} attempts that never left the box raised ${bns.length} bid_not_sent notices; the `
      + 'desk must be told exactly once per load - zero leaves a priced load silently unbid, more than '
      + 'one floods the customer group on every retry');
    assert.strictEqual(bns[0].level, 'warn', 'bid_not_sent is a warn-level notice');
    assert.strictEqual(bns[0].price, LADDER[0], `the notice must carry the price that did not go out, got ${bns[0].price}`);
    assert.strictEqual(bns[0].landedBids, 0, 'nothing of ours stands on this load, and the notice must say so');
    assert.strictEqual(bns[0].companyName, 'Havells', 'the notice names the customer');
    assert.strictEqual(alerts(events, 'bid_submit_error').length, 0,
      'a throw raised before the request was issued is not an uncertain outcome; bid_submit_error '
      + 'means the engine treated it as a write that may be on the board');
    assert.strictEqual(m.landedBids, 0, 'the pre-wire throw books nothing');
    plainEvent = bns[0];
  });

  // ----------------------------------------------- 3-4. retired or killed mid-attempt: silent
  for (const which of ['finalized', 'killed']) await check(`a load ${which} while its attempt was in flight raises no bid_not_sent`, async () => {
    const { gc } = gocomet({ get: 'throw' });
    await gc.login();
    let eng;
    let m;
    const r = mkEngine(async (i, p, o) => {
      if (which === 'finalized') m.finalized = true; else eng.killed = true;
      return gc.placeBid(i, p, o);
    });
    eng = r.eng;
    m = arm(eng, 'GC-' + which);
    await drive(eng, m, { from: 126_739, to: 120_000 });
    assert.strictEqual(r.calls.length, 1, `harness: one attempt ran before the load was ${which}`);
    assert.strictEqual(m.landedBids, 0, 'harness: the pre-wire throw books nothing');
    assert.strictEqual(alerts(r.events, 'bid_not_sent').length, 0,
      `the load was ${which} while its attempt was in flight, so no retry will follow; a bid_not_sent `
      + 'here tells the desk "we will try again" about a load the engine has already let go');
  });

  // ----------------------------------------------- 5. routed to the desk, rendered with the price
  await check('the notice routes as a desk_notice and renders the price and the nothing-placed line', async () => {
    assert.ok(plainEvent, 'this check renders the notice raised in check 2, and there was none');
    const { n, body } = render(plainEvent);
    assert.ok(n, 'bid_not_sent must route to a notification; null means it reaches nobody');
    assert.strictEqual(n.kind, 'desk_notice', `bid_not_sent must route as a desk_notice, got ${n.kind}`);
    assert.strictEqual(n.data.price, LADDER[0], `the desk-notice payload must carry the price, got ${n.data.price}`);
    assert.ok(body.includes('Bid not sent - Havells: Rs 41,420 did not reach the portal'),
      'the headline must say what did not happen and at what price, in Indian digit grouping:\n' + body);
    assert.ok(body.includes('It never left our system, so nothing was placed on the portal. '
      + 'We will try again while the load is open, and the result will follow at close.'),
      'the action line must say nothing was placed and what happens next:\n' + body);
    assert.ok(!body.includes('still stands'), 'no bid of ours stands, so the copy must not claim one:\n' + body);
  });

  // ----------------------------------------------- 6. after a landed bid: the earlier bid still stands
  await check('after a landed bid the notice carries the standing count and says the earlier bid still stands', async () => {
    const mode = { get: 'ok' };
    const { gc, wire } = gocomet(mode);
    await gc.login();
    const { eng, events } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-STANDS');
    await drive(eng, m, { from: 126_739, to: 120_000, stopWhen: () => wire.puts.length >= 1 });
    assert.strictEqual(m.landedBids, 1, 'harness: the establish bid landed');
    mode.get = 'throw';
    await drive(eng, m, { from: 99_000, to: 90_000 });
    const bns = alerts(events, 'bid_not_sent');
    assert.strictEqual(bns.length, 1, `the defend that never left the box must raise one bid_not_sent, got ${bns.length}`);
    assert.strictEqual(bns[0].landedBids, 1,
      `the notice must carry the count of our bids already standing (1), got ${bns[0].landedBids}; `
      + 'without it the desk is told nothing of ours is on the board when one is');
    assert.ok(bns[0].price > FLOOR && bns[0].price < LADDER[0], `the defend price, got ${bns[0].price}`);
    const { n, body } = render(bns[0]);
    assert.strictEqual(n.kind, 'desk_notice');
    const rs = 'Rs ' + bns[0].price.toLocaleString('en-IN');
    assert.ok(body.includes(`Bid not sent - Havells: ${rs} did not reach the portal`), 'headline:\n' + body);
    assert.ok(body.includes('It never left our system, so nothing new was placed on the portal. '
      + 'Our earlier bid on this load still stands. We will try again while the load is open, and the '
      + 'result will follow at close.'),
      'with a bid of ours already on the board, the action line must say it still stands:\n' + body);
  });

  // ----------------------------------------------- 7. a DISPATCHED write is never "not sent"
  await check('a dispatched write that failed raises bid_submit_error and never bid_not_sent', async () => {
    const { sp, wire } = superprocure();
    const { eng, events } = mkEngine((i, p, o) => sp.placeBid(i, p, o));
    const m = arm(eng, 'SP-SENT');
    await drive(eng, m, { from: 126_739, to: 120_000, stopWhen: () => wire.submits >= 1 });
    assert.strictEqual(wire.submits, 1, 'harness: the createV2 write was dispatched');
    assert.deepStrictEqual(wire.unexpected, [], 'harness: no other request was issued');
    assert.strictEqual(m.landedBids, 1,
      'a dispatched write with no answer may be committed on the portal and must stay booked as possibly '
      + 'landed; un-booking it lets the engine re-fire the same price over a live bid');
    assert.strictEqual(alerts(events, 'bid_submit_error').length, 1, 'the uncertain outcome raises bid_submit_error');
    assert.strictEqual(alerts(events, 'bid_not_sent').length, 0,
      'a write that was dispatched may be committed on the portal; telling the desk it did not reach '
      + 'the portal invites a hand quote on top of our own live bid');
  });

  if (failures.length) throw failures[0];
  cleanup();
  const EXPECTED = 7;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - bid_not_sent is raised once, only for a bid that never left the box`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - the desk is not told correctly about a bid that never left the box\n' + ((e && e.stack) || e));
  process.exit(1);
});
