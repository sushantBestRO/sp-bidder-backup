'use strict';
/**
 * SPENT ATTEMPTS SURVIVE A RESTART - a price the portal refused is never re-offered after pm2 comes
 * back up.
 *
 * `sh scripts/deploy.sh` restarts pm2 on every deploy, and #240 put GoComet's open auctions through
 * engine.rehydrate() for the first time over 52 records stuck at 'bidding'. rehydrate() re-enters
 * arm(), which rebuilt every refusal verdict from scratch: the refused-price run, the raise refusal
 * and the submission-closed latch all lived in memory alone, so the engine came back believing the
 * portal had never answered. On the 7 of 12 SuperProcure customers at branchBidCountAllowed <= 3 and
 * on GoComet's 3-per-vendor cap, a post-restart re-walk can re-spend the whole auction budget at
 * prices the portal has already refused - and bidEngine.js:5711-5713 says the platform may well count
 * a refused write against the cap, in which case the next genuine attempt hits "Bid limit exceeded"
 * and the reserved floor shot never fires.
 *
 * WHAT THIS PINS, and every part after the first is as load-bearing as it:
 *   - a RESTART resumes the same quote, so the verdicts the portal gave still apply and no refused
 *     price goes back on the wire (1-3);
 *   - a RE-PRICE is a quote the portal has never ruled on, so it must re-learn from scratch - and
 *     that holds whether the ladder MOVED (4) or came back byte-identical off an untouched band
 *     (6), which is the case ladder equality got wrong and silenced the load for;
 *   - a restart may not walk the ladder DOWN on a verdict the engine deliberately re-learns (5);
 *   - the desk's close receipt still names the refusal once the latch survives the restart (7);
 *   - an intent written before the epoch existed behaves correctly in both directions (8), which on
 *     ship day is every live auction.
 *
 * THE DIRECTION THAT MATTERS: going silent is the expensive failure here, not writing once too
 * often, so the checks that assert an empty wire (2, 3) are paired with ones that assert a
 * non-empty one (5, 6, 8). An assertion built by looping over what was sent cannot tell "re-offered
 * nothing refused" from "never wrote again", and that is how this file first shipped.
 *
 * A LIFETIME HERE IS A REAL RESTART: a fresh BidEngine and a fresh DurableScheduler over the SAME
 * intents file, resumed through the real rehydrate() -> arm() path. Nothing is stubbed but the
 * platform adapter, and the ladder is the one the real band derivation produces (cost 100,000 at
 * [12, 7, 2] -> [112000, 107000, 102000]) rather than one assigned onto the monitor, because the
 * restart-vs-re-price distinction is about the quote the intent rebuilds.
 *
 *   node scripts/test-refused-price-survives-restart.js
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

// COMPLETION SENTINEL - run-tests.js grades this file by exit code alone, so an async file that ends
// early reads as a silent green.
const EXPECTED_CHECKS = 10;
process.on('exit', () => {
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `refused-restart-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

// ------------------------------------------------------------------------------------------------
// FIXTURES
// ------------------------------------------------------------------------------------------------
const ID = 'RESTART-1';
const META = { id: ID, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
  companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
const INPUTS = { cost: 100_000, marginsPct: [12, 7, 2] };
const LADDER = [112_000, 107_000, 102_000];
const FLOOR = 102_000;

// A five-rung ladder for the walk-down checks: three rungs cannot tell "repeated the same rung" from
// "stepped once and stopped", and the defect under test concedes one rung per process lifetime.
const WIDE_INPUTS = { cost: 100_000, marginsPct: [15, 12, 9, 6, 3] };
const WIDE_LADDER = [115_000, 112_000, 109_000, 106_000, 103_000];

// SuperProcure's verbatim wording for the two verdicts the engine deliberately RE-LEARNS rather than
// carries: they are live platform state about a load it may since have reopened.
const NOT_BIDDABLE = 'Load not available for bidding';
const QTY_REFUSED = 'Quote quantity is greater than total quantity';

// SuperProcure's verbatim numeric cap. With the cap AT the floor rung, raiseRefusal returns null and
// nothing terminal latches - this is the residual price/state class, where the only thing that can
// stop a re-send is the refused-price run itself. Each ladder needs its own: a cap below the WHOLE
// ladder latches priceRaiseRefused instead, which stands the load down after one write and would
// have the spent-rung checks measuring the terminal latch rather than the carry.
const spCap = (n) => `Amount is invalid. Amount should be less than or equal to ${n}`;
const CAP_AT_FLOOR = spCap(FLOOR);
const WIDE_CAP_AT_FLOOR = spCap(WIDE_LADDER[WIDE_LADDER.length - 1]);
// The same wording with the cap BELOW the whole ladder latches priceRaiseRefused - terminal for
// submission on this load.
const CAP_BELOW_LADDER = spCap(90_000);

// A 3-revision branch: the budget where one repeated price IS a third of the auction.
function mkEngine(file) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: false },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function refuseAll(eng, body, { status = 400 } = {}) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return { accepted: false, reason: body, status, text: body };
  };
  return box;
}

const state = (remaining) => ({ closesInMs: remaining, myRank: null, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

async function driveMaybeBid(eng, m, { from = 160_000, to = 0, maxTicks = 20_000 } = {}) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

function detach(m) { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } return m; }

/** One process lifetime over an existing intents file: fresh engine, real rehydrate, real drive. */
async function restartLifetime(file, body) {
  const eng = mkEngine(file);
  const box = refuseAll(eng, body);
  await eng.rehydrate();
  const m = eng.monitors.get(ID);
  assert.ok(m, 'rehydrate() did not re-arm the load - the restart path under test never ran');
  detach(m);
  await driveMaybeBid(eng, m);
  return { eng, m, attempted: box.attempted };
}

/** The verdicts as they actually reached disk, read back the way the next process will read them. */
function persistedRefusal(file) {
  const it = new DurableScheduler(file).get(ID);
  return (it && it.refusalState) || null;
}

/** Rewrite the intents file the way a process without the re-price epoch would have left it. */
function stripEpochOnDisk(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const it of raw.intents) {
    if (!it || it.auctionId !== ID) continue;
    delete it.repriceEpoch;
    if (it.refusalState) delete it.refusalState.epoch;
  }
  fs.writeFileSync(file, JSON.stringify(raw));
}

(async () => {
  // ============================================================================================
  // 1. BASELINE - the first lifetime walks the ladder, one write per rung, and must keep doing so.
  //    If this moves, checks 2 and 3 are measuring the wrong thing.
  // ============================================================================================
  await check('first lifetime: each rung goes on the wire exactly once', async () => {
    const file = tmp();
    const eng = mkEngine(file);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    const m = detach(eng.arm(META, INPUTS));
    assert.deepStrictEqual(m.ladder, LADDER, `the band derivation moved: armed ladder ${JSON.stringify(m.ladder)}`);
    await driveMaybeBid(eng, m);
    assert.deepStrictEqual(box.attempted, LADDER,
      `a fresh lifetime should offer each rung once. Prices sent: [${box.attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 2. THE RULING. Three further process lifetimes over the same intents file, each resumed through
  //    rehydrate(). Not one price the portal already refused may go back on the wire.
  // ============================================================================================
  await check('three restarts re-offer NO price the portal already refused', async () => {
    const file = tmp();
    const eng1 = mkEngine(file);
    const box1 = refuseAll(eng1, CAP_AT_FLOOR);
    await driveMaybeBid(eng1, detach(eng1.arm(META, INPUTS)));
    const refused = new Set(box1.attempted);

    const resent = [];
    let totalAfter = 0;
    for (let lifetime = 2; lifetime <= 4; lifetime++) {
      const { attempted } = await restartLifetime(file, CAP_AT_FLOOR);
      totalAfter += attempted.length;
      for (const p of attempted) if (refused.has(p)) resent.push(`lifetime ${lifetime}: ${p}`);
    }

    assert.deepStrictEqual(resent, [],
      `a refused price was re-sent after a restart: ${resent.join('; ')}. `
      + `${box1.attempted.length} writes in lifetime 1, ${totalAfter} across the three restarts - `
      + 'on a 3-attempt auction that re-spends the whole budget at prices the portal has already refused');

    // STATED, not left to an empty loop. `resent` is built by iterating `attempted`, so on a load
    // that writes nothing at all the loop never runs and the deepStrictEqual above is satisfied
    // vacuously - it cannot tell "re-offered nothing refused" from "went silent". Every rung of this
    // fixture was refused and the floor's run is at its bound, so zero is the correct total here and
    // asserting it directly is what makes the check say so. The complementary direction - a restart
    // lifetime that CAN still bid - is checks 5 and 6, which assert non-empty wire traffic.
    assert.strictEqual(totalAfter, 0,
      `the three restarts put ${totalAfter} write(s) on the wire against a portal that had already `
      + 'refused every rung of this ladder');
  });

  // ============================================================================================
  // 2b. THE PERSISTED SHAPE ITSELF. The floor rung stays offerable only because
  //     _persistRefusalState runs AFTER the nothing-placed restore un-banks it. Nothing else in the
  //     suite pins that ordering, so moving the persist one block up is a silent, money-losing edit.
  // ============================================================================================
  await check('a refused FLOOR is never persisted as spent', async () => {
    const file = tmp();
    const eng = mkEngine(file);
    refuseAll(eng, CAP_AT_FLOOR);
    await driveMaybeBid(eng, detach(eng.arm(META, INPUTS)));

    const rs = persistedRefusal(file);
    assert.ok(rs, 'no refusalState reached disk, so this check is not exercising the persist');
    assert.ok(!rs.offeredRungs.includes(LADDER.length - 1),
      `the floor rung was banked on disk as already offered (offeredRungs ${JSON.stringify(rs.offeredRungs)}). `
      + 'Both snipe paths gate on it, so a restart abandons the single decisive shot of the auction.');
  });

  // ============================================================================================
  // 3. THE TERMINAL LATCH. A raise refusal stands the load down for submission entirely; a restart
  //    must not hand it a fresh ladder to walk.
  // ============================================================================================
  await check('a raise refusal stands the load down across a restart', async () => {
    const file = tmp();
    const eng1 = mkEngine(file);
    const box1 = refuseAll(eng1, CAP_BELOW_LADDER);
    const m1 = detach(eng1.arm(META, INPUTS));
    await driveMaybeBid(eng1, m1);
    assert.strictEqual(m1.priceRaiseRefused, true,
      'the fixture did not latch priceRaiseRefused, so this check is not exercising the latch');

    const { m, attempted } = await restartLifetime(file, CAP_BELOW_LADDER);
    assert.strictEqual(m.priceRaiseRefused, true,
      'the raise refusal was forgotten across the restart - the load is standing down on nothing');
    assert.deepStrictEqual(attempted, [],
      `a load the portal had refused to take an upward revision on put ${attempted.length} more `
      + `write(s) on the wire after a restart: [${attempted.join(', ')}]`);
  });

  // ============================================================================================
  // 4. THE OTHER HALF. A genuine re-price rebuilds the ladder, so every verdict above is about
  //    prices that no longer exist and the load must re-learn. This is the check that fails if the
  //    fix persists the verdicts against the LOAD rather than against the ladder.
  // ============================================================================================
  await check('a genuine re-price re-learns - the load is not poisoned by the old ladder', async () => {
    const file = tmp();
    const eng = mkEngine(file);
    const box = refuseAll(eng, CAP_BELOW_LADDER);
    await driveMaybeBid(eng, detach(eng.arm(META, INPUTS)));
    assert.ok(box.attempted.length > 0, 'nothing was refused, so there is no verdict to re-learn from');

    // The desk corrects the cost downward: stop + arm is what armFromRequest does on a re-price.
    eng.stop(ID);
    box.attempted.length = 0;
    const m2 = detach(eng.arm(META, { cost: 80_000, marginsPct: [12, 7, 2] }));
    assert.notDeepStrictEqual(m2.ladder, LADDER, 'the re-price did not move the ladder, so this check proves nothing');
    assert.strictEqual(m2.priceRaiseRefused, false, 'a re-priced load inherited a verdict about the old ladder');
    await driveMaybeBid(eng, m2);

    assert.deepStrictEqual(box.attempted, m2.ladder,
      `a re-priced load must offer its new ladder. Prices sent: [${box.attempted.join(', ')}], `
      + `new ladder: [${m2.ladder.join(', ')}]`);
  });

  // ============================================================================================
  // 5. A RESTART MUST NOT WALK THE LADDER DOWN. loadNotBiddable is live platform state, so the
  //    engine re-learns it each lifetime at the cost of one refused write - the deployed behaviour.
  //    Carrying the SPEND while dropping the VERDICT is what turned that into a walk: the banked
  //    rung is what selectRung walks on, so each restart wrote the next price down and conceded a
  //    rung of margin per deploy.
  // ============================================================================================
  for (const [label, body] of [['load not biddable', NOT_BIDDABLE], ['quantity refused', QTY_REFUSED]]) {
    await check(`a restart re-offers the same rung on "${label}", never the one below it`, async () => {
      const file = tmp();
      const eng = mkEngine(file);
      const box1 = refuseAll(eng, body);
      const m1 = detach(eng.arm(META, WIDE_INPUTS));
      assert.deepStrictEqual(m1.ladder, WIDE_LADDER,
        `the band derivation moved: armed ladder ${JSON.stringify(m1.ladder)}`);
      await driveMaybeBid(eng, m1);

      const perLifetime = [box1.attempted.slice()];
      for (let lifetime = 2; lifetime <= 4; lifetime++) {
        const { attempted } = await restartLifetime(file, body);
        perLifetime.push(attempted.slice());
      }

      const top = WIDE_LADDER[0];
      assert.deepStrictEqual(perLifetime, [[top], [top], [top], [top]],
        `four lifetimes must each offer ${top} once and stand down on the portal's own verdict. `
        + `Sent: ${JSON.stringify(perLifetime)} - a descending sequence is a rung of margin conceded `
        + 'per deploy, and on a quantity refusal it also re-sends a vehicle count SuperProcure refused.');
    });
  }

  // ============================================================================================
  // 6. THE DISCRIMINATOR. A desk re-price that leaves the band untouched - a lowered truck count, a
  //    plain re-submit - rebuilds a BYTE-IDENTICAL ladder. Under ladder equality that read as a
  //    restart, so a quote the portal had never ruled on inherited every verdict about the last one
  //    and the load went completely silent against a portal that would have accepted.
  // ============================================================================================
  await check('a same-ladder re-price re-learns - the epoch, not the ladder, is what decides', async () => {
    const file = tmp();
    const eng = mkEngine(file);
    const box = refuseAll(eng, WIDE_CAP_AT_FLOOR);
    const m1 = detach(eng.arm(Object.assign({}, META, { repriceEpoch: 0 }), WIDE_INPUTS));
    await driveMaybeBid(eng, m1);
    assert.deepStrictEqual(box.attempted, WIDE_LADDER, 'lifetime 1 did not spend the ladder, so there is no verdict to inherit');

    // The desk lowers the truck count and re-submits the same band: stop + arm, as reArmWithNewBand
    // does, with the epoch priceRequests bumps on every re-price write.
    eng.stop(ID);
    box.attempted.length = 0;
    const m2 = detach(eng.arm(Object.assign({}, META, { repriceEpoch: 1, bidVehicleCount: 1 }), WIDE_INPUTS));
    assert.deepStrictEqual(m2.ladder, WIDE_LADDER,
      'the re-price moved the ladder, so this check is measuring the case that already worked');
    await driveMaybeBid(eng, m2);

    assert.deepStrictEqual(box.attempted, WIDE_LADDER,
      `a re-priced load must offer its whole ladder to a portal that has never ruled on this quote. `
      + `Sent: [${box.attempted.join(', ')}] - an empty list is the load going silent with nothing said to the desk.`);
  });

  // ============================================================================================
  // 7. THE DESK'S RECEIPT. priceRaiseRefused now survives the restart, and that is precisely what
  //    makes the reason NOT re-record itself: the restored latch sends every later tick out through
  //    the stand-down gate before the classification block can run. Without a fallback the close
  //    receipt drops to a generic LOST and the desk reads a broken bot instead of a portal refusal.
  // ============================================================================================
  await check('the close receipt still names the refusal after a restart', async () => {
    const file = tmp();
    const eng1 = mkEngine(file);
    refuseAll(eng1, CAP_BELOW_LADDER);
    const m1 = detach(eng1.arm(META, INPUTS));
    await driveMaybeBid(eng1, m1);
    assert.strictEqual(m1.noBid && m1.noBid.reason, 'price_raise_refused',
      'lifetime 1 did not record the reason, so this check cannot show it being lost');

    const { eng, m } = await restartLifetime(file, CAP_BELOW_LADDER);
    assert.strictEqual(m.noBid, null,
      'noBid re-recorded itself after the restart - the premise this fallback exists for no longer holds, '
      + 'so re-check whether the fallback is still the right shape');

    await eng._finalize(m, state(0));
    const outcome = eng._events.filter((e) => e.type === 'auction_result').pop();
    assert.ok(outcome, 'no auction_result was emitted, so the receipt path never ran');
    assert.strictEqual(outcome.noBidReason, 'price_raise_refused',
      `the close receipt lost the refusal reason across the restart (noBidReason ${JSON.stringify(outcome.noBidReason)}). `
      + 'The desk sees a generic LOST and can reasonably conclude the bot failed.');
    assert.strictEqual(outcome.noBidAmountCap, 90_000,
      `the receipt lost the cap the portal named (${JSON.stringify(outcome.noBidAmountCap)})`);
  });

  // ============================================================================================
  // 8. SHIP DAY. `sh scripts/deploy.sh` restarts pm2 mid-day, so on the day this ships EVERY live
  //    auction rehydrates off an intent written without the epoch. Both directions have to hold on
  //    that record: the restart still carries, and a re-price on it still drops.
  // ============================================================================================
  await check('an intent written before the epoch existed still carries, and still drops on a re-price', async () => {
    const file = tmp();
    const eng1 = mkEngine(file);
    const box1 = refuseAll(eng1, CAP_AT_FLOOR);
    await driveMaybeBid(eng1, detach(eng1.arm(META, INPUTS)));
    assert.deepStrictEqual(box1.attempted, LADDER, 'lifetime 1 did not spend the ladder');

    stripEpochOnDisk(file);
    const { eng, attempted } = await restartLifetime(file, CAP_AT_FLOOR);
    assert.deepStrictEqual(attempted, [],
      `a pre-epoch intent lost its restart carry-back and re-sent [${attempted.join(', ')}] - `
      + 'on ship day that is every live auction re-walking a ladder the portal already refused');

    eng.stop(ID);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    const m = detach(eng.arm(Object.assign({}, META, { repriceEpoch: 1 }), INPUTS));
    await driveMaybeBid(eng, m);
    assert.deepStrictEqual(box.attempted, LADDER,
      `a re-price on a pre-epoch intent must still re-learn. Sent: [${box.attempted.join(', ')}]`);
  });
})();
