'use strict';
/**
 * A 3-attempt Waaree load bids 9 % -> 7.2 % -> floor; the 1.8 % rung never reaches the wire.
 *
 * Regression target: PR-T2a behaviour contract section 5e,
 * owner ruling Q3:
 * the middle price is the NEXT price. Waaree band 9 / 7.2 / 1.8 / floor 1 % with 3 non-renewing
 * attempts: rung 0, then rung 1, then the floor. Timing diagnosis classes C10/D8 (61 of 78 Waaree
 * losses): the deployed walk spends every attempt before the final round and never offers the floor.
 *
 * THE DEFECT. An unbid provisional-close load establishes at the softOpenAtMs mark (~150 s) of
 * round 0, then _decide branch 4,
 *   next = Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
 *   if (next >= last) next = last - 1;
 * steps rung 1 and rung 2 on the next outranked ticks of the same round. All three attempts are
 * gone inside round 0, the 1.8 % rung is sent, and the final round has nothing left for the floor.
 *
 * THE LADDER is built through arm(): cost 70,000, marginsPct [9, 7.2, 1.8, 1], minMarginPct 1 ->
 * [76,300, 75,040, 71,260, 70,700]. Every expected price is read off the armed ladder.
 *
 * CAREERS. Posted close P; round r's close is P + r x 299,000 (the measured per-round step; the
 * published increment is 300,000, so derived R = r). Each round is read at 290,000 / 150,000 /
 * 60,000 / 10,500 / 5,000 ms. The default cap C = 3 makes round 3 the final round.
 *   A. outranked at every buzzer: unranked until our first bid lands, then rank 3 in rounds 0-2 and
 *      rank 2 in round 3. Expected writes: rung 0 in round 0's middle band, rung 1 in round 1's
 *      middle band, nothing in round 2 (A = 1, the floor's), the floor at round 3's buzzer.
 *   B. leading until the final round: rank 1 once rung 0 lands, rank 3 from 10,500 ms of round 3.
 *      Expected writes: rung 0 in round 0's middle band, rung 1 at round 3's 10,500 ms middle band,
 *      the floor at round 3's buzzer.
 *   (A pre-final round's shot goes at 10,500 ms, not the 5,000 ms buzzer, since rulings 40 and 56.)
 * Frames mirror the real gocometAdapter (extendMs 300,000, extendCount null, extensionCeiling null);
 * capabilities mirror gocometAdapter.capabilities() (extensionCeiling null, snipeBudgetMs 4,500).
 * placeBid is accepted and returns myRank and the decremented revisionsLeft.
 *
 * CHECKS
 *   1. control: an SP hard-close load on the same harness, unbid, read at 60,000 then 10,500 ms,
 *      still sends its establish (rung 0) at 10,500 ms. Green on both trees.
 *   2. mechanism: career A's write sequence.
 *   3. mechanism: career B's write sequence.
 *   4. mechanism: the 1.8 % rung is never sent in either career.
 *   5. mechanism: the last write of each career is the floor.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-ladder-mapping.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 5;
const EXTEND_MS = 299_000;
const READS = [290_000, 150_000, 60_000, 10_500, 5_000];
const FINAL_ROUND = 3;
const COST = 70_000;
// Ruling 27: the minimum margin is a guard, never a bid, so the floor rung is carried as the lowest band margin.
const WAAREE = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const CAUSE = 'the deployed provisional-close walk (softOpenAtMs establish at ~150 s, then _decide branch 4 '
  + 'next = max(currentRungIndex + 1, _scheduledRungIndex) on every outranked tick) spends all 3 attempts '
  + 'on rungs 0-2 before the final round and never offers the floor';

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown' };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const TMP_PREFIX = `gc-ladder-mapping-${process.pid}-`;
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ENGINE_OPTS = {
  config: { minInterFireMs: 0, openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0 },
  softClose: { enabled: false, shippers: [], mode: 'live' },
  rand: () => 0,
  log: quiet,
};

function rig({ caps, closeModel, id, platformKey, companyName }) {
  const file = path.join(os.tmpdir(), `${TMP_PREFIX}${seq++}.json`);
  const ctrl = { frame: null, revisionsLeft: caps.revisionLimit != null ? caps.revisionLimit : null, round: 0,
    rankAfterBid: null };
  const writes = [];
  const tickErrors = [];
  const adapter = {
    capabilities: () => ({ ...caps }),
    async getAuctionState() { return { ...ctrl.frame, revisionsLeft: ctrl.revisionsLeft }; },
    async placeBid(auctionId, price) {
      writes.push({ price, round: ctrl.round, closesInMs: ctrl.frame.closesInMs });
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: ctrl.rankAfterBid, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 600_000;
  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS,
    onEvent: (e) => { if (e && e.kind === 'tick_error') tickErrors.push(e.detail); } });
  const m = eng.arm({
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName, closesAt: posted,
    platformKey, rules: { revisionLimit: 3, minDecrement: 500 },
  }, { cost: COST, ...WAAREE });
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  const ladder = m.ladder.slice();
  const at = async (round, countdown, myRank) => {
    ctrl.round = round;
    const close = posted + round * EXTEND_MS;
    vnow = close - countdown;
    ctrl.frame = { ok: true, status: 'live', closeModel, closesAtMs: close, closesInMs: close - Date.now(),
      extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank, totalBidders: null,
      standingL1Price: null, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 };
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const harness = () => {
    const bad = [];
    const expected = WAAREE.marginsPct.map((p) => Math.round(COST * (1 + p / 100)));
    if (ladder.join() !== expected.join()) bad.push(`armed ladder ${ladder}, expected ${expected} (9 / 7.2 / 1.8 / floor 1 %; ruling 27: the floor rung is the lowest band margin; the minimum margin is never appended as a rung)`);
    if (m.softStrategy !== 'off') bad.push(`softStrategy '${m.softStrategy}', expected 'off'`);
    if (m.currentRungIndex !== -1 || m.landedBids !== 0) bad.push('the load was already bid at arm');
    return bad.length ? `HARNESS: ${bad.join('; ')}` : null;
  };
  const errors = () => (tickErrors.length ? `HARNESS: tick_error ${tickErrors.join(' | ')}` : null);
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ladder, writes, ctrl, at, harness, errors, done };
}

async function career(id, rankFor) {
  const r = rig({ caps: GOCOMET_CAPS, closeModel: 'soft', id, platformKey: 'gocomet', companyName: 'Waaree Energies' });
  const h = r.harness();
  if (h) { r.done(); return { r, harness: h }; }
  try {
    for (let round = 0; round <= FINAL_ROUND; round++) {
      for (const c of READS) {
        const rank = r.writes.length ? rankFor(round, c) : null;
        r.ctrl.rankAfterBid = rankFor(round, c);
        await r.at(round, c, rank);
      }
    }
  } finally { r.done(); }
  return { r, harness: r.errors() };
}

const rungOf = (ladder, price) => {
  const i = ladder.indexOf(price);
  return i === ladder.length - 1 ? 'FLOOR' : `rung ${i}`;
};
const describe = (writes, ladder) => `[${writes.map((w) => `${rungOf(ladder, w.price)} ${w.price} at round ${w.round} `
  + `${w.closesInMs} ms`).join(', ')}]`;
const sameWrites = (got, want) => got.length === want.length
  && got.every((w, i) => w.price === want[i].price && w.round === want[i].round && w.closesInMs === want[i].closesInMs);

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  if (!closeIsProvisional(GOCOMET_CAPS) || closeIsProvisional(SP_CAPS)) {
    throw new Error('HARNESS: closeIsProvisional does not split the GoComet and SP capabilities');
  }

  await check(1, 'control_sp_hard_close_still_establishes', 'control', async () => {
    const r = rig({ caps: SP_CAPS, closeModel: 'hard', id: 'SP-HARD-CTL', platformKey: null, companyName: 'Havells India' });
    try {
      const h = r.harness();
      if (h) return h;
      await r.at(0, 60_000, null);
      await r.at(0, 10_500, null);
      const e = r.errors();
      if (e) return e;
      if (r.writes.length === 1 && r.writes[0].price === r.ladder[0] && r.writes[0].closesInMs === 10_500) return null;
      return `HARNESS DEAD: an unbid SP hard-close load read at 60,000 then 10,500 ms placed ${describe(r.writes, r.ladder)}, `
        + 'expected its establish (rung 0) at 10,500 ms - the harness is not reaching _decide or placeBid';
    } finally { r.done(); }
  });

  const careers = {};
  await check(2, 'outranked_every_buzzer_bids_rung0_rung1_then_floor', 'mechanism', async () => {
    const c = await career('GC-MAP-OUTRANKED', (round) => (round === FINAL_ROUND ? 2 : 3));
    if (c.harness) return c.harness;
    careers.A = c.r;
    const L = c.r.ladder;
    // named re-pin: round tracker piece C, rulings 40 and 56 - the pre-final shots moved from the
    // buzzer (5,000 ms) into the middle band (10,500 ms).
    const want = [
      { price: L[0], round: 0, closesInMs: 10_500 },
      { price: L[1], round: 1, closesInMs: 10_500 },
      { price: L[3], round: 3, closesInMs: 5_000 },
    ];
    if (sameWrites(c.r.writes, want)) return null;
    return `career A (cap 3, A = 3, outranked at every buzzer) wrote ${describe(c.r.writes, L)}; expected `
      + `${describe(want, L)} - ${CAUSE}`;
  });

  await check(3, 'leading_until_final_bids_rung0_then_next_price_then_floor', 'mechanism', async () => {
    const c = await career('GC-MAP-LEADING', (round, countdown) => (round === FINAL_ROUND && countdown <= 10_500 ? 3 : 1));
    if (c.harness) return c.harness;
    careers.B = c.r;
    const L = c.r.ladder;
    // named re-pin: round tracker piece C, rulings 40 and 56 - round 0's shot moved from the buzzer
    // (5,000 ms) into the middle band (10,500 ms).
    const want = [
      { price: L[0], round: 0, closesInMs: 10_500 },
      { price: L[1], round: FINAL_ROUND, closesInMs: 10_500 },
      { price: L[3], round: FINAL_ROUND, closesInMs: 5_000 },
    ];
    if (sameWrites(c.r.writes, want)) return null;
    return `career B (rank 1 through rounds 0-2, rank 3 from 10,500 ms of the final round) wrote ${describe(c.r.writes, L)}; `
      + `expected ${describe(want, L)} - ${CAUSE}`;
  });

  await check(4, 'the_1_8_pct_rung_never_on_the_wire', 'mechanism', async () => {
    if (!careers.A || !careers.B) return 'HARNESS: a career did not run';
    const sent = Object.entries(careers).filter(([, r]) => r.writes.some((w) => w.price === r.ladder[2]));
    if (!sent.length) return null;
    return `the 1.8 % rung ${careers.A.ladder[2]} was sent on a 3-attempt load in career(s) ${sent.map(([k]) => k).join(', ')}: `
      + `${sent.map(([k, r]) => `${k} ${describe(r.writes, r.ladder)}`).join('; ')} - ${CAUSE}`;
  });

  await check(5, 'the_floor_is_always_the_last_write', 'mechanism', async () => {
    if (!careers.A || !careers.B) return 'HARNESS: a career did not run';
    const bad = Object.entries(careers).filter(([, r]) => {
      const last = r.writes[r.writes.length - 1];
      return !last || last.price !== r.ladder[r.ladder.length - 1];
    });
    if (!bad.length) return null;
    return `the floor ${careers.A.ladder[3]} was not the last write in career(s) ${bad.map(([k]) => k).join(', ')}: `
      + `${bad.map(([k, r]) => `${k} ${describe(r.writes, r.ladder)}`).join('; ')} - ${CAUSE}`;
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(TMP_PREFIX)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} }
  }

  const isHarness = (x) => x.failure && (x.kind !== 'mechanism' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the mechanism results above are not trustworthy`);
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${CAUSE}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a 3-attempt Waaree load bids rung 0, the next price, then the floor`);
});
