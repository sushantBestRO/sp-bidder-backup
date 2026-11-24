'use strict';
/**
 * A SHIPPER CEILING THAT LOWERS THE OPENING PRICE MUST NOT LEAVE A PRICE THE ENGINE CANNOT SEND.
 *
 * Regression target: T4 D1 (R2-9). _planFor spaces the ladder so every step clears the
 * load's minimum bid difference. arm() then caps the ladder to the shipper ceiling, and the cap
 * lowers the opening onto the ceiling, which narrows the first step. Nothing re-spaces or re-checks
 * the capped ladder. The monitor is armed on a step the platform refuses, _maybeBid skips that price
 * every tick, and the load makes one attempt fewer than the desk was shown. This hits every
 * ceiling-carrying load where the ceiling is the binding constraint, with no feature gate.
 *
 * Cost 40,000, band [25, 12.5, 7.5, 2.5], minimum 2.5, minimum bid difference 1,000, bid cap 4:
 *   band prices round(40000 x 1.25 / 1.125 / 1.075 / 1.025) = [50000, 45000, 43000, 41000]
 *   every step (5000 / 2000 / 2000) clears 1,000, so the spaced ladder is the band as typed
 *   ceiling 45,200 -> the cap gives [45200, 45000, 43000, 41000], first step 200 < 1,000
 *   the middle price has room: it must sit <= 45200 - 1000 = 44200 and >= 43000 + 1000 = 44000,
 *   so four prices fit under the ceiling and all four must be armed as sendable.
 *
 * WHAT MUST NOT MOVE:
 *   - with no ceiling the band is armed as typed and four bids go out (this also proves the drive
 *     harness can deliver four bids, so a red on check 2 is the mechanism);
 *   - ruling 30: a ceiling between the minimum-margin guard and the lowest band price arms exactly
 *     one price, the ceiling, and bids it once (cost 100,000, band [12.6, 7.2, 6.3], minimum 5,
 *     guard 105,000, ceiling 105,500 -> [105500]);
 *   - a ceiling whose cap leaves every step clear (46,000) or lands on a band price (45,000) arms the
 *     capped ladder unchanged;
 *   - the capped ladder still opens at the ceiling and ends at the lowest band price, and no price
 *     rises above the ceiling or falls below the guard.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), a virtual clock
 * stepped by the delay the engine schedules. No RNG on an asserted path, no sleeps.
 *
 *   node scripts/test-ceiling-cap-keeps-rung-spacing.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { decrementViolations, fittingRungs } = require('../src/engine/pricing');

const MIN_DEC = 1_000;
const BID_CAP = 4;
const BAND = { cost: 40_000, marginsPct: [25, 12.5, 7.5, 2.5], minMarginPct: 2.5 };
const BAND_PRICES = [50_000, 45_000, 43_000, 41_000];
const GUARD = 41_000;
const CEILING = 45_200;
const GAP_BAND = { cost: 100_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const GAP_CEILING = 105_500;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `ceiling-cap-spacing-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
quiet.child = () => quiet;

function mkEngine(adapter) {
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, cadenceJitterMs: 0, minInterFireMs: 0 },
    rand: () => 0,
    log: quiet,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

const idleAdapter = () => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: MIN_DEC, revisionLimit: null, closeModel: 'unknown' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => { throw new Error('placeBid must not be reached here'); },
});

const metaFor = (ceilingPrice, closesAt) => ({
  id: String(810_000 + seq++), lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
  companyName: 'Acme Cables', branchName: 'MAIN', closesAt,
  rules: { revisionLimit: BID_CAP, minDecrement: MIN_DEC, pricingMode: 'flat', ceilingPrice, costByType: null },
});

function armOn(eng, ceilingPrice, band) {
  const m = eng.arm(metaFor(ceilingPrice, Date.now() + 900_000), band);
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

function previewOn(ceilingPrice, band) {
  return mkEngine(idleAdapter()).planPreview(metaFor(ceilingPrice, Date.now() + 900_000), band);
}

// One hard-close load from 70s out to the close through the real _tick. Rank is null until our first
// bid lands and 2 (outranked) after every bid, so each price on the ladder gets its chance.
async function runToClose(ceilingPrice, band) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    const closeAt = vnow + 70_000;
    const sent = [];
    let rank = null;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: MIN_DEC, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: closeAt - vnow > 0 ? 'live' : 'closed', myRank: rank,
        totalBidders: 5, standingL1Price: null, closesInMs: closeAt - vnow, revisionLimit: BID_CAP,
        closeModel: 'hard', minDecrement: MIN_DEC, measuredRttMs: 80 }),
      placeBid: async (id, price) => {
        sent.push(price);
        rank = 2;
        return { accepted: true, ok: true, myRank: 2, revisionsLeft: null };
      },
    };
    const eng = mkEngine(adapter);
    let nextDelay = null;
    eng._schedule = (mon, d) => { nextDelay = d; };
    const m = eng.arm(metaFor(ceilingPrice, closeAt), band);
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    for (let ticks = 0; !m.finalized && ticks < 5_000; ticks++) {
      nextDelay = null;
      await eng._tick(m);
      if (m.finalized || nextDelay == null) break;
      vnow += Math.max(1, nextDelay);
    }
    return { sent, monitor: m };
  } finally { Date.now = REAL_NOW; }
}

const steps = (ladder) => ladder.slice(1).map((p, i) => ladder[i] - p);

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 7;
process.on('exit', (code) => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nPASS ceiling cap keeps rung spacing: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - the ceiling cap narrows a step below the `
    + 'minimum bid difference after the ladder was spaced, and the armed load silently skips that price');
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n         ' + (e && e.message));
  }
}

(async () => {
  console.log('ceiling cap keeps rung spacing');

  await check('1 armed-ladder-clears-min-gap: ceiling 45,200 arms four prices, every step >= 1,000', () => {
    const m = armOn(mkEngine(idleAdapter()), CEILING, BAND);
    assert.strictEqual(m.ceilingBelowFloor, false, 'precondition: the ceiling sits above the lowest band price');
    const bad = decrementViolations(m.ladder, MIN_DEC);
    assert.deepStrictEqual(bad, [],
      `armed ladder [${m.ladder}] has steps [${steps(m.ladder)}]: the cap lowered the opening onto ${CEILING} `
      + `and left a ${bad.length ? bad[0].gap : '?'} step against a ${MIN_DEC} minimum bid difference, so that price can never be sent`);
    const fits = fittingRungs(m.ladder, MIN_DEC, null, { lastRungAlwaysAttempted: true });
    assert.strictEqual(fits.length, 4, `only ${fits.length} of the armed [${m.ladder}] can be sent; four fit under ${CEILING}`);
  });

  await check('2 armed-load-sends-four: ceiling 45,200 driven to the close sends four prices, steps >= 1,000', async () => {
    const { sent, monitor } = await runToClose(CEILING, BAND);
    assert.strictEqual(sent.length, 4,
      `sent [${sent}] from the armed [${monitor.ladder}]: the ${monitor.ladder[1]} price sits ${monitor.ladder[0] - monitor.ladder[1]} `
      + `under the capped opening, below the ${MIN_DEC} minimum, so the load made one attempt fewer than it had`);
    assert.ok(steps(sent).every((g) => g >= MIN_DEC), `a sent step is under ${MIN_DEC}: [${sent}]`);
  });

  await check('3 preview-matches-arm: planPreview for ceiling 45,200 shows the armed ladder, every price sendable', () => {
    const pv = previewOn(CEILING, BAND);
    const m = armOn(mkEngine(idleAdapter()), CEILING, BAND);
    assert.deepStrictEqual(pv.ladder, m.ladder, `preview [${pv.ladder}] vs armed [${m.ladder}]`);
    assert.deepStrictEqual(pv.fittingPrices, pv.ladder,
      `the preview lists [${pv.ladder}] but only [${pv.fittingPrices}] can be sent - the capped ladder was never re-spaced`);
  });

  await check('4 control-no-ceiling: the band arms as typed and four bids go out', async () => {
    const m = armOn(mkEngine(idleAdapter()), null, BAND);
    assert.deepStrictEqual(m.ladder, BAND_PRICES, `armed ladder: ${m.ladder}`);
    const { sent } = await runToClose(null, BAND);
    assert.deepStrictEqual(sent, BAND_PRICES, `sent [${sent}]`);
  });

  await check('5 pin-ruling-30: ceiling 105,500 between guard 105,000 and the lowest band price arms [105500] and bids once', async () => {
    const m = armOn(mkEngine(idleAdapter()), GAP_CEILING, GAP_BAND);
    assert.strictEqual(m.ceilingBelowFloor, false);
    assert.deepStrictEqual(m.ladder, [GAP_CEILING], `armed ladder: ${m.ladder}`);
    assert.deepStrictEqual(previewOn(GAP_CEILING, GAP_BAND).ladder, [GAP_CEILING]);
    const { sent } = await runToClose(GAP_CEILING, GAP_BAND);
    assert.deepStrictEqual(sent, [GAP_CEILING], `sent [${sent}]`);
  });

  await check('6 pin-clean-caps-unchanged: ceiling 46,000 arms [46000, 45000, 43000, 41000]; 45,000 arms [45000, 43000, 41000]', () => {
    assert.deepStrictEqual(armOn(mkEngine(idleAdapter()), 46_000, BAND).ladder, [46_000, 45_000, 43_000, 41_000]);
    assert.deepStrictEqual(previewOn(46_000, BAND).ladder, [46_000, 45_000, 43_000, 41_000]);
    assert.deepStrictEqual(armOn(mkEngine(idleAdapter()), 45_000, BAND).ladder, [45_000, 43_000, 41_000]);
    assert.deepStrictEqual(previewOn(45_000, BAND).ladder, [45_000, 43_000, 41_000]);
  });

  await check('7 pin-cap-bounds: ceiling 45,200 arms a ladder opening at 45,200, ending at 41,000, inside [guard, ceiling]', () => {
    const m = armOn(mkEngine(idleAdapter()), CEILING, BAND);
    assert.strictEqual(m.ladder[0], CEILING, `opening: ${m.ladder[0]}`);
    assert.strictEqual(m.ladder[m.ladder.length - 1], 41_000, `last price: ${m.ladder[m.ladder.length - 1]}`);
    assert.strictEqual(m.floor, 41_000, `floor: ${m.floor}`);
    assert.ok(m.ladder.every((p) => p <= CEILING && p >= GUARD), `a price outside [${GUARD}, ${CEILING}]: [${m.ladder}]`);
    assert.ok(steps(m.ladder).every((g) => g > 0), `ladder not strictly descending: [${m.ladder}]`);
  });

  for (const e of ENGINES) { try { e.kill('test done'); } catch (_) {} }
  process.exit(ran === EXPECTED && pass === EXPECTED ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
