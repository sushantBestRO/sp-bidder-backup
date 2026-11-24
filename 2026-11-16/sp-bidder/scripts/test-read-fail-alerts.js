'use strict';
/**
 * Regression for the spurious repeated_read_failures alert on the NORMAL scheduled-wake
 * flow: the wake arms armLeadMs (10s) before startsAt, SuperProcure keeps biddingOn 0
 * (closesAt null) and the socket silent until it opens the window, so getAuctionState
 * correctly answers ok:false for the whole pre-open gap. At the engine's 1s read-fail
 * retry cadence that gap accrued 5 "failures" ~4-5s after EVERY scheduled wake - before
 * recovery was even possible - firing a WhatsApp error ping per wake.
 *
 * The guard: read-fails while now < intent.startsAt + startGraceMs are not COUNTED
 * (counting-but-muting would let the counter sail past the exact ===5 trigger pre-open
 * and permanently disarm the real alert). A read still failing AFTER the window opens
 * counts from zero and alerts at the same 5-fail threshold; a load with no known
 * startsAt (directly armed, never scheduled) keeps the original behavior untouched.
 *
 *   node scripts/test-read-fail-alerts.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const BAND = [12.6, 7.2, 6.3];
const tmp = (tag) => path.join(os.tmpdir(), `readfail-${tag}-${process.pid}.json`);

// adapter stuck in the pre-open shape: every read is ok:false (no meta close, no frame)
function failingAdapter() {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() { return { ok: false, measuredRttMs: 50 }; },
    async placeBid() { throw new Error('placeBid must never fire in this test'); },
  };
}

// drive one manual tick, then cancel the retry timer it schedules (deterministic count)
const tick = async (engine, m) => { await engine._tick(m); if (m.timer) clearTimeout(m.timer); };
const readFailAlerts = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'repeated_read_failures');

(async () => {
  // A. scheduled wake with startsAt in the future -> pre-open read-fails accrue SILENTLY
  {
    const f = tmp('preopen');
    const events = [];
    const engine = new BidEngine(failingAdapter(), new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    const startsAt = Date.now() + 60_000;
    const closesAt = startsAt + 30 * 60_000;
    engine.schedule({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, startsAt, closesAt },
      { cost: 50_000, marginsPct: BAND });
    // replicate the wake body exactly (the real wake fires at startsAt - armLeadMs; too far
    // out to wait for): intent -> _intentToArm -> arm. _intentToArm drops startsAt from meta,
    // so the guard only works if arm()'s upsert MERGE preserves it on the durable intent.
    for (const t of engine.scheduledTimers.values()) clearTimeout(t);
    const { meta, inputs } = engine._intentToArm(engine.scheduler.get('1'));
    const m = engine.arm(meta, inputs);
    if (m.timer) clearTimeout(m.timer); // cancel the arm-time tick; every tick below is manual
    assert.strictEqual(m.intent.startsAt, startsAt, 'upsert merge preserves startsAt on the armed intent (the guard\'s data source)');
    for (let i = 0; i < 8; i++) await tick(engine, m); // > 5 fails, all inside the pre-open gap
    assert.strictEqual(m.consecutiveReadFails, 0, 'pre-open read-fails are not counted');
    assert.strictEqual(readFailAlerts(events).length, 0, 'no repeated_read_failures alert during the pre-open gap');
    ok('scheduled wake, startsAt in the future: read-fails accrue silently (no per-wake false alarm)');

    // B. the SAME monitor after the window opens (startsAt now past the grace) -> a genuinely
    // broken read counts from zero and alerts at the same threshold: exactly once, at 5.
    engine.scheduler.update('1', { startsAt: Date.now() - (engine.cfg.startGraceMs + 1_000) });
    for (let i = 0; i < 4; i++) await tick(engine, m);
    assert.strictEqual(m.consecutiveReadFails, 4, 'post-open fails count normally');
    assert.strictEqual(readFailAlerts(events).length, 0, 'no alert before the 5th consecutive fail');
    await tick(engine, m);
    const alerts = readFailAlerts(events);
    assert.strictEqual(alerts.length, 1, 'alert fires on the 5th consecutive post-open fail');
    assert.strictEqual(alerts[0].count, 5, 'alert reports the real count');
    await tick(engine, m);
    assert.strictEqual(readFailAlerts(events).length, 1, 'alert fires once, not on every subsequent fail');
    engine.kill('test-done');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('same load after startsAt: still alerts at exactly 5 consecutive fails (real signal intact)');
  }

  // C. no known startsAt (directly armed, never scheduled) -> original behavior untouched
  {
    const f = tmp('nostart');
    const events = [];
    const engine = new BidEngine(failingAdapter(), new DurableScheduler(f), { onEvent: (e) => events.push(e) });
    const m = engine.arm({ id: '2', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 300_000 },
      { cost: 50_000, marginsPct: BAND });
    if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(m.intent.startsAt, undefined, 'directly-armed intent has no startsAt');
    for (let i = 0; i < 5; i++) await tick(engine, m);
    const alerts = readFailAlerts(events);
    assert.strictEqual(alerts.length, 1, 'unknown startsAt keeps the original 5-fail alert');
    assert.strictEqual(alerts[0].count, 5, 'at the original threshold');
    engine.kill('test-done');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('unknown startsAt: current behavior kept (5 consecutive fails still alert)');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
