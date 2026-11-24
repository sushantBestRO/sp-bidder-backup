'use strict';
/**
 * @requires-summary-line
 * On SuperProcure the walk trusts a rank early only on evidence (owner ruling 26 Sep, merge scan of
 * 17e8f92). After our accepted step the socket shows our amount - and rank 1 - only after `showAfterMs`.
 * Trusting the stale rank 2 on time alone (1,200 ms) sent a lower price while we already held rank 1:
 * Rs 2,622 given away. Every row must give exactly the pre-merge (1fce56e) writes: one step, no second
 * price at rank 1. Engine timers run on the virtual clock.
 *
 *   node scripts/test-walk-settle-evidence.js
 */
const H = require('./lib/walk-harness');

const ROWS = [300, 1_000, 1_500, 1_800, 2_200];
const EXPECTED = ROWS.length;
const clock = H.useFakeTimers();
const WALK = H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 });
const BAND5 = { cost: 87_400, marginsPct: [15.3, 12, 9, 6.5, 4.5], minMarginPct: 3 };
const PRE_MERGE = ['97888@10700'];

async function run(showAfterMs) {
  const r = H.load({ band: BAND5, walk: WALK, keepTimers: true, sp: { revisionLimit: 10 } });
  const read = r.adapter.getAuctionState;
  r.adapter.getAuctionState = async (...a) => Object.assign(await read(...a), { pushFed: true });
  const place = r.adapter.placeBid;
  r.adapter.placeBid = async (...a) => {
    const before = r.ctrl.myAmount;
    const res = await place(...a);
    if (res.accepted) {
      r.ctrl.myAmount = before;
      setTimeout(() => { r.ctrl.myAmount = a[1]; r.ctrl.rank = 1; }, showAfterMs);
    }
    return res;
  };
  r.seedStanding(0, 8);
  await r.at(20_000, { rank: 2 });
  await clock.advanceTo(r.close - 500);
  r.m.finalized = true;
  const tr = r.trace();
  r.done();
  return tr;
}

(async () => {
  console.log('T9 walk - SuperProcure rank trusted early only on our own amount');
  for (const ms of ROWS) {
    await H.check(`our amount (and rank 1) shows ${ms} ms after the step: exactly the pre-merge writes ${JSON.stringify(PRE_MERGE)}`, async () => {
      const got = await run(ms);
      return H.same(got, PRE_MERGE) ? null : `sent ${JSON.stringify(got)}`;
    });
  }
  H.finish('T9 walk settle evidence', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
