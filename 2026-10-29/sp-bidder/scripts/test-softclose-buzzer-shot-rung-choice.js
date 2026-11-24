'use strict';
/**
 * Which rung a soft-close buzzer shot offers, and when the floor after a final shot stops.
 *
 *   1. A pre-cap buzzer shot skips a middle rung already spent, even one the decrement would reach.
 *      Re-offering it places nothing and burns a revision.
 *   2. With no middle rung left, the pre-cap shot goes to the last-resort floor release and takes its
 *      guards. A floor already landed and standing is not sent again.
 *   3. The floor after a non-floor final shot stops at the attempt bound.
 *
 * The suite drove these only through whole countdowns that never reached the boundaries, so the rung
 * walk, the hand-off to the release and the bound were unpinned (mutation critique, PR-1). Offline:
 * each case calls the decision function on a monitor with its timer detached; placeBid throws.
 *
 *   node scripts/test-softclose-buzzer-shot-rung-choice.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED = 3;
const files = [];
const engines = [];
let pass = 0;
process.on('exit', () => {
  for (const e of engines) { try { e.kill(); } catch (_) {} }
  for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} }
  if (pass !== EXPECTED) { console.log(`FAIL: ${pass}/${EXPECTED} checks passed`); process.exitCode = 1; }
  else console.log(`\n${pass}/${EXPECTED} checks passed`);
});
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must never be reached in a decision unit test'); },
  };
  const f = path.join(os.tmpdir(), `buzzer-rung-${process.pid}-${files.length}.json`);
  files.push(f);
  const eng = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: () => {},
  });
  engines.push(eng);
  return eng;
}

let seq = 0;
function armLoad(eng) {
  const meta = { id: `B${++seq}`, lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: Date.now() + 900_000 };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 10, 8.5, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.triggerWindowMs = 100_000;
  m.extendMs = 180_000;
  return m;
}
const REMAINING = 2_000;
const state = (m) => ({ closesInMs: REMAINING, closesAtMs: Date.now() + REMAINING, myRank: 2, minDecrement: 100, standingL1Price: null });
const land = (m, idx) => { m.firedRungs.add(idx); m.currentRungIndex = idx; m.lastBidPrice = m.ladder[idx]; m.landedBids += 1; };

(async () => {
  {
    const eng = mkEngine();
    const m = armLoad(eng);
    const last = m.ladder.length - 1;
    assert.ok(last >= 3, `the ladder needs two middle rungs, got ${JSON.stringify(m.ladder)}`);
    land(m, 0);
    m.firedRungs.add(1); // offered and spent, never landed
    const d = eng._softPreCapBuzzerShot(m, state(m), REMAINING, last);
    assert.ok(d && d.rungIndex === 2 && d.price === m.ladder[2],
      `the shot after a spent rung 1 was ${JSON.stringify(d)} on ladder ${JSON.stringify(m.ladder)}`);
    ok(1, 'a pre-cap buzzer shot skips a middle rung already spent');
  }
  {
    const eng = mkEngine();
    const m = armLoad(eng);
    const last = m.ladder.length - 1;
    for (let i = 0; i < last; i++) m.firedRungs.add(i);
    land(m, last);
    m.currentRungIndex = last - 1; // the floor stands on the board, the walk sits on the last middle rung
    const d = eng._softPreCapBuzzerShot(m, state(m), REMAINING, last);
    assert.strictEqual(d, null, `a standing floor was offered again as a pre-cap shot: ${JSON.stringify(d)}`);
    ok(2, 'with no middle rung left the pre-cap shot defers to the floor release, which holds a standing floor');
  }
  {
    const eng = mkEngine();
    const m = armLoad(eng);
    const last = m.ladder.length - 1;
    land(m, 1);
    m.snipeFired = true;
    m.extendCap = 3;
    const bound = eng.softCfg.lastResortFloorAttempts;
    const fired = [];
    for (let i = 0; i < bound + 1; i++) {
      const d = eng._softFloorAfterFinalShot(m, state(m), REMAINING, last);
      fired.push(d ? d.rungIndex : null);
    }
    assert.deepStrictEqual(fired, [...Array(bound).fill(last), null], `attempts past the final shot: ${JSON.stringify(fired)}`);
    ok(3, `the floor after a final shot is sent at most ${bound} times`);
  }
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exitCode = 1; });
