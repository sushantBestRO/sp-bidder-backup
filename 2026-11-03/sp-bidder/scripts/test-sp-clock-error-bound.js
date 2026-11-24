'use strict';
/**
 * THE COUNTDOWN CARRIES NO STATEMENT OF HOW WRONG IT MAY BE.
 *
 * Regression target: final-seconds bidding on SuperProcure needs a safety margin sized to the clock.
 * Anything that bids near the close has to know how far the countdown it acts on can be from the
 * portal's own clock.
 *
 * getAuctionState returns closesInMs and nothing about its uncertainty. The fix reports
 * `clockErrorMs`: a bound on |closesInMs - the portal's true remaining time| attributable to the
 * clock, or null when nothing has been measured yet. It must be honest in both directions: small
 * once enough heartbeats back the estimate, and large when they do not - one heartbeat that
 * happened to arrive late is indistinguishable from a good one.
 *
 * Scored at every engine tick of the final minute of a simulated auction whose heartbeats carry
 * the delay mix measured on the box (most within tens of ms, some 0.5-3 s late) and whose REST
 * round trips vary 88-410 ms.
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, a fixed
 * delay table (no RNG), no network.
 *
 *   node scripts/test-sp-clock-error-bound.js
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
const DELAYS = [22, 31, 25, 480, 27, 2_900, 24, 26, 1_300, 23, 35, 28];
const RTTS = [95, 140, 88, 410, 120];

(async () => {
  {
    // Twelve minutes of heartbeats with the measured delay mix, REST every 30 s, then every engine
    // tick of the final 60 s (1 s cadence, 200 ms inside the last 10 s).
    const sim = createSim({ theta: -12 });
    const t0 = sim.serverNow();
    const close = t0 + 720_000;
    sim.setClose(LOAD, close);
    const ev = [];
    for (let i = 1; i <= 66; i++) ev.push(sim.hbEvent(t0 + i * 10_000, DELAYS[i % DELAYS.length]));
    for (let i = 0; i < 22; i++) {
      const rtt = RTTS[i % RTTS.length];
      ev.push(sim.restEvent(sim.now() + 5_000 + i * 30_000, rtt / 2, rtt / 2));
    }
    await runTimeline(sim, ev);
    let ticks = 0, worstErr = 0, widest = 0;
    while (sim.trueRemaining(close) > 0) {
      const { st, err } = await sim.read(LOAD, close);
      ticks++;
      assert.ok(typeof st.clockErrorMs === 'number',
        `tick at ${sim.trueRemaining(close)} ms before the close: getAuctionState reports no clock error bound `
        + `(clockErrorMs ${st.clockErrorMs}) - the countdown the engine acts on carries no statement of its own uncertainty`);
      assert.ok(Math.abs(err) <= st.clockErrorMs,
        `tick at ${sim.trueRemaining(close)} ms before the close: countdown off by ${err} ms, outside the reported bound ${st.clockErrorMs}`);
      if (Math.abs(err) > Math.abs(worstErr)) worstErr = err;
      if (st.clockErrorMs > widest) widest = st.clockErrorMs;
      sim.advance(sim.trueRemaining(close) > 10_000 ? 1_000 : 200);
    }
    assert.ok(ticks > 90, `expected the final-minute tick walk to run, ran ${ticks}`);
    ok(`every final-minute tick (${ticks}) reports a bound that covers its countdown error (worst ${worstErr} ms)`);
    assert.ok(widest <= 500,
      `with 66 heartbeats behind it the bound should be under 500 ms, widest was ${widest} ms`);
    ok(`the bound is useful once heartbeats back it: widest ${widest} ms over the final minute`);
  }
  {
    const sim = createSim({ theta: -12 });
    const close = sim.serverNow() + 600_000;
    sim.setClose(LOAD, close);
    const { st } = await sim.read(LOAD, close);
    assert.strictEqual(st.clockErrorMs, null,
      `before any clock reading the bound must be null (unknown), not a number - got ${st.clockErrorMs}`);
    ok('no heartbeat yet: clockErrorMs is null, not an invented precision');
  }
  {
    // One heartbeat, 2 s late. With a single sample nothing can tell it from a punctual one, so the
    // bound must still cover the 2 s it is actually off.
    const sim = createSim({ theta: -12 });
    const t0 = sim.serverNow();
    const close = t0 + 600_000;
    sim.setClose(LOAD, close);
    await runTimeline(sim, [sim.restEvent(sim.now() + 1_000, 60, 60), sim.hbEvent(t0 + 10_000, 2_000)]);
    const { st, err } = await sim.read(LOAD, close);
    assert.ok(typeof st.clockErrorMs === 'number' && st.clockErrorMs >= Math.abs(err),
      `one heartbeat 2 s late: countdown off by ${err} ms but the reported bound is ${st.clockErrorMs}`);
    ok('a single late heartbeat: the bound covers the error it cannot see');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
