'use strict';
/**
 * REFUSED-PRICE BOUND LATCH - a price the engine told the desk it was holding stays held.
 *
 * Regression target: T5 F6.
 *
 * On a low-cap auction (a stated budget of 3 or less) the refused-price bound is 1: the platform
 * refuses a price once, the engine holds it, alerts the desk once and never sends it again. But the
 * bound is re-derived from THIS tick's state on every tick and nothing latches it. _attemptBudget
 * reads state.revisionLimit first, and SuperProcure's adapter maps that field as
 * `branchBidCountAllowed || loadBidCountAllowed || null` while its platform-static
 * caps.revisionLimit is null. So one listing frame whose cap field is missing, null or empty makes
 * the budget unknown, the bound reverts to the shipped 3 for that tick, and the fire-point gate opens
 * on the exact price the desk was told is held - with no second alert, because the hold's
 * once-per-run dedupe is still set. The bound must be monotone within a refusal run: it may tighten,
 * never loosen.
 *
 * Every mechanism check asserts on the fake adapter's own wire log, never on an engine flag.
 *
 * WHAT MUST NOT MOVE (checks 5-10):
 *   - a cap of 0 is a positive statement, not an unknown one, and already holds (check 5).
 *   - a steady tight cap holds the refused floor after one send (check 6).
 *   - an ample budget keeps the shipped bound of 3 - exactly 3 sends, not 1 (check 7).
 *   - a load that never states a cap keeps the shipped bound of 3 (check 8).
 *   - the bound MAY tighten: unknown at the first refusal, then a cap of 3 appears, and the price
 *     is not sent again (check 9).
 *   - a tight budget still walks the ladder - every rung is a new price (check 10).
 * Whether a latch clears on an accepted bid or on a new price is deliberately not pinned.
 *
 * Mock policy: only the adapter seam (capabilities to state the platform-static cap, placeBid to
 * refuse). Real BidEngine, real _maybeBid, DurableScheduler on a temp file, injected clock.
 *
 *   node scripts/test-refused-price-bound-latch.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let ran = 0, pass = 0;
const FAILURES = [];
const check = async (name, fn) => {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { FAILURES.push({ name, message: (e && e.message) ? e.message : String(e) }); console.log('  FAIL  ' + name); }
};

const EXPECTED_CHECKS = 10;
process.on('exit', () => {
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nPASS - ${EXPECTED_CHECKS} of ${EXPECTED_CHECKS} checks`); return; }
  console.error(`\nFAIL (T5 F6 - the refused-price bound is re-derived per tick and not latched): ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `refused-bound-latch-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

const LD2Z = [41_420, 40_736, 38_684];
const FLOOR = 38_684;
// Names a cap at the floor, so the refusal stays in the residual price/state class and nothing
// terminal latches: the bound under test is the only brake on a floor re-send.
const CAP_AT_FLOOR = `Amount is invalid. Amount should be less than or equal to ${FLOOR}`;
const TIGHT_BOUND = 1;
const AMPLE_BOUND = 3;
const OMIT = Symbol('omit');

const ENGINES = [];
function mkEngine({ capRevisionLimit = null, cfg } = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100,
      revisionLimit: capRevisionLimit, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfg || {}),
    softClose: { enabled: false },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  ENGINES.push(eng);
  return eng;
}

function armFine(eng, ladder, { id = 'F', revisionsLeft = 30 } = {}) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = 100_000;
  return m;
}

const mkState = (remaining, limit, extra) => {
  const s = { closesInMs: remaining, myRank: null, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 };
  if (limit !== OMIT) s.revisionLimit = limit;
  return Object.assign(s, extra || {});
};

function refuseAll(eng, body, { status = 400 } = {}) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return { accepted: false, reason: body, status, text: body };
  };
  return box;
}

const holdAlerts = (eng) => eng._events.filter((e) => e.type === 'alert'
  && (e.kind === 'refused_price_bound' || e.kind === 'refusal_unrecognised'));

// `limitFor(ctx)` picks each tick's state.revisionLimit (OMIT drops the key). ctx.hold is set the
// tick the engine first announces a hold, with the held price and the wire length at that moment.
async function drive(eng, m, box, limitFor, { from = 160_000, maxTicks = 20_000 } = {}) {
  const ctx = { hold: null, tick: 0 };
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    while (r >= 0 && ctx.tick++ < maxTicks) {
      await eng._maybeBid(m, mkState(r, limitFor(ctx)));
      if (!ctx.hold && holdAlerts(eng).length) {
        ctx.hold = { price: holdAlerts(eng)[0].price, wireAt: box.attempted.length };
      }
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
  return ctx;
}

const countOf = (arr, v) => arr.filter((x) => x === v).length;
const reOffersAfterHold = (box, hold) => (hold ? box.attempted.slice(hold.wireAt).filter((p) => p >= hold.price) : []);

// Every tick states a cap of 3, except the ONE tick right after the hold is announced, which
// carries `gapShape` - what the adapter's `||` chain hands the engine when the listing frame
// dropped the field.
async function gapRun(gapShape) {
  const eng = mkEngine({ capRevisionLimit: null });
  const m = armFine(eng, LD2Z);
  const box = refuseAll(eng, CAP_AT_FLOOR);
  const gap = { applied: false, floorSendsBefore: null };
  const ctx = await drive(eng, m, box, (c) => {
    if (c.hold && !gap.applied) {
      gap.applied = true;
      gap.floorSendsBefore = countOf(box.attempted, FLOOR);
      return gapShape;
    }
    return 3;
  });
  return { eng, m, box, gap, ctx };
}

function assertGapHeld({ box, gap, ctx }, label) {
  assert.ok(gap.applied, `fixture: no hold was ever announced, so the ${label} gap tick never ran`);
  assert.strictEqual(gap.floorSendsBefore, TIGHT_BOUND,
    `fixture: the floor had gone out ${gap.floorSendsBefore} times before the gap tick, expected the held single send`);
  assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
    `the floor price the desk was told is HELD went on the wire ${countOf(box.attempted, FLOOR)} times: one listing `
    + `frame whose cap arrived as ${label} made the budget unknown, the per-tick bound reverted from 1 to 3, and the `
    + `gate re-opened with no second alert. Prices sent: [${box.attempted.join(', ')}]`);
  assert.deepStrictEqual(reOffersAfterHold(box, ctx.hold), [],
    `after the hold alert at ${ctx.hold && ctx.hold.price} the engine still sent [${reOffersAfterHold(box, ctx.hold).join(', ')}]`);
}

(async () => {
  // 1. A listing frame that omits the cap field entirely.
  await check('1. a gap frame with NO revisionLimit key does not re-open a held price', async () => {
    assertGapHeld(await gapRun(OMIT), 'a missing field');
  });

  // 2-3. The other shapes that reach the engine as "no cap stated".
  await check('2. a gap frame with revisionLimit null does not re-open a held price', async () => {
    assertGapHeld(await gapRun(null), 'null');
  });

  await check('3. a gap frame with revisionLimit \'\' does not re-open a held price', async () => {
    assertGapHeld(await gapRun(''), 'an empty string');
  });

  // 4. The shrunk counterexample: a load already on its floor rung, four 200 ms ticks, the third
  //    listing frame without its cap. Expected wire log is [54000], not [54000, 54000].
  await check('4. pinned 4-tick sequence: the held floor goes on the wire once', async () => {
    const eng = mkEngine({ capRevisionLimit: null, cfg: { maxBidsPerMin: 10_000 } });
    const m = armFine(eng, [60_000, 58_000, 56_000, 54_000], { id: 'P', revisionsLeft: 3 });
    for (const i of [0, 1, 2]) m.firedRungs.add(i);
    m.currentRungIndex = 2;
    m.ownBidAttempts = 3;
    m.everBid = true;
    const wire = [];
    eng.adapter.placeBid = async (_id, price) => {
      wire.push(price);
      return { accepted: false, status: 400, reason: 'Bid amount should be less than previous bid amount', latencyMs: 5 };
    };
    const TICKS = [[1800, 3], [1600, 3], [1400, null], [1200, 3]];
    const REAL_NOW = Date.now;
    let vnow = REAL_NOW();
    Date.now = () => vnow;
    let hold = null;
    try {
      for (const [closesInMs, revisionLimit] of TICKS) {
        await eng._maybeBid(m, { closesInMs, myRank: 2, minDecrement: 100, standingL1Price: null,
          measuredRttMs: 50, revisionsLeft: null, revisionLimit, closeModel: 'soft' });
        if (!hold && holdAlerts(eng).length) hold = { price: holdAlerts(eng)[0].price, wireAt: wire.length };
        vnow += 200;
      }
    } finally { Date.now = REAL_NOW; }

    assert.deepStrictEqual(wire, [54_000],
      `wire log [${wire.join(', ')}], expected [54000]: the third tick's null cap reverted the per-tick bound `
      + 'from 1 to 3 and re-sent the floor the engine had already announced it was holding');
    const after = hold ? wire.slice(hold.wireAt).filter((p) => p >= hold.price) : [];
    assert.deepStrictEqual(after, [], `after the hold alert at ${hold && hold.price} the engine still sent [${after.join(', ')}]`);
  });

  // 5. CONTROL: a cap of 0 is a positive "no revisions" statement, read as a budget of 0 <= 3.
  await check('5. control: a gap frame with revisionLimit 0 already holds (0 is stated, not unknown)', async () => {
    assertGapHeld(await gapRun(0), '0');
  });

  // 6. CONTROL: the steady tight cap - proves the harness sees a correct hold.
  await check('6. control: steady tight cap holds the refused floor after one send', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    const ctx = await drive(eng, m, box, () => 3);
    assert.ok(ctx.hold, 'no hold was announced on a steady 3-revision budget');
    assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
      `steady cap 3: floor sent ${countOf(box.attempted, FLOOR)} times. Prices: [${box.attempted.join(', ')}]`);
  });

  // 7. CONTROL: an ample budget keeps the shipped bound - a latch that pins 1 everywhere fails here.
  await check('7. control: ample budget keeps the shipped bound of 3', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    await drive(eng, m, box, () => 30);
    assert.strictEqual(countOf(box.attempted, FLOOR), AMPLE_BOUND,
      `cap 30: floor sent ${countOf(box.attempted, FLOOR)} times, expected ${AMPLE_BOUND}. Prices: [${box.attempted.join(', ')}]`);
  });

  // 8. CONTROL: a load that never states a cap keeps the shipped bound.
  await check('8. control: unknown budget throughout keeps the shipped bound of 3', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    await drive(eng, m, box, () => OMIT);
    assert.strictEqual(countOf(box.attempted, FLOOR), AMPLE_BOUND,
      `no cap ever stated: floor sent ${countOf(box.attempted, FLOOR)} times, expected ${AMPLE_BOUND}. Prices: [${box.attempted.join(', ')}]`);
  });

  // 9. CONTROL: the bound may tighten mid-run - count 1 >= bound 1 once the cap of 3 appears.
  await check('9. control: a cap appearing after the first refusal tightens the bound', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    await drive(eng, m, box, () => (box.attempted.includes(FLOOR) ? 3 : OMIT));
    assert.ok(box.attempted.includes(FLOOR), 'the floor never went out at all');
    assert.strictEqual(countOf(box.attempted, FLOOR), TIGHT_BOUND,
      `cap 3 appeared after the first floor refusal and the floor still went out ${countOf(box.attempted, FLOOR)} times. `
      + `Prices: [${box.attempted.join(', ')}]`);
  });

  // 10. CONTROL: a tight budget still walks every rung - each is a new price.
  await check('10. control: a tight budget still walks the ladder down', async () => {
    const eng = mkEngine({ capRevisionLimit: null });
    const m = armFine(eng, LD2Z);
    const box = refuseAll(eng, 'Amount is invalid. Amount should be less than or equal to 50000');
    await drive(eng, m, box, () => 3);
    for (const rung of LD2Z) {
      assert.ok(box.attempted.includes(rung),
        `rung ${rung} never reached the wire on a tight budget. Prices: [${box.attempted.join(', ')}]`);
    }
  });

  for (const eng of ENGINES) { try { eng.kill('test-end'); } catch (_) {} }
})();
