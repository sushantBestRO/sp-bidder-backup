'use strict';
/**
 * A FINAL BID TIMED 2.5 s BEFORE THE CLOSE ARRIVES AFTER IT.
 *
 * Regression target: Durian 25635492 (21 Sep 2026) - floor fired at a 2,304 ms countdown, refused
 * "Error in remaining time calculation" 564 ms after the close; 159 such refusals across the corpus.
 *
 * The engine releases the floor on the first tick whose countdown is at or under floorWindowMs
 * (2,500 ms) and trusts that countdown to be the portal's. When the socket clock has just taken a
 * late heartbeat, the countdown is seconds optimistic, the "2.5 s" shot goes out after the portal
 * has closed, and SuperProcure refuses it. With the clock right, the same shot lands with about two
 * seconds to spare even at the slowest write RTT measured in September.
 *
 * The timeline is the one the box recorded for Durian 25635492: five minutes of ordinary
 * heartbeats, then heartbeats 273 ms, 591 ms and 2,741 ms late at 25.4 s, 15.2 s and 3.9 s before
 * the close. Engine ticks every 200 ms in the last 10 s; the shot fires on the first tick at or under
 * the engine's own floorWindowMs and reaches the portal one write round trip later.
 *
 * CONTROL (check 1, green before and after the fix): with no late heartbeat the same shot lands in
 * time - the harness itself is not what fails check 2.
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-final-bid-lands.js
 */
const assert = require('assert');
const { DEFAULTS } = require('../src/engine/bidEngine');
const { createSim, runTimeline } = require('./lib/sp-clock-sim');

const EXPECTED = 3;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
process.on('exit', (code) => {
  if (code === 0 && pass !== EXPECTED) {
    console.error(`COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED}`);
    process.exitCode = 1;
  }
});

const LOAD = 25635492;
const FLOOR_WINDOW_MS = DEFAULTS.floorWindowMs;
// September SP hard-close write RTTs (n=361): p90 372 ms, p99 1,546 ms (production box, Sep 2026).
const RTT_P90 = 372, RTT_P99 = 1_546;

// Returns how many ms before the portal's close the final shot reaches the portal (negative = after).
async function finalShot({ lateBeats, writeRttMs }) {
  const sim = createSim({ theta: -12 });
  const t0 = sim.serverNow();
  const close = t0 + 330_000;
  sim.setClose(LOAD, close);
  const ev = [];
  for (let i = 1; i <= 29; i++) ev.push(sim.hbEvent(t0 + i * 10_000, 30));
  for (let i = 0; i < 10; i++) ev.push(sim.restEvent(sim.now() + 5_000 + i * 30_000, 60, 60));
  if (lateBeats) {
    ev.push(sim.hbEvent(close - 25_400 - 273, 273));
    ev.push(sim.hbEvent(close - 15_200 - 591, 591));
    ev.push(sim.hbEvent(close - 3_900 - 2_741, 2_741));
  }
  // Engine ticks every 200 ms over the last 10 s, with every heartbeat delivered at its own arrival
  // instant in between.
  let tick = close - sim.theta - 10_000;
  const ticks = [];
  while (tick < close - sim.theta + 5_000) { ticks.push({ at: tick, tick: true }); tick += 200; }
  const timeline = ev.concat(ticks).sort((a, b) => a.at - b.at || (a.tick ? 1 : -1));
  let fired = false;
  for (const e of timeline) {
    sim.at(e.at);
    if (!e.tick) { await e.run(); continue; }
    const { st } = await sim.read(LOAD, close);
    if (st.closesInMs <= FLOOR_WINDOW_MS) { fired = true; break; }
  }
  if (!fired) throw new Error('the countdown never reached the floor window');
  const firedWithMs = sim.trueRemaining(close);
  return { landsBeforeCloseMs: firedWithMs - writeRttMs, firedWithMs };
}

(async () => {
  {
    const r = await finalShot({ lateBeats: false, writeRttMs: RTT_P90 });
    assert.ok(r.landsBeforeCloseMs > 0,
      `control: with ordinary heartbeats the shot landed ${-r.landsBeforeCloseMs} ms AFTER the close - the harness is broken`);
    ok(`control, ordinary heartbeats: fired ${r.firedWithMs} ms before the close, lands ${r.landsBeforeCloseMs} ms before it`);
  }
  {
    const r = await finalShot({ lateBeats: true, writeRttMs: RTT_P90 });
    assert.ok(r.landsBeforeCloseMs > 0,
      `Durian timeline: the ${FLOOR_WINDOW_MS} ms shot fired with ${r.firedWithMs} ms really left and reached the portal `
      + `${-r.landsBeforeCloseMs} ms AFTER the close - a late heartbeat left the countdown seconds optimistic`);
    assert.ok(r.landsBeforeCloseMs >= FLOOR_WINDOW_MS - 500 - RTT_P90,
      `the shot lands only ${r.landsBeforeCloseMs} ms before the close - more than 500 ms of the floor window lost to the clock`);
    ok(`Durian timeline at the p90 write RTT: fired ${r.firedWithMs} ms before the close, lands ${r.landsBeforeCloseMs} ms before it`);
  }
  {
    const r = await finalShot({ lateBeats: true, writeRttMs: RTT_P99 });
    assert.ok(r.landsBeforeCloseMs > 0,
      `Durian timeline at the p99 write RTT (${RTT_P99} ms): the shot reached the portal ${-r.landsBeforeCloseMs} ms after the close`);
    ok(`Durian timeline at the p99 write RTT: still lands ${r.landsBeforeCloseMs} ms before the close`);
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
