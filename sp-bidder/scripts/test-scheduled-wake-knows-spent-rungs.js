'use strict';
/**
 * A MONITOR ARMED BY THE SCHEDULED WAKE MUST KNOW WHICH RUNGS ARE ALREADY SPENT.
 *
 * Regression target: T2 D9 (the order gate behind T2 D5).
 *
 * arm() writes the spent-rung array to the durable intent (remapFiredRungs, by price) but hands
 * back a monitor built with `firedRungs: new Set()` and `currentRungIndex: -1` - a monitor that
 * believes nothing has been bid. Two of its callers repair that straight after the call:
 * rehydrate() ("READ THE RUNGS BACK OFF THE INTENT arm() JUST REWROTE") and armFromRequest's live
 * branch ("never re-fires a paid rung"). The third caller, the scheduled wake in _planWake, does
 * not. A blind monitor on a load that has already bid establishes again: it walks past its own
 * standing price and offers the next rung down, a real re-bid against our own price.
 *
 * It stayed dormant only because schedule() wiped the durable array (T2 D5), so a 'scheduled'
 * intent never carried spend. Fixing D5 by routing a spent record into arm() keeps the spend on
 * disk and still re-bids, because the monitor arm() returns is blind. Check 3 is that composed
 * route and stays red until BOTH are fixed.
 *
 * The contract: every path that hands back a live monitor hands back one whose spent set agrees
 * with the durable record - set(monitor.firedRungs) == set(intent.firedRungs), and
 * monitor.currentRungIndex == max(intent.firedRungs) when that array is non-empty.
 *
 * WHAT MUST NOT MOVE:
 *   - rehydrate() of a 'bidding' intent already restores the spent rungs (check 4).
 *   - armFromRequest re-arming a stopped live load already restores them (check 5).
 *   - every wake check first requires the load to be ARMED. A wake that stands down leaves no
 *     monitor and puts nothing on the wire, which would read as a pass on a wire-only check while
 *     the live load goes unwatched.
 *
 * The durable record's status after a re-price belongs to the T2 D5 regression file, not here.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, in-memory price-request store, no
 * network. _planWake's setTimeout is the unit under test, so waits are short real polls with a
 * hard cap.
 *
 *   node scripts/test-scheduled-wake-knows-spent-rungs.js
 */
process.env.LOG_LEVEL = 'silent';
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, pollMidMs: 100 };
const BAND = [12, 10, 8, 7, 6.3];
const NEW_BAND = [12, 9, 6.3]; // same top margin, so the spent opening price is on the new ladder too
const COST = 45_000;
const INPUTS = { cost: COST, marginsPct: BAND, minMarginPct: 6.3 };
const FAR_MS = 45_000;   // outside the establish mark: a blind monitor has no reason to bid yet
const MID_MS = 12_000;   // inside the establish mark, outside the floor window

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `wake-knows-spend-${process.pid}-`));
let seq = 0;
const tmp = () => path.join(DIR, `intents-${seq++}.json`);
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill('test-cleanup'); } catch (_) {} }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, capMs) {
  const end = Date.now() + capMs;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}

// `rank` decides what the platform reports; `reads` counts ticks so waits can be tick-bounded.
function mockAdapter({ closesInMs, rank }) {
  const a = {
    writeEnabled: true, placed: [], reads: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      a.reads++;
      return { ok: true, status: 'live', myRank: rank(a), totalBidders: 3, standingL1Price: null,
        closesInMs, revisionLimit: 3, revisionsLeft: null, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) {
      if (!a.writeEnabled) throw new Error('write disabled');
      a.placed.push(price);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
  return a;
}
const holdingL1 = () => 1;
const outrankedUntilWeBid = (a) => (a.placed.length ? 1 : 2);

function newEngine(adapter, file) {
  const e = new BidEngine(adapter, new DurableScheduler(file), { config: CFG, live: true });
  ENGINES.push(e);
  return e;
}
const newRequests = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: BAND, minMarginPct: 6.3 });

const mkMeta = (id, startsAt, closesAt) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' },
  equipment: 'SXL', units: 1, companyName: 'Durian Industries', startsAt, closesAt });

// A durable intent that has already landed rung 0, written as the given status by a first engine,
// then read back by a fresh engine over the same file (the restart shape). The ladder comes from
// schedule() itself so the next arm rebuilds it index-for-index.
function spentIntentFile(id, status, startsAt) {
  const file = tmp();
  const e0 = newEngine(mockAdapter({ closesInMs: FAR_MS, rank: holdingL1 }), file);
  e0.schedule(mkMeta(id, Date.now() + 3_600_000, Date.now() + 7_200_000), INPUTS);
  const ladder = e0.scheduler.get(id).ladder;
  e0.scheduler.update(id, { status, firedRungs: [0], everBid: true, landedBids: 1, landedBidPrice: ladder[0],
    startsAt, closesAt: Date.now() + 60_000 });
  e0.kill('fixture-written');
  return { file, ladder };
}

// null when the monitor agrees with the durable record, otherwise the disagreement in words.
function disagreement(m, it) {
  const mon = [...m.firedRungs].sort((x, y) => x - y);
  const dur = [...(it.firedRungs || [])].sort((x, y) => x - y);
  const cri = dur.length ? Math.max(...dur) : -1;
  if (JSON.stringify(mon) === JSON.stringify(dur) && m.currentRungIndex === cri) return null;
  return `monitor.firedRungs ${JSON.stringify(mon)} / currentRungIndex ${m.currentRungIndex}, `
    + `durable firedRungs ${JSON.stringify(dur)} (expected currentRungIndex ${cri})`;
}

let pass = 0;
const failures = [];
function check(n, name, fn) {
  try { fn(); console.log(`  ok  ${n}. ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${n}. ${name}\n       ${e.message}`); failures.push(n); }
}

(async () => {
  // ---------------------------------------------- 1. scheduled wake: monitor agrees with the record
  {
    const { file } = spentIntentFile('D9-WAKE', 'scheduled', Date.now() - 1_000);
    const eng = newEngine(mockAdapter({ closesInMs: FAR_MS, rank: holdingL1 }), file);
    await eng.rehydrate();
    const armed = await until(() => eng.monitors.has('D9-WAKE'), 2_000);
    const m = eng.monitors.get('D9-WAKE');
    const it = eng.scheduler.get('D9-WAKE');
    check(1, 'the monitor a scheduled wake arms knows the rungs the durable record says are spent', () => {
      assert.ok(armed, `the scheduled wake never armed the load: durable status '${it && it.status}'`);
      assert.ok((it.firedRungs || []).includes(0),
        `the durable record lost the spent rung 0 at the wake: firedRungs ${JSON.stringify(it.firedRungs)}`);
      const d = disagreement(m, it);
      assert.ok(d === null, `the scheduled wake armed a monitor that disagrees with the durable record: ${d} `
        + '- arm() builds the monitor with an empty spent set and the wake never reads the rungs back');
    });
    eng.kill('test-done');
  }

  // ---------------------------------------------- 2. scheduled wake: no spent price goes back on the wire
  {
    const { file, ladder } = spentIntentFile('D9-WIRE', 'scheduled', Date.now() - 1_000);
    const adapter = mockAdapter({ closesInMs: MID_MS, rank: holdingL1 });
    const eng = newEngine(adapter, file);
    await eng.rehydrate();
    const armed = await until(() => eng.monitors.has('D9-WIRE'), 2_000);
    const readsAtArm = adapter.reads;
    const ticked = await until(() => adapter.reads >= readsAtArm + 4, 3_000);
    const it = eng.scheduler.get('D9-WIRE');
    check(2, 'a load already holding rank 1 at its own price puts nothing on the wire after the wake', () => {
      assert.ok(armed, `the scheduled wake never armed the load: durable status '${it && it.status}'`);
      assert.ok(ticked, `the armed monitor did not tick: ${adapter.reads - readsAtArm} reads after arm`);
      assert.deepStrictEqual(adapter.placed, [],
        `the wake-armed monitor re-bid a load that already stands at rank 1 on ${ladder[0]}: `
        + `placed ${JSON.stringify(adapter.placed)} on ladder ${JSON.stringify(ladder)} - it believed nothing `
        + 'was spent and established again');
      assert.ok((it.firedRungs || []).includes(0),
        `the spent rung 0 (${ladder[0]}) was erased from the durable record: firedRungs ${JSON.stringify(it.firedRungs)}`);
    });
    eng.kill('test-done');
  }

  // ---------------------------------------------- 3. the order gate: re-price routed through schedule()
  {
    // reArmWithNewBand's composition (stop + armFromRequest) on a load whose frozen snapshot still
    // reads "starts later", so the re-price reaches schedule() and the load is re-armed by the wake.
    const adapter = mockAdapter({ closesInMs: MID_MS, rank: outrankedUntilWeBid });
    const eng = newEngine(adapter, tmp());
    const requests = newRequests();
    const load = { id: 'D9-REPRICE', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      companyName: 'Durian Industries', closesAt: Date.now() + 60_000,
      startsAt: Date.now() + eng.cfg.armLeadMs + 300, status: 'upcoming', softClose: false };
    const created = await requests.createForLoad(load, { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: COST });
    armFromRequest(eng, capt, { requests });
    const spent = await until(() => {
      const it = eng.scheduler.get('D9-REPRICE');
      return !!(it && Array.isArray(it.firedRungs) && it.firedRungs.includes(0) && adapter.placed.length === 1);
    }, 4_000);
    assert.ok(spent, `setup: rung 0 never landed; record=${JSON.stringify(eng.scheduler.get('D9-REPRICE'))} placed=${JSON.stringify(adapter.placed)}`);
    const before = JSON.parse(JSON.stringify(eng.scheduler.get('D9-REPRICE')));
    const wireBefore = adapter.placed.slice();
    const spentPrices = before.firedRungs.map((i) => before.ladder[i]);
    assert.deepStrictEqual(wireBefore, spentPrices, 'setup: the wire and the durable spend must agree before the re-price');
    assert.ok(Date.now() < capt.load.startsAt, 'setup: the frozen snapshot must still read "starts later" at re-price time');

    const updated = await requests.setBidOverride(created.id, { marginsPct: NEW_BAND, minMarginPct: 6.3 }, { setBy: 'operator' });
    eng.stop('D9-REPRICE');
    armFromRequest(eng, updated, { requests });

    const armed = await until(() => eng.monitors.has('D9-REPRICE'), 2_000);
    const m = eng.monitors.get('D9-REPRICE');
    const knownPrices = m ? [...m.firedRungs].map((i) => m.ladder[i]) : null;
    const readsAtArm = adapter.reads;
    const ticked = await until(() => adapter.reads >= readsAtArm + 4, 3_000);
    check(3, 'a re-price routed through schedule() re-arms a monitor that knows the spent price and re-bids nothing', () => {
      assert.ok(armed, 'the re-priced load was never re-armed: monitors.has=false, durable status '
        + `'${(eng.scheduler.get('D9-REPRICE') || {}).status}' - a load that has bid is left unwatched`);
      assert.ok(m.ladder.includes(spentPrices[0]),
        `setup: the re-priced ladder ${JSON.stringify(m.ladder)} must still carry the spent price ${spentPrices[0]}`);
      assert.ok(spentPrices.every((p) => knownPrices.includes(p)),
        `the re-armed monitor does not know the spent price(s) ${JSON.stringify(spentPrices)}: it believes `
        + `${JSON.stringify(knownPrices)} spent on ladder ${JSON.stringify(m.ladder)} (durable firedRungs `
        + `${JSON.stringify(eng.scheduler.get('D9-REPRICE').firedRungs)})`);
      assert.ok(ticked, `the re-armed monitor did not tick: ${adapter.reads - readsAtArm} reads after arm`);
      assert.deepStrictEqual(adapter.placed, wireBefore,
        `the re-price put a new bid on the wire against our own standing ${wireBefore[wireBefore.length - 1]}: `
        + `wire ${JSON.stringify(wireBefore)} -> ${JSON.stringify(adapter.placed)}`);
    });
    eng.kill('test-done');
  }

  // ---------------------------------------------- 4. control: rehydrate() of a bidding intent
  {
    const { file } = spentIntentFile('D9-REHYDRATE', 'bidding', Date.now() - 60_000);
    const eng = newEngine(mockAdapter({ closesInMs: FAR_MS, rank: holdingL1 }), file);
    await eng.rehydrate();
    const m = eng.monitors.get('D9-REHYDRATE');
    const it = eng.scheduler.get('D9-REHYDRATE');
    check(4, 'control: rehydrate() of a bidding intent hands back a monitor that agrees with the record', () => {
      assert.ok(m, 'rehydrate() did not arm the bidding intent');
      assert.ok((it.firedRungs || []).includes(0), `fixture: firedRungs ${JSON.stringify(it.firedRungs)}`);
      const d = disagreement(m, it);
      assert.ok(d === null, `rehydrate() restore disagrees: ${d}`);
    });
    eng.kill('test-done');
  }

  // ---------------------------------------------- 5. control: armFromRequest live re-arm of a stopped load
  {
    const eng = newEngine(mockAdapter({ closesInMs: FAR_MS, rank: holdingL1 }), tmp());
    const requests = newRequests();
    const load = { id: 'D9-LIVE', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      companyName: 'Durian Industries', closesAt: Date.now() + 60_000, startsAt: Date.now() - 1_000,
      status: 'live', softClose: false };
    const created = await requests.createForLoad(load, { deadlineAt: Date.now() + 60_000 });
    const capt = await requests.capture(created.id, { cost: COST });
    const m1 = armFromRequest(eng, capt, { requests });
    eng.scheduler.update('D9-LIVE', { status: 'bidding', firedRungs: [0], everBid: true, landedBids: 1,
      landedBidPrice: m1.ladder[0] });
    eng.stop('D9-LIVE');
    const m = armFromRequest(eng, capt, { requests });
    const it = eng.scheduler.get('D9-LIVE');
    check(5, 'control: armFromRequest re-arming a stopped live load hands back a monitor that agrees with the record', () => {
      assert.ok(m && eng.monitors.get('D9-LIVE') === m, 'armFromRequest did not re-arm the live load');
      assert.ok((it.firedRungs || []).includes(0), `fixture: firedRungs ${JSON.stringify(it.firedRungs)}`);
      const d = disagreement(m, it);
      assert.ok(d === null, `armFromRequest restore disagrees: ${d}`);
    });
    eng.kill('test-done');
  }

  cleanup();
  const EXPECTED = 5;
  if (failures.length) {
    console.error(`\nFAILED checks ${failures.join(', ')} of ${EXPECTED}: the scheduled wake arms a monitor that `
      + 'believes nothing is spent while the durable record says rungs landed (arm() builds an empty spent set '
      + 'and the wake never reads the rungs back), so it re-bids against our own standing price');
    process.exit(1);
  }
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\nPASS ${pass}/${EXPECTED} checks`);
  process.exit(0);
})().catch((e) => { console.error('\nHARNESS ERROR:', e && e.stack || e); cleanup(); process.exit(1); });
