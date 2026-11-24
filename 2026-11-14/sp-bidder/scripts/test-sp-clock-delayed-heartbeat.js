'use strict';
/**
 * ONE LATE OR WRONG HEARTBEAT MOVES THE WHOLE COUNTDOWN.
 *
 * Regression target: Durian 25635492 (21 Sep 2026), the floor fired at a 2,304 ms countdown and was
 * refused "Error in remaining time calculation" 564 ms after the close.
 *
 * spSocket._onClock REPLACES serverOffsetMs with every heartbeat. A heartbeat can only ever reach us
 * late (queued behind a stalled event loop, a busy socket, the network) - never early - so a late
 * one under-reads the server clock by however long it waited, and latest-wins adopts that as the
 * clock for every load on the socket until the next heartbeat ten seconds later. The engine's own
 * per-tick countdowns on the box show it: Durian read -12 ms, then -273, -591, and 3.9 s before the
 * close -2,741 ms (the heartbeat processed after a 2,980 ms tick stall). That offset held through
 * the close; the portal had closed when the countdown still said 2.7 s. Replayed over 1-24 Sep, a
 * single heartbeat is more than 500 ms late 17% of the time.
 *
 * The fix keeps the recent samples and uses the highest (the least-delayed) - the minimum-delay
 * filter - with old samples expiring so a genuine clock change is followed, and a single sample far
 * ABOVE the rest held until a second one agrees, so one wrong reading cannot make the countdown
 * read zero early either.
 *
 * WHAT MUST NOT MOVE (checks 1 and 2, green before and after the fix):
 *   - a genuine drop in the server-minus-local offset (the box clock stepped forward) is followed;
 *   - a genuine rise (the box clock stepped back) is followed once a second heartbeat confirms it.
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-delayed-heartbeat.js
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
const ONE_WAY = 30;

// Heartbeats every 10 s from `fromServer` for `count` beats, each 30 ms on the wire.
const beats = (sim, fromServer, count, oneWay = ONE_WAY) =>
  Array.from({ length: count }, (_, i) => sim.hbEvent(fromServer + (i + 1) * 10_000, oneWay));

(async () => {
  {
    // The box clock steps FORWARD by 3 s: from then on every heartbeat reads 3 s lower, and that is
    // the truth. Fifteen minutes later the countdown must have followed.
    const sim = createSim({ theta: 1_000 });
    const close = sim.serverNow() + 3_600_000;
    sim.setClose(LOAD, close);
    await runTimeline(sim, beats(sim, sim.serverNow(), 12));
    sim.theta -= 3_000;
    await runTimeline(sim, beats(sim, sim.serverNow(), 90));
    const { err } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 50,
      `15 min after the local clock stepped forward 3 s the countdown is still ${err} ms off - stale samples never expire`);
    ok('a genuine drop in the offset is followed once the old samples age out');
  }
  {
    // The box clock steps BACK by 3 s: every later heartbeat reads 3 s higher. Two minutes of
    // agreeing heartbeats later the countdown must have followed.
    const sim = createSim({ theta: 1_000 });
    const close = sim.serverNow() + 3_600_000;
    sim.setClose(LOAD, close);
    await runTimeline(sim, beats(sim, sim.serverNow(), 12));
    sim.theta += 3_000;
    await runTimeline(sim, beats(sim, sim.serverNow(), 12));
    const { err } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 50,
      `2 min after the local clock stepped back 3 s the countdown is still ${err} ms off - a confirmed rise is not followed`);
    ok('a genuine rise in the offset is followed once a second heartbeat confirms it');
  }
  {
    // The Durian 25635492 shape, reproduced from the box's own per-tick countdowns: five minutes of
    // normal heartbeats, then three late ones - 273 ms, 591 ms, and 2,741 ms at 3.9 s before the close.
    const sim = createSim({ theta: -12 });
    const t0 = sim.serverNow();
    const close = t0 + 330_000;
    sim.setClose(LOAD, close);
    const ev = beats(sim, t0, 29);
    ev.push(sim.hbEvent(close - 25_400 - 273, 273));
    ev.push(sim.hbEvent(close - 15_200 - 591, 591));
    ev.push(sim.hbEvent(close - 3_900 - 2_741, 2_741));
    await runTimeline(sim, ev);
    let worst = 0;
    while (sim.trueRemaining(close) > 200) {
      const { err } = await sim.read(LOAD, close);
      if (Math.abs(err) > Math.abs(worst)) worst = err;
      sim.advance(200);
    }
    assert.ok(Math.abs(worst) <= 500,
      `after one heartbeat arrived 2,741 ms late the countdown was ${worst} ms optimistic in the last seconds - `
      + 'the latest heartbeat replaces the offset, so one late sample moves every countdown on the socket');
    ok('late heartbeats (273 / 591 / 2,741 ms) do not move the countdown in the final seconds');
  }
  {
    // One heartbeat stamped 5 s ahead of every other one (a wrong reading, not a clock change): the
    // countdown must not suddenly read 5 s short and close the load early.
    const sim = createSim({ theta: -12 });
    const t0 = sim.serverNow();
    const close = t0 + 400_000;
    sim.setClose(LOAD, close);
    const ev = beats(sim, t0, 30);
    ev.push({ at: t0 - sim.theta + 305_000 + ONE_WAY, run: async () => sim.sock._onClock({ time: t0 + 305_000 + 5_000 }) });
    await runTimeline(sim, ev);
    const { err } = await sim.read(LOAD, close);
    assert.ok(Math.abs(err) <= 500,
      `one heartbeat 5 s ahead of the rest moved the countdown by ${err} ms - a single wrong sample is adopted outright`);
    ok('a single heartbeat far above the rest is held, not adopted');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
