'use strict';
/**
 * Two paths of the contained retire writes that no earlier test exercised.
 *
 * 1. A healthy resume() retires a scheduled load whose close passed during the kill ON DISK, not only
 *    in the alert: the intent reads closed afterwards.
 * 2. The restart sweep (rehydrate -> retirePastClose -> _retireIfPastClose) calls
 *    _persistClosedWhileDown with the intent and no monitor. A failed intent write there is not
 *    swallowed: it counts as a failed retire and the restart's rehydrate_retire_failed alert names it.
 * 3. Control: the same sweep on a healthy disk raises no write-fault alert and emits the ledger event.
 *
 * Run: node scripts/test-staged-write-fault-critique.js
 */
process.env.LOG_LEVEL = 'silent';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 3;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-critique-'));
const REAL_NOW = Date.now;
process.on('exit', () => { Date.now = REAL_NOW; try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} });
const HOUR = 3_600_000;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const adapter = () => ({
  writeEnabled: true,
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => ({ accepted: true }),
});

function sweep(failIds) {
  const lane = { origin: 'Bhiwandi', destination: 'Hosur' };
  const intents = [{ auctionId: 'SWEPT', status: 'bidding', closesAt: Date.now() - 2 * HOUR, won: null,
    lane, companyName: 'Acme Test Co', branchName: 'Hosur', units: 1, cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }];
  const scheduler = {
    activeIntents: () => intents.slice(),
    get: (id) => intents.find((i) => i.auctionId === id) || null,
    update: (id, patch) => {
      if (failIds.includes(id)) throw new Error('ENOSPC: no space left on device');
      return Object.assign(intents.find((i) => i.auctionId === id), patch);
    },
  };
  const events = [];
  const eng = new BidEngine(adapter(), scheduler, { onEvent: (e) => events.push(e) });
  return { eng, events, lane };
}

(async () => {
  {
    let clock = REAL_NOW();
    Date.now = () => clock;
    const engine = new BidEngine(adapter(), new DurableScheduler(path.join(TMPDIR, 'resume.json')), {
      config: { openAtMs: 2 * HOUR }, live: true, log: quietLog });
    engine.onEvent = () => {};
    engine.schedule({ id: 'EARLY', lane: { origin: 'A', destination: 'B' }, equipment: 'SXL', units: 1,
      companyName: 'Acme Test Co', startsAt: clock + 60_000, closesAt: clock + 120_000 }, { cost: 29_000, marginsPct: [9, 5, 1] });
    engine.kill('operator');
    clock += 120_000 + 11 * 60_000;
    engine.resume();
    for (const t of engine.scheduledTimers.values()) clearTimeout(t);
    Date.now = REAL_NOW;
    const it = engine.scheduler.get('EARLY');
    assert.strictEqual(it && it.status, 'closed', `the passed load must be marked closed on disk by the resume; status ${it && it.status}`);
    ok('1. a healthy resume marks the passed scheduled load closed on disk');
  }

  {
    const { eng, events } = sweep(['SWEPT']);
    await eng.rehydrate();
    const alert = events.find((e) => e.type === 'alert' && e.kind === 'rehydrate_retire_failed');
    assert.ok(alert && /SWEPT/.test(String(alert.auctionId)),
      `a failed intent write in the restart sweep must be counted as a failed retire and named in rehydrate_retire_failed; saw ${JSON.stringify(events.map((e) => e.kind || e.type))}`);
    assert.ok(!events.some((e) => e.type === 'alert' && e.kind === 'close_record_failed'),
      'the sweep keeps its batch accounting: the same failure is not also reported per load');
    ok('2. a failed write in the restart sweep is counted as a failed retire and named in the restart alert');
  }

  {
    const { eng, events } = sweep([]);
    await eng.rehydrate();
    assert.ok(!events.some((e) => e.type === 'alert' && e.kind === 'close_record_failed'), 'CONTROL: a healthy sweep raises no write-fault alert');
    assert.ok(events.some((e) => e.type === 'closed_while_down' && e.auctionId === 'SWEPT'), 'CONTROL: the ledger event goes out');
    ok('3. control: a healthy sweep raises no write-fault alert and emits the ledger event');
  }

  if (pass !== EXPECTED_CHECKS) { console.error(`ran ${pass} of ${EXPECTED_CHECKS} checks`); process.exit(1); }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { Date.now = REAL_NOW; console.error('FAILED: ' + (e && e.message)); process.exit(1); });
