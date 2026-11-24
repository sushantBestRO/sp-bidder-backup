'use strict';
/**
 * SP HARD CLOSE: a rank-1 hold on the last revision, taken as the engine's final decision, is not
 * reported as an unexplained no-bid - and only the final decision counts.
 *
 * Regression target: R1-F02, the fresh-monitor rank-1 hold on the last hard-close revision.
 *
 * Mechanism: with one revision left and the shared account already at rank 1, the engine holds rather
 * than undercut the account's own lead. The hold returned bare, so when a rival overtook the account
 * after the engine's last tick the load closed with zero writes, no recorded reason, and _finalize
 * raised never_bid_before_close - the error-class "armed and never fired for a reason nobody wrote
 * down" alarm - for a decision the engine made on purpose.
 *
 * The reason must describe the LAST decision, not any earlier one. A hold taken before the final
 * window, or one followed by a tick that did not hold, says nothing about why the floor never went
 * out, and those closes must keep alarming exactly as before.
 *
 * Checks:
 *   1  rank 1 on every tick, overtaken at the final read: zero writes, no never_bid_before_close, and
 *      the outcome names the hold as its no-bid reason                           (red before the fix)
 *   2  rank 1 early, then every read fails from before the final window to the close: the engine
 *      never decided in the window, so the alarm still fires and the hold is not the reason
 *   3  rank 1 held inside the window, then a later tick finds the account outranked with no revision
 *      left, so nothing is sent: the alarm still fires and the hold is not the reason
 *
 * Offline and deterministic: fake SuperProcure adapter, real BidEngine + DurableScheduler on a temp
 * file, the REAL _tick -> _maybeBid -> _finalize path on a virtual clock. No network, no real waits.
 *
 *   node scripts/test-hardclose-held-lead-close-reason.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
const MARGINS = [15.3, 10.8, 4.5];
const WINDOW_MS = 2_500;
const HELD_REASON = 'held_lead_last_revision';

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-heldreason-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// Cap 2 with a bid already standing on the shared account before the engine's first tick: the
// LOW_CAP discount leaves the engine one revision. SuperProcure publishes no live count, so
// revisionsLeft is null unless `liveRevisionsAt` says otherwise. After the close the read reports
// `finalRank`.
function spAccount({ closesAt, rankAt, readFailsAt = () => false, liveRevisionsAt = () => null, finalRank }) {
  const writes = [];
  return {
    writes,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const closesInMs = Math.max(0, closesAt - Date.now());
      if (closesInMs > 0 && readFailsAt(closesInMs)) return { ok: false, error: 'read failed' };
      return {
        ok: true, status: closesInMs <= 0 ? 'closed' : 'live',
        myRank: closesInMs <= 0 ? finalRank : rankAt(closesInMs), totalBidders: 6, standingL1Price: null,
        closesInMs, revisionLimit: 2, revisionsLeft: closesInMs <= 0 ? null : liveRevisionsAt(closesInMs),
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      writes.push({ price, closesInMs: closesAt - Date.now() });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
}

async function runLoad(opts) {
  const REAL_NOW = Date.now;
  const clock = { v: REAL_NOW() };
  Date.now = () => clock.v;
  const events = [];
  let eng;
  try {
    const closesAt = clock.v + 30_000;
    const adapter = spAccount({ closesAt, ...opts });
    eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: WINDOW_MS, cadenceJitterMs: 0 },
      rand: () => 0,
      onEvent: (e) => events.push(e),
    });
    const id = `hr-${seq}`;
    const m = eng.arm({ id, lane: { origin: 'Govindgarh', destination: 'X' }, equipment: '19ft', units: 1, closesAt, companyName: 'BG' },
      { cost: COST, marginsPct: MARGINS, minMarginPct: 3 });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    let ticks = 0;
    const decidedAt = [];
    while (!m.finalized && ticks++ < 3_000) {
      const remaining = closesAt - clock.v;
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      if (!m.finalized && remaining > 0 && !opts.readFailsAt?.(remaining)) decidedAt.push(remaining);
      clock.v += Math.max(1, eng._cadence(m.closesInMs, m));
    }
    return { writes: adapter.writes, events, finalized: !!m.finalized, revisionsLeft: m.revisionsLeft, decidedAt };
  } finally {
    Date.now = REAL_NOW;
    if (eng) { try { eng.kill('test done'); } catch (_) {} }
  }
}

const fmt = (writes) => '[' + writes.map((w) => `${w.price}@${w.closesInMs}ms`).join(', ') + ']';
const alarms = (run) => run.events.filter((e) => e.type === 'alert' && e.kind === 'never_bid_before_close');
const result = (run) => run.events.find((e) => e.type === 'auction_result');

let pass = 0;
const FAILURES = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push(name);
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

const EXPECTED = 3;
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

(async () => {
  console.log('hard close, last revision, account at rank 1: the close-time reason follows the last decision');

  const held = await runLoad({ rankAt: () => 1, finalRank: 2 });
  check('1 rank 1 on every tick, overtaken at the final read: zero writes, no never_bid_before_close, the hold is the reason', () => {
    assert.ok(held.finalized, 'precondition: the load reached _finalize');
    assert.strictEqual(held.revisionsLeft, 1, `precondition: the engine had one revision, not ${held.revisionsLeft}`);
    assert.ok(held.decidedAt.some((ms) => ms <= WINDOW_MS), 'precondition: the engine ticked inside the final window');
    assert.strictEqual(held.writes.length, 0, `the engine undercut the account's own lead: ${fmt(held.writes)}`);
    assert.strictEqual(alarms(held).length, 0,
      'never_bid_before_close was raised for a load the engine held on purpose at rank 1 on its last decision');
    const r = result(held);
    assert.ok(r, 'no auction_result was emitted');
    assert.strictEqual(r.landedBids, 0, `precondition: landedBids ${r.landedBids}`);
    assert.strictEqual(r.noBidReason, HELD_REASON, `the outcome gave no-bid reason ${r.noBidReason}`);
  });

  const blind = await runLoad({ rankAt: () => 1, readFailsAt: (ms) => ms <= WINDOW_MS + 2_500, finalRank: 2 });
  check('2 rank 1 early, reads fail from before the window to the close: the alarm fires, the hold is not the reason', () => {
    assert.ok(blind.finalized, 'precondition: the load reached _finalize');
    assert.ok(blind.decidedAt.length > 0 && blind.decidedAt.every((ms) => ms > WINDOW_MS),
      `precondition: the engine decided only outside the window (${blind.decidedAt.length} ticks)`);
    assert.strictEqual(blind.writes.length, 0, `precondition: nothing was sent: ${fmt(blind.writes)}`);
    assert.strictEqual(alarms(blind).length, 1,
      'a load that never reached its final-window decision was reported as a deliberate hold');
    const r = result(blind);
    assert.ok(r && r.noBidReason !== HELD_REASON, `a hold taken before the window was given as the reason (${r && r.noBidReason})`);
  });

  const lost = await runLoad({
    rankAt: (ms) => (ms > 1_500 ? 1 : 3),
    liveRevisionsAt: (ms) => (ms > 1_500 ? null : 0),
    finalRank: 3,
  });
  check('3 held inside the window, then outranked with no revision left: the alarm fires, the hold is not the reason', () => {
    assert.ok(lost.finalized, 'precondition: the load reached _finalize');
    assert.ok(lost.decidedAt.some((ms) => ms <= WINDOW_MS && ms > 1_500),
      'precondition: the engine held at rank 1 inside the window before it was outranked');
    assert.ok(lost.decidedAt.some((ms) => ms <= 1_500), 'precondition: a later tick read the account outranked');
    assert.strictEqual(lost.writes.length, 0, `precondition: nothing was sent: ${fmt(lost.writes)}`);
    assert.strictEqual(alarms(lost).length, 1,
      'an earlier in-window hold was carried past a later tick that did not hold, silencing the alarm');
    const r = result(lost);
    assert.ok(r && r.noBidReason !== HELD_REASON, `a superseded hold was given as the reason (${r && r.noBidReason})`);
  });

  if (pass !== EXPECTED || FAILURES.length) {
    console.error(`\nFAILED ${FAILURES.length} of ${EXPECTED}: ${FAILURES.join(' | ')}`);
    console.error('The close-time no-bid reason for the last-revision rank-1 hold does not follow the engine\'s last decision.');
    process.exit(1);
  }
  console.log(`\nPASS hardclose-held-lead-close-reason: ${pass}/${EXPECTED} checks`);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
