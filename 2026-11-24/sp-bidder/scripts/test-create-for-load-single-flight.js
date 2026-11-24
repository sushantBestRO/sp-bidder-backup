'use strict';
/**
 * DUPLICATE PRICE REQUESTS from two overlapping createForLoad calls for the same load.
 *
 * createForLoad re-checks getByLoad and then awaits twice more (resolveInherited,
 * resolveRoundPolicy, resolveCustomerTag) before it ever writes. An abandoned discovery tick that
 * resumes beside its replacement - or any other overlapping caller for the same load - can have
 * both calls pass the "no existing request" check before either has written, and both then create
 * and persist their own token: two price-request links for one load, and the desk gets asked twice.
 *
 * WHAT MUST NOT MOVE: two DIFFERENT loads must still each get their own request even when their
 * creation windows overlap - the fix is a per-load guard, never a global one (check 4, the control).
 *
 * Pinned deterministically with a store whose read can be held open on demand, so both calls are
 * made to interleave inside the exact window the finding describes, with no timers and no real
 * concurrency. Offline, no network.
 *
 *   node scripts/test-create-for-load-single-flight.js
 */
const assert = require('assert');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// A store whose listDocs can be held open on demand. getByLoad (createForLoad's pre-write check)
// reads through listAll -> store.listDocs, so holding THIS is what reproduces two overlapping
// calls each seeing "no existing request" before either has written one.
function holdableStore() {
  const inner = new MemoryStore();
  let gate = null;
  let hits = 0;
  return {
    hitCount: () => hits,
    // Returns a release() that lets every call currently waiting on THIS hold through.
    hold() {
      let release;
      gate = new Promise((r) => { release = r; });
      const mine = gate;
      return () => { release(); if (gate === mine) gate = null; };
    },
    async getDoc(...a) { return inner.getDoc(...a); },
    async putDoc(...a) { return inner.putDoc(...a); },
    async listDocs(...a) {
      hits++;
      if (gate) await gate;
      return inner.listDocs(...a);
    },
  };
}

const load = (id, over = {}) => ({
  id, lane: { origin: 'Pune', destination: 'Nashik' }, companyName: 'Havells India Limited',
  equipment: '32 Feet', units: 1, weight: 16, weightUnit: 'MT', closesAt: Date.now() + 20 * 60_000,
  softClose: false, closeModelKnown: true, ...over,
});

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. Two overlapping createForLoad calls for the SAME load, forced to interleave: one write.
  // ---------------------------------------------------------------------------------------------
  let r1, r2, hitsAtWrite;
  {
    const store = holdableStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });

    const release = store.hold();
    const p1 = requests.createForLoad(load('DUP-1'));
    const p2 = requests.createForLoad(load('DUP-1'));
    // Both calls must have already reached the held read before release - otherwise this is
    // pinning two calls that never actually overlapped, which is not the mechanism.
    hitsAtWrite = store.hitCount();
    release();
    [r1, r2] = await Promise.all([p1, p2]);

    const stored = await requests.getByLoad('DUP-1');
    assert.ok(stored, 'the load has a persisted request after both calls settle');
    ok('both overlapping calls settle without either throwing');
  }

  assert.strictEqual(hitsAtWrite >= 1, true, 'the held read was actually reached before release (precondition)');
  ok(`the held read was reached ${hitsAtWrite} time(s) before release, so the calls genuinely overlapped`);

  assert.strictEqual(r1.id, r2.id, 'both calls must resolve to the SAME request id, not two tokens');
  ok('both overlapping calls resolve to the same request id');

  // ---------------------------------------------------------------------------------------------
  // 2. Exactly one document was written for the load, not two.
  // ---------------------------------------------------------------------------------------------
  {
    const store = holdableStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });
    const release = store.hold();
    const p1 = requests.createForLoad(load('DUP-2'));
    const p2 = requests.createForLoad(load('DUP-2'));
    release();
    await Promise.all([p1, p2]);
    const all = (await requests.listAll()).filter((r) => r.loadId === 'DUP-2');
    assert.strictEqual(all.length, 1, `exactly one request must be persisted for the load, found ${all.length}`);
    ok('exactly one request is persisted for the load, not two');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. The single-flight guard itself: the store's read is touched once, not once per caller.
  // ---------------------------------------------------------------------------------------------
  {
    const store = holdableStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });
    const release = store.hold();
    const p1 = requests.createForLoad(load('DUP-3'));
    const p2 = requests.createForLoad(load('DUP-3'));
    const p3 = requests.createForLoad(load('DUP-3'));
    const hitsBeforeRelease = store.hitCount();
    release();
    await Promise.all([p1, p2, p3]);
    assert.strictEqual(hitsBeforeRelease, 1,
      `a second and third overlapping call for the same load must never re-enter the store read - saw ${hitsBeforeRelease} reads before release`);
    ok('three overlapping calls for one load touch the store read exactly once');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. CONTROL: two DIFFERENT loads overlapping still each get their own request. The guard is
  //    per-load, never a global lock.
  // ---------------------------------------------------------------------------------------------
  {
    const store = holdableStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });
    const release = store.hold();
    const pA = requests.createForLoad(load('DIFF-A'));
    const pB = requests.createForLoad(load('DIFF-B'));
    release();
    const [ra, rb] = await Promise.all([pA, pB]);
    assert.notStrictEqual(ra.id, rb.id, 'two different loads must never share a request id');
    const allA = (await requests.listAll()).filter((r) => r.loadId === 'DIFF-A');
    const allB = (await requests.listAll()).filter((r) => r.loadId === 'DIFF-B');
    assert.strictEqual(allA.length, 1, 'load DIFF-A gets exactly one request');
    assert.strictEqual(allB.length, 1, 'load DIFF-B gets exactly one request');
    ok('two different overlapping loads each still get their own, separate request (control)');
  }

  console.log(`\n${pass}/6 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
