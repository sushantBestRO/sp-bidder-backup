'use strict';
/**
 * A soft-close SuperProcure load outside the soft allowlist follows a moved close without counting it.
 *
 * softStrategy 'off' runs no soft endgame: its believed close follows the live close (the retire bound,
 * the /track mark and the recorded close read it), but no extension round is counted and nothing is
 * emitted. Counting would feed the allowlisted endgame's extension state into a load that never runs it.
 * The suite never moved the close of such a load, so the branch that keeps it out of counting was
 * unpinned (mutation critique, PR-1).
 *
 *   node scripts/test-softoff-close-move-not-counted.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const file = path.join(os.tmpdir(), `softoff-close-${process.pid}.json`);
let eng = null;
let pass = 0;
process.on('exit', () => {
  try { if (eng) eng.kill(); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
  if (pass !== 2) { console.log(`FAIL: ${pass}/2 checks passed`); process.exitCode = 1; }
  else console.log(`\n${pass}/2 checks passed`);
});

(async () => {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must never be reached here'); },
  };
  eng = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: () => {},
  });
  const close0 = Date.now() + 600_000;
  const m = eng.arm({ id: 'SOFTOFF1', lane: { origin: 'PUNE', destination: 'NAGPUR' }, units: 1,
    companyName: 'Tata Steel', branchName: 'PUNE', closesAt: close0 }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  assert.strictEqual(m.softStrategy, 'off', `a non-allowlisted shipper armed with softStrategy ${m.softStrategy}`);
  assert.ok(!m.provisionalClose, 'the fixture must be a SuperProcure (non-provisional) load');

  const state = (closesAtMs) => ({ closesAtMs, closesInMs: closesAtMs - Date.now(), extendMs: 180_000, extendCount: 3 });
  eng._observeExtension(m, state(close0));
  const counted = eng._observeExtension(m, state(close0 + 180_000));
  assert.strictEqual(m.believedCloseAt, close0 + 180_000, `the believed close did not follow the move: ${m.believedCloseAt}`);
  console.log('  ok  1. the believed close follows a moved close');
  pass++;

  assert.strictEqual(counted, false, 'a close move on a soft-off load was reported as a counted extension');
  assert.ok(!m.extendsObserved, `a soft-off load counted ${m.extendsObserved} extension(s)`);
  assert.strictEqual(m.extendCap == null ? null : m.extendCap, null, `a soft-off load took the soft endgame's cap ${m.extendCap}`);
  console.log('  ok  2. the move is not counted as an extension round');
  pass++;
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exitCode = 1; });
