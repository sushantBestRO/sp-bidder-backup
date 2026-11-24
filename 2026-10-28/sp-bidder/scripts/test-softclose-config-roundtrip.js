'use strict';
/**
 * setSoftClose IS A WHOLESALE REPLACE, AND A DROPPED FIELD UN-BOUNDS THE MONEY PATH.
 *
 * `bidEngine.setSoftClose` does not merge - it assigns a fresh object literal over `this.softCfg`.
 * Any key the constructor seeds (DEFAULT_SOFT) that the literal omits is therefore DELETED, silently,
 * with no error anywhere. And this is not a rare operator action: `server.js:4430` runs
 * `applyConfigValues(await configStore.get())` at BOOT, after the engines are constructed, and
 * `applyConfigValues` (`server.js:4290`) calls `e.setSoftClose(next.softClose)` on every engine. So an
 * omission here is gone on EVERY process start, not merely after somebody saves Settings.
 *
 * The field this file exists for is `lastResortFloorAttempts`. `_lastResortFloor`'s bound reads
 * `attempts >= this.softCfg.lastResortFloorAttempts`, and in JavaScript `n >= undefined` is false for
 * EVERY n - 0, 3, 1e9 alike, because the comparison is NaN. Drop the field and the never-forfeit
 * release stops being bounded at all. That matters most on exactly the loads it was built for: when
 * SuperProcure refuses the write (`Load not available for bidding`, `Amount is invalid. Amount should
 * be less than or equal to ...` - 135 of them in the 7 days to 2026-08-01) the rejection restore puts
 * `snipeFired` back, which re-opens the guard above, leaving this bound as the only limit. Unbounded
 * there is roughly one refused write per hot poll inside the 2.5s last-chance window, on the master
 * account BRL's own desk operators share.
 *
 * DEFAULT_SOFT's own comment names that outcome as the reason the bound is explicit rather than
 * "whatever maxBidsPerMin leaves over" - so dropping the field reverts the code to precisely the
 * failure mode the field was added to prevent.
 *
 * The load-bearing case here is R2, not R3. R3 pins the one field that was actually missing; R2 pins
 * the GENERAL invariant - every DEFAULT_SOFT key survives the round-trip - so the NEXT field somebody
 * adds to DEFAULT_SOFT and forgets to add to setSoftClose fails here instead of in production.
 *
 * Offline and deterministic: no adapter write is ever reachable (the fake adapter's placeBid throws),
 * no network, no clock waits, no timers armed.
 *
 *   node scripts/test-softclose-config-roundtrip.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine, DEFAULT_SOFT } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// ---------------------------------------------------------------------------
// Completion sentinel, registered BEFORE any case runs.
//
// scripts/run-tests.js grades a test file by its EXIT CODE ALONE. A file that returns early - an
// exception swallowed by a bare catch, an early `return`, a require that resolves to undefined -
// exits 0 and is scored as a silent green pass with zero assertions. Registering this at the BOTTOM
// of the file would be exactly as broken as an inline assert, because an early return never reaches
// the registration either. Setting `process.exitCode` inside an 'exit' listener overrides an explicit
// process.exit(0), which is what makes this catch the injected-early-exit proof.
// ---------------------------------------------------------------------------
const EXPECTED = 7;
let passed = 0;
process.on('exit', () => {
  if (passed !== EXPECTED) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${passed} of ${EXPECTED} cases - this file exited ` +
      `early, or cases were added/removed without updating EXPECTED. This run is NOT a pass.`);
    process.exitCode = 1;
  }
});
function ok(name) { passed++; console.log('  ok  ', name); }

const TMPS = [];
function tmp() {
  const p = path.join(os.tmpdir(), `softclose-roundtrip-${process.pid}-${TMPS.length}.json`);
  TMPS.push(p);
  return p;
}

// placeBid THROWS: nothing in this file may reach a wire, and if a future edit makes one of these
// cases drive a bid path, the throw makes that loud rather than silent.
const adapter = {
  capabilities: () => ({ rankVisible: true }),
  placeBid: () => { throw new Error('test-softclose-config-roundtrip must never place a bid'); },
};

function makeEngine(softOver) {
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: Object.assign({ enabled: true, shippers: ['Havells'], mode: 'live' }, softOver || {}),
    onEvent: () => {},
  });
}

// The shape server.js persists and replays: configStore holds the OPERATOR-facing soft-close block,
// which is what a Settings save and the boot hydration both pass in. It deliberately does NOT carry
// every DEFAULT_SOFT key - that asymmetry is the whole hazard.
const OPERATOR_SAVE = { enabled: true, shippers: ['Havells', 'KEI'], mode: 'live' };

console.log('\nsoft-close config round-trip (setSoftClose is a wholesale replace)\n');

// --- R1 ------------------------------------------------------------------------------------------
// The premise. If setSoftClose ever becomes a merge, this file's reason for existing changes, so state
// the premise as an assertion rather than a comment.
{
  const eng = makeEngine();
  const before = eng.softCfg;
  eng.setSoftClose({ mode: 'shadow' });
  assert.notStrictEqual(eng.softCfg, before,
    'setSoftClose is expected to REPLACE softCfg, not mutate it in place - if it now mutates, the ' +
    'dropped-field hazard this file guards may no longer apply and the file should be revisited');
  assert.strictEqual(eng.softCfg.mode, 'shadow', 'the field that WAS passed must be applied');
  ok('R1 setSoftClose replaces softCfg wholesale (the premise this file guards)');
}

// --- R2 ------------------------------------------------------------------------------------------
// THE GENERAL INVARIANT. Every key DEFAULT_SOFT seeds must survive a save that does not mention it.
// This is the case that catches the NEXT omission, not just the one that happened.
{
  const eng = makeEngine();
  const seeded = Object.keys(DEFAULT_SOFT);
  assert.ok(seeded.length >= 7, 'DEFAULT_SOFT should seed at least the 7 known keys');

  eng.setSoftClose(OPERATOR_SAVE);

  const missing = seeded.filter((k) => eng.softCfg[k] === undefined);
  assert.deepStrictEqual(missing, [],
    `setSoftClose DROPPED these DEFAULT_SOFT keys: [${missing.join(', ')}]. setSoftClose assigns a ` +
    'fresh literal, so every DEFAULT_SOFT field must be listed in it explicitly. Add the missing ' +
    'field(s) there with the same Number.isFinite guard the siblings use.');
  ok('R2 every DEFAULT_SOFT key survives a partial save (catches the NEXT dropped field)');
}

// --- R3 ------------------------------------------------------------------------------------------
// The specific field, and the specific arithmetic that made its absence invisible.
{
  const eng = makeEngine();
  eng.setSoftClose(OPERATOR_SAVE);

  const bound = eng.softCfg.lastResortFloorAttempts;
  assert.notStrictEqual(bound, undefined,
    'lastResortFloorAttempts was deleted by a save that never mentioned it - _lastResortFloor is now ' +
    'unbounded, because `n >= undefined` is false for every n');
  assert.ok(Number.isFinite(bound), `the bound must be finite, got ${bound}`);
  assert.strictEqual(bound, DEFAULT_SOFT.lastResortFloorAttempts,
    'a save that does not mention the bound must leave it at the seeded value');

  // The arithmetic, asserted rather than described - this is WHY a dropped field is silent.
  for (const n of [0, 1, 3, 1e9]) {
    assert.strictEqual(n >= undefined, false,
      `n >= undefined must be false (n=${n}) - this is the comparison that hides the dropped field`);
  }
  ok('R3 the never-forfeit bound survives, and `n >= undefined` is false for every n');
}

// --- R4 ------------------------------------------------------------------------------------------
// The BOOT sequence specifically. This is the real production path and the reason the bug was not a
// Settings-only edge case: engines are constructed, THEN applyConfigValues -> setSoftClose runs.
{
  const eng = makeEngine();
  assert.ok(Number.isFinite(eng.softCfg.lastResortFloorAttempts),
    'constructor must seed the bound (it does - which is why nothing caught the deletion downstream)');

  // server.js:4430 -> applyConfigValues(configStore.get()) -> server.js:4290 -> e.setSoftClose(...)
  eng.setSoftClose(OPERATOR_SAVE);

  assert.ok(Number.isFinite(eng.softCfg.lastResortFloorAttempts),
    'after the BOOT hydration the bound must still be finite - if this fails, the bound is undefined ' +
    'on every process start, not just after an operator saves Settings');
  ok('R4 the boot hydration (constructor -> applyConfigValues -> setSoftClose) keeps the bound');
}

// --- R5 ------------------------------------------------------------------------------------------
// A surviving field is not the same as an ENFORCED one. Drive the real guard past its bound.
{
  const eng = makeEngine();
  eng.setSoftClose(OPERATOR_SAVE);
  const bound = eng.softCfg.lastResortFloorAttempts;

  const ladder = [90_000, 85_000, 80_000, 74_410];
  const monitor = {
    auctionId: 'RT1', ladder, firedRungs: new Set(), landedBids: 0, snipeFired: false,
    currentRungIndex: -1, revisionsLeft: 28, extendsObserved: 0, extendCap: 1, triggerWindowMs: null,
    _lastResortFloorAttempts: 0,
  };
  const state = { myRank: 5 };
  const last = ladder.length - 1;

  // The poll count is a LITERAL, deliberately not `bound + n`. With the bug present `bound` is
  // undefined, so `i < bound + 5` is `i < NaN` and the loop body never runs - the case would still go
  // red, but on `0 !== undefined` having never once observed an unbounded release. A fixed count makes
  // the failure the real one: on the buggy build this loop records 50 releases where 3 is correct,
  // which is the actual production shape (one refused write per hot poll inside the 2.5s window).
  const HOT_POLLS = 50;
  assert.ok(Number.isFinite(bound) && bound < HOT_POLLS,
    `this case only proves anything if the bound is finite and well under ${HOT_POLLS}; got ${bound}`);

  let releases = 0;
  for (let i = 0; i < HOT_POLLS; i++) {
    const d = eng._lastResortFloor(monitor, state, 1_200, last);   // 1200 <= floorWindowMs 2500
    if (d) {
      releases++;
      assert.strictEqual(d.price, ladder[last], 'a release must offer the floor rung, never another');
      assert.strictEqual(d.lastResort, true, 'a release must be marked lastResort');
    }
  }
  assert.strictEqual(releases, bound,
    `the guard must release exactly ${bound} times across ${HOT_POLLS} hot polls and then stand down; ` +
    `got ${releases}. ${releases === HOT_POLLS ? 'EVERY poll released - the bound is not being applied ' +
    'at all, which is one refused write per hot poll on the account BRL operators share. ' : ''}`);
  ok('R5 the bound is ENFORCED after a save, not merely present');
}

// --- R6 ------------------------------------------------------------------------------------------
// A malformed operator value must never land the bound on `undefined` - that would un-bound the guard
// through the "validated" path instead of the omitted one. It never does.
//
// But the guard is `Number.isFinite(Number(x))`, and JS coerces null, [], '' and false to 0 - all
// FINITE. Those therefore pass validation and set the bound to ZERO, which disables the never-forfeit
// release outright: `0 >= 0` is true on the very first call, so the reserved floor is never offered and
// the load forfeits. That is the Rs 1,25,000 Havells Alwar failure mode, arrived at through a
// "successful" config save rather than a dropped field.
//
// Pinned AS IT ACTUALLY IS, deliberately, with the edge named - so a future fix has to update this
// assertion on purpose rather than drift past it. Not reachable from the console today (configStore's
// persisted softClose block does not carry this key), and the same coercion applies identically to the
// three sibling fields, so this is a pre-existing pattern rather than something the bound introduced.
// Recorded as a finding; not fixed here, because narrowing one field's guard and not its siblings'
// would be a worse inconsistency than the edge itself.
{
  const eng = makeEngine();
  const seeded = eng.softCfg.lastResortFloorAttempts;

  // Genuinely non-numeric -> Number() is NaN -> guard rejects -> current value kept. The safe class.
  for (const bad of ['abc', NaN, {}, 'three', undefined]) {
    eng.setSoftClose({ lastResortFloorAttempts: bad });
    assert.strictEqual(eng.softCfg.lastResortFloorAttempts, seeded,
      `a non-numeric bound (${String(bad)}) must keep the CURRENT value`);
  }

  // Coerces-to-zero -> guard ACCEPTS -> bound becomes 0 -> never-forfeit is off. The sharp edge.
  for (const zeroish of [null, [], '', false]) {
    const e2 = makeEngine();
    e2.setSoftClose({ lastResortFloorAttempts: zeroish });
    assert.strictEqual(e2.softCfg.lastResortFloorAttempts, 0,
      `Number(${JSON.stringify(zeroish)}) is 0 and passes Number.isFinite, so the bound lands on 0. ` +
      'If this assertion now fails, someone tightened the guard - update this case deliberately.');
    assert.ok(Number.isFinite(e2.softCfg.lastResortFloorAttempts),
      'even at the sharp edge the bound must stay FINITE - undefined is the unbounded case R3 guards');
  }
  ok('R6 non-numeric bounds fall back; null/[]/""/false coerce to 0 (named sharp edge, pinned as-is)');
}

// --- R7 ------------------------------------------------------------------------------------------
// The field is still genuinely operator-settable - a guard that ignores every input is not a guard.
{
  const eng = makeEngine();
  eng.setSoftClose({ lastResortFloorAttempts: 5 });
  assert.strictEqual(eng.softCfg.lastResortFloorAttempts, 5, 'an explicit valid override must apply');
  eng.setSoftClose({ lastResortFloorAttempts: '2' });
  assert.strictEqual(eng.softCfg.lastResortFloorAttempts, 2,
    'a numeric string must coerce, matching the sibling fields');
  eng.setSoftClose(OPERATOR_SAVE);
  assert.strictEqual(eng.softCfg.lastResortFloorAttempts, 2,
    'a later save that does not mention the bound must preserve the OVERRIDE, not reset to the default');
  ok('R7 an explicit override applies, coerces, and survives a later unrelated save');
}

for (const p of TMPS) { try { fs.unlinkSync(p); } catch (_) {} }
console.log(`\nsoft-close config round-trip: ${passed}/${EXPECTED} cases passed\n`);
