'use strict';
/**
 * A CLOCK READING IN WHOLE SECONDS IS READ AS THE START OF ITS SECOND.
 *
 * Regression target: SuperProcure countdown optimism, measured on the production box (Sep 2026).
 *
 * SuperProcure's REST getAvailableViews `currentTime` is whole Unix SECONDS (1785922009 - five HAR
 * captures, 2026-08-04 to 2026-09-08). serverClock.normalizeServerOffset turns it into ms by
 * multiplying by 1000, which is the START of that second: the server was anywhere from 0 to 999 ms
 * past it. On top of that the offset is taken against the local time AFTER the response came back,
 * so the whole return leg is added to the error. Result: the REST-derived server clock reads up to
 * a second behind, always on the late side, and the countdown built on it is up to a second
 * optimistic. The same holds for a `current` heartbeat if one ever arrives in seconds (the socket
 * accepts that shape; the captured heartbeats are in ms).
 *
 * The fix reads a whole-second value as the middle of its second, against the middle of the round
 * trip, which bounds the error by half a second plus half the round trip - and reports that bound.
 *
 * WHAT MUST NOT MOVE:
 *   - normalizeServerOffset's own contract, pinned by test-sp-time-field-bounds.js, is unchanged.
 *
 * Offline and deterministic: the real adapter's real login() over a REST transport stub, the real
 * SpSocket's heartbeat handler, a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-seconds-truncation.js
 */
const assert = require('assert');
const { createSim } = require('./lib/sp-clock-sim');

const EXPECTED = 3;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
process.on('exit', (code) => {
  if (code === 0 && pass !== EXPECTED) {
    console.error(`COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED}`);
    process.exitCode = 1;
  }
});

const LOAD = 42;
const UP = 200, DOWN = 200;
const PHASES = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];

// Log in when the server's clock is `phase` ms past a whole second at the instant it stamps the
// reply, with no socket attached (the REST clock is the one in use). Returns the REST read.
async function restLoginAt(phase) {
  const sim = createSim({ theta: 2_345 });
  sim.adapter.sock = null;
  const stampTarget = Math.ceil((sim.serverNow() + UP) / 1000) * 1000 + 1000 + phase;
  sim.at(stampTarget - sim.theta - UP);
  await sim.login(UP, DOWN);
  const close = sim.serverNow() + 300_000;
  sim.adapter.loadMeta.set(String(LOAD), { id: String(LOAD), closesAt: close, softClose: false, revisionLimit: 3 });
  return sim.read(LOAD, close);
}

(async () => {
  const errs = [];
  {
    for (const phase of PHASES) {
      const { err } = await restLoginAt(phase);
      errs.push(err);
      assert.ok(Math.abs(err) <= 500 + (UP + DOWN) / 2,
        `REST login with the server ${phase} ms into its second: countdown ${err} ms optimistic - the whole-second `
        + 'currentTime is read as the start of its second, so the offset keeps only the floor');
    }
    ok(`REST currentTime in whole seconds: countdown error within half a second plus half the round trip at every sub-second phase (${errs.join(', ')})`);
  }
  {
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    assert.ok(Math.abs(mean) <= 100,
      `mean countdown error across sub-second phases is ${mean} ms - the truncation still biases one way`);
    for (const phase of PHASES) {
      const { err, st } = await restLoginAt(phase);
      assert.ok(typeof st.clockErrorMs === 'number' && st.clockErrorMs >= Math.abs(err),
        `phase ${phase}: the reported clock error bound (${st.clockErrorMs}) must cover the countdown error (${err} ms)`);
    }
    ok('no one-sided bias, and the reported bound covers the second it cannot resolve');
  }
  {
    // A heartbeat in whole seconds, the server 900 ms into its second, 20 ms on the wire.
    const sim = createSim({ theta: -12 });
    const close = sim.serverNow() + 300_000;
    sim.setClose(LOAD, close);
    const stamp = Math.ceil(sim.serverNow() / 1000) * 1000 + 10_000 + 900;
    sim.heartbeat(stamp, 20, Math.floor(stamp / 1000));
    const { err, st } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 500 + 20,
      `a whole-second heartbeat 900 ms into its second leaves the countdown ${err} ms optimistic`);
    assert.ok(typeof st.clockErrorMs === 'number' && st.clockErrorMs >= Math.abs(err),
      `the reported clock error bound (${st.clockErrorMs}) must cover the countdown error (${err} ms)`);
    ok('a whole-second heartbeat is read as the middle of its second, inside the reported bound');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
