'use strict';
/**
 * CEILING PRICE (Module 2 L5).
 *
 * A shipper ceilingPrice caps the bid (430 loads, mostly Havells). The money contract:
 *   - NEVER place a bid ABOVE the ceiling. The ladder is capped to it (a visible cap) and the
 *     adapter's ceiling belt is the structural backstop that throws rather than ever sending an
 *     over-ceiling amount - it never silently clamps.
 *   - If respecting the ceiling would require bidding BELOW the cost floor (ceiling < floor), FAIL
 *     CLOSED: never bid, stand down, alert the operator ("cannot win profitably"). No clamp in
 *     either direction (not up to the floor, not down to the ceiling).
 *   - An absent / implausible ceiling (null, blank, non-numeric SP placeholder, zero, negative) is
 *     IGNORED - money-safe, because the cost floor still guards the downside.
 *   - BYTE-IDENTICAL: a load whose bid is at/under the ceiling (or has no ceiling) bids exactly the
 *     wire body it does today - the ceiling belt reads an opts-only field and never touches the body.
 *
 *   node scripts/test-ceiling-price.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');
const { plausibleCeiling, assertBelowCeiling, capLadderToCeiling } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const API = 'https://api.superprocure.com';

// a fetch stub that CAPTURES the outgoing request, then answers 201 (same shape the real accepted
// path reads). Mirrors test-loadrules-payload.js's capturingAdapter.
function capturingAdapter(carrierId, captured) {
  const fetchImpl = async (url, init) => {
    captured.calls = (captured.calls || 0) + 1;
    captured.url = url; captured.method = init.method;
    captured.bodyRaw = init.body; captured.body = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return a;
}
const norm = (raw) => { const b = JSON.parse(raw); b.requestTime = 0; return JSON.stringify(b); };

// engine harness: an adapter stub whose placeBid records the amounts it is asked to send.
function engineWith(sentAmounts, events, f) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}), writeEnabled: true,
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid: async (id, price) => { sentAmounts.push(price); return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
  };
  return new BidEngine(adapter, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
}
// band [12,7,6] on cost 40000 -> ladder [44800, 42800, 42400], floor 42400 (the fixture below).
const BAND = [12, 7, 6];
const COST = 40000;

(async () => {
  // ---- 1. plausibleCeiling: the single "is this ceiling real" gate ----
  {
    for (const bad of [null, undefined, '', 0, -5, NaN, 'lots', '2100-05-24T19:53:25.000Z']) {
      assert.strictEqual(plausibleCeiling(bad), null, `implausible ceiling ${JSON.stringify(bad)} -> null (ignored)`);
    }
    assert.strictEqual(plausibleCeiling(120000), 120000, 'a finite positive number is plausible');
    assert.strictEqual(plausibleCeiling('120000'), 120000, 'a numeric STRING off the wire is coerced (SP type variance)');
    ok('plausibleCeiling: ignores absent/blank/zero/negative/non-numeric; coerces a numeric string');
  }

  // ---- 2. assertBelowCeiling: the upper-bound invariant (mirror of assertAboveFloor) ----
  {
    assert.strictEqual(assertBelowCeiling(100, 100), 100, 'a bid AT the ceiling is allowed (inclusive)');
    assert.strictEqual(assertBelowCeiling(99, 100), 99, 'a bid below the ceiling is allowed');
    let e1 = null; try { assertBelowCeiling(101, 100); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.code === 'CEILING', 'a bid ABOVE the ceiling throws CEILING (never clamps)');
    let e2 = null; try { assertBelowCeiling(NaN, 100); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.code === 'CEILING', 'a NaN amount fails closed (never fail-open)');
    ok('assertBelowCeiling: throws CEILING on an over-ceiling or NaN amount; passes at/under');
  }

  // ---- 3. capLadderToCeiling: caps the top, preserves the floor rung, no-op above the opening ----
  {
    const ladder = [44800, 42800, 42400]; // floor 42400
    assert.deepStrictEqual(capLadderToCeiling(ladder, 43000), [43000, 42800, 42400], 'top rungs above the ceiling are lowered TO the ceiling');
    assert.deepStrictEqual(capLadderToCeiling(ladder, 50000), ladder, 'a ceiling at/above the opening leaves the ladder byte-identical');
    assert.deepStrictEqual(capLadderToCeiling(ladder, 42800), [42800, 42400], 'dedupes back to strictly descending');
    assert.deepStrictEqual(capLadderToCeiling(ladder, 42400), [42400], 'ceiling == floor collapses to the floor rung only');
    ok('capLadderToCeiling caps the top, keeps the floor as the last rung, no-op when ceiling >= opening');
  }

  // ---- 4. adapter ceiling BELT: an over-ceiling amount fails closed before the write; at/under sends ----
  {
    const carrier = 10686, load = 23088090;
    const rules = deriveLoadRules({ id: String(load), branchCarrierCarrierId: carrier, ceilingPrice: 100000, branchAuctionExtendTime: '00:00:00' });

    const capOver = {};
    const aOver = capturingAdapter(carrier, capOver);
    let be = null; try { await aOver.placeBid(String(load), 100001, rules); } catch (e) { be = e; }
    assert.ok(be && be.code === 'CEILING', 'placeBid throws CEILING when the amount exceeds the ceiling');
    assert.strictEqual(capOver.calls || 0, 0, 'NO createV2 request was sent on a ceiling breach (fail closed before the write)');

    const capAt = {};
    const aAt = capturingAdapter(carrier, capAt);
    const res = await aAt.placeBid(String(load), 100000, rules);
    assert.strictEqual(res.accepted, true, 'a bid AT the ceiling is sent');
    assert.strictEqual(capAt.body.amount, 100000, 'the wire amount is the bid, not a clamp');

    // a string-typed ceiling off the wire enforces identically
    const rulesStr = deriveLoadRules({ id: String(load), ceilingPrice: '100000', branchAuctionExtendTime: '00:00:00' });
    const capStr = {}; let se = null;
    try { await capturingAdapter(carrier, capStr).placeBid(String(load), 100001, rulesStr); } catch (e) { se = e; }
    assert.ok(se && se.code === 'CEILING', 'a numeric-string ceiling is enforced the same as a number');
    ok('ceiling belt: over-ceiling amount fails closed (no request); at/under sends; string ceiling enforced');
  }

  // ---- 5. BYTE-IDENTICAL: an under-ceiling bid == the no-ceiling bid, same load ----
  {
    const carrier = 10686, load = 23088090, price = 88888.7;
    const capCeil = {}, capNone = {};
    const withCeil = deriveLoadRules({ id: String(load), branchCarrierCarrierId: carrier, ceilingPrice: 120000, branchAuctionExtendTime: '00:00:00' });
    const noCeil = deriveLoadRules({ id: String(load), branchCarrierCarrierId: carrier, branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(noCeil.ceilingPrice, null, 'precondition: the no-ceiling rules carry a null ceilingPrice');
    await capturingAdapter(carrier, capCeil).placeBid(String(load), price, withCeil);
    await capturingAdapter(carrier, capNone).placeBid(String(load), price, noCeil);
    assert.strictEqual(norm(capCeil.bodyRaw), norm(capNone.bodyRaw),
      'an under-ceiling bid is BYTE-IDENTICAL to the no-ceiling bid (ceiling is an opts-only field, never on the wire)');
    ok('byte-identical: a bid at/under a ceiling sends the exact same createV2 body as a load with no ceiling');
  }

  // ---- 6. engine ladder CAP: a ceiling between floor and opening caps the top rung; floor untouched ----
  {
    const f = path.join(os.tmpdir(), `ceil-cap-${process.pid}.json`);
    const sent = [], events = [];
    const engine = engineWith(sent, events, f);
    const rules = deriveLoadRules({ id: 'CAP1', ceilingPrice: 43000, branchAuctionExtendTime: '00:00:00' });
    const m = engine.arm({ id: 'CAP1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 1000, rules },
      { cost: COST, marginsPct: BAND, minMarginPct: 6 });
    if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(m.ceiling, 43000, 'monitor carries the resolved ceiling');
    assert.strictEqual(m.ceilingBelowFloor, false, 'ceiling is above the floor - not a fail-closed load');
    assert.strictEqual(m.ladder[0], 43000, 'the opening rung is capped down to the ceiling');
    assert.strictEqual(m.ladder[m.ladder.length - 1], m.floor, 'the floor rung is unchanged (still the lowest rung)');
    assert.ok(m.ladder.every((r) => r <= 43000), 'no rung exceeds the ceiling');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
    ok('engine caps the armed ladder to a ceiling between floor and opening; floor rung preserved');
  }

  // ---- 7. a ceiling AT/ABOVE the opening leaves the ladder byte-identical (no cap) ----
  {
    const f = path.join(os.tmpdir(), `ceil-nocap-${process.pid}.json`);
    const sent = [], events = [];
    const engine = engineWith(sent, events, f);
    const bare = engineWith([], [], path.join(os.tmpdir(), `ceil-bare-${process.pid}.json`));
    const rules = deriveLoadRules({ id: 'NOCAP1', ceilingPrice: 500000, branchAuctionExtendTime: '00:00:00' });
    const m = engine.arm({ id: 'NOCAP1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 1000, rules },
      { cost: COST, marginsPct: BAND, minMarginPct: 6 });
    const mBare = bare.arm({ id: 'NOCAP1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 1000, rules: null },
      { cost: COST, marginsPct: BAND, minMarginPct: 6 });
    if (m.timer) clearTimeout(m.timer); if (mBare.timer) clearTimeout(mBare.timer);
    assert.deepStrictEqual(m.ladder, mBare.ladder, 'a ceiling above the opening leaves the ladder identical to the no-ceiling ladder');
    engine.kill('t'); bare.kill('t');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('engine: a ceiling at/above the opening does not alter the ladder (byte-identical to no ceiling)');
  }

  // ---- 8. FAIL CLOSED: ceiling BELOW the floor -> never bids, stands down, alerts once ----
  {
    const f = path.join(os.tmpdir(), `ceil-belowfloor-${process.pid}.json`);
    const sent = [], events = [];
    const engine = engineWith(sent, events, f);
    // band floor is 42400; a ceiling of 42000 sits below it -> cannot win profitably
    const rules = deriveLoadRules({ id: 'LOW1', ceilingPrice: 42000, branchAuctionExtendTime: '00:00:00' });
    const m = engine.arm({ id: 'LOW1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells', closesAt: Date.now() + 1000, rules },
      { cost: COST, marginsPct: BAND, minMarginPct: 6 });
    if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(m.ceilingBelowFloor, true, 'monitor is flagged ceiling-below-floor');
    assert.strictEqual(m.ladder[m.ladder.length - 1], m.floor, 'the ladder is left UNcapped and floor-safe (floor still the lowest rung)');

    // _decide refuses (returns null) and stands down
    const state = await engine.adapter.getAuctionState();
    assert.strictEqual(engine._decide(m, state), null, '_decide returns null - no rung to bid under the ceiling');

    // a full tick places NO bid and the operator alert fires
    await engine._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.deepStrictEqual(sent, [], 'no bid was ever placed on a ceiling-below-floor load');
    assert.deepStrictEqual([...m.firedRungs], [], 'no rung was spent');
    const alert = events.find((e) => e.type === 'alert' && e.kind === 'ceiling_below_floor');
    assert.ok(alert, 'a ceiling_below_floor alert is raised');
    assert.strictEqual(alert.auctionId, 'LOW1', 'the alert names the load');
    // alerted ONCE, not every tick
    await engine._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(events.filter((e) => e.kind === 'ceiling_below_floor').length, 1, 'the stand-down alert fires once, not every tick');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
    ok('ceiling < floor: engine never bids, stands down, raises ceiling_below_floor exactly once');
  }

  // ---- 9. UNKNOWN ceiling IGNORED: an implausible ceiling bids exactly as a no-ceiling load ----
  {
    for (const badCeil of [null, 0, -1, 'x', '2100-05-24T19:53:25.000Z']) {
      const f = path.join(os.tmpdir(), `ceil-unknown-${process.pid}.json`);
      const sent = [], events = [];
      const engine = engineWith(sent, events, f);
      const rules = deriveLoadRules({ id: 'UNK1', ceilingPrice: badCeil, branchAuctionExtendTime: '00:00:00' });
      const m = engine.arm({ id: 'UNK1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 1000, rules },
        { cost: COST, marginsPct: BAND, minMarginPct: 6 });
      if (m.timer) clearTimeout(m.timer);
      assert.strictEqual(m.ceiling, null, `implausible ceiling ${JSON.stringify(badCeil)} -> no ceiling in force`);
      assert.strictEqual(m.ceilingBelowFloor, false, 'an ignored ceiling never trips the fail-closed path');
      assert.deepStrictEqual(m.ladder, [44800, 42800, 42400], 'the ladder is the full uncapped band (bids as if no ceiling)');
      assert.ok(!events.some((e) => e.kind === 'ceiling_below_floor'), 'no fail-closed alert on an ignored ceiling');
      engine.kill('t'); try { fs.unlinkSync(f); } catch (_) {}
    }
    ok('unknown/implausible ceiling is ignored - the load bids on the full band, floor still guarding');
  }

  console.log(`\n${pass}/9 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
