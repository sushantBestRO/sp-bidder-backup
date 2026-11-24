'use strict';
/**
 * A virtual clock for driving the real BidEngine and the real portal adapters together.
 *
 * Date.now, setTimeout and clearTimeout are replaced for the life of the process; setImmediate is
 * left real and is how pending promise work is drained between timer firings. Adapters take
 * `now` and `sleep` from here, so the engine's ticks, the adapter's read queue and the fake portal's
 * latency all run on one clock. No real waiting.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */

const REAL = { now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };

const clock = { now: REAL.now() };
let seq = 0;
const timers = new Set();

function vSetTimeout(fn, ms, ...args) {
  const t = { at: clock.now + Math.max(0, Number(ms) || 0), seq: seq += 1, fn, args,
    unref() { return t; }, ref() { return t; }, hasRef() { return false; } };
  timers.add(t);
  return t;
}
function vClearTimeout(t) { if (t) timers.delete(t); }

Date.now = () => clock.now;
global.setTimeout = vSetTimeout;
global.clearTimeout = vClearTimeout;

const now = () => clock.now;
const sleep = (ms) => new Promise((r) => vSetTimeout(r, ms));

async function drain(turns = 12) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

/** Run every timer due up to `to`, in time order, draining promise work around each one. */
async function runUntil(to) {
  for (;;) {
    await drain();
    let next = null;
    for (const t of timers) if (t.at <= to && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
    if (!next) { clock.now = Math.max(clock.now, to); await drain(); return; }
    timers.delete(next);
    clock.now = Math.max(clock.now, next.at);
    try { next.fn(...next.args); } catch (_) { /* a throwing timer is the code under test's to report */ }
  }
}

function restore() {
  Date.now = REAL.now;
  global.setTimeout = REAL.setTimeout;
  global.clearTimeout = REAL.clearTimeout;
  timers.clear();
}

module.exports = { clock, now, sleep, runUntil, drain, restore, REAL };
