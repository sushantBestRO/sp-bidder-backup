'use strict';
/**
 * SOFT CLOSE AFTER A KNOWN EXTENSION CAP - the final bid goes at the buzzer, not in the band.
 *
 * Regression target: ruling F1 (2026-09-24). Vishal Pipes (trigger 100 s, extension 120 s,
 * cap 1, 3 bids) put its final bid at ~101.9 s on 20 of 21 loads, 16-23 Sep on v2.14.2. Once a KNOWN
 * cap is used up the auction cannot extend again, so a bid 100 s out is not "the last moment that
 * cannot start another round" - it is 100 s of free time for every rival to undercut it.
 *
 * Mechanism: `_decisiveBandFor` returns the band [102,500, 100,000] ms for every effectively-hard
 * allowlisted soft load, a known-and-exhausted cap included; `_softEndgameUnlocked` releases the
 * decisive shot inside it; `_cadence` aims the poll at 101,875 ms so a tick is sure to land there.
 * Ruling: after a known cap, the decisive bid goes at <= floorWindowMs (2,500 ms) like hard close and
 * the poll schedule does not aim at the band.
 *
 * Must NOT move (in-file controls): an UNKNOWN cap (extendCap null) keeps the band exactly as today,
 * and a hard-close load still fires its floor at <= 2,500 ms.
 *
 * Drives the REAL _maybeBid at production cadence on a virtual clock (rand stubbed to 0), fake adapter,
 * temp scheduler file. The extension count is the engine's own, reached through _observeExtension.
 *
 *   node scripts/test-softclose-no-band-after-known-cap.js
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
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-nobandcap-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 5;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft close, no band after a known cap: ${pass}/${EXPECTED_CASES} cases passed`);
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

function mkEngine(clock) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => {
      clock.sent.push({ price, remaining: clock.remaining });
      return { accepted: true, status: 201, myRank: clock.rank, revisionsLeft: null };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, rungs: 6 },
    softClose: { enabled: true, shippers: ['Vishal Pipes'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

// The SP state frame as realAdapter.getAuctionState shapes it: revisionLimit is the branch bid cap,
// revisionsLeft is null (the engine keeps its own count).
const spState = (fx, remaining, closesAtMs) => ({
  ok: true, status: 'live', myRank: fx.clock.rank, totalBidders: 6, standingL1Price: null,
  closesInMs: remaining, revisionLimit: fx.revisionLimit, revisionsLeft: null, minDecrement: 100,
  closeModel: fx.closeModel, extendMs: EXTEND_MS, extendCount: fx.publishedCap, triggerWindowMs: TRIGGER_MS,
  closesAtMs, measuredRttMs: 80,
});

// Arm, stand the load on `standing` (every rung above it already landed), then walk its close forward
// by one published increment per extension through the engine's own _observeExtension.
function fixture({ closeModel = 'soft', publishedCap, extensions, marginsPct, standing, revisionLimit, rank }) {
  const clock = { sent: [], remaining: null, rank };
  const eng = mkEngine(clock);
  const meta = { id: `VP-${++seq}`, lane: { origin: 'Kutch', destination: 'Pune' }, units: 1,
    companyName: 'Vishal Pipes', branchName: 'KUTCH', closesAt: Date.now() + 900_000 };
  const m = eng.arm(meta, { cost: 70_000, marginsPct });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.triggerWindowMs = TRIGGER_MS;
  m.extendMs = EXTEND_MS;
  for (let r = 0; r <= standing; r++) m.firedRungs.add(r);
  m.currentRungIndex = standing;
  m.lastBidPrice = m.ladder[standing];
  m.landedBids = standing + 1;
  m.revisionsLeft = revisionLimit - (standing + 1);
  const fx = { eng, m, clock, closeModel, publishedCap, revisionLimit };
  // arm() seeds believedCloseAt from meta.closesAt; the first frame restates that close.
  let closeAt = m.believedCloseAt != null ? m.believedCloseAt : meta.closesAt;
  eng._observeExtension(m, spState(fx, 600_000, closeAt));
  // named re-pin: round tracker, ruling 56 - each extension is read 60 s before the close it extends,
  // inside the trigger window; a move read 600 s out is a reschedule, not a round.
  const REAL_NOW = Date.now;
  try {
    for (let i = 0; i < extensions; i++) {
      const readAt = closeAt - 60_000;
      Date.now = () => readAt;
      closeAt += EXTEND_MS;
      eng._observeExtension(m, spState(fx, 600_000, closeAt));
    }
  } finally { Date.now = REAL_NOW; }
  fx.closeAt = closeAt;
  return fx;
}

// Production cadence on a virtual clock: each step is exactly what _cadence would have scheduled.
async function drive(fx, { from = 200_000, maxTicks = 20_000 } = {}) {
  const { eng, m, clock } = fx;
  const REAL_NOW = Date.now;
  let vnow = fx.closeAt - from;
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= 0 && ticks++ < maxTicks) {
      clock.remaining = r;
      await eng._maybeBid(m, spState(fx, r, fx.closeAt));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
  return clock.sent;
}

const fmt = (sent) => '[' + sent.map((s) => `${s.price}@${s.remaining}ms`).join(', ') + ']';
const VISHAL = { marginsPct: [12.6, 7.2, 6.3], standing: 1, revisionLimit: 3, rank: 3 };
const TRANSRAIL = { marginsPct: [12.6, 11.4, 10.2, 9.0, 8.4, 7.8, 7.2, 6.3], standing: 2, revisionLimit: 10, rank: 4 };

(async () => {
  console.log('soft close, no band after a known cap');

  await runAsync('1 vishal-floor-at-buzzer: cap 1 used up, the floor goes at <= 2,500 ms and nothing goes in the band', async () => {
    const fx = fixture({ ...VISHAL, publishedCap: 1, extensions: 1 });
    const { eng, m } = fx;
    const last = m.ladder.length - 1;
    assert.strictEqual(m.ladder.length, 3, `PRECONDITION: 3-rung ladder, got ${m.ladder.length}`);
    assert.strictEqual(m.extendCap, 1, `PRECONDITION: known cap 1 read off the frame, got ${m.extendCap}`);
    assert.strictEqual(m.extendsObserved, 1, `PRECONDITION: the engine counted the one extension, got ${m.extendsObserved}`);
    assert.strictEqual(m.revisionsLeft, 1, `PRECONDITION: one bid left, got ${m.revisionsLeft}`);
    assert.strictEqual(eng._effectivelyHard(m), true, 'PRECONDITION: the load is post-cap (effectively hard)');
    const sent = await drive(fx);
    const early = sent.filter((s) => s.remaining > FLOOR_WINDOW_MS && s.remaining <= BAND_OPENS);
    assert.strictEqual(early.length, 0,
      `post-cap final bid went at ${early.map((s) => s.remaining + ' ms').join(', ')} remaining (sent ${fmt(sent)}) - `
      + 'the cap is used up so the auction cannot extend and rivals get ~100 s to undercut. Ruling F1: after a known '
      + 'extension cap the final bid goes in the last seconds like hard close (<= 2,500 ms)');
    assert.strictEqual(sent.length, 1, `exactly one bid expected (one revision left), sent ${fmt(sent)}`);
    assert.strictEqual(sent[0].price, m.ladder[last], `the one bid must be the floor ${m.ladder[last]}, sent ${fmt(sent)}`);
    assert.ok(sent[0].remaining <= FLOOR_WINDOW_MS, `the floor must go at <= 2,500 ms, sent ${fmt(sent)}`);
  });

  await runAsync('2 transrail-last-bid-at-buzzer: cap 3 used up, the last bid before the close goes at <= 2,500 ms', async () => {
    const fx = fixture({ ...TRANSRAIL, publishedCap: 3, extensions: 3 });
    const { eng, m } = fx;
    assert.ok(m.ladder.length >= 6, `PRECONDITION: fine ladder (>= 6 rungs), got ${m.ladder.length}`);
    assert.strictEqual(m.extendCap, 3, `PRECONDITION: known cap 3, got ${m.extendCap}`);
    assert.strictEqual(m.extendsObserved, 3, `PRECONDITION: the engine counted 3 extensions, got ${m.extendsObserved}`);
    assert.ok(m.revisionsLeft >= 5, `PRECONDITION: ample revisions, got ${m.revisionsLeft}`);
    assert.strictEqual(eng._effectivelyHard(m), true, 'PRECONDITION: the load is post-cap (effectively hard)');
    const sent = await drive(fx);
    assert.ok(sent.length >= 1, 'PRECONDITION: an outranked load with budget placed at least one bid');
    const lastBid = sent[sent.length - 1];
    assert.ok(lastBid.remaining <= FLOOR_WINDOW_MS,
      `post-cap last bid went at ${lastBid.remaining} ms remaining (sent ${fmt(sent)}) - after the third and final `
      + 'extension nothing can re-open the auction, so a closing bid ~100 s out is just a target. Ruling F1: after a '
      + 'known extension cap the final bid goes in the last seconds like hard close (<= 2,500 ms)');
  });

  // Asserted against the band's AIM point, not "lands anywhere in the band": a plain 30 s far poll can
  // land inside the band by arithmetic alone, which is not aiming.
  await runAsync('3 poll-does-not-aim-at-band: at 130,000 ms on the post-cap load the next poll is not the band-aimed one', async () => {
    const { eng, m } = fixture({ ...VISHAL, publishedCap: 1, extensions: 1 });
    assert.strictEqual(m.extendsObserved, 1, 'PRECONDITION: post-cap (1 of 1 extension observed)');
    const bandAimed = (130_000 - BAND_OPENS) + Math.floor(FLOOR_WINDOW_MS / 4);
    const step = eng._cadence(130_000, m);
    assert.notStrictEqual(step, bandAimed,
      `_cadence(130000) returned ${step} ms, aiming the next poll at ${130_000 - step} ms remaining - a quarter into `
      + `the band (${TRIGGER_MS}, ${BAND_OPENS}]. The scheduler is still aiming at the soft-close band on a load whose `
      + 'known cap is used up. Ruling F1: after a known extension cap the poll schedule does not aim at the band');
  });

  await runAsync('C1 control, UNKNOWN cap: the band is kept - the floor goes inside (100,000, 102,500]', async () => {
    const fx = fixture({ ...VISHAL, publishedCap: null, extensions: 1 });
    const { m } = fx;
    const last = m.ladder.length - 1;
    assert.strictEqual(m.extendCap, null, `PRECONDITION: cap unknown, got ${m.extendCap}`);
    const sent = await drive(fx);
    assert.strictEqual(sent.length, 1, `exactly one bid expected, sent ${fmt(sent)}`);
    assert.strictEqual(sent[0].price, m.ladder[last], `the floor expected, sent ${fmt(sent)}`);
    assert.ok(sent[0].remaining > TRIGGER_MS && sent[0].remaining <= BAND_OPENS,
      `unknown-cap floor went at ${sent[0].remaining} ms - an unknown cap keeps the band (F1 scope), sent ${fmt(sent)}`);
  });

  await runAsync('C2 control, HARD close: the floor goes at <= 2,500 ms', async () => {
    const fx = fixture({ ...VISHAL, closeModel: 'hard', publishedCap: 0, extensions: 0 });
    const { m } = fx;
    const last = m.ladder.length - 1;
    const sent = await drive(fx);
    assert.strictEqual(sent.length, 1, `exactly one bid expected, sent ${fmt(sent)}`);
    assert.strictEqual(sent[0].price, m.ladder[last], `the floor expected, sent ${fmt(sent)}`);
    assert.ok(sent[0].remaining <= FLOOR_WINDOW_MS, `hard-close floor went at ${sent[0].remaining} ms, sent ${fmt(sent)}`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
