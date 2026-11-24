'use strict';
/**
 * STRUCTURAL FLOOR GATE (Module 2 foundation, audit fix #6).
 *
 *  A. GREP GATE: `.placeBid(` may be CALLED only from the sanctioned engine/harness callers. A new
 *     rule path that reaches the write from anywhere else would bypass the engine's floor + rules
 *     guards - this test fails if it ever appears outside the allowlist.
 *  B. FLOOR BELT: assertAboveFloor fires INSIDE placeBid, on the exact amount going on the wire, so
 *     a sub-floor amount can never leave the building even if both call-site guards were removed.
 *  C. Every _planFor output carries a finite floor > 0 (what the belt trusts as monitor.floor).
 *
 *   node scripts/test-placebid-floor-gate.js
 */
const fs = require('fs'); // allowed: this is a test + the grep-gate scanner, not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// the ONLY src files allowed to CALL `.placeBid(` (the engine's decision loop + the live snipe harness).
// gocomet/targetPriceSubmit.js is the third, and it was added deliberately rather than routed
// through the engine. A shipper target rate arrives AFTER the auction closed and the engine
// finalized the load; arm() short-circuits on that finalized monitor, so the engine path reaches
// the wire on this flow not at all. Section D below is what earns the entry: it proves the module
// cannot reach placeBid without a finite floor > 0 taken from buildBandLadder, which is the exact
// property this allowlist exists to protect. Widening the list without D would gut the gate.
const SANCTIONED = new Set(['engine/bidEngine.js', 'engine/snipeHarness.js', 'gocomet/targetPriceSubmit.js']);

(async () => {
  // ---- A. grep gate: `.placeBid(` only in the sanctioned callers ----
  {
    const srcRoot = path.join(__dirname, '..', 'src');
    const offenders = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith('.js')) continue;
        const body = fs.readFileSync(p, 'utf8');
        if (/\.placeBid\s*\(/.test(body)) { // a CALL (leading dot), not the `async placeBid(` definition
          const rel = path.relative(srcRoot, p).split(path.sep).join('/');
          if (!SANCTIONED.has(rel)) offenders.push(rel);
        }
      }
    })(srcRoot);
    assert.deepStrictEqual(offenders, [], 'placeBid is called outside the sanctioned engine/harness callers: ' + JSON.stringify(offenders));
    ok('grep gate: `.placeBid(` is only called from the sanctioned engine/harness/target-rate callers');
  }

  // ---- B. floor belt fires INSIDE placeBid (on the wire amount), independent of the engine ----
  {
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) }; };
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;

    // floor ABOVE the wire amount -> the belt throws FLOOR and NO request is sent
    let threw = null;
    try { await a.placeBid('123', 1000, { floor: 1001 }); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'FLOOR', 'placeBid throws a FLOOR-coded error when amount < opts.floor');
    assert.strictEqual(fetchCalls, 0, 'NO createV2 request was sent on a floor breach (fail closed before the write)');

    // floor at/below the wire amount -> the bid goes through
    const res = await a.placeBid('123', 1000, { floor: 999 });
    assert.strictEqual(res.accepted, true, 'a bid at/above the floor is sent');
    assert.strictEqual(fetchCalls, 1, 'exactly one request sent once the floor is cleared');

    // no floor in opts (legacy/harness caller) -> belt is skipped, the call-site guards still cover it
    const res2 = await a.placeBid('123', 1000, {});
    assert.strictEqual(res2.accepted, true, 'absent opts.floor -> belt skipped (byte-identical legacy path)');
    ok('floor belt inside placeBid blocks a sub-floor amount before the write; passes at/above the floor');
  }

  // ---- C. every _planFor output carries a finite floor > 0 ----
  {
    const adapterStub = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 6, closeModel: 'unknown' }), writeEnabled: true };
    const engine = new BidEngine(adapterStub, {}, {});
    // band model (the live SuperProcure/BRL path)
    const band = engine._planFor({ cost: 40000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    assert.ok(Number.isFinite(band.plan.floor) && band.plan.floor > 0, 'band-model plan carries a finite floor > 0');
    // rate model (mock/sim + any price-visible platform)
    const rate = engine._planFor({ marketRate: 50000, costFloor: 42000 });
    assert.ok(Number.isFinite(rate.plan.floor) && rate.plan.floor > 0, 'rate-model plan carries a finite floor > 0');
    // and the floor really is the lowest rung (a bid can't drop below it)
    assert.strictEqual(band.plan.floor, band.plan.ladder[band.plan.ladder.length - 1], 'band floor is the last ladder rung');
    ok('_planFor guarantees a finite floor > 0 on both pricing models');
  }

  // ---- D. the target-rate caller cannot reach the wire without a floor ----
  //
  // This section is what earns targetPriceSubmit.js its place in SANCTIONED above. The allowlist
  // exists to stop a write path reaching placeBid without the engine's floor guard; this proves the
  // new path carries one on every branch that reaches the wire, and reaches it on no other branch.
  {
    const { submitTargetRate } = require('../src/gocomet/targetPriceSubmit');
    const BAND = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
    const req = (over = {}) => Object.assign({
      loadId: 'GC1', targetPricePerUnit: 98000, chargeLineCount: 1,
      targetDeadlineMs: Date.now() + 10 * 60 * 1000,
    }, over);

    const calls = [];
    const adapter = { placeBid: async (id, amount, opts) => { calls.push({ id, amount, opts }); return { accepted: true }; } };
    const sent = await submitTargetRate(Object.assign({ adapter, request: req(), cost: 80000 }, BAND));
    assert.strictEqual(calls.length, 1, 'exactly one bid is placed - never a ladder');
    assert.ok(Number.isFinite(calls[0].opts.floor) && calls[0].opts.floor > 0,
      'the target-rate write carries a finite floor > 0');
    assert.ok(calls[0].amount >= calls[0].opts.floor, 'the amount sent is at or above that floor');
    assert.strictEqual(calls[0].opts.ceilingPrice, 98000,
      'the shipper target rides as the ceiling, so placeBid asserts against it too');
    assert.strictEqual(sent.submitted, true);

    const refusals = [
      ['below the floor', req(), 95000],
      ['below cost', req(), 110000],
      ['more than one truck type', req({ chargeLineCount: 2 }), 80000],
      ['a lapsed window', req({ targetDeadlineMs: Date.now() - 1 }), 80000],
      ['no usable target', req({ targetPricePerUnit: null }), 80000],
    ];
    for (const [why, request, cost] of refusals) {
      const seen = [];
      const spy = { placeBid: async () => { seen.push(1); return { accepted: true }; } };
      const out = await submitTargetRate(Object.assign({ adapter: spy, request, cost }, BAND));
      assert.strictEqual(out.submitted, false, 'refused: ' + why);
      assert.strictEqual(seen.length, 0, 'nothing reaches the wire on ' + why);
    }
    // A PLATFORM REJECTION IS NOT A SEND. placeBid RESOLVES on a non-2xx - it returns
    // { accepted: false, rejectReason } and throws only on network/structural failure - so awaiting
    // it and assuming success reports a refused bid to the desk as sent, and suppresses the
    // missed-window alert at the same time. Anything that is not an explicit accepted:true is a
    // refusal here, including a result the double did not give us.
    for (const [why, result] of [
      ['an explicit rejection', { accepted: false, rejectReason: 'You have increased the quote price' }],
      ['an accepted flag that is not true', { accepted: 'yes' }],
      ['no result at all', undefined],
    ]) {
      const out = await submitTargetRate(Object.assign(
        { adapter: { placeBid: async () => result }, request: req(), cost: 80000 }, BAND));
      assert.strictEqual(out.submitted, false, `not reported as sent on ${why}`);
      assert.strictEqual(out.reason, 'rejected', `and named a rejection on ${why}`);
    }

    // The target rides as its own ceiling, and placeBid's belt is `price <= ceiling`, so the amount
    // must never round UP past it. 97999.6 rounds to 98000 and would breach a 97999.6 ceiling.
    {
      const sent = [];
      const out = await submitTargetRate(Object.assign({
        adapter: { placeBid: async (id, amount, opts) => { sent.push({ amount, opts }); return { accepted: true }; } },
        request: req({ targetPricePerUnit: 97999.6 }), cost: 80000 }, BAND));
      assert.strictEqual(out.submitted, true);
      assert.ok(sent[0].amount <= sent[0].opts.ceilingPrice,
        'the amount sent never exceeds the target it is ceilinged by');
      assert.strictEqual(sent[0].amount, 97999, 'it rounds DOWN, into the ceiling');
    }
    ok('the target-rate path reaches placeBid only with a floor, and never on a refusal');
    ok('a platform rejection is reported as not-sent, and the amount never rounds past the ceiling');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
