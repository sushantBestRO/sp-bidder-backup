'use strict';
/**
 * THE SOCKET CLOCK OFFSET HAS NO TRANSIT CORRECTION.
 *
 * Regression target: SuperProcure countdown optimism, measured on the production box (Sep 2026):
 * the countdown the engine acted on was 0.6-3.9 s optimistic on some final-window shots.
 *
 * spSocket._onClock sets serverOffsetMs = heartbeat.time - Date.now() at receipt. The heartbeat was
 * stamped when SuperProcure sent it and arrives one network leg later, so every sample under-reads
 * the server clock by that whole leg and the countdown the engine acts on says MORE time is left
 * than really is - the late side, the side that gets a final bid refused after the close.
 *
 * The fix corrects each heartbeat by half the smallest round trip measured to the same host. With a
 * symmetric path that removes the bias; with an asymmetric path (the return leg slower than the
 * request leg) half the round trip is still the best available estimate, and the residual stays
 * inside half the round trip, which is what the reported error bound has to cover.
 *
 * WHAT MUST NOT MOVE:
 *   - with no round trip measured, the offset is the raw heartbeat reading - no invented correction
 *     (check 1).
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, a REST
 * transport stub with chosen leg times, no network.
 *
 *   node scripts/test-sp-clock-transit-correction.js
 */
const assert = require('assert');
const { createSim, runTimeline } = require('./lib/sp-clock-sim');

const EXPECTED = 4;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
process.on('exit', (code) => {
  if (code === 0 && pass !== EXPECTED) {
    console.error(`COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED}`);
    process.exitCode = 1;
  }
});

const LOAD = 25635492;

// Three minutes of heartbeats every 10 s, each arriving `hbOneWayMs` after its stamp, and a REST
// call every 30 s with the given legs. Returns the countdown error at the end.
async function scenario({ theta, hbOneWayMs, rest = [] }) {
  const sim = createSim({ theta });
  const t0 = sim.serverNow();
  const close = t0 + 600_000;
  sim.setClose(LOAD, close);
  const events = [];
  for (let i = 1; i <= 18; i++) events.push(sim.hbEvent(t0 + i * 10_000, hbOneWayMs));
  rest.forEach(([up, down], i) => events.push(sim.restEvent(sim.now() + 5_000 + i * 30_000, up, down)));
  await runTimeline(sim, events);
  sim.advance(1_000);
  return { sim, ...(await sim.read(LOAD, close)) };
}

(async () => {
  {
    // No REST traffic at all: nothing measured, so nothing to correct by. The offset is what the
    // heartbeat said, which under-reads by exactly the one-way leg.
    const { err } = await scenario({ theta: 1_234, hbOneWayMs: 150 });
    assert.ok(Math.abs(err - 150) <= 5,
      `with no round trip measured the countdown must be the raw heartbeat reading (150 ms late), got ${err} ms`);
    ok('no round trip measured: no invented correction');
  }
  {
    // Symmetric path: 150 ms each way on REST, and the heartbeat's own leg is the same 150 ms.
    const { err } = await scenario({ theta: 1_234, hbOneWayMs: 150,
      rest: [[150, 150], [150, 150], [150, 150], [150, 150], [150, 150]] });
    assert.ok(Math.abs(err) <= 20,
      `the countdown is ${err} ms optimistic on a symmetric 150/150 ms path: the heartbeat offset carries `
      + 'no transit correction, so every sample under-reads the server clock by the whole one-way leg');
    ok('symmetric 150/150 ms path: the transit leg is corrected out of the countdown');
  }
  {
    // The smallest round trip is the one that bounds the path; a slow retry or a large listing body
    // must not inflate the correction.
    const { err } = await scenario({ theta: -12, hbOneWayMs: 150,
      rest: [[450, 450], [150, 150], [350, 350], [400, 400], [300, 300]] });
    assert.ok(Math.abs(err) <= 20,
      `with round trips of 900/300/700/800/600 ms the correction must come from the smallest (300 ms), `
      + `countdown error ${err} ms`);
    ok('the correction uses the minimum round trip, not the latest or the mean');
  }
  {
    // Asymmetric: request leg 30 ms, return leg 270 ms (RTT 300). The heartbeat travels the slow
    // return leg. Half the RTT (150) is the best a round trip can say; the residual 120 ms must stay
    // inside half the RTT, and the adapter must report a bound that covers it.
    const { err, st } = await scenario({ theta: 1_234, hbOneWayMs: 270,
      rest: [[30, 270], [30, 270], [30, 270], [30, 270], [30, 270]] });
    assert.ok(Math.abs(err) <= 150,
      `asymmetric 30/270 ms path: countdown error ${err} ms exceeds half the round trip (150 ms) - the `
      + 'heartbeat offset is not corrected for transit');
    assert.ok(typeof st.clockErrorMs === 'number' && st.clockErrorMs >= Math.abs(err),
      `the reported clock error bound (${st.clockErrorMs}) must cover the actual countdown error (${err} ms)`);
    ok('asymmetric 30/270 ms path: residual inside half the round trip, and inside the reported bound');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
