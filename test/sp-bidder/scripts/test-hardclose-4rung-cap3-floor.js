'use strict';
/**
 * SP HARD CLOSE, DEPLOYED PATH: the last revision is kept for the floor.
 *
 * Regression target: PR-T5, diagnosis 2026-09-24 timing lane C (Borosil). 44 of 45 September Borosil
 * 4-rung loads closed with the floor never offered; 17 of 18 checked in 16-23 Sep were lost.
 *
 * Mechanism: on a non-allowlisted (softStrategy 'off') hard-close load, _decide branch 4 steps down one
 * rung on every outranked tick with no revision reserve. It protects the floor RUNG (next capped at
 * last - 1) but not the floor REVISION. Borosil's band builds 4 prices against SuperProcure's 3-bid
 * cap, so establish + two step-downs spend the whole budget ~22 s out, and at the final window
 * _maybeBid's `revisionsLeft <= 0` gate returns before _decide ever runs. The floor never goes.
 *
 * Contract (owner ruling 2026-09-24): on a hard close, while outranked, a non-floor bid goes out only
 * while at least two revisions remain; with one left the bot holds and the existing final-window shot
 * sends the floor on the FIRST tick at countdown <= floorWindowMs (2,500 ms) - not later. Rank 1 holds.
 *
 * WHICH middle price goes out is owner question Q3 (OPEN). Check 2 here asserts only that ONE middle
 * price strictly between the establish and the floor is sent. The exact Q3 price is pinned in exactly
 * one place: the Q3_MIDDLE constant in scripts/test-hardclose-short-budget-middle-price.js.
 *
 * Checks (the control runs first; only harness REACHABILITY gates the rest):
 *   5  CONTROL: 3-rung ladder / cap 3, outranked throughout -> [100772, 96839, 91333], floor on the
 *      first final-window tick (passes on base)
 *   1  4-rung / cap 3, outranked: exactly 3 accepted writes, the 3rd is the floor on the first
 *      final-window tick, none refused
 *   2  same run: [100772, <one middle price>, 90022]
 *   3  same run: no write between the 2nd write and the final window
 *   4  shared slot spent by a human after the establish (live read says 1 left): no step-down, the
 *      floor next, on the first final-window tick
 *
 * WHAT MUST NOT MOVE: the 3-rung / cap-3 sequence (check 5), the 2,500 ms window, rank-1 holds.
 *
 * Offline and deterministic: fake SuperProcure adapter, real BidEngine + DurableScheduler on a temp
 * file, the REAL _tick -> _maybeBid path driven on a virtual clock at the engine's own cadence. No
 * network, no real waits, jitter pinned to 0. Expected prices are cost x (1 + pct/100), by hand.
 *
 *   node scripts/test-hardclose-4rung-cap3-floor.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
const MARGINS = [15.3, 10.8, 4.5];
// Ruling 27: the minimum margin is a guard, never a bid, so a 4-rung ladder needs a 4th band margin.
const MARGINS_4 = [15.3, 10.8, 4.5, 3];
// 87,400 x 1.153 / 1.108 / 1.045 / 1.03
const R0 = 100_772;
const R1 = 96_839;
const R2 = 91_333;
const FLOOR_3PCT = 90_022;
const WINDOW_MS = 2_500;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-4r3c-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// SuperProcure as the bot sees it: own rank null until our first bid lands, revisionsLeft null on
// every read (SP publishes none) unless a human spends a shared slot, a published revisionLimit, and
// a hard "Bid limit exceeded" once the per-load cap is spent.
function spAdapter({ closesAt, cap, rankAfterBid, humanSpendsAfterEstablish = false }) {
  let revs = cap;
  let landed = 0;
  let reportRevs = false;
  const writes = [];
  return {
    writes,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const closesInMs = Math.max(0, closesAt - Date.now());
      return {
        ok: true, status: closesInMs <= 0 ? 'closed' : 'live',
        myRank: landed === 0 ? null : rankAfterBid(closesInMs), totalBidders: 6, standingL1Price: null,
        closesInMs, revisionLimit: cap, revisionsLeft: reportRevs ? revs : null,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      const closesInMs = closesAt - Date.now();
      if (revs <= 0) {
        writes.push({ price, closesInMs, accepted: false });
        return { accepted: false, reason: 'Bid limit exceeded' };
      }
      revs -= 1;
      landed += 1;
      writes.push({ price, closesInMs, accepted: true });
      if (humanSpendsAfterEstablish && landed === 1) { revs -= 1; reportRevs = true; }
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
}

async function runAuction({ minMarginPct, marginsPct = MARGINS, cap = 3, rankAfterBid = () => 4, humanSpendsAfterEstablish = false }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  let eng;
  try {
    const closesAt = vnow + 30_000;
    const adapter = spAdapter({ closesAt, cap, rankAfterBid, humanSpendsAfterEstablish });
    eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: WINDOW_MS, cadenceJitterMs: 0 },
      rand: () => 0,
    });
    const m = eng.arm(
      { id: `bg-${seq}`, lane: { origin: 'Govindgarh', destination: 'X' }, equipment: '19ft', units: 1, closesAt, companyName: 'BG' },
      { cost: COST, marginsPct, minMarginPct });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    let ticks = 0;
    while (closesAt - vnow > 0 && ticks++ < 2_000) {
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      vnow += Math.max(1, eng._cadence(m.closesInMs, m));
    }
    return { ladder: m.ladder.slice(), softStrategy: m.softStrategy, writes: adapter.writes, hotMs: eng.cfg.pollHotMs };
  } finally {
    Date.now = REAL_NOW;
    if (eng) { try { eng.kill('test done'); } catch (_) {} }
  }
}

const fmt = (writes) => '[' + writes.map((w) => `${w.price}@${w.closesInMs}ms${w.accepted ? '' : '(REFUSED)'}`).join(', ') + ']';

// The floor must go on the first hot tick inside the window, so it sits in (WINDOW - hot poll, WINDOW].
// An upper bound alone would pass a fix that releases the kept floor seconds later.
function assertFirstWindowTick(write, hotMs, all) {
  assert.ok(write.closesInMs <= WINDOW_MS && write.closesInMs > WINDOW_MS - hotMs,
    `the floor went out at ${write.closesInMs}ms, not on the first final-window tick (${WINDOW_MS - hotMs}, ${WINDOW_MS}]ms. `
    + `Writes: ${fmt(all)}`);
}

let pass = 0;
const FAILURES = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push(name);
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

const EXPECTED = 5;
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

(async () => {
  console.log('hard close, 4-rung ladder vs cap 3: the last revision is kept for the floor');

  const control = await runAuction({ minMarginPct: 4.5 });
  const c = control.writes;
  const reached = c.some((x) => x.accepted && x.price === R2 && x.closesInMs <= WINDOW_MS);
  check('5 CONTROL 3-rung / cap 3, outranked: [100772, 96839, 91333], floor on the first final-window tick', () => {
    assert.deepStrictEqual(control.ladder, [R0, R1, R2], 'precondition: 3-rung ladder at minMarginPct 4.5');
    assert.strictEqual(control.softStrategy, 'off', 'precondition: non-allowlisted (deployed) path');
    assert.deepStrictEqual(c.map((x) => x.price), [R0, R1, R2], `the 3-rung / cap-3 sequence moved: ${fmt(c)}`);
    assertFirstWindowTick(c[2], control.hotMs, c);
    assert.ok(c.every((x) => x.accepted), `control: a write was refused: ${fmt(c)}`);
  });
  if (!reached) {
    console.error(`\nHARNESS BROKEN: the 3-rung control never landed its floor inside the final window (${fmt(c)}), `
      + 'so the driver does not reach the window and the 4-rung checks would prove nothing.');
    process.exit(1);
  }

  const borosil = await runAuction({ marginsPct: MARGINS_4, minMarginPct: 3 });
  const w = borosil.writes;
  check('1 4-rung / cap 3, outranked: 3 accepted writes, the 3rd is the floor 90022 on the first final-window tick (ruling 27 fixture)', () => {
    assert.deepStrictEqual(borosil.ladder, [R0, R1, R2, FLOOR_3PCT], 'precondition (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.ok(w.length >= 3, `only ${w.length} write(s) reached the adapter - the floor was never sent: ${fmt(w)}`);
    assert.strictEqual(w[2].price, FLOOR_3PCT,
      `the 3rd and last revision went on ${w[2].price} at ${w[2].closesInMs}ms, not the floor ${FLOOR_3PCT} - the hard `
      + `step-down spent every revision with no reserve and the floor was never offered. Writes: ${fmt(w)}`);
    assertFirstWindowTick(w[2], borosil.hotMs, w);
    assert.strictEqual(w.length, 3, `a write was attempted after the floor: ${fmt(w)}`);
    assert.ok(w.every((x) => x.accepted), `a write was refused for the cap: ${fmt(w)}`);
  });

  check('2 4-rung / cap 3, outranked: [100772, <one middle price>, 90022] (exact middle = Q3, pinned in the short-budget file) (ruling 27 fixture)', () => {
    assert.strictEqual(w.length, 3, `expected 3 writes, got ${fmt(w)}`);
    assert.strictEqual(w[0].price, R0, `the establish was not 100772: ${fmt(w)}`);
    assert.ok(w[1].price < R0 && w[1].price > FLOOR_3PCT, `the 2nd write is not a middle price: ${fmt(w)}`);
    assert.strictEqual(w[2].price, FLOOR_3PCT,
      `writes were ${fmt(w)} - a second middle price took the revision the floor needed`);
  });

  check('3 4-rung / cap 3, outranked: nothing is written between the 2nd write and the final window (ruling 27 fixture)', () => {
    const between = w.slice(2).filter((x) => x.closesInMs > WINDOW_MS);
    assert.strictEqual(between.length, 0,
      `wrote ${fmt(between)} after the 2nd write and before the final window, with one revision left - `
      + `that bid spent the floor's revision. All writes: ${fmt(w)}`);
  });

  const shared = await runAuction({ marginsPct: MARGINS_4, minMarginPct: 3, humanSpendsAfterEstablish: true });
  const s = shared.writes;
  check('4 shared slot spent after the establish (live read: 1 left): no step-down, the next and last write is the floor (ruling 27 fixture)', () => {
    assert.ok(s.length >= 1 && s[0].price === R0 && s[0].accepted, `precondition: the establish 100772 did not land first: ${fmt(s)}`);
    const stepDowns = s.slice(1).filter((x) => x.price !== FLOOR_3PCT);
    assert.strictEqual(stepDowns.length, 0,
      `stepped down to ${fmt(stepDowns)} with one revision left after a human spent a shared slot - that was the floor's `
      + `revision. All writes: ${fmt(s)}`);
    assert.strictEqual(s.length, 2, `expected establish + floor only, got ${fmt(s)}`);
    assert.strictEqual(s[1].price, FLOOR_3PCT, `the last write is not the floor: ${fmt(s)}`);
    assertFirstWindowTick(s[1], shared.hotMs, s);
    assert.ok(s.every((x) => x.accepted), `a write was refused for the cap: ${fmt(s)}`);
  });

  if (pass !== EXPECTED || FAILURES.length) {
    console.error(`\nFAILED ${FAILURES.length} of ${EXPECTED}: ${FAILURES.join(' | ')}`);
    console.error('The deployed hard-close step-down spends the floor\'s revision; _maybeBid\'s revisionsLeft<=0 gate then blocks the final-window floor.');
    process.exit(1);
  }
  console.log(`\nPASS hardclose-4rung-cap3-floor: ${pass}/${EXPECTED} checks`);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
