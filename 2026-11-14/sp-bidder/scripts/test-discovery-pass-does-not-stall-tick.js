'use strict';
/**
 * A DISCOVERY PASS MUST NOT STALL THE HOT TICKS.
 *
 * Regression target: the discovery-pass blind spot. When a portal listing returns, the discovery
 * poller walks every listed load on the same thread as every armed load's tick timer, and for as
 * long as the pass runs no hot monitor can tick. A monitor inside its last seconds loses its final
 * bid that way.
 *
 * The mechanism, in plain words. For every listed load the pass asks the price-request store whether
 * a request exists (getByLoad -> listAll), and on a portal with a declared extension step it also
 * refreshes the load's live close (refreshLiveClose -> getByToken). The file store behind those calls
 * re-reads and JSON-parses the WHOLE priceRequests collection on every one of them, and every write
 * re-reads it and rewrites the whole file pretty-printed. The pass then runs five sweeps, each another
 * whole-collection read. The store's promises settle without yielding to the event loop, so the pass
 * is one synchronous block from the moment the listing lands to the tick summary, and its length
 * scales with loads listed times collection size.
 *
 * Two scenarios, each a real BidEngine on its real timer holding one load in its hot window without
 * bidding, and a real DiscoveryPoller + PriceRequestStore + FileStore over a temp dir seeded with a
 * synthetic production-sized collection (~1,250 records, ~3.2 MB pretty-printed):
 *   gocomet - the portal declares a soft close with no ceiling and a 300s extension step, so the
 *             refresh runs. 15 listed loads: 14 with existing requests (awaiting and terminal), two
 *             of whose closes moved forward within one step, and 1 new load, so the create path runs.
 *             Two stored records are past the 7-day retention, so the prune removes them.
 *   sp      - closeModel 'unknown', so no refresh. 15 listed loads, all with existing requests.
 * The listing resolves through a macrotask LISTING_LANDS_MS after hot tick TRIGGER_TICK, late in the
 * cadence as a network response can land. None of the AFTER_TRIGGER_TICKS hot ticks that follow may
 * stall - ten ticks, not one, so moving the same work a tick later still fails.
 *
 * How a stall is judged. A stall is a hot tick that is BOTH late on the wall clock (more than
 * pollHotMs + SLACK_MS after the one before it) AND held back by this thread: in the stretch the tick
 * fell due in (from the last moment the thread was free to run a timer at or before the tick fell
 * due, pollHotMs after the tick before it, to the tick itself) the thread spent more than SLACK_MS of
 * its own CPU time. A marker timer every MARK_MS records the free moments. The defect runs the whole
 * pass as one synchronous block of 250-700ms of CPU, so a due tick waits behind all of it, and it is
 * both. A loaded machine that simply does not schedule the process makes a tick late while this
 * thread burns no CPU; that is the machine, not the store, and a wall-clock-only bound failed on it
 * at the fix (363ms beside 8 busy loops on 4 cores). The CPU a block costs is the same however loaded
 * the machine is. Two things the busy figure must not count, both measured at the fix beside the
 * same load:
 *   - time the process was descheduled in the middle of a step. Event-loop utilization counts it as
 *     busy (434ms "busy" in a 448ms gap that held 118ms of CPU), so the meter is CPU time.
 *   - work the pass does before a tick falls due. A pass that yields keeps the thread working while
 *     the next tick is not yet due (up to ~200ms of CPU in a 204ms gap), and that delays no tick.
 *     Only the stretch a tick fell due in holds it back.
 * The meter is process.threadCpuUsage where the runtime has it, else process.cpuUsage: the whole
 * process, which reads at least as high, so it can only err toward a stall. SLACK_MS is 150ms.
 *
 * Controls, all asserted: the CPU meter counts a METER_MS hold of the thread and not a METER_MS wait;
 * both scenarios on a tiny store (only the scenario's own records) do not stall on the current code,
 * so the stall is collection size and not discovery work; and hot ticks on the big store with no
 * pass running do not stall, so the harness is sound.
 *
 * WHAT MUST NOT MOVE:
 *   - the pass really does its work, checked after every run: the tick reports scanned 15 and the
 *     expected created / pruned / dropped / expired / closed / reminded counts, the two moved closes
 *     carry the new liveClosesAt, the new load has a request and requestPrice ran exactly once for
 *     it, the aged records are gone, and the monitored load never bid.
 *   - the notifier here settles without yielding, as a price-needed call that does no I/O does. A
 *     notifier that yields would hand the thread back mid-pass and hide the stall.
 *   - nothing here constrains HOW a fix keeps time (snapshot, cache, yielding, async I/O) or how busy
 *     the thread is between ticks; only that no tick is held back by the thread and discovery's
 *     results are unchanged.
 *
 * Offline: fake adapters, synthetic records only, temp stores under os.tmpdir() removed at the end.
 * The engine's timer is the unit under test, so it runs for real; nothing else sleeps. The marker
 * timer only reads the clock and the meter.
 *
 *   node scripts/test-discovery-pass-does-not-stall-tick.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp collection file), not app state
const path = require('path');
const assert = require('assert');
const { performance } = require('perf_hooks');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { FileStore } = require('../src/store/fileStore');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');

const EXPECTED_CHECKS = 10;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const SLACK_MS = 150;
const METER_MS = 150;
const METER_GUARD_MS = 10_000;
const MARK_MS = 5;
const FILLER_RECORDS = 1_234;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STEP_MS = 300_000;
const COST = 100_000;
const BAND = [9, 5, 1];
const OPEN_AT_MS = 8_000;
const WAIT_REMAINING_MS = 9_000;
const FAR_REMAINING_MS = 30 * 60 * 1000;
const TRIGGER_TICK = 3;
const AFTER_TRIGGER_TICKS = 10;
const LISTING_LANDS_MS = 170;
const RUN_GUARD_MS = 20_000;
const SCENARIOS = ['gocomet', 'sp'];

// The busy meter: this thread's CPU time in ms. process.threadCpuUsage is missing on older runtimes
// (Node 18 among them); there the whole process's CPU time stands in, which reads at least as high.
const THREAD_METER = (() => { try { process.threadCpuUsage(); return true; } catch (_) { return false; } })();
const METER_NAME = THREAD_METER ? 'thread CPU time' : 'process CPU time';
const cpuMs = () => { const u = THREAD_METER ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };

const DIRS = [];
const cleanup = () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };

const CITIES = [
  ['Palghar', 'Maharashtra', '401404'], ['Jaipur', 'Rajasthan', '302013'], ['Kakinada', 'Andhra Pradesh', '533003'],
  ['Chikhli', 'Gujarat', '396521'], ['Haridwar', 'Uttarakhand', '249403'], ['Kottayam', 'Kerala', '686122'],
  ['Neemrana', 'Rajasthan', '301705'], ['Hosur', 'Tamil Nadu', '635126'], ['Sanand', 'Gujarat', '382110'],
  ['Chakan', 'Maharashtra', '410501'], ['Bhiwadi', 'Rajasthan', '301019'], ['Sriperumbudur', 'Tamil Nadu', '602105'],
];
const SHIPPERS = ['Waaree Energies Ltd.', 'Havells India Ltd', 'Kingspan Jindal Pvt Ltd', 'Parijat Industries', 'KEI Industries'];
const EQUIPMENT = ['32 ft MXL', '20 ft SXL', '40 ft Trailer', '19 ft Open', '24 ft Container'];
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const tokenOf = (i) => { let s = ''; let n = i * 7919 + 104729; for (let k = 0; k < 11; k++) { s += B62[n % 62]; n = Math.floor(n / 62) + k * 13; } return s; };
const loadIdOf = (i, platformKey) => (platformKey === 'gocomet' ? `GCQ${String(i).padStart(6, '0')}X` : String(23_000_000 + i));

// Production mix: ~74% skipped_no_price, ~24% closed, ~2% awaiting_price, a handful armed.
function fillerStatus(i) {
  if (i % 250 === 7) return 'armed';
  if (i % 50 === 3) return 'awaiting_price';
  if (i % 4 === 1) return 'closed';
  return 'skipped_no_price';
}

function loadFields(i, platformKey, closesAt) {
  const [oc, os_, op] = CITIES[i % CITIES.length];
  const [dc, ds, dp] = CITIES[(i * 7 + 3) % CITIES.length];
  const shipper = SHIPPERS[i % SHIPPERS.length];
  const gc = platformKey === 'gocomet';
  const extraDrops = i % 13 === 0 ? 14 : i % 4 === 0 ? 11 : i % 6 === 0 ? 4 : 0;
  const points = [{ kind: 'pickup', address: `Plot ${100 + (i % 800)}, MIDC, ${oc}, ${os_} ${op}, India` }];
  for (let k = 0; k <= extraDrops; k++) points.push({ kind: 'drop', address: `${shipper} Depot ${(i + k) % 40}, ${dc}, ${ds} ${dp}, India` });
  const load = {
    lane: { origin: gc ? `${oc}, ${os_} ${op}` : oc, destination: gc ? `${dc}, ${ds} ${dp}` : dc },
    equipment: EQUIPMENT[i % EQUIPMENT.length],
    units: 1 + (i % 3),
    loadCode: gc ? null : `LD${880000 + i}`,
    shipperRef: gc ? `SR/2026/${String(i).padStart(5, '0')}` : null,
    weight: 9 + (i % 20),
    weightUnit: 'MT',
    distanceKm: gc ? null : 150 + (i % 1400),
    dimensions: gc ? "40'x8'x8\"" : null,
    points,
    laneParsed: gc ? { origin: { city: oc, state: os_, pincode: op }, destination: { city: dc, state: ds, pincode: dp } } : null,
    companyName: shipper,
    shipmentType: 'FTL',
    branchName: gc ? null : `${oc} Plant`,
    poster: i % 5 === 0 ? { name: `Dispatch Desk ${i % 12}`, mobile: `98${String(10000000 + i).slice(0, 8)}`, createdBy: `user${i % 30}` } : null,
    quoteType: gc ? null : 'FTL',
    loadTotalQuantity: 1 + (i % 3),
    cargoLines: 1,
    cargoTypes: i % 11 === 0 ? [{ label: '32 ft MXL', count: 1 }, { label: '20 ft SXL', count: 1 }] : null,
    closesAt,
    softClose: gc,
    closeModelKnown: true,
    status: 'live',
    productName: i % 4 ? 'Solar modules' : null,
    notes: i % 5 === 0 ? 'Vehicle must report by 09:00 with valid permits. Tarpaulin and ropes mandatory. Unloading at consignee cost.' : null,
    hasPortalComments: i % 6 === 0,
    hasPortalAttachments: i % 8 === 0,
    rules: gc || i % 2 ? null : { loadIsTransitTimeOn: i % 7 === 0, isMultipleVehicleAllowed: false, minDecrement: 100, rateType: 'FTL', vehicleCount: 1 + (i % 3) },
  };
  if (gc) Object.assign(load, { startsAt: closesAt - 4 * HOUR, ceiling: null, revisionLimit: null });
  else if (i % 2 === 0) Object.assign(load, { startsAt: closesAt - 2 * HOUR, ceiling: 40_000 + (i % 60) * 1_000, revisionLimit: 3 });
  return load;
}

function mkRecord(i, now, { platformKey = i % 3 === 2 ? 'gocomet' : 'sp', status = fillerStatus(i), closesAt } = {}) {
  const live = status === 'awaiting_price' || status === 'armed';
  const close = closesAt != null ? closesAt : (live ? now + 2 * HOUR + (i % 37) * 60_000 : now - HOUR - (i % 140) * HOUR);
  const shipper = SHIPPERS[i % SHIPPERS.length];
  const price = status === 'armed' || (status === 'closed' && i % 3 === 0) ? { cost: 30_000 + (i % 90) * 500 } : null;
  return {
    id: tokenOf(i),
    loadId: loadIdOf(i, platformKey),
    account: { accountId: 'primary', label: 'Primary' },
    platformKey,
    customer: { customerId: shipper.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''), label: shipper },
    load: loadFields(i, platformKey, close),
    marginsPct: BAND.slice(),
    minMarginPct: 1,
    marginSource: 'default',
    marginOverride: null,
    status,
    createdAt: close - 5 * HOUR,
    deadlineAt: close - 35_000,
    price,
    capturedAt: price ? close - 3 * HOUR : null,
    notified: true,
    notifiedAt: close - 5 * HOUR + 2_000,
    reminderSentAt: live ? null : close - 400_000,
  };
}

// The listed load as the adapter reports it: the stored snapshot's fields plus the portal's close.
function listed(rec, closesAt) {
  return Object.assign({}, rec.load, { id: rec.loadId, closesAt, closeModel: rec.platformKey === 'gocomet' ? 'soft' : 'hard' });
}

// Each scenario's own records carry indices from 100_000 up so they never collide with the filler.
function buildScenario(kind, now) {
  const own = [];
  const listing = [];
  const moved = [];
  const aged = [];
  let newLoad = null;
  if (kind === 'gocomet') {
    const mix = ['awaiting_price', 'awaiting_price', 'awaiting_price', 'awaiting_price', 'awaiting_price', 'awaiting_price',
      'skipped_no_price', 'skipped_no_price', 'skipped_no_price', 'skipped_no_price', 'skipped_no_price',
      'closed', 'closed', 'closed'];
    mix.forEach((status, k) => {
      const rec = mkRecord(100_000 + k, now, { platformKey: 'gocomet', status });
      own.push(rec);
      if (k < 2) {
        const liveClose = rec.load.closesAt + 120_000;
        moved.push({ id: rec.id, liveClosesAt: liveClose });
        listing.push(listed(rec, liveClose));
      } else {
        listing.push(listed(rec, status === 'awaiting_price' ? rec.load.closesAt : now + 3 * HOUR));
      }
    });
    newLoad = listed(mkRecord(100_050, now, { platformKey: 'gocomet', status: 'awaiting_price' }), now + 4 * HOUR);
    listing.splice(7, 0, newLoad);
    for (let k = 0; k < 2; k++) {
      const rec = mkRecord(100_060 + k, now, { platformKey: k ? 'sp' : 'gocomet', status: 'closed', closesAt: now - 8 * DAY - k * HOUR });
      own.push(rec);
      aged.push(rec.id);
    }
  } else {
    const mix = ['awaiting_price', 'awaiting_price', 'awaiting_price', 'awaiting_price', 'awaiting_price', 'armed',
      'skipped_no_price', 'skipped_no_price', 'skipped_no_price', 'skipped_no_price', 'skipped_no_price', 'skipped_no_price',
      'closed', 'closed', 'closed'];
    mix.forEach((status, k) => {
      const rec = mkRecord(100_100 + k, now, { platformKey: 'sp', status });
      own.push(rec);
      listing.push(listed(rec, status === 'awaiting_price' || status === 'armed' ? rec.load.closesAt : now + 3 * HOUR));
    });
  }
  const expected = kind === 'gocomet'
    ? { scanned: 15, created: 1, pruned: 2, dropped: 0, expired: 0, closed: 0, reminded: 0 }
    : { scanned: 15, created: 0, pruned: 0, dropped: 0, expired: 0, closed: 0, reminded: 0 };
  return { own, listing, moved, aged, newLoad, expected };
}

function seedStore(kind, big) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `discovery-stall-${kind}-`));
  DIRS.push(dir);
  const now = Date.now();
  const scenario = buildScenario(kind, now);
  const map = {};
  if (big) for (let i = 0; i < FILLER_RECORDS; i++) { const r = mkRecord(i, now); map[r.id] = r; }
  for (const r of scenario.own) map[r.id] = r;
  const body = JSON.stringify(map, null, 2);
  fs.writeFileSync(path.join(dir, COLLECTION + '.json'), body);
  return { dir, bytes: Buffer.byteLength(body), records: Object.keys(map).length, scenario };
}

const mkEngineLoad = (id, remainingMs) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: '32 ft MXL',
  units: 1, companyName: 'Waaree Energies Ltd.', closesAt: Date.now() + remainingMs, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });

// Load A is the monitor whose ticks are timed: the engine adapter holds it above the establish mark
// so it never bids. At A's tick TRIGGER_TICK the test starts one discovery pass; the portal listing
// lands LISTING_LANDS_MS later on a timer, the way a network response arrives.
async function runScenario(kind, big) {
  const seeded = seedStore(kind, big);
  const { dir, scenario } = seeded;
  const idA = `${kind.toUpperCase()}_A`;
  const ticks = [];
  const cpuAt = [];
  const marks = [];
  const placed = [];
  const priceAsks = [];
  const want = TRIGGER_TICK + AFTER_TRIGGER_TICKS;
  let passPromise = null;
  let landedAt = null;
  let passEndedAt = null;
  let onDone = null;

  const caps = kind === 'gocomet'
    ? { closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: STEP_MS }
    : { closeModel: 'unknown' };
  const portal = {
    capabilities: () => caps,
    listAuctions: () => new Promise((resolve) => setTimeout(() => { landedAt = performance.now(); resolve(scenario.listing); }, LISTING_LANDS_MS)),
  };
  const notifier = {
    requestPrice: async (req) => { priceAsks.push(req.loadId); return { delivered: true }; },
    remindApproaching: async () => ({ delivered: true }),
    alert: async () => ({ delivered: true }),
  };
  const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
  const requests = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 1, platformKey: 'sp' });
  const poller = new DiscoveryPoller({
    adapter: portal, requests, notifier, platformKey: kind,
    config: { allowlist: { shippers: SHIPPERS.slice() }, priceDeadlineLeadMs: 35_000, reminderLeadMs: 300_000 },
  });

  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async (auctionId) => {
      if (String(auctionId) !== idA) {
        return { ok: true, status: 'live', myRank: null, totalBidders: 0, standingL1Price: null,
          closesInMs: FAR_REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
      }
      ticks.push(performance.now());
      cpuAt.push(cpuMs());
      const n = ticks.length;
      if (n === TRIGGER_TICK) passPromise = poller.tick().then((r) => { passEndedAt = performance.now(); return r; });
      if (n >= want && onDone) { const d = onDone; onDone = null; d(); }
      return { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: WAIT_REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
    },
    placeBid: async (auctionId, price) => { placed.push({ auctionId: String(auctionId), price }); return { accepted: true, myRank: 1, latencyMs: 30 }; },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(path.join(dir, `intents-${kind}.json`)), {
    config: { openAtMs: OPEN_AT_MS, openJitterMs: 0 },
    onEvent: () => {},
  });

  // The marker runs whenever the thread is free to run a due timer and records the clock and the
  // meter there, so the stretch a tick fell due in starts at the last free moment before it fell due.
  let marker = null;
  const mark = () => { marks.push({ t: performance.now(), cpu: cpuMs() }); marker = setTimeout(mark, MARK_MS); };

  let guard;
  const reached = new Promise((resolve, reject) => {
    onDone = resolve;
    guard = setTimeout(() => reject(new Error(`harness: ${kind} reached only ${ticks.length} of ${want} ticks in ${RUN_GUARD_MS}ms`)), RUN_GUARD_MS);
  });
  mark();
  engine.arm(mkEngineLoad(idA, WAIT_REMAINING_MS), { cost: COST, marginsPct: BAND, minMarginPct: 1 });
  try {
    await reached;
  } finally {
    clearTimeout(guard);
    clearTimeout(marker);
    engine.kill('test done');
  }
  const result = await passPromise;

  const after = {};
  for (const r of await new FileStore({ dataDir: dir }).listDocs(COLLECTION)) after[r.id] = r;
  // Interval i ends at hot tick i, which fell due pollHotMs after tick i-1. `held` is the CPU the
  // thread spent in the stretch tick i fell due in: from the last free moment at or before it fell
  // due (tick i-1 itself if no mark ran) to tick i.
  const pollHotMs = engine.cfg.pollHotMs;
  const interval = (i, at) => {
    const due = ticks[i - 1] + pollHotMs;
    let from = { t: ticks[i - 1], cpu: cpuAt[i - 1] };
    for (const m of marks) { if (m.t > due) break; if (m.t >= ticks[i - 1]) from = m; }
    return { at, gap: ticks[i] - ticks[i - 1], held: cpuAt[i] - from.cpu };
  };
  const t = TRIGGER_TICK - 1;
  const intervals = [];
  for (let i = t + 1; i < want; i++) intervals.push(interval(i, i - t));
  const noPass = [];
  for (let i = 1; i < TRIGGER_TICK; i++) noPass.push(interval(i, i));
  return {
    kind, big, seeded, result, after, priceAsks, placed, pollHotMs,
    noPass, intervals, marks: marks.length,
    landedMs: landedAt - ticks[t], passMs: passEndedAt - landedAt,
  };
}

function assertPassDidItsWork(r, label) {
  const { scenario, records } = r.seeded;
  for (const [k, v] of Object.entries(scenario.expected)) {
    assert.strictEqual(r.result && r.result[k], v, `${label} ${r.kind}: the tick reports ${k} ${v} (got ${JSON.stringify(r.result)})`);
  }
  assert.deepStrictEqual(r.placed, [], `${label} ${r.kind}: the monitored load never bid`);
  const byLoad = (loadId) => Object.values(r.after).filter((x) => String(x.loadId) === String(loadId));
  if (r.kind === 'gocomet') {
    for (const m of scenario.moved) {
      const rec = r.after[m.id];
      assert.strictEqual(rec && rec.load && rec.load.liveClosesAt, m.liveClosesAt, `${label} gocomet: record ${m.id} carries the refreshed liveClosesAt`);
    }
    const made = byLoad(scenario.newLoad.id);
    assert.strictEqual(made.length, 1, `${label} gocomet: exactly one request exists for the new load ${scenario.newLoad.id}`);
    assert.strictEqual(made[0].status, 'awaiting_price', `${label} gocomet: the new request awaits a price`);
    assert.strictEqual(made[0].notified, true, `${label} gocomet: the new request is marked notified`);
    assert.deepStrictEqual(r.priceAsks, [scenario.newLoad.id], `${label} gocomet: requestPrice ran exactly once, for the new load`);
    for (const id of scenario.aged) assert.ok(!r.after[id], `${label} gocomet: aged record ${id} was pruned`);
    assert.strictEqual(Object.keys(r.after).length, records + 1 - scenario.aged.length, `${label} gocomet: the collection holds every other record`);
  } else {
    assert.deepStrictEqual(r.priceAsks, [], `${label} sp: no price was asked`);
    assert.strictEqual(Object.keys(r.after).length, records, `${label} sp: the collection is unchanged in size`);
    for (const l of scenario.listing) assert.strictEqual(byLoad(l.id).length, 1, `${label} sp: listed load ${l.id} still has exactly one request`);
  }
}

const fmt = (ms) => '[' + ms.map((g) => g.toFixed(0)).join(', ') + ']';
const show = (label, r) => console.log(`  ${label} ${r.kind}: ${r.seeded.records} records, ${r.seeded.bytes} bytes; no-pass gaps ${fmt(r.noPass.map((s) => s.gap))}ms `
  + `(busy ${fmt(r.noPass.map((s) => s.held))}ms); listing landed +${r.landedMs.toFixed(0)}ms after tick ${TRIGGER_TICK}, pass took ${r.passMs.toFixed(0)}ms; `
  + `gaps after the trigger ${fmt(r.intervals.map((s) => s.gap))}ms, thread busy in the stretch each fell due in ${fmt(r.intervals.map((s) => s.held))}ms (${r.marks} marks)`);

const isStall = (s, bound) => s.gap > bound && s.held > SLACK_MS;
const stallsOf = (list, bound) => list.filter((s) => isStall(s, bound));
const said = (s) => `hot tick ${s.at} after the trigger came ${s.gap.toFixed(1)}ms after the one before it, the thread busy for ${s.held.toFixed(1)}ms of CPU in the stretch it fell due in`;

// A METER_MS wait must read under a third of that, and a hold of the thread must reach METER_MS of
// CPU without reading it in under half that on the wall clock (the process-wide stand-in also counts
// other threads, such as the compiler's, while the hold runs), or the meter is not counting this
// thread's work and no interval can be judged. The hold spins until the meter reads METER_MS, so a
// loaded machine only makes it take longer.
async function meterReads() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(10);
  const a = cpuMs();
  await wait(METER_MS);
  const b = cpuMs();
  const t = performance.now();
  let c = b;
  while (c - b < METER_MS && performance.now() - t < METER_GUARD_MS) c = cpuMs();
  return { wait: b - a, hold: c - b, holdWall: performance.now() - t };
}

(async () => {
  const t0 = Date.now();

  const meter = await meterReads();
  const tiny = {};
  for (const k of SCENARIOS) tiny[k] = await runScenario(k, false);
  assert.strictEqual(tiny.gocomet.pollHotMs, 200, 'precondition: the engine hot cadence is 200ms');
  const BOUND_MS = tiny.gocomet.pollHotMs + SLACK_MS;
  console.log(`  busy meter (${METER_NAME}): a ${METER_MS}ms wait read ${meter.wait.toFixed(1)}ms, a hold read ${meter.hold.toFixed(1)}ms over ${meter.holdWall.toFixed(1)}ms of wall time`);
  assert.ok(meter.hold >= METER_MS && meter.holdWall >= METER_MS / 2 && meter.wait <= METER_MS / 3,
    `precondition: the busy meter must count a ${METER_MS}ms hold of the thread (read ${meter.hold.toFixed(1)}ms over ${meter.holdWall.toFixed(1)}ms of wall time) and not a ${METER_MS}ms wait (read ${meter.wait.toFixed(1)}ms), or no interval can be judged`);
  console.log(`  a stall is a gap over ${BOUND_MS}ms with the thread busy over ${SLACK_MS}ms of CPU in the stretch the tick fell due in`);
  for (const k of SCENARIOS) show('tiny', tiny[k]);
  ok(`1. hot cadence is pollHotMs = 200ms; bound ${BOUND_MS}ms; the busy meter counts a hold of the thread, not a wait`);

  assertPassDidItsWork(tiny.gocomet, 'tiny');
  ok('2. tiny gocomet: the pass refreshed two closes, created and asked for one new load, pruned two aged records');
  assertPassDidItsWork(tiny.sp, 'tiny');
  ok('3. tiny sp: the pass scanned 15 existing loads and changed nothing');

  for (const k of SCENARIOS) {
    const s = stallsOf(tiny[k].intervals, BOUND_MS);
    if (s.length) assert.fail(`control: tiny store ${k} - ${said(s[0])} - discovery work alone stalls the ticks, so this harness cannot judge the collection size`);
  }
  ok('4. control: on a tiny store no hot tick through and after each pass stalls');

  const big = {};
  for (const k of SCENARIOS) big[k] = await runScenario(k, true);
  for (const k of SCENARIOS) show('big', big[k]);
  for (const k of SCENARIOS) {
    const { records, bytes } = big[k].seeded;
    assert.ok(records >= 1_200 && records <= 1_300 && bytes >= 3_000_000 && bytes <= 3_500_000,
      `precondition: big ${k} store is production-sized (${records} records, ${bytes} bytes)`);
  }
  ok('5. the synthetic price-request collection is production-sized (~1,250 records, ~3.2 MB pretty-printed)');

  assertPassDidItsWork(big.gocomet, 'big');
  ok('6. big gocomet: the pass refreshed two closes, created and asked for one new load, pruned two aged records');
  assertPassDidItsWork(big.sp, 'big');
  ok('7. big sp: the pass scanned 15 existing loads and changed nothing');

  for (const k of SCENARIOS) {
    const s = stallsOf(big[k].noPass, BOUND_MS);
    if (s.length) assert.fail(`control: big store ${k} - two hot ticks with no pass running came ${s[0].gap.toFixed(1)}ms apart with the thread busy for ${s[0].held.toFixed(1)}ms of CPU in the stretch the later one fell due in - the harness itself stalls the ticks`);
  }
  ok('8. control: on the big store hot ticks with no pass running do not stall');

  const stalled = [];
  SCENARIOS.forEach((k, i) => {
    const r = big[k];
    const s = stallsOf(r.intervals, BOUND_MS);
    if (!s.length) { ok(`${9 + i}. ${k}: no hot tick through and after a discovery pass stalls against a production-sized price-request collection`); return; }
    const w = s.reduce((m, x) => (x.held > m.held ? x : m));
    stalled.push(`${k} - ${said(w)} (the pass took ${r.passMs.toFixed(0)}ms from +${r.landedMs.toFixed(0)}ms)`);
  });
  if (stalled.length) {
    throw new assert.AssertionError({ message: `${stalled.length} of ${SCENARIOS.length} scenarios stalled (a hot tick over ${BOUND_MS}ms = pollHotMs + ${SLACK_MS} after the one before it, with the thread busy over ${SLACK_MS}ms of CPU in the stretch it fell due in): ${stalled.join('; ')}. `
      + 'The discovery pass re-reads and re-parses the whole price-request collection for every listed load on the tick thread '
      + '(getByLoad, refreshLiveClose, each write and each sweep), without yielding, so every hot monitor goes blind until the pass ends' });
  }

  assert.strictEqual(pass, EXPECTED_CHECKS, `ran ${pass} of ${EXPECTED_CHECKS} checks`);
  console.log(`\nPASS test-discovery-pass-does-not-stall-tick: ${pass}/${EXPECTED_CHECKS} checks (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  cleanup();
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL test-discovery-pass-does-not-stall-tick (check ${pass + 1}): ${e && e.message}`);
  process.exit(1);
});
