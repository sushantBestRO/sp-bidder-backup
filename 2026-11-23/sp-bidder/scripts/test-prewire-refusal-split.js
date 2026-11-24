'use strict';
/**
 * A REFUSAL THAT WILL REPEAT STANDS THE LOAD DOWN AND HANDS IT TO THE DESK; A TRANSIENT ONE RETRIES.
 *
 * Regression target: the engine's pre-wire arm in the placeBid catch (the arm keyed on an adapter
 * error marked `placed: false`) and the desk notice it raises.
 *
 * THE MECHANISM, in plain words. When an adapter throws before its write request is issued, the
 * engine books nothing and holds the rung. Some of those refusals are transient - a throttle, a
 * quote read that never landed, another writer moving the quote under us - and the next try can
 * land, so the engine retries and the notice says it will try again. Others come back identically
 * on every attempt - GoComet answering with a real, parsed, empty quote list (NO_QUOTE), a partial
 * vehicle count GoComet cannot express, an unreadable quote shape, a belt, a write gate. Retrying
 * those spends the whole auction, the last-chance floor shot included, on a request that cannot
 * succeed, while the desk has been told "we will try again". So after the FIRST such refusal the
 * load stands down: no further placeBid on it for the rest of the auction, and the desk is told to
 * bid this load by hand, with the price that did not go out.
 *
 * What each check pins:
 *   2. an empty quote list is refused once, then the load stands down to close; nothing is booked;
 *      one desk notice says to bid it by hand and states the price.
 *   3. a quote read that never landed keeps retrying, and its one notice says we will try again.
 *   4. a load told "we will try again" that then hits a repeat refusal is still told to bid by
 *      hand - a second notice the notifier will not swallow as a duplicate - and then stops.
 *   5-6. both notice variants stay inside the desk copy rules.
 *
 * WHAT MUST NOT MOVE: check 1 (the harness puts a real PUT on the wire on a healthy transport and
 * raises no notice) and check 3 (the transient retry). A silent stand-down - the load quietly stops
 * while the desk was only ever told "we will try again" - is the dangerous direction: nobody bids
 * a load the desk believes is still being bid.
 *
 * Offline and deterministic: the REAL GoComet adapter over an injected counting fetchImpl, the REAL
 * engine over a temp-file DurableScheduler, a virtual clock, a fixed jitter source, no sleeps, no
 * network.
 *
 *   node scripts/test-prewire-refusal-split.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `prewire-split-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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
const OPEN = 126_739;
const CLOSE = 0;

// `mode.get`: 'ok' serves a real quote, 'throw' fails the quote GET before any request lands
// (NETWORK), 'empty' answers HTTP 200 with a parsed empty list (NO_QUOTE).
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
      if (mode.get === 'empty') return httpResponse(200, []);
      return httpResponse(200, [quoteDoc()]);
    } });
  return { gc, wire };
}

// `codes` records what each attempt threw, so the harness proves which refusal the engine saw.
function mkEngine(placeBid) {
  const events = [];
  const calls = [];
  const codes = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      calls.push(price);
      try { return await placeBid(id, price, opts); } catch (e) { codes.push(e && e.code); throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });
  return { eng, events, calls, codes };
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

// Every alert on the load that reaches the desk, whatever the engine names it.
const deskNotices = (events, id) => events
  .filter((e) => e.type === 'alert' && e.auctionId === id)
  .map((evt) => {
    const n = toNotification(evt);
    return n && n.kind === 'desk_notice' ? { evt, n, body: renderMessage(templateFor(n.kind, n.data), n.data) } : null;
  })
  .filter(Boolean);

const BY_HAND = /by hand/i;
const TRY_AGAIN = /try again/i;
const BANNED = [/\u2014/, /\bband\b/i, /\bfloor\b/i, /your lowest price/i, /\bbot\b/i, /\bticks?\b/i, /\bmonitor/i];
const copyViolations = (body) => BANNED.filter((re) => re.test(body)).map(String);

(async () => {
  // ----------------------------------------------- 1. CONTROL: a healthy transport places the bid
  await check('CONTROL: a healthy GoComet transport puts the establish price on the wire and raises no notice', async () => {
    const { gc, wire } = gocomet({ get: 'ok' });
    await gc.login();
    const { eng, events } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-OK');
    await drive(eng, m, { from: OPEN, to: 60_000, stopWhen: () => wire.puts.length >= 1 });
    assert.deepStrictEqual(wire.puts, [LADDER[0]],
      'control: on a healthy transport the same drive must put the establish price on the wire once');
    assert.strictEqual(m.landedBids, 1, 'control: the landed establish bid is booked');
    assert.strictEqual(deskNotices(events, 'GC-OK').length, 0, 'control: a bid that reached the portal raises no desk notice');
  });

  // ----------------------------------------------- 2. repeat refusal: stand down, hand to the desk
  let standDownBody = null;
  await check('an empty GoComet quote list is refused once, the load stands down to close, and the desk is told to bid it by hand', async () => {
    const { gc, wire } = gocomet({ get: 'empty' });
    await gc.login();
    const { eng, events, calls, codes } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-EMPTY');
    await drive(eng, m, { from: OPEN, to: CLOSE });
    assert.strictEqual(codes[0], 'NO_QUOTE', `harness: the first attempt must be refused as NO_QUOTE, got ${codes[0]}`);
    assert.strictEqual(wire.puts.length, 0, 'harness: an empty quote list can never reach a PUT');
    const notices = deskNotices(events, 'GC-EMPTY');
    if (notices.length) standDownBody = notices[0].body;
    assert.strictEqual(calls.length, 1,
      `an empty quote list comes back on every read, yet the load was attempted ${calls.length} times `
      + `(${wire.gets} quote reads) between establish and close; it must stand down after the first refusal`);
    assert.strictEqual(wire.gets, 1, `one attempt must cost one quote read, got ${wire.gets}`);
    assert.strictEqual(m.landedBids, 0, 'a refusal before the wire books nothing');
    assert.strictEqual(m.revisionsLeft, 30, `a refusal before the wire spends no revision, left ${m.revisionsLeft}`);
    assert.strictEqual(notices.length, 1, `the desk must be told exactly once, got ${notices.length} desk notices`);
    assert.ok(BY_HAND.test(notices[0].body),
      'the load will not be bid again, so the notice must tell the desk to bid it by hand:\n' + notices[0].body);
    assert.ok(!TRY_AGAIN.test(notices[0].body),
      'the load has stood down, so "we will try again" is false:\n' + notices[0].body);
    assert.ok(notices[0].body.includes('Rs 41,420'), 'the notice must state the price that did not go out:\n' + notices[0].body);
  });

  // ----------------------------------------------- 3. transient refusal: keep retrying
  let retryBody = null;
  await check('a quote read that never landed keeps retrying, and its one notice says we will try again', async () => {
    const { gc, wire } = gocomet({ get: 'throw' });
    await gc.login();
    const { eng, events, calls, codes } = mkEngine((i, p, o) => gc.placeBid(i, p, o));
    const m = arm(eng, 'GC-NET');
    await drive(eng, m, { from: OPEN, to: CLOSE });
    assert.ok(codes.length > 0 && codes.every((c) => c === 'NETWORK'),
      `harness: every attempt must be refused as NETWORK, got ${[...new Set(codes)].join(',')}`);
    assert.strictEqual(wire.puts.length, 0, 'harness: the quote read failed, so no PUT can have gone out');
    assert.ok(calls.length >= 2,
      `a transient refusal must be retried; ${calls.length} attempt(s) means the load stood down on a network blip`);
    const notices = deskNotices(events, 'GC-NET');
    assert.strictEqual(notices.length, 1, `the desk must be told exactly once, got ${notices.length} desk notices`);
    retryBody = notices[0].body;
    assert.ok(TRY_AGAIN.test(retryBody), 'the load is still being bid, so the notice says we will try again:\n' + retryBody);
    assert.ok(!BY_HAND.test(retryBody), 'the load is still being bid, so the desk must not be sent to bid it by hand:\n' + retryBody);
  });

  // ----------------------------------------------- 4. try-again notice first: the by-hand one still lands
  await check('a load already told "we will try again" that then hits an empty quote list is told to bid by hand and stops', async () => {
    const mode = { get: 'throw' };
    const { gc, wire } = gocomet(mode);
    await gc.login();
    let attempts = 0;
    const { eng, events, calls, codes } = mkEngine(async (i, p, o) => {
      try { return await gc.placeBid(i, p, o); } finally { if (++attempts === 1) mode.get = 'empty'; }
    });
    const m = arm(eng, 'GC-FLIP');
    await drive(eng, m, { from: OPEN, to: CLOSE });
    assert.deepStrictEqual(codes.slice(0, 2), ['NETWORK', 'NO_QUOTE'],
      `harness: the first attempt must fail transiently and the second hit the empty list, got ${codes.slice(0, 2).join(',')}`);
    assert.strictEqual(wire.puts.length, 0, 'harness: no PUT can have gone out');
    const notices = deskNotices(events, 'GC-FLIP');
    const byHand = notices.filter((x) => BY_HAND.test(x.body));
    assert.strictEqual(byHand.length, 1,
      `the load stopped being bidable after the empty quote list, yet ${byHand.length} of ${notices.length} desk `
      + 'notices tell the desk to bid it by hand; the desk was only ever told "we will try again"');
    const tryAgain = notices.filter((x) => TRY_AGAIN.test(x.body));
    assert.strictEqual(tryAgain.length, 1, `the first, transient refusal raised one try-again notice, got ${tryAgain.length}`);
    assert.notStrictEqual(byHand[0].n.dedupeKey, tryAgain[0].n.dedupeKey,
      `both notices carry dedupeKey ${byHand[0].n.dedupeKey}, so the notifier would drop the by-hand one as a duplicate`);
    assert.strictEqual(calls.length, 2,
      `the load must stop at the empty quote list, but it was attempted ${calls.length} times in total`);
  });

  // ----------------------------------------------- 5-6. copy rules on both variants
  await check('the try-again notice stays inside the desk copy rules', async () => {
    assert.ok(retryBody, 'this check renders the notice raised in check 3, and there was none');
    assert.deepStrictEqual(copyViolations(retryBody), [], 'the try-again notice breaks the copy rules:\n' + retryBody);
  });
  await check('the by-hand notice stays inside the desk copy rules', async () => {
    assert.ok(standDownBody, 'this check renders the notice raised in check 2, and there was none');
    assert.ok(BY_HAND.test(standDownBody) && !TRY_AGAIN.test(standDownBody),
      'the stand-down notice must be the by-hand variant, not the try-again one:\n' + standDownBody);
    assert.deepStrictEqual(copyViolations(standDownBody), [], 'the by-hand notice breaks the copy rules:\n' + standDownBody);
  });

  if (failures.length) throw failures[0];
  cleanup();
  const EXPECTED = 6;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - a repeat pre-wire refusal stands the load down and hands it to the desk, a transient one retries`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - a pre-wire refusal that repeats on every attempt keeps retrying instead of standing the load down and telling the desk to bid it by hand\n' + ((e && e.stack) || e));
  process.exit(1);
});
