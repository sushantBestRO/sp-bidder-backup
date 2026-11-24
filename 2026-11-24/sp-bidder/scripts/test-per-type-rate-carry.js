'use strict';
/**
 * Regression (CW-213): the desk's rate PER TRUCK TYPE must reach the BID-LIVE alert, so the message
 * that fires seconds after the receipt does not call a blended mean "your rate".
 *
 * The receipt half is pinned in test-gocomet-per-type-cost.js section 10. What this file pins is the
 * stretch in between - the carry path through the engine, which is the half that silently drops a
 * load fact:
 *   A. capture -> armFromRequest -> bid_placed -> bid_live payload -> rendered message
 *   B. scheduled load: schedule() persists the vector on the intent; the wake arms with it
 *   C. restart: rehydrate() re-arms from the intent with the vector intact (fresh store = worst case)
 *   D. a single-rate load carries null the whole way and renders the original copy byte-for-byte
 *
 * B and C are the reason this file exists rather than a unit test on the payload builder. The vector
 * rides `meta.rules`, and `sh scripts/deploy.sh` restarts pm2 mid-auction as a matter of routine, so
 * a fact that does not round-trip on the durable intent is one deploy away from going blank in
 * production while every CI run stays green. That is the exact failure shape this pins against.
 *
 *   node scripts/test-per-type-rate-carry.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');
const { cargoTypeList } = require('../src/platform/gocometCargo');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `per-type-carry-${tag}-${process.pid}.json`);
// Waaree's live band, so the figures below are the ones the closed record for 260906V7TB carries.
const BAND = [9, 7.2, 1.8];
const CFG = { armLeadMs: 300 };

// The 260906V7TB shape: three 40-footers the desk priced at 60,000, one pickup at 30,000.
const DESC_40FT = "3 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck";
const DESC_PICKUP = '1 x PICKUP 1 TON Truck';

function adapterStub() {
  const a = {
    st: { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 8_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 },
    // multiCargoBidSupported true, the way the GoComet adapter declares it, so armFromRequest carries
    // the vector rather than dropping it.
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3,
      closeModel: 'hard', multiCargoBidSupported: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ...a.st }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 40 }),
  };
  return a;
}

function mkLoad(id, { startsAt, status, multi = true }) {
  const descriptors = multi ? [DESC_40FT, DESC_PICKUP] : [DESC_40FT];
  const types = cargoTypeList(descriptors);
  return {
    id, lane: { origin: 'Gurugram', destination: 'Pune' }, companyName: 'Waaree Energies Ltd.',
    branchName: 'Pune', equipment: '3 x 40 ft, 25 T + 1 x PICKUP, 1 T',
    units: types.reduce((n, t) => n + t.count, 0), cargoLines: descriptors.length,
    cargoTypes: multi ? types : null,
    closesAt: Date.now() + 8_000, startsAt, status, softClose: false,
  };
}

function rig(adapter, intentsFile) {
  const store = createStore({ backend: 'memory' });
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), {
    config: CFG, onEvent: (e) => { events.push(e); },
  });
  return { store, events, engine };
}

/** capture on a fresh request and hand it to the engine - per-type when the load carries types. */
async function armed(engine, store, load) {
  const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 1.8 });
  // These fixtures close in SECONDS, so the derived deadlineAt would land in the past and capture()
  // would rightly refuse. deadlineAt gates capture() alone, never engine timing.
  const created = await rq.createForLoad(load, { deadlineAt: Date.now() + 60_000 });
  const captured = load.cargoTypes
    ? await rq.capture(created.id, { costByType: [60_000, 30_000] })
    : await rq.capture(created.id, { cost: 60_000 });
  return armFromRequest(engine, captured);
}

const bidLiveOf = (events) => {
  const evt = events.find((e) => e.type === 'bid_placed');
  return { evt, n: evt ? toNotification(evt) : null };
};

(async () => {
  // ---- A. live path: armFromRequest -> bid_placed -> bid_live payload -> rendered message ----
  {
    const f = tmp('live');
    const { store, events, engine } = rig(adapterStub(), f);
    await armed(engine, store, mkLoad('260906V7TB', { startsAt: Date.now() - 1000, status: 'live' }));

    const intent = engine.scheduler.get('260906V7TB');
    assert.strictEqual(intent.cost, 52_500, 'the ladder is built off the weighted blend, unchanged');
    assert.ok(intent.rules && intent.rules.costByType, 'the armed intent persists the per-type vector');
    ok('armFromRequest -> arm() persists the per-type vector on the durable intent');

    await sleep(600); // engine is live -> places the establishing bid
    const { evt, n } = bidLiveOf(events);
    assert.ok(evt, 'a bid was placed');
    assert.strictEqual(evt.cost, 52_500, 'the event still carries the blended cost the ladder walks');
    assert.ok(evt.costByType && evt.costByType.types.length === 2, 'and now carries the vector beside it');
    assert.strictEqual(n.kind, 'bid_live', 'the bid routes as the bid_live kind');
    assert.deepStrictEqual(n.data.rateByType,
      [{ label: '40 ft, 25 T', count: 3, cost: 60_000 }, { label: 'PICKUP, 1 T', count: 1, cost: 30_000 }],
      'the bid_live payload carries each entered rate against its own type and count');
    assert.ok(!('match' in (n.data.rateByType[0] || {})),
      'and never the freight-line join key, which has no business in a message payload');
    ok('the vector survives arm -> bid_placed -> bid_live alert payload');

    const msg = renderMessage('bid_live', n.data);
    assert.ok(/\+9% on each of your rates/.test(msg),
      'the message states the margin, which is what holds per line');
    assert.ok(!/52,500/.test(msg) && !/your rate ₹/.test(msg),
      'and never calls the blended mean "your rate" - the CW-213 defect on the louder message');
    ok('the rendered bid_live message names no figure the desk did not enter');

    // The margin is DERIVED from the fired rung, never read off the band. A ceiling-capped ladder
    // fires rungIndex 0 at the ceiling, so quoting openingPct would overstate the opening by six
    // points on a message that no longer carries a price to contradict it.
    assert.ok(/First bid placed at \+2\.86% on each of your rates/.test(
      renderMessage('bid_live', Object.assign({}, n.data, { price: 54000 }))),
    'a ceiling-capped rung must report its own margin, not the band\'s anchor');
    ok('a ceiling-capped rung reports its own margin, not the band\'s anchor');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- B. scheduled load: the intent persists the vector; the WAKE arms with it ----
  {
    const f = tmp('sched');
    const { store, events, engine } = rig(adapterStub(), f);
    await armed(engine, store, mkLoad('SCHED1', { startsAt: Date.now() + 700, status: 'scheduled' }));

    const intent = engine.scheduler.get('SCHED1');
    assert.strictEqual(intent.status, 'scheduled', 'not-yet-started load -> scheduled intent');
    assert.ok(intent.rules && intent.rules.costByType, 'schedule() persists the vector on the intent');
    ok('schedule() persists the vector (a pre-armed load is armed by the wake, not by the capture)');

    await sleep(900); // wake fires at startsAt - armLeadMs
    assert.ok(events.some((e) => e.type === 'armed'), 'the wake armed the load');
    const { evt, n } = bidLiveOf(events);
    assert.ok(evt && evt.costByType && evt.costByType.types.length === 2,
      'the wake-armed load still carries the vector when it bids');
    assert.ok(/\+9% on each of your rates/.test(renderMessage('bid_live', n.data)),
      'and its bid_live message is the per-type copy, not the blended one');
    ok('schedule -> wake -> arm -> bid keeps the vector through the intent round-trip');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- C. restart: rehydrate re-arms with the vector, over a FRESH store ----
  //
  // THE ONE THAT MATTERS. `rules` is what carries the vector, and it round-trips on the intent
  // (bidEngine.js "LoadRules must survive wake/rehydrate too"). Were that ever not true, every case
  // above would still pass and the alert would be blank on the box after any mid-auction deploy.
  {
    const f = tmp('restart');
    const adapter = adapterStub();
    // session 1: arm via the price-request path, then "crash" mid-auction (what deploy.sh does)
    {
      const { store, engine } = rig(adapter, f);
      await armed(engine, store, mkLoad('RESTART1', { startsAt: Date.now() - 1000, status: 'live' }));
      assert.ok(engine.scheduler.get('RESTART1').rules.costByType, 'the armed intent persists the vector');
      engine.kill('simulated crash');
    }
    // session 2: fresh engine + EMPTY store rehydrates from disk alone
    const { events: events2, engine: engine2 } = rig(adapter, f);
    await engine2.rehydrate();
    assert.ok(events2.some((e) => e.type === 'armed'), 'rehydrate re-armed the load');
    await sleep(600);
    const { evt, n } = bidLiveOf(events2);
    assert.ok(evt, 'the rehydrated load placed a bid');
    assert.ok(evt.costByType && evt.costByType.types.length === 2,
      'the rehydrated load still carries the vector - a mid-auction deploy does not strip it');
    assert.deepStrictEqual(n.data.rateByType.map((t) => t.cost), [60_000, 30_000],
      'both entered rates survive the disk round-trip with their own values');
    const msg = renderMessage('bid_live', n.data);
    assert.ok(/\+9% on each of your rates/.test(msg) && !/52,500/.test(msg),
      'and the post-restart message is still the per-type copy');
    ok('restart/rehydrate keeps the vector (a mid-auction deploy no longer blanks the alert)');
    engine2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- D. a single-rate load carries null the whole way and renders the ORIGINAL copy ----
  {
    const f = tmp('single');
    const { store, events, engine } = rig(adapterStub(), f);
    await armed(engine, store, mkLoad('SINGLE1', { startsAt: Date.now() - 1000, status: 'live', multi: false }));
    await sleep(600);
    const { evt, n } = bidLiveOf(events);
    assert.strictEqual(evt.costByType, null, 'the event carries an explicit null, never undefined-by-accident');
    assert.strictEqual(n.data.rateByType, null, 'and the payload does too');
    assert.strictEqual(renderMessage('bid_live', n.data),
      'Bidding is live on Gurugram -> Pune (Waaree Energies Ltd.). First bid ₹65,400 - your rate ₹60,000 + 9%.',
      'a one-rate load renders the message byte-for-byte as it did before CW-213');
    ok('a single-rate load is untouched end to end');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- E. rules === null on the WIRE half: the load class the merge fix actually widened ----
  //
  // GoComet attaches a rules object only where the enquiry declares a minDecrement or a ceiling
  // (gocometAdapter.js:1648), so an enquiry with neither arms with rules null - the class the merge
  // exists for, and the class that now engages resolvePerTypePrices where it used to short-circuit
  // on a null spec and bid one blended rate. Cases A-D all arm with no rules too, but they stop at
  // the ALERT payload; nothing there reaches the opts placeBid is called with, which is where the
  // widening actually happens. Two things have to hold: the vector gets there, and a refusal to
  // route it is never booked as a bid. That second half is the money one - resolvePerTypePrices
  // refuses ABOVE the confirming read and the PUT, so nothing reached the portal, and the
  // uncertain-outcome handler would have counted a landed bid anyway (GoComet publishes no
  // revisionsLeft to falsify it with) and gone quiet at close about a load that never bid.
  {
    const f = tmp('nullrules');
    const seenOpts = [];
    const adapter = adapterStub();
    adapter.placeBid = async (id, price, opts) => {
      seenOpts.push(opts);
      const e = new Error('gocomet: the rate for "PICKUP, 1 T" matches no freight line on the quote');
      e.code = 'COST_TYPE_UNMATCHED';
      throw e;
    };
    // GoComet publishes NO revision count, and that absence is what makes the uncertain-outcome
    // handler unfalsifiable: `landed` initialises true and only a DROPPED revisionsLeft can turn it
    // off. A stub reporting one would quietly take the not-landed branch and hide the phantom.
    adapter.getAuctionState = async () => ({ ...adapter.st, revisionsLeft: null });
    const { store, events, engine } = rig(adapter, f);
    const load = Object.assign(
      mkLoad('NULLRULES1', { startsAt: Date.now() - 1000, status: 'live' }), { rules: null });
    await armed(engine, store, load);
    assert.strictEqual(engine.scheduler.get('NULLRULES1').rules.pricingMode, undefined,
      'the fixture really is the no-LoadRules class - nothing but the added keys is on the rules');

    await sleep(600);
    assert.ok(seenOpts.length >= 1, 'the engine reached the fire point');
    assert.ok(seenOpts[0].costByType && seenOpts[0].costByType.types.length === 2,
      'a load carrying NO rules still hands the per-type vector to placeBid');
    ok('rules: null + multi-type carries the vector all the way onto the placeBid opts');

    const m = engine.monitors.get('NULLRULES1');
    assert.strictEqual(m.landedBids, 0,
      'a refusal raised before the wire books NO landed bid - the phantom this guard exists to stop');
    assert.strictEqual(m.firedRungs.size, 0, 'it spends no rung, so the decisive shot is still in hand');
    assert.strictEqual(m.currentRungIndex, -1, 'and the ladder position is given back');
    assert.ok(m.ownBidAttempts > 0,
      'the ATTEMPT is deliberately not given back - it is what keeps the close alarming');
    assert.strictEqual(m.noBid && m.noBid.reason, 'per_type_rates_unmatched',
      'and the load carries a recorded reason rather than closing unexplained');
    ok('COST_TYPE_UNMATCHED books no phantom bid, holds the rung, and records an actionable refusal');

    await engine._finalize(m, { ok: true, myRank: null, closesInMs: 0 });
    const result = events.find((e) => e.type === 'auction_result');
    assert.strictEqual(result.landedBids, 0, 'the outcome reports zero landed bids');
    assert.strictEqual(result.noBidReason, 'per_type_rates_unmatched', 'and names the reason');
    assert.strictEqual(events.filter((e) => e.kind === 'never_bid_before_close').length, 1,
      'never_bid_before_close STILL fires - a recorded reason explains the close, it must not silence it');
    // marketRate is what outcomeEnrichment actually puts on this payload (engineAlerts.js:497, from
    // the arm-time blend on the closed-bids record), so the render is driven with it here. Omitting
    // it made yourRateLine return '' and hid the contradiction the money block prints in prod.
    const body = renderMessage('no_bid', { noBidReason: 'per_type_rates_unmatched', marketRate: '52,500' });
    assert.ok(!/Your Rate/.test(body) && !/52,500/.test(body),
      'no blended rupee figure sits above a sentence saying the load was priced per truck type');
    assert.ok(/[Qq]uote this load by hand on the portal/.test(body),
      'and the desk receipt states a remedy the desk actually holds');
    assert.ok(!/enter one rate for it on the load link/.test(body),
      'never the single-rate entry the per-type price form structurally cannot accept');
    assert.ok(!/no bid could be placed before close/.test(body),
      'rather than the unknown-reason wording that sends them hunting a pricing mistake');
    ok('the close names the reason, still alarms ops, and the receipt is actionable');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // COMPLETION SENTINEL - run-tests.js grades this file by its EXIT CODE ALONE, so a body that
  // exits 0 early scores as a silent green having asserted nothing.
  const MIN_EXPECTED_CHECKS = 11;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS}`);
  console.log(`\n${pass}/${pass} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
