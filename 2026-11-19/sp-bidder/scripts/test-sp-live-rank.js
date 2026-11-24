'use strict';
/**
 * @requires-summary-line
 * SuperProcure live rank off the OPEN tab, for a load whose socket never ranked us (the Epack logins).
 *
 * Proven on the box 2026-09-28 (Havells 25920505, suyash-gupta, soft close extended once): two
 * /sp/loads/v4 OPEN reads at 11:52:43Z and 11:53:43Z, while the load was open to 11:54:00Z, each
 * carried our active bidDetails row (isActive 1, amount 20,268 = our landed bid) at rank 2, the rank
 * the socket showed at the same moment. On 25921089 a read sent 1.06 s after our bid landed returned
 * that bid (81,072) at rank 1, again the socket's rank. The fixture below is the 25920505 row, reduced
 * to the fields read.
 *
 * What must hold:
 *   - after one of OUR accepted writes on a socket-blind load in the walk's final window, the adapter
 *     makes one OPEN read, and getAuctionState then serves its rank as a normal observation (myRank,
 *     with myAmount = our amount so the walk trusts it);
 *   - the rank is served only for the price just written, only while the load is live, and never on
 *     a load the socket ranked; a failed read leaves the rank unknown (D-C unchanged);
 *   - at most one read per accepted write and never two reads within 1 s on one login, no retries;
 *   - the engine asks only with the walk on, only on SuperProcure, only inside the walk window;
 *     walk off, GoComet and socket-ranked loads are byte-identical;
 *   - the walk holds at L1 on a REST rank 1, steps at once on a REST rank 3, and with no rank still
 *     steps at its deadline.
 *
 *   node scripts/test-sp-live-rank.js
 */
const H = require('./lib/walk-harness');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const EXPECTED = 34;
const clock = H.useFakeTimers();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const LOAD = 25920505;
const OURS = 20_268;
const openTab = (rows, loadId = LOAD) => ({
  loadDetails: [{ id: loadId, branchCarrierCarrierId: 5963, biddingCloseTime: '2026-09-28T11:54:00.000Z',
    branchDisableRank: 0, branchDisableLiveLoadRank: 0 }],
  bidDetails: rows,
  totalLoadCountData: {},
  pageTotalLoads: 1,
});
const ourRow = (rank, amount = OURS, loadId = LOAD) => ({ id: 1, load: loadId, amount, isActive: 1, bidCarrierId: 5963,
  isSelected: 0, rank });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function rig({ respond = () => ({ status: 200, text: JSON.stringify(openTab([ourRow(2)])) }), socketRank = null, sock = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init && init.method, body, at: H.now() });
    const r = respond(url, body, calls.length);
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: () => null }, text: async () => r.text };
  };
  const closeAt = H.now() + 60_000;
  const states = new Map();
  const fakeSock = sock ? {
    state: (id) => states.get(Number(id)) || null,
    closesInMs: () => Math.max(0, closeAt - H.now()),
    watch() {}, clockErrorMs: () => 100,
  } : null;
  const a = new RealSuperProcureAdapter({ token: 'test-only', sock: fakeSock, fetchImpl, sleep: async () => {}, rand: () => 0,
    authProbeEnabled: false });
  a.account = { carrierId: 41041, branchIds: [52567, 52860] };
  for (const id of [LOAD, LOAD + 1]) {
    a.loadMeta.set(String(id), { id: String(id), closesAt: closeAt });
    if (socketRank != null) states.set(id, { myRank: socketRank, myAmount: OURS, bids: [{}] });
    else if (sock) states.set(id, { myRank: null, myAmount: null, bids: [] });
  }
  return { a, calls, closeAt, states };
}

async function engineRig({ platform = 'sp', walkOn = true, restRank, restAfterMs = 400, withMethod = true } = {}) {
  const walk = walkOn ? H.walkCfg(platform, platform === 'sp' ? { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 } : {})
    : H.WALK_OFF;
  const r = H.load({ platform: platform === 'gc' ? 'gc' : 'sp', walk, keepTimers: true,
    band: { cost: 87_400, marginsPct: [15.3, 12, 9, 6.5, 4.5], minMarginPct: 3 }, sp: { revisionLimit: 10 } });
  const read = r.adapter.getAuctionState;
  r.adapter.getAuctionState = async (...a) => {
    const f = Object.assign(await read(...a), { pushFed: true });
    if (platform === 'sp' && r.ctrl.restAt != null && f.myRank != null) Object.assign(f, { rankFromRest: true, restRankAt: r.ctrl.restAt });
    return f;
  };
  r.adapter.liveRankGapMs = 1_000;
  const place = r.adapter.placeBid;
  r.adapter.placeBid = async (...a) => {
    const before = r.ctrl.myAmount;
    const res = await place(...a);
    if (res.accepted && platform === 'sp') r.ctrl.myAmount = before;
    return res;
  };
  r.asks = [];
  if (withMethod) {
    r.adapter.requestLiveRank = (id, price) => {
      r.asks.push({ id, price, cd: r.close - H.now() });
      const sentAt = H.now();
      if (restRank !== undefined) setTimeout(() => { r.ctrl.rank = restRank; r.ctrl.myAmount = price; r.ctrl.restAt = sentAt; }, restAfterMs);
      return true;
    };
  }
  r.seedStanding(0, 8);
  r.ctrl.rank = null;
  if (platform === 'sp') r.ctrl.myAmount = null;
  await r.at(20_000);
  await clock.advanceTo(r.close - 300);
  r.m.finalized = true;
  r.done();
  return r;
}

(async () => {
  console.log('SuperProcure live rank off the OPEN tab (socket-blind loads, walk final window)');

  await H.check('adapter: one OPEN read after our write; getAuctionState then serves rank 2 with our amount', async () => {
    const { a, calls } = rig();
    const before = await a.getAuctionState(LOAD);
    if (before.myRank !== null) return `rank before the read was ${before.myRank}`;
    if (typeof a.requestLiveRank !== 'function') return 'adapter has no requestLiveRank';
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 50);
    await settle();
    if (calls.length !== 1) return `${calls.length} requests, expected 1`;
    const c = calls[0];
    if (!/\/sp\/loads\/v4$/.test(c.url) || c.method !== 'POST' || c.body.baseFilter.tab !== 'OPEN') return `wrong request ${c.method} ${c.url} ${JSON.stringify(c.body && c.body.baseFilter)}`;
    const st = await a.getAuctionState(LOAD);
    return st.myRank === 2 && st.myAmount === OURS ? null : `after the read: myRank ${st.myRank}, myAmount ${st.myAmount}`;
  });

  await H.check('adapter: a rank read for an older price is not served once a lower price is written', async () => {
    const { a } = rig();
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 50); await settle();
    a.requestLiveRank(LOAD, 19_800);
    const st = await a.getAuctionState(LOAD);
    return st.myRank === null && st.myAmount === null ? null : `served ${st.myRank} / ${st.myAmount} for a price no longer ours`;
  });

  await H.check('adapter: a load the socket ranked is never read and keeps the socket rank', async () => {
    const { a, calls } = rig({ socketRank: 3 });
    await a.getAuctionState(LOAD);
    const asked = a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 2_000); await settle();
    const st = await a.getAuctionState(LOAD);
    return calls.length === 0 && asked === false && st.myRank === 3 ? null : `requests ${calls.length}, returned ${asked}, rank ${st.myRank}`;
  });

  await H.check('adapter: a load the socket ranked earlier stays unread after its rank goes quiet', async () => {
    const { a, calls, states } = rig({ socketRank: 3 });
    await a.getAuctionState(LOAD);
    states.set(LOAD, { myRank: null, myAmount: null, bids: [] });
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 2_000); await settle();
    return calls.length === 0 ? null : `${calls.length} requests on a load the socket had ranked`;
  });

  await H.check('adapter: never two reads within 1 s on one login; asks inside a pending read share it', async () => {
    const { a, calls } = rig({ respond: (_u, _b) => ({ status: 200, text: JSON.stringify({ ...openTab([ourRow(2), ourRow(4, OURS, LOAD + 1)]),
      loadDetails: [{ id: LOAD, branchCarrierCarrierId: 5963 }, { id: LOAD + 1, branchCarrierCarrierId: 5963 }] }) }) });
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 10); await settle();
    a.requestLiveRank(LOAD, OURS);
    a.requestLiveRank(LOAD + 1, OURS);
    await clock.advanceTo(H.now() + 400); await settle();
    const early = calls.length;
    await clock.advanceTo(H.now() + 1_000); await settle();
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    const st = await a.getAuctionState(LOAD + 1);
    if (early !== 1) return `${early} reads inside the first second`;
    if (calls.length !== 2) return `${calls.length} reads for three asks, expected 2 (the two later asks share one)`;
    if (gaps.some((g) => g < 1_000)) return `reads ${JSON.stringify(gaps)} ms apart`;
    return st.myRank === 4 ? null : `the shared read did not serve the second load (rank ${st.myRank})`;
  });

  await H.check('adapter: a failed read (503, status 0, HTML 500) is one attempt and leaves the rank unknown', async () => {
    for (const bad of [{ status: 503, text: '' }, new Error('ECONNRESET'), { status: 500, text: '<html>oops</html>' }]) {
      const { a, calls } = rig({ respond: () => bad });
      a.requestLiveRank(LOAD, OURS);
      await clock.advanceTo(H.now() + 1_500); await settle();
      const st = await a.getAuctionState(LOAD);
      if (calls.length !== 1) return `${calls.length} attempts on ${bad instanceof Error ? bad.message : bad.status}`;
      if (st.myRank !== null) return `rank ${st.myRank} after a failed read`;
    }
    return null;
  });

  await H.check('adapter: a 401 counts against the read streak like listAuctions, and the rank stays unknown', async () => {
    const { a } = rig({ respond: () => ({ status: 401, text: 'Unauthorized' }) });
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 50); await settle();
    const st = await a.getAuctionState(LOAD);
    return a._readStreak === 1 && st.myRank === null ? null : `read streak ${a._readStreak}, rank ${st.myRank}`;
  });

  await H.check('adapter: no row of ours, or an inactive or unranked one, is not a rank', async () => {
    for (const rows of [[], [{ ...ourRow(null) }], [{ ...ourRow(2), isActive: 0 }], [{ ...ourRow(2), bidCarrierId: 999 }]]) {
      const { a } = rig({ respond: () => ({ status: 200, text: JSON.stringify(openTab(rows)) }) });
      a.requestLiveRank(LOAD, OURS);
      await clock.advanceTo(H.now() + 50); await settle();
      const st = await a.getAuctionState(LOAD);
      if (st.myRank !== null) return `rows ${JSON.stringify(rows)} served rank ${st.myRank}`;
    }
    return null;
  });

  await H.check('adapter: at the close the live rank is not served, so _finalize still asks the settled read', async () => {
    const { a, closeAt } = rig();
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 50); await settle();
    H.setNow(closeAt + 100);
    const st = await a.getAuctionState(LOAD);
    return st.status === 'closed' && st.myRank === null ? null : `closed read served rank ${st.myRank} (${st.status})`;
  });

  await H.check('adapter: no socket attached - no read and no myAmount key (REST-only unchanged)', async () => {
    const { a, calls } = rig({ sock: false });
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 1_500); await settle();
    const st = await a.getAuctionState(LOAD);
    return calls.length === 0 && !Object.prototype.hasOwnProperty.call(st, 'myAmount') ? null : `requests ${calls.length}, keys ${Object.keys(st)}`;
  });

  await H.check('engine: walk on, socket-blind SP - one ask per accepted write, each with the written price', async () => {
    const r = await engineRig({});
    const accepted = r.writes.filter((w) => !w.refused);
    if (!accepted.length) return `no writes: ${JSON.stringify(r.trace())}`;
    if (r.asks.length !== accepted.length) return `${r.asks.length} asks for ${accepted.length} accepted writes (${JSON.stringify(r.trace())})`;
    return r.asks.every((q, i) => q.id === r.meta.id && q.price === accepted[i].price) ? null : `asks ${JSON.stringify(r.asks)}`;
  });

  await H.check('engine: walk off - no ask, and writes plus tick schedule match an adapter without the method', async () => {
    const withM = await engineRig({ walkOn: false });
    const without = await engineRig({ walkOn: false, withMethod: false });
    if (withM.asks.length) return `${withM.asks.length} asks with the walk off`;
    return H.same(withM.trace(), without.trace()) && H.same(withM.schedule, without.schedule) ? null
      : `walk-off moved: ${JSON.stringify(withM.trace())} vs ${JSON.stringify(without.trace())}`;
  });

  await H.check('engine: GoComet walk on - no ask', async () => {
    const r = await engineRig({ platform: 'gc' });
    return r.asks.length === 0 ? null : `${r.asks.length} asks on GoComet`;
  });

  await H.check('engine: REST rank 1 after our step - the walk holds at L1 (W3), no further step', async () => {
    const blind = await engineRig({ withMethod: false });
    const held = await engineRig({ restRank: 1 });
    if (blind.writes.length < 2) return `control never stepped twice: ${JSON.stringify(blind.trace())}`;
    return held.writes.length === 1 ? null : `stepped on at rank 1: ${JSON.stringify(held.trace())} (blind control ${JSON.stringify(blind.trace())})`;
  });

  await H.check('engine: REST rank 3 after our step - the next step goes as the rank lands, before its deadline', async () => {
    const blind = await engineRig({ withMethod: false });
    const out = await engineRig({ restRank: 3, restAfterMs: 400 });
    if (out.writes.length < 2 || blind.writes.length < 2) return `too few writes: ${JSON.stringify(out.trace())} / ${JSON.stringify(blind.trace())}`;
    const gap = out.writes[0].cd - out.writes[1].cd;
    return gap <= 400 + 25 + 1 && out.writes[0].cd === blind.writes[0].cd ? null
      : `second step ${gap} ms after the first (control ${blind.writes[0].cd - blind.writes[1].cd}); traces ${JSON.stringify(out.trace())} / ${JSON.stringify(blind.trace())}`;
  });

  await H.check('engine: the read never lands - D-C steps at the deadline exactly as with no read at all', async () => {
    const blind = await engineRig({ withMethod: false });
    const lost = await engineRig({});
    return H.same(lost.trace(), blind.trace()) ? null : `moved: ${JSON.stringify(lost.trace())} vs ${JSON.stringify(blind.trace())}`;
  });

  // Holding L1 on a REST rank: one check read, early enough that its answer can act by the last
  // step's latest start (stepDeadlineMs(1) = safety 700 + land 2,500 + one tick 200 = 3,400 here).
  const DEADLINE = 3_400;
  const LEAD = 2_500;
  async function holdRig(check, { socketRanked = false } = {}) {
    const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 }), keepTimers: true,
      band: { cost: 87_400, marginsPct: [15.3, 12, 9, 6.5, 4.5], minMarginPct: 3 }, sp: { revisionLimit: 10 } });
    const read = r.adapter.getAuctionState;
    r.adapter.getAuctionState = async (...a) => {
      const f = Object.assign(await read(...a), { pushFed: true });
      if (r.ctrl.rank != null && !socketRanked) Object.assign(f, { rankFromRest: true, restRankAt: r.ctrl.restAt });
      return f;
    };
    r.adapter.liveRankGapMs = 1_000;
    const place = r.adapter.placeBid;
    r.adapter.placeBid = async (...a) => {
      const res = await place(...a);
      if (res.accepted) {
        r.ctrl.myAmount = null; r.ctrl.rank = null;
        if (socketRanked) setTimeout(() => { r.ctrl.rank = 1; r.ctrl.myAmount = a[1]; }, 300);
      }
      return res;
    };
    r.asks = [];
    r.adapter.requestLiveRank = (id, price) => {
      r.asks.push({ price, cd: r.close - H.now() });
      if (socketRanked) return false;
      const answer = r.asks.length === 1 ? { rank: 1, afterMs: 400 } : check;
      const sentAt = H.now();
      if (answer && answer.rank != null) setTimeout(() => { r.ctrl.rank = answer.rank; r.ctrl.myAmount = price; r.ctrl.restAt = sentAt; }, answer.afterMs);
      return true;
    };
    r.seedStanding(0, 8);
    r.ctrl.rank = null; r.ctrl.myAmount = null;
    await r.at(20_000);
    await clock.advanceTo(r.close - 300);
    r.m.finalized = true;
    r.done();
    return r;
  }

  await H.check('hold at REST rank 1: a rival undercut seen only on the check read - the next price goes before the last step\'s deadline', async () => {
    const r = await holdRig({ rank: 2, afterMs: 500 });
    if (r.asks.length !== 3) return `${r.asks.length} reads asked, expected 3 (first write, check, defence write): ${JSON.stringify(r.asks)}`;
    const c = r.asks[1];
    if (!(c.cd > DEADLINE + 1_500 && c.cd <= DEADLINE + LEAD)) return `check read asked at ${c.cd}, expected inside (${DEADLINE + 1_500}, ${DEADLINE + LEAD}] - the login's 1 s gap plus a 1.5 s read`;
    if (r.writes.length !== 2) return `writes ${JSON.stringify(r.trace())}, expected the first step then the defence`;
    const w = r.writes[1];
    return w.cd >= DEADLINE && w.price < r.writes[0].price ? null : `defence ${w.price}@${w.cd}, expected a lower price at or before ${DEADLINE}`;
  });

  await H.check('hold at REST rank 1: the check read still shows rank 1 - no bid', async () => {
    const r = await holdRig({ rank: 1, afterMs: 500 });
    return r.asks.length === 2 && r.writes.length === 1 ? null : `asks ${r.asks.length}, writes ${JSON.stringify(r.trace())}`;
  });

  await H.check('hold at REST rank 1: the check read fails - keep holding, the lowest is not spent blind', async () => {
    const r = await holdRig(null);
    return r.asks.length === 2 && r.writes.length === 1 ? null : `asks ${r.asks.length}, writes ${JSON.stringify(r.trace())}`;
  });

  await H.check('hold at a SOCKET rank 1: no check read, trace unchanged from the no-read hold', async () => {
    const r = await holdRig(null, { socketRanked: true });
    return r.asks.length === 1 && r.writes.length === 1 ? null : `asks ${JSON.stringify(r.asks)}, writes ${JSON.stringify(r.trace())}`;
  });

  await H.check('F2: a REST rank never stamps rank_visible (no REST latency in the SP step-time pool)', async () => {
    const r = await engineRig({ restRank: 3, restAfterMs: 400 });
    const stamps = r.events.filter((e) => e.type === 'rank_visible');
    return stamps.length === 0 ? null : `${stamps.length} rank_visible from REST ranks`;
  });

  await H.check('F2 control: a socket rank still stamps rank_visible', async () => {
    const r = await holdRig(null, { socketRanked: true });
    const stamps = r.events.filter((e) => e.type === 'rank_visible');
    return stamps.length >= 1 ? null : 'the socket rank no longer stamps rank_visible';
  });

  // Soft close, rounds before the final: the check read belongs to each round, and a REST rank read
  // before the current round began is not a rank in it.
  const SOFT = { closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 100_000, revisionLimit: 5 };
  async function roundsRig(answers) {
    const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 }), keepTimers: true,
      band: { cost: 87_400, marginsPct: [15.3, 12.9, 10.8, 4.5], minMarginPct: 3 }, company: 'Havells India',
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, sp: SOFT });
    const read = r.adapter.getAuctionState;
    r.adapter.getAuctionState = async (...a) => {
      const f = Object.assign(await read(...a), { pushFed: true });
      if (r.ctrl.rank != null) Object.assign(f, { rankFromRest: true, restRankAt: r.ctrl.restAt });
      return f;
    };
    r.adapter.liveRankGapMs = 1_000;
    r.asks = [];
    r.adapter.requestLiveRank = (id, price) => {
      const a = answers[r.asks.length];
      r.asks.push({ price, cd: r.close - H.now() });
      const sentAt = H.now();
      if (a && a.rank != null) setTimeout(() => { r.ctrl.rank = a.rank; r.ctrl.myAmount = price; r.ctrl.restAt = sentAt; }, a.afterMs);
      return true;
    };
    r.seedStanding(0, 4);
    r.ctrl.rank = 1; r.ctrl.restAt = H.now();
    await r.at(150_000);
    await clock.advanceTo(r.close - 1_000);
    r.round1Writes = r.writes.length;
    r.round1Asks = r.asks.length;
    r.ctrl.close += 180_000;
    await r.at(179_000);
    await clock.advanceTo(r.close - 300);
    r.m.finalized = true;
    r.done();
    return r;
  }

  await H.check('F1: a REST rank-1 hold gets its check read in EVERY round (pre-final included); an undercut in round 2 is answered', async () => {
    const r = await roundsRig([{ rank: 1, afterMs: 400 }, { rank: 2, afterMs: 400 }]);
    if (r.round1Asks !== 1 || r.round1Writes !== 0) return `round 1: ${r.round1Asks} check reads, writes ${JSON.stringify(r.trace())}`;
    if (r.asks.length < 2) return `round 2 asked no check read (asks ${JSON.stringify(r.asks)})`;
    const w = r.writes.slice(r.round1Writes);
    return w.length >= 1 && w[0].cd > DEADLINE ? null : `round 2 writes ${JSON.stringify(r.trace())}, expected the undercut answered before ${DEADLINE}`;
  });

  await H.check('F1 control: round 2 check read still shows rank 1 - hold, no bid in either round', async () => {
    const r = await roundsRig([{ rank: 1, afterMs: 400 }, { rank: 1, afterMs: 400 }]);
    return r.asks.length === 2 && r.writes.length === 0 ? null : `asks ${r.asks.length}, writes ${JSON.stringify(r.trace())}`;
  });

  await H.check('storm: every read fails after an extension - the round-1 rank 1 is stale, the walk falls back to D-C (bids), never holds it', async () => {
    const r = await roundsRig([null, null, null]);
    if (r.round1Writes !== 0) return `round 1 wrote ${JSON.stringify(r.trace())} while holding a fresh rank 1`;
    return r.writes.length >= 1 ? null : `held a stale rank 1 through round 2 with every read failing (asks ${r.asks.length})`;
  });

  await H.check('F3 adapter: a read in flight answers every load waiting on it; the ask made during it still gets its own read', async () => {
    let release = null;
    const body = { ...openTab([ourRow(2), ourRow(4, OURS, LOAD + 1)]),
      loadDetails: [{ id: LOAD, branchCarrierCarrierId: 5963 }, { id: LOAD + 1, branchCarrierCarrierId: 5963 }] };
    const { a, calls } = rig({ respond: () => ({ status: 200, text: JSON.stringify(body) }) });
    const fetch0 = a.fetchImpl;
    a.fetchImpl = async (url, init) => {
      const r0 = await fetch0(url, init);
      if (calls.length === 1) await new Promise((res) => { release = res; });
      return r0;
    };
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 10); await settle();
    a.requestLiveRank(LOAD + 1, OURS);
    if (release) release();
    await settle();
    const served = await a.getAuctionState(LOAD + 1);
    await clock.advanceTo(H.now() + 1_100); await settle();
    return served.myRank === 4 && calls.length === 2 ? null : `load 2 served ${served.myRank} from the in-flight read, reads ${calls.length}`;
  });

  await H.check('F3 adapter: an older response landing late never overwrites a newer rank', async () => {
    const { a } = rig();
    if (typeof a._applyLiveRanks !== 'function') return 'adapter has no _applyLiveRanks';
    a._liveRankPrice.set(String(LOAD), OURS);
    a._applyLiveRanks({ loadDetails: [{ id: LOAD, branchCarrierCarrierId: 5963 }], bidDetails: [ourRow(3)] }, H.now());
    a._applyLiveRanks({ loadDetails: [{ id: LOAD, branchCarrierCarrierId: 5963 }], bidDetails: [ourRow(1)] }, H.now() - 500);
    const st = await a.getAuctionState(LOAD);
    return st.myRank === 3 ? null : `rank ${st.myRank}, expected the newer read's 3`;
  });

  await H.check('F3 adapter: publishes its login-wide gap so the engine can lead by it', async () => {
    const { a } = rig();
    return a.liveRankGapMs === 1_000 ? null : `liveRankGapMs ${a.liveRankGapMs}`;
  });

  await H.check('starve: discovery listings go out at once while live-rank reads wait on the cap, and do not move it', async () => {
    const { a, calls } = rig({ respond: () => ({ status: 200, text: JSON.stringify(openTab([ourRow(2)])) }) });
    a.requestLiveRank(LOAD, OURS);
    await clock.advanceTo(H.now() + 10); await settle();
    a.requestLiveRank(LOAD, OURS);
    const t0 = H.now();
    await a.listAuctions();
    await a.listAuctions();
    const listed = calls.filter((c) => c.at === t0).length;
    await clock.advanceTo(H.now() + 1_100); await settle();
    const gap = calls.length === 4 ? calls[3].at - calls[0].at : null;
    return listed === 2 && gap >= 1_000 ? null : `listings at once ${listed}, live-rank gap ${gap}, calls ${calls.length}`;
  });

  // Review r2 (V1-F01): OUR write inside the trigger window extends the close. The post-write read is
  // sent after that write was accepted, so its rank belongs to the round the write opened.
  async function selfExtRig({ extendCount, round1Rank, postWriteRank }) {
    const sp = { closeModel: 'soft', extendMs: 180_000, extendCount, triggerWindowMs: 100_000, revisionLimit: 8 };
    const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: 15_000 }), keepTimers: true,
      band: { cost: 87_400, marginsPct: [15.3, 13, 11, 9, 7, 4.5], minMarginPct: 3 }, company: 'Havells India',
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, sp });
    const read = r.adapter.getAuctionState;
    r.adapter.getAuctionState = async (...a) => {
      const f = Object.assign(await read(...a), { pushFed: true });
      if (r.ctrl.rank != null) Object.assign(f, { rankFromRest: true, restRankAt: r.ctrl.restAt });
      return f;
    };
    r.adapter.liveRankGapMs = 1_000;
    const place = r.adapter.placeBid;
    r.extended = 0;
    r.adapter.placeBid = async (...a) => {
      const cd = r.ctrl.close - H.now();
      const res = await place(...a);
      if (cd <= 100_000 && r.extended < 1) { r.ctrl.close += 180_000; r.extended += 1; }
      return res;
    };
    r.asks = [];
    r.adapter.requestLiveRank = (id, price) => {
      const sentAt = H.now();
      r.asks.push({ price, cd: r.ctrl.close - sentAt });
      const rank = r.asks.length === 1 ? postWriteRank : 1;
      setTimeout(() => { r.ctrl.rank = rank; r.ctrl.myAmount = price; r.ctrl.restAt = sentAt; }, 400);
      return true;
    };
    r.seedStanding(0, 6);
    r.ctrl.rank = round1Rank; r.ctrl.restAt = H.now();
    await r.at(150_000);
    await clock.advanceTo(r.ctrl.close - 1_000);
    await clock.advanceTo(r.ctrl.close - 300);
    r.m.finalized = true;
    r.done();
    return r;
  }

  await H.check('V1-F01 A: our probe extends a pre-final round, its read says rank 2 - the next round probes the middle price 98762, never the lowest', async () => {
    const r = await selfExtRig({ extendCount: 3, round1Rank: 2, postWriteRank: 2 });
    const prices = r.writes.map((w) => w.price);
    if (prices.includes(r.ladder[r.ladder.length - 1])) return `sent the lowest: ${JSON.stringify(r.trace())}`;
    return prices.length === 2 && prices[1] === 98_762 ? null : `writes ${JSON.stringify(r.trace())}, expected the round-1 probe then 98762`;
  });

  await H.check('V1-F01 B: our probe extends into the FINAL round and its read says rank 1 - hold, no bid at L1', async () => {
    const r = await selfExtRig({ extendCount: 1, round1Rank: 2, postWriteRank: 1 });
    return r.writes.length === 1 ? null : `writes ${JSON.stringify(r.trace())}, expected only the round-1 probe`;
  });

  // Review r2 (R1-F01 regression): a rival's extension opens a FINAL round while the last REST rank we
  // hold is round 1's rank 1. Production-like timing: walkStartMs(4) = 5,600 ms sits above the check
  // window's top (stepDeadlineMs(1) + 2,500 = 5,300 ms), so the no-rank timing must not step first.
  const PROD_LIKE = { stepTimeMs: 1_000, landMs: 1_500, safetyMarginMs: 100, maxWalkWindowMs: 6_000, probeLeadMs: 4_000 };
  async function finalRound2Rig(answers) {
    const r = H.load({ walk: H.walkCfg('sp', PROD_LIKE), keepTimers: true,
      band: { cost: 87_400, marginsPct: [15.3, 12.9, 10.8, 8, 6, 4.5], minMarginPct: 3 }, company: 'Havells India',
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
      sp: { closeModel: 'soft', extendMs: 180_000, extendCount: 1, triggerWindowMs: 100_000, revisionLimit: 5, clockErrorMs: 1_000 } });
    const read = r.adapter.getAuctionState;
    r.adapter.getAuctionState = async (...a) => {
      const f = Object.assign(await read(...a), { pushFed: true });
      if (r.ctrl.rank != null) Object.assign(f, { rankFromRest: true, restRankAt: r.ctrl.restAt });
      return f;
    };
    r.adapter.liveRankGapMs = 1_000;
    r.asks = [];
    r.adapter.requestLiveRank = (id, price) => {
      const a = answers[r.asks.length];
      const sentAt = H.now();
      r.asks.push({ price, cd: r.close - sentAt });
      if (a && a.rank != null) setTimeout(() => { r.ctrl.rank = a.rank; r.ctrl.myAmount = price; r.ctrl.restAt = sentAt; }, a.afterMs);
      return true;
    };
    r.seedStanding(0, 6);
    r.ctrl.rank = 1; r.ctrl.restAt = H.now();
    await r.at(150_000);
    await clock.advanceTo(r.close - 1_000);
    r.round1Writes = r.writes.length;
    r.round1Asks = r.asks.length;
    r.ctrl.close += 180_000;
    await r.at(179_000);
    await clock.advanceTo(r.close - 300);
    r.m.finalized = true;
    r.done();
    return r;
  }

  await H.check('R1-F01: extended FINAL round, round-1 REST rank 1, check read says rank 1 - hold, no bid below our standing price', async () => {
    const r = await finalRound2Rig([{ rank: 1, afterMs: 400 }, { rank: 1, afterMs: 400 }]);
    return r.writes.length === 0 && r.asks.length === 2 ? null : `asks ${JSON.stringify(r.asks)}, writes ${JSON.stringify(r.trace())}`;
  });

  await H.check('R1-F01: extended FINAL round, check read shows the undercut - the walk steps after the check, not before its window', async () => {
    const r = await finalRound2Rig([{ rank: 1, afterMs: 400 }, { rank: 2, afterMs: 400 }]);
    if (r.asks.length < 2) return `no round-2 check read: ${JSON.stringify(r.asks)}`;
    const check = r.asks[1];
    const first = r.writes[r.round1Writes];
    if (!first) return `no step after the undercut (asks ${JSON.stringify(r.asks)})`;
    return first.cd < check.cd ? null : `stepped at ${first.cd} before the check read at ${check.cd}: ${JSON.stringify(r.trace())}`;
  });

  await H.check('R1-F01: extended FINAL round, check read fails - holds until the last step\'s deadline, then D-C steps (never before the check window)', async () => {
    const r = await finalRound2Rig([{ rank: 1, afterMs: 400 }, null]);
    const first = r.writes[r.round1Writes];
    if (!first) return `never stepped after a failed check on a stale rank: asks ${JSON.stringify(r.asks)}`;
    // stepDeadlineMs(1) at these settings: safety 1,100 + land 1,500 + one tick 200.
    return r.asks.length >= 2 && first.cd === 2_800 ? null : `step ${first.cd}, expected D-C at 2800 after the check at ${r.asks[1] && r.asks[1].cd}: ${JSON.stringify(r.trace())}`;
  });

  H.finish('SuperProcure live rank', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
