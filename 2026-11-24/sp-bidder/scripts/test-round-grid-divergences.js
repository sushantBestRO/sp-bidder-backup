'use strict';
/**
 * THE ROUND-FIGURE GRID KEEPS THE SPACING IT WAS DERIVED FOR, AND SAYS WHY WHEN IT COSTS A PRICE.
 *
 * All four are latent while the grid is off (DEFAULT_ROUNDING.enabled false); a config edit turns
 * them on for an opted-in shipper. Regression targets:
 *   A052 - the post-snap re-check judged only the blended amount. On a per-truck-type load the snap
 *          could leave a cheap line's step under the portal minimum while the blend cleared it, and
 *          that rung was armed and reported clean.
 *   A053 - spacing was derived in raw rupees and then snapped onto a grid that cannot express it
 *          (150 on a 100 grid), pulling a middle step under the requirement; the shortfall corrective
 *          was computed in raw rupees too, so pressing it produced the identical refusal forever.
 *   A054 - the shortfall blamed the minimum gap ("needs Rs 10 between bids") when the prices were
 *          lost to the grid folding them onto one figure and every gap sent already cleared it.
 *   A059 - the re-arm warning was gated on the moved/dropped lists, which _planFor empties whenever
 *          the snap changed the ladder, so on a grid shipper it could never fire.
 *
 * What must not move: a shipper without the grid plans byte-identically, and a grid ladder whose
 * snapped steps already clear the requirement is unchanged.
 *
 *   node scripts/test-round-grid-divergences.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { decrementViolations, scaleLadderByType } = require('../src/engine/pricing');
const { ladderShortfall } = require('../src/pricing/ladderNotice');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmpFiles = [];
process.on('exit', () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} } });
const tmp = () => { const f = path.join(os.tmpdir(), `round-grid-${process.pid}-${tmpFiles.length}.json`); tmpFiles.push(f); return f; };
const GRID = { enabled: true, shippers: ['Round'], step: 100 };
const engines = [];
function mkEngine({ rounding, log } = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }), placeBid: async () => ({ accepted: true }),
  };
  const opts = { config: {}, softClose: { enabled: false }, onEvent: () => {} };
  if (log) opts.log = log;
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), opts);
  if (rounding) eng.setRounding(rounding);
  engines.push(eng);
  return eng;
}
const meta = (id, rules, companyName = 'Round Co') => ({ id, lane: { origin: 'Pune', destination: 'Delhi' }, units: 1,
  equipment: '32ft', companyName, closesAt: Date.now() + 3_600_000, rules });
const band = (cost, prices, minMarginPct) => ({ cost, marginsPct: prices.map((p) => (p / cost - 1) * 100),
  minMarginPct: minMarginPct != null ? minMarginPct : (prices[prices.length - 1] / cost - 1) * 100 });
const steps = (ladder) => ladder.slice(1).map((p, i) => ladder[i] - p);

console.log('\nA052 - a per-truck-type line never carries a step under the minimum after the snap');
const CBT = { cost: 50_000, types: [
  { index: 0, label: '32FT', match: 'a', count: 1, cost: 70_000 },
  { index: 1, label: '20FT', match: 'b', count: 1, cost: 30_000 }] };
{
  const rules = { minDecrement: 1000, costByType: CBT };
  const snapped = [56_000, 54_000, 52_400, 50_600];
  const flagged = decrementViolations(snapped, 1000, scaleLadderByType(snapped, CBT));
  ok(flagged.some((v) => v.toIndex === 2), `the post-snap detector flags a middle step one line cannot clear (${JSON.stringify(flagged)})`);
  const eng = mkEngine({ rounding: GRID });
  const m = eng.arm(meta('A052', rules), band(50_000, [56_000, 54_099, 52_400, 50_600]));
  const lines = scaleLadderByType(m.ladder, CBT);
  const short = lines.map((l) => ({ label: l.label, steps: steps(l.amounts) })).filter((l) => l.steps.some((g) => g < 1000));
  ok(short.length === 0, `no line of the armed ladder steps under Rs 1,000 (${m.ladder}; ${JSON.stringify(short)})`);
  ok(m.ladder.every((p) => p % 100 === 0) && m.ladder.length === 4, `and it keeps all four prices, on the grid (${m.ladder})`);
}

console.log('\nA053 - the grid does not pull a step under the requirement, and the corrective moves');
{
  const eng = mkEngine({ rounding: GRID });
  const rules = { minDecrement: 150 };
  // A 5% minimum (Rs 10,500) leaves room under the last price for a corrective to exist.
  const desk = band(10_000, [11_300, 11_150, 11_000, 10_850], 5);
  const armed = eng.arm(meta('A053', rules), desk).ladder;
  ok(steps(armed).every((g) => g >= 150), `every step of the armed ladder clears Rs 150 (${armed}; steps ${steps(armed)})`);
  const pv = eng.planPreview(meta('A053-pv', rules), desk);
  const first = ladderShortfall(pv);
  ok(!!first && first.costTarget != null && first.costTarget % 100 === 0,
    `the corrective names an on-grid last price (${first && first.costTarget})`);
  if (first && first.costTarget != null) {
    const retyped = band(10_000, [11_300, 11_150, 11_000, first.costTarget], 5);
    const again = ladderShortfall(eng.planPreview(meta('A053-pv2', rules), retyped));
    ok(!again || again.costTarget !== first.costTarget,
      `taking the corrective does not return the same refusal (${first.fact} -> ${again ? again.fact : 'no shortfall'})`);
  } else {
    ok(false, 'taking the corrective does not return the same refusal (no corrective to take)');
  }
}

console.log('\nA054 - a price lost to the grid is blamed on the grid, not the minimum gap');
{
  const eng = mkEngine({ rounding: GRID });
  const pv = eng.planPreview(meta('A054', { minDecrement: 10 }), band(1000, [1234, 1210, 1180]));
  const s = ladderShortfall(pv);
  ok(!!s, `the lost prices are still reported (${s && s.fact})`);
  ok(!!s && !/needs Rs 10 between bids/.test(s.fact), 'and the fact does not blame a Rs 10 gap every sent price already clears');
  ok(!!s && /Rs 100/.test(s.fact), 'it names the Rs 100 steps the customer takes prices in');
}

console.log('\nA059 - re-arming onto a ladder the grid changed is announced');
{
  const warns = [];
  const log = { debug() {}, info() {}, warn: (msg, payload) => warns.push({ msg, payload }), error() {} };
  const eng = mkEngine({ rounding: GRID, log });
  const desk = band(10_000, [11_300, 11_150, 11_000, 10_850]);
  eng.scheduler.upsert({ auctionId: 'A059', status: 'bidding', cost: desk.cost, marginsPct: desk.marginsPct,
    minMarginPct: desk.minMarginPct, ladder: [11_300, 11_150, 11_000, 10_850], firedRungs: [1], companyName: 'Round Co' });
  eng.arm(meta('A059', { minDecrement: 150 }), Object.assign({}, desk, { roundStep: 100 }));
  ok(warns.some((w) => /re-arming an existing intent onto a re-spaced ladder/.test(w.msg)),
    `the re-arm onto the snapped ladder logs the remap warning (${warns.map((w) => w.msg).join(' | ') || 'no warnings'})`);
}

console.log('\ncontrols - no grid, or a grid that already fits, plans exactly as before');
{
  const plain = mkEngine();
  const off = plain.arm(meta('C1', { minDecrement: 150 }, 'Plain Co'), band(10_000, [11_300, 11_150, 11_000, 10_850])).ladder;
  ok(same(off, [11_300, 11_150, 11_000, 10_850]), `a shipper off the grid keeps its ladder (${off})`);
  const eng = mkEngine({ rounding: GRID });
  const fits = eng.arm(meta('C2', { minDecrement: 150 }), band(10_000, [11_320, 11_110, 10_890, 10_590])).ladder;
  ok(same(fits, [11_300, 11_100, 10_800, 10_600]), `a grid ladder whose snapped steps already fit is the plain snap (${fits})`);
  // Review finding 2: a snap that folds two prices together but leaves every step clear of the
  // minimum is valid as snapped, and re-placing it would add a price back. [11390, 11330, ...] at a
  // Rs 50 minimum clears the minimum before the snap and folds 11,390 and 11,330 onto 11,300.
  {
    const got = mkEngine({ rounding: GRID }).planPreview(meta('C3-fold', { minDecrement: 50 }), band(10_000, [11_390, 11_330, 11_100, 10_900])).ladder;
    ok(same(got, [11_300, 11_100, 10_900]), `a valid folded snap comes back as snapped (${got})`);
  }
  // The reviewer's two ladders arm what f04380c armed. Their extra 11,200 is not the grid's: the
  // desk's second price sits under the Rs 100 minimum before any snap, and the minimum-gap
  // derivation (shipped before this branch) moves it to a legal slot, which the snap then rounds.
  for (const [desk, atF04380c] of [
    [[11_350, 11_320, 11_100, 10_900], [11_300, 11_200, 11_100, 10_900]],
    [[11_500, 11_150, 11_120, 11_000, 10_900], [11_500, 11_200, 11_100, 11_000, 10_900]],
  ]) {
    const got = mkEngine({ rounding: GRID }).planPreview(meta(`C3-${desk[0]}`, { minDecrement: 100 }), band(10_000, desk)).ladder;
    ok(same(got, atF04380c), `[${desk}] at a Rs 100 minimum arms as it did at f04380c (${got}, want ${atF04380c})`);
  }
}

for (const eng of engines) { for (const m of eng.monitors.values()) if (m.timer) clearTimeout(m.timer); }
const total = pass + fail;
if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
console.log(`\n${pass}/${total} checks passed`);
process.exit(0);
