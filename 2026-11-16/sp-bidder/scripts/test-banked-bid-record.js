'use strict';
/**
 * A bid banked after its own monitor was retired must reach the business record as a LATE bid, not
 * as a fresh opening.
 *
 * Two defects in one emit (bidEngine._recordLandedAfterRetire), both introduced with the emit itself:
 *
 *   1. The durable intent composes lowest-wins (lowestStandingPrice) but the EVENT carried the raw
 *      decision.price, and bidLogger._onBid assigned rec.lastBidPrice from it unconditionally. A
 *      dearer write resolving after the successor's cheaper one therefore raised closedBids above
 *      the price the portal holds - and lastBidPrice is what directorEod, eodReport and the CSV
 *      exports read as the won value, so a won load was reported high.
 *
 *   2. The same emit drops rungIndex (correct - the ladder those indices counted against has been
 *      replaced) and Number(null) is 0, which is exactly what notifier._whatsapp's DM filter treats
 *      as the establishing rung. The banked write pinged DMs a SECOND "First bid" message, framed
 *      against the RETIRED monitor's cost - the rate the desk had just corrected.
 *
 *   node scripts/test-banked-bid-record.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');

let pass = 0;
const EXPECTED_CHECKS = 7;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// The 260908LD2Z geometry, same hand-derived ladders the re-price suite works from: the load is
// captured at Rs 29,000 (opening rung 31,610), then corrected DOWN to Rs 26,000 (opening 28,340).
const A_COST = 29_000, A_BAND = [9, 5, 1], A_OPENING = 31_610;
const D_COST = 26_000, D_OPENING = 28_340;
const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
// A DM subscriber, not a scoped group - the recipient class the establishing ping exists for and the
// one a banked bid must never reach.
const dmRecipient = [{ name: 'Desk', phone: '+919000000001', alerts: ['bid_live'] }];

// Records each outbound send body; the listPhones branch keeps the sender-health probe happy.
function immediate() {
  const calls = [];
  const fn = async (url, opts) => {
    if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

function mkNotifier() {
  const tr = immediate();
  const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
  const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => dmRecipient });
  return { n, tr };
}

const bidPlaced = (extra) => Object.assign({
  type: 'bid_placed', auctionId: 'LD2Z', price: A_OPENING,
  lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
  cost: A_COST, openingPct: 9,
}, extra);

(async () => {
  // ---- 1) THE RECORD. Run the real out-of-order window through the engine and replay its own event
  // stream into BidLogger: the dearer write is still on the wire when the desk re-prices, the
  // successor lands 28,340, and only then does 31,610 resolve and bank. ----
  {
    const f = path.join(os.tmpdir(), `banked-bid-record-${process.pid}.json`);
    const adapter = {
      writeEnabled: true, placed: [],
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => liveState(),
      placeBid: null,
    };
    const engine = new BidEngine(adapter, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
    const events = [];
    engine.onEvent = (e) => events.push(e);

    let release;
    const onWire = new Promise((r) => { release = r; });
    adapter.placeBid = async function (id, price) {
      this.placed.push(price);
      if (price === A_OPENING) await onWire;          // the dearer write parks
      return { accepted: true, myRank: 1, latencyMs: 30 };
    };

    const m1 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m1.timer) clearTimeout(m1.timer);
    const inFlight = engine._maybeBid(m1, liveState());
    await new Promise((r) => setImmediate(r));
    engine.stop('LD2Z');
    const m2 = engine.arm(mkLoad('LD2Z'), { cost: D_COST, marginsPct: A_BAND, minMarginPct: 1 });
    if (m2.timer) clearTimeout(m2.timer);
    await engine._maybeBid(m2, liveState());          // the successor lands the cheaper bid
    assert.strictEqual(engine.scheduler.get('LD2Z').landedBidPrice, D_OPENING,
      'precondition: the intent holds the 28,340 the board really has');
    release();
    await inFlight;
    engine.kill();
    try { fs.unlinkSync(f); } catch (_) {}

    const placed = events.filter((e) => e.type === 'bid_placed');
    assert.deepStrictEqual(placed.map((e) => e.price), [D_OPENING, A_OPENING],
      'precondition: both writes emitted, the banked dearer one LAST');
    assert.strictEqual(engine.scheduler.get('LD2Z').landedBidPrice, D_OPENING,
      'precondition: the durable standing price is still the lower one');

    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    for (const e of events) await logger.handle(e);
    const rec = await store.getDoc('closedBids', 'LD2Z');

    assert.deepStrictEqual(rec.ourBids.map((b) => b.price), [D_OPENING, A_OPENING],
      'every write stays on the record at the price that really went on the wire - the forensic half is untouched');
    ok('both writes are recorded, at the prices actually sent');

    assert.strictEqual(rec.lastBidPrice, D_OPENING,
      'the business record holds the price the PORTAL holds, not the dearer write that resolved last');
    ok('closedBids.lastBidPrice is never raised above the board by a late-resolving write');

    assert.strictEqual(rec.lastBidPrice, engine.scheduler.get('LD2Z').landedBidPrice,
      'the durable intent and the business record agree on the standing price');
    ok('the durable intent and closedBids agree on what stands');
  }

  // ---- 2) THE DM. The banked event carries no rung index by design, so the filter cannot infer the
  // answer from one - it reads the fact the engine states. ----
  {
    const n = toNotification(bidPlaced({ rungIndex: null, establishing: false }));
    assert.strictEqual(n.dedupeKey, 'LD2Z_bid_live_x',
      'the per-rung dedupe key is unchanged - the banked bid still cannot be swallowed as a duplicate of rung 0');
    assert.strictEqual(n.data.establishing, false, 'and the descriptor carries the establishing fact for the router');
    ok('the banked bid keeps its own dedupe key and declares it is not an establishing bid');
  }

  {
    const { n, tr } = mkNotifier();
    await notifyEngineEvent(n, bidPlaced({ rungIndex: null, establishing: false }));
    assert.strictEqual(tr.calls.length, 0,
      'a bid banked after a retire sends NO first-bid DM - it is a late write on a load the desk has already re-priced');
    ok('a banked bid does not ping DMs with a second "First bid" quoting the pre-correction rate');
  }

  // ---- 2b) THE CONTRACT IT MUST NOT BREAK: rung 0 still pings once, rung 1 still does not. ----
  {
    const { n, tr } = mkNotifier();
    await notifyEngineEvent(n, bidPlaced({ auctionId: 'CTRL0', rungIndex: 0 }));
    assert.strictEqual(tr.calls.length, 1, 'the establishing rung still reaches DM subscribers');
    assert.ok(/31,610/.test(tr.calls[0].message), 'and it is the establishing price that is quoted');
    ok('the one first-bid DM is untouched');
  }

  {
    const { n, tr } = mkNotifier();
    await notifyEngineEvent(n, bidPlaced({ auctionId: 'CTRL1', rungIndex: 1, price: 30_450 }));
    assert.strictEqual(tr.calls.length, 0, 'a step-down rung still reaches no DM subscriber');
    ok('the step-down filter is unchanged');
  }

  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
