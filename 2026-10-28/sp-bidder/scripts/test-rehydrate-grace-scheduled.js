'use strict';
/**
 * THE GRACE ONLY HALF THE ENGINE HONOURS - rehydrate() retiring what its own sweep just spared.
 *
 * Regression target: bid-command bug hunt 2026-09-16, finding BH-BOUNDARY-1, disposition T2 D2
 * (upheld_confirmed, deterministic 3/3).
 *
 * _retireIfPastClose will NOT retire an intent whose close passed less than cfg.rehydrateGraceMs
 * ago with no outcome on the record (`mayStillBeLive`), because a soft auction runs past every
 * close it publishes and a terminal branch may not resolve that doubt from a timestamp. rehydrate()
 * therefore leaves such an intent in stillOpen and counts it into "resumed N live auction(s)". Its
 * own re-arm loop then hands every stillOpen 'scheduled' intent straight to _planWake, whose close
 * test is a bare `it.closesAt <= Date.now()` carrying no grace rule at all, and which writes
 * `{ status: 'closed', won: it.won ?? false }`. So the intent the sweep deliberately preserved as
 * possibly-live is terminally retired - and booked as a definite LOSS on a load that never bid -
 * inside the same rehydrate() call that announced it as resumed. An ordinary pm2 restart reaches it.
 *
 * THE DOCTRINE BINDS BOTH RETIRES IN _planWake. The plan-time branch above is only half of it: the
 * wake() closure the function then arms carries the same graceless test (`planned.closesAt <=
 * Date.now()` -> `status: 'closed'`) and finishes the job one macrotask later. A fix applied to the
 * plan branch alone leaves the intent 'scheduled' at rehydrate() return and 'closed' on the box, so
 * check 8 flushes the timer queue and re-asserts - it is the only check that can tell those apart.
 *
 * WHAT MUST NOT MOVE:
 *   - an intent PAST the grace is still retired (check 2), at BOTH doors: by the sweep, and inside
 *     _planWake itself, reached through schedule() because the sweep never screens that door. A fix
 *     that grants unbounded grace resurrects every genuinely dead load, and this is what catches it.
 *   - the armed-path twin with a byte-identical close still survives (check 3). That is the same
 *     doctrine where it is already honoured, so it proves the split is the 'scheduled' branch and
 *     not the close value - and that this harness can still observe a surviving intent at all.
 *
 * Check 7 asserts only that the restart banner's count and the still-open set AGREE for this
 * fixture, which the grace fix alone makes true; the announce-ORDER defect (the notice is emitted
 * before the re-arm loop runs) is T2 D8 and is deliberately outside this cluster's scope.
 *
 * Offline and deterministic: fake adapter whose read always fails and whose placeBid throws,
 * temp-file scheduler, no network. No tuned sleep either - check 8 flushes explicit macrotask turns
 * rather than waiting a chosen number of milliseconds.
 *
 *   node scripts/test-rehydrate-grace-scheduled.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const GRACE = 600_000;
const T0 = Date.now();
const FILE = path.join(os.tmpdir(), `rehydrate-grace-${process.pid}-${T0}.json`);
const cleanup = () => { for (const f of [FILE, FILE + '.tmp']) { try { fs.unlinkSync(f); } catch (_) {} } };

const intent = (id, status, closesAt) => ({
  auctionId: id, status, closesAt,
  startsAt: T0 - 30 * 60_000,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Havells India', cost: 50_000, marginsPct: [12.6, 7.2, 6.3],
  firedRungs: [], won: null, finalRank: null, createdAt: T0 - 3_600_000,
});

// The 60s standoff off each band edge: an intent within ~10ms of the grace bound genuinely flips
// branch on boot timing, so neither probe may sit at grace-1ms.
fs.writeFileSync(FILE, JSON.stringify({ savedAt: T0, intents: [
  intent('SCHED-JUST-CLOSED', 'scheduled', T0 - 1),
  intent('SCHED-NEAR-GRACE', 'scheduled', T0 - (GRACE - 60_000)),
  intent('SCHED-PAST-GRACE', 'scheduled', T0 - (GRACE + 60_000)),
  intent('BID-JUST-CLOSED', 'bidding', T0 - 1),
] }));

const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  getAuctionState: async () => ({ ok: false, error: 'ECONNRESET' }),
  placeBid: async () => { throw new Error('placeBid must never be reached on the rehydrate path'); },
};
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const events = [];
const eng = new BidEngine(adapter, new DurableScheduler(FILE), {
  onEvent: (e) => events.push(e), log,
});

const st = (id) => (eng.scheduler.get(id) || {}).status;
const won = (id) => (eng.scheduler.get(id) || {}).won;
const retiredAlertsFor = (id) => events.filter(
  (e) => e.type === 'alert' && e.kind === 'wake_retired_past_close' && e.auctionId === id);

// rehydrate() holds no await point, so every assertion below it runs before the delay-0 wake timers
// it armed have had a turn. Explicit turns rather than a tuned sleep: one timer turn for the wake
// callback, then immediate turns for the platform read it awaits.
const flushTimerQueue = async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

(async () => {
  // ------------------------------------------------- 1. the fixture, before anything runs
  {
    assert.strictEqual(eng.cfg.rehydrateGraceMs, GRACE,
      'the fixture is built around a 600s grace - if cfg.rehydrateGraceMs moved, the probe points moved with it');
    for (const id of ['SCHED-JUST-CLOSED', 'SCHED-NEAR-GRACE', 'SCHED-PAST-GRACE']) {
      assert.strictEqual(st(id), 'scheduled', `${id} must load as a 'scheduled' intent`);
    }
    assert.strictEqual(st('BID-JUST-CLOSED'), 'bidding', 'the control twin must load on the armed path');
    for (const id of ['SCHED-JUST-CLOSED', 'SCHED-NEAR-GRACE', 'SCHED-PAST-GRACE', 'BID-JUST-CLOSED']) {
      assert.strictEqual(won(id), null, `${id} must carry an UNKNOWN outcome - the grace only applies to won == null`);
      assert.ok(eng.scheduler.get(id).closesAt < Date.now(), `${id} must load with its close already passed`);
    }
    assert.strictEqual(eng.scheduler.get('BID-JUST-CLOSED').closesAt,
      eng.scheduler.get('SCHED-JUST-CLOSED').closesAt,
      'the control must carry a byte-identical close, or it is not a control for the path');
    ok('four unknown-outcome intents load with closes placed either side of the grace bound');
  }

  await eng.rehydrate();
  const notice = events.find((e) => e.type === 'alert' && e.kind === 'restart_with_live_auctions');

  // ------------------------------------------------- 2. control: past the grace, the close stands
  {
    assert.strictEqual(st('SCHED-PAST-GRACE'), 'closed',
      `control broken: an intent ${GRACE + 60_000}ms past close is OUTSIDE the grace and must still be retired by the sweep, got '${st('SCHED-PAST-GRACE')}'`);
    // The sweep retires that one before the re-arm loop runs, so it never reaches _planWake at all.
    // schedule() is the door into the same retire that the sweep does not screen.
    eng.schedule({ id: 'PLANWAKE-PAST-GRACE', lane: { origin: 'Bhiwandi', destination: 'Hosur' },
      equipment: '32ft SXL', units: 1, companyName: 'Havells India',
      startsAt: T0 - 30 * 60_000, closesAt: T0 - (GRACE + 60_000) },
    { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    assert.strictEqual(st('PLANWAKE-PAST-GRACE'), 'closed',
      `control broken: _planWake's own retire must still stand past the grace, got '${st('PLANWAKE-PAST-GRACE')}' - a grace with no upper bound abandons every genuinely dead load`);
    assert.ok(retiredAlertsFor('PLANWAKE-PAST-GRACE').some((e) => e.branch === 'plan'),
      "control broken: the past-grace retire must come from _planWake's plan branch, or this check is not on the bound it claims");
    ok('an intent past the grace is still retired, by the sweep AND inside _planWake (the bound holds)');
  }

  // ------------------------------------------------- 3. control: the armed twin survives
  {
    assert.notStrictEqual(st('BID-JUST-CLOSED'), 'closed',
      `control broken: the 'bidding' intent with the identical close must survive the grace, got '${st('BID-JUST-CLOSED')}'`);
    assert.ok(eng.monitors.has('BID-JUST-CLOSED'),
      'control broken: the armed-path twin must come back watched, or this harness cannot observe a survivor');
    ok('the armed-path twin with a byte-identical close survives the same rehydrate (live control)');
  }

  // ------------------------------------------------- 4. THE DEFECT: retired inside the grace
  {
    assert.ok(eng.scheduler.get('SCHED-JUST-CLOSED'),
      'SCHED-JUST-CLOSED must still be ON the record - a grace that deletes the intent loses the load as completely as retiring it');
    assert.notStrictEqual(st('SCHED-JUST-CLOSED'), 'closed',
      `_planWake retired an intent 1ms past close on a bare 'closesAt <= Date.now()', bypassing _retireIfPastClose's mayStillBeLive grace which had just preserved it: got '${st('SCHED-JUST-CLOSED')}'`);
    ok('a scheduled intent 1ms past close is not retired by _planWake inside the grace');
  }

  // ------------------------------------------------- 5. and booked as a definite loss
  {
    assert.strictEqual(won('SCHED-JUST-CLOSED'), null,
      "_planWake's retire writes `won: it.won ?? false`, booking a definite LOSS on a load that never bid and may still be running - the outcome must stay UNKNOWN at null, the way _retireIfPastClose leaves it");
    ok('a scheduled intent inside the grace is not booked as a loss - its outcome stays null');
  }

  // ------------------------------------------------- 6. the far edge of the same band
  {
    assert.ok(eng.scheduler.get('SCHED-NEAR-GRACE'),
      'SCHED-NEAR-GRACE must still be ON the record - a grace that deletes the intent loses the load as completely as retiring it');
    assert.notStrictEqual(st('SCHED-NEAR-GRACE'), 'closed',
      `_planWake retired an intent ${GRACE - 60_000}ms past close - still inside cfg.rehydrateGraceMs - because its close test carries no mayStillBeLive rule: got '${st('SCHED-NEAR-GRACE')}'`);
    ok('a scheduled intent 9 minutes past close, still inside the grace, is not retired');
  }

  // ------------------------------------------------- 7. the banner describes what is open
  {
    const ids = ['SCHED-JUST-CLOSED', 'SCHED-NEAR-GRACE', 'SCHED-PAST-GRACE', 'BID-JUST-CLOSED'];
    const stillOpen = ids.filter((id) => st(id) !== 'closed');
    assert.ok(notice, 'the restart notice must fire');
    assert.strictEqual(notice.count, stillOpen.length,
      `the restart banner says ${notice.count} resumed while ${stillOpen.length} intent(s) are still open once rehydrate() returned - _planWake retired inside the same call that counted them live`);
    ok('the restart banner count agrees with what is actually still open after rehydrate()');
  }

  // ------------------------------------------- 8. THE DEFECT, one macrotask later: the wake branch
  {
    await flushTimerQueue();
    for (const id of ['SCHED-JUST-CLOSED', 'SCHED-NEAR-GRACE']) {
      assert.ok(eng.scheduler.get(id), `${id} must still be on the record once the wake timer has run`);
      assert.notStrictEqual(st(id), 'closed',
        `${id} survived rehydrate() and was then retired by _planWake's OTHER graceless test - the wake() closure's bare 'planned.closesAt <= Date.now()' - so the doctrine holds only until the timer fires and the box still loses the load: got '${st(id)}'`);
      assert.strictEqual(won(id), null,
        `${id} must still carry an UNKNOWN outcome after the wake turn - mayStillBeLive applies to every retire in _planWake, not just the plan-time one`);
      assert.deepStrictEqual(retiredAlertsFor(id).map((e) => e.branch), [],
        `${id} raised wake_retired_past_close inside the grace - _planWake told the desk the auction was over while _retireIfPastClose was still treating it as possibly live`);
    }
    ok("the in-grace intents survive the wake turn too - both of _planWake's retires honour the grace");
  }

  eng.kill('done');
  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 8;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  try { eng.kill('done'); } catch (_) {}
  cleanup();
  console.error(e);
  process.exit(1);
});
