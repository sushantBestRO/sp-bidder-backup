'use strict';
/**
 * WHEN THE CLOCK HAS TO PICK BETWEEN READINGS THAT DISAGREE, ITS ERROR BOUND MUST SAY SO.
 *
 * The socket clock keeps the least-delayed recent heartbeat, holds a single reading far above it until
 * a second agrees, and treats six readings in a row far below it as a clock change. Each rule is a
 * bet between two explanations the heartbeats alone cannot separate:
 *   - six late heartbeats in a row look exactly like the local clock stepping forward;
 *   - one reading far above looks exactly like the local clock stepping back, until the next one.
 * Whichever way the bet goes, clockErrorMs is what later logic sizes its safety margin from, so while
 * the readings disagree it has to cover the explanation that was not taken.
 *
 * Check 1 is the other side of the same rule: fewer than six late heartbeats in a row are delay, and
 * must not move the countdown at all (the most seen on the production box, 1-24 Sep 2026, was four).
 *
 * Offline and deterministic: the real adapter and the real SpSocket on a fake local clock, no network.
 *
 *   node scripts/test-sp-clock-bound-covers-disagreement.js
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

const LOAD = 25635492;
const ONE_WAY = 30;

// 30 punctual heartbeats, then `late` heartbeats each `lateMs` late, then punctual ones again (with
// sim.theta moved by `thetaShift` from the first special beat on). Every 500 ms after the first
// special beat, for `watchMs`, the countdown is read. Returns the reads.
async function run({ late = 0, lateMs = 0, thetaShift = 0, watchMs = 60_000 }) {
  const sim = createSim({ theta: -12 });
  const t0 = sim.serverNow();
  const close = t0 + 3_600_000;
  sim.setClose(LOAD, close);
  const events = [];
  for (let i = 1; i <= 30; i++) events.push({ stampLocal: t0 - sim.theta + i * 10_000, oneWay: ONE_WAY, shifted: false });
  const firstSpecial = t0 - sim.theta + 310_000;
  for (let i = 0; i < 20; i++) {
    events.push({ stampLocal: firstSpecial + i * 10_000, oneWay: i < late ? lateMs : ONE_WAY, shifted: true });
  }
  const reads = [];
  const timeline = [];
  for (const e of events) timeline.push({ at: e.stampLocal + e.oneWay, hb: e });
  for (let at = firstSpecial + 1; at <= firstSpecial + watchMs; at += 500) timeline.push({ at, read: true });
  timeline.sort((a, b) => a.at - b.at || (a.hb ? -1 : 1));
  let shifted = false;
  for (const e of timeline) {
    if (e.hb && e.hb.shifted && !shifted && thetaShift) { sim.theta += thetaShift; shifted = true; }
    sim.at(e.at);
    if (e.hb) {
      sim.sock._onClock({ time: e.hb.stampLocal + sim.theta });
      continue;
    }
    const { st, err } = await sim.read(LOAD, close);
    reads.push({ at: e.at - firstSpecial, err, bound: st.clockErrorMs });
  }
  return reads;
}

(async () => {
  {
    const reads = await run({ late: 5, lateMs: 1_500 });
    const worst = reads.reduce((m, r) => (Math.abs(r.err) > Math.abs(m) ? r.err : m), 0);
    assert.ok(Math.abs(worst) <= 100,
      `five heartbeats in a row 1,500 ms late moved the countdown by ${worst} ms - delay alone is being read as `
      + 'a clock change (or adopted outright)');
    ok(`five late heartbeats in a row are delay: the countdown stays put (worst ${worst} ms)`);
  }
  {
    const reads = await run({ late: 6, lateMs: 1_500 });
    const miss = reads.find((r) => typeof r.bound !== 'number' || Math.abs(r.err) > r.bound);
    assert.ok(!miss,
      `six heartbeats in a row 1,500 ms late: at +${miss && miss.at} ms the countdown is ${miss && miss.err} ms off `
      + `and the reported bound is ${miss && miss.bound} - the bound does not cover the reading the clock set aside`);
    ok('six late heartbeats (indistinguishable from a forward step): the bound covers the countdown throughout');
  }
  {
    const reads = await run({ thetaShift: 3_000, watchMs: 30_000 });
    const miss = reads.find((r) => typeof r.bound !== 'number' || Math.abs(r.err) > r.bound);
    assert.ok(!miss,
      `a genuine 3 s rise in the offset: at +${miss && miss.at} ms the countdown is ${miss && miss.err} ms off and the `
      + `reported bound is ${miss && miss.bound} - the held reading is not reflected in the bound`);
    ok('a genuine rise held for confirmation: the bound covers the countdown while it is held');
  }

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
