'use strict';
// The close-unknown hold, as the desk meets it: the hold text never calls the system a bot; a
// freshly priced load with no close yet is NOT held at price time but keeps its wake and its
// platform re-read, and is held only if that read still gives no close; a held load leaves the
// console's scheduled list until a re-price with a real close brings it back; and a stranded load
// whose retire cannot be written raises its own desk alert instead of only a log line.
process.env.PLATFORM = process.env.PLATFORM || 'mock';
process.env.STORE_BACKEND = process.env.STORE_BACKEND || 'memory';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

const T0 = Date.now();
const EXPECTED = 9;
const BANNED = /\bbots?\b/i;
let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok    ' + name); } catch (e) {
    fail += 1; console.log('  FAIL  ' + name + ' :: ' + (e && e.message ? e.message : String(e)));
  }
};

const TMP = path.join(os.tmpdir(), `close-unknown-hold-desk-${process.pid}-${T0}`);
fs.mkdirSync(TMP, { recursive: true });
let seq = 0;
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill('done'); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

const CAPS = { standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' };

function mkEngine({ intents = [], dir = null, state = { ok: false, error: 'harness: no platform read' },
  config = {}, writeEnabled = false } = {}) {
  const d = dir || path.join(TMP, 'd' + (seq++));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'intents.json');
  if (intents.length) fs.writeFileSync(file, JSON.stringify({ savedAt: T0, intents }), 'utf8');
  const events = [];
  const logs = [];
  const logAt = (level) => (m, f) => logs.push({ level, m, f: f || {} });
  const log = { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') };
  const adapter = {
    writeEnabled,
    capabilities: () => CAPS,
    ensureSession: async () => ({}),
    getAuctionState: async () => (typeof state === 'function' ? state() : state),
    placeBid: async () => { throw new Error('placeBid reached - nothing in this file may bid'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config, onEvent: (e) => events.push(e), log, rand: () => 0.5,
  });
  eng.log = log;
  eng._events = events;
  ENGINES.push(eng);
  return eng;
}

const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };
const meta = (id, startsAt, closesAt) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', startsAt, closesAt,
});
const alertsOf = (eng, id, kind) => eng._events.filter((e) => e.type === 'alert' && e.auctionId === id
  && (!kind || e.kind === kind));
const inSnapshot = (eng, id) => eng.scheduledSnapshot().some((r) => r.auctionId === id);
const describe = (eng, id) => {
  const r = eng.scheduler.get(id) || {};
  return `status=${JSON.stringify(r.status)} listed=${inSnapshot(eng, id)} armed=${eng.monitors.has(id)}`
    + ` timer=${eng.scheduledTimers.has(id)} alerts=${JSON.stringify(alertsOf(eng, id).map((a) => a.kind))}`;
};
const deskText = (evt) => {
  const n = toNotification(evt);
  assert.ok(n && n.kind === 'error', `${evt.kind} does not route to the error channel`);
  assert.strictEqual(n.data.auctionId, evt.auctionId, `${evt.kind} lost its auctionId on the way to the desk`);
  return String(n.data.detail || '');
};

(async () => {
  // A restored intent with no close on record: the rehydrate door holds it.
  const R = mkEngine({ intents: [{
    auctionId: 'RESTORED-NOCLOSE', status: 'bidding', lane: { origin: 'Bhiwandi', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, companyName: 'Havells India', branchName: 'Alwar',
    rules: { minDecrement: 100, revisionLimit: 3, pricingMode: 'flat', rateType: 'per_truck' },
    cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5, firedRungs: [], landedBids: 0,
    finalRank: null, won: null, createdAt: T0 - 3_600_000, startsAt: T0 - 1_800_000,
  }] });
  R.rehydrate();
  await settle();

  // Freshly priced, opens in an hour, no close known yet.
  const F = mkEngine();
  F.schedule(meta('FRESH-LATER', Date.now() + 3_600_000, null), INPUTS);
  await settle();

  // Freshly priced, already open, no close in the snapshot - the platform read supplies one.
  const liveClose = Date.now() + 3_600_000;
  const L = mkEngine({ state: () => ({ ok: true, status: 'live', closesInMs: liveClose - Date.now(), closesAtMs: liveClose }),
    config: { armLeadMs: 0 } });
  L.schedule(meta('FRESH-LIVE', Date.now() - 1000, null), INPUTS);
  await settle();

  // Freshly priced, already open, no close anywhere - the read fails too.
  const N = mkEngine({ config: { armLeadMs: 0 } });
  N.schedule(meta('FRESH-NOREAD', Date.now() - 1000, null), INPUTS);
  await settle();
  const noreadHeldInSnapshot = inSnapshot(N, 'FRESH-NOREAD');
  const noreadAfterHold = describe(N, 'FRESH-NOREAD');
  const noreadActive = N.scheduler.activeIntents().some((i) => i.auctionId === 'FRESH-NOREAD');
  // The desk re-prices it once a real close is known.
  N.schedule(meta('FRESH-NOREAD', Date.now() + 3_600_000, Date.now() + 7_200_000), INPUTS);
  await settle();

  // Kill/resume is a restore door: a stored close that is missing is held there even when the
  // platform read would now supply one, exactly as rehydrate() holds without reading.
  const K = mkEngine({ state: () => ({ ok: true, status: 'live', closesInMs: liveClose - Date.now(), closesAtMs: liveClose }),
    config: { armLeadMs: 0 } });
  K.kill('test');
  K.schedule(meta('RESUME-NOCLOSE', Date.now() - 1000, null), INPUTS);
  K.resume();
  await settle();

  // A load held at kill/resume whose record later carries a plausible close (not via a re-price):
  // the next restore door plans its wake, and the console must list it again.
  const U = mkEngine({ config: { armLeadMs: 0 } });
  U.kill('test');
  U.schedule(meta('UNHOLD', Date.now() + 3_600_000, null), INPUTS);
  U.resume();
  await settle();
  const unholdListedWhileHeld = inSnapshot(U, 'UNHOLD');
  Object.assign(U.scheduler.get('UNHOLD'), { closesAt: Date.now() + 7_200_000 });
  U.kill('test');
  U.resume();
  await settle();

  // A hold taken while every durable write fails: the data dir becomes a file before rehydrate().
  const hDir = path.join(TMP, 'hold-broken');
  const H = mkEngine({ dir: hDir, intents: [{
    auctionId: 'HOLD-BROKEN', status: 'scheduled', lane: { origin: 'Bhiwandi', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, companyName: 'Havells India', branchName: 'Alwar',
    rules: { minDecrement: 100, revisionLimit: 3, pricingMode: 'flat', rateType: 'per_truck' },
    cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5, firedRungs: [], landedBids: 0,
    finalRank: null, won: null, createdAt: T0 - 3_600_000, startsAt: Date.now() + 3_600_000,
  }] });
  fs.rmSync(hDir, { recursive: true, force: true });
  fs.writeFileSync(hDir, 'the data dir is now a file - every durable write fails');
  H.rehydrate();
  await settle();

  // A stranded wake whose retire cannot be written: the data dir becomes a file.
  const bDir = path.join(TMP, 'broken');
  const B = mkEngine({ dir: bDir, state: { ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 1000 },
    config: { armLeadMs: 0 }, writeEnabled: true });
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  try {
    B.schedule(meta('W-BROKEN', Date.now() - 1000, Date.now() + 3_600_000), INPUTS);
    fs.rmSync(bDir, { recursive: true, force: true });
    fs.writeFileSync(bDir, 'the data dir is now a file - every durable write fails');
    await settle();
    await settle();
  } finally {
    process.removeListener('unhandledRejection', onRej);
  }

  check('the hold alert reaches the desk without calling the system a bot', () => {
    const held = alertsOf(R, 'RESTORED-NOCLOSE', 'close_unknown_held');
    assert.strictEqual(held.length, 1, `expected one close_unknown_held - ${describe(R, 'RESTORED-NOCLOSE')}`);
    const text = deskText(held[0]);
    assert.ok(text.trim().length > 0, 'hold alert has no text');
    assert.ok(!BANNED.test(text), `hold alert text says "bot": ${JSON.stringify(text)}`);
  });

  check('a freshly priced load with no close yet keeps its wake and is not held at price time', () => {
    assert.ok(F.scheduledTimers.has('FRESH-LATER'), `no wake planned - ${describe(F, 'FRESH-LATER')}`);
    assert.strictEqual(alertsOf(F, 'FRESH-LATER', 'close_unknown_held').length, 0,
      `held at price time, before the platform was read - ${describe(F, 'FRESH-LATER')}`);
    assert.ok(inSnapshot(F, 'FRESH-LATER'), 'a pending wake must still show on the scheduled list');
  });

  check('at the wake, a close supplied by the platform read arms the load', () => {
    assert.ok(L.monitors.has('FRESH-LIVE'), `not armed on the live close - ${describe(L, 'FRESH-LIVE')}`);
    assert.strictEqual(alertsOf(L, 'FRESH-LIVE', 'close_unknown_held').length, 0,
      `held although the platform gave a close - ${describe(L, 'FRESH-LIVE')}`);
  });

  check('at the wake, no close from the read either: held, active, and off the scheduled list', () => {
    assert.ok(!/armed=true/.test(noreadAfterHold), `armed with no close - ${noreadAfterHold}`);
    assert.ok(/"close_unknown_held"/.test(noreadAfterHold), `no hold alert - ${noreadAfterHold}`);
    assert.ok(noreadActive, 'a held load must stay active for a re-price to pick up');
    assert.ok(!noreadHeldInSnapshot, 'a held load is still listed as a scheduled wake that will fire');
  });

  check('a re-price with a real close lifts the hold and the load is listed again', () => {
    const r = N.scheduler.get('FRESH-NOREAD') || {};
    assert.strictEqual(r.status, 'scheduled', `re-priced load - ${describe(N, 'FRESH-NOREAD')}`);
    assert.ok(inSnapshot(N, 'FRESH-NOREAD'), `re-priced load missing from the scheduled list - ${describe(N, 'FRESH-NOREAD')}`);
  });

  check('kill/resume holds a scheduled load with no stored close, even when the platform has one', () => {
    assert.ok(!K.monitors.has('RESUME-NOCLOSE'), `armed through the resume door - ${describe(K, 'RESUME-NOCLOSE')}`);
    assert.strictEqual(alertsOf(K, 'RESUME-NOCLOSE', 'close_unknown_held').length, 1,
      `no hold alert at the resume door - ${describe(K, 'RESUME-NOCLOSE')}`);
  });

  check('a restore door that no longer holds a load lists it again', () => {
    assert.ok(!unholdListedWhileHeld, 'precondition: the held load must be off the scheduled list');
    assert.strictEqual(alertsOf(U, 'UNHOLD', 'close_unknown_held').length, 1, `precondition - ${describe(U, 'UNHOLD')}`);
    assert.ok(U.scheduledTimers.has('UNHOLD'), `no wake planned once the close became plausible - ${describe(U, 'UNHOLD')}`);
    assert.ok(inSnapshot(U, 'UNHOLD'), `a load with a planned wake is hidden from the scheduled list - ${describe(U, 'UNHOLD')}`);
  });

  check('a hold taken while durable writes fail still keeps the load off the scheduled list', () => {
    assert.strictEqual(alertsOf(H, 'HOLD-BROKEN', 'close_unknown_held').length, 1, `precondition - ${describe(H, 'HOLD-BROKEN')}`);
    assert.ok(!inSnapshot(H, 'HOLD-BROKEN'), `held load listed as a wake that will fire - ${describe(H, 'HOLD-BROKEN')}`);
  });

  check('a stranded load whose retire cannot be written raises its own desk alert', () => {
    assert.strictEqual(rejections.length, 0, `an unhandled rejection escaped: ${String(rejections[0])}`);
    assert.strictEqual(alertsOf(B, 'W-BROKEN', 'wake_arm_failed').length, 1, `precondition - ${describe(B, 'W-BROKEN')}`);
    const f = alertsOf(B, 'W-BROKEN', 'wake_retire_failed');
    assert.strictEqual(f.length, 1, `no desk alert for the failed retire - ${describe(B, 'W-BROKEN')}`);
    const text = deskText(f[0]);
    assert.ok(text.trim().length > 0 && !BANNED.test(text), `bad desk text: ${JSON.stringify(text)}`);
  });

  cleanup();
  if (pass + fail !== EXPECTED) {
    fail += 1;
    console.log(`  FAIL  ran ${pass + fail - 1} checks, expected ${EXPECTED}`);
  }
  console.log(`\n${pass}/${EXPECTED} checks passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => {
  cleanup();
  console.error(e);
  process.exitCode = 1;
});
