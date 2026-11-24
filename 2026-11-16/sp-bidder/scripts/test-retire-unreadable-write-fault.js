'use strict';
/**
 * _tick -> _retireUnreadable -> _persistClosedWhileDown. The intent write in
 * _persistClosedWhileDown ran unguarded ahead of its own ledger emit, so when the scheduler's write
 * throws (a full disk, a locked file, a replaced data dir), the throw fires before the
 * closed_while_down event is ever raised - the closed-bids ledger keeps its pre-retirement shape
 * (landed bids, no rank) forever, and _tick's own containment turns the failure into a generic
 * tick-fault line rather than a write-fault the desk can act on.
 *
 * Must not move: a healthy retire still emits closed_while_down and raises no write-fault alert
 * (checks 1-3, the control, run first).
 *
 * Run: node scripts/test-retire-unreadable-write-fault.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-unreadable-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
// unhandledRejection lands after the microtask queue drains, so flush with alternating turns rather
// than a wall-clock wait.
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
};

function rig(tag) {
  const dir = path.join(ROOT, tag);
  fs.mkdirSync(dir);
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }), // the portal never answers again - the unreadable path
    placeBid: async () => { throw new Error('no bid expected on a load past its close'); },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(path.join(dir, 'intents.json')), {
    config: { openAtMs: 2 * 60 * 60 * 1000, unreadableRetireMs: 500 }, live: true, log: quietLog });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const monitor = engine.arm({ id: 'GHOST', lane: { origin: 'Bhiwandi', destination: 'Hosur' },
    equipment: 'SXL', units: 1, companyName: 'Acme Test Co', startsAt: Date.now() - 600_000,
    closesAt: Date.now() + 600_000 }, { cost: 29_000, marginsPct: [9, 5, 1] });
  // arm() plants an immediate tick; cancel it so the fault (below, for the 'fault' rig) is in place
  // before the first read, and drive the tick ourselves once for both rigs.
  if (monitor.timer) clearTimeout(monitor.timer);
  monitor.timer = null;
  // The portal has been dark since well past the (short) unreadable-retire bound.
  monitor.meta.closesAt = Date.now() - 10_000;
  monitor.believedCloseAt = Date.now() - 10_000;
  return { engine, events, monitor, dir };
}

async function fireOneTick({ engine, monitor }) {
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  let thrown = null;
  try {
    engine._schedule(monitor, 0);
    await settle();
  } catch (e) { thrown = e; }
  process.removeListener('unhandledRejection', onRej);
  return { thrown, rejections };
}

const kindsOf = (events) => events.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type));

(async () => {
  // ---- control first, so a red below cannot be a dead harness: the same sequence on a healthy disk ----
  const good = rig('healthy');
  const g = await fireOneTick(good);
  const goodKinds = kindsOf(good.events);

  assert.strictEqual(g.thrown, null, 'control: a healthy retire does not throw');
  ok('1. control: a healthy retire does not throw');
  assert.ok(goodKinds.includes('closed_while_down'),
    `control: no ledger event; saw ${goodKinds.join(', ')}`);
  ok('2. control: the closed_while_down ledger event is emitted');
  assert.ok(!goodKinds.includes('alert:close_record_failed'),
    `control: a healthy write must not raise a write-fault alert; saw ${goodKinds.join(', ')}`);
  ok('3. control: no write-fault alert on a healthy write');

  // ---- the fault: the intents directory is replaced by a file, so every durable write fails ----
  const bad = rig('fault');
  fs.rmSync(bad.dir, { recursive: true, force: true });
  fs.writeFileSync(bad.dir, 'not a directory');
  const b = await fireOneTick(bad);
  const badKinds = kindsOf(bad.events);
  const state = `thrown=${b.thrown ? (b.thrown.code || b.thrown.message) : 'no'} `
    + `rejections=${b.rejections.length} events=${badKinds.join(',')}`;

  assert.strictEqual(b.thrown, null,
    `a failed retire write inside _retireUnreadable must not escape the tick (${state})`);
  ok('4. a failed retire write does not escape the tick');
  assert.strictEqual(b.rejections.length, 0, `no unhandled rejection may escape either (${state})`);
  ok('5. no unhandled rejection escapes');
  assert.ok(badKinds.includes('closed_while_down'),
    `the ledger event must still be emitted even when the intent write fails (${state})`);
  ok('6. the closed_while_down ledger event is emitted despite the failed write');
  assert.ok(badKinds.includes('alert:close_record_failed'),
    `the failed write must reach the desk as its own write-fault alert, not a generic tick fault (${state})`);
  ok('7. the failed write reaches the desk as a close_record_failed alert');

  console.log(`\nPASS ${pass}/7 checks passed`);
})().catch((e) => {
  console.error('FAIL: _persistClosedWhileDown write fault: ' + (e && e.message));
  process.exit(1);
});
