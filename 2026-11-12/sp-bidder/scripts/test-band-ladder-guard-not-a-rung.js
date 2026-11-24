'use strict';
/**
 * THE MINIMUM MARGIN IS A GUARD, NOT A BID.
 *
 * Regression target: buildBandLadder appending the operating floor as an extra rung whenever the
 * load's minMarginPct sits below the band's lowest margin.
 *
 * The band margins are the bids: one price per margin, the lowest margin's price is the last rung
 * and is what `floor` means. minMarginPct only guards - no price may sit below
 * cost x (1 + minMarginPct/100), and a margin below that is raised to it. Today the guard is also
 * pushed onto the end of the ladder as a price of its own, so a Borosil band [15.3, 10.8, 4.5] with
 * a 3% minimum arms FOUR prices ending at the 3% guard, and `floor` reports the guard. SuperProcure
 * allows that load three bids, so the fourth price is a rung the engine budgets for and never
 * reaches, and every floor-keyed decision (snipe, floor-reached, the placeBid floor gate) is aimed at
 * a price the desk never asked to bid.
 *
 * WHAT MUST NOT MOVE:
 *   - no rung below the guard, ever; a stored margin below the guard is raised to it (check 4).
 *   - a band whose lowest margin IS the minimum builds exactly today's ladder (check 5). That is the
 *     house default and the control proving a later green is the fix and not a dead harness.
 *
 * Offline and deterministic: pure pricing calls plus one engine arm on a fake adapter and a temp
 * scheduler file. No network, no timers left running, no randomness on the asserted path.
 *
 *   node scripts/test-band-ladder-guard-not-a-rung.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 100_000;
const TOTAL = 5;
let pass = 0;
const failed = [];
const CLEAN = [];
let seq = 0;
const tmp = () => { const f = path.join(os.tmpdir(), `guard-not-rung-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const guardOf = (minPct) => Math.round(COST * (1 + minPct / 100));

async function check(id, fn) {
  try { await fn(); console.log('  ok  ' + id); pass++; } catch (e) { console.log('  FAIL ' + id + ': ' + e.message); failed.push(id); }
}

function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    rounding: { enabled: false },
  });
}

function assertBandIsTheLadder(got, marginsPct, minPct, label) {
  const guard = guardOf(minPct);
  const expected = marginsPct.map((m) => Math.round(COST * (1 + m / 100)));
  assert.ok(!got.ladder.includes(guard),
    `${label}: the ${minPct}% guard price ${guard} was bid as a rung of its own - ladder ${JSON.stringify(got.ladder)}`);
  assert.deepStrictEqual(got.ladder, expected, `${label}: one price per band margin, nothing appended`);
  assert.strictEqual(got.floor, expected[expected.length - 1], `${label}: floor is the lowest band price, not the guard`);
  assert.strictEqual(got.floor, got.ladder[got.ladder.length - 1], `${label}: floor is the last rung`);
}

(async () => {
  // 1. borosil-three-prices: band [15.3, 10.8, 4.5], min 3 -> 115300 / 110800 / 104500, guard 103000 absent.
  await check('1. borosil-three-prices', () => {
    // Arrange
    const band = [15.3, 10.8, 4.5];
    // Act
    const got = buildBandLadder({ cost: COST, marginsPct: band, minMarginPct: 3 });
    // Assert
    assertBandIsTheLadder(got, band, 3, 'Borosil');
  });

  // 2. waaree-three-prices: [9, 7.2, 5.4] and the stored [9, 7.2, 3.6], both min 2 -> guard 102000 absent.
  await check('2. waaree-three-prices', () => {
    // Arrange
    const bands = [[9, 7.2, 5.4], [9, 7.2, 3.6]];
    const errors = [];
    for (const band of bands) {
      // Act
      const got = buildBandLadder({ cost: COST, marginsPct: band, minMarginPct: 2 });
      // Assert
      try { assertBandIsTheLadder(got, band, 2, `Waaree ${JSON.stringify(band)}`); } catch (e) { errors.push(e.message); }
    }
    if (errors.length) throw new Error(errors.join(' | '));
  });

  // 3. engine-arms-three: the real arm path (arm -> _planFor -> buildBandLadder) on a 3-bid-cap hard-close
  //    Borosil load. Not on the soft-close allowlist and revisionLimit 3, so the coarse ladder is armed.
  await check('3. engine-arms-three', () => {
    // Arrange
    const eng = mkEngine();
    const meta = { id: 'BOROSIL-HARD', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Borosil Limited', rules: { revisionLimit: 3, minDecrement: 500 }, closesAt: Date.now() + 600_000 };
    assert.strictEqual(eng._deriveRungCount({ cost: COST, marginsPct: [15.3, 10.8, 4.5], minMarginPct: 3 },
      meta.rules, meta.companyName), null, 'precondition: this load takes the coarse band path');
    // Act
    const m = eng.arm(meta, { cost: COST, marginsPct: [15.3, 10.8, 4.5], minMarginPct: 3 });
    if (m && m.timer) clearTimeout(m.timer);
    // Assert
    assert.ok(!m.ladder.includes(guardOf(3)),
      `armed ladder carries the 3% guard ${guardOf(3)} as a bid - ${JSON.stringify(m.ladder)}`);
    assert.strictEqual(m.ladder.length, 3, `a 3-bid load arms 3 prices (got ${JSON.stringify(m.ladder)})`);
    assert.strictEqual(m.floor, 104_500, 'monitor floor is the 4.5% price');
    assert.strictEqual(m.ladder[m.ladder.length - 1], 104_500, 'the last armed rung is the 4.5% price');
  });

  // 4. no-price-below-guard (pin): a stored margin below the guard is raised to it, once - not dropped,
  //    not duplicated - and no band here produces any rung below its guard or below cost.
  await check('4. no-price-below-guard', () => {
    // Arrange
    const cases = [
      { band: [12.6, 7.2, 0], min: 5 },
      { band: [15.3, 10.8, 4.5], min: 3 },
      { band: [9, 7.2, 5.4], min: 2 },
      { band: [9, 7.2, 3.6], min: 2 },
      { band: [12.6, 7.2, 5], min: 5 },
    ];
    // Act
    const violating = buildBandLadder({ cost: COST, marginsPct: [12.6, 7.2, 0], minMarginPct: 5 });
    // Assert
    assert.deepStrictEqual(violating.ladder, [112_600, 107_200, 105_000], 'the 0% margin is raised to the 5% guard, once');
    assert.strictEqual(violating.floor, 105_000);
    for (const { band, min } of cases) {
      const got = buildBandLadder({ cost: COST, marginsPct: band, minMarginPct: min });
      for (const p of got.ladder) {
        assert.ok(p >= guardOf(min) && p >= COST, `${JSON.stringify(band)} min ${min}: rung ${p} below the guard ${guardOf(min)}`);
      }
      assert.ok(got.ladder.every((p, i) => i === 0 || p < got.ladder[i - 1]), `${JSON.stringify(band)}: strictly descending`);
    }
  });

  // 5. min-equals-bottom-unchanged (pin): when the minimum IS the band's lowest margin nothing moves.
  await check('5. min-equals-bottom-unchanged', () => {
    // Act
    const house = buildBandLadder({ cost: COST, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 });
    const live = buildBandLadder({ cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    // Assert
    assert.deepStrictEqual(house.ladder, [112_600, 107_200, 105_000]);
    assert.strictEqual(house.floor, 105_000);
    assert.deepStrictEqual(live.ladder, [112_600, 107_200, 106_300]);
    assert.strictEqual(live.floor, 106_300);
  });

  cleanup();
  if (failed.length) {
    console.error(`\nFAILED ${failed.length}/${TOTAL}: ${failed.join(', ')} - the minimum-margin guard is being bid as an extra ladder rung and reported as the floor`);
    process.exit(1);
  }
  console.log(`\n${pass}/${TOTAL} checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
