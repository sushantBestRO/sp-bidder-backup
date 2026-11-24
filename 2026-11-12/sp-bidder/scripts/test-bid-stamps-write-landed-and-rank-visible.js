'use strict';
/**
 * P6 TELEMETRY: EVERY LANDED BID CARRIES writeLandedAt, AND rankVisibleAt WHEN A LATER READ SHOWS
 * OUR OWN RANK AFTER IT.
 *
 * Regression target: the final-window walk (rulings 35/48) sets its step time from five working
 * days of these two stamps, at least 50 final-window bids per platform - until then it ships
 * switched off. Before this build neither stamp existed anywhere durable:
 * bid_placed carried decidedAt/latencyMs only, and no tick ever recorded when a rank became visible.
 *
 *   1. SuperProcure shape (myAmount published): a landed bid's ourBids entry has
 *      decidedAt <= writeLandedAt < rankVisibleAt, and a read whose own amount still shows the OLD
 *      price - or no amount at all - is never mistaken for this bid's rank becoming visible.
 *   2. GoComet shape (no myAmount at all): writeLandedAt is set on landing; rankVisibleAt comes from
 *      the next read that carries any rank for us, since there is no amount to verify against.
 *   3. The uncertain-outcome path (T7): a transport-thrown write that resolves fail-closed assumed
 *      (no portal confirmation available) still carries writeLandedAt, tagged unconfirmed.
 *   4. Two landed bids in quick succession on the same load: the SECOND bid's own rank read never
 *      back-fills onto the FIRST bid's entry - the first's rankVisibleAt stays null forever once a
 *      later bid has landed.
 *   5. A restart (a fresh store re-reading the same files) still shows both stamps on the record.
 *
 * Offline: fake adapters, real BidEngine, real DurableScheduler, real BidLogger (memory store for
 * 1-4, a real FileStore on a temp dir for 5).
 *
 *   node scripts/test-bid-stamps-write-landed-and-rank-visible.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent/store files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { FileStore } = require('../src/store/fileStore');
const { BidLogger } = require('../src/logging/bidLogger');

let seq = 0;
const CLEAN = [];
const tmpFile = () => {
  const f = path.join(os.tmpdir(), `bid-stamps-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
const DIRS = [];
process.on('exit', () => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const FAR_MS = 30 * 60 * 1000;
const NEAR_MS = 90 * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(n, name, fn) {
  try { await fn(); results.push(true); console.log(`  ok  ${n}. ${name}`); }
  catch (e) {
    if (/^(setup|harness):/.test(e.message)) throw e;
    results.push(false); console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
  }
}

// hasMyAmount: SuperProcure-shaped state carries the key (null until we have evidence); GoComet
// never carries it at all. myRank/myAmount are read fresh on every call from `live`, so a test can
// mutate them between calls to simulate successive ticks. Always outranked (myRank 2) so the ladder
// keeps stepping down across repeated _maybeBid calls, the same device test-uncertain-write-recorded
// uses to produce more than one landed write from one fixed adapter.
function mkAdapter({ hasMyAmount, throwOn = [] }) {
  const wire = [];
  const live = { myRank: 2, myAmount: null };
  return {
    wire, live,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      const s = { ok: true, status: 'live', myRank: live.myRank, totalBidders: 3, standingL1Price: null,
        closesInMs: FAR_MS, revisionsLeft: null, revisionLimit: 3, closeModel: 'hard',
        measuredRttMs: 50, minDecrement: 100 };
      if (hasMyAmount) s.myAmount = live.myAmount;
      return s;
    },
    placeBid: async (_id, price) => {
      const i = wire.length;
      wire.push(price);
      if (throwOn.includes(i)) throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

function mkEngine(adapter, onEvent) {
  const scheduler = new DurableScheduler(tmpFile());
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true, onEvent, log: silent,
  });
  const m = engine.arm({
    id: `PS${seq}`, lane: { origin: 'Khopoli', destination: 'Gajsinghpur' }, equipment: 'Trailer 40', units: 1,
    companyName: 'Renewsys', closesAt: Date.now() + FAR_MS, startsAt: Date.now() - 1_000,
    status: 'live', softClose: false,
  }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return { engine, m, scheduler };
}

async function loggedRun(adapter) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  const pending = [];
  const { engine, m } = mkEngine(adapter, (e) => pending.push(logger.handle(e)));
  return { store, logger, engine, m, pending, drain: () => Promise.all(pending) };
}

(async () => {
  await check(1, 'SuperProcure shape: decidedAt <= writeLandedAt < rankVisibleAt, an old/absent amount never counts', async () => {
    const adapter = mkAdapter({ hasMyAmount: true });
    const { store, engine, m, drain } = await loggedRun(adapter);
    await engine._maybeBid(m, await adapter.getAuctionState());
    await drain();
    const price = adapter.wire[0];
    if (adapter.wire.length !== 1) throw new Error(`setup: expected exactly 1 write, saw ${JSON.stringify(adapter.wire)}`);

    // a read with no evidence either way -> no stamp
    engine._maybeStampRankVisible(m, { myRank: null, myAmount: null });
    // a read that carries a rank but our own amount is still absent -> no stamp (cannot verify it's THIS bid)
    engine._maybeStampRankVisible(m, { myRank: 2, myAmount: null });
    // a read that carries a rank at a DIFFERENT amount (an older bid's own standing price) -> no stamp
    engine._maybeStampRankVisible(m, { myRank: 2, myAmount: price + 500 });
    let rec = await store.getDoc('closedBids', m.auctionId);
    assert.strictEqual(rec.ourBids[0].rankVisibleAt, undefined,
      'a rank read at an amount that is not this bid\'s own price was taken as this bid\'s rank becoming visible');

    // the real thing: our own amount now equals the price we bid, at rank 1 (a real gap on the wall
    // clock, matching writeLandedAt < rankVisibleAt being a NEXT-tick fact, not a same-instant one)
    await wait(5);
    engine._maybeStampRankVisible(m, { myRank: 1, myAmount: price });
    await drain();
    rec = await store.getDoc('closedBids', m.auctionId);
    const bid = rec.ourBids[0];
    assert.ok(bid.decidedAt != null, 'ourBids[0].decidedAt is missing');
    assert.ok(bid.writeLandedAt != null, 'ourBids[0].writeLandedAt is missing');
    assert.ok(bid.rankVisibleAt != null, 'ourBids[0].rankVisibleAt is missing');
    assert.ok(bid.decidedAt <= bid.writeLandedAt,
      `decidedAt ${bid.decidedAt} is after writeLandedAt ${bid.writeLandedAt}`);
    assert.ok(bid.writeLandedAt < bid.rankVisibleAt,
      `writeLandedAt ${bid.writeLandedAt} is not before rankVisibleAt ${bid.rankVisibleAt}`);
    engine.kill('done');
  });

  await check(2, 'GoComet shape (no myAmount at all): writeLandedAt set on landing, rankVisibleAt from the next ranked read', async () => {
    const adapter = mkAdapter({ hasMyAmount: false });
    const { store, engine, m, drain } = await loggedRun(adapter);
    await engine._maybeBid(m, await adapter.getAuctionState());
    await drain();
    if (adapter.wire.length !== 1) throw new Error(`setup: expected exactly 1 write, saw ${JSON.stringify(adapter.wire)}`);

    engine._maybeStampRankVisible(m, { myRank: null });
    let rec = await store.getDoc('closedBids', m.auctionId);
    assert.strictEqual(rec.ourBids[0].rankVisibleAt, undefined, 'a read with no rank at all was taken as rank-visible');

    await wait(5);
    engine._maybeStampRankVisible(m, { myRank: 2 }); // no myAmount key at all - GoComet has none to check
    await drain();
    rec = await store.getDoc('closedBids', m.auctionId);
    const bid = rec.ourBids[0];
    assert.ok(bid.writeLandedAt != null, 'ourBids[0].writeLandedAt is missing on the GoComet shape');
    assert.ok(bid.rankVisibleAt != null, 'ourBids[0].rankVisibleAt is missing on the GoComet shape');
    assert.ok(bid.writeLandedAt < bid.rankVisibleAt, 'rankVisibleAt did not follow writeLandedAt');
    engine.kill('done');
  });

  await check(3, 'uncertain-outcome path (T7): a fail-closed-assumed landing still carries writeLandedAt, tagged unconfirmed', async () => {
    const adapter = mkAdapter({ hasMyAmount: false, throwOn: [0] }); // GoComet shape: no own-amount evidence available
    const { store, engine, m, drain } = await loggedRun(adapter);
    await engine._maybeBid(m, await adapter.getAuctionState());
    await drain();
    const rec = await store.getDoc('closedBids', m.auctionId);
    assert.strictEqual(rec.ourBids.length, 1, `expected 1 recorded bid for the thrown-but-landed write, saw ${rec.ourBids.length}`);
    const bid = rec.ourBids[0];
    assert.strictEqual(bid.unconfirmed, true, 'the fail-closed-assumed landing does not say so');
    assert.ok(bid.writeLandedAt != null, 'the uncertain-outcome path did not stamp writeLandedAt');
    assert.ok(bid.decidedAt <= bid.writeLandedAt, 'writeLandedAt precedes decidedAt on the uncertain-outcome path');
    engine.kill('done');
  });

  await check(4, 'two landed bids in quick succession: the second bid\'s rank read never back-fills the first', async () => {
    const adapter = mkAdapter({ hasMyAmount: true }); // always myRank 2 (outranked) -> the ladder steps down
    const { store, engine, m, drain } = await loggedRun(adapter);
    // establish far out, then step down while still outranked - the same device
    // test-uncertain-write-recorded uses to produce a second landed write from one fixed adapter.
    for (const closesInMs of [FAR_MS, NEAR_MS]) {
      await engine._maybeBid(m, Object.assign(await adapter.getAuctionState(), { closesInMs }));
    }
    await drain();
    if (adapter.wire.length !== 2) throw new Error(`setup: expected exactly 2 writes, saw ${JSON.stringify(adapter.wire)}`);
    let rec = await store.getDoc('closedBids', m.auctionId);
    if (rec.ourBids.length !== 2) throw new Error(`setup: expected 2 recorded bids, saw ${rec.ourBids.length}`);
    const [firstPrice, secondPrice] = adapter.wire;

    // a read at rank 1 for the SECOND bid's own price - resolves the second bid's marker only,
    // because the second bid's own landing overwrote the first bid's pending marker when it fired.
    await wait(5);
    engine._maybeStampRankVisible(m, { myRank: 1, myAmount: secondPrice });
    await drain();
    rec = await store.getDoc('closedBids', m.auctionId);
    const [first, second] = rec.ourBids;
    assert.strictEqual(first.price, firstPrice, 'setup: ourBids[0] is not the first landed price');
    assert.strictEqual(second.price, secondPrice, 'setup: ourBids[1] is not the second landed price');
    assert.ok(second.rankVisibleAt != null, 'the second (most recent) bid never got its rankVisibleAt');
    assert.strictEqual(first.rankVisibleAt, undefined,
      'the FIRST bid was back-filled with the rank the SECOND bid produced');

    // even a later read at the FIRST bid's own price cannot resurrect it - its slot was already spent.
    engine._maybeStampRankVisible(m, { myRank: 1, myAmount: firstPrice });
    await drain();
    rec = await store.getDoc('closedBids', m.auctionId);
    assert.strictEqual(rec.ourBids[0].rankVisibleAt, undefined,
      'a later read at the first bid\'s own price back-filled it after a newer bid had already landed');
    engine.kill('done');
  });

  await check(5, 'a restart (a fresh store re-reading the same files) still shows both stamps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-stamps-'));
    DIRS.push(dir);
    const store1 = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const logger1 = new BidLogger({ store: store1, log: () => {} });
    const adapter = mkAdapter({ hasMyAmount: true });
    const pending = [];
    const { engine, m } = mkEngine(adapter, (e) => pending.push(logger1.handle(e)));
    await engine._maybeBid(m, await adapter.getAuctionState());
    const price = adapter.wire[0];
    await wait(5);
    engine._maybeStampRankVisible(m, { myRank: 1, myAmount: price });
    await Promise.all(pending);
    engine.kill('done');

    // "restart": a brand new store instance re-reading the same files, exactly as a fresh process would.
    const store2 = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const rec = await store2.getDoc('closedBids', m.auctionId);
    assert.ok(rec, 'the closed-bids record did not survive the restart at all');
    assert.strictEqual(rec.ourBids.length, 1, `expected 1 bid on the reloaded record, saw ${rec.ourBids.length}`);
    const bid = rec.ourBids[0];
    assert.ok(bid.writeLandedAt != null, 'writeLandedAt did not survive the restart');
    assert.ok(bid.rankVisibleAt != null, 'rankVisibleAt did not survive the restart');
  });

  const failed = results.filter((r) => !r).length;
  if (failed) {
    console.log(`FAIL - ${failed} of ${results.length} checks: a landed bid's write-landed and rank-visible timing is missing, wrong, or gets back-filled from a later bid`);
    process.exit(1);
  }
  console.log(`PASS - ${results.length} checks: every landed bid carries writeLandedAt, and rankVisibleAt when a later read proves it, durably and without back-fill`);
})().catch((e) => {
  console.error(`FAIL - harness: ${e && e.stack}`);
  process.exit(1);
});
