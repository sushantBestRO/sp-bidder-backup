'use strict';
/**
 * Offline check for the kill-switch (gap A3). No token, no network. The engine
 * ALWAYS places real bids; there is no dry-run/go-live mode. This exercises the
 * hard stop and its lift:
 *   A. kill() before the first tick -> zero bids ever (deterministic halt).
 *   B. kill() mid-auction -> bids freeze; nothing fires after the kill.
 *   C. the adapter write backstop tracks kill/resume (kill lowers it, resume lifts it).
 *   D. kill while LIVE -> resume restores live bidding with the real ladder state
 *      intact (no re-firing of a rung that already spent real money).
 *
 *   node scripts/test-kill-switch.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const BAND = [12.6, 7.2, 6.3];
const band = (cost) => buildBandLadder({ cost, marginsPct: BAND }).ladder;
// A per-run directory, not a pid-named file in the shared tmpdir: Windows reuses pids, and an
// intent file left by an aborted run is rehydrated by arm(), so E's monitor would start with that
// run's landed bid already counted.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-'));
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const tmp = (tag) => path.join(TMP_DIR, `${tag}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// hard-close adapter that holds us at rank 2 (forces escalation) and GATES writes
// like the real adapter (placeBid throws unless writeEnabled). The engine lifts
// writeEnabled on construction; kill lowers it.
function gatedAdapter(closesAt) {
  let revs = 3;
  return {
    placed: [], writeEnabled: false,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 3,
        standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: revs,
        closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) {
      if (!this.writeEnabled) { const e = new Error('write_disabled'); e.code = 'WRITE_DISABLED'; throw e; }
      this.placed.push(price); revs = Math.max(0, revs - 1);
      return { accepted: true, myRank: 2, revisionsLeft: revs, latencyMs: 60 };
    },
  };
}

// controllable-countdown variant for the deterministic manual-tick section (D).
function gatedCtrlAdapter() {
  let closesInMs = 12_000;
  let revs = 3;
  return {
    placed: [], writeEnabled: false,
    setClose: (ms) => { closesInMs = ms; },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: closesInMs <= 0 ? 'closed' : 'live', myRank: 2, totalBidders: 3,
        standingL1Price: null, closesInMs, revisionsLeft: revs, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) {
      if (!this.writeEnabled) { const e = new Error('write_disabled'); e.code = 'WRITE_DISABLED'; throw e; }
      this.placed.push(price); revs = Math.max(0, revs - 1);
      return { accepted: true, myRank: 2, revisionsLeft: revs, latencyMs: 60 };
    },
  };
}

const armMeta = (closesAt) => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt });
const CFG = { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0 };

(async () => {
  // ---- A. kill before the first tick -> zero bids ever ----
  {
    const f = tmp('killpre'); const closesAt = Date.now() + 6_000;
    const adapter = gatedAdapter(closesAt);
    // engine boots live (no `live:` option) - it would bid for real without the kill.
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG });
    assert.strictEqual(adapter.writeEnabled, true, 'engine boots live: write backstop lifted');
    engine.arm(armMeta(closesAt), { cost: 50_000, marginsPct: BAND });
    engine.kill('panic'); // synchronous, before the setTimeout(0) tick runs
    await sleep(7_500);
    assert.strictEqual(adapter.placed.length, 0, 'kill before first tick -> no bid ever fired');
    assert.strictEqual(adapter.writeEnabled, false, 'kill lowered the write backstop');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('kill() before first tick: deterministic full halt');
  }

  // ---- B. kill mid-auction -> bids freeze ----
  {
    const f = tmp('killmid'); const closesAt = Date.now() + 8_000;
    const adapter = gatedAdapter(closesAt);
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG });
    engine.arm(armMeta(closesAt), { cost: 50_000, marginsPct: BAND });
    // wait for the establishing real bid, then kill mid-flight
    while (adapter.placed.length < 1) await sleep(50);
    engine.kill('mid');
    await sleep(400);                 // let any in-flight bid settle
    const frozen = adapter.placed.length;
    await sleep(5_000);              // through the rest of the auction (MED/LOW would have been due)
    assert.strictEqual(adapter.placed.length, frozen, 'no bid fired after the kill');
    assert.ok(frozen < band(50_000).length, 'killed before the full ladder spent');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('kill() mid-auction: escalation frozen, no further bids');
  }

  // ---- C. write backstop tracks kill / resume ----
  {
    const adapter = gatedAdapter(Date.now() + 60_000);
    const engine = new BidEngine(adapter, new DurableScheduler(tmp('gate')), { config: CFG });
    assert.strictEqual(adapter.writeEnabled, true, 'boots live: backstop up');
    engine.kill();   assert.strictEqual(adapter.writeEnabled, false, 'kill lowers it');
    engine.resume(); assert.strictEqual(adapter.writeEnabled, true, 'resume lifts it again (back to live)');
    assert.strictEqual(engine.killed, false, 'resume cleared the kill');
    engine.kill();
    ok('write backstop follows kill / resume');
  }

  // ---- D. kill while LIVE -> resume restores live bidding, real ladder intact ----
  {
    const f = tmp('resumelive');
    const adapter = gatedCtrlAdapter();
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG });
    const closesAt = Date.now() + 12_000;
    const m = engine.arm(armMeta(closesAt), { cost: 50_000, marginsPct: BAND });

    // drive the establishing real bid deterministically (12s left <= openAt 15s)
    adapter.setClose(12_000); await engine._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.ok(adapter.placed.length >= 1, 'established a real bid while live');
    const firedBefore = [...m.firedRungs];
    const placedAtKill = adapter.placed.length;

    engine.kill('mid');
    assert.strictEqual(engine.killed, true, 'kill halted the engine');
    // a tick while killed does nothing (no bid, even in the floor window)
    adapter.setClose(1_500); await engine._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(adapter.placed.length, placedAtKill, 'no bid fired while killed');

    engine.resume();
    assert.strictEqual(engine.killed, false, 'resume lifted the kill');
    assert.strictEqual(adapter.writeEnabled, true, 'write backstop lifted again (live)');
    assert.deepStrictEqual([...m.firedRungs], firedBefore, 'real fired rungs survived kill/resume (no re-fire)');

    // live again: a floor-window tick fires the real floor bid (live bidding restored)
    adapter.setClose(400); await engine._tick(m); if (m.timer) clearTimeout(m.timer);
    const floor = m.ladder[m.ladder.length - 1];
    assert.ok(adapter.placed.includes(floor), `real floor bid ${floor} fired after resume (placed: ${adapter.placed})`);
    engine.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('kill while LIVE -> resume: live again, real ladder intact, bidding continues');
  }

  // ---- E. a bid that LANDS while killed is known to the live monitor after resume ----
  // The late-resolve bail in _maybeBid fires on `monitor.finalized || this.killed`, and the killed
  // half is not a retirement: kill() leaves the monitor in this.monitors, so the correction that
  // hands the landed facts back to the live monitor - keyed on a re-arm having replaced it - was
  // skipped here. The load then came out of resume() with a bid standing on the portal and a monitor
  // that believed the board was empty, so standingBid() and _mustImproveOn() both read null and the
  // engine could re-offer ABOVE its own live bid. D covers state that survives the kill; this covers
  // state that ARRIVES during it.
  {
    const f = tmp('killlanding');
    const adapter = gatedCtrlAdapter();
    const engine = new BidEngine(adapter, new DurableScheduler(f), { config: CFG });
    let release;
    const onWire = new Promise((r) => { release = r; });
    adapter.placeBid = async function (id, price) {
      if (!this.writeEnabled) { const e = new Error('write_disabled'); e.code = 'WRITE_DISABLED'; throw e; }
      this.placed.push(price);
      await onWire;                       // still on the wire when the kill lands
      return { accepted: true, myRank: 2, latencyMs: 60 };
    };
    const m = engine.arm(armMeta(Date.now() + 12_000), { cost: 50_000, marginsPct: BAND });
    adapter.setClose(12_000);
    const inFlight = engine._tick(m);
    while (adapter.placed.length < 1) await sleep(10);
    if (m.timer) clearTimeout(m.timer);
    engine.kill('mid-write');
    release();
    await inFlight;
    if (m.timer) clearTimeout(m.timer);

    const landed = adapter.placed[0];
    assert.strictEqual(engine.monitors.get(m.auctionId), m,
      'precondition: kill() leaves the monitor live - this is not the retired-monitor path');
    assert.strictEqual(engine.scheduler.get(m.auctionId).landedBidPrice, landed,
      'precondition: the durable intent recorded the bid that landed during the kill');

    engine.resume();
    if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(m.landedBids, 1, 'the live monitor knows it has a bid on the board');
    assert.strictEqual(m.lastBidPrice, landed, 'at the price that actually landed');
    assert.strictEqual(engine.standingBid(m.auctionId).price, landed,
      'so the re-price gate sees the standing bid instead of an empty board');
    assert.strictEqual(engine._mustImproveOn(m), landed - 1,
      'and the belt refuses a price at or above it, instead of returning null and passing everything');
    engine.kill(); try { fs.unlinkSync(f); } catch (_) {}
    ok('a bid landing mid-kill is handed to the live monitor, so resume() cannot re-offer above it');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
