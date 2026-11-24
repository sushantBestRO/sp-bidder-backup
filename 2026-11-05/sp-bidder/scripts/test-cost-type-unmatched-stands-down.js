'use strict';
/**
 * PER-TRUCK-TYPE RATES THAT CANNOT BE ROUTED STAND THE LOAD DOWN, AND THE DESK IS TOLD ONCE TO BID IT BY HAND.
 *
 * Regression target: the engine's COST_TYPE_UNMATCHED arm in the placeBid catch. GoComet's
 * resolvePerTypePrices refuses before either write request when the desk's per-type rates cannot be
 * matched to the quote's freight lines. That refusal is deterministic against the armed rates and
 * the quote, so it comes back on every attempt. On the base the arm restores the rung, records
 * per_type_rates_unmatched and returns: no stand-down and no desk notice, so the engine re-sends the
 * same refused bid until the per-load throttle stops it, and the desk hears nothing until the close
 * receipt. Ruling 47: COST_TYPE_UNMATCHED stands the load down with one by-hand notice.
 *
 * The contract: after the first refusal, no further placeBid on the load; exactly one desk notice,
 * the by-hand variant, stating the price; the close receipt names a reason.
 *
 * Control: the same load and transport with no per-type rates bids at once and raises no notice.
 *
 *   node scripts/test-cost-type-unmatched-stands-down.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
    pass++;
  } catch (e) {
    if (!(e instanceof assert.AssertionError)) throw e;
    console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n')[0]);
    failures.push(e);
  }
}
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `cost-type-unmatched-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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

// Priced for two truck types; the quote carries one freight line, so the rates cannot be routed.
const UNROUTABLE = {
  cost: 100_000,
  types: [
    { label: '40ft', match: '40ft', count: 1, cost: 110_000 },
    { label: '20ft ODC', match: '20ftodc', count: 1, cost: 90_000 },
  ],
};

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const OPEN = 126_739;
const CLOSE = 0;

function gocomet() {
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
      return httpResponse(200, [quoteDoc()]);
    } });
  return { gc, wire };
}

function mkEngine(gc, costByType) {
  const events = [];
  const calls = [];
  const codes = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      calls.push(price);
      const o = costByType ? Object.assign({}, opts, { costByType }) : opts;
      try { return await gc.placeBid(id, price, o); } catch (e) { codes.push(e && e.code); throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Waaree'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });
  return { eng, events, calls, codes };
}

function arm(eng, id) {
  const meta = { id, lane: { origin: 'Chikhli', destination: 'Jaipur' }, units: 1, equipment: '32ft',
    companyName: 'Waaree Energies', branchName: 'Chikhli', closesAt: Date.now() + 600_000 };
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

const deskNotices = (events, id) => events
  .filter((e) => e.type === 'alert' && e.auctionId === id)
  .map((evt) => {
    const n = toNotification(evt);
    return n && n.kind === 'desk_notice' ? { evt, n, body: renderMessage(templateFor(n.kind, n.data), n.data) } : null;
  })
  .filter(Boolean);
const BY_HAND = /by hand/i;
const TRY_AGAIN = /try again/i;
const UNKNOWN_REASON = /no bid could be placed before close/i;

(async () => {
  await check('1. CONTROL: the same load with one blended rate bids at once and raises no notice', async () => {
    const { gc, wire } = gocomet();
    await gc.login();
    const { eng, events, calls } = mkEngine(gc, null);
    const m = arm(eng, 'GC-BLENDED');
    await drive(eng, m, { from: OPEN, to: 60_000, stopWhen: () => wire.puts.length >= 1 });
    assert.deepStrictEqual(wire.puts, [LADDER[0]], `control: expected one PUT at ${LADDER[0]}, got ${JSON.stringify(wire.puts)}`);
    assert.strictEqual(calls.length, 1, 'control: one attempt');
    assert.strictEqual(deskNotices(events, 'GC-BLENDED').length, 0, 'control: a landed bid raises no desk notice');
  });

  const { gc, wire } = gocomet();
  await gc.login();
  const run = mkEngine(gc, UNROUTABLE);
  const ID = 'GC-PER-TYPE';
  const m = arm(run.eng, ID);
  await drive(run.eng, m, { from: OPEN, to: CLOSE });
  assert.strictEqual(run.codes[0], 'COST_TYPE_UNMATCHED',
    `harness: the first attempt must be refused as COST_TYPE_UNMATCHED by the real adapter, got ${run.codes[0]}`);
  assert.strictEqual(wire.puts.length, 0, 'harness: an unroutable per-type bid can never reach a PUT');
  const notices = deskNotices(run.events, ID);

  await check('2. after the first COST_TYPE_UNMATCHED refusal the load stands down: no further placeBid on it', async () => {
    assert.strictEqual(run.calls.length, 1,
      `the per-type rates cannot be routed on any attempt, yet the load was attempted ${run.calls.length} times `
      + `(${wire.gets} quote reads) between establish and close; it must stand down after the first refusal`);
  });

  await check('3. the desk is told exactly once, and told to bid the load by hand at the price that did not go out', async () => {
    assert.strictEqual(notices.length, 1,
      `a COST_TYPE_UNMATCHED stand-down must raise exactly one desk notice, got ${notices.length}`);
    assert.ok(BY_HAND.test(notices[0].body), 'the notice must tell the desk to bid the load by hand:\n' + notices[0].body);
    assert.ok(!TRY_AGAIN.test(notices[0].body), 'the load has stood down, so "we will try again" is false:\n' + notices[0].body);
    assert.ok(notices[0].body.includes('Rs 41,420'), 'the notice must state the price that did not go out:\n' + notices[0].body);
  });

  await check('4. the close receipt names why nothing was bid', async () => {
    await run.eng._finalize(m, { myRank: null });
    const result = run.events.find((e) => e.type === 'auction_result' && e.auctionId === ID);
    assert.ok(result, 'harness: _finalize must emit an auction_result');
    assert.ok(result.noBidReason, `the close receipt carries no reason: noBidReason ${result.noBidReason}`);
    const n = toNotification(result);
    const body = renderMessage(templateFor(n.kind, n.data), n.data);
    assert.ok(!UNKNOWN_REASON.test(body), `the close receipt falls back to the unnamed reason (${result.noBidReason}):\n` + body);
  });

  if (failures.length) { cleanup(); throw failures[0]; }
  cleanup();
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks - unroutable per-type rates stand the load down with one by-hand notice`);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL - ${failures.length} check(s) failed - a COST_TYPE_UNMATCHED refusal holds the rung and retries silently instead of standing the load down with one by-hand notice\n` + ((e && e.stack) || e));
  process.exit(1);
});
