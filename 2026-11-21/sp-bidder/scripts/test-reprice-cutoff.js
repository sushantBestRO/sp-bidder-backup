'use strict';
/**
 * Re-price acceptance model. The ONLY hard stop on a re-price is the auction actually closing on the
 * portal. A late re-price (past the advisory deadlineAt but before close) is accepted best-effort,
 * because the engine now snipes the FLOOR into whatever window is left (bidEngine _decide sends a
 * fresh monitor straight to the floor in the final window, not the opening rung). So:
 *   - armed + auction CLOSED                            -> setBidOverride/clearBidOverride refuse (GONE)
 *   - armed + DANGER ZONE (deadline past, still open)   -> ACCEPTED (re-price applies)
 *   - armed + comfortably open                          -> ACCEPTED
 * Pure store-level checks (no engine): the guard lives in priceRequests.js.
 *   node scripts/test-reprice-cutoff.js
 */
const assert = require('assert');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { createStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const BAND = [12, 10, 8];
const NEW_BAND = [10, 8, 6.3];
const mkStore = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: BAND, minMarginPct: 6.3 });
const mkLoad = (id, closesInMs = 30 * 60_000) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL',
  units: 1, companyName: 'Durian Industries', closesAt: Date.now() + closesInMs, startsAt: Date.now() - 1000, status: 'live', softClose: false });

async function throwsGone(fn, msg) {
  try { await fn(); assert.fail(`expected GONE, got success: ${msg}`); }
  catch (e) { assert.strictEqual(e.code, 'GONE', `${msg} (got code=${e.code}, message=${e.message})`); }
}
async function armed(rq, id) {
  const created = await rq.createForLoad(mkLoad(id), { deadlineAt: Date.now() + 60_000 });
  await rq.capture(created.id, { cost: 45_000 }); // -> armed
  return created.id;
}
// move the auction's close (and deadline) into the past -> genuinely closed on the portal
async function closeAuction(rq, id) {
  const d = await rq.getByToken(id);
  await rq.store.patchDoc(COLLECTION, id, { load: { ...(d.load || {}), closesAt: Date.now() - 1_000 }, deadlineAt: Date.now() - 40_000 });
}
// move only the deadline into the past (auction still open) -> the danger zone
async function enterDangerZone(rq, id) {
  await rq.store.patchDoc(COLLECTION, id, { deadlineAt: Date.now() - 1_000 });
}

(async () => {
  // 1) armed + auction CLOSED -> setBidOverride refused
  {
    const rq = mkStore(); const id = await armed(rq, 'CLOSED-SET'); await closeAuction(rq, id);
    await throwsGone(() => rq.setBidOverride(id, { marginsPct: NEW_BAND, minMarginPct: 6.3, cost: 40_000 }, { setBy: 'pricing' }),
      'setBidOverride on a CLOSED auction is refused');
    ok('setBidOverride past the real close -> GONE');
  }

  // 2) armed + auction CLOSED -> clearBidOverride (revert) refused (same rebuild risk)
  {
    const rq = mkStore(); const id = await armed(rq, 'CLOSED-CLEAR'); await closeAuction(rq, id);
    await throwsGone(() => rq.clearBidOverride(id), 'clearBidOverride on a CLOSED auction is refused');
    ok('clearBidOverride past the real close -> GONE');
  }

  // 3) armed + DANGER ZONE (deadline passed, auction still open) -> re-price ACCEPTED best-effort
  {
    const rq = mkStore(); const id = await armed(rq, 'DANGER-SET'); await enterDangerZone(rq, id);
    const updated = await rq.setBidOverride(id, { marginsPct: NEW_BAND, minMarginPct: 6.3, cost: 40_000 }, { setBy: 'pricing' });
    assert.strictEqual(updated.price.cost, 40_000, 'danger-zone re-price applies the new cost (accepted, not refused)');
    assert.deepStrictEqual(updated.marginsPct, NEW_BAND, 'danger-zone re-price applies the new band');
    ok('setBidOverride in the danger zone (deadline passed, auction open) is ACCEPTED best-effort');
  }

  // 4) armed + comfortably open -> re-price accepted (regression: the guard must not over-block)
  {
    const rq = mkStore(); const id = await armed(rq, 'OPEN-SET');
    const updated = await rq.setBidOverride(id, { marginsPct: NEW_BAND, minMarginPct: 6.3, cost: 41_000 }, { setBy: 'pricing' });
    assert.strictEqual(updated.price.cost, 41_000, 're-price on a comfortably-open load applies normally');
    ok('setBidOverride on a comfortably-open load is accepted (no over-block)');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
