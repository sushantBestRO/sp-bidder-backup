'use strict';
/**
 * ON A FINE LADDER THE BOTTOM ANCHOR IS THE BAND'S LOWEST MARGIN, NOT THE MINIMUM-MARGIN GUARD.
 *
 * Regression target: interpolateBandLadder inheriting buildBandLadder's appended guard rung as its
 * bottom anchor.
 *
 * When a load's platform allows more bids than the desk typed margins (a 10-bid SuperProcure
 * soft-close load on an allowlisted shipper), the margins become anchors and the fine ladder fills
 * priced steps between them. Its range is the band: top margin down to the lowest margin. The
 * minimum margin only guards. Today buildBandLadder appends the guard as a fourth "anchor", so with
 * band [12.6, 7.2, 5] and a 3% minimum the fine ladder spreads rungs BELOW the 5% price down to 3% -
 * prices the desk never put in the band - and `floor` is the 3% guard.
 *
 * Cost 100000, rules.minDecrement 500, rules.revisionLimit 10: the band span 112600 -> 105000 is 7600,
 * so 1 + floor(7600 / 500) = 16 rungs would fit and the platform's 10 binds - well over 3 either way.
 *
 * WHAT MUST NOT MOVE:
 *   - the same load with minimum 5 (the band's own bottom) builds exactly today's fine ladder, both
 *     directly and through the engine (check 3). It is the control proving a later green is the fix.
 *   - the red cases pin bounds, anchors, strict descent and 3 < count <= 10, never the exact count:
 *     the count legitimately changes once the span shrinks.
 *
 * Offline and deterministic: pure pricing calls plus engine arms on a fake adapter and a temp
 * scheduler file. No network, no timers left running, no randomness on the asserted path.
 *
 *   node scripts/test-fine-ladder-bottom-anchor-is-band.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { interpolateBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 100_000;
const BAND = [12.6, 7.2, 5];
const ANCHORS = [112_600, 107_200, 105_000];
const BAND_BOTTOM = 105_000;
const GUARD_3 = 103_000;
const RULES = { revisionLimit: 10, minDecrement: 500 };
// What this tree builds for min 5 (min == band bottom): 7600 split across the two gaps, 5 + 2 inserts.
const MIN5_FINE = [112_600, 111_700, 110_800, 109_900, 109_000, 108_100, 107_200, 106_467, 105_733, 105_000];
const TOTAL = 3;
let pass = 0;
const failed = [];
const CLEAN = [];
let seq = 0;
const tmp = () => { const f = path.join(os.tmpdir(), `fine-bottom-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

async function check(id, fn) {
  try { await fn(); console.log('  ok  ' + id); pass++; } catch (e) { console.log('  FAIL ' + id + ': ' + e.message); failed.push(id); }
}

function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, revisionLimit: 10, closeModel: 'soft' }),
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

function armSoft(eng, id, minMarginPct) {
  const meta = { id, lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells India Ltd',
    rules: { ...RULES }, closesAt: Date.now() + 600_000 };
  const inputs = { cost: COST, marginsPct: BAND, minMarginPct };
  assert.ok(eng._deriveRungCount(inputs, meta.rules, meta.companyName) > 3, 'precondition: this load takes the fine-ladder path');
  const m = eng.arm(meta, inputs);
  if (m && m.timer) clearTimeout(m.timer);
  return m;
}

function assertFineWithinBand(ladder, floor, label) {
  const below = ladder.filter((p) => p < BAND_BOTTOM);
  assert.strictEqual(below.length, 0,
    `${label}: rungs ${JSON.stringify(below)} lie below the band's 5% price ${BAND_BOTTOM} - the 3% guard ${GUARD_3} was used as the bottom anchor; ladder ${JSON.stringify(ladder)}`);
  assert.strictEqual(ladder[ladder.length - 1], BAND_BOTTOM, `${label}: the last rung is the 5% price`);
  assert.strictEqual(floor, BAND_BOTTOM, `${label}: floor is the 5% price`);
  assert.strictEqual(ladder[0], ANCHORS[0], `${label}: the first rung is the 12.6% price`);
  for (const a of ANCHORS) assert.ok(ladder.includes(a), `${label}: band price ${a} is a rung`);
  assert.ok(ladder.every((p, i) => i === 0 || p < ladder[i - 1]), `${label}: strictly descending`);
  assert.ok(ladder.length > 3 && ladder.length <= 10, `${label}: 3 < rung count <= 10 (got ${ladder.length})`);
}

(async () => {
  // 1. fine-direct-bottom-is-band: interpolateBandLadder, band [12.6, 7.2, 5], min 3, 10 rungs.
  await check('1. fine-direct-bottom-is-band', () => {
    // Act
    const got = interpolateBandLadder({ cost: COST, marginsPct: BAND, minMarginPct: 3, rungs: 10, minDecrement: 500 });
    // Assert
    assertFineWithinBand(got.ladder, got.floor, 'interpolateBandLadder');
  });

  // 2. fine-engine-bottom-is-band: the real arm path on a 10-bid soft-close allowlisted load, min 3.
  await check('2. fine-engine-bottom-is-band', () => {
    // Arrange
    const eng = mkEngine();
    // Act
    const m = armSoft(eng, 'HAVELLS-SOFT-MIN3', 3);
    // Assert
    assertFineWithinBand(m.ladder, m.floor, 'armed fine ladder');
  });

  // 3. fine-min-equals-bottom-unchanged (pin): the same load with min 5 builds exactly today's fine ladder.
  await check('3. fine-min-equals-bottom-unchanged', () => {
    // Arrange
    const eng = mkEngine();
    // Act
    const direct = interpolateBandLadder({ cost: COST, marginsPct: BAND, minMarginPct: 5, rungs: 10, minDecrement: 500 });
    const m = armSoft(eng, 'HAVELLS-SOFT-MIN5', 5);
    // Assert
    assert.deepStrictEqual(direct.ladder, MIN5_FINE, 'direct fine ladder for min == band bottom is unchanged');
    assert.strictEqual(direct.floor, BAND_BOTTOM);
    assert.deepStrictEqual(m.ladder, MIN5_FINE, 'armed fine ladder for min == band bottom is unchanged');
    assert.strictEqual(m.floor, BAND_BOTTOM);
  });

  cleanup();
  if (failed.length) {
    console.error(`\nFAILED ${failed.length}/${TOTAL}: ${failed.join(', ')} - the minimum-margin guard is the fine ladder's bottom anchor, so rungs are spread below the band's lowest price`);
    process.exit(1);
  }
  console.log(`\n${pass}/${TOTAL} checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
