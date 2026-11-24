'use strict';
/**
 * Our own floor standing is the end of the ladder, not a hold (BC-24, engine layer).
 *
 * On 260927Q4QF the provisional-close round shot landed the floor (168,640) and on the next decision
 * _decideProvisional read price = standing = floor as "no price improves on our standing bid": it
 * raised reprice_unreachable_ladder, recorded new_floor_above_standing_bid and logged "holding this
 * load" 6 ms after the portal accepted. That event became the false "New rate saved" on the desk
 * group. A hold means a re-priced band sits wholly ABOVE our standing bid; that one still raises.
 *
 * Walk on never takes this decision, and its runs are pinned byte for byte against the base tree.
 *
 * @requires-summary-line
 *
 *   node scripts/test-floor-landing-no-engine-hold.js
 */
process.env.PLATFORM = 'mock';
const H = require('./lib/walk-harness');

const Q4QF_BAND = { cost: 160_000, marginsPct: [9, 7.2, 5.4], minMarginPct: 5.4 };
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const HOLD_LOG = /holding this load/;

const holdsOf = (r) => r.events.filter((e) => e.type === 'alert' && e.kind === 'reprice_unreachable_ladder');
const holdLogsOf = (r) => r.logs.error.filter((l) => HOLD_LOG.test(l.m));

async function floorLands(opts, epoch) {
  const r = H.load(opts);
  r.m.repriceEpoch = epoch;
  const gc = opts.platform === 'gc';
  for (let cd = 25_000; cd >= (gc ? 1_000 : 200); cd -= (gc ? 500 : 100)) await r.at(cd, { rank: r.writes.length ? 2 : null });
  const seen = { holds: holdsOf(r).length, logs: holdLogsOf(r).length, noBid: r.m.noBid };
  r.eng.scheduler.update(r.m.auctionId, { landedBids: r.m.landedBids, landedBidPrice: r.m.lastBidPrice, everBid: true });
  await r.restart();
  r.m.repriceEpoch = epoch;
  for (let cd = 900; cd >= 100; cd -= 100) await r.at(cd, { rank: 2 });
  r.done();
  return { r, seen, floor: r.ladder[r.ladder.length - 1] };
}

function noHold(label, res) {
  const w = res.r.writes;
  if (!w.length || w[w.length - 1].price !== res.floor || w[w.length - 1].refused) {
    return `${label}: HARNESS: the floor did not land (${JSON.stringify(res.r.trace())})`;
  }
  const bad = [];
  if (res.seen.holds || res.seen.logs || res.seen.noBid) {
    bad.push(`${label}: after the floor landed the engine raised ${res.seen.holds} hold(s), logged ${res.seen.logs} "holding this load", recorded ${JSON.stringify(res.seen.noBid)}`);
  }
  const after = { holds: holdsOf(res.r).length, logs: holdLogsOf(res.r).length, noBid: res.r.m.noBid };
  if (after.holds || after.logs || after.noBid) {
    bad.push(`${label}: after a restart the engine raised ${after.holds} hold(s), logged ${after.logs}, recorded ${JSON.stringify(after.noBid)}`);
  }
  return bad.join('; ') || null;
}

// Recorded on e6abeb6 (v2.17.1): every write, every event kind and every scheduled tick of each run.
const WALK_ON_GOLDEN = {
  gc: {"trace": ["174400@19500", "171520@18000", "168640@16500"], "kinds": ["armed:", "bid_placed:", "rank_visible:", "bid_placed:", "rank_visible:", "bid_placed:", "alert:stood_down_at_floor", "rank_visible:", "alert:no_revisions_left", "alert:killed", "armed:", "alert:restart_with_live_auctions", "alert:no_revisions_left", "alert:killed"], "schedule": [2000, 1500, 1000, 500, 4000, 3500, 3000, 2500, 2000, 1500, 1000, 6500, 6000, 5500, 10500, 10000, 9500, 9000, 8500, 8000, 7500, 7000, 6500, 6000, 5500, 5000, 4500, 4000, 3500, 3000, 2500, 2000, 1500, 1000, 500, 1500, 1000, 500, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]},
  sp: {"trace": ["174400@6700", "171520@6500", "168640@6300"], "kinds": ["armed:", "bid_placed:", "rank_visible:", "bid_placed:", "rank_visible:", "bid_placed:", "alert:stood_down_at_floor", "rank_visible:", "alert:killed", "armed:", "alert:restart_with_live_auctions", "alert:killed"], "schedule": [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 100, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 100, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]},
};

function fingerprint(r) {
  return { trace: r.trace(), kinds: r.events.map((e) => `${e.type}:${e.kind || ''}`), schedule: r.schedule };
}

(async () => {
  await H.check('Q4QF: GoComet walk off, one capture - the floor lands and nothing reads it as a hold, before or after a restart', async () => {
    const res = await floorLands({ platform: 'gc', band: Q4QF_BAND, gc: FINAL_NOW, walk: H.WALK_OFF }, 0);
    if (res.floor !== 168_640) return `HARNESS: floor ${res.floor}, expected Q4QF's 168,640`;
    return noHold('Q4QF', res);
  });

  await H.check('GoComet walk off, after an earlier correction that kept bidding - the floor lands, no hold', async () =>
    noHold('epoch 1', await floorLands({ platform: 'gc', band: Q4QF_BAND, gc: FINAL_NOW, walk: H.WALK_OFF }, 1)));

  await H.check('SuperProcure walk off - the floor lands, no hold', async () =>
    noHold('SP', await floorLands({ sp: { revisionLimit: 5 }, band: Q4QF_BAND, walk: H.WALK_OFF }, 0)));

  await H.check('control: a correction whose whole band sits above our standing bid still holds, once, with the refusal and the log', async () => {
    const r = H.load({ platform: 'gc', band: Q4QF_BAND, gc: FINAL_NOW, walk: H.WALK_OFF });
    r.m.repriceEpoch = 1;
    const standing = 150_000;
    r.m.landedBids = 1;
    r.m.lastBidPrice = standing;
    r.m.everBid = true;
    r.m.ownBidAttempts = 1;
    r.ctrl.myAmount = standing;
    for (let cd = 25_000; cd >= 1_000; cd -= 500) await r.at(cd, { rank: 2 });
    r.done();
    const holds = holdsOf(r);
    const bad = [];
    if (r.writes.length) bad.push(`a held load wrote ${JSON.stringify(r.trace())}`);
    if (holds.length !== 1) bad.push(`raised ${holds.length} hold(s), expected exactly 1`);
    else if (holds[0].standingBidPrice !== standing || holds[0].floor !== 168_640 || holds[0].repriceEpoch !== 1) {
      bad.push(`hold carried ${JSON.stringify({ standing: holds[0].standingBidPrice, floor: holds[0].floor, epoch: holds[0].repriceEpoch })}`);
    }
    if (!r.m.noBid || r.m.noBid.reason !== 'new_floor_above_standing_bid') bad.push(`refusal ${JSON.stringify(r.m.noBid)}`);
    if (holdLogsOf(r).length !== 1) bad.push(`logged "holding this load" ${holdLogsOf(r).length} time(s), expected 1`);
    return bad.join('; ') || null;
  });

  await H.check('walk on is byte-identical to the base tree (GoComet and SuperProcure, Q4QF band)', async () => {
    const gc = await floorLands({ platform: 'gc', band: Q4QF_BAND, gc: FINAL_NOW, walk: H.walkCfg('gc') }, 0);
    const sp = await floorLands({ sp: { revisionLimit: 5 }, band: Q4QF_BAND,
      walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 }) }, 0);
    const got = { gc: fingerprint(gc.r), sp: fingerprint(sp.r) };
    if (process.env.WALK_RECORD) { console.log(`    RECORD ${JSON.stringify(got)}`); return null; }
    const bad = [];
    for (const k of ['gc', 'sp']) if (!H.same(got[k], WALK_ON_GOLDEN[k])) bad.push(`${k}: ${JSON.stringify(got[k])}`);
    return bad.length ? `walk on moved: ${bad.join('; ')}` : null;
  });

  H.finish('Our own floor standing is never a hold', 5);
})();
