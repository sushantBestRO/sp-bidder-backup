'use strict';
/**
 * RULING 62: A LANDED FOLLOW-UP FLOOR FIRES THE SAME DESK NOTICE AS THE LAST-RESORT FLOOR.
 *
 * Regression target: `_softFloorAfterFinalShot` (the ruling-F2 follow-up floor - see
 * scripts/test-softclose-floor-after-nonfloor-snipe.js) returns `{..., floorFollowUp: true}`, never
 * `lastResort`. The desk notice at the accepted-bid fire point is gated on `decision.lastResort`
 * only, so a landed follow-up floor - the desk's own lowest price, just spent - reaches the desk in
 * the bid-log bubble alone, never as "Final bid placed - this was our lowest, nothing more goes out on
 * this load". W1-9's refund already covers both markers (`decision.lastResort || decision.floorFollowUp`
 * at the release-attempt refund); this notice was the one consumer W1-9 deliberately left out.
 *
 * Rig lifted from test-softclose-floor-after-nonfloor-snipe.js (must stay green, unmodified) - case 1
 * there is this notice's own red scenario, just without an event listener wired to check it.
 *
 *   node scripts/test-followup-floor-notice.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const MIN_DEC = 100;
let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `followup-floor-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

function mkRig(respond, { mode = 'live' } = {}) {
  const wire = [];
  const events = [];
  const clock = { remaining: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: MIN_DEC, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { wire.push({ price, remaining: clock.remaining }); return respond(price, wire); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500 },
    softClose: { enabled: true, shippers: ['Transrail'], mode, reserve: 1 },
    onEvent: (e) => events.push(e),
    rand: () => 0,
  });
  ENGINES.push(eng);
  return { eng, wire, clock, events };
}
const accept = () => ({ accepted: true, status: 201, myRank: null, revisionsLeft: null });

function armLoad(eng, { extendCap = 3, extendsObserved = 3, standAt = 1 } = {}) {
  const meta = { id: String(25_600_000 + (++seq)), lane: { origin: 'NAGPUR', destination: 'BHOPAL' }, units: 1,
    companyName: 'Transrail Lighting Ltd', branchName: 'NAGPUR', closesAt: Date.now() + 900_000,
    rules: { revisionLimit: 10, minDecrement: MIN_DEC } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = 100_000;
  m.extendMs = 120_000;
  for (let i = 0; i <= standAt; i++) m.firedRungs.add(i);
  m.currentRungIndex = standAt;
  m.lastBidPrice = m.ladder[standAt];
  m.landedBids = standAt + 1;
  m.revisionsLeft = 10 - (standAt + 1);
  m._lastDefendAtExtend = extendsObserved;
  assert.notStrictEqual(m.softStrategy, 'off', 'PRECONDITION: the fixture must be an allowlisted (rank-driven) load');
  return m;
}

const spState = (m, remaining, myRank) => ({
  ok: true, status: remaining > 0 ? 'live' : 'closed', myRank, totalBidders: 5, standingL1Price: null,
  closesInMs: remaining, revisionLimit: 10, revisionsLeft: null, minDecrement: MIN_DEC,
  closeModel: m.closeModel, extendMs: m.extendMs, extendCount: m.extendCap, triggerWindowMs: m.triggerWindowMs,
  measuredRttMs: 80,
});

async function drive(rig, m, { from, to = 0, rank }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < 20_000) {
      rig.clock.remaining = r;
      await rig.eng._maybeBid(m, spState(m, r, rank(rig.wire)));
      const step = Math.max(1, rig.eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const rankAfterShot = (after) => (wire) => (wire.length ? after : 3);

function firstShotIsNonFloor(m, wire, label) {
  const floor = m.ladder[m.ladder.length - 1];
  assert.ok(wire.length >= 1, `PRECONDITION (${label}): no final shot reached the wire at all`);
  assert.notStrictEqual(wire[0].price, floor,
    `PRECONDITION (${label}): the first final shot was the floor ${floor}, so there is no non-floor shot to follow up`);
  return floor;
}

const noticeEvents = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'last_resort_floor_fired');

(async () => {
  console.log('\nA landed follow-up floor fires last_resort_floor_fired (ruling 62)\n');

  // 1. THE DEFECT'S OWN MECHANISM: the exact rig of case 1 in
  //    test-softclose-floor-after-nonfloor-snipe.js - a landed follow-up floor.
  {
    const rig = mkRig(accept);
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    const floor = firstShotIsNonFloor(m, rig.wire, 'case 1');
    const after = rig.wire.slice(1);
    const floorShot = after.find((w) => w.price === floor && w.remaining > 0);
    assert.ok(floorShot, 'PRECONDITION: the follow-up floor must have landed (see the sibling test file)');
    const notices = noticeEvents(rig.events);
    assert.strictEqual(notices.length, 1,
      `a landed follow-up floor raised ${notices.length} last_resort_floor_fired notice(s), expected 1`);
    assert.strictEqual(notices[0].floor, floor, 'the notice must carry the floor price that actually landed');
    assert.ok(notices[0].myRank === 2 || notices[0].myRank == null, 'the notice carries the landed rank when the platform gave one');
    ok(1, 'a landed follow-up floor fires last_resort_floor_fired, carrying the floor price');
  }

  // 2. CONTROL: a REFUSED follow-up emits nothing (mirrors S2 - a money claim needs money to have moved).
  {
    let cap = null;
    const rig = mkRig((price, wire) => {
      if (wire.length === 1) { cap = price - MIN_DEC; return accept(); }
      const text = `Amount is invalid. Amount should be less than or equal to ${cap}`;
      return { accepted: false, ok: false, status: 400, reason: text, text, raw: text };
    });
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    firstShotIsNonFloor(m, rig.wire, 'case 2');
    const notices = noticeEvents(rig.events);
    assert.strictEqual(notices.length, 0,
      `a refused follow-up floor raised ${notices.length} last_resort_floor_fired notice(s), expected 0 - nothing landed`);
    ok(2, 'CONTROL: a refused follow-up floor emits no notice');
  }

  // 3. CONTROL: shadow mode emits nothing (mirrors S1 - shadow's contract is zero wire writes).
  {
    const rig = mkRig(accept, { mode: 'shadow' });
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    assert.strictEqual(m.softStrategy, 'shadow', 'PRECONDITION: fixture must produce a shadow monitor');
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    assert.strictEqual(rig.wire.length, 0, 'PRECONDITION: shadow mode must place zero real bids');
    const notices = noticeEvents(rig.events);
    assert.strictEqual(notices.length, 0,
      `shadow mode raised ${notices.length} last_resort_floor_fired notice(s) for a follow-up floor never sent, expected 0`);
    ok(3, 'CONTROL: shadow mode emits no notice for a follow-up floor never sent');
  }

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', (e && e.stack) || e);
  process.exit(1);
});
