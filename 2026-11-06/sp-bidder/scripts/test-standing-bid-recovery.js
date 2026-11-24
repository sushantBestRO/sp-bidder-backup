'use strict';
/**
 * Recovering the standing bid from an intent that predates `landedBidPrice` must never report a
 * price ABOVE the one the board really holds.
 *
 * This is deploy-day machinery and not an edge case: `sh scripts/deploy.sh` restarts pm2 mid-auction,
 * so on the day the field ships EVERY live load rehydrates off an intent that does not carry it, and
 * arm() has to derive the standing price from `ladder` + `firedRungs` + `landedBids` instead.
 *
 * The recovery took the LOWEST fired index (the highest price) whenever firedRungs.length diverged
 * from landedBids, on the reasoning that a divergence means an unidentifiable refusal is banked in
 * the set. It is the wrong direction. The durable firedRungs is written at LANDED sites only, each
 * writing the whole set with the rung that just landed already added, and selectRung only walks DOWN
 * the ladder - so a refusal banked after the last landed bid never reaches disk, and one banked
 * before it carries a LOWER index. The divergence shape is therefore "early rung refused, later
 * rungs landed", where the lowest index is the REFUSED opening and the recovery overstates.
 *
 * Overstating is the unsafe direction, because standingBid() feeds assertLadderReachable: the
 * /price page then SAVES a re-price no rung of which the portal can accept, and the load goes
 * silently dark. Understating refuses at the page with a corrective message instead.
 *
 *   node scripts/test-standing-bid-recovery.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder } = require('../src/engine/pricing');
const { assertLadderReachable } = require('../src/pricing/priceRequests');

let pass = 0;
const EXPECTED_CHECKS = 5;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// Load 260908LD2Z's own geometry: Rs 29,000 on Waaree's inherited band (9 / 5 / 1).
const COST = 29_000, BAND = [9, 5, 1];
const LADDER = [31_610, 30_450, 29_290];
const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;
const FLOOR_WINDOW_MS = 2_500;

const st = (rem) => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: rem, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

// `refuseCalls` names the 1-based placeBid attempts SuperProcure turns down with a PRICE-class
// refusal - the ordinary "Amount is invalid" shape, not a cap and not a not-biddable load.
function mkEngine(tag, refuseCalls) {
  const f = path.join(os.tmpdir(), `standing-recovery-${tag}-${process.pid}.json`);
  let call = 0;
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => st(REMAINING_MS),
    async placeBid(id, price) {
      this.placed.push(price);
      if (refuseCalls.includes(++call)) return { accepted: false, reason: 'Amount is invalid', status: 400, text: 'Amount is invalid' };
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0 }, live: true });
  return { engine, adapter, f };
}

// Strip the field the recovery exists to replace, exactly as an intent written before it existed
// carries it: absent, with the ladder + rung history it was armed on still intact.
function asPreFixIntent(engine) {
  engine.scheduler.update('LD2Z', { landedBidPrice: null });
}

(async () => {
  // ---- 0) Fixture sanity. Every price below is hand-derived from buildBandLadder's spec. ----
  {
    assert.deepStrictEqual(buildBandLadder({ cost: COST, marginsPct: BAND, minMarginPct: 1 }).ladder, LADDER,
      'the hand-derived ladder matches buildBandLadder');
    ok('fixture sanity: the 31,610 / 30,450 / 29,290 ladder is the builder\'s own');
  }

  // ---- 1) THE COMMONEST DIVERGENCE, produced by the engine rather than hand-written onto an intent:
  // the opening rung is REFUSED, the two below it LAND. firedRungs reaches disk as [0,1,2] against a
  // landedBids of 2, and the board holds the floor rung. ----
  {
    const h = mkEngine('refused-opening', [1]);
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, st(REMAINING_MS));        // rung 0 - refused
    await h.engine._maybeBid(m1, st(REMAINING_MS));        // rung 1 - lands
    await h.engine._maybeBid(m1, st(1_500));               // the decisive shot takes the floor - lands

    const intent = h.engine.scheduler.get('LD2Z');
    assert.deepStrictEqual(h.adapter.placed, LADDER, 'precondition: all three rungs went on the wire');
    assert.deepStrictEqual(intent.firedRungs, [0, 1, 2], 'precondition: the refused rung is banked on disk with the landed ones');
    assert.strictEqual(intent.landedBids, 2, 'precondition: only two of the three landed, so the counts diverge');
    assert.strictEqual(intent.landedBidPrice, LADDER[2], 'precondition: the board really holds 29,290');

    asPreFixIntent(h.engine);
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);

    assert.strictEqual(m2.lastBidPrice, LADDER[2],
      'the recovered standing price is the last LANDED rung, not the refused opening banked beside it');
    ok('a refused opening followed by landed rungs recovers the price the board holds, not the one it refused');

    const standing = h.engine.standingBid('LD2Z');
    assert.strictEqual(standing.price, LADDER[2], 'and standingBid hands the gate that same number');
    // The scan's own scenario: the desk re-prices into a band whose floor is Rs 30,000. No rung of it
    // can improve on the 29,290 standing, so the gate must refuse at the page.
    assert.throws(() => assertLadderReachable({ floor: 30_000, ladder: [33_000, 31_500, 30_000] }, standing),
      (e) => e.code === 'UNREACHABLE' && e.standingBidPrice === LADDER[2],
      'a band that cannot beat the real board is refused at the price page, not saved and left to go dark');
    h.engine.kill(); try { fs.unlinkSync(h.f); } catch (_) {}
    ok('the re-price gate refuses an unreachable band instead of passing it on an overstated standing price');
  }

  // ---- 2) THE OPPOSITE ORDER, and the one the divergence branch was reaching for: a rung LANDS and
  // the next is REFUSED. That refusal is in memory only - the durable set is written at landed sites
  // alone - so the counts AGREE and the recovery must still name the landed price. The gate has to
  // stay open for a legitimate downward re-price here; refusing it is terminal for the auction. ----
  {
    const h = mkEngine('refused-after-landing', [2]);
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, st(REMAINING_MS));        // rung 0 - lands
    await h.engine._maybeBid(m1, st(REMAINING_MS));        // rung 1 - refused

    const intent = h.engine.scheduler.get('LD2Z');
    assert.deepStrictEqual(intent.firedRungs, [0],
      'precondition: a refusal AFTER the last landed bid never reaches disk - the durable set is landed-only');
    assert.strictEqual(intent.landedBids, 1, 'precondition: one bid on the board');
    assert.strictEqual(intent.landedBidPrice, LADDER[0], 'precondition: the board holds the opening rung');

    asPreFixIntent(h.engine);
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);

    assert.strictEqual(m2.lastBidPrice, LADDER[0],
      'the recovery does not understate either - the refused rung below the board is not on the record to be read');
    assert.doesNotThrow(() => assertLadderReachable({ floor: 27_000, ladder: [29_000, 28_000, 27_000] }, h.engine.standingBid('LD2Z')),
      'so a genuine downward re-price still passes the gate');
    h.engine.kill(); try { fs.unlinkSync(h.f); } catch (_) {}
    ok('a refusal taken after the last landed bid cannot drag the recovered price below the board');
  }

  // ---- 3) THE CLEAN SHAPE, unchanged: every fired rung landed. ----
  {
    const h = mkEngine('all-landed', []);
    const m1 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    await h.engine._maybeBid(m1, st(REMAINING_MS));
    await h.engine._maybeBid(m1, st(1_500));

    const intent = h.engine.scheduler.get('LD2Z');
    assert.strictEqual(intent.firedRungs.length, intent.landedBids, 'precondition: the counts agree');
    const board = intent.landedBidPrice;
    asPreFixIntent(h.engine);
    h.engine.stop('LD2Z');
    const m2 = h.engine.arm(mkLoad('LD2Z'), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    assert.strictEqual(m2.lastBidPrice, board, 'the lowest landed price is recovered exactly');
    h.engine.kill(); try { fs.unlinkSync(h.f); } catch (_) {}
    ok('an all-landed history still recovers its lowest rung');
  }

  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
