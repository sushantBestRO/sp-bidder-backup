'use strict';
/**
 * THE SCHEDULED-WAKE ERROR HANDLER IS ITSELF UNGUARDED.
 *
 * Regression target: T2 disposition D7 / finding BH-ASYNC-1
 * (disposition row D7, upheld_confirmed, deterministic 3/3, fix_flip genuine).
 *
 * _planWake ends in `setTimeout(() => { wake().catch((e) => this._wakeFailed(id, e)); }, delay)`.
 * That `.catch` is the only handler on the whole scheduled-wake path, and there is no containment
 * on the callback itself. _wakeFailed exists to retire a load whose arm threw, and it ends in
 * `scheduler.update(id, { status: 'closed', ... })` - DurableScheduler._persist rethrows every fs
 * failure by design. So when wake() and _wakeFailed() fail for the SAME cause - one unwritable
 * intents file - the handler installed to contain the first failure throws the second one into a
 * derived promise nobody holds. Node has no handler on it: unhandledRejection.
 *
 * server.js's process.on('unhandledRejection', ...) logs at error level and does NOT exit, so there
 * is no crash, no PM2 restart, no durable record and no desk-visible channel. That is bucket 3 of
 * the price-page gate - currently silent, unacceptable.
 *
 * WHAT MUST NOT MOVE:
 *   - a wake whose handler does NOT throw still alerts, still retires the intent to 'closed', and
 *     still puts the cause on the log and never in the alert (check 2). Containing the handler must
 *     not change what the handler does.
 *   - the containment must not work by SUPPRESSING the path it exists to exercise: the
 *     wake_arm_failed desk alert still fires, still reads as prose rather than the raw kind, and
 *     still leaks no rupee figure into the WhatsApp channel the Director subscribes to (check 5).
 *   - an ordinary scheduled wake on a healthy disk still arms (check 3).
 *
 * Offline and deterministic: fake adapter, temp scheduler files under os.tmpdir(), no network, no
 * sleeps. The fs failure is forced STRUCTURALLY rather than by timing - the data directory is
 * replaced by a regular file AFTER the intent is persisted, so existsSync(dir) stays true,
 * writeJSONAtomic's ensureDir() does not re-create it, and every later tmp write is a hard
 * ENOENT/ENOTDIR. The wake is planned at delay 0, so the only wait is an event-loop flush driven
 * with explicit macrotask turns.
 *
 *   node scripts/test-wake-failed-handler-contained.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const ROOT = path.join(os.tmpdir(), `wake-contained-${process.pid}-${Date.now()}`);
let seq = 0;
const mkDataDir = () => {
  const d = path.join(ROOT, 'd' + (seq++));
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const cleanup = () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} };

// existsSync(dir) stays true so ensureDir() no-ops, and every tmp write under it is ENOENT/ENOTDIR.
const breakDataDir = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'the data dir is now a file - every durable write fails');
};

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function withRejectionCapture(fn) {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    await settle();
    await settle();
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
  return rejections;
}

function mkEngine({ state, dataDir }) {
  const events = [];
  const logs = [];
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => state,
    placeBid: async () => { throw new Error('placeBid must never be reached on this path'); },
  };
  const log = {
    debug: (m, f) => logs.push({ level: 'debug', m, f }),
    info: (m, f) => logs.push({ level: 'info', m, f }),
    warn: (m, f) => logs.push({ level: 'warn', m, f }),
    error: (m, f) => logs.push({ level: 'error', m, f }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(path.join(dataDir, 'intents.json')), {
    config: { armLeadMs: 0 }, onEvent: (e) => events.push(e), log,
  });
  eng._events = events;
  eng._logs = logs;
  return eng;
}

const mkMeta = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi',
  startsAt: Date.now() - 1000,
  closesAt: Date.now() + 3_600_000,
});
const INPUTS = { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] };

const alertsOf = (eng, k) => eng._events.filter((e) => e.type === 'alert' && e.kind === k);

(async () => {
  const LIVE = { ok: true, status: 'live', closesInMs: 890_000, closesAtMs: Date.now() + 890_000 };
  const DEAD = { ok: true, status: 'closed', closesInMs: 0, closesAtMs: Date.now() - 1000,
    myRank: null, totalBidders: 0 };

  const brokenDir = mkDataDir();
  const broken = mkEngine({ state: DEAD, dataDir: brokenDir });
  const brokenRejections = await withRejectionCapture(async () => {
    broken.schedule(mkMeta('W-brokendisk'), INPUTS);
    assert.strictEqual(broken.scheduler.get('W-brokendisk').status, 'scheduled',
      'setup: the intent is persisted as scheduled while the disk still works');
    breakDataDir(brokenDir);
    await settle();
    await settle();
    broken.kill('done');
  });
  const brokenAlerts = alertsOf(broken, 'wake_arm_failed');

  // ------------------------------------------------ 1. precondition: the wake reached _wakeFailed
  {
    assert.strictEqual(brokenAlerts.length, 1,
      'precondition: the scheduled wake must genuinely run and genuinely reach _wakeFailed - one '
      + 'wake_arm_failed alert. Without this the harness is wrong, not the engine.');
    assert.strictEqual(brokenAlerts[0].auctionId, 'W-brokendisk',
      'precondition: the alert carries the load it was raised for');
    ok('the wake ran and reached _wakeFailed on the unwritable intents file (precondition)');
  }

  // ------------------------------------------------ 2. CONTROL: the handler itself does not throw
  {
    const eng = mkEngine({ state: LIVE, dataDir: mkDataDir() });
    eng.arm = () => {
      const e = new Error('ceiling cap altered the floor rung (14200 != 13800)');
      e.code = 'FLOOR';
      throw e;
    };
    const rejections = await withRejectionCapture(async () => {
      eng.schedule(mkMeta('W-armthrow'), INPUTS);
      await settle();
      await settle();
      eng.kill('done');
    });
    const a = alertsOf(eng, 'wake_arm_failed')[0];
    assert.ok(a, 'a throwing arm() on a healthy disk still alerts the desk');
    assert.strictEqual(eng.scheduler.get('W-armthrow').status, 'closed',
      'and still retires the intent - left at scheduled it has no timer, no monitor and no way back');
    assert.strictEqual(rejections.length, 0,
      'a handler that completes rejects nothing: this is today behaviour and must stay today behaviour');
    const line = eng._logs.find((l) => l.level === 'error' && /scheduled wake failed/.test(l.m));
    assert.ok(line && /ceiling cap altered the floor rung/.test(line.f.err),
      'the cause is on the error log, which no recipient receives');
    assert.ok(!/14200|13800|ceiling cap/.test(a.detail),
      'and never in the recipient-facing detail - it names our own margin figures');
    ok('CONTROL: a wake whose handler does not throw alerts, retires, and leaks no cause (unchanged)');
  }

  // ------------------------------------------------ 3. CONTROL: an ordinary wake still arms
  {
    const eng = mkEngine({ state: LIVE, dataDir: mkDataDir() });
    await withRejectionCapture(async () => {
      eng.schedule(mkMeta('W-ok'), INPUTS);
      await settle();
      await settle();
    });
    assert.ok(eng.monitors.has('W-ok'),
      'a live, open auction at wake time must still arm - this file must not silence the happy path');
    assert.strictEqual(alertsOf(eng, 'wake_arm_failed').length, 0, 'and raise no failure alert');
    eng.kill('done');
    ok('CONTROL: an ordinary scheduled wake on a healthy disk still arms');
  }

  // ------------------------------------------------ 4. THE DEFECT: the handler's own throw escapes
  {
    if (brokenRejections.length) {
      const r = brokenRejections[0];
      console.error('\nUNHANDLED REJECTION ESCAPED THE SCHEDULED-WAKE PATH:');
      console.error(r && r.stack ? r.stack : String(r));
    }
    assert.strictEqual(brokenRejections.length, 0,
      'wake().catch((e) => this._wakeFailed(id, e)) has no containment on the CALLBACK itself, so '
      + 'the throw from _wakeFailed\'s own scheduler.update -> _persist -> writeJSONAtomic rejects a '
      + 'derived promise nobody holds. No handler, no crash, no PM2 restart, no durable record and '
      + 'no desk-visible channel - the silent bucket the price-page gate refuses.');
    ok('no unhandled rejection escapes the scheduled wake when the handler\'s own durable write throws');
  }

  // ------------------------------------------------ 5. the containment must not suppress the path
  {
    const a = brokenAlerts[0];
    assert.ok(a.detail, 'wake_arm_failed must still carry a detail under containment');
    assert.notStrictEqual(a.detail, a.kind,
      'detail must not be the raw kind - engineAlerts falls through to detail: evt.kind');
    assert.ok(/\s/.test(a.detail), 'detail must be prose');
    assert.ok(!/\d{3}/.test(a.detail),
      `detail must carry no numeric amount - this kind routes to the Director's WhatsApp error channel:\n${a.detail}`);
    ok('the desk alert survives the containment intact and still leaks no numeric amount');
  }

  cleanup();
  const EXPECTED = 5;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
