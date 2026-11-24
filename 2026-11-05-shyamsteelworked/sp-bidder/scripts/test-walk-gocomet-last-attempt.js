'use strict';
/**
 * @requires-summary-line
 * GoComet never forfeits its last attempt in a round the tracker calls not final (29 Sep, v2.19.0).
 *
 * 260928NXAW, 2609283YDV, 2609288XIY (all lost at rank 2): cap 3, 3 attempts. The R0 and R1 probes each
 * landed about 5 s before the buzzer and each extended the close. In R2 (NOT_FINAL, 2 rounds < cap 3)
 * we were at rank 2 with one attempt left; the walk kept it for a final round that only opens if
 * someone bids in R2's window. Nobody did, and the auction closed with our lowest band price unsent.
 * The last attempt now goes as the lowest at the round's last-step deadline, on a fresh read or on the
 * clock, as it already did on SuperProcure (B017).
 *
 * Timing as live: step 2,500, land 4,500, safety 200 (clock error 100 + margin 100), probe lead 9,000.
 * Band as NXAW: cost 85,000 -> 92,650 / 91,120 / 89,590.
 *
 *   node scripts/test-walk-gocomet-last-attempt.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 7;
const GC_STEP_MS = 299_000;
const WRITE_MS = 1_300;
const WALK = H.walkCfg('gc', { stepTimeMs: 2_500, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 10_000, probeLeadMs: 9_000 });
const BAND = { cost: 85_000, marginsPct: [9, 7.2, 5.4], minMarginPct: 1 };
const [P0, P1, LOWEST] = [92_650, 91_120, 89_590];
const DEADLINE_CD = 4_700;

const GOLDEN = {
  clock: ['92650@8000', '91120@8400'],
  read: ['92650@8000', '91120@8400'],
};

// Every accepted write lands inside the window and extends the close, as our probes did on NXAW.
function nxaw(walk, { rankAfter = 2 } = {}) {
  const r = H.load({ platform: 'gc', band: BAND, walk, gc: { clockErrorMs: 100 } });
  r.ctrl.close = Math.ceil(r.ctrl.close / 1000) * 1000;
  const place = r.adapter.placeBid;
  r.adapter.placeBid = async (...a) => {
    const res = await place(...a);
    if (res.accepted) {
      H.setNow(H.now() + WRITE_MS);
      r.ctrl.close += GC_STEP_MS;
      res.myRank = rankAfter;
      res.bidClosingInMs = Math.round((r.ctrl.close - H.now()) / 1000) * 1000;
      r.ctrl.rank = rankAfter;
    }
    return res;
  };
  return r;
}

// R0 unbid probe at 8,000; R1 probe at 8,400; into R2 with one attempt, read last at 8,466.
async function toRound2(r, rank = 2) {
  await r.at(60_000, { rank: null });
  await r.at(8_000, { rank: null });
  await r.at(r.ctrl.close - H.now() - 20, {});
  await r.at(60_000, { rank });
  await r.at(8_400, { rank });
  await r.at(r.ctrl.close - H.now() - 20, {});
  await r.at(60_000, { rank });
  await r.at(8_466, { rank });
}

async function clockScript(r) {
  await toRound2(r);
  H.setNow(r.ctrl.close - DEADLINE_CD);
  await r.eng._walkClockFire(r.m);
}

async function readScript(r) {
  await toRound2(r);
  for (const cd of [6_000, 5_000, DEADLINE_CD, 3_000]) await r.at(cd, { rank: 2 });
}

async function pairOf(script, opts) {
  const off = nxaw(H.WALK_OFF, opts);
  await script(off);
  off.done();
  const on = nxaw(WALK, opts);
  await script(on);
  on.done();
  return { off, on };
}

(async () => {
  console.log('T9 walk - GoComet last attempt in a not-final round');

  await H.check('harness: after two extending probes the load is in R2 of cap 3, NOT_FINAL, with one attempt left', async () => {
    const r = nxaw(WALK);
    await toRound2(r);
    const v = r.eng.roundVerdict(r.m);
    r.done();
    const bad = [];
    if (!H.same(r.ladder, [P0, P1, LOWEST])) bad.push(`ladder ${JSON.stringify(r.ladder)}`);
    if (v.rounds !== 2 || v.verdict !== 'NOT_FINAL') bad.push(`verdict ${v.verdict}/${v.reason} at rounds ${v.rounds}, expected NOT_FINAL at 2`);
    if (r.m.revisionsLeft !== 1) bad.push(`revisionsLeft ${r.m.revisionsLeft}, expected 1`);
    if (!H.same(r.trace(), ['92650@8000', '91120@8400'])) bad.push(`probes ${JSON.stringify(r.trace())}`);
    return bad.length ? `HARNESS: ${bad.join('; ')}` : null;
  });

  await H.check('NXAW: no fresh read by R2\'s last-step deadline -> the clock sends the lowest with the last attempt', async () => {
    const { off, on } = await pairOf(clockScript);
    const bad = [];
    if (!H.same(on.trace(), [`${P0}@8000`, `${P1}@8400`, `${LOWEST}@${DEADLINE_CD}`])) {
      bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected the lowest ${LOWEST} at ${DEADLINE_CD} in R2 after the two probes`);
    }
    const ctl = H.offMatches('clock', off.trace(), GOLDEN.clock);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('NXAW on reads: rank 2 in R2 with one attempt -> the lowest at the last-step deadline, once', async () => {
    const { off, on } = await pairOf(readScript);
    const bad = [];
    const r2 = on.writes.slice(2);
    if (r2.length !== 1 || r2[0].price !== LOWEST) bad.push(`in R2 walk on sent ${JSON.stringify(on.trace().slice(2))}, expected exactly one ${LOWEST}`);
    else if (r2[0].cd > 5_700 || r2[0].cd < DEADLINE_CD) bad.push(`the lowest went at ${r2[0].cd} ms, expected inside the last-step deadline (${DEADLINE_CD}-5,700 ms)`);
    const ctl = H.offMatches('read', off.trace(), GOLDEN.read);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('rank 1 in R2 with one attempt -> hold, on reads and on the clock', async () => {
    const r = nxaw(WALK, { rankAfter: 1 });
    await toRound2(r, 1);
    for (const cd of [6_000, DEADLINE_CD]) await r.at(cd, { rank: 1 });
    H.setNow(r.ctrl.close - DEADLINE_CD + 50);
    await r.eng._walkClockFire(r.m);
    r.done();
    const extra = r.trace().slice(2);
    return extra.length ? `at rank 1 walk on sent ${JSON.stringify(extra)}` : null;
  });

  await H.check('the clock prepares a quote ahead of R2\'s last-attempt shot', async () => {
    const r = nxaw(WALK);
    await toRound2(r);
    r.m._walkClockAtMs = DEADLINE_CD;
    const before = r.ctrl.prepares.length;
    r.eng._walkClockPrepare(r.m);
    await new Promise((res) => setImmediate(res));
    r.done();
    return r.ctrl.prepares.length > before ? null : 'no quote was prepared for the last attempt in a NOT_FINAL round';
  });

  await H.check('two attempts left in R2 but only the lowest price below ours -> a quote is prepared and the clock sends the lowest', async () => {
    const r = nxaw(WALK);
    await toRound2(r);
    r.m.revisionsLeft = 2;
    r.ctrl.attempts = 2;
    r.m._walkClockAtMs = DEADLINE_CD;
    const before = r.ctrl.prepares.length;
    r.eng._walkClockPrepare(r.m);
    await new Promise((res) => setImmediate(res));
    const prepared = r.ctrl.prepares.length > before;
    H.setNow(r.ctrl.close - DEADLINE_CD);
    await r.eng._walkClockFire(r.m);
    r.done();
    const bad = [];
    if (!prepared) bad.push('no quote was prepared');
    if (!H.same(r.trace().slice(2), [`${LOWEST}@${DEADLINE_CD}`])) bad.push(`in R2 the clock sent ${JSON.stringify(r.trace().slice(2))}, expected ${LOWEST}@${DEADLINE_CD}`);
    return bad.join('; ') || null;
  });

  await H.check('a middle price still available in R2 with two attempts -> the probe goes, and the clock prepares nothing for a lowest shot', async () => {
    const r = nxaw(WALK, { rankAfter: 2 });
    r.m.ladder.splice(2, 0, 90_350);
    await toRound2(r);
    r.m.revisionsLeft = 2;
    r.ctrl.attempts = 2;
    const due = r.eng._walkPreFinalLastDue(r.m, r.m._lastOkState, r.eng.roundVerdict(r.m));
    r.done();
    return due ? 'the lowest was treated as due while a middle price and two attempts remained' : null;
  });

  H.finish('T9 walk - GoComet last attempt in a not-final round', EXPECTED);
})();
