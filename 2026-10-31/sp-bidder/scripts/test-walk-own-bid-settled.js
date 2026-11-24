'use strict';
/**
 * @requires-summary-line
 * The walk trusts a rank on the same own-bid evidence as the soft-close holds (#256 _ownBidSettled),
 * integrated 26 Sep. After our own accepted walk step on a push-fed SuperProcure socket, the next step
 * goes as soon as the socket shows our amount (the #256 follow pulls the tick forward). When the
 * socket never shows it, the SuperProcure rank is NOT trusted on time alone: the next step waits for its
 * planned deadline (owner ruling 26 Sep, after the merge scan of 17e8f92). Engine timers run on the
 * virtual clock.
 *
 *   node scripts/test-walk-own-bid-settled.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 2;
const clock = H.useFakeTimers();
const WALK = H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 });
const BAND5 = { cost: 87_400, marginsPct: [15.3, 12, 9, 6.5, 4.5], minMarginPct: 3 };

// A push-fed socket (reads cost nothing) on which our own amount appears `showAfterMs` after each
// accepted bid, or never (null). Rank stays 2 throughout.
function rig(showAfterMs) {
  const r = H.load({ band: BAND5, walk: WALK, keepTimers: true, sp: { revisionLimit: 10 } });
  const read = r.adapter.getAuctionState;
  r.adapter.getAuctionState = async (...a) => Object.assign(await read(...a), { pushFed: true, myRank: 2 });
  const place = r.adapter.placeBid;
  r.adapter.placeBid = async (...a) => {
    const before = r.ctrl.myAmount;
    const res = await place(...a);
    if (res.accepted) {
      r.ctrl.myAmount = before;
      if (showAfterMs != null) setTimeout(() => { r.ctrl.myAmount = a[1]; }, showAfterMs);
    }
    return res;
  };
  r.seedStanding(0, 8);
  return r;
}
const gaps = (r) => r.writes.slice(1).map((w, i) => r.writes[i].cd - w.cd);

(async () => {
  console.log('T9 walk - the next step trusts rank on the #256 own-bid evidence');

  await H.check('our amount shows 300 ms after the accepted step: the next step goes within the 25 ms follow of it', async () => {
    const r = rig(300);
    await r.at(20_000, { rank: 2 });
    await clock.advanceTo(r.close - 2_000);
    r.m.finalized = true;
    r.done();
    const g = gaps(r);
    if (r.writes.length < 2) return `only ${JSON.stringify(r.trace())}`;
    return g[0] <= 300 + 25 + 1 ? null : `the second step went ${g[0]} ms after the first (${JSON.stringify(r.trace())}); expected about 300`;
  });

  // Named reversal (owner ruling 26 Sep): this check asked for a step at about rankSettleMs (1,200 ms);
  // on SuperProcure the walk trusts rank early only on evidence, so the step waits for its deadline.
  await H.check('our amount never shows: no early step on time alone - the second step goes at its planned deadline (2,500 ms after the first)', async () => {
    const r = rig(null);
    await r.at(20_000, { rank: 2 });
    await clock.advanceTo(r.close - 2_000);
    r.m.finalized = true;
    r.done();
    const g = gaps(r);
    if (r.writes.length < 2) return `only ${JSON.stringify(r.trace())}`;
    return g[0] === 2_500 ? null : `the second step went ${g[0]} ms after the first (${JSON.stringify(r.trace())}); expected its planned deadline, 2,500 ms`;
  });

  H.finish('T9 walk own-bid settled', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
