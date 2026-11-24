'use strict';
/**
 * THE TRI-STATE OUTCOME - a load nobody bid must retire as UNKNOWN, never as a loss.
 *
 * Regression target: bid-command bug hunt 2026-09-16, T2 defect D3 (disposition row D3;
 * upheld_confirmed 3/3 in two independent verifications). Promoted from reproducers t2inv-1-won-unknown-must-survive-retire.js and
 * repro-F5-won-divergence.js.
 *
 * `won` is a TRI-STATE: true = won, false = a definite loss we actually fought, null = unknown, we
 * never learned. The doctrine sits above _retireIfPastClose: "Can't read final rank back, so DON'T
 * book a phantom loss: keep any recorded outcome, else mark unknown so win/loss reporting isn't
 * corrupted." Two retire writers break it with the same two tokens, `won: it.won ?? false` -
 * _planWake's plan-time retire and _wakeFailed's stranded-load retire - so a load a human priced and
 * nobody ever bid leaves those two sites booked as a fought loss. The two sibling writers on the
 * identical event disagree: the wake-side retire writes no `won` key at all and the read-closed
 * branch writes `cur.won ?? null`. One method family disagreeing with itself is the defect.
 *
 * THE COST IS NOT THE WIN-RATE REPORT. bidLogger, eodReport, heartbeat, engineAlerts and directorEod
 * all test `won === true`, so false and null collapse for every one of them. The cost is the
 * rehydrate grace, whose gate is `it.won == null && pastByMs < this.cfg.rehydrateGraceMs`: a phantom
 * false costs a never-bid load the 600s window that exists to let a soft auction outlive its
 * published close, so the load that closed 0 ms ago is booked MORE definitely than the identical
 * load that closed 11 minutes ago.
 *
 * WHAT MUST NOT MOVE:
 *   - a recorded win still retires as won:true (check 2), at BOTH writers.
 *   - a genuinely fought loss still retires as won:false (check 3), at BOTH writers. The repair is a
 *     coalesce change; a blanket `won: null` write would satisfy every mechanism check below and
 *     corrupt the ledger in the other direction.
 *
 * Check 6 ships in the same commit as the T2 D2 grace repair, which stops the near copy being
 * retired at all, so it asserts definiteness(near) <= definiteness(far) and never the near copy's
 * status - it holds under a D3-only fix (near retired, won null) and under the combined fix (near
 * not retired, won still null).
 *
 * Offline and deterministic: fake adapter, temp-file intent stores under os.tmpdir(), no network,
 * no wall-clock waits - the scheduled wake is planned at delay 0, so the _wakeFailed checks drain
 * the macrotask queue instead. placeBid throws - no bid may be placed on any of these paths.
 *
 *   node scripts/test-retire-unknown-outcome-not-lost.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmpFile = () => {
  const f = path.join(os.tmpdir(), `retire-unknown-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
// The scheduled wake is planned at delay 0 here (startsAt is inside armLeadMs), so draining the
// macrotask queue reaches the same state a wall-clock wait would, without depending on one.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

const intent = (id, over) => Object.assign({
  auctionId: id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft SXL',
  units: 1, quoteType: 'FTL', bidVehicleCount: 1,
  companyName: 'Havells India', branchName: 'Alwar', platformKey: 'superprocure', rules: null,
  cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [56_300, 53_600, 53_150],
  status: 'scheduled', firedRungs: [], everBid: false, landedBids: 0, finalRank: null, won: null,
}, over);

// `live` is what the wake's re-read answers. ok:false is the "no usable read -> arm anyway" branch,
// the shortest deterministic route from a wake to arm() and so to _wakeFailed.
function mkEngine(intents, { live = { ok: false, error: 'harness: no platform read' } } = {}) {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), intents }), 'utf8');
  const events = [];
  const adapter = {
    writeEnabled: false,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => live,
    placeBid: async () => { throw new Error('placeBid reached - no bid may fire on a retire path'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), { onEvent: (e) => events.push(e), log: SILENT });
  eng.log = SILENT;
  eng._events = events;
  return eng;
}

const throwingArm = () => {
  const err = new Error('ceiling cap altered the floor rung (14200 != 13800)');
  err.code = 'FLOOR';
  throw err;
};

const recOf = (eng, id) => eng.scheduler.get(id) || {};
const wonOf = (eng, id) => { const it = recOf(eng, id); return ('won' in it) ? it.won : '(key absent)'; };
const show = (v) => JSON.stringify(v);
const definiteness = (rec) => (rec.won == null ? 0 : 1);

(async () => {
  // ------------------------------------------------------- 1. precondition: the reference branch
  {
    const now = Date.now();
    const eng = mkEngine([intent('R-REF', { won: null, startsAt: now - 1_260_000, closesAt: now - 1_200_000 })]);
    await eng.rehydrate();
    const rec = recOf(eng, 'R-REF');
    assert.strictEqual(rec.status, 'closed', 'setup: a never-bid intent 20 minutes past close is retired by the sweep');
    assert.ok('won' in rec, 'setup: the retire must write a won key at all');
    assert.strictEqual(rec.won, null,
      'setup: the reference writer (_retireIfPastClose -> _persistClosedWhileDown) records UNKNOWN, and '
      + 'null survives the durable store round-trip - without this the checks below cannot tell null from a drop');
    assert.ok(eng._events.some((e) => e.type === 'closed_while_down' && e.auctionId === 'R-REF'),
      'setup: and it reaches the ledger as closed_while_down, not as a loss');
    eng.kill('done');
    ok('precondition: the sibling retire records UNKNOWN and null round-trips the durable store');
  }

  // ------------------------------------------------------- ARRANGE: both writers, three outcomes
  const PAST = Date.now() - 1_200_000; // 20 minutes past close - well outside the 600s rehydrate grace
  const planEng = mkEngine([
    intent('PLAN-UNKNOWN', { won: null, startsAt: PAST - 60_000, closesAt: PAST }),
    intent('PLAN-WON', { won: true, startsAt: PAST - 60_000, closesAt: PAST }),
    intent('PLAN-LOST', { won: false, startsAt: PAST - 60_000, closesAt: PAST }),
  ]);
  // kill()+resume() is the only public route back into _planWake carrying an intent that ALREADY
  // holds an outcome: rehydrate's sweep retires those at _retireIfPastClose before the re-arm loop.
  planEng.kill('harness');
  planEng.resume();

  const wakeEng = {};
  for (const [id, won] of [['WAKE-UNKNOWN', null], ['WAKE-WON', true], ['WAKE-LOST', false]]) {
    const t = Date.now();
    const eng = mkEngine([intent(id, { won, startsAt: t + 400, closesAt: t + 900_000 })]);
    eng.arm = throwingArm;
    await eng.rehydrate();
    wakeEng[id] = eng;
  }
  await settle();
  await settle();

  // ------------------------------------------------------- 2. CONTROL: a recorded win survives
  {
    assert.strictEqual(recOf(planEng, 'PLAN-WON').status, 'closed', 'setup: the plan-time retire ran on the won copy');
    assert.strictEqual(recOf(wakeEng['WAKE-WON'], 'WAKE-WON').status, 'closed', 'setup: the stranded-load retire ran on the won copy');
    assert.strictEqual(wonOf(planEng, 'PLAN-WON'), true,
      'CONTROL BROKEN: _planWake\'s plan-time retire lost a RECORDED WIN (got ' + show(wonOf(planEng, 'PLAN-WON'))
      + '). The repair is a coalesce change - `?? false` to `?? null` - never a blanket null write.');
    assert.strictEqual(wonOf(wakeEng['WAKE-WON'], 'WAKE-WON'), true,
      'CONTROL BROKEN: _wakeFailed\'s stranded-load retire lost a RECORDED WIN (got '
      + show(wonOf(wakeEng['WAKE-WON'], 'WAKE-WON')) + ').');
    ok('CONTROL: a recorded win survives both retire writers');
  }

  // ------------------------------------------------------- 3. CONTROL: a fought loss stays false
  {
    assert.strictEqual(recOf(planEng, 'PLAN-LOST').status, 'closed', 'setup: the plan-time retire ran on the lost copy');
    assert.strictEqual(recOf(wakeEng['WAKE-LOST'], 'WAKE-LOST').status, 'closed', 'setup: the stranded-load retire ran on the lost copy');
    assert.strictEqual(wonOf(planEng, 'PLAN-LOST'), false,
      'CONTROL BROKEN: _planWake\'s plan-time retire discarded a GENUINE FOUGHT LOSS (got '
      + show(wonOf(planEng, 'PLAN-LOST')) + '). A blanket null write would satisfy checks 4-6 and corrupt '
      + 'the ledger in the other direction.');
    assert.strictEqual(wonOf(wakeEng['WAKE-LOST'], 'WAKE-LOST'), false,
      'CONTROL BROKEN: _wakeFailed\'s stranded-load retire discarded a GENUINE FOUGHT LOSS (got '
      + show(wonOf(wakeEng['WAKE-LOST'], 'WAKE-LOST')) + ').');
    ok('CONTROL: a genuinely fought loss stays false at both retire writers');
  }

  // ------------------------------------------------------- 4. WRITER 1: _planWake's plan-time retire
  {
    assert.strictEqual(recOf(planEng, 'PLAN-UNKNOWN').status, 'closed', 'setup: the never-bid copy was retired at plan time');
    assert.strictEqual(wonOf(planEng, 'PLAN-UNKNOWN'), null,
      'PHANTOM LOSS at _planWake\'s plan-time retire: `won: it.won ?? false` collapsed the tri-state. The '
      + 'intent carried won:null (UNKNOWN - a human priced it and nobody ever bid) and the retire booked it '
      + 'as a DEFINITE LOSS (won=' + show(wonOf(planEng, 'PLAN-UNKNOWN')) + '). The doctrine above '
      + '_retireIfPastClose is "keep any recorded outcome, else mark unknown"; the sibling writers on the '
      + 'same event class leave it null. A false here also costs the load the 600s rehydrate grace, whose '
      + 'gate reads `it.won == null && pastByMs < this.cfg.rehydrateGraceMs`.');
    ok('the plan-time retire of a never-bid intent records UNKNOWN, not a loss');
  }

  // ------------------------------------------------------- 5. WRITER 2: _wakeFailed's stranded retire
  {
    const eng = wakeEng['WAKE-UNKNOWN'];
    assert.ok(eng._events.some((e) => e.kind === 'wake_arm_failed' && e.auctionId === 'WAKE-UNKNOWN'),
      'setup: arm() threw at the wake and the load was reported stranded');
    assert.strictEqual(recOf(eng, 'WAKE-UNKNOWN').status, 'closed', 'setup: the stranded load was retired');
    assert.strictEqual(wonOf(eng, 'WAKE-UNKNOWN'), null,
      'PHANTOM LOSS at _wakeFailed\'s stranded-load retire: the SECOND `won: it.won ?? false`. arm() threw, '
      + 'so this load never reached the platform at all, and it was booked as a DEFINITE LOSS (won='
      + show(wonOf(eng, 'WAKE-UNKNOWN')) + '). This site is pinned independently of check 4 on purpose - '
      + 'repairing only one of the two leaves the other still writing a phantom loss.');
    ok('the stranded-load retire in _wakeFailed records UNKNOWN, not a loss');
  }

  // ------------------------------------------------------- 6. definiteness is monotone in lateness
  {
    const retireOnce = async (pastByMs) => {
      const t = Date.now();
      const eng = mkEngine([intent('MONO', { won: null, startsAt: t - pastByMs - 60_000, closesAt: t - pastByMs })]);
      await eng.rehydrate();
      const rec = recOf(eng, 'MONO');
      eng.kill('done');
      return rec;
    };
    const near = await retireOnce(0);
    const far = await retireOnce(660_000);
    assert.ok(definiteness(near) <= definiteness(far),
      'MONOTONICITY VIOLATED: the intent that closed 0 ms ago was booked with a MORE definite outcome (won='
      + show(near.won) + ') than the identical intent that closed 11 minutes ago (won=' + show(far.won) + '). '
      + 'rehydrateGraceMs exists to make the NEAR case LESS settled, not more: the grace keeps the near copy '
      + 'out of _retireIfPastClose, and _planWake then retires it anyway through `won: it.won ?? false`. '
      + 'definiteness(near)=' + definiteness(near) + ' must be <= definiteness(far)=' + definiteness(far));
    ok('definiteness of the recorded outcome is monotone non-increasing in how late the close is');
  }

  planEng.kill('done');
  for (const eng of Object.values(wakeEng)) eng.kill('done');
  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 6;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
