'use strict';
/**
 * A GOCOMET SERVER ERROR ON THE QUOTE READ IS A BLIP TO RETRY, NOT A LOAD TO HAND TO THE DESK.
 *
 * Regression target: W1-8 V1-F01. GoCometAdapter._fetchQuoteForWrite (both quote reads in placeBid)
 * sorts out 401/403, 429/503, status 0 and 304, then parses whatever else came back. A 500 with a
 * JSON error body, a 502, a 504, a 404, a 200 whose body is not JSON and a 200 whose JSON is not a
 * quote list all parse to "no quote list" and are thrown as NO_QUOTE with placed:false. NO_QUOTE is
 * outside the engine's pre-wire retry set, so one server blip stands the load down for the rest of
 * the auction and tells the desk to bid it by hand. Ruling 47: non-2xx, unparseable or 304 quote
 * reads retry at the held rung. NO_QUOTE keeps meaning only a 2xx whose parsed list holds no quote.
 *
 * Each variant serves the bad answer on one quote read and a real quote on every read after it.
 * The contract: no by-hand notice and no stand-down; the refused attempt sends no PUT; a later
 * attempt puts the held establish price on the wire.
 *
 * Controls: a healthy transport bids at once; a quote read that never landed (already a retry
 * code) recovers and bids, which is the shape every variant must take; a 200 with a real parsed
 * empty list still stands the load down with the by-hand notice; a 304 already retries (positive
 * pin, passes on the base).
 *
 *   node scripts/test-gocomet-quote-read-server-error-retries.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `gc-quote-read-5xx-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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
const OPEN = 126_739;

// `bad` answers quote read number `badAt` (1-based, counted across the whole load); every other
// quote read gets a real quote. `bad` is either a response or the string 'throw' (transport error).
function gocomet({ bad, badAt = 1 }) {
  const wire = { gets: 0, puts: [], served: [] };
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
      if (bad && wire.gets === badAt) {
        wire.served.push('bad');
        if (bad === 'throw') throw new Error('ECONNRESET');
        return bad;
      }
      wire.served.push('ok');
      return httpResponse(200, [quoteDoc()]);
    } });
  return { gc, wire };
}

function mkEngine(gc, wire) {
  const events = [];
  const attempts = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      const a = { price, putsBefore: wire.puts.length, code: null };
      attempts.push(a);
      try { return await gc.placeBid(id, price, opts); } catch (e) { a.code = (e && e.code) || null; throw e; } finally { a.putsAfter = wire.puts.length; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Waaree'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });
  return { eng, events, attempts };
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

// One load whose quote read number `badAt` gets `bad`, driven from the establish until a PUT lands
// or 60 s before close.
async function runLoad(id, bad, badAt = 1) {
  const { gc, wire } = gocomet({ bad, badAt });
  await gc.login();
  const { eng, events, attempts } = mkEngine(gc, wire);
  const m = arm(eng, id);
  await drive(eng, m, { from: OPEN, to: 60_000, stopWhen: () => wire.puts.length >= 1 });
  const notices = deskNotices(events, id);
  return { m, wire, attempts, notices, byHand: notices.filter((x) => BY_HAND.test(x.body)) };
}

function harness(r, label, badAt = 1) {
  assert.ok(r.wire.served[badAt - 1] === 'bad',
    `harness: quote read ${badAt} must be served the ${label}, served ${JSON.stringify(r.wire.served)}`);
  assert.ok(r.attempts.length >= 1 && r.attempts[0].code != null,
    `harness: the first attempt must be refused before the wire on the ${label}, codes ${JSON.stringify(r.attempts.map((a) => a.code))}`);
}

// The retry contract, asserted in the order the base breaks it: the by-hand hand-off first.
function assertRetried(r, label) {
  const code = r.attempts[0].code;
  assert.strictEqual(r.byHand.length, 0,
    `a ${label} on the quote read was treated as a refusal that repeats (code ${code}): the load was stood down `
    + `and the desk told to bid it by hand, after ${r.attempts.length} attempt(s). It must retry at the held price`);
  assert.strictEqual(r.m.prewireStoodDown, false, `a ${label} on the quote read must not stand the load down (code ${code})`);
  assert.strictEqual(r.attempts[0].putsAfter, r.attempts[0].putsBefore,
    `the attempt refused on the ${label} must send no PUT`);
  assert.ok(r.attempts.length >= 2, `a ${label} must be retried; the load was attempted ${r.attempts.length} time(s)`);
  assert.deepStrictEqual(r.wire.puts, [LADDER[0]],
    `once the quote read recovers, the held establish price ${LADDER[0]} must reach the wire; puts ${JSON.stringify(r.wire.puts)}`);
  assert.strictEqual(r.m.landedBids, 1, 'the recovered bid is booked once');
}

const VARIANTS = [
  ['500 with a JSON error body', httpResponse(500, { error: 'Internal Server Error', status: 500 })],
  ['502 Bad Gateway', httpResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
  ['504 Gateway Timeout', httpResponse(504, '<html><body><h1>504 Gateway Time-out</h1></body></html>')],
  ['404 with a JSON error body', httpResponse(404, { error: 'Not Found', status: 404 })],
  ['200 whose body is not JSON', httpResponse(200, '<html><body>Service temporarily unavailable</body></html>')],
  ['200 whose JSON is not a quote list', httpResponse(200, { message: 'Something went wrong', success: false })],
];

(async () => {
  await check('1. CONTROL: a healthy quote read puts the establish price on the wire at the first attempt', async () => {
    const r = await runLoad('GC-HEALTHY', null);
    assert.deepStrictEqual(r.wire.puts, [LADDER[0]], `control: expected one PUT at ${LADDER[0]}, got ${JSON.stringify(r.wire.puts)}`);
    assert.strictEqual(r.attempts.length, 1, 'control: one attempt');
    assert.strictEqual(r.notices.length, 0, 'control: a landed bid raises no desk notice');
  });

  await check('2. CONTROL: a quote read that never landed recovers and bids the held price (the shape every variant below must take)', async () => {
    const r = await runLoad('GC-NET-RECOVERS', 'throw');
    harness(r, 'transport error');
    assert.strictEqual(r.attempts[0].code, 'NETWORK', `control: the transport error is refused as NETWORK, got ${r.attempts[0].code}`);
    assertRetried(r, 'transport error');
  });

  await check('3. CONTROL: a 200 with a real parsed empty list is still NO_QUOTE and stands the load down with the by-hand notice', async () => {
    const r = await runLoad('GC-EMPTY', httpResponse(200, []));
    harness(r, 'empty list');
    assert.strictEqual(r.attempts[0].code, 'NO_QUOTE', `control: an empty list is NO_QUOTE, got ${r.attempts[0].code}`);
    assert.strictEqual(r.attempts.length, 1, `control: the empty list stands the load down after one attempt, got ${r.attempts.length}`);
    assert.strictEqual(r.wire.puts.length, 0, 'control: nothing reaches the wire');
    assert.strictEqual(r.byHand.length, 1, `control: exactly one by-hand notice, got ${r.byHand.length}`);
  });

  await check('4. POSITIVE PIN: a 304 on the quote read retries at the held price and reaches the wire', async () => {
    const r = await runLoad('GC-304', httpResponse(304, ''));
    harness(r, '304');
    assertRetried(r, '304');
  });

  let n = 5;
  for (const [label, resp] of VARIANTS) {
    const id = `GC-V${n}`;
    await check(`${n}. a ${label} on the first quote read retries at the held price, with no stand-down and no by-hand notice`, async () => {
      const r = await runLoad(id, resp);
      harness(r, label);
      assertRetried(r, label);
    });
    n++;
  }

  await check(`${n}. a 502 on the confirming quote read retries at the held price, with no stand-down and no by-hand notice`, async () => {
    const r = await runLoad('GC-CONFIRM-502', httpResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>'), 2);
    harness(r, '502 (confirming read)', 2);
    assert.strictEqual(r.wire.served[0], 'ok', 'harness: the first quote read of the attempt is healthy');
    assertRetried(r, '502 (confirming read)');
  });
  n++;

  if (failures.length) { cleanup(); throw failures[0]; }
  cleanup();
  const EXPECTED = n - 1;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks - a server error on a GoComet quote read retries at the held price`);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL - ${failures.length} check(s) failed - a server error or unparseable answer on a GoComet quote read is classified NO_QUOTE and stands the load down instead of retrying\n` + ((e && e.stack) || e));
  process.exit(1);
});
