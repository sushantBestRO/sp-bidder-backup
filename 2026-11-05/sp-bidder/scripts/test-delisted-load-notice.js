'use strict';
/**
 * The delisted-load blind spot: SuperProcure drops a load, realAdapter's loadMeta is never evicted,
 * so the engine keeps counting down on a healthy-looking local cache and learns the load is dead only
 * when the platform refuses its snipe. On load 25084674 that news reached the desk 25 seconds before
 * close; across the 13 in-scope loads, 10 gave them under 40 seconds and 23 of the 24 carrying the
 * signature landed zero bids.
 *
 * What is pinned here is the OWNER'S choice, which is notify early and STAY ARMED. Two halves, and
 * the second is the one that is easy to lose in a later edit:
 *   - the notice goes out at or before armedAt, off the listing cache, with no platform read;
 *   - nothing about bidding changes. The monitor stays armed, the ladder is untouched, no refusal is
 *     recorded, and a relist forfeits nothing. A guard that stood the load down would pass every
 *     assertion about the notice and silently take the opposite decision.
 *
 * The discriminator has to be all three of no-bid-landed, biddingOn false, and a stale sighting: the
 * control group is 17 loads that stood down carrying biddingOn TRUE and 15 of them bid normally, and
 * a load this adapter has never listed (armed from a durable intent after a restart) reports a null
 * age that must read as UNKNOWN rather than as infinitely stale.
 *
 *   node scripts/test-delisted-load-notice.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const tmp = (tag) => path.join(os.tmpdir(), `delisted-notice-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

// 90_000 is the shipped default (three missed 30s discovery polls). Named here rather than inlined
// so a change to the threshold shows up as one edit in this file, not as scattered magic numbers.
const STALE_MS = 90_000;
const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0, delistedStaleMs: STALE_MS };
const BAND = { cost: 38000, marginsPct: [14, 11.5, 10.3], minMarginPct: 10.3 };

const st = (o) => Object.assign({ ok: true, status: 'live', myRank: null, totalBidders: 1,
  standingL1Price: null, closesInMs: 10000, revisionLimit: 3, revisionsLeft: 3,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }, o);

const armMeta = (id, closesInMs) => ({ id, lane: { origin: 'Bhiwandi', destination: 'Surat' }, units: 1,
  companyName: 'Syngenta', branchName: 'Bhiwandi', closesAt: Date.now() + closesInMs });

// `trace` is what the adapter's listingTrace answers for every load. null models an adapter with no
// listing cache at all; a per-load object models the real one.
function mkEngine(f, trace, opts = {}) {
  const events = [];
  const placed = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    async getAuctionState() { return st({ closesInMs: this._t != null ? this._t : 10000 }); },
    async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
  };
  if (trace !== null) adapter.listingTrace = (id) => trace(id);
  const eng = new BidEngine(adapter, new DurableScheduler(f),
    Object.assign({ config: CFG, rand: () => 0, onEvent: (e) => events.push(e) }, opts));
  return { eng, adapter, events, placed,
    notices: () => events.filter((e) => e.type === 'alert' && e.kind === 'load_not_biddable') };
}

// The Syngenta 25084674 shape: last seen 4.9 minutes ago, and that sighting carried biddingOn false.
const delisted = () => ({ lastSeenInListAt: Date.now() - 294_000, lastSeenInListAgoMs: 294_000, biddingOn: false });
// The control shape: a fresh sighting SuperProcure is still listing as open.
const healthy = () => ({ lastSeenInListAt: Date.now() - 4_000, lastSeenInListAgoMs: 4_000, biddingOn: true });
// The post-restart shape: armed off a durable intent, this adapter has never listed the load.
const neverListed = () => ({ lastSeenInListAt: null, lastSeenInListAgoMs: null, biddingOn: null });

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. The notice fires at arm time, and it is the ONLY thing that changed.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('arm');
    const { eng, events, placed, notices } = mkEngine(f, delisted);
    const m = eng.arm(armMeta('25084674', 32 * 60_000), BAND);

    assert.strictEqual(notices().length, 1, 'exactly one notice for the load');
    const n = notices()[0];
    assert.strictEqual(n.auctionId, '25084674', 'the notice names the load');
    assert.strictEqual(n.level, 'warn');
    assert.strictEqual(n.companyName, 'Syngenta', 'the shipper scope key is present or no group matches');
    assert.strictEqual(n.branchName, 'Bhiwandi', 'the branch scope key rides too');
    assert.deepStrictEqual(n.lane, { origin: 'Bhiwandi', destination: 'Surat' });
    assert.strictEqual(n.lastSeenInListAgoMs, 294_000, 'the notice carries the staleness that triggered it');
    assert.strictEqual(n.biddingOn, false);
    assert.strictEqual(n.stillListed, null, 'no live probe on this path - stillListed stays UNKNOWN, never guessed');

    // AT OR BEFORE armedAt. The notice is emitted from inside arm(), ahead of the armed event, so a
    // consumer replaying the stream in order sees the warning before the load is reported armed.
    const kinds = events.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type));
    assert.ok(kinds.indexOf('alert:load_not_biddable') < kinds.indexOf('armed'),
      'the notice is emitted at or before armedAt, not after it');

    // ZERO BIDS, and placeBid never reached. Asserted because the alternative reading of this fix -
    // stand the load down - would also produce the notice above.
    assert.deepStrictEqual(placed, [], 'no bid went on the wire');
    ok('a stale sighting carrying biddingOn false raises exactly one notice, at or before armedAt, with zero bids');

    // STILL ARMED is the owner's choice and the half a later edit would quietly drop.
    assert.ok(eng.monitors.has('25084674'), 'the monitor is armed');
    assert.strictEqual(m.loadNotBiddable, false, 'no bidding latch was set - the ladder is still spendable');
    assert.strictEqual(m.noBid, null, 'no refusal was recorded, so a relist that wins still gets a true receipt');
    assert.strictEqual(m.revisionsLeft, 3, 'the per-load budget is untouched');
    assert.deepStrictEqual(m.ladder, [43320, 42370, 41914], 'the ladder is untouched');
    ok('the load stays armed with its ladder, budget and receipt intact - a relist forfeits nothing');
    eng.kill(); rm(f);
  }

  {
    // Latched. The monitor ticks at up to 5 per second in the snipe window; an unlatched notice
    // would put hundreds of WhatsApp messages on the customer's own group.
    const f = tmp('latch');
    const { eng, adapter, notices } = mkEngine(f, delisted);
    const m = eng.arm(armMeta('L1', 30_000), BAND);
    assert.strictEqual(notices().length, 1, 'the arm notified');
    for (const t of [20000, 12000, 8000, 6000, 5000, 4000, 3000, 1200]) {
      adapter._t = t;
      await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    }
    assert.strictEqual(notices().length, 1, 'eight further ticks added nothing');
    ok('the notice is latched per load: repeated ticks never repeat it');
    eng.kill(); rm(f);
  }

  {
    // THE TICK PATH on its own. A load that was listed and fresh at arm time and goes stale while
    // armed must still be reported - the arm-time check alone would miss every mid-auction delist.
    const f = tmp('tick');
    let trace = healthy();
    const { eng, adapter, notices, placed } = mkEngine(f, () => trace);
    const m = eng.arm(armMeta('T1', 30_000), BAND);
    assert.strictEqual(notices().length, 0, 'a fresh, open sighting says nothing at arm');
    trace = delisted();
    adapter._t = 40000; // still outside openAtMs, so nothing is due to bid on this tick either way
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(notices().length, 1, 'the tick that first sees the stale sighting raises the notice');
    assert.deepStrictEqual(placed, [], 'and still without bidding');
    ok('a load that goes stale mid-auction is caught on the tick path, not only at arm');
    eng.kill(); rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Silence on every shape that is not this one.
  // ---------------------------------------------------------------------------------------------
  {
    // The mirror fixture: fresh sighting, biddingOn true. This is the 17-load control group, 15 of
    // which bid normally - the population the guard must not touch.
    const f = tmp('healthy');
    const { eng, adapter, notices, placed } = mkEngine(f, healthy);
    const m = eng.arm(armMeta('H1', 30_000), BAND);
    for (const t of [20000, 12000, 8000, 1200]) {
      adapter._t = t;
      await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    }
    assert.strictEqual(notices().length, 0, 'a load SuperProcure is still listing as open says nothing');
    assert.ok(placed.length > 0, 'and it bids exactly as before');
    ok('the fresh, biddingOn-true fixture arms and fires unchanged');
    eng.kill(); rm(f);
  }

  {
    // The post-restart case: listingTrace returns all nulls because this adapter process has never
    // listed the load. A null age is UNKNOWN, and a fabricated "infinitely stale" reading here would
    // fire on every single load for the first 30 seconds after every deploy.
    const f = tmp('nulls');
    const { eng, adapter, notices, placed } = mkEngine(f, neverListed);
    const m = eng.arm(armMeta('N1', 30_000), BAND);
    for (const t of [20000, 8000, 1200]) {
      adapter._t = t;
      await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    }
    assert.strictEqual(notices().length, 0, 'all-nulls reads as UNKNOWN, not as delisted');
    assert.ok(placed.length > 0, 'and the load arms and bids normally');
    ok('a load this adapter has never listed (post-restart) arms normally and raises nothing');
    eng.kill(); rm(f);
  }

  {
    // An adapter with no listing cache at all - GoComet, the simulator, every mock in this suite.
    const f = tmp('notrace');
    const { eng, notices, placed } = mkEngine(f, null);
    const m = eng.arm(armMeta('X1', 30_000), BAND);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(notices().length, 0, 'no listingTrace, no notice');
    assert.ok(placed.length >= 0);
    ok('an adapter without listingTrace is unaffected');
    eng.kill(); rm(f);
  }

  {
    // THE THRESHOLD, from both sides of it. Two minutes of staleness is a real delisted load
    // (24779249 was 2.0 min stale at arm); one interval of ordinary poll jitter is not.
    const f = tmp('below');
    const jitter = () => ({ lastSeenInListAt: Date.now() - 45_000, lastSeenInListAgoMs: 45_000, biddingOn: false });
    const a = mkEngine(f, jitter);
    a.eng.arm(armMeta('U1', 30_000), BAND);
    assert.strictEqual(a.notices().length, 0, '45s of staleness is inside ordinary poll jitter - silent');
    a.eng.kill(); rm(f);

    const f2 = tmp('above');
    const tight = () => ({ lastSeenInListAt: Date.now() - 120_000, lastSeenInListAgoMs: 120_000, biddingOn: false });
    const b = mkEngine(f2, tight);
    b.eng.arm(armMeta('U2', 30_000), BAND);
    assert.strictEqual(b.notices().length, 1, 'the tightest real case measured (2.0 min) is still caught');
    b.eng.kill(); rm(f2);
    ok('the threshold separates ordinary poll jitter from the tightest delisted load on record');
  }

  {
    // A BID ALREADY ON THE BOARD is not this case, whatever the listing says. The control group is
    // exactly the reason: biddingOn does not separate the populations on its own.
    const f = tmp('landed');
    const { eng, adapter, notices } = mkEngine(f, healthy);
    const m = eng.arm(armMeta('B1', 30_000), BAND);
    adapter._t = 20000;
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.ok(m.landedBids > 0, 'precondition: a bid landed');
    // Now the load drops off the listing, with our money already on the board.
    adapter.listingTrace = delisted;
    adapter._t = 8000;
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(notices().length, 0, 'a load carrying a landed bid raises nothing');
    ok('the guard is conditioned on no bid having landed, not on the listing alone');
    eng.kill(); rm(f);
  }

  {
    // THE CLASS, not one load. The 13 in-scope loads (2026-08-03 to 2026-09-07: Renewsys x9,
    // Syngenta x2, Epack x1, BG x1) were every one of them already absent from the listing at arm
    // time, at a measured staleness spanning 2.0 minutes to 48 hours. Their per-load listingTrace
    // records live on the box and are not in this repo, so this walks the measured RANGE rather than
    // claiming to replay the records: every point in it must flag, and it is the low end (2.0 min,
    // load 24779249) that decides the threshold.
    const spread = [120_000, 300_000, 900_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 48 * 3_600_000];
    const flagged = [];
    for (const ageMs of spread) {
      const f = tmp(`class-${ageMs}`);
      const { eng, notices } = mkEngine(f,
        () => ({ lastSeenInListAt: Date.now() - ageMs, lastSeenInListAgoMs: ageMs, biddingOn: false }));
      eng.arm(armMeta(`C${ageMs}`, 30_000), BAND);
      if (notices().length === 1) flagged.push(ageMs);
      eng.kill(); rm(f);
    }
    assert.deepStrictEqual(flagged, spread,
      'every staleness in the measured 2.0-minute-to-48-hour range flags at arm time');
    ok('the whole measured staleness range of the in-scope class flags at arm, low end included');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. It reaches the desk, on the channel that already carries this kind.
  // ---------------------------------------------------------------------------------------------
  {
    assert.ok(DESK_NOTICE_KINDS.has('load_not_biddable'),
      'the notice routes to the customer group, not to the ops error channel');
    ok('the kind is already a desk notice, so the early notice reaches the same recipients as the late one');
  }

  console.log(`\n${pass}/11 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
