'use strict';
/**
 * W1-8 F1: A GOCOMET COOLDOWN MUST TELL EVERY PLANT'S GROUP, NOT JUST THE FIRST ONE REFUSED.
 *
 * Regression target: the per-customer cooldown key (engineAlerts.js toNotification, ruling 47) omits
 * the load's origin. A shipper split across origin-scoped groups (the live Waaree case: separate
 * "BRL Bids" groups for the main plant, Samakhiyali and Noida) has one adapter-wide GoComet 429
 * refuse loads at several of those plants at once, and the notifier's dedupe mark for the customer
 * key is written by whichever plant's load is routed first - so every OTHER plant's group hears
 * nothing at all. That is a silent miss on a real, live audience, not a hypothetical one.
 *
 * Owner default, ruling 58: the key includes the load's origin plant. One notice per plant per
 * cooldown - the over-notify side of ruling 47's "one notice per 429 cooldown", never the under-notify
 * side.
 *
 * Chain under test: the REAL GoCometAdapter shared across loads over an injected fetchImpl -> the
 * REAL engine -> notifyEngineEvent -> a real Notifier over a MemoryStore -> a real WhatsAppClient
 * over a capturing transport. Adapted from test-gocomet-cooldown-one-notice-per-customer.js's rig,
 * which must stay green under this fix (it uses one origin and origin-less group scopes).
 *
 *   node scripts/test-gocomet-cooldown-one-notice-per-plant.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `gc-cooldown-plant-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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

const MAIN_GROUP = '120363133333333333@g.us';
const SAMAKHIYALI_GROUP = '120363144444444444@g.us';

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
  // Two groups on the SAME shipper, scoped to different origins of that shipper - the live Waaree
  // shape (main plant group vs the Samakhiyali plant group).
  const recipients = [
    { name: 'Waaree main group', phone: MAIN_GROUP, alerts: ['desk_notice'], scope: { shippers: ['Waaree'], origins: ['Chikhli'] } },
    { name: 'Waaree Samakhiyali group', phone: SAMAKHIYALI_GROUP, alerts: ['desk_notice'], scope: { shippers: ['Waaree'], origins: ['Samakhiyali'] } },
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
    softClose: { enabled: true, shippers: ['Waaree'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
    rand: () => 0.5,
  });

  const rig = { gc, wire, eng, events, codes, sends, routed: 0, monitors: [] };
  rig.arm = (id, origin) => {
    const meta = { id, lane: { origin, destination: 'Jaipur' }, units: 1, equipment: '32ft',
      companyName: 'Waaree Energies', branchName: null, closesAt: Date.now() + 600_000 };
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
  return rig;
}

(async () => {
  const r = mkRig();
  await r.gc.login();
  // One cooldown episode refuses a Chikhli load AND a Samakhiyali load of the SAME shipper.
  const chikhli = r.arm('WAAREE-CHIKHLI-1', 'Chikhli');
  const samakhiyali = r.arm('WAAREE-SAMAKHIYALI-1', 'Samakhiyali');

  for (let i = 0; i < 5; i++) await r.tick([chikhli, samakhiyali]);
  assert.strictEqual(r.wire.throttled, 1,
    `harness: one cooldown must be opened by one 429 on the wire, saw ${r.wire.throttled} throttled GETs`);
  assert.strictEqual(r.wire.puts, 0, 'harness: nothing can reach the wire during the cooldown');
  for (const m of [chikhli, samakhiyali]) {
    assert.ok(r.codes.some((c) => c.id === m.auctionId && c.code === 'RATE_LIMITED'),
      `harness: load ${m.auctionId} must have been refused as RATE_LIMITED in the cooldown`);
  }

  const mainCount = r.bidNotSentTo(MAIN_GROUP).length;
  const samakhiyaliCount = r.bidNotSentTo(SAMAKHIYALI_GROUP).length;

  await check('1. the Chikhli-scoped group hears about the cooldown', async () => {
    assert.strictEqual(mainCount, 1, `the Chikhli group received ${mainCount} bid-not-sent messages, expected 1`);
  });

  await check('2. the Samakhiyali-scoped group ALSO hears about the same cooldown, not just the group whose load routed first', async () => {
    assert.strictEqual(samakhiyaliCount, 1,
      `one shared cooldown across two plants of Waaree left the Samakhiyali group with ${samakhiyaliCount} `
      + 'bid-not-sent message(s), expected 1 - a per-customer key without origin silently drops every '
      + 'plant but the first one routed');
  });

  // CONTROL (ruling 47 kept): two Chikhli loads in one episode still send the main group exactly 1,
  // and a second episode notifies again.
  const chikhli2 = r.arm('WAAREE-CHIKHLI-2', 'Chikhli');
  await r.tick([chikhli2]);
  await check('3. CONTROL: a second Chikhli load in the SAME cooldown does not send the main group a second message', async () => {
    assert.strictEqual(r.bidNotSentTo(MAIN_GROUP).length, mainCount,
      `a second Chikhli load in the same cooldown grew the main group's message count to ${r.bidNotSentTo(MAIN_GROUP).length}, expected it to stay ${mainCount}`);
  });

  clock.t += COOLDOWN_MS + 5_000;
  const chikhli3 = r.arm('WAAREE-CHIKHLI-3', 'Chikhli');
  const throttledBefore = r.wire.throttled;
  for (let i = 0; i < 3; i++) await r.tick([chikhli3]);
  assert.strictEqual(r.wire.throttled, throttledBefore + 1, 'harness: a second, separate cooldown must open on the wire');
  await check('4. CONTROL: a later, separate cooldown notifies the main group again', async () => {
    const after = r.bidNotSentTo(MAIN_GROUP).length;
    assert.strictEqual(after, mainCount + 1, `a later cooldown on the main plant delivered ${after - mainCount} new message(s), expected 1`);
  });

  r.eng.kill('done');
  if (failures.length) { cleanup(); throw failures[0]; }
  cleanup();
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks - a GoComet cooldown notifies every plant's own group`);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL - ${failures.length} check(s) failed - a GoComet cooldown silently drops a plant's own group\n` + ((e && e.stack) || e));
  process.exit(1);
});
