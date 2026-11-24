'use strict';

/**
 * The watch lifecycle: detect off a real quote body, raise one ask per round, hold the shipper's
 * own deadline, expire it unanswered, and survive a restart mid-window.
 *
 * Time is injected rather than slept: the shortest observed window is 13m45s and the harness must
 * not take 13m45s to prove it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TargetPriceWatch } = require('../src/gocomet/targetPriceWatch');
const { decideTargetPrice } = require('../src/gocomet/targetPriceDecision');

const FIXTURES = path.resolve(__dirname, 'fixtures/gocomet-target-price-2026-08-19');
const loadFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };
const CLEAN = [];
const tmpFile = (tag) => {
  const p = path.join(os.tmpdir(), `gc-target-${tag}-${process.pid}.json`);
  CLEAN.push(p);
  return p;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A clock we drive by hand.
function clock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

const T0 = Date.UTC(2026, 7, 17, 15, 16, 0);   // 17 Aug 20:46 IST - the moment N3VH's target landed
const DEADLINE = Date.UTC(2026, 7, 17, 15, 30, 59); // 21:00:59 IST
const WINDOW_MS = DEADLINE - T0;

// An adapter stub whose target-rate read is swapped per test. The body is the REAL capture, with
// only the deadline rewritten so the fixture stays usable against an injected clock.
function stubAdapter(body) {
  const calls = [];
  return {
    calls,
    async fetchTargetPrice(key, opts) {
      calls.push(key);
      if (body instanceof Error) throw body;
      if (typeof body === 'function') return body(key, opts);
      const { readTargetPrice } = require('../src/platform/gocometTargetPrice');
      return readTargetPrice(body, opts && opts.nowMs);
    },
  };
}

const LOAD = { id: '260817N3VH', lane: { origin: 'Kutch', destination: 'Chennai' }, units: 1, companyName: 'Waaree Energies Ltd.', closesAt: Date.UTC(2026, 7, 17, 14, 29, 59) };

function liveBody() {
  const body = JSON.parse(JSON.stringify(loadFixture('05_quotes_N3VH.json')));
  body[0].negotiation_status = 'negotiation_in_progress';
  return body;
}

(async () => {
  // ---- detection raises exactly one ask, off a real body ---------------------------------------
  {
    const c = clock(T0);
    const raised = [];
    const w = new TargetPriceWatch({
      filePath: tmpFile('detect'), adapter: stubAdapter(liveBody()), now: c.now,
      onTarget: async (r) => raised.push(r), pollMs: 60_000,
    });
    w.watch(LOAD);
    assert.strictEqual(w.watched().length, 1);

    const r1 = await w.tick(c.now());
    assert.strictEqual(r1.polled, 1);
    assert.strictEqual(r1.found, 1, 'a live target on a watched load raises an ask');
    assert.strictEqual(raised.length, 1);
    assert.strictEqual(raised[0].targetPricePerUnit, 98000);
    assert.strictEqual(raised[0].standingPricePerUnit, 99000);
    assert.strictEqual(raised[0].targetDeadlineMs, DEADLINE);
    ok('a target on a watched closed load is detected and raised once');

    // Re-polling the same round must not ask twice - the desk gets one message per round.
    c.advance(61_000);
    const r2 = await w.tick(c.now());
    assert.strictEqual(r2.found, 0, 'same round, no second ask');
    assert.strictEqual(raised.length, 1);
    ok('a repeat poll of the same round does not re-ask');
  }

  // ---- a second round is a NEW ask, not a merge ------------------------------------------------
  {
    const c = clock(T0);
    const raised = [];
    let deadline = DEADLINE;
    const w = new TargetPriceWatch({
      filePath: tmpFile('rounds'),
      adapter: stubAdapter(() => {
        const b = liveBody();
        b[0].indicative_charges_list.negotiate_data.deadline = deadline === DEADLINE ? '17/08/2026 21:00' : '17/08/2026 22:00';
        b[0].indicative_charges_list.total_charge.price = deadline === DEADLINE ? 98000 : 95000;
        return require('../src/platform/gocometTargetPrice').readTargetPrice(b, c.now());
      }),
      now: c.now, onTarget: async (r) => raised.push(r), pollMs: 60_000,
    });
    w.watch(LOAD);
    await w.tick(c.now());
    assert.strictEqual(raised.length, 1);

    deadline = 'later';
    c.advance(61_000);
    await w.tick(c.now());
    assert.strictEqual(raised.length, 2, 'a second power negotiation raises its own ask');
    assert.strictEqual(raised[1].targetPricePerUnit, 95000);
    assert.notStrictEqual(raised[0].id, raised[1].id, 'the two rounds are distinct records');
    ok('a second negotiation round gets its own record and its own ask');
  }

  // ---- the deadline expires unanswered ---------------------------------------------------------
  {
    const c = clock(T0);
    const expired = [];
    const w = new TargetPriceWatch({
      filePath: tmpFile('expire'), adapter: stubAdapter(liveBody()), now: c.now,
      onExpired: async (r) => expired.push(r), pollMs: 60_000,
    });
    w.watch(LOAD);
    await w.tick(c.now());
    assert.strictEqual(w.pending().length, 1);

    c.advance(WINDOW_MS - 60_000);          // one minute left
    await w.tick(c.now());
    assert.strictEqual(expired.length, 0, 'still inside the window');

    c.advance(120_000);                      // past the deadline
    await w.tick(c.now());
    assert.strictEqual(expired.length, 1, 'the window closed unanswered');
    assert.strictEqual(expired[0].status, 'expired');
    assert.strictEqual(w.pending().length, 0);
    ok('an unanswered window expires exactly once, at the shipper deadline');
  }

  // ---- answering stops the expiry --------------------------------------------------------------
  {
    const c = clock(T0);
    const expired = [];
    const raised = [];
    const w = new TargetPriceWatch({
      filePath: tmpFile('answer'), adapter: stubAdapter(liveBody()), now: c.now,
      onTarget: async (r) => raised.push(r), onExpired: async (r) => expired.push(r), pollMs: 60_000,
    });
    w.watch(LOAD);
    await w.tick(c.now());
    w.answer(raised[0].id, { price: 98000, outcome: 'submitted' });

    c.advance(WINDOW_MS + 60_000);
    await w.tick(c.now());
    assert.strictEqual(expired.length, 0, 'an answered target never fires the missed-window alert');
    ok('answering before the deadline suppresses the expiry alert');
  }

  // ---- RESTART MID-WINDOW ----------------------------------------------------------------------
  {
    const f = tmpFile('restart');
    const c = clock(T0);
    const w1 = new TargetPriceWatch({ filePath: f, adapter: stubAdapter(liveBody()), now: c.now, pollMs: 60_000 });
    w1.watch(LOAD);
    await w1.tick(c.now());
    assert.strictEqual(w1.pending().length, 1);

    // Process restarts five minutes in, still nine minutes of window left.
    c.advance(5 * 60_000);
    const reasserted = [];
    const w2 = new TargetPriceWatch({
      filePath: f, adapter: stubAdapter(liveBody()), now: c.now,
      onTarget: async (r, meta) => reasserted.push({ r, meta }), pollMs: 60_000,
    });
    assert.strictEqual(w2.pending().length, 1, 'the live obligation survived the restart on disk');
    const out = await w2.rehydrate(c.now());
    assert.strictEqual(out.reasserted, 1);
    assert.strictEqual(out.missed, 0);
    assert.strictEqual(reasserted[0].meta.reasserted, true, 'the re-surfaced ask is flagged as a re-assert');
    assert.strictEqual(reasserted[0].r.targetPricePerUnit, 98000);
    ok('a restart mid-window re-asserts the live target instead of abandoning it');

    // And the same window, restarted AFTER it lapsed, must report a miss rather than a live ask.
    const c2 = clock(DEADLINE + 60_000);
    const missed = [];
    const w3 = new TargetPriceWatch({
      filePath: f, adapter: stubAdapter(liveBody()), now: c2.now,
      onTarget: async () => { throw new Error('must not re-ask a lapsed window'); },
      onExpired: async (r) => missed.push(r), pollMs: 60_000,
    });
    const out3 = await w3.rehydrate(c2.now());
    assert.strictEqual(out3.missed, 1);
    assert.strictEqual(missed[0].expiredWhileDown, true);
    ok('a restart after the window lapsed reports the miss, never a stale ask');
  }

  // ---- a hydration failure must not stop the expiry sweep --------------------------------------
  {
    const c = clock(T0);
    const expired = [];
    const w = new TargetPriceWatch({
      filePath: tmpFile('resilient'), adapter: stubAdapter(liveBody()), now: c.now,
      onExpired: async (r) => expired.push(r), pollMs: 60_000,
    });
    w.watch(LOAD);
    await w.tick(c.now());
    w.adapter = stubAdapter(new Error('RATE_LIMITED'));
    c.advance(WINDOW_MS + 60_000);
    const out = await w.tick(c.now());
    assert.strictEqual(out.errors >= 0, true);
    assert.strictEqual(expired.length, 1, 'the sweep still ran despite the read failing');
    ok('a failed hydration does not suppress the missed-window alert');
  }

  // ---- the watch set ages out ------------------------------------------------------------------
  {
    const c = clock(T0);
    const w = new TargetPriceWatch({
      filePath: tmpFile('age'), adapter: stubAdapter(null), now: c.now, watchMs: 60_000, pollMs: 1000,
    });
    w.watch(LOAD);
    c.advance(61_000);
    await w.tick(c.now());
    assert.strictEqual(w.watched().length, 0, 'a load with no target stops being watched');
    ok('the watch set ages out so it cannot grow without bound');
  }

  // ---- the per-cycle read cap ------------------------------------------------------------------
  {
    const c = clock(T0);
    const adapter = stubAdapter(null);
    const w = new TargetPriceWatch({
      filePath: tmpFile('cap'), adapter, now: c.now, pollMs: 60_000, maxPollsPerCycle: 3,
    });
    for (let i = 0; i < 10; i += 1) w.watch({ ...LOAD, id: `LOAD${i}` });
    assert.strictEqual(w.watched().length, 10);

    const out = await w.tick(c.now());
    assert.strictEqual(out.polled, 3, 'the cycle never issues more reads than the cap');
    assert.strictEqual(adapter.calls.length, 3, 'and the adapter really was only called that many times');

    // The unpolled ones are not starved: the next cycle takes the ones waiting longest.
    c.advance(61_000);
    const out2 = await w.tick(c.now());
    assert.strictEqual(out2.polled, 3);
    const polledTwice = adapter.calls.filter((k, i) => adapter.calls.indexOf(k) !== i);
    assert.strictEqual(polledTwice.length, 0, 'the second cycle picked loads the first one skipped');
    ok('the per-cycle read cap bounds the budget and rotates rather than starving');
  }

  // ---- THE MONEY GATE: bid above the floor, refuse below it -------------------------------------
  {
    const band = { marginsPct: [12, 9, 6], minMarginPct: 6 };

    // Cost 80,000, floor = 80,000 x 1.06 = 84,800. Target 98,000 clears it.
    const yes = decideTargetPrice({ targetPricePerUnit: 98000, cost: 80000, ...band });
    assert.strictEqual(yes.action, 'bid');
    assert.strictEqual(yes.price, 98000, 'we meet the target exactly, not below it');
    assert.strictEqual(yes.floor, 84800);
    ok('a target above the operating floor is met at the target');

    // Cost 95,000, floor = 100,700. Target 98,000 is above cost but under the floor.
    const under = decideTargetPrice({ targetPricePerUnit: 98000, cost: 95000, ...band });
    assert.strictEqual(under.action, 'refuse');
    assert.strictEqual(under.reason, 'below_floor');
    assert.strictEqual(under.price, null, 'a refusal never carries a price to submit');
    assert.strictEqual(under.shortfall, 2700);
    ok('a target below the operating floor is REFUSED, not clamped up and submitted');

    // Cost 110,000. Target 98,000 is below cost outright.
    const loss = decideTargetPrice({ targetPricePerUnit: 98000, cost: 110000, ...band });
    assert.strictEqual(loss.action, 'refuse');
    assert.strictEqual(loss.reason, 'below_cost');
    assert.strictEqual(loss.price, null);
    ok('a target below true cost is refused as a guaranteed loss');

    // The exact boundary: target == floor is acceptable, one rupee under is not.
    assert.strictEqual(decideTargetPrice({ targetPricePerUnit: 84800, cost: 80000, ...band }).action, 'bid');
    assert.strictEqual(decideTargetPrice({ targetPricePerUnit: 84799, cost: 80000, ...band }).action, 'refuse');
    ok('the floor boundary is inclusive and one rupee under it refuses');

    // The real multi-line load: no single number expresses the target, so it never auto-bids.
    const multi = decideTargetPrice({ targetPricePerUnit: 190000, cost: 100000, chargeLineCount: 2, ...band });
    assert.strictEqual(multi.action, 'refuse');
    assert.strictEqual(multi.reason, 'multi_line');
    ok('a multi-truck-type target refuses rather than guessing the split across lines');

    for (const bad of [null, undefined, 0, -1, NaN, 'abc']) {
      assert.strictEqual(decideTargetPrice({ targetPricePerUnit: bad, cost: 80000, ...band }).action, 'refuse');
    }
    ok('an absent or malformed target refuses');

  // A FAILED HAND-OFF MUST NOT CONSUME THE ASK. The record is written before onTarget so a crash
  // between the two cannot lose it - but if onTarget throws, that same record is what makes the
  // next poll return early, so the desk would never be asked and the only trace would be an
  // expiry alert saying nobody replied.
  {
    let now = 1_000_000;
    const facts = {
      targetPricePerUnit: 98000, standingPricePerUnit: 102695,
      targetDeadlineMs: now + 10 * 60_000, chargeLineCount: 1, autoBiddable: true, comment: null,
    };
    let attempts = 0;
    const w = new TargetPriceWatch({
      filePath: tmpFile('rollback'),
      adapter: { fetchTargetPrice: async () => facts },
      now: () => now,
      onTarget: async () => { attempts += 1; if (attempts === 1) throw new Error('send blew up'); },
    });
    w.watch({ id: 'GCROLL' }, { closedAt: now });
    await w.tick(now);                       // first pass: onTarget throws, record rolled back
    assert.strictEqual(attempts, 1, 'the desk hand-off was attempted');
    assert.strictEqual(w.pending().length, 0, 'and no half-raised record was left behind');
    now += 120_000;
    await w.tick(now);                       // second pass: it is retried, not silently skipped
    assert.strictEqual(attempts, 2, 'the next poll retries the hand-off rather than skipping it');
    assert.strictEqual(w.pending().length, 1, 'and the ask now stands');
    ok('a failed hand-off to the desk is rolled back and retried, never silently consumed');
  }
  }

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades by exit code alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count makes truncation fail.
  const EXPECTED = 17;
  assert.strictEqual(checks, EXPECTED, `expected ${EXPECTED} checks, ran ${checks} - the file did not run to completion`);
  console.log(`\n${checks}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
