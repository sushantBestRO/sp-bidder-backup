'use strict';
// Pins the edges of the restore-path repairs the four per-defect tests leave loose: a held or
// in-grace load stays ACTIVE (not parked at 'stopped'), the hold alert routes to the error channel,
// the zero / negative / just-past-30-day closes are held, a 31-day-old close is retired not held,
// the wake-closure retire never writes won:false, and a failed stranded-load retire is logged.
// Each check is named after the code mutation it was proven to catch.
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
const DAY = 86_400_000;
const EXPECTED = 10;
let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok    ' + name); } catch (e) {
    fail += 1; console.log('  FAIL  ' + name + ' :: ' + (e && e.message ? e.message : String(e)));
  }
};

const TMP = path.join(os.tmpdir(), `rehydrate-hold-grace-pins-${process.pid}-${T0}`);
fs.mkdirSync(TMP, { recursive: true });
let seq = 0;
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill('done'); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const timeline = [];
  const events = [];
  const logAt = (level) => (m, f) => timeline.push({ log: true, level, m, f: f || {} });
  const log = { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') };
  const adapter = {
    writeEnabled,
    capabilities: () => CAPS,
    ensureSession: async () => ({}),
    getAuctionState: async () => state,
    placeBid: async () => { throw new Error('placeBid reached - nothing in this file may bid'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config, onEvent: (e) => { events.push(e); timeline.push({ log: false, e }); }, log, rand: () => 0.5,
  });
  eng.log = log;
  eng._events = events;
  eng._timeline = timeline;
  ENGINES.push(eng);
  return eng;
}

const base = (id, over) => Object.assign({
  auctionId: id, status: 'bidding',
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Havells India', branchName: 'Alwar', platformKey: 'superprocure',
  rules: { minDecrement: 100, revisionLimit: 3, pricingMode: 'flat', rateType: 'per_truck' },
  cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5,
  firedRungs: [], everBid: false, landedBids: 0, finalRank: null, won: null,
  createdAt: T0 - 3_600_000, startsAt: T0 - 1_800_000,
}, over);
const withoutClose = (it) => { delete it.closesAt; return it; };

const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };
const meta = (id, startsAt, closesAt) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', startsAt, closesAt,
});

const isActive = (eng, id) => eng.scheduler.activeIntents().some((i) => i.auctionId === id);
const alertsFor = (eng, id) => eng._events.filter((e) => e.type === 'alert' && e.auctionId === id);
const routedToDesk = (eng, id) => alertsFor(eng, id).some((a) => {
  const n = toNotification(a);
  return !!n && n.kind === 'error' && !!n.data && n.data.auctionId === id
    && typeof n.data.detail === 'string' && n.data.detail.trim().length > 0;
});
const describe = (eng, id) => {
  const r = eng.scheduler.get(id) || {};
  return `status=${JSON.stringify(r.status)} won=${JSON.stringify(r.won)} armed=${eng.monitors.has(id)}`
    + ` active=${isActive(eng, id)} alerts=${JSON.stringify(alertsFor(eng, id).map((a) => a.kind))}`;
};
const assertHeld = (eng, id, status) => {
  assert.ok(!eng.monitors.has(id), `${id} was armed, a held load arms nothing - ${describe(eng, id)}`);
  assert.strictEqual((eng.scheduler.get(id) || {}).status, status,
    `${id} must keep its status '${status}' while held - ${describe(eng, id)}`);
  assert.ok(isActive(eng, id), `${id} dropped out of activeIntents() - ${describe(eng, id)}`);
  assert.ok(routedToDesk(eng, id), `${id} has no alert that toNotification routes to the error channel - ${describe(eng, id)}`);
};

(async () => {
  // Rehydrate door: every unknown-close shape, plus two believable controls.
  const HELD = [
    base('ZERO', { closesAt: 0 }),
    base('NEG', { closesAt: -1 }),
    base('FUT31', { status: 'armed', closesAt: T0 + 30 * DAY + 3_600_000 }),
    withoutClose(base('ABSENT')),
    withoutClose(base('ABSENT-SCHED', { status: 'scheduled' })),
  ];
  const CONTROLS = [
    base('REAL-2H', { closesAt: T0 + 2 * 3_600_000 }),
    base('FUT29', { closesAt: T0 + 29 * DAY }),
  ];
  const R = mkEngine({ intents: [...HELD, ...CONTROLS] });
  const resumed = await R.rehydrate();
  await settle();
  const banner = R._events.find((e) => e.type === 'alert' && e.kind === 'restart_with_live_auctions');

  // Resume door: an absent-close scheduled intent through kill -> resume.
  const K = mkEngine({ intents: [withoutClose(base('ABSENT-RESUME', { status: 'scheduled' }))] });
  K.kill('operator kill switch');
  K.resume();
  await settle();

  // In-grace scheduled intent through rehydrate's _planWake.
  const G = mkEngine({ intents: [base('INGRACE', { status: 'scheduled', closesAt: T0 - 60_000 })],
    state: { ok: false, error: 'ECONNRESET' } });
  const graceMs = G.cfg.rehydrateGraceMs;
  await G.rehydrate();
  const gAtReturn = { status: (G.scheduler.get('INGRACE') || {}).status, active: isActive(G, 'INGRACE') };
  await settle();

  // Wake-closure retire past the grace: close falls ~250ms before the wake, grace shrunk to 1ms.
  const W = mkEngine({ state: { ok: true, status: 'live', closesInMs: 500_000 }, config: { armLeadMs: 0 } });
  W.cfg.rehydrateGraceMs = 1;
  const wNow = Date.now();
  W.schedule(meta('W-PAST', wNow + 300, wNow + 50), INPUTS);
  const wAtPlan = (W.scheduler.get('W-PAST') || {}).status;
  const wUntil = Date.now() + 3_000;
  while (Date.now() < wUntil && (W.scheduler.get('W-PAST') || {}).status === 'scheduled') await sleep(20);

  // schedule() over a close 31 days in the past.
  const P = mkEngine();
  P.schedule(meta('PAST31', T0 - 31 * DAY - 60_000, T0 - 31 * DAY), INPUTS);
  await settle();

  // _wakeFailed's own durable write throws on a broken data dir.
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

  check('M31: an in-grace scheduled intent reached through _planWake stays active with its status', () => {
    assert.ok(graceMs >= 120_000, `fixture assumes a 60s-past close is inside the grace, got rehydrateGraceMs=${graceMs}`);
    assert.strictEqual(gAtReturn.status, 'scheduled', `INGRACE status at rehydrate() return was ${JSON.stringify(gAtReturn.status)}`);
    assert.ok(gAtReturn.active, 'INGRACE left activeIntents() at rehydrate() return');
    assert.ok(isActive(G, 'INGRACE'), `INGRACE left activeIntents() after its wake - ${describe(G, 'INGRACE')}`);
    assert.strictEqual((G.scheduler.get('INGRACE') || {}).won, null, 'INGRACE must keep won null');
  });

  check('M20: a held intent keeps its status and stays active (rehydrate door and kill/resume door)', () => {
    for (const h of HELD) {
      const r = R.scheduler.get(h.auctionId) || {};
      assert.strictEqual(r.status, h.status, `${h.auctionId} - ${describe(R, h.auctionId)}`);
      assert.ok(isActive(R, h.auctionId), `${h.auctionId} not active - ${describe(R, h.auctionId)}`);
      assert.strictEqual(r.won, null, `${h.auctionId} won must stay null`);
    }
    assertHeld(K, 'ABSENT-RESUME', 'scheduled');
  });

  check('M17/M18: every held alert routes through toNotification to the error channel with its auctionId', () => {
    for (const h of HELD) {
      assert.ok(routedToDesk(R, h.auctionId), `${h.auctionId}: no routed desk alert - ${describe(R, h.auctionId)}`);
    }
  });

  check('M25: the wake-closure retire past the grace keeps an unknown outcome unknown', () => {
    assert.strictEqual(wAtPlan, 'scheduled', 'precondition: W-PAST must be scheduled at plan time, not retired');
    const r = W.scheduler.get('W-PAST') || {};
    assert.strictEqual(r.status, 'closed', `W-PAST must be retired at the wake - ${describe(W, 'W-PAST')}`);
    assert.ok(r.won === null || !('won' in r), `W-PAST was never bid, won must stay unknown, got ${JSON.stringify(r.won)}`);
  });

  check('M04/M08: a zero or negative stored close is held - not armed, not retired', () => {
    assertHeld(R, 'ZERO', 'bidding');
    assertHeld(R, 'NEG', 'bidding');
  });

  check('M11: a close 30 days + 1 hour out is held, a close 29 days out still arms', () => {
    assertHeld(R, 'FUT31', 'armed');
    assert.ok(R.monitors.has('FUT29'), `control FUT29 must arm - ${describe(R, 'FUT29')}`);
    assert.strictEqual(alertsFor(R, 'FUT29').length, 0, `control FUT29 raised an alert - ${describe(R, 'FUT29')}`);
  });

  check('M35: the rehydrate hold covers scheduled intents and counts them as held, not resumed', () => {
    assertHeld(R, 'ABSENT-SCHED', 'scheduled');
    assert.ok(banner, 'restart banner missing');
    assert.strictEqual(banner.held, HELD.length, `banner.held=${banner.held}, expected ${HELD.length}`);
    assert.strictEqual(banner.count, CONTROLS.length, `banner.count=${banner.count}, expected ${CONTROLS.length}`);
    assert.strictEqual(resumed, CONTROLS.length, `rehydrate() returned ${resumed}, expected ${CONTROLS.length}`);
  });

  check('M12: a close 31 days in the PAST is retired closed with won null, not held', () => {
    const r = P.scheduler.get('PAST31') || {};
    assert.strictEqual(r.status, 'closed', `PAST31 - ${describe(P, 'PAST31')}`);
    assert.strictEqual(r.won, null, `PAST31 won must be null, got ${JSON.stringify(r.won)}`);
    assert.ok(!P._events.some((e) => e.kind === 'close_unknown_held'), 'PAST31 raised a close_unknown_held alert');
  });

  check('M27: a throw inside _wakeFailed is contained and logged at error level with the auctionId', () => {
    const tl = B._timeline;
    const alertAt = tl.findIndex((x) => !x.log && x.e.type === 'alert' && x.e.kind === 'wake_arm_failed'
      && x.e.auctionId === 'W-BROKEN');
    assert.ok(alertAt >= 0, 'precondition: the wake must reach _wakeFailed and raise its alert');
    assert.strictEqual(rejections.length, 0, `an unhandled rejection escaped: ${String(rejections[0])}`);
    const after = tl.slice(alertAt + 1).filter((x) => x.log && x.level === 'error' && x.f.auctionId === 'W-BROKEN');
    assert.ok(after.length >= 1, '_wakeFailed\'s own failure (after its alert) left no error-level log carrying the auctionId');
  });

  check('M23: the restart banner carries the held count in its fields and its message', () => {
    assert.ok(banner, 'restart banner missing');
    assert.strictEqual(banner.held, HELD.length, `banner.held=${banner.held}`);
    assert.ok(new RegExp('\\b' + HELD.length + '\\b').test(banner.message),
      `banner message does not mention the ${HELD.length} held load(s): ${JSON.stringify(banner.message)}`);
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
