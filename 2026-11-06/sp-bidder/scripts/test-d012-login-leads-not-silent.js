'use strict';
/**
 * @requires-summary-line
 * D012's no-landing streak with the final-window walk (owner ruling 26 Sep). A close where our LOGIN
 * holds rank 1 - another writer's quote on the shared login (the autopilot, the desk), nothing of ours
 * landed - is not a silent failure: the login's quote leads, and the walk holds at rank 1 by ruling.
 * It must not count toward the streak, so two such closes in a row raise no D012 alert. Only D012's
 * counting changes: no new no-bid reason, and the close receipt is untouched.
 *
 * Controls: rank 2 at close with no bid and no reason, and rank unknown at close, still count; a close
 * with a landed bid resets the streak, as before.
 *
 *   node scripts/test-d012-login-leads-not-silent.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 5;
const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const SHAPES = {
  GC: { opts: { platform: 'gc', band: BAND_GC, gc: { roundPolicy: { finalAfterExtensions: 0 } } }, walk: H.walkCfg('gc'), step: 500 },
  SP: { opts: { sp: { revisionLimit: 3 } }, walk: H.walkCfg('sp'), step: 200 },
};

let seq = 0;
// One load driven through its final 30 s at `rank`, then closed with the portal reading `rank`; with
// `second`, a fresh load on the same engine (the same account) closed at once, nothing of ours on it.
async function closeAt(r, rank, { second } = {}) {
  let m = r.m;
  if (second) {
    m = r.eng.arm(Object.assign({}, r.meta, { id: `${r.meta.id}-x${++seq}` }), { cost: r.m.intent ? r.m.intent.cost : 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  } else {
    for (let cd = 30_000; cd >= 0; cd -= r.step) await r.at(cd, { rank });
  }
  r.ctrl.rank = rank;
  H.setNow(r.close + 1_000);
  await r.eng._finalize(m, Object.assign({}, m._lastOkState || {}, { ok: true, closesInMs: 0, myRank: rank }));
  return m;
}
function load(name) {
  const s = SHAPES[name];
  const r = H.load(Object.assign({}, s.opts, { walk: s.walk }));
  r.step = s.step;
  return r;
}

(async () => {
  console.log('D012: our login leading at rank 1 is not a silent close');

  await H.check('GC and SP, walk on, rank 1 throughout, no bid of ours: the streak stays 0, and two such closes raise no D012 alert', async () => {
    const bad = [];
    for (const name of ['GC', 'SP']) {
      const r = load(name);
      await closeAt(r, 1);
      if (r.writes.length) bad.push(`${name}: HARNESS: the walk bid ${JSON.stringify(r.trace())} at rank 1`);
      if ((r.eng._silentNoBidStreak || 0) !== 0) bad.push(`${name}: streak ${r.eng._silentNoBidStreak} after a close our login led`);
      await closeAt(r, 1, { second: true });
      if ((r.eng._silentNoBidStreak || 0) !== 0) bad.push(`${name}: streak ${r.eng._silentNoBidStreak} after two such closes`);
      const report = r.eng.noLandingReport(2);
      if (report) bad.push(`${name}: D012 alert ${JSON.stringify(report)}`);
      r.done();
    }
    return bad.join('; ') || null;
  });

  await H.check('control: rank 2 at close with no bid of ours and no reason still counts as silent (both portals)', async () => {
    const bad = [];
    for (const name of ['GC', 'SP']) {
      const r = load(name);
      await closeAt(r, 2, { second: true });
      r.done();
      if (r.eng._silentNoBidStreak !== 1) bad.push(`${name}: streak ${r.eng._silentNoBidStreak} after a rank-2 close with nothing of ours, expected 1`);
    }
    return bad.join('; ') || null;
  });

  await H.check('control: rank unknown at close still counts as silent (both portals)', async () => {
    const bad = [];
    for (const name of ['GC', 'SP']) {
      const r = load(name);
      await closeAt(r, null, { second: true });
      r.done();
      if (r.eng._silentNoBidStreak !== 1) bad.push(`${name}: streak ${r.eng._silentNoBidStreak} after a rank-unknown close, expected 1`);
    }
    return bad.join('; ') || null;
  });

  await H.check('control: two silent closes then a close with a landed bid - the streak resets to 0', async () => {
    const bad = [];
    for (const name of ['GC', 'SP']) {
      const r = load(name);
      await closeAt(r, 2, { second: true });
      await closeAt(r, 2, { second: true });
      if (r.eng._silentNoBidStreak !== 2) bad.push(`${name}: HARNESS: streak ${r.eng._silentNoBidStreak} before the landed close`);
      r.seedStanding(0, 2);
      await closeAt(r, 2);
      r.done();
      if (r.eng._silentNoBidStreak !== 0) bad.push(`${name}: streak ${r.eng._silentNoBidStreak} after a landed close, expected 0`);
    }
    return bad.join('; ') || null;
  });

  await H.check('the close record for a rank-1 close with nothing of ours is unchanged (no new no-bid reason)', async () => {
    const bad = [];
    for (const name of ['GC', 'SP']) {
      const r = load(name);
      await closeAt(r, 1);
      r.done();
      const res = r.events.find((e) => e.type === 'auction_result');
      if (!res || res.noBidReason != null) bad.push(`${name}: noBidReason ${res && res.noBidReason}`);
    }
    return bad.join('; ') || null;
  });

  H.finish('D012 login-leads close', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
