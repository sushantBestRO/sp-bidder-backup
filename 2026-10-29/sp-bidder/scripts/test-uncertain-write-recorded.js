'use strict';
/**
 * A WRITE WHOSE TRANSPORT FAILED IS EITHER PROVEN ON THE BOARD AND RECORDED, OR RETRIED - never booked
 * blind and never left out of the record.
 *
 * Regression targets: timing PR-T7 (a reconciled landed bid is missing from ourBids: 26091792T2 had 3
 * landed and 2 recorded; 2609018BQ6's landed third GoComet bid is missing) and BC-15 Fix A (25480681:
 * a status-0 SuperProcure write that landed was recorded as "no bid"; 25746269: one that did not land
 * was assumed landed, so no later rung re-fired).
 *
 * The uncertain-outcome handler in BidEngine._maybeBid books a status-0 / transport-thrown write as
 * landed whenever the read-back cannot disprove it, and emits no bid_placed, so the closed record and
 * the receipt never see the bid. SuperProcure's socket does show our own active bid (spSocket keeps
 * myAmount), about 1.15 s after it lands, so on a portal that publishes our own standing amount the
 * write can be CONFIRMED instead of assumed.
 *
 *   1. own amount published at the sent price within the window -> booked as landed AND recorded
 *      (one bid_placed, confirmed by the portal).
 *   2. own amount never shows the sent price -> NOT booked: no landed bid, no bid_placed, the rung is
 *      still unspent and the next tick sends the same price again; the revision stays spent.
 *   3. a portal that publishes no own amount (GoComet) -> booked as today (fail-closed) AND recorded,
 *      marked unconfirmed.
 *   4. through the real bid logger: three landed writes, one of them transport-thrown, leave three
 *      ourBids on the closed record.
 *   5. control: an accepted write emits exactly one bid_placed, unchanged.
 *
 * Offline: fake adapter, real BidEngine, real DurableScheduler and BidLogger on temp files / memory.
 *
 *   node scripts/test-uncertain-write-recorded.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `uncertain-recorded-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

const REMAINING_MS = 114 * 60 * 1000;
const results = [];
async function check(n, name, fn) {
  try { await fn(); results.push(true); console.log(`  ok  ${n}. ${name}`); }
  catch (e) {
    if (/^(setup|harness):/.test(e.message)) throw e;
    results.push(false); console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
  }
}

// ownAmount: 'lands' (the sent price shows after confirmAfterMs), 'silent' (it never does), or
// 'absent' (the portal publishes no own amount at all - the GoComet shape).
function mkAdapter({ ownAmount, confirmAfterMs = 400, throwOn = [0] }) {
  const wire = [];
  let landedAt = null;
  let landedPrice = null;
  const caps = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' };
  if (ownAmount !== 'absent') caps.ownBidAmountVisible = true;
  return {
    wire,
    writeEnabled: true,
    capabilities: () => caps,
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      const s = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3, closeModel: 'hard',
        measuredRttMs: 50, minDecrement: 100 };
      if (ownAmount !== 'absent') {
        s.myAmount = (ownAmount === 'lands' && landedAt != null && Date.now() - landedAt >= confirmAfterMs) ? landedPrice : null;
      }
      return s;
    },
    placeBid: async (_id, price) => {
      const i = wire.length;
      wire.push(price);
      if (throwOn.includes(i)) {
        landedAt = Date.now(); landedPrice = price;
        throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      }
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

function mkEngine(adapter, onEvent) {
  const scheduler = new DurableScheduler(tmp());
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true, onEvent, log: silent,
  });
  const m = engine.arm({
    id: `UWR${seq}`, lane: { origin: 'Khopoli', destination: 'Gajsinghpur' }, equipment: 'Trailer 40', units: 1,
    companyName: 'Renewsys', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
    status: 'live', softClose: false,
  }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return { engine, m, scheduler };
}

async function oneWrite(ownAmount) {
  const events = [];
  const adapter = mkAdapter({ ownAmount });
  const { engine, m } = mkEngine(adapter, (e) => events.push(e));
  await engine._maybeBid(m, await adapter.getAuctionState());
  const placed = events.filter((e) => e.type === 'bid_placed');
  const out = { adapter, m, placed, landed: m.landedBids, rev: m.revisionsLeft, fired: [...m.firedRungs] };
  // one more tick: does the same price go out again?
  await engine._maybeBid(m, await adapter.getAuctionState());
  out.wireAfterNextTick = adapter.wire.slice();
  engine.kill('done');
  return out;
}

(async () => {
  const c1 = await oneWrite('lands');
  await check(1, 'own amount published at the sent price -> booked as landed and recorded', async () => {
    const sent = c1.adapter.wire[0];
    assert.strictEqual(c1.landed, 1, `landedBids ${c1.landed}, expected 1`);
    assert.strictEqual(c1.placed.length >= 1 && c1.placed[0].price, sent,
      `a transport-thrown write the portal then showed as our own standing bid at ${sent} emitted `
      + `${c1.placed.length} bid_placed - the closed record and the receipt never see it`);
    assert.strictEqual(c1.placed[0].confirmedBy, 'portal', `bid_placed.confirmedBy is ${c1.placed[0].confirmedBy}`);
  });

  const c2 = await oneWrite('silent');
  await check(2, 'own amount never shows the sent price -> not booked, and the same price goes out again', async () => {
    const sent = c2.adapter.wire[0];
    assert.strictEqual(c2.landed, 0, `a write the portal never showed was booked as ${c2.landed} landed bid(s)`);
    assert.strictEqual(c2.placed.length, 0, `${c2.placed.length} bid_placed for a write that did not land`);
    assert.ok(c2.wireAfterNextTick.length >= 2 && c2.wireAfterNextTick[1] === sent,
      `after an unconfirmed write the next tick sent ${JSON.stringify(c2.wireAfterNextTick.slice(1))}, expected ${sent} again - `
      + 'the rung was spent on a write the portal never showed');
    assert.strictEqual(c2.rev, 2, `revisionsLeft ${c2.rev} - an unconfirmed write keeps its revision spent (fail-closed on the cap)`);
  });

  const c3 = await oneWrite('absent');
  await check(3, 'no own amount published (GoComet) -> booked fail-closed and recorded, marked unconfirmed', async () => {
    assert.strictEqual(c3.landed, 1, `landedBids ${c3.landed}, expected 1 (fail-closed)`);
    assert.strictEqual(c3.placed.length, 1, `${c3.placed.length} bid_placed for a write booked as landed`);
    assert.strictEqual(c3.placed[0].unconfirmed, true, 'bid_placed does not say the landing was assumed');
  });

  await check(4, 'through the real bid logger: 3 landed writes, one transport-thrown, leave 3 ourBids', async () => {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store, log: () => {} });
    const adapter = mkAdapter({ ownAmount: 'absent', throwOn: [2] });
    const pending = [];
    const { engine, m } = mkEngine(adapter, (e) => pending.push(logger.handle(e)));
    // establish far out, step down while outranked, then the floor in the final window (thrown)
    for (const closesInMs of [REMAINING_MS, 60 * 60 * 1000, 2_000]) {
      await engine._maybeBid(m, Object.assign(await adapter.getAuctionState(), { closesInMs }));
    }
    await Promise.all(pending);
    const rec = await store.getDoc('closedBids', m.auctionId);
    engine.kill('done');
    if (adapter.wire.length !== 3) throw new Error(`setup: expected 3 writes on the wire, saw ${JSON.stringify(adapter.wire)}`);
    const recorded = rec && Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean).length : 0;
    assert.strictEqual(m.landedBids, 3, `landedBids ${m.landedBids}, expected 3`);
    assert.strictEqual(recorded, 3, `the closed record carries ${recorded} ourBids for 3 landed writes (the 26091792T2 shape)`);
  });

  const c5 = await (async () => {
    const events = [];
    const adapter = mkAdapter({ ownAmount: 'lands', throwOn: [] });
    const { engine, m } = mkEngine(adapter, (e) => events.push(e));
    await engine._maybeBid(m, await adapter.getAuctionState());
    engine.kill('done');
    return events.filter((e) => e.type === 'bid_placed');
  })();
  await check(5, 'control: an accepted write emits exactly one bid_placed, unconfirmed/confirmedBy absent', async () => {
    assert.strictEqual(c5.length, 1, `${c5.length} bid_placed for one accepted write`);
    assert.ok(c5[0].unconfirmed === undefined && c5[0].confirmedBy === undefined, 'an accepted write carries a reconciliation marker');
  });

  const failed = results.filter((r) => !r).length;
  if (failed) {
    console.log(`FAIL - ${failed} of ${results.length} checks: a transport-thrown write is booked blind (never confirmed on a portal that shows our own bid) and never recorded as a bid`);
    process.exit(1);
  }
  console.log(`PASS - ${results.length} checks: an uncertain write is proven on the board and recorded, or retried`);
})().catch((e) => { console.log(`FAIL - harness: ${e && e.stack}`); process.exit(1); });
