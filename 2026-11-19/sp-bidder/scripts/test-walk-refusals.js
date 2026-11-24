'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: refused steps (W6; rulings 20, 30, 48).
 *
 * A refused step re-derives the next price from the portal's stated limit ("amount should be less
 * than or equal to X"): the highest band price at or below X; with no band price at or below X but
 * X at or above the minimum-margin guard, ONE bid at X (the ruling-30 ceiling shape); with X below
 * the guard, the load stands down with the existing refusal notice and nothing below the minimum is
 * ever sent. A refusal that placed nothing gives its attempt back, so the walk can still spend it.
 *
 * SuperProcure hard close. Band cost 87,400, margins 15.3 / 10.8 / 4.5, minimum 3 -> 100,772 /
 * 96,839 / 91,333, guard 90,022. Safety 700, stepTime 2,000: the walk starts at 6,700.
 *
 *   node scripts/test-walk-refusals.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 4;
const [P0, , P2] = [100_772, 96_839, 91_333];
const GUARD = 90_022;
const walk2k = H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 });
const capRefusal = (x) => ({ reason: `Amount should be less than or equal to ${x}`, text: `Amount should be less than or equal to ${x}` });

const GOLDEN = {
  rederive: ['100772@25000x', '96839@24800', '91333@2400'],
  betweenGuard: ['100772@25000x'],
  belowGuard: ['100772@25000x'],
  refund: ['100772@25000x', '98675@24800', '91333@2400'],
};

(async () => {
  console.log('T9 walk - refused steps');

  await H.check('27 refused-step-rederives: SP refuses "<= 93,000" (between the middle and the lowest) -> the next bid is the lowest band price at or below it', async () => {
    const script = async (r) => {
      r.ctrl.refuse.push(capRefusal(93_000));
      for (const cd of [25_000, 24_800, 10_000, 6_700, 6_500, 6_000]) await r.at(cd, { rank: null });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), [`${P0}@6700x`, `${P2}@6500`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${P0} refused at 6,700 then ${P2} at 6,500`);
    const ctl = H.offMatches('rederive', off.trace(), GOLDEN.rederive);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('28 refused-limit-between-guard-and-lowest: "<= 90,500" (below every band price, above the minimum 90,022) -> one bid at 90,500, floor belt at the guard', async () => {
    const script = async (r) => {
      r.ctrl.refuse.push(capRefusal(90_500));
      for (const cd of [25_000, 24_800, 6_700, 6_500]) await r.at(cd, { rank: null });
      for (const cd of [6_000, 4_000, 2_400, 1_000]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), [`${P0}@6700x`, '90500@6500'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${P0} refused at 6,700 then one bid at 90,500`);
    const limitWrite = on.writes.find((w) => w.price === 90_500);
    if (limitWrite && limitWrite.floor !== GUARD) bad.push(`the bid at the limit went out with floor belt ${limitWrite.floor}, expected the guard ${GUARD}`);
    const ctl = H.offMatches('betweenGuard', off.trace(), GOLDEN.betweenGuard);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('29 refused-limit-below-guard: "<= 89,000" (below the minimum) -> stand down with the existing refusal notice; nothing below the minimum is ever sent', async () => {
    const script = async (r) => {
      r.ctrl.refuse.push(capRefusal(89_000));
      for (const cd of [25_000, 24_800, 6_700, 6_500, 4_000, 2_400, 1_000]) await r.at(cd, { rank: null });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), [`${P0}@6700x`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only ${P0} refused at 6,700`);
    if (on.writes.some((w) => w.price < GUARD)) bad.push('a price below the minimum went out');
    if (!on.events.some((e) => e.type === 'alert' && e.kind === 'bid_price_raise_refused')) bad.push('no bid_price_raise_refused notice was raised');
    if (!(on.m.noBid && on.m.noBid.reason === 'price_raise_refused')) bad.push(`the refusal recorded was ${JSON.stringify(on.m.noBid)}, expected price_raise_refused`);
    const ctl = H.offMatches('belowGuard', off.trace(), GOLDEN.belowGuard);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('30 refused-step-refunds: a refusal that placed nothing gives its attempt back -> with 2 bids the walk still lands two prices after it', async () => {
    const BAND4 = { cost: 87_400, marginsPct: [15.3, 12.9, 10.8, 4.5], minMarginPct: 3 };
    let leftAfterRefusal = null;
    const script = async (r) => {
      r.ctrl.refuse.push({ reason: 'Something went wrong, please try again', text: 'Something went wrong, please try again' });
      for (const cd of [25_000, 24_800, 10_000, 4_700]) await r.at(cd, { rank: null });
      leftAfterRefusal = r.m.revisionsLeft;
      await r.at(4_500, { rank: null });
      for (const cd of [4_300, 2_400]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair({ band: BAND4, sp: { revisionLimit: 2 } }, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), ['98675@4700x', '96839@4500', `${P2}@4300`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected 98675 refused at 4,700, then 96839 at 4,500 and ${P2} at 4,300`);
    if (leftAfterRefusal !== 2) bad.push(`bids left after the refusal: ${leftAfterRefusal}, expected 2 (ruling 20)`);
    const ctl = H.offMatches('refund', off.trace(), GOLDEN.refund);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  H.finish('T9 walk refused steps', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
