'use strict';
/**
 * ONE GOCOMET RATE-LIMIT COOLDOWN TELLS EACH CUSTOMER'S DESK ONCE, NOT ONCE PER LOAD.
 *
 * Regression target: the bid_not_sent notice raised by the engine's pre-wire retry arm, as keyed by
 * engineAlerts.toNotification (`<auctionId>_notice_bid_not_sent`) and delivered by the Notifier.
 * A GoComet 429 opens one adapter-wide cooldown; every quote read in it is refused locally as
 * RATE_LIMITED with placed:false. Each affected load raises its own bid_not_sent and each key is
 * per load, so one cooldown across N loads of a customer sends N "Bid not sent" messages to that
 * customer's group. Ruling 47: one notice per 429 cooldown.
 *
 * Built to the default returned to the owner as a question: while one cooldown episode is in force,
 * the loads of one customer produce ONE bid_not_sent message to that customer's group; a later,
 * separate cooldown episode may notify again; another customer's load in the same cooldown still
 * gets its own message.
 *
 * Chain under test: the REAL GoCometAdapter shared by every load (one adapter per stack, as in
 * production) over an injected fetchImpl -> the REAL engine -> notifyEngineEvent -> a real Notifier
 * over a MemoryStore -> a real WhatsAppClient over a capturing transport.
 *
 * Controls: the other customer's notice in the same cooldown (check 2) and the notice in a second
 * cooldown episode (check 3) both pass on the base and must keep passing.
 *
 *   node scripts/test-gocomet-cooldown-one-notice-per-customer.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

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
const tmp = () => { const f = path.join(os.tmpdir(), `gc-cooldown-notice-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const OPEN = 126_739;
const COOLDOWN_MS = 60_000;

const WAAREE_GROUP = '120363111111111111@g.us';
const BOROSIL_GROUP = '120363222222222222@g.us';

function mkRig() {
  const wire = { gets: 0, throttled: 0, puts: 0 };
  const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {}, log: silentLog,
    now: () => Date.now(), rateLimitBackoffMs: COOLDOWN_MS,
    fetchImpl: async (url, init) => {
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'PUT') { wire.puts += 1; return httpResponse(200, { data: { quote_rank: 4 } }); }
      wire.gets += 1;
      wire.throttled += 1;
      return httpResponse(429, { error: 'Too Many Requests' });
    } });

  const sends = [];
  const transport = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const recipients = [
    { name: 'Waaree group', phone: WAAREE_GROUP, alerts: ['desk_notice'], scope: { shippers: ['Waaree'] } },
    { name: 'Borosil group', phone: BOROSIL_GROUP, alerts: ['desk_notice'], scope: { shippers: ['Borosil'] } },
  ];
  const notifier = new Notifier({ mode: 'whatsapp', platformModes: { gocomet: 'whatsapp' }, baseUrl: 'http://h',
    log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients,
    healthProvider: async () => true });

  const events = [];
  const codes = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (id, price, opts) => {
      try { return await gc.placeBid(id, price, opts); } catch (e) { codes.push({ id, code: e && e.code }); throw e; }
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Waaree', 'Borosil'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });

  const rig = { gc, wire, eng, events, codes, sends, routed: 0, monitors: [] };
  rig.arm = (id, companyName) => {
    const meta = { id, lane: { origin: 'Chikhli', destination: 'Jaipur' }, units: 1, equipment: '32ft',
      companyName, branchName: null, closesAt: Date.now() + 600_000 };
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
    m._remaining = OPEN;
    rig.monitors.push(m);
    return m;
  };
  rig.route = async () => {
    while (rig.routed < events.length) await notifyEngineEvent(notifier, events[rig.routed++], null, null, 'gocomet');
  };
  // One pass over the given monitors at their own countdowns, then the clock moves on by `stepMs`.
  rig.tick = async (monitors, stepMs = 1_000) => {
    for (const m of monitors) {
      await eng._maybeBid(m, { closesInMs: m._remaining, myRank: 4, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
    }
    await rig.route();
    for (const m of monitors) m._remaining -= stepMs;
    clock.t += stepMs;
  };
  rig.bidNotSentTo = (group) => sends.filter((s) => String(s.to_number) === group
    && /did not reach the portal/.test(String(s.message || '')));
  rig.bidNotSentEvents = (ids) => events.filter((e) => e.type === 'alert' && e.kind === 'bid_not_sent' && ids.includes(e.auctionId));
  return rig;
}

(async () => {
  const r = mkRig();
  await r.gc.login();
  const w1 = r.arm('WAAREE-1', 'Waaree Energies');
  const w2 = r.arm('WAAREE-2', 'Waaree Energies');
  const w3 = r.arm('WAAREE-3', 'Waaree Energies');
  const b1 = r.arm('BOROSIL-1', 'Borosil Renewables');

  for (let i = 0; i < 5; i++) await r.tick([w1, w2, w3, b1]);
  assert.strictEqual(r.wire.throttled, 1,
    `harness: episode 1 must be ONE cooldown opened by one 429 on the wire, saw ${r.wire.throttled} throttled GETs`);
  assert.strictEqual(r.wire.puts, 0, 'harness: nothing can reach the wire during the cooldown');
  assert.ok(r.codes.length >= 4 && r.codes.every((c) => c.code === 'RATE_LIMITED'),
    `harness: every attempt in the cooldown must be refused as RATE_LIMITED, got ${[...new Set(r.codes.map((c) => c.code))].join(',')}`);
  for (const m of [w1, w2, w3, b1]) {
    assert.ok(r.codes.some((c) => c.id === m.auctionId), `harness: load ${m.auctionId} must have attempted a bid in the cooldown`);
  }
  const waareeEp1 = r.bidNotSentTo(WAAREE_GROUP).length;
  const borosilEp1 = r.bidNotSentTo(BOROSIL_GROUP).length;

  await check('1. three Waaree loads refused in one GoComet cooldown send ONE bid-not-sent message to the Waaree group', async () => {
    assert.strictEqual(waareeEp1, 1,
      `one rate-limit cooldown across 3 Waaree loads delivered ${waareeEp1} bid-not-sent messages to the Waaree group `
      + `(${r.bidNotSentEvents(['WAAREE-1', 'WAAREE-2', 'WAAREE-3']).length} engine events); ruling 47 is one notice per cooldown`);
  });

  await check('2. CONTROL: a Borosil load in the same cooldown still gets its own message in the Borosil group', async () => {
    assert.strictEqual(borosilEp1, 1,
      `the other customer's load in the same cooldown delivered ${borosilEp1} messages to its own group, expected 1`);
  });

  clock.t += COOLDOWN_MS + 5_000;
  const w4 = r.arm('WAAREE-4', 'Waaree Energies');
  const throttledBefore = r.wire.throttled;
  for (let i = 0; i < 3; i++) await r.tick([w4]);
  assert.strictEqual(r.wire.throttled, throttledBefore + 1,
    `harness: episode 2 must be one fresh 429 on the wire after the first cooldown ended, saw ${r.wire.throttled - throttledBefore}`);
  assert.ok(r.codes.some((c) => c.id === 'WAAREE-4' && c.code === 'RATE_LIMITED'), 'harness: the episode-2 load must be refused as RATE_LIMITED');

  await check('3. CONTROL: a later, separate cooldown notifies the Waaree group again', async () => {
    const ep2 = r.bidNotSentTo(WAAREE_GROUP).length - waareeEp1;
    assert.strictEqual(ep2, 1,
      `a Waaree load refused in a second, separate cooldown delivered ${ep2} messages to the Waaree group, expected 1`);
  });

  r.eng.kill('done');
  if (failures.length) { cleanup(); throw failures[0]; }
  cleanup();
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks - one GoComet rate-limit cooldown sends one bid-not-sent message per customer`);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL - ${failures.length} check(s) failed - one GoComet rate-limit cooldown sends a bid-not-sent message per load instead of one per customer\n` + ((e && e.stack) || e));
  process.exit(1);
});
