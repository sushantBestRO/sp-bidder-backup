'use strict';
/**
 * Round tracker piece B: the cross-checks that confirm a close the tracker would otherwise guess at
 * (rulings 45, 47, 56, 57; round-tracker spec s1.5 rows 2 and 7, s4.1, s5.1, s6 piece B; round-detection
 * map s4 tests 6, 10 and 13).
 *
 *   1-3   map 6, SuperProcure: a countdown frozen past the close makes one listing read. A later close
 *         re-enters as the next round; an unchanged or a delisted load sends nothing.
 *   4-5   an unanswered check (the listing read fails, or never answers) still sends the floor once
 *         (ruling 57, T4's fallback).
 *   6     no check after a round that is already FINAL HIGH.
 *   7-8   GoComet: the frozen zero makes one detail read and an unchanged close sends nothing; an
 *         unanswered read still sends the floor once.
 *   9-10  GoComet (spec s5.1): a reopen visible in the detail read blocks the finalize - a later close
 *         re-enters as the next round; a still-open status with the same close holds the finalize once.
 *   11    map 13: REST one round ahead of the socket -> the larger close and R, UNCERTAIN until the
 *         socket agrees; outranked, the floor goes at the REST close's buzzer, nothing at the socket's.
 *   12-13 map 10: a backward move from REST is taken after two agreeing reads 30 s apart, both newer
 *         than the socket's last change (FINAL, the new close); one read is not enough.
 *   14    a backward socket move is taken at once: FINAL, the floor at the new close's buzzer.
 *   15    ruling 56 (e): a GoComet server-clock step moves the derived close without the countdown and
 *         is not a round; a real extension, which raises the countdown, still is.
 *
 * Every read goes through _tick with the scripted fake adapter of lib/round-tracker-harness.js on its
 * virtual clock. Each load's adapter is given a listing read (SuperProcure listingProbe, with the close
 * that listing parsed through listedCloseAt) or a detail read (GoComet closeProbe) and, where a check
 * needs it, the REST close the listing last showed (restClosesAtMs / restSeenAt). SuperProcure: allowlisted soft, increment 120 s, cap 3, window 100 s,
 * rung 0 standing. GoComet: 300 s increment, cap 3, 2 attempts left, rung 0 standing.
 *
 *   node scripts/test-round-tracker-cross-checks.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const EXPECTED_CHECKS = 15;
const INC = 120_000;
const W = 100_000;
const STEP = 299_000;
const P = Date.now() + 3_600_000;
const AFTER_SP = [500, 2_000, 3_600, 4_000, 6_000, 9_500, 12_000];
const AFTER_GC = [1_000, 5_000, 10_000, 15_000];
let n = 0;

const flush = () => new Promise((r) => setImmediate(r));
const floorOf = (load) => load.ladder[load.ladder.length - 1];
const results = (load) => load.events.filter((e) => e.type === 'auction_result');
// A listing that still shows the load open, and the close that listing parsed (listedCloseAt).
const listed = (closesAt) => ({ envelope: { stillListed: true, biddingOn: true, biddingCloseTime: 'listed', listedCount: 5 },
  closesAt });

// The adapter reads piece B adds, patched onto the harness's fake adapter for this load.
function crossChecks(load, { probe, closeProbe }) {
  load.probes = [];
  load.rest = null;
  load.stepMs = 0;
  const a = load.eng.adapter;
  const base = a.getAuctionState.bind(a);
  a.getAuctionState = async (id) => {
    const st = await base(id);
    if (st.ok && load.stepMs) st.closesAtMs += load.stepMs;
    if (st.ok && load.rest) Object.assign(st, { restClosesAtMs: load.rest.closeAt, restSeenAt: load.rest.seenAt });
    return st;
  };
  if (probe) {
    a.listingProbe = async (id) => {
      load.probes.push(Date.now());
      const r = await probe(id);
      if (!r || !r.envelope) return r;
      load.listedClose = r.closesAt;
      return r.envelope;
    };
    a.listedCloseAt = () => (load.listedClose != null ? load.listedClose : null);
  }
  if (closeProbe) a.closeProbe = async (id) => { load.probes.push(Date.now()); return closeProbe(id); };
}

async function read(load, opts) {
  const bids = await H.read(load, opts);
  await flush();
  return bids;
}

async function readsAt(load, times, close, extra) {
  const out = [];
  for (const at of times) out.push(...await read(load, Object.assign({ at, close }, extra)));
  return out;
}

async function spLoad(checks, firstAt = P - 300_000) {
  const load = await H.openLoad({ portal: 'sp', id: `RTB-SP-${n++}`, posted: P, armAt: P - 900_000,
    frame: { extendMs: INC, cap: 3, window: W }, seed: { fired: [0], revisionsLeft: 8 } });
  crossChecks(load, checks);
  await read(load, { at: firstAt, close: P, rank: 1 });
  return load;
}

async function gcLoad(checks) {
  const load = await H.openLoad({ portal: 'gc', id: `RTB-GC-${n++}`, posted: P, armAt: P - 900_000,
    seed: { fired: [0], revisionsLeft: 2 } });
  crossChecks(load, checks);
  await read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  return load;
}

// Round 0 of 3 outranked: the pre-cap shot goes at its buzzer, then the socket freezes at the close.
async function spFrozen(probe) {
  const load = await spLoad({ probe });
  const pre = await readsAt(load, [P - 60_000, P - 10_000, P - 2_400], P, { rank: 2 });
  if (!pre.some((b) => P - b.at <= 2_500) || pre.some((b) => b.price === floorOf(load))) {
    throw new Error(`HARNESS: round 0's buzzer did not take a middle price (sent ${H.fmtBids(load, pre)})`);
  }
  const post = await readsAt(load, AFTER_SP.map((d) => P + d), P, { rank: 2 });
  return { load, post };
}

async function gcFrozen(closeProbe) {
  const load = await gcLoad({ closeProbe });
  const pre = await readsAt(load, [P - 12_000, P - 10_500, P - 5_000], P, { rank: 2, attempts: 2 });
  if (pre.length !== 1 || pre[0].price === floorOf(load)) {
    throw new Error(`HARNESS: round 0's buzzer did not take exactly one middle price (sent ${H.fmtBids(load, pre)})`);
  }
  const post = await readsAt(load, AFTER_GC.map((d) => P + d), P, { rank: 2, attempts: 1 });
  return { load, post };
}

const sent = (load, bids, close) => (bids.length
  ? bids.map((b) => `${H.priceName(load, b.price)} at ${close - b.at}ms before ${close === P ? 'the frozen close' : 'the close'}`).join(', ')
  : 'nothing');

(async () => {
  const { check, done } = H.runner('Round tracker piece B: cross-checks (rulings 45, 47, 56, 57)', EXPECTED_CHECKS);

  await check('1 map 6 SP: frozen zero, the listing shows a later close -> no bid into the frozen close, R+1, the next round runs', 'red', async () => {
    const { load, post } = await spFrozen(async () => listed(P + INC));
    assert.strictEqual(post.length, 0,
      `the countdown froze at the close and the listing read showed the round still running (close +${INC} ms), `
      + `but ${sent(load, post, P)} went: T4's fallback fired into the frozen close with nothing to check it against`);
    assert.strictEqual(load.probes.length, 1, `the frozen zero made ${load.probes.length} listing read(s), expected exactly 1`);
    assert.strictEqual(load.m.extendsObserved, 1, `the later close counted ${load.m.extendsObserved} round(s), expected 1`);
    const quiet = await read(load, { at: P + 10_000, close: P, rank: 2 });
    // Read before round 1's shot: that in-window shot is itself a probe, so the verdict after it is probe_pending.
    const v = H.verdictOf(load);
    const shot = await read(load, { at: P + INC - 2_400, close: P, rank: 2 });
    assert.strictEqual(quiet.length, 0, `outside the new close's window ${sent(load, quiet, P + INC)} went`);
    assert.ok(shot.length === 1,
      `round 1 of 3 re-entered from the listing: expected its buzzer shot on the new close, sent ${sent(load, shot, P + INC)}`);
    assert.strictEqual(v.verdict, 'NOT_FINAL', `verdict ${v.verdict} (${v.reason}) after the re-entered round`);
    assert.strictEqual(v.closeAt, P + INC, `verdict close ${v.closeAt}, expected the listing's close ${P + INC}`);
  });

  await check('2 map 6 SP: frozen zero, the listing shows the same close -> no bid', 'red', async () => {
    const { load, post } = await spFrozen(async () => listed(P));
    assert.strictEqual(post.length, 0,
      `the listing read confirmed the close had not moved, yet ${sent(load, post, P)} went into the closed round`);
    assert.strictEqual(load.probes.length, 1, `the frozen zero made ${load.probes.length} listing read(s), expected exactly 1`);
    assert.strictEqual(load.m.extendsObserved, 0, `an unchanged close counted ${load.m.extendsObserved} round(s)`);
  });

  await check('3 map 6 SP: frozen zero, the load is no longer listed -> no bid', 'red', async () => {
    const { load, post } = await spFrozen(async () => ({ stillListed: false, biddingOn: null, biddingCloseTime: null,
      closesAt: null, listedCount: 4 }));
    assert.strictEqual(post.length, 0, `the load was delisted, yet ${sent(load, post, P)} went`);
    assert.strictEqual(load.probes.length, 1, `the frozen zero made ${load.probes.length} listing read(s), expected exactly 1`);
  });

  await check('4 ruling 57 SP: the listing read fails -> the floor once, exactly as T4 does today', 'positive', async () => {
    const { load, post } = await spFrozen(async () => ({ stillListed: null, biddingOn: null, biddingCloseTime: null,
      listedCount: null, error: 'socket hang up' }));
    const floors = post.filter((b) => b.price === floorOf(load));
    assert.ok(floors.length === 1 && post.length === 1,
      `an unanswered check must fire T4's floor fallback once; sent ${sent(load, post, P)}`);
  });

  await check('5 ruling 57 SP: the listing read never answers -> the floor once, after the check times out', 'positive', async () => {
    const { load, post } = await spFrozen(() => new Promise(() => {}));
    const floors = post.filter((b) => b.price === floorOf(load));
    assert.ok(floors.length === 1 && post.length === 1,
      `a check that never answers must still fire T4's floor fallback once; sent ${sent(load, post, P)}`);
  });

  await check('6 SP: frozen zero after a FINAL HIGH round (3 of 3) -> no listing read', 'positive', async () => {
    const load = await spLoad({ probe: async () => listed(P + 3 * INC) });
    for (let i = 1; i <= 3; i++) await read(load, { at: P + (i - 1) * INC - 30_000, close: P + i * INC, rank: 1 });
    const close = P + 3 * INC;
    const v = H.verdictOf(load);
    if (v.verdict !== 'FINAL') throw new Error(`HARNESS: three on-grid rounds of 3 read ${v.verdict} (${v.reason})`);
    await readsAt(load, [close - 10_000, close - 2_400], close, { rank: 2 });
    await readsAt(load, AFTER_SP.map((d) => close + d), close, { rank: 2 });
    assert.strictEqual(load.probes.length, 0, `a frozen zero after a FINAL HIGH round made ${load.probes.length} listing read(s)`);
  });

  await check('7 map 6 GoComet: frozen zero, the detail read shows the same close -> no bid', 'red', async () => {
    const { load, post } = await gcFrozen(async () => ({ closesAtMs: P, status: 'closed', vendorRank: 2 }));
    assert.strictEqual(post.length, 0,
      `the detail read confirmed the enquiry closed at its close, yet ${sent(load, post, P)} went into the closed round`);
    assert.strictEqual(load.probes.length, 1, `the frozen zero made ${load.probes.length} detail read(s), expected exactly 1`);
  });

  await check('8 ruling 57 GoComet: the detail read fails -> the floor once', 'positive', async () => {
    const { load, post } = await gcFrozen(async () => null);
    const floors = post.filter((b) => b.price === floorOf(load));
    assert.ok(floors.length === 1 && post.length === 1,
      `an unanswered detail read must fire the floor fallback once; sent ${sent(load, post, P)}`);
  });

  await check('9 spec s5.1 GoComet: the detail read shows the enquiry reopened 299 s later -> no finalize, the reopened round runs', 'red', async () => {
    let asked = 0;
    const { load } = await gcFrozen(async () => (asked++ === 0
      ? { closesAtMs: P + STEP, status: 'open', vendorRank: 2 } : { closesAtMs: P + STEP, status: 'closed', vendorRank: 2 }));
    const reopened = P + STEP;
    const mid = await readsAt(load, [P + 60_000, P + 200_000], P, { rank: 2, attempts: 1 });
    const buzzer = await read(load, { at: reopened - 5_000, close: P, rank: 2, attempts: 1 });
    await readsAt(load, [P + 304_500, P + 310_000], P, { rank: 2, attempts: 1 });
    assert.strictEqual(results(load).length, 0,
      `the detail read showed the enquiry running to +${STEP} ms, yet the load was finalized `
      + `(${results(load).length} auction_result): _finalize booked a result off the held zero alone`);
    assert.strictEqual(load.m.finalized, false, 'the monitor was finalized while the detail read showed it open');
    assert.strictEqual(load.m.extendsObserved, 1, `the reopen counted ${load.m.extendsObserved} round(s), expected 1`);
    assert.strictEqual(mid.length, 0, `before the reopened round's buzzer ${sent(load, mid, reopened)} went`);
    assert.ok(buzzer.length === 1 && buzzer[0].price === floorOf(load),
      `the reopened round is UNCERTAIN; outranked at its buzzer the floor must go (ruling 47), sent ${sent(load, buzzer, reopened)}`);
  });

  await check('10 spec s5.1 GoComet: the detail read still says open at the same close -> the finalize waits one more window, then books', 'red', async () => {
    const { load } = await gcFrozen(async () => ({ closesAtMs: P, status: 'open', vendorRank: 2 }));
    await readsAt(load, [P + 200_000, P + 304_500], P, { rank: 2, attempts: 1 });
    assert.strictEqual(results(load).length, 0,
      'the detail read said the enquiry was still open, yet the held zero finalized it at the first debounce');
    await readsAt(load, [P + 450_000, P + 610_000], P, { rank: 2, attempts: 1 });
    assert.strictEqual(results(load).length, 1, `the finalize was held past one more window (${results(load).length} results)`);
  });

  await check('11 map 13 SP: REST one round ahead of the socket -> larger close and R, UNCERTAIN; floor at the REST buzzer only', 'red', async () => {
    const load = await spLoad({ probe: async () => listed(P + INC) });
    load.rest = { closeAt: P + INC, seenAt: P - 60_000 };
    await read(load, { at: P - 60_000, close: P, rank: 1 });
    const early = await readsAt(load, [P - 2_400, P - 400], P, { rank: 2 });
    assert.strictEqual(early.length, 0,
      `the listing shows the close ${INC} ms later than the socket, so the socket's close is stale; `
      + `${sent(load, early, P)} went at the stale close`);
    const v = H.verdictOf(load);
    assert.strictEqual(load.m.extendsObserved, 1, `REST one round ahead counted ${load.m.extendsObserved} round(s), expected 1`);
    assert.strictEqual(v.verdict, 'UNCERTAIN', `verdict ${v.verdict} (${v.reason}) while the sources disagree`);
    assert.strictEqual(v.reason, 'sources_disagree', `reason ${v.reason}, expected sources_disagree`);
    const shot = await readsAt(load, [P + INC - 10_000, P + INC - 2_400], P, { rank: 2 });
    assert.ok(shot.some((b) => b.price === floorOf(load)),
      `UNCERTAIN, outranked at the REST close's buzzer: expected the floor (ruling 47), sent ${sent(load, shot, P + INC)}`);
    await read(load, { at: P + INC - 1_000, close: P + INC, rank: 1 });
    const agreed = H.verdictOf(load);
    assert.ok(agreed.reason !== 'sources_disagree', `the socket caught up and the verdict still reads ${agreed.reason}`);
  });

  await check('12 map 10 SP: REST moves the close 300 s earlier on two reads 40 s apart -> FINAL, floor at the new close', 'red', async () => {
    const load = await spLoad({ probe: async () => listed(P) }, P - 900_000);
    const back = P - 300_000;
    load.rest = { closeAt: back, seenAt: P - 600_000 };
    await read(load, { at: P - 600_000, close: P, rank: 1 });
    load.rest = { closeAt: back, seenAt: P - 560_000 };
    await read(load, { at: P - 560_000, close: P, rank: 1 });
    const bids = await readsAt(load, [back - 10_000, back - 2_400, back - 1_200], P, { rank: 2 });
    assert.ok(bids.some((b) => b.price === floorOf(load)),
      `REST moved the close back 300 s on two agreeing reads: the round is final at the new close, so the floor goes `
      + `at its buzzer; sent ${sent(load, bids, back)}`);
    const v = H.verdictOf(load);
    assert.strictEqual(v.verdict, 'FINAL', `verdict ${v.verdict} (${v.reason}), expected FINAL`);
    assert.strictEqual(v.reason, 'backward_move', `reason ${v.reason}, expected backward_move`);
    assert.strictEqual(v.closeAt, back, `verdict close ${v.closeAt}, expected ${back}`);
  });

  await check('13 map 10 SP: one REST read showing an earlier close is not enough -> nothing at that close', 'positive', async () => {
    const load = await spLoad({ probe: async () => listed(P) }, P - 900_000);
    const back = P - 300_000;
    load.rest = { closeAt: back, seenAt: P - 600_000 };
    await read(load, { at: P - 600_000, close: P, rank: 1 });
    const bids = await readsAt(load, [back - 10_000, back - 2_400, back - 1_200], P, { rank: 2 });
    assert.strictEqual(bids.length, 0, `one REST read moved the round: ${sent(load, bids, back)}`);
    assert.notStrictEqual(H.verdictOf(load).reason, 'backward_move', 'one REST read set backward_move');
  });

  await check('14 map 10 SP: the socket moves the close 300 s earlier -> FINAL at once, floor at the new close', 'red', async () => {
    const load = await spLoad({ probe: async () => listed(P) }, P - 900_000);
    const back = P - 300_000;
    await read(load, { at: P - 600_000, close: back, rank: 1 });
    const bids = await readsAt(load, [back - 10_000, back - 2_400, back - 1_200], back, { rank: 2 });
    assert.ok(bids.some((b) => b.price === floorOf(load)),
      `a backward socket move makes the round final at the new close; outranked at its buzzer the floor must go, `
      + `sent ${sent(load, bids, back)}`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'FINAL' && v.reason === 'backward_move' && v.closeAt === back,
      `verdict ${v.verdict} (${v.reason}) close ${v.closeAt}, expected FINAL backward_move at ${back}`);
  });

  await check('15 ruling 56 (e) GoComet: a +100 s server-clock step 40 s out is not a round; a real extension is', 'red', async () => {
    const load = await gcLoad({ closeProbe: async () => null });
    await read(load, { at: P - 45_000, close: P, rank: 1, attempts: 2 });
    load.stepMs = 100_000;
    await read(load, { at: P - 40_000, close: P, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.extendsObserved, 0,
      `the derived close moved +100 s while bid_closing_in kept falling (a server-clock step), and it counted `
      + `${load.m.extendsObserved} round(s)`);
    const v = H.verdictOf(load);
    assert.strictEqual(v.verdict, 'NOT_FINAL', `a clock step left the round ${v.verdict} (${v.reason})`);
    await read(load, { at: P - 10_000, close: P + STEP, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.extendsObserved, 1,
      `a real extension raised bid_closing_in by ${STEP} ms and counted ${load.m.extendsObserved} round(s), expected 1`);
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
