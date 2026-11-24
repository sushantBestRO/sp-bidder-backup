'use strict';
/**
 * R3-5 follow-up: a write that THREW across _finalize's await is never booked onto the closed record.
 *
 * The late-bank acceptance on a closed record (test-won-load-late-banked-bid-recorded.js) exists for a
 * write the portal ACCEPTED after the result was finalized. The transport-throw handler reaches the same
 * banker with `landed` assumed true, and on SuperProcure no read carries revisionsLeft to disprove it, so
 * nothing proves that write reached the portal. Booked, it turned a no-bid into a won load with a bid
 * line and a price the portal may never have held.
 *
 * Unchanged and pinned beside it: the accepted late write is still booked, and a throw the read-back
 * PROVES landed (the revision counter dropped) is booked too.
 *
 *   node scripts/test-late-bank-unconfirmed-throw-not-booked.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents file), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { closedOutcome } = require('../src/util/closedOutcome');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const LANE = { origin: 'Palghar', destination: 'Jaipur' };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

// mode: 'accept' | 'throw' (no revision counter, SuperProcure shape) | 'throw-proven' (counter drops)
async function lateWrite(id, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-throw-'));
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  const events = [];
  let release = null;
  let thrown = false;
  const placed = [];
  const counted = mode === 'throw-proven';
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: counted ? 3 : null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    async getAuctionState() {
      return { ok: true, status: 'live', myRank: 1, totalBidders: 2, standingL1Price: null, closesInMs: 30_000,
        revisionLimit: counted ? 3 : null, revisionsLeft: counted ? (thrown ? 1 : 3) : null,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 };
    },
    placeBid(auctionId, price) {
      placed.push(price);
      return new Promise((resolve, reject) => {
        release = () => {
          if (mode === 'accept') resolve({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 });
          else { thrown = true; reject(new Error('socket hang up')); }
        };
      });
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(path.join(dir, 'intents.json')),
    { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0,
      onEvent: (e) => { events.push(e); logger.handle(e); } });
  const m = eng.arm({ id, lane: LANE, units: 1, companyName: 'Waaree Energies', closesAt: Date.now() + 30_000 },
    { cost: 26_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  const tick = eng._tick(m);
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
  await eng._finalize(m, { myRank: 1 });
  release();
  await tick;
  if (m.timer) clearTimeout(m.timer);
  await flush();
  await logger.handle({ type: 'noop' });
  const rec = await store.getDoc('closedBids', id);
  const intent = eng.scheduler.get(id) || {};
  const stream = await store.readEvents('bids');
  const order = events.filter((e) => e.type !== 'alert').map((e) => e.type);
  const alerts = events.filter((e) => e.type === 'alert').map((e) => e.kind);
  eng.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return { rec, intent, stream, order, alerts, placed };
}

(async () => {
  console.log('\n1. a write that threw after the result, with nothing to prove it landed');
  {
    const r = await lateWrite('THROW-1', 'throw');
    ok(r.placed.length === 1 && r.order.join(',') === 'armed,auction_result,bid_placed' && r.alerts.includes('bid_submit_error'),
      `fixture: one write, thrown after the result, the desk alerted (${r.order.join(', ')}; alerts ${r.alerts.join(', ')})`);
    ok(r.intent.landedBids === 1,
      `the engine still counts the uncertain write against its own budget (intent landedBids ${r.intent.landedBids})`);
    ok(r.rec.status === 'closed' && r.rec.ourBids.length === 0,
      `the closed record books no bid for it (ourBids ${JSON.stringify(r.rec.ourBids.map((b) => b.price))})`);
    ok(r.rec.lastBidPrice == null, `and carries no bid price (lastBidPrice ${r.rec.lastBidPrice})`);
    ok(r.stream.filter((x) => x.kind === 'bid_placed').length === 0, 'and the daily bids stream carries no bid line for it');
    ok(closedOutcome(r.rec) === 'no_bid', `so the load reads as no bid, never won (outcome ${closedOutcome(r.rec)})`);
  }

  console.log('\n2. a write the portal accepted after the result is still booked');
  {
    const r = await lateWrite('ACCEPT-1', 'accept');
    ok(JSON.stringify(r.rec.ourBids.map((b) => b.price)) === JSON.stringify(r.placed) && r.rec.lastBidPrice === r.placed[0],
      `ourBids ${JSON.stringify(r.rec.ourBids.map((b) => b.price))}, lastBidPrice ${r.rec.lastBidPrice}`);
    ok(closedOutcome(r.rec) === 'won', `outcome won (got ${closedOutcome(r.rec)})`);
  }

  console.log('\n3. a throw the read-back proves landed (revision counter dropped) is booked');
  {
    const r = await lateWrite('THROW-PROVEN-1', 'throw-proven');
    ok(JSON.stringify(r.rec.ourBids.map((b) => b.price)) === JSON.stringify(r.placed)
      && r.stream.filter((x) => x.kind === 'bid_placed').length === 1,
      `ourBids ${JSON.stringify(r.rec.ourBids.map((b) => b.price))}, one stream line`);
  }

  console.log('\n4. the logger: an unconfirmed late bank on a closed record is dropped, a plain late bank is kept');
  {
    const store = createStore({ backend: 'memory' });
    const lines = [];
    const logger = new BidLogger({ store, log: (s) => lines.push(s) });
    const T0 = 1_757_000_000_000;
    await logger.handle({ type: 'armed', auctionId: 'L4', ts: T0, lane: LANE, equipment: 'SXL', units: 1,
      companyName: 'Waaree Energies', cost: 26_000, ladder: [28_340, 27_300, 26_260], floor: 26_260 });
    await logger.handle({ type: 'auction_result', auctionId: 'L4', ts: T0 + 600_000, won: true, finalRank: 1, closeModel: 'hard' });
    await logger.handle({ type: 'bid_placed', auctionId: 'L4', ts: T0 + 599_000, price: 28_340, rungIndex: null,
      establishing: false, landingUnconfirmed: true });
    const rec = await store.getDoc('closedBids', 'L4');
    ok(rec.ourBids.length === 0 && lines.some((l) => /L4/.test(l) && /not confirmed/.test(l)),
      `dropped with a log line naming why (ourBids ${rec.ourBids.length}; ${JSON.stringify(lines.filter((l) => /L4/.test(l)))})`);
  }

  const EXPECTED_CHECKS = 10;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL -', e && e.stack || e); process.exit(1); });
