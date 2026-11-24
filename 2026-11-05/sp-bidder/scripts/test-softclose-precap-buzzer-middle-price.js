'use strict';
/**
 * SOFT-CLOSE PRE-CAP BUZZER - the next middle price goes, the floor is kept for the final round.
 *
 * Regression target: ruling Q5 (with Q3), 2026-09-24. Transrail 25625834 (floor at 2.4 s with
 * 0 extensions observed, three more rounds followed, lost at rank 6) and 25631495 (floor at 2.4 s at
 * extension 2, one more round followed, lost at rank 2).
 *
 * Mechanism. On an allowlisted soft branch whose extensions are not yet exhausted, every hold in the
 * soft-defend branch of _decide routes through _lastResortFloor. Once this round's one defend is spent,
 * an outranked load reaches the buzzer (<= floorWindowMs) through that hold and _lastResortFloor
 * releases the FLOOR. A bid there sits inside the anti-snipe trigger window, so the auction extends,
 * and the bot has shown and spent its best price with rounds still to come.
 *
 * Contract (Q5 + Q3): outranked at the buzzer of a round BEFORE the cap, send ONE shot at the next
 * unfired rung below the rung we stand on, above the floor; keep the floor unfired for the final round,
 * where it goes at <= 2,500 ms.
 *
 * Must NOT move: rank 1 holds at the buzzer (the control below).
 *
 * Drives the REAL _maybeBid on a virtual clock at the engine's own cadence, fake adapter that accepts
 * every bid, jitter pinned via opts.rand. The Transrail branch is modelled as a flat (FTL) load: the
 * timing path under test does not read the pricing basis.
 *
 *   node scripts/test-softclose-precap-buzzer-middle-price.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// Transrail's published branch mechanics (branchAuctionRemainingTime 100 s, extend 120 s, 3
// extensions, 10 bids per branch).
const TRIGGER_MS = 100_000;
const EXTEND_MS = 120_000;
const EXTEND_COUNT = 3;
const REVISION_LIMIT = 10;
const FLOOR_WINDOW_MS = 2_500;
// named re-pin: round tracker piece C, rulings 40 and 56 - the pre-cap shot goes in a round's last 6 s
// (the probe lead), and the frame showing the extension it causes arrives about 1.2 s later.
const PROBE_LEAD_MS = 6_000;
const FRAME_AFTER_SHOT_MS = 1_200;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-precap-q5-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const ENGINES = [];

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 4;
process.on('exit', (code) => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close pre-cap buzzer middle price: ${pass}/${EXPECTED_CASES} cases passed`);
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

// A Transrail load mid-auction: established at rung 0, this round's one defend landed at rung 1, both
// on the board, 8 of 10 revisions left. The virtual clock and the believed close travel with the load
// so a later round continues on the same timeline.
function mkLoad({ extendsObserved }) {
  const clock = { now: Date.now() };
  const load = { sent: [], remaining: null, clock };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: REVISION_LIMIT, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => {
      load.sent.push({ price, remaining: load.remaining, extendsObserved: load.m.extendsObserved });
      return { accepted: true, status: 201, myRank: 2, revisionsLeft: null };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, rungs: 6 },
    softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
    onEvent: () => {},
    rand: () => 0,
  });
  ENGINES.push(eng);
  const meta = { id: String(900_000 + seq++), lane: { origin: 'NAGPUR', destination: 'Raipur' }, units: 1,
    companyName: 'Transrail Lighting Ltd', branchName: 'NAGPUR', closesAt: clock.now + 900_000,
    rules: { revisionLimit: REVISION_LIMIT, minDecrement: 100 } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.extendCap = EXTEND_COUNT;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = TRIGGER_MS;
  m.extendMs = EXTEND_MS;
  m.firedRungs.add(0); m.firedRungs.add(1);
  m.currentRungIndex = 1;
  m.lastBidPrice = m.ladder[1];
  m.landedBids = 2;
  m.ownBidAttempts = 2;
  m.everBid = true;
  m.revisionsLeft = REVISION_LIMIT - 2;
  m._lastDefendAtExtend = extendsObserved; // this round's once-per-round defend already landed
  m.lastFireAt = clock.now - 60_000;
  Object.assign(load, { eng, m });
  return load;
}

const state = (remaining, myRank) => ({ ok: true, status: 'live', closesInMs: remaining, myRank, totalBidders: 7,
  standingL1Price: null, minDecrement: 100, revisionLimit: REVISION_LIMIT, revisionsLeft: null, closeModel: 'soft',
  extendMs: EXTEND_MS, extendCount: EXTEND_COUNT, triggerWindowMs: TRIGGER_MS, measuredRttMs: 80 });

// Walk the real _maybeBid to the believed close, stepping the virtual clock by the engine's own cadence.
// With `extendOnShot` (a round before the cap), a shot in the round's last PROBE_LEAD_MS extends it the
// way SuperProcure does, and the round ends where the frame showing that reaches the engine.
async function driveToClose(load, { from, rank, extendOnShot = false }) {
  const { eng, m, clock } = load;
  if (from != null) m.believedCloseAt = clock.now + from;
  const REAL_NOW = Date.now;
  Date.now = () => clock.now;
  try {
    let ticks = 0;
    let shotAt = null;
    for (let r = m.believedCloseAt - clock.now; r >= 0 && ticks++ < 20_000; r = m.believedCloseAt - clock.now) {
      load.remaining = r;
      if (shotAt != null && clock.now - shotAt >= FRAME_AFTER_SHOT_MS) {
        eng._observeExtension(m, Object.assign(state(r, rank), { closesAtMs: m.believedCloseAt + EXTEND_MS }));
        break;
      }
      const before = load.sent.length;
      await eng._maybeBid(m, state(r, rank));
      if (extendOnShot && shotAt == null && load.sent.length > before && r <= PROBE_LEAD_MS) shotAt = clock.now;
      clock.now += Math.max(1, eng._cadence(r, m));
    }
  } finally { Date.now = REAL_NOW; }
}

// Q3: the next unfired rung below the one we stand on, strictly above the floor.
function nextMiddleRung(m, standingAt) {
  const last = m.ladder.length - 1;
  for (let j = standingAt + 1; j < last; j++) if (!m.firedRungs.has(j)) return j;
  return null;
}

const fmt = (sent, m) => '[' + sent.map((s) => `rung ${m.ladder.indexOf(s.price)} @ ${s.remaining}ms ext ${s.extendsObserved}`).join(', ') + ']';

function assertPreCapBuzzerShot(load, standingAt, expectedRung, ext) {
  const { m, sent } = load;
  const last = m.ladder.length - 1;
  const floorShot = sent.find((s) => s.price === m.ladder[last]);
  assert.ok(!floorShot,
    `the FLOOR (${m.ladder[last]}) went at ${floorShot && floorShot.remaining}ms at the buzzer of a PRE-cap round `
    + `(extension ${ext} of ${EXTEND_COUNT}) via the last-resort release - ruling Q5: outranked at a pre-cap buzzer, `
    + `send the next middle price and keep the floor for the final round. Sent: ${fmt(sent, m)}`);
  const buzzer = sent.filter((s) => s.remaining <= PROBE_LEAD_MS && s.remaining > FLOOR_WINDOW_MS);
  assert.strictEqual(buzzer.length, 1,
    `${buzzer.length} bids in the last ${PROBE_LEAD_MS}ms of a pre-cap round ahead of its ${FLOOR_WINDOW_MS}ms buzzer, expected exactly one next-price shot `
    + `(ruling Q5: one such shot per pre-cap buzzer). Sent: ${fmt(sent, m)}`);
  assert.strictEqual(buzzer[0].price, m.ladder[expectedRung],
    `the pre-cap buzzer shot went at rung ${m.ladder.indexOf(buzzer[0].price)}, expected rung ${expectedRung} - `
    + `ruling Q3: the next unfired rung below the rung we stand on (${standingAt}), above the floor`);
  assert.ok(!m.firedRungs.has(last), 'the floor rung is banked as fired after a pre-cap buzzer - it must stay unfired');
}

(async () => {
  console.log('soft-close pre-cap buzzer middle price (Q5)');

  await runAsync('1 round 0, outranked at the buzzer: one shot at the next middle rung, the floor stays unfired', async () => {
    const load = mkLoad({ extendsObserved: 0 });
    const { eng, m } = load;
    assert.ok(m.ladder.length >= 6, `PRECONDITION: a fine ladder (>= 6 rungs) was not built - got ${m.ladder.length}`);
    assert.strictEqual(m.softStrategy, 'live', 'PRECONDITION: the Transrail load must be allowlisted live');
    assert.strictEqual(eng._effectivelyHard(m), false, 'PRECONDITION: extendsObserved 0 of 3 must be pre-cap');
    const expected = nextMiddleRung(m, 1);
    await driveToClose(load, { from: 5_000, rank: 2, extendOnShot: true });
    assertPreCapBuzzerShot(load, 1, expected, 0);
  });

  // Case 2 and case 3 are one auction: the last pre-cap round, then the final round it extends into.
  const lastPre = mkLoad({ extendsObserved: EXTEND_COUNT - 1 });
  let lastPreDriven = false;
  await runAsync('2 last pre-cap round (extension 2 of 3), outranked at the buzzer: one next middle rung, no floor', async () => {
    const { eng, m } = lastPre;
    assert.ok(m.ladder.length >= 6, `PRECONDITION: a fine ladder (>= 6 rungs) was not built - got ${m.ladder.length}`);
    assert.strictEqual(eng._effectivelyHard(m), false, 'PRECONDITION: extendsObserved 2 of 3 must be pre-cap');
    const expected = nextMiddleRung(m, 1);
    await driveToClose(lastPre, { from: 5_000, rank: 2, extendOnShot: true });
    lastPreDriven = true;
    assertPreCapBuzzerShot(lastPre, 1, expected, EXTEND_COUNT - 1);
  });

  await runAsync('3 then the final round (post-cap), outranked to the close: the floor goes at <= 2,500 ms', async () => {
    const { eng, m, clock } = lastPre;
    assert.ok(lastPreDriven, 'PRECONDITION: case 2 did not drive the last pre-cap round');
    const last = m.ladder.length - 1;
    const precap = lastPre.sent.slice();
    // named re-pin: round tracker piece C, rulings 40 and 56 - the move our pre-cap shot caused was read
    // in case 2's drive (it used to be fed here), so the final round is already counted.
    assert.strictEqual(m.extendsObserved, EXTEND_COUNT, `PRECONDITION: extendsObserved is ${m.extendsObserved}, expected ${EXTEND_COUNT} (post-cap)`);
    assert.strictEqual(eng._effectivelyHard(m), true, 'PRECONDITION: the final round must be post-cap');
    assert.ok(m.believedCloseAt - clock.now > TRIGGER_MS, 'PRECONDITION: the final round must start above the trigger window');
    lastPre.sent.length = 0;
    await driveToClose(lastPre, { rank: 2 });
    const finalFloor = lastPre.sent.find((s) => s.price === m.ladder[last] && s.remaining <= FLOOR_WINDOW_MS);
    const spentPrecap = precap.find((s) => s.price === m.ladder[last]);
    assert.ok(finalFloor,
      'the final round (post-cap) closed outranked with NO floor bid at <= 2,500 ms - '
      + (spentPrecap
        ? `the floor was already spent at the PRE-cap buzzer (${spentPrecap.remaining}ms, extension ${spentPrecap.extendsObserved}) `
          + 'by the last-resort release, so nothing was left for the round that decides the load. '
        : 'the floor was held and still never sent. ')
      + `Ruling Q5: keep the floor for the final round. Final round sent: ${fmt(lastPre.sent, m)}; `
      + `pre-cap round sent: ${fmt(precap, m)}`);
  });

  await runAsync('CONTROL round 0 at rank 1 through the buzzer: nothing is sent', async () => {
    const load = mkLoad({ extendsObserved: 0 });
    assert.strictEqual(load.eng._effectivelyHard(load.m), false, 'PRECONDITION: extendsObserved 0 of 3 must be pre-cap');
    await driveToClose(load, { from: 5_000, rank: 1 });
    assert.strictEqual(load.sent.length, 0,
      `a rank-1 load bid at a pre-cap buzzer - SP holds at rank 1. Sent: ${fmt(load.sent, load.m)}`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
