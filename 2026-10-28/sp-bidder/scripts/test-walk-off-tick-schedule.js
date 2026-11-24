'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: walk-off identity covers the TICK SCHEDULE, not only the writes (engine review
 * of cd484de). With the walk switched off, every tick asks for the same next tick, and sends the same
 * prices, as the pre-T9 tip f04380c. Goldens were recorded by running this file on f04380c with
 * WALK_RECORD=1 (the harness passes the walk block, which that tip ignores).
 *
 *   node scripts/test-walk-off-tick-schedule.js
 */
const H = require('./lib/walk-harness');

const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };

const SCENARIOS = {
  spHard: {
    opts: {},
    script: async (r) => {
      for (const [cd, rank] of [[25_000, null], [9_700, null], [9_500, 2], [8_000, 1], [6_000, 1], [4_500, 2], [3_300, 2], [3_100, 2], [2_400, 2], [1_200, 2]]) {
        await r.at(cd, { rank });
      }
    },
  },
  spHardStanding: {
    opts: { sp: { revisionLimit: 3 } },
    script: async (r) => {
      r.seedStanding(0, 2);
      for (let cd = 12_000; cd >= 400; cd -= 800) await r.at(cd, { rank: 2 });
    },
  },
  gcFinal: {
    opts: { platform: 'gc', band: BAND_GC, gc: { roundPolicy: { finalAfterExtensions: 0 } } },
    script: async (r) => {
      r.seedStanding(0, 2);
      for (const cd of [60_000, 19_500, 12_000, 7_600, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 2 });
    },
  },
  gcUncappedExtend: {
    opts: { platform: 'gc', band: BAND_GC, gc: { roundPolicy: { finalAfterExtensions: null } } },
    script: async (r) => {
      r.seedStanding(0, 3);
      for (const cd of [60_000, 19_500, 7_500, 6_500, 4_000]) await r.at(cd, { rank: 2 });
      await r.extend(300_000, 200_000, { rank: 2 });
      for (const cd of [60_000, 19_500, 7_500, 6_500, 4_000]) await r.at(cd, { rank: 2 });
    },
  },
  gcCapped: {
    opts: { platform: 'gc', band: BAND_GC, gc: { roundPolicy: { finalAfterExtensions: 3 } } },
    script: async (r) => {
      r.seedStanding(0, 3);
      for (const cd of [60_000, 19_500, 12_000, 9_000, 6_500, 3_000]) await r.at(cd, { rank: 3 });
    },
  },
};

const GOLDEN = {
  spHard: { schedule: [1000, 200, 200, 200, 200, 200, 200, 200, 200, 200], writes: ['100772@25000', '96839@9500', '91333@2400'] },
  spHardStanding: { schedule: [1000, 1000, 1000, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200], writes: ['96839@12000', '91333@2400'] },
  gcFinal: { schedule: [1000, 1000, 1000, 1600, 1500, 200, 200, 200], writes: ['53600@12000', '50900@6500'] },
  gcUncappedExtend: { schedule: [1000, 1000, 1500, 200, 200, 30000, 1000, 1000, 1500, 200, 200], writes: ['53600@6500', '50900@6500'] },
  gcCapped: { schedule: [1000, 1000, 1000, 3000, 200, 200], writes: ['53600@12000', '50900@6500'] },
};

(async () => {
  console.log('T9 walk - walk-off tick schedule identity');
  const names = Object.keys(SCENARIOS);
  for (const name of names) {
    await H.check(`walk off, ${name}: the next-tick schedule and the writes are the pre-T9 tip's`, async () => {
      const r = H.load(Object.assign({}, SCENARIOS[name].opts, { walk: H.WALK_OFF }));
      await SCENARIOS[name].script(r);
      r.done();
      const got = { schedule: r.schedule, writes: r.trace() };
      if (process.env.WALK_RECORD) { console.log(`    RECORD ${name}: ${JSON.stringify(got)}`); return null; }
      return H.same(got, GOLDEN[name]) ? null : `moved from f04380c: base ${JSON.stringify(GOLDEN[name])}, now ${JSON.stringify(got)}`;
    });
  }
  H.finish('T9 walk-off tick schedule identity', names.length);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
