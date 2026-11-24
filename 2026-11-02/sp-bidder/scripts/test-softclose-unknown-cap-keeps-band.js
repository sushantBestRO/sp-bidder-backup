'use strict';
/**
 * SOFT-CLOSE UNKNOWN CAP KEEPS THE BAND - a positive pin for the soft-close fix after the extension cap.
 *
 * The soft-close fix removes the 100-102.5 s decisive band for a KNOWN extension cap that is used up: after the cap
 * the final bid goes in the last 2.5 s like hard close. That removal is scoped to the known cap. When
 * SuperProcure does not publish the cap (extendCap null) the engine fails closed to "treat the believed
 * close as final", and the band, the poll aimed at it, and the floor landing inside it stay exactly as
 * today. extendCap 0 (a hard window wearing a soft close model) never had a band and keeps its floor at
 * the buzzer.
 *
 * Must NOT move, and pinned here:
 *   1 unknown-cap-band      the floor reaches the wire with remaining in (100,000, 102,500], driven
 *                           through the real _maybeBid at production cadence on a virtual clock.
 *   2 unknown-cap-cadence   _cadence(130,000) aims at the band: 28,125 ms with jitter 0. CONTROL in the
 *                           same case: a load whose extensions remain keeps the plain 30,000 ms far poll.
 *   3 cap-zero-no-band      extendCap 0: nothing in (2,500, 102,500], the floor at <= 2,500 ms. This is
 *                           also the harness control for case 1 - the same drive reports a buzzer floor
 *                           when there is no band, so a band result in case 1 is the engine, not the rig.
 *
 * Deliberately NOT pinned: anything after the unknown-cap band shot (the soft-close fix lets the floor follow a
 * non-floor band shot when outranked).
 *
 *   node scripts/test-softclose-unknown-cap-keeps-band.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const TRIGGER_MS = 100_000;
const EXTEND_MS = 120_000;
const FLOOR_WINDOW_MS = 2_500;
const BAND_OPENS = TRIGGER_MS + FLOOR_WINDOW_MS;

let seq = 0;
let ran = 0;
let pass = 0;
const FAILURES = [];
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-unknown-cap-band-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const EXPECTED_CASES = 3;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nPASS - soft-close unknown cap keeps the band: ${pass}/${EXPECTED_CASES} cases`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

async function runAsync(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

// placeBid records the countdown the engine was driven at when the write went out.
function mkEngine() {
  const clock = { remaining: null };
  const sent = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { sent.push({ price, remaining: clock.remaining });
      return { accepted: true, status: 201, myRank: null, revisionsLeft: null }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return { eng, clock, sent };
}

// Allowlisted soft load already established and stepped once (rungs 0 and 1 landed), so the only
// rung left is the floor. revisionsLeft is generous so no bid-budget rule decides the timing.
function armStanding(eng, { extendCap, extendsObserved = 0 }) {
  const meta = { id: `UCB-${++seq}`, lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: Date.now() + 900_000 };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = TRIGGER_MS;
  m.extendMs = EXTEND_MS;
  m.revisionsLeft = 8;
  const last = m.ladder.length - 1;
  for (let i = 0; i < last; i++) m.firedRungs.add(i);
  m.currentRungIndex = last - 1;
  m.lastBidPrice = m.ladder[last - 1];
  m.landedBids = last;
  return m;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });

// The real _maybeBid, stepped by the engine's own _cadence on a virtual Date.now so minInterFireMs and
// maxBidsPerMin see production spacing.
async function driveMaybeBid(eng, clock, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      clock.remaining = r;
      await eng._maybeBid(m, st(r, rank));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

function assertFixture(m, extendCap) {
  assert.notStrictEqual(m.softStrategy, 'off', 'PRECONDITION: the load must be allowlisted (rank-driven soft path)');
  assert.strictEqual(m.extendCap, extendCap, `PRECONDITION: extendCap must be ${extendCap}`);
  assert.ok(m.ladder.length >= 3, `PRECONDITION: expected the 3-rung desk band, got ${m.ladder.length} rungs`);
}

(async () => {
  console.log('soft-close unknown cap keeps the band');

  await runAsync('1 unknown-cap-band: the floor reaches the wire inside (100,000, 102,500] ms', async () => {
    // Arrange
    const { eng, clock, sent } = mkEngine();
    const m = armStanding(eng, { extendCap: null });
    assertFixture(m, null);
    const floor = m.ladder[m.ladder.length - 1];
    // Act
    await driveMaybeBid(eng, clock, m, { from: 160_000, rank: 2 });
    // Assert
    const shot = sent.find((s) => s.price === floor);
    assert.ok(shot, `the floor ${floor} never reached the wire on an unknown-cap soft load; sent: `
      + JSON.stringify(sent));
    assert.ok(shot.remaining > TRIGGER_MS && shot.remaining <= BAND_OPENS,
      `unknown-cap floor went at ${shot.remaining} ms - ruling: with no published cap the believed close is `
      + `final and the decisive shot stays in the band just above the ${TRIGGER_MS} ms trigger window `
      + `(${TRIGGER_MS}, ${BAND_OPENS}]; only a KNOWN, used-up cap moves it to the last 2.5 s`);
  });

  await runAsync('2 unknown-cap-cadence: the 130,000 ms poll aims at the band (28,125), extensions-remain control keeps 30,000', async () => {
    // Arrange
    const { eng } = mkEngine();
    const m = armStanding(eng, { extendCap: null });
    assertFixture(m, null);
    const control = armStanding(eng, { extendCap: 3, extendsObserved: 0 });
    // Act
    const aimed = eng._cadence(130_000, m);
    const plain = eng._cadence(130_000, control);
    // Assert
    assert.strictEqual(plain, 30_000,
      `CONTROL: a load with extensions remaining polled ${plain} ms at 130,000 - expected the plain 30,000 ms far `
      + 'poll with jitter 0, so the rig is not measuring the band pull');
    assert.strictEqual(aimed, 28_125,
      `unknown-cap poll at 130,000 ms was ${aimed} ms, not 28,125 - ruling: with no published cap the scheduler `
      + 'still aims a quarter-width inside the band opening (102,500 - 625 = 101,875 ms)');
  });

  await runAsync('3 cap-zero-no-band: nothing in (2,500, 102,500], the floor at <= 2,500 ms', async () => {
    // Arrange
    const { eng, clock, sent } = mkEngine();
    const m = armStanding(eng, { extendCap: 0 });
    assertFixture(m, 0);
    const floor = m.ladder[m.ladder.length - 1];
    // Act
    await driveMaybeBid(eng, clock, m, { from: 160_000, rank: 2 });
    // Assert
    const early = sent.filter((s) => s.remaining > FLOOR_WINDOW_MS && s.remaining <= BAND_OPENS);
    assert.deepStrictEqual(early, [],
      `extendCap 0 bid in (2,500, 102,500]: ${JSON.stringify(early)} - ruling: a hard window wearing a soft `
      + 'close model has no anti-snipe band; its decisive shot is the buzzer');
    const shot = sent.find((s) => s.price === floor);
    assert.ok(shot, `extendCap 0: the floor ${floor} never reached the wire; sent: ${JSON.stringify(sent)}`);
    assert.ok(shot.remaining <= FLOOR_WINDOW_MS,
      `extendCap 0 floor went at ${shot.remaining} ms - ruling: with no extensions the floor goes at <= 2,500 ms`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
