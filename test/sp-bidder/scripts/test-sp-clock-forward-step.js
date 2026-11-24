'use strict';
/**
 * A FORWARD STEP OF THE LOCAL CLOCK MUST NOT END A HARD-CLOSE AUCTION EARLY.
 *
 * Positive pin, green on the latest-heartbeat-wins clock and required to stay green.
 *
 * When the box's own clock steps forward (an NTP correction, a VM migration), every heartbeat after it
 * reads the server-minus-local offset lower, and that lower reading is the truth. A clock that keeps
 * the highest recent heartbeat keeps the OLD, higher offset until it ages out: the countdown then runs
 * short by the size of the step. On a hard close the engine finalizes on the first zero countdown
 * (bidEngine _tick: hardClosed = status closed or countdown zero), so a 3 s step ends our bidding on
 * that load 3 s before the portal closes it. The latest-wins clock followed within one heartbeat; the
 * minimum-delay clock must follow within a bounded number of agreeing heartbeats, not the whole window.
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-forward-step.js
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

const LOAD = 25635492;
const ONE_WAY = 30;

(async () => {
  const sim = createSim({ theta: 1_000 });
  const t0 = sim.serverNow();
  const stepAtServer = t0 + 180_000;
  const close = stepAtServer + 150_000;
  sim.setClose(LOAD, close);
  const before = [];
  for (let i = 1; i <= 18; i++) before.push(sim.hbEvent(t0 + i * 10_000, ONE_WAY));
  await runTimeline(sim, before);

  sim.theta -= 3_000;
  const after = [];
  for (let i = 1; i <= 16; i++) after.push(sim.hbEvent(stepAtServer + i * 10_000, ONE_WAY));
  const ninetyAfter = stepAtServer - sim.theta + 90_000 + ONE_WAY + 1;
  const ticks = [{ at: ninetyAfter, probe: true }];
  for (let at = close - sim.theta - 10_000; at <= close - sim.theta + 400; at += 200) ticks.push({ at, tick: true });
  const timeline = after.concat(ticks).sort((a, b) => a.at - b.at || (a.run ? -1 : 1));

  let at90 = null, worst = 0, firstZeroLeft = null;
  for (const e of timeline) {
    sim.at(e.at);
    if (e.run) { await e.run(); continue; }
    const { st, err } = await sim.read(LOAD, close);
    if (e.probe) { at90 = err; continue; }
    if (Math.abs(err) > Math.abs(worst)) worst = err;
    if (firstZeroLeft == null && st.closesInMs <= 0) firstZeroLeft = sim.trueRemaining(close);
  }

  assert.ok(Math.abs(at90) <= 100,
    `90 s after the local clock stepped forward 3 s the countdown is still ${at90} ms off - the stale higher `
    + 'offset is held until it ages out of the window');
  ok(`90 s after a 3 s forward step the countdown has followed (off by ${at90} ms)`);
  assert.ok(firstZeroLeft != null && firstZeroLeft <= 500,
    `the hard-close countdown first read zero with ${firstZeroLeft} ms really left (worst tick error ${worst} ms) - `
    + 'the engine would finalize the load that early');
  ok(`the countdown reaches zero at the portal's close, not before it (${firstZeroLeft} ms left at the first zero)`);

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
