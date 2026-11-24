'use strict';
/**
 * PR #247's zero-floor substitution has two blind spots this pins.
 *
 * PART 1 - the heal gate. armFromRequest substitutes the house default for any band whose
 * EFFECTIVE floor margin (effectiveFloorMarginPct: minMarginPct, else the band's own lowest
 * anchor) is <= 0, then tries to correct the stored record so the /price page and CSV export stop
 * reporting the old broken number forever. The heal's own gate (healZeroFloorMargin) was never
 * widened to match: it reads only the bare `minMarginPct` field, so a band with NO explicit
 * minimum at all (the "band lowest <= 0" shape) reads as NaN, the gate refuses, and the stored
 * record - and every surface that reads it rather than the armed ladder - keeps reporting a
 * never-go-below that is not what the engine actually bid on.
 *
 * PART 2 - the preview flag. planPreview shares the same substitution (_planFor sets
 * plan.floorMarginSubstituted) but discards the field when it builds its own return object, so a
 * desk operator previewing a customer with a broken floor sees a ladder built off the house
 * default with nothing distinguishing it from their own configured band.
 *
 * WHAT MUST NOT MOVE:
 *   - a healthy band (explicit positive minMarginPct) is never healed and never flagged (controls
 *     1 and 5).
 *   - the pre-existing narrow shape (explicit minMarginPct: 0) still heals exactly as before -
 *     widening the gate must not regress the case it already handled (control 2).
 *   - a record already healed (now positive) is never re-healed - the documented idempotency
 *     (control 3).
 *   - planPreview still never emits an alert - substitution stays silent on this path, only arm()
 *     and schedule() page anyone (control 6).
 *
 * Offline and deterministic: MemoryStore, a fake platform adapter, no network, no timers.
 *
 *   node scripts/test-zero-floor-heal-and-preview-flag.js
 */
process.env.STORE_BACKEND = 'memory';

const os = require('os');
const path = require('path');
const assert = require('assert');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const appConfig = require('../src/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const HOUSE = appConfig.minMarginPct;
assert.ok(Number.isFinite(HOUSE) && HOUSE > 0, 'precondition: the house default margin must be a positive number for this pin to mean anything');

// =========================================================================================
// PART 1 - the heal gate must widen with the same resolution the caller (armFromRequest) uses.
// =========================================================================================
console.log('\n1. healZeroFloorMargin heals every shape the caller can substitute for');

(async () => {
  const store = new MemoryStore();
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });

  const seed = (token, loadId, price) => store.putDoc(COLLECTION, token, { id: token, loadId, price });

  // THE MECHANISM: no explicit minMarginPct at all, band lowest anchor <= 0. armFromRequest's
  // floorMarginSubstitution (effectiveFloorMarginPct) treats this as a zero floor and substitutes
  // the house default; the heal gate must agree.
  await seed('TOK-ABSENT', 'L-ABSENT', { cost: 40_000, marginsPct: [12, 5, -2] });
  const healed = await requests.healZeroFloorMargin('TOK-ABSENT', HOUSE);
  ok(healed != null && healed.price.minMarginPct === HOUSE && healed.minMarginPct === HOUSE,
    'a band with no explicit minMarginPct and a lowest anchor <= 0 is healed to the house default');

  // CONTROL 1 - a healthy band (explicit positive minimum) must never be healed.
  await seed('TOK-POS', 'L-POS', { cost: 40_000, marginsPct: [12, 8, 6], minMarginPct: 6 });
  const untouched = await requests.healZeroFloorMargin('TOK-POS', HOUSE);
  ok(untouched === null, 'a healthy band with an explicit positive minimum is never healed (control)');

  // CONTROL 2 - the pre-existing narrow shape (explicit 0) must still heal, unchanged by the widen.
  await seed('TOK-ZERO', 'L-ZERO', { cost: 40_000, marginsPct: [12, 5, 0], minMarginPct: 0 });
  const healedZero = await requests.healZeroFloorMargin('TOK-ZERO', HOUSE);
  ok(healedZero != null && healedZero.price.minMarginPct === HOUSE,
    'the pre-existing explicit-zero shape still heals exactly as before (control)');

  // CONTROL 3 - idempotency: a record already healed (now positive) is never re-healed.
  const reheal = await requests.healZeroFloorMargin('TOK-ZERO', HOUSE);
  ok(reheal === null, 'a record already healed to a positive margin is never re-healed (control)');

  // =========================================================================================
  // PART 2 - planPreview must surface the same substitution flag arm()/schedule() compute.
  // =========================================================================================
  console.log('\n2. planPreview surfaces floorMarginSubstituted');

  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 1, totalBidders: 1,
      standingL1Price: null, closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid: async () => { throw new Error('planPreview must never place a bid'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(path.join(os.tmpdir(), `s4-preview-${process.pid}.json`)),
    { config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, onEvent: (e) => events.push(e) });

  const meta = (id, companyName = 'Test Co') => ({ id,
    lane: { origin: 'Pune', destination: 'Nashik' }, units: 1, companyName,
    rules: { revisionLimit: 3, minDecrement: 100, closeModel: 'hard' }, closesAt: Date.now() + 600_000 });

  // Same broken shape as Part 1: no explicit minMarginPct, band lowest anchor 0.
  const brokenBand = { cost: 38_000, marginsPct: [12.6, 7.2, 0] };
  const preview = eng.planPreview(meta('PREVIEW-BROKEN'), brokenBand);
  ok(preview.floorMarginSubstituted != null
      && preview.floorMarginSubstituted.stored === 0
      && preview.floorMarginSubstituted.substituted === HOUSE,
    `planPreview reports the substitution on a broken band (got ${JSON.stringify(preview.floorMarginSubstituted)})`);

  // CONTROL 4 - the previewed floor is still built off the substituted margin (unchanged
  // behaviour - only the missing SIGNAL is being added, never the arithmetic).
  ok(preview.floor > brokenBand.cost, 'the previewed floor still sits above cost, off the substituted margin (control)');

  // CONTROL 5 - a healthy band's preview never carries the flag.
  const healthyBand = { cost: 38_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
  const cleanPreview = eng.planPreview(meta('PREVIEW-HEALTHY'), healthyBand);
  ok(!cleanPreview.floorMarginSubstituted, 'a healthy band\'s preview never carries floorMarginSubstituted (control)');

  // CONTROL 6 - planPreview stays silent. Substitution announcing is arm()'s and schedule()'s job
  // only; a preview firing per keystroke would page someone for every character the desk types.
  ok(events.length === 0, 'planPreview never emits an alert even on a broken band (control)');

  eng.kill('done');
  const EXPECTED = 8;
  console.log(`\n${pass}/${EXPECTED} checks passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
