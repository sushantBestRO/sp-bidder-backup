'use strict';
/**
 * resume() re-plans every scheduled load through _planWake. A load whose close passed while the
 * engine was killed is retired there with a durable write, and that write rethrows when the disk
 * refuses it. The throw escapes resume() mid-loop: every scheduled load after it gets no wake, so
 * it never arms, and the load being retired gets no notice either.
 *
 * Must not move: a healthy resume still retires the passed load with its wake_retired_past_close
 * notice and still plans the later load's wake (checks 1-3, the control, run first).
 *
 * Run: node scripts/test-resume-planwake-retire-throw.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-planwake-'));
const REAL_NOW = Date.now;
let clock = REAL_NOW();
Date.now = () => clock;
process.on('exit', () => { Date.now = REAL_NOW; try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const adapter = () => ({
  writeEnabled: true,
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => ({ accepted: true }),
});

// Two scheduled loads, a kill, then time passes EARLY's close by more than the rehydrate grace.
function rig(tag) {
  const dir = path.join(ROOT, tag);
  fs.mkdirSync(dir);
  const engine = new BidEngine(adapter(), new DurableScheduler(path.join(dir, 'intents.json')), {
    config: { openAtMs: 2 * 60 * 60 * 1000 }, live: true, log: quietLog });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const load = (id, startIn, closeIn) => engine.schedule({ id, lane: { origin: 'A', destination: 'B' },
    equipment: 'SXL', units: 1, companyName: 'Acme Test Co', startsAt: clock + startIn, closesAt: clock + closeIn },
  { cost: 29_000, marginsPct: [9, 5, 1] });
  load('EARLY', 60_000, 120_000);
  load('LATER', 6 * 60 * 60 * 1000, 7 * 60 * 60 * 1000);
  engine.kill('operator');
  clock += 120_000 + 11 * 60_000;
  return { engine, events, dir };
}

function resumeAndRead({ engine, events }) {
  let thrown = null;
  try { engine.resume(); } catch (e) { thrown = e; }
  const planned = [...engine.scheduledTimers.keys()];
  for (const t of engine.scheduledTimers.values()) clearTimeout(t);
  const alertsFor = (id) => events.filter((e) => e.type === 'alert' && e.auctionId === id);
  return { thrown, planned, alertsFor };
}

(async () => {
  // ---- control first, so a red below cannot be a dead harness: the same sequence on a healthy disk ----
  const g = resumeAndRead(rig('healthy'));
  assert.strictEqual(g.thrown, null, 'control: a healthy resume does not throw');
  ok('1. control: a healthy resume does not throw');
  assert.ok(g.planned.includes('LATER'), `control: LATER gets its wake; planned ${JSON.stringify(g.planned)}`);
  ok('2. control: the later load gets its wake');
  assert.ok(g.alertsFor('EARLY').some((e) => e.kind === 'wake_retired_past_close'),
    'control: the passed load is retired with its wake_retired_past_close notice');
  ok('3. control: the passed load retires with its notice');

  // ---- the fault: the intents directory is replaced by a file, so every durable write fails ----
  const f = rig('fault');
  fs.rmSync(f.dir, { recursive: true, force: true });
  fs.writeFileSync(f.dir, 'not a directory');
  const bad = resumeAndRead(f);
  const state = `threw=${bad.thrown ? (bad.thrown.code || bad.thrown.message) : 'no'} `
    + `wakes=${JSON.stringify(bad.planned)} earlyAlerts=${bad.alertsFor('EARLY').length}`;

  assert.strictEqual(bad.thrown, null,
    `resume() must not throw when retiring a passed scheduled load fails on disk (${state})`);
  ok('4. a failed retire write inside resume() does not escape resume()');

  assert.ok(bad.planned.includes('LATER'),
    `the scheduled load after the failed retire must still get its wake (${state})`);
  ok('5. the later scheduled load still gets its wake');

  assert.ok(bad.alertsFor('EARLY').length > 0,
    `the load whose retire failed must reach the desk as an alert, not vanish (${state})`);
  ok('6. the load whose retire failed is named in an alert');

  console.log(`
PASS ${pass}/6 checks passed`);
})().catch((e) => {
  console.error('FAIL: resume() -> _planWake retire throw: ' + (e && e.message));
  process.exit(1);
});
