'use strict';
/**
 * Our own lowest price landing never sends "New rate saved. Bidding stopped on this load." (BC-24).
 *
 * Regression target: 260927Q4QF and nine other Waaree loads, 26-27 Sep. One capture, no re-price;
 * the provisional-close round shot put the floor (168,640) on the board, and 166 ms later the
 * engine's reprice_unreachable_ladder hold (price = standing = floor) went to the desk group as a
 * corrected-rate notice. The engine no longer raises that hold (test-floor-landing-no-engine-hold.js);
 * the server's routing chain is the second layer that would still keep it off WhatsApp. Every
 * platform, walk on and walk off, with and without an earlier correction.
 *
 * Real engine through the walk rig, events through the server's own routing chain. The last check
 * is the control: the same chain does deliver a genuine unshown correction hold.
 *
 * @requires-summary-line
 *
 *   node scripts/test-floor-landing-no-desk-hold-notice.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floor-landing-'));

const { stacks, notifier } = require('../src/web/server');
const H = require('./lib/walk-harness');

const EXPECTED = 10;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL - ' + m); } };
const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };

const sent = [];
notifier.alert = async (kind, data, opts) => { sent.push({ kind, data, dedupeKey: opts && opts.dedupeKey }); return true; };
const holdNotices = (id, from) => sent.slice(from).filter((s) => s.kind === 'desk_notice' && s.data
  && s.data.reason === 'reprice_unreachable_ladder' && String(s.data.auctionId) === String(id));

const Q4QF_BAND = { cost: 160_000, marginsPct: [9, 7.2, 5.4], minMarginPct: 5.4 };
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };

async function run({ platform, walk, epoch }) {
  const opts = platform === 'gc'
    ? { platform: 'gc', band: Q4QF_BAND, gc: FINAL_NOW, walk }
    : { sp: { revisionLimit: 5 }, band: Q4QF_BAND, walk };
  const r = H.load(opts);
  r.m.repriceEpoch = epoch;
  const [from, to, step] = platform === 'gc' ? [25_000, 1_000, 500] : [25_000, 200, 100];
  for (let cd = from; cd >= to; cd -= step) await r.at(cd, { rank: r.writes.length ? 2 : null });
  // A restart re-raises the hold: the engine's once-per-load latch is in memory.
  r.eng.scheduler.update(r.m.auctionId, { landedBids: r.m.landedBids, landedBidPrice: r.m.lastBidPrice, everBid: true });
  await r.restart();
  r.m.repriceEpoch = epoch;
  for (let cd = 900; cd >= 100; cd -= 100) await r.at(cd, { rank: 2 });
  r.done();
  const floor = r.ladder[r.ladder.length - 1];
  const holds = r.events.filter((e) => e.type === 'alert' && e.kind === 'reprice_unreachable_ladder');
  const mark = sent.length;
  for (const e of r.events) stacks[0].engine.onEvent(e);
  await settle();
  return { r, floor, holds, notices: holdNotices(r.m.auctionId, mark) };
}

(async () => {
  const realNow = H.REAL_NOW;
  try {
    console.log('\nThe Q4QF shape: GoComet, walk off, one capture, the floor lands');
    const q = await run({ platform: 'gc', walk: H.WALK_OFF, epoch: 0 });
    const last = q.r.writes[q.r.writes.length - 1];
    if (!last || last.price !== q.floor || last.refused) throw new Error(`setup: the floor did not land (${JSON.stringify(q.r.trace())})`);
    ok(q.floor === 168_640 && q.holds.length === 0, `the engine raises no hold over its own floor (floor ${q.floor}, holds ${q.holds.length})`);
    ok(q.notices.length === 0, `and no "New rate saved" goes to the desk (sent ${q.notices.length})`);

    console.log('\nSecond layer: the hold exactly as the engine raised it on Q4QF is kept off WhatsApp');
    const e0 = { type: 'alert', level: 'error', kind: 'reprice_unreachable_ladder', auctionId: 'Q4QF-EVENT',
      standingBidPrice: 168_640, correctedCost: 160_000, repriceEpoch: 0, floor: 168_640, opening: 174_400,
      price: 168_640, reachAt: 168_639, lane: q.r.m.meta.lane, companyName: q.r.m.meta.companyName };
    {
      const mark = sent.length;
      stacks[0].engine.onEvent(e0);
      stacks[0].engine.onEvent(Object.assign({}, e0, { repriceEpoch: 1 }));
      await settle();
      ok(holdNotices('Q4QF-EVENT', mark).length === 0, `routed at epoch 0 and epoch 1, nothing is sent (sent ${holdNotices('Q4QF-EVENT', mark).length})`);
    }

    const matrix = [
      ['GoComet, walk off, after an earlier correction that kept bidding', { platform: 'gc', walk: H.WALK_OFF, epoch: 1 }],
      ['GoComet, walk on', { platform: 'gc', walk: H.walkCfg('gc'), epoch: 0 }],
      ['GoComet, walk on, after an earlier correction', { platform: 'gc', walk: H.walkCfg('gc'), epoch: 1 }],
      ['SuperProcure, walk off', { platform: 'sp', walk: H.WALK_OFF, epoch: 0 }],
      ['SuperProcure, walk off, after an earlier correction', { platform: 'sp', walk: H.WALK_OFF, epoch: 1 }],
      ['SuperProcure, walk on', { platform: 'sp', walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 }), epoch: 0 }],
    ];
    console.log('\nEvery other path: the floor lands, nothing goes to the desk');
    for (const [label, cfg] of matrix) {
      const res = await run(cfg);
      const w = res.r.writes;
      if (!w.length || w[w.length - 1].price !== res.floor) throw new Error(`setup (${label}): the floor did not land (${JSON.stringify(res.r.trace())})`);
      ok(res.notices.length === 0, `${label}: engine raised ${res.holds.length} hold(s), desk notices sent ${res.notices.length}`);
    }

    console.log('\nControl: the same chain delivers a correction hold the page did not show');
    {
      const genuine = Object.assign({}, e0, { auctionId: 'CONTROL-1', repriceEpoch: 1, floor: e0.standingBidPrice + 1_000 });
      const mark = sent.length;
      stacks[0].engine.onEvent(genuine);
      await settle();
      ok(holdNotices('CONTROL-1', mark).length === 1, `one notice for a floor above our standing bid under a correction (sent ${holdNotices('CONTROL-1', mark).length})`);
    }
  } finally {
    Date.now = realNow;
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail || pass !== EXPECTED) {
    console.log(`FAIL - ${fail} failed, ${pass} passed, expected ${EXPECTED}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
