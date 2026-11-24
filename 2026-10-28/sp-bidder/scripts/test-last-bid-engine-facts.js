'use strict';
/**
 * A real engine run stamps the two ruling-29 facts about our last bid onto auction_result:
 * leadAfterLastBid (we held rank 1 after our last accepted bid) and lastBidInFinalSeconds (our last
 * bid was decided inside the engine's floorWindowMs and nothing extended after it).
 *
 * Regression target: owner ruling 29 (24 Sep 2026, loss-cause tag), engine half. Without these two
 * facts resultReason cannot tell "undercut while leading" from "lost on timing", and the last-bid
 * sheet cannot say whether our bid was in the final seconds.
 *
 * THE RUN. Real BidEngine, fake GoComet-like adapter (soft close, softStrategy off), temp-file
 * DurableScheduler, stubbed Date.now, _tick/_finalize driven directly. Close P = 17 Sep 2026
 * 09:30:00 pm IST, never extended. Frames at countdowns of k.6 s down to 4.6 s; placeBid advances the
 * clock 600 ms and accepts at rank 2.
 *   F1 - one more frame after the ladder at myRank 1, then a close at rank 2.
 *   F2 - the same frame at myRank 2.
 *   F3 - F2 plus a frame at 2.0 s (inside floorWindowMs 2.5 s), where the reserved floor fires.
 * EXPECTED FACTS come from the stub's log: the countdown each accepted bid was decided on.
 *
 * WHAT MUST NOT MOVE (controls, HARNESS: on failure): the engine placed bids, emitted an
 * auction_result at rank 2 with the unextended close and extensionsAfterLastBid 0.
 *
 *   node scripts/test-last-bid-engine-facts.js
 */
process.env.LOG_LEVEL = 'warn';
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const { istAt } = h;

const P = istAt(2026, 9, 17, 21, 30, 0);
const WRITE_MS = 600;
const CAP = 3;
const FLOOR_WINDOW_MS = 2_500;

const REAL_NOW = Date.now;
let vnow = P - 600_000;
Date.now = () => vnow;

const CLEAN = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

class HarnessError extends Error {}
function harness(cond, msg) {
  if (!cond) throw new HarnessError(`HARNESS: ${msg}`);
}

function rig(id) {
  const file = path.join(os.tmpdir(), `last-bid-engine-facts-${process.pid}-${id}.json`);
  CLEAN.push(file);
  const events = [];
  const stub = { frame: null, served: null, bids: [], rank: 2 };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: CAP, closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() {
      if (!stub.frame) return { ok: false, error: 'no frame' };
      stub.served = { ...stub.frame };
      return { ...stub.frame };
    },
    async placeBid(auctionId, price) {
      stub.bids.push({ price, closesInMs: stub.served.closesInMs });
      vnow += WRITE_MS;
      return { accepted: true, myRank: 2, revisionsLeft: Math.max(0, CAP - stub.bids.length), latencyMs: WRITE_MS };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 15_000, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0, softOpenJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  const frame = (rank) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: P, closesInMs: P - Date.now(),
    extendMs: 300_000, extendCount: null, myRank: stub.bids.length ? rank : null, totalBidders: stub.bids.length ? 4 : null,
    standingL1Price: null, measuredRttMs: 20 });
  const tickAt = async (m, countdownMs, rank = 2) => {
    const at = P - countdownMs;
    if (vnow > at) return;
    vnow = at;
    stub.frame = frame(rank);
    await eng._tick(m);
    unTimer(m);
  };
  vnow = P - 600_000;
  const m = eng.arm({
    id, lane: { origin: 'Degam', destination: 'Akola' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd.', closesAt: P, platformKey: 'gocomet',
    rules: { revisionLimit: CAP, minDecrement: 500 },
  }, { cost: 48_000, marginsPct: [12.6, 7.2, 6.3] });
  unTimer(m);
  harness(m.softStrategy === 'off', `${id}: resolved softStrategy '${m.softStrategy}', expected 'off'`);

  const ladder = async () => {
    for (let k = 595; k >= 30; k -= 5) await tickAt(m, k * 1000 + 600);
    for (let k = 29; k >= 4; k -= 1) await tickAt(m, k * 1000 + 600);
  };
  const finalize = async () => {
    vnow = P;
    const closing = { ...frame(2), status: 'closed', myRank: 2, totalBidders: 4 };
    stub.frame = closing;
    await eng._finalize(m, closing);
    unTimer(m);
    try { eng.kill('test done'); } catch (_) {}
    return events.find((e) => e.type === 'auction_result' && String(e.auctionId) === id) || null;
  };
  return { stub, events, ladder, tickAt, finalize, m };
}

function controls(name, r, result) {
  harness(r.stub.bids.length >= 1, `${name}: the engine placed no accepted bid`);
  harness(r.events.filter((e) => e.type === 'bid_placed').length === r.stub.bids.length,
    `${name}: ${r.stub.bids.length} accepted placeBid call(s) without a bid_placed each`);
  harness(!!result && result.won === false && result.finalRank === 2, `${name}: no auction_result lost at rank 2`);
  harness(result.finalCloseAt === P && result.extensionsAfterLastBid === 0,
    `${name}: finalCloseAt ${result.finalCloseAt} / extensionsAfterLastBid ${result.extensionsAfterLastBid}, want ${P} / 0`);
}

const failures = [];
let n = 0;
const check = (mech, ok, msg) => { n += 1; if (!ok) failures.push(`FAIL ${n} [${mech}] ${msg}`); };

async function main() {
  const f1 = rig('260917F1LB');
  await f1.ladder();
  const beforeLead = f1.stub.bids.length;
  await f1.tickAt(f1.m, 3_600, 1);
  harness(f1.stub.bids.length === beforeLead, 'F1: the engine bid on the rank-1 frame, so it is not after our last bid');
  const r1 = await f1.finalize();
  controls('F1', f1, r1);

  const f2 = rig('260917F2LB');
  await f2.ladder();
  const beforeF2 = f2.stub.bids.length;
  await f2.tickAt(f2.m, 3_600, 2);
  harness(f2.stub.bids.length === beforeF2, 'F2: the engine bid on the frame after the ladder');
  const r2 = await f2.finalize();
  controls('F2', f2, r2);

  const f3 = rig('260917F3LB');
  await f3.ladder();
  const beforeFloor = f3.stub.bids.length;
  await f3.tickAt(f3.m, 2_000, 2);
  harness(f3.stub.bids.length === beforeFloor + 1, `F3: the 2.0 s frame fired ${f3.stub.bids.length - beforeFloor} bid(s), want the floor shot`);
  const r3 = await f3.finalize();
  controls('F3', f3, r3);

  const last2 = f2.stub.bids[f2.stub.bids.length - 1];
  const last3 = f3.stub.bids[f3.stub.bids.length - 1];
  harness(last2.closesInMs > FLOOR_WINDOW_MS, `F2: last bid decided at ${last2.closesInMs} ms, want outside the ${FLOOR_WINDOW_MS} ms window`);
  harness(last3.closesInMs <= FLOOR_WINDOW_MS, `F3: last bid decided at ${last3.closesInMs} ms, want inside the ${FLOOR_WINDOW_MS} ms window`);

  check('leadAfterLastBid', r1.leadAfterLastBid === true,
    `F1: rank 1 seen after our last accepted bid -> auction_result.leadAfterLastBid = ${r1.leadAfterLastBid}, want true`);
  check('leadAfterLastBid', r2.leadAfterLastBid === false,
    `F2: rank 2 throughout after our last bid -> auction_result.leadAfterLastBid = ${r2.leadAfterLastBid}, want false`);
  check('lastBidInFinalSeconds', r2.lastBidInFinalSeconds === false,
    `F2: last bid decided at ${last2.closesInMs} ms, no extension -> lastBidInFinalSeconds = ${r2.lastBidInFinalSeconds}, want false`);
  check('lastBidInFinalSeconds', r3.lastBidInFinalSeconds === true,
    `F3: last bid decided at ${last3.closesInMs} ms, no extension -> lastBidInFinalSeconds = ${r3.lastBidInFinalSeconds}, want true`);

  console.log(`  run facts: F1/F2 ${f2.stub.bids.length} bid(s), last decided at ${last2.closesInMs} ms; `
    + `F3 ${f3.stub.bids.length} bid(s), last decided at ${last3.closesInMs} ms`);
}

main().then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (failures.length) {
    for (const f of failures) console.log(ascii(f));
    console.log(`FAILED ${failures.length} of ${n} checks - ruling 29 engine half: auction_result does not carry leadAfterLastBid / `
      + 'lastBidInFinalSeconds for our last bid');
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
}, (e) => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  console.log(ascii(e instanceof HarnessError ? e.message : `HARNESS: threw ${e && e.stack ? e.stack : e}`));
  process.exit(1);
});
