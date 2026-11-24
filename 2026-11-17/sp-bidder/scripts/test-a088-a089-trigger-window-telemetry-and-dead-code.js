'use strict';
/**
 * Pins A088 and A089 (fix/ops-alerting-divergences).
 *
 * A088: _triggerWindowTelemetry treated a published trigger window of 0 as KNOWN (admits w=0,
 * `known = w != null && Number.isFinite(w)`), while _softFinalShotBand - the rule that actually
 * fires - treats w<=0 as "no usable window" ("a published window of 0 ... has no anti-snipe
 * mechanic to dodge"). The shadow telemetry disagreed with the mechanism it exists to observe.
 * `known` is now `w != null && Number.isFinite(w) && w > 0`, matching _softFinalShotBand exactly.
 *
 * A089: _insideTriggerWindow had zero production callers - the only thing that ever executed it
 * was one test fixture computing a deliberately-naive comparison formula. Removed.
 *
 * @requires-summary-line
 *   node scripts/test-a088-a089-trigger-window-telemetry-and-dead-code.js
 */
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const fakeAdapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'soft' }) };
const tmpScheduler = () => new DurableScheduler(path.join(os.tmpdir(), `a088-${process.pid}-${Math.random()}.json`));

(async () => {
  const eng = new BidEngine(fakeAdapter, tmpScheduler());

  // ---- A088: a published window of 0 is NOT "known" - matches _softFinalShotBand's own bar ----
  {
    const monitor = { triggerWindowMs: 0 };
    const t = eng._triggerWindowTelemetry(monitor, 5000);
    assert.strictEqual(t.triggerWindowMs, null, `A088: a window of 0 reports as unknown (null), got ${JSON.stringify(t)}`);
    assert.strictEqual(t.insideTriggerWindow, null, 'A088: insideTriggerWindow is also null when the window is not usable');
    const band = eng._softFinalShotBand(monitor);
    assert.strictEqual(band, null, 'control: _softFinalShotBand already treats w=0 as no usable window (the rule telemetry must agree with)');
    ok('A088: a published trigger window of 0 is reported as unknown, matching _softFinalShotBand');
  }

  // ---- A088: a real positive window is still reported and evaluated normally (no over-correction) ----
  {
    const monitor = { triggerWindowMs: 100000 };
    const inside = eng._triggerWindowTelemetry(monitor, 50000);
    assert.strictEqual(inside.triggerWindowMs, 100000, 'a real window is still reported');
    assert.strictEqual(inside.insideTriggerWindow, true, 'remaining <= window reports inside=true');
    const outside = eng._triggerWindowTelemetry(monitor, 150000);
    assert.strictEqual(outside.insideTriggerWindow, false, 'remaining > window reports inside=false');
    ok('control: a real (positive) trigger window still reports and evaluates correctly');
  }

  // ---- A088: an absent/unknown window still reports null both fields (unchanged) ----
  {
    const t = eng._triggerWindowTelemetry({ triggerWindowMs: null }, 5000);
    assert.strictEqual(t.triggerWindowMs, null, 'an absent window still reports null');
    assert.strictEqual(t.insideTriggerWindow, null, 'insideTriggerWindow still null for an absent window');
    ok('control: an absent/unknown trigger window is unaffected (still null/null)');
  }

  // ---- A089: the dead method no longer exists on the engine ----
  {
    assert.strictEqual(typeof eng._insideTriggerWindow, 'undefined', 'A089: _insideTriggerWindow has been removed (zero production callers)');
    ok('A089: dead code (_insideTriggerWindow) removed from BidEngine');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
