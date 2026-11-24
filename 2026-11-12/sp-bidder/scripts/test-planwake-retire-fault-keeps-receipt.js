'use strict';
/**
 * A scheduled load whose close passed while the engine was killed never bid. resume() retires it in
 * _planWake and gives the desk the wake_retired_past_close receipt ("no bid was placed"). When the
 * retire write fails, that receipt must still go out: the fact it states does not depend on the
 * write, and the write-fault alert alone tells the desk the load may still be live.
 *
 * Control first: the same sequence on a healthy disk.
 *
 *   node scripts/test-planwake-retire-fault-keeps-receipt.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'planwake-receipt-'));
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

function run(tag, breakDisk) {
  const dir = path.join(ROOT, tag);
  fs.mkdirSync(dir);
  const engine = new BidEngine(adapter(), new DurableScheduler(path.join(dir, 'intents.json')), {
    config: { openAtMs: 2 * 60 * 60 * 1000 }, live: true, log: quietLog });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  engine.schedule({ id: 'EARLY', lane: { origin: 'A', destination: 'B' }, equipment: 'SXL', units: 1,
    companyName: 'Acme Test Co', startsAt: clock + 60_000, closesAt: clock + 120_000 },
  { cost: 29_000, marginsPct: [9, 5, 1] });
  engine.kill('operator');
  clock += 120_000 + 11 * 60_000;
  if (breakDisk) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');
  }
  engine.resume();
  for (const t of engine.scheduledTimers.values()) clearTimeout(t);
  return events.filter((e) => e.type === 'alert' && e.auctionId === 'EARLY').map((e) => e.kind);
}

try {
  const good = run('healthy', false);
  assert.ok(good.includes('wake_retired_past_close'), `control: receipt on a healthy disk; saw ${JSON.stringify(good)}`);
  ok('1. control: a healthy retire gives the never-bid receipt');

  const bad = run('fault', true);
  assert.ok(bad.includes('wake_retire_failed'), `the failed write still raises wake_retire_failed; saw ${JSON.stringify(bad)}`);
  ok('2. the failed retire write raises wake_retire_failed');
  assert.ok(bad.includes('wake_retired_past_close'),
    `the never-bid receipt must go out even when the retire write fails; saw ${JSON.stringify(bad)}`);
  ok('3. the never-bid receipt goes out despite the failed write');
  console.log(`\nPASS ${pass}/3 checks passed`);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  process.exit(1);
}
