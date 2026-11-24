'use strict';
/**
 * @requires-summary-line
 * GoComet's no-read final shot after our own accepted write (28 Sep, v2.17.1).
 *
 * 260928DDQK (won): the first step's submit response said rank 1, and 13 ms later the no-read shot
 * sent the lowest price on the pre-bid read (rank unknown), giving away Rs 450. The same shot through
 * the clock timer (_walkClockFire) had the same hole.
 * 260928J43Q and 26092834TN: our probe's submit response opened the final round, and the no-read shot
 * timed the lowest price on the previous round's countdown, about 300 s before the true close. The
 * write, timed on that old close, then read GoComet's countdown as a second move: a phantom round 4,
 * r_exceeds_cap, and a final close 5 minutes late on the closed record and the result message.
 *
 * GoComet counts bid_closing_in in whole seconds from before we receive it, so a response close can read
 * about a second late; the last step must never go later than it does off the read before the write.
 * A response without a rank leaves the rank unknown: the shot waits for a fresh read only until its
 * deadline, then treats us as outranked (design D-C) and fires when the pre-fix engine did. A rank 1 our
 * own write returned stands until a newer read or response replaces it, however old the queued response.
 *
 * Timing as live: manual step 2,500, land 4,500, safety 200 (clock error 100 + margin 100). Closes on
 * whole seconds, response countdowns in whole seconds.
 *
 *   node scripts/test-walk-gocomet-response-rank-holds.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 12;
const GC_STEP_MS = 299_000;
const WALK = H.walkCfg('gc', { stepTimeMs: 2_500, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 10_000, probeLeadMs: 9_000 });

// DDQK: band 13,625 / 13,175, FINAL round, no standing bid, 3 attempts; first step decided at 6,355 ms,
// write 1,713 ms, next tick 12 ms after it landed.
const DDQK_BAND = { cost: 12_500, marginsPct: [9, 5.4], minMarginPct: 1 };
const [TOP, LOWEST] = [13_625, 13_175];
const DDQK_WRITE_MS = 1_713;
// The rank-2 lowest-price countdown the pre-fix engine (e6abeb6) sends on this shape: the timing a
// response may never push later.
const MAIN_RANK2_LOWEST_CD = 4_629;

// J43Q: round 2 of the default cap 3, rank 4, standing at the top price with 3 attempts. The probe is
// decided at 8,095 ms and lands with 2,698 ms left; its response opens round 3 (+299 s).
const J43Q_BAND = { cost: 190_000, marginsPct: [13, 11.9, 9.9, 8.2], minMarginPct: 1 };
const J43Q_PROBE_WRITE_MS = 5_397;
const J43Q_WRITE_MS = 300;

const GOLDEN = {
  ddqkRank1: ['13175@6355'],
  ddqkRank2: ['13175@6355'],
  ddqkRank2Late: ['13175@6355'],
  j43q: ['212610@8095', '208810@7200', '205580@4700'],
  ranklessRank1: ['13625@7200', '13175@5500'],
  j43qRankless: ['212610@8095', '208810@7200', '205580@4700'],
  rank1ThenRank2: ['13625@7200', '13175@5500'],
};
// The lowest-price countdown e6abeb6 sends on the rank-1-then-rank-2 script, walk on.
const MAIN_RANK1_THEN_RANK2_CD = 5_500;

function wholeSecondClose(r) {
  r.ctrl.close = Math.ceil(r.ctrl.close / 1000) * 1000;
}

// GoComet's submit response: whole-second bid_closing_in, computed `latMs` before we receive it.
function respond(r, res, rank, latMs) {
  res.myRank = rank;
  res.bidClosingInMs = latMs == null ? undefined : Math.round((r.ctrl.close - H.now() + latMs) / 1000) * 1000;
  r.ctrl.rank = rank;
}

function ddqk(walk, responseRank, latMs = 0, writeMs = DDQK_WRITE_MS) {
  const r = H.load({ platform: 'gc', band: DDQK_BAND, walk, gc: { roundPolicy: { finalAfterExtensions: 0 }, clockErrorMs: 100 } });
  wholeSecondClose(r);
  const place = r.adapter.placeBid;
  r.adapter.placeBid = async (...a) => {
    const res = await place(...a);
    if (res.accepted) {
      H.setNow(H.now() + writeMs);
      respond(r, res, responseRank, latMs);
    }
    return res;
  };
  return r;
}

async function ddqkScript(r) {
  await r.at(6_355, { rank: null });
  for (const cd of [4_629, 3_000, 1_000]) await r.at(cd);
}

async function ddqkPair(responseRank, latMs) {
  const off = ddqk(H.WALK_OFF, responseRank, latMs);
  await ddqkScript(off);
  off.done();
  const on = ddqk(WALK, responseRank, latMs);
  await ddqkScript(on);
  on.done();
  return { off, on };
}

function j43q(walk, responseRank = 4) {
  const r = H.load({ platform: 'gc', band: J43Q_BAND, walk, gc: { clockErrorMs: 100 } });
  wholeSecondClose(r);
  const place = r.adapter.placeBid;
  let writes = 0;
  r.adapter.placeBid = async (...a) => {
    const res = await place(...a);
    if (res.accepted) {
      writes += 1;
      if (writes === 1) {
        H.setNow(H.now() + J43Q_PROBE_WRITE_MS);
        r.ctrl.close += GC_STEP_MS;
      } else {
        H.setNow(H.now() + J43Q_WRITE_MS);
      }
      respond(r, res, responseRank, 0);
    }
    return res;
  };
  return r;
}

// Two rounds observed (R2 of C3), the probe at 8,095, the tick 8 ms after it lands, then the new round.
async function j43qToProbe(r) {
  r.seedStanding(0, 3);
  for (let i = 0; i < 2; i++) {
    r.ctrl.close += GC_STEP_MS;
    await r.at(GC_STEP_MS, { rank: 4 });
  }
  await r.at(20_000, { rank: 4 });
  await r.at(8_095, { rank: 4 });
}

async function j43qScript(r) {
  await j43qToProbe(r);
  await r.at(r.ctrl.close - H.now() - 8);
  for (const cd of [200_000, 20_000, 7_200, 4_700, 3_000, 1_000]) await r.at(cd, { rank: 4 });
}

function j43qEarly(on) {
  const lowest = on.ladder[on.ladder.length - 1];
  const [probe, ...rest] = on.writes;
  const bad = [];
  if (!probe || probe.cd !== 8_095) bad.push(`HARNESS: no probe at 8,095 (${JSON.stringify(on.trace())})`);
  const early = rest.filter((w) => w.cd > WALK.gocomet.maxWalkWindowMs);
  if (early.length) bad.push(`walk on sent ${JSON.stringify(early.map((w) => `${w.price}@${w.cd}`))} before the final round's walk window`);
  const low = rest.find((w) => w.price === lowest);
  if (!low || !(low.cd > 0 && low.cd <= 7_200)) bad.push(`the lowest ${lowest} did not go inside the final round's last 7,200 ms: ${JSON.stringify(on.trace())}`);
  return bad;
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res)); };

// One tick at countdown `cd` whose portal read never answers; returns what it wrote meanwhile.
async function hungTick(r, cd) {
  r.ctrl.readDefer = true;
  H.setNow(r.ctrl.close - cd);
  const before = r.writes.length;
  const tick = r.eng._tick(r.m);
  await settle();
  const sent = r.writes.slice(before).map((w) => `${w.price}@${w.cd}`);
  if (r.ctrl.releaseRead) r.ctrl.releaseRead();
  r.m.finalized = true;
  await tick;
  r.done();
  return sent;
}

(async () => {
  console.log('T9 walk - GoComet no-read shot after our own accepted write');

  await H.check('DDQK: the submit response says rank 1 -> no second step; the load holds at the top price', async () => {
    const { off, on } = await ddqkPair(1, 0);
    const bad = [];
    if (on.ladder[0] !== TOP || on.ladder[on.ladder.length - 1] !== LOWEST) bad.push(`HARNESS: ladder ${JSON.stringify(on.ladder)}`);
    if (!H.same(on.trace(), [`${TOP}@6355`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only ${TOP} at 6,355`);
    const ctl = H.offMatches('ddqkRank1', off.trace(), GOLDEN.ddqkRank1);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('DDQK shape, the response says rank 2 -> the lowest price goes on the next tick (4,629)', async () => {
    const { off, on } = await ddqkPair(2, 0);
    const bad = [];
    if (!H.same(on.trace(), [`${TOP}@6355`, `${LOWEST}@${MAIN_RANK2_LOWEST_CD}`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${TOP}@6355 then ${LOWEST}@4629`);
    const ctl = H.offMatches('ddqkRank2', off.trace(), GOLDEN.ddqkRank2);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('rank 2, the response countdown counted 900 ms before we got it (its close snaps 1 s late) -> the lowest goes no later than before the fix', async () => {
    const { off, on } = await ddqkPair(2, 900);
    const bad = [];
    const low = on.writes.find((w) => w.price === LOWEST);
    if (!low) bad.push(`walk on never sent the lowest: ${JSON.stringify(on.trace())}`);
    else if (low.cd < MAIN_RANK2_LOWEST_CD) bad.push(`the lowest went at ${low.cd} ms, later than ${MAIN_RANK2_LOWEST_CD} ms before the fix (${JSON.stringify(on.trace())})`);
    const ctl = H.offMatches('ddqkRank2Late', off.trace(), GOLDEN.ddqkRank2Late);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('the clock timer fires right after a write whose response says rank 1 -> nothing is sent on the pre-bid read', async () => {
    const r = ddqk(WALK, 1, 0);
    await r.at(6_355, { rank: null });
    const before = r.writes.length;
    await r.eng._walkClockFire(r.m);
    const sent = r.writes.slice(before).map((w) => `${w.price}@${w.cd}`);
    r.done();
    return sent.length ? `the clock timer sent ${JSON.stringify(sent)} while our response said rank 1` : null;
  });

  await H.check('J43Q: the probe response opens the final round -> no step until that round\'s own deadline, the lowest in its last seconds', async () => {
    const off = j43q(H.WALK_OFF);
    await j43qScript(off);
    off.done();
    const on = j43q(WALK);
    await j43qScript(on);
    on.done();
    const bad = j43qEarly(on);
    const ctl = H.offMatches('j43q', off.trace(), GOLDEN.j43q);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('J43Q: a write decided on the pre-probe read books no phantom round; the record keeps round 3 and the true close', async () => {
    const r = j43q(WALK);
    await j43qToProbe(r);
    const stale = r.m._lastOkState;
    const trueClose = r.ctrl.close;
    const bad = [];
    const v0 = r.eng.roundVerdict(r.m);
    if (v0.rounds !== 3 || v0.verdict !== 'FINAL' || r.m.believedCloseAt !== trueClose) {
      bad.push(`HARNESS: after the probe R${v0.rounds} ${v0.verdict}/${v0.reason}, close ${r.m.believedCloseAt} vs ${trueClose}`);
    }
    H.setNow(H.now() + 3_433);
    const decidedAt = H.now() - 3_000;
    r.eng._observeOwnWrite(r.m, stale, { bidClosingInMs: Math.round((trueClose - H.now()) / 1000) * 1000 }, decidedAt, H.now(), v0.roundId);
    const v = r.eng.roundVerdict(r.m);
    const rec = r.eng._roundRecord(r.m);
    if (v.rounds !== 3) bad.push(`the tracker booked round ${v.rounds} (${v.verdict}/${v.reason})`);
    if (v.reason === 'r_exceeds_cap') bad.push('the round reads r_exceeds_cap');
    if (r.m.believedCloseAt !== trueClose) bad.push(`believed close moved ${(r.m.believedCloseAt - trueClose) / 1000} s past the true close`);
    if (!rec || rec.rounds !== 3) bad.push(`closed-record round ${JSON.stringify(rec)}`);
    r.done();
    return bad.join('; ') || null;
  });

  await H.check('rankless response, no fresh read arrives by the deadline -> rank unknown counts as outranked; the lowest goes no later than before the fix', async () => {
    const r = ddqk(WALK, null, 0);
    await r.at(6_355, { rank: null });
    r.ctrl.readDefer = true;
    H.setNow(r.ctrl.close - MAIN_RANK2_LOWEST_CD);
    const tick = r.eng._tick(r.m);
    await settle();
    const sent = r.writes.slice(1).map((w) => ({ price: w.price, cd: w.cd }));
    if (r.ctrl.releaseRead) r.ctrl.releaseRead();
    await tick;
    r.done();
    const low = sent.find((w) => w.price === LOWEST);
    if (!low) return `nothing was sent at ${MAIN_RANK2_LOWEST_CD} ms while the read hung (${JSON.stringify(sent)})`;
    return low.cd < MAIN_RANK2_LOWEST_CD ? `the lowest went at ${low.cd} ms, later than ${MAIN_RANK2_LOWEST_CD} ms before the fix` : null;
  });

  await H.check('rankless response to a step at 7,200 (write 300 ms), a fresh read shows rank 1 at 5,500, before the deadline -> hold at the top price', async () => {
    const script = async (r) => {
      await r.at(7_200, { rank: null });
      await r.at(5_500, { rank: 1 });
      for (const cd of [4_629, 3_000, 1_000]) await r.at(cd, { rank: 1 });
    };
    const off = ddqk(H.WALK_OFF, null, 0, 300);
    await script(off);
    off.done();
    const on = ddqk(WALK, null, 0, 300);
    await script(on);
    on.done();
    const bad = [];
    if (!H.same(on.trace(), [`${TOP}@7200`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only ${TOP} at 7,200`);
    const ctl = H.offMatches('ranklessRank1', off.trace(), GOLDEN.ranklessRank1);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check("J43Q with a rankless probe response -> the tracker's new round times the shot; no step before the final round's window", async () => {
    const off = j43q(H.WALK_OFF, null);
    await j43qScript(off);
    off.done();
    const on = j43q(WALK, null);
    await j43qScript(on);
    on.done();
    const ctl = H.offMatches('j43qRankless', off.trace(), GOLDEN.j43qRankless);
    return j43qEarly(on).concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('rank-1 response now older than 1.5 s, no newer read (read hung at 3,000) -> hold, nothing lower is sent', async () => {
    const r = ddqk(WALK, 1, 0);
    await r.at(6_355, { rank: null });
    const sent = await hungTick(r, 3_000);
    return sent.length ? `sent ${JSON.stringify(sent)} while our own write's response said rank 1` : null;
  });

  await H.check('rank-1 response with no usable countdown (nothing queued), no newer read -> hold at the deadline', async () => {
    const r = ddqk(WALK, 1, null);
    await r.at(6_355, { rank: null });
    const sent = await hungTick(r, MAIN_RANK2_LOWEST_CD);
    return sent.length ? `sent ${JSON.stringify(sent)} while our own write's response said rank 1` : null;
  });

  await H.check('rank-1 response to a step at 7,200, then a newer read shows rank 2 at 5,500 -> the lowest goes no later than before the fix', async () => {
    const script = async (r) => {
      await r.at(7_200, { rank: null });
      await r.at(6_890);
      for (const cd of [5_500, 4_629, 3_000]) await r.at(cd, { rank: 2 });
    };
    const off = ddqk(H.WALK_OFF, 1, 0, 300);
    await script(off);
    off.done();
    const on = ddqk(WALK, 1, 0, 300);
    await script(on);
    on.done();
    const bad = [];
    const low = on.writes.find((w) => w.price === LOWEST);
    if (!low) bad.push(`walk on never sent the lowest: ${JSON.stringify(on.trace())}`);
    else if (low.cd < MAIN_RANK1_THEN_RANK2_CD) bad.push(`the lowest went at ${low.cd} ms, later than ${MAIN_RANK1_THEN_RANK2_CD} ms before the fix (${JSON.stringify(on.trace())})`);
    const ctl = H.offMatches('rank1ThenRank2', off.trace(), GOLDEN.rank1ThenRank2);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  H.finish('T9 walk - GoComet no-read shot after our own write', EXPECTED);
})();
