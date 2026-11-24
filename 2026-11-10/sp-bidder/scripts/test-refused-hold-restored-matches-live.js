'use strict';
/**
 * @requires-summary-line
 * A refused price restored after a restart must bid exactly as the live run it came from (verifier of
 * da45d49, 26 Sep). A live non-cap refusal leaves the refused rung marked tried but rolls the ladder
 * position back (bidEngine D3 repair), so the restored-state hold may do the same and no more. Each
 * check runs one shape twice - the refusal happening live, and the same refusal restored as a held
 * price - and compares the prices that went out, with their countdowns (the live run's refused write
 * itself is left out: in the restored run that write happened before the restart).
 *
 *   node scripts/test-refused-hold-restored-matches-live.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 6;
const REFUSAL = 'Quote could not be updated';
const SPB = { cost: 87_400, marginsPct: [15.3, 12, 9, 6.5, 4.5], minMarginPct: 3 };
const B6 = { cost: 87_400, marginsPct: [15.3, 13, 11, 9, 7, 4.5], minMarginPct: 3 };
const GCBAND = { cost: 50_000, marginsPct: [9, 7.2, 3.6, 1.8], minMarginPct: 1 };
const SOFT_LIVE = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };

function seedRefused(r, price) {
  r.m._refusedPrice = price;
  r.m._refusedPriceVcq = null;
  r.m._refusedPriceCount = 3;
  r.m._refusedPriceUnrecognised = false;
  r.m._refusedPriceBody = REFUSAL;
}
const sent = (r) => r.writes.filter((w) => !w.refused).map((w) => `${w.price}@${w.cd}`);

// `setup(r)` builds the shape; `refusedIndex` is the rung refused live / restored as held.
async function compare(opts, setup, refusedIndex, drive) {
  const live = H.load(opts);
  setup(live);
  live.ctrl.refuse.push({ reason: REFUSAL, text: REFUSAL });
  await drive(live);
  live.done();
  const restored = H.load(opts);
  setup(restored);
  seedRefused(restored, restored.ladder[refusedIndex]);
  await drive(restored);
  restored.done();
  const liveRefused = live.writes.filter((w) => w.refused).map((w) => w.price);
  if (!H.same(liveRefused, [live.ladder[refusedIndex]])) return `HARNESS: the live run refused ${JSON.stringify(liveRefused)}, expected ${live.ladder[refusedIndex]}`;
  return H.same(sent(restored), sent(live)) ? null
    : `restored ${JSON.stringify(sent(restored))} differs from the live refusal ${JSON.stringify(sent(live))}`;
}
const sweep = (from, step, rank) => async (r) => { for (let cd = from; cd >= 0; cd -= step) await r.at(cd, { rank }); };

(async () => {
  console.log('refused price restored after a restart bids exactly as the live refusal');

  await H.check('S1: SP walk off, top rung refused, no bid landed, rank unknown - same writes as live', () =>
    compare({ sp: { revisionLimit: 10 }, walk: H.WALK_OFF }, () => {}, 0, sweep(30_000, 200, null)));

  await H.check('S2b: SP walk off, 5 prices, rung 0 landed, rung 1 refused, rank 3 - same writes as live', () =>
    compare({ band: SPB, sp: { revisionLimit: 10 }, walk: H.WALK_OFF }, (r) => r.seedStanding(0, 8), 1, sweep(30_000, 200, 3)));

  await H.check('S7: rank-driven (allowlisted, hard close), rung 0 landed, rung 1 refused at rank 2, then rank 3 - same writes as live', () =>
    compare({ band: B6, company: 'Havells India', softClose: SOFT_LIVE, sp: { closeModel: 'hard', revisionLimit: 10 }, walk: H.WALK_OFF },
      (r) => r.seedStanding(0, 8), 1, async (r) => {
        await r.at(20_000, { rank: 2 });
        await r.at(19_800, { rank: 3 });
        await r.at(19_600, { rank: 3 });
      }));

  await H.check('S3: GoComet walk off, rung 0 landed, rung 1 refused - 51,800 at 11,500 then 50,900 at 6,500, as live', async () => {
    const r = H.load({ platform: 'gc', band: GCBAND, walk: H.WALK_OFF, gc: { roundPolicy: { finalAfterExtensions: 0 } } });
    r.seedStanding(0, 3);
    seedRefused(r, r.ladder[1]);
    await sweep(30_000, 500, 2)(r);
    r.done();
    return H.same(sent(r), ['51800@11500', '50900@6500']) ? null : `restored sent ${JSON.stringify(sent(r))}`;
  });

  await H.check('walk on control: SP, top rung refused, rank unknown - the same prices at the same countdowns as live', () =>
    compare({ band: SPB, sp: { revisionLimit: 10 }, walk: H.walkCfg('sp', { stepTimeMs: 2_500 }) }, () => {}, 0, sweep(30_000, 200, null)));

  await H.check('walk on control: GoComet, rung 0 landed, rung 1 refused, rank 2 - the same prices at the same countdowns as live', () =>
    compare({ platform: 'gc', band: GCBAND, walk: H.walkCfg('gc'), gc: { roundPolicy: { finalAfterExtensions: 0 } } },
      (r) => r.seedStanding(0, 3), 1, sweep(30_000, 500, 2)));

  H.finish('restored refused price matches the live refusal', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
