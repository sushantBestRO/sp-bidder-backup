'use strict';
/**
 * A LATE HEARTBEAT WITH NOTHING BESIDE IT MUST NOT OUTRANK THE NEXT PUNCTUAL ONE.
 *
 * Positive pin, green on the latest-heartbeat-wins clock and required to stay green.
 *
 * The socket clock holds a heartbeat that reads far ABOVE its estimate until a second one agrees, so
 * a single wrong reading cannot make the countdown read zero early. That guard is only sound while
 * the estimate itself rests on several agreeing heartbeats. When it rests on one - the first
 * heartbeat after a restart, or the first after a long socket outage - that one heartbeat is as
 * likely to be the late one, and the punctual heartbeat that follows it reads "far above".
 * Holding it keeps the late reading as the clock for another ten seconds, seconds optimistic.
 *
 * Found by replaying the production box's recovered clock samples (1-24 Sep 2026) through the
 * estimator: on master load 25479041 the only sample in the window was 2,206 ms late, the next
 * punctual one was held, and the final shot at a 2,422 ms countdown would have gone out 2.2 s late
 * where the old clock was right.
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-late-first-heartbeat.js
 */
const assert = require('assert');
const { createSim, runTimeline } = require('./lib/sp-clock-sim');

const EXPECTED = 2;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
process.on('exit', (code) => {
  if (code === 0 && pass !== EXPECTED) {
    console.error(`COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED}`);
    process.exitCode = 1;
  }
});

const LOAD = 25479041;

(async () => {
  {
    // A fresh socket: the first heartbeat is 2,206 ms late, the second is on time.
    const sim = createSim({ theta: -8 });
    const t0 = sim.serverNow();
    const close = t0 + 120_000;
    sim.setClose(LOAD, close);
    await runTimeline(sim, [sim.hbEvent(t0 + 10_000, 2_206), sim.hbEvent(t0 + 20_000, 30)]);
    const { err } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 100,
      `first heartbeat 2,206 ms late, second on time: the countdown is ${err} ms off - the late first `
      + 'reading outranked the punctual one');
    ok('fresh socket: a late first heartbeat is replaced by the next punctual one');
  }
  {
    // Six minutes of punctual heartbeats, a ten-minute outage, then a late heartbeat and a punctual one.
    const sim = createSim({ theta: -8 });
    const t0 = sim.serverNow();
    const close = t0 + 1_200_000;
    sim.setClose(LOAD, close);
    const ev = [];
    for (let i = 1; i <= 36; i++) ev.push(sim.hbEvent(t0 + i * 10_000, 30));
    const back = t0 + 360_000 + 600_000;
    ev.push(sim.hbEvent(back + 10_000, 2_206), sim.hbEvent(back + 20_000, 30));
    await runTimeline(sim, ev);
    const { err } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 100,
      `after a ten-minute outage, a late then a punctual heartbeat: the countdown is ${err} ms off`);
    ok('after an outage: a late first heartbeat is replaced by the next punctual one');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
