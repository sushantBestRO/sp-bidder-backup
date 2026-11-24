'use strict';
/**
 * A LOAD THE ADAPTER HAS NEVER LISTED IS CHECKED ON THE PORTAL AT ARM, AND THE DESK IS TOLD IF IT IS
 * NOT OPEN (BC-15 Fix B).
 *
 * After a restart the adapter's listing cache is empty, so the at-arm delisted notice reads a never-
 * listed load as UNKNOWN and stays silent (25704609: priced two minutes before close on a load
 * SuperProcure was no longer offering; every read failed for two hours and the load retired with no
 * reason on its record).
 *
 * Checks 1-2 are a NAMED RE-PIN (BC-15 Fix B, ruling 65). As first built, BC-15 Fix B probed the
 * portal at arm for every never-listed load, once each - a restart fires one board-wide read per
 * armed load at once on the shared live account, and broke two frozen read-cost contracts
 * (test-rejection-classify-contract.js C1, test-submit-leg-network-fails-closed.js check 7). The
 * rework judges a never-listed load off the first full listing that completes after it armed (the
 * discovery poll the stack already runs) and falls back to a probe of its own only once no listing
 * has landed within a bound (>= two discovery polls, never under 60s - see config.js
 * engine.neverListedProbeBoundMs). Checks 1-2 now cover the two routes to the same notice: the fast
 * path (1, a listing lands) and the fallback path (2, none does before the bound). Checks 3-5 are
 * UNCHANGED in their assertions; the shared arm() harness gained one config field
 * (neverListedProbeBoundMs: 0) so the fallback path they exercise still fires within a fast test -
 * without it, the default >= 60s bound would leave checks 3-4 vacuously true (the probe never runs
 * inside a settle()-length window either way, so "no notice" and "probed once" would pass with zero
 * evidence behind them).
 *
 *   1. named re-pin: BC-15 Fix B, ruling 65 - a full listing completes after arm and the load is
 *      absent from it -> load_not_biddable at arm (via the trace, no probe spent), and the no-bid
 *      close carries reason not_open_on_portal.
 *   2. named re-pin: BC-15 Fix B, ruling 65 - no listing completes before the bound, so the load
 *      probes itself once and the portal says it is listed but not open -> the same notice.
 *   3. control: never listed but the fallback probe finds it open -> no notice, no reason.
 *   4. control: the fallback probe runs once per monitor, not per tick.
 *   5. control: a load that went on to land a bid closes with no not_open_on_portal reason.
 *   6. a restart arming several never-listed loads together makes ZERO listing requests before the
 *      bound, and a discovery listing landing inside the bound settles all of them for free.
 *   7. with no listing inside the bound, each load's fallback probe still runs exactly once - the
 *      per-monitor latch, not a one-shot per adapter.
 *   8. the ADAPTER single-flights concurrent fallback probes into one physical listing read
 *      (RealSuperProcureAdapter over an injected transport - the mechanism check 7 cannot see from
 *      the engine side, since the engine calls listingProbe once per monitor regardless).
 *   9. a load that was never listed and then IS, open, by a real discovery-shaped listing raises
 *      nothing - the never-listed branch hands off cleanly to the ordinary staleness check.
 *
 *   node scripts/test-never-listed-load-probed-at-arm.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `never-listed-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

const results = [];
async function check(n, name, fn) {
  try { await fn(); results.push(true); console.log(`  ok  ${n}. ${name}`); }
  catch (e) {
    if (/^(setup|harness):/.test(e.message)) throw e;
    results.push(false); console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `lastFullListingAt` is mutable (a `{ v }` box) so a test can simulate a discovery listing landing
// after arm without rebuilding the adapter.
function mkAdapter({ probe, lastFullListingAtBox = { v: null } } = {}) {
  const calls = { probe: 0 };
  return {
    calls,
    lastFullListingAtBox,
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    listingTrace: () => ({ lastSeenInListAt: null, lastSeenInListAgoMs: null, biddingOn: null }),
    lastFullListingAt: () => lastFullListingAtBox.v,
    listingProbe: async () => { calls.probe += 1; return probe; },
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 }),
  };
}

function mkEngine(adapter, cfg = {}) {
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
    // neverListedProbeBoundMs: 0 keeps the fallback path reachable inside a fast test - see the
    // file header. Individual checks override it where the bound itself is under test.
    config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0, neverListedProbeBoundMs: 0, ...cfg },
    live: true, onEvent: (e) => events.push(e), log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { engine, events };
}

function armOn(engine, id, closesInMs = 120_000) {
  const m = engine.arm({
    id, lane: { origin: 'Bagru', destination: 'Badli' }, equipment: '32FT', units: 1,
    companyName: 'BG', closesAt: Date.now() + closesInMs, startsAt: Date.now() - 1_000, status: 'live', softClose: false,
  }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

async function arm(opts) {
  const adapter = mkAdapter(opts);
  const { engine, events } = mkEngine(adapter);
  const m = armOn(engine, `NL${seq}`);
  await settle();
  return { engine, m, events, adapter };
}
const notices = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'load_not_biddable');

(async () => {
  const aBox = { v: null };
  const aAdapter = mkAdapter({ lastFullListingAtBox: aBox });
  // A bound wide enough that arm() itself cannot exhaust it - the point of this check is that the
  // fast trace path settles the load before the fallback probe ever becomes eligible.
  const { engine: aEngine, events: aEvents } = mkEngine(aAdapter, { neverListedProbeBoundMs: 5_000 });
  const aM = armOn(aEngine, `NL${seq}`);
  await settle();
  await check(1, 'named re-pin: BC-15 Fix B, ruling 65 - a listing lands after arm without the load -> desk notice at arm via the trace, no probe spent, and a reason at close', async () => {
    assert.strictEqual(notices(aEvents).length, 0, 'no listing has landed yet - nothing should have fired');
    // The discovery poll the stack already runs completes AFTER this monitor armed.
    aBox.v = Date.now();
    aEngine._checkDelisted(aM);
    const n = notices(aEvents);
    assert.strictEqual(n.length, 1, `${n.length} load_not_biddable notice(s) for a load absent from a post-arm listing`);
    assert.strictEqual(n[0].stillListed, false, `notice.stillListed is ${n[0].stillListed}`);
    assert.strictEqual(aAdapter.calls.probe, 0, 'the fast trace path settled it - the fallback probe must not have run');
    const why = aEngine._refusalAtClose(aM);
    assert.ok(why && why.reason === 'not_open_on_portal', `the no-bid close would carry ${JSON.stringify(why)}, expected reason not_open_on_portal`);
  });
  aEngine.kill('done');

  const bAdapter = mkAdapter({ probe: { stillListed: true, biddingOn: false, listedCount: 40 } });
  const { engine: bEngine, events: bEvents } = mkEngine(bAdapter, { neverListedProbeBoundMs: 40 });
  const bM = armOn(bEngine, `NL${seq}`);
  await check(2, 'named re-pin: BC-15 Fix B, ruling 65 - no listing before the bound, the fallback probe finds it listed but not open -> the same notice', async () => {
    assert.strictEqual(bAdapter.calls.probe, 0, 'nothing should probe before the bound elapses');
    assert.strictEqual(notices(bEvents).length, 0, 'and nothing has been decided yet');
    await sleep(70); // past the 40ms bound
    bEngine._checkDelisted(bM);
    await settle(); // _probeNeverListed is fire-and-forget async
    assert.strictEqual(bAdapter.calls.probe, 1, 'past the bound, the fallback probe ran exactly once');
    assert.strictEqual(notices(bEvents).length, 1, 'and the portal\'s "listed but not open" answer raised the same notice');
  });
  bEngine.kill('done');

  const c = await arm({ probe: { stillListed: true, biddingOn: true, listedCount: 40 } });
  await check(3, 'control: never listed but the fallback probe finds it open -> no notice, no reason', async () => {
    assert.strictEqual(notices(c.events).length, 0, 'a notice for a load that is open');
    assert.strictEqual(c.engine._refusalAtClose(c.m), null, 'a no-bid reason for a load that is open');
  });

  await check(4, 'control: the fallback probe runs once per monitor, not per tick', async () => {
    for (let i = 0; i < 3; i++) c.engine._checkDelisted(c.m);
    await settle();
    assert.ok(c.adapter.calls.probe <= 1, `listingProbe ran ${c.adapter.calls.probe} times for one monitor`);
  });
  c.engine.kill('done');

  const d = await arm({ probe: { stillListed: false, biddingOn: null, listedCount: 40 } });
  await check(5, 'control: a load that went on to land a bid closes without the not-open reason', async () => {
    d.m.landedBids = 1;
    const why = d.engine._refusalAtClose(d.m);
    assert.ok(!why || why.reason !== 'not_open_on_portal', `a load with a landed bid would close as ${JSON.stringify(why)}`);
  });
  d.engine.kill('done');

  // ------------------------------------------------------------------------------------------------
  // 6. A RESTART BATCH. Several never-listed loads arm together, none has landed a listing yet, and a
  //    discovery listing lands inside the bound before any of them falls back to a probe.
  // ------------------------------------------------------------------------------------------------
  {
    const box = { v: null };
    const adapter = mkAdapter({ lastFullListingAtBox: box });
    const { engine, events } = mkEngine(adapter, { neverListedProbeBoundMs: 5_000 });
    const ids = ['RS1', 'RS2', 'RS3'];
    const monitors = ids.map((id) => armOn(engine, id));
    await settle();
    await check(6, 'a restart batch makes zero listing requests before the bound, and a listing landing inside it settles every load', async () => {
      assert.strictEqual(adapter.calls.probe, 0, 'no monitor should have fallen back to a probe yet');
      assert.strictEqual(notices(events).length, 0, 'and nothing has been decided yet either');

      // The discovery poll the stack already runs completes, well inside the 5s bound.
      box.v = Date.now();
      for (const m of monitors) engine._checkDelisted(m);

      assert.strictEqual(adapter.calls.probe, 0, 'the listing settled every load for free - still zero listing requests');
      assert.strictEqual(notices(events).length, 3, 'every one of the three absent loads got its notice');
    });
    engine.kill('done');
  }

  // ------------------------------------------------------------------------------------------------
  // 7. NO LISTING INSIDE THE BOUND. Each load's own fallback probe still runs exactly once - a
  //    per-monitor latch, not a one-shot the first load to probe consumes for the others.
  // ------------------------------------------------------------------------------------------------
  {
    const adapter = mkAdapter({ probe: { stillListed: false, biddingOn: null, listedCount: 0 } });
    const { engine, events } = mkEngine(adapter, { neverListedProbeBoundMs: 30 });
    const ids = ['BE1', 'BE2'];
    const monitors = ids.map((id) => armOn(engine, id));
    await check(7, 'past the bound, each never-listed load falls back to exactly one probe of its own', async () => {
      assert.strictEqual(adapter.calls.probe, 0, 'nothing should probe before the bound elapses');
      await sleep(60); // past the 30ms bound
      for (const m of monitors) engine._checkDelisted(m);
      await settle();
      for (const m of monitors) engine._checkDelisted(m); // a repeat tick must not re-probe
      assert.strictEqual(adapter.calls.probe, 2, `expected one probe per load (2), got ${adapter.calls.probe}`);
      assert.strictEqual(notices(events).length, 2, 'both loads got their notice');
    });
    engine.kill('done');
  }

  // ------------------------------------------------------------------------------------------------
  // 8. THE ADAPTER'S OWN SINGLE-FLIGHT. Concurrent fallback probes - the shape a restart produces -
  //    must cost the shared account ONE physical listing read, not one per load. This is the real
  //    RealSuperProcureAdapter over an injected transport, not the fake mock above, because the
  //    engine-side count in check 7 cannot see whether the adapter coalesced the underlying reads.
  // ------------------------------------------------------------------------------------------------
  {
    const listCalls = [];
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/sp/loads/v4')) {
        listCalls.push(u);
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { loadDetails: [] } }) };
      }
      throw new Error('unexpected request: ' + u);
    };
    const adapter = new RealSuperProcureAdapter({ token: 'never-listed-singleflight-token', fetchImpl });
    adapter.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
    adapter.writeEnabled = true;

    await check(8, 'concurrent fallback probes share one physical listing read in the adapter', async () => {
      await Promise.all([
        adapter.listingProbe('P1'), adapter.listingProbe('P2'), adapter.listingProbe('P3'),
      ]);
      assert.strictEqual(listCalls.length, 1, `expected one /sp/loads/v4 read for three concurrent probes, got ${listCalls.length}`);
    });
  }

  // ------------------------------------------------------------------------------------------------
  // 9. HANDOFF. A load that was never listed and is then found, open, by a real discovery-shaped
  //    listing raises nothing - the never-listed branch must not keep re-deciding once the ordinary
  //    staleness check has a real sighting to read.
  // ------------------------------------------------------------------------------------------------
  {
    let trace = () => ({ lastSeenInListAt: null, lastSeenInListAgoMs: null, biddingOn: null });
    const adapter = mkAdapter({});
    adapter.listingTrace = (id) => trace(id);
    const { engine, events } = mkEngine(adapter);
    const m = armOn(engine, 'HO1');
    await settle();
    trace = () => ({ lastSeenInListAt: Date.now() - 4_000, lastSeenInListAgoMs: 4_000, biddingOn: true });
    engine._checkDelisted(m);
    await check(9, 'a load found open by a real listing after being never-listed raises nothing', async () => {
      assert.strictEqual(notices(events).length, 0, 'a load the listing now shows as open must stay silent');
    });
    engine.kill('done');
  }

  const failed = results.filter((r) => !r).length;
  if (failed) {
    console.log(`FAIL - ${failed} of ${results.length} checks: a load the adapter has never listed is not checked on the portal at arm, so a load that is not open reaches the desk only at close`);
    process.exit(1);
  }
  console.log(`PASS - ${results.length} checks: a never-listed load is checked on the portal at arm`);
})().catch((e) => { console.log(`FAIL - harness: ${e && e.stack}`); process.exit(1); });
