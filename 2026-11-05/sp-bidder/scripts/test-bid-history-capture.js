'use strict';
/**
 * Bid-history data-capture (capture-only). Pins the three additive fields the bot already
 * computes live but used to throw away (audit _research/2026-07-21_bid-history-data-capture-audit.md):
 *
 *   A1 - socketRank: the LIVE socket rank we held when a bid fired, stamped onto bid_placed as a
 *        NEW field. The existing REST `rank` (SP returns null) is left untouched for byte-compat.
 *   A2 - rank_sample: a per-tick {ts, myRank, totalBidders, closesInMs} trajectory appended to the
 *        append-only bids jsonl (NOT onto the closedBids doc, NOT via the emit bus).
 *   A3 - laneFreight: SP's OWN published lane anchor {ftl, pmt, freightRate} parsed in _mapLoad and
 *        carried through arm -> intent -> armed event -> the closedBids doc (incl. null-safety).
 *
 * Every check is CAPTURE-ONLY: no assertion here depends on a changed bid price, timing, or rung.
 * Offline + deterministic: memory store for the logger checks, mock adapter + DurableScheduler for
 * the engine checks. Mirrors test-bid-logger.js / test-bid-rejected-log.js / test-band-escalation.js.
 *
 *   node scripts/test-bid-history-capture.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b); // deep-compare without a throwing assert
const T0 = 1700000000000;
const tmp = (tag) => path.join(os.tmpdir(), `bhc-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

(async () => {
  // ============================================================================================
  // A3 (adapter) - _mapLoad parses SP's published lane anchor, null-safe, 0 preserved.
  // ============================================================================================
  {
    const a = new RealSuperProcureAdapter({ token: 'x' });

    // all three present (the live Havells values from the audit): parsed as numbers.
    const present = a._mapLoad({ id: 'LF1', loadAvgLaneFreightFTL: 10100, loadAvgLaneFreightPMT: 8416.67, freightRate: 6250, branchAuctionExtendTime: '00:00:00' });
    ok(eq(present.laneFreight, { ftl: 10100, pmt: 8416.67, freightRate: 6250 }), 'A3 _mapLoad parses ftl/pmt/freightRate when all present');

    // SP's "no anchor for this quote type" 0 sentinel is PRESERVED as 0 (not nulled), and a null
    // freightRate (the common case in the master capture) maps to null.
    const zeros = a._mapLoad({ id: 'LF2', loadAvgLaneFreightFTL: 0, loadAvgLaneFreightPMT: 0, freightRate: null, branchAuctionExtendTime: '00:00:00' });
    ok(eq(zeros.laneFreight, { ftl: 0, pmt: 0, freightRate: null }), 'A3 _mapLoad preserves a real 0 anchor and nulls an absent freightRate');

    // MISSING all three (the null-safe case the audit called out): never throws, all null.
    let threw = false;
    let missing;
    try { missing = a._mapLoad({ id: 'LF3', branchAuctionExtendTime: '00:00:00' }); } catch (_) { threw = true; }
    ok(!threw, 'A3 _mapLoad does not throw when the anchor fields are entirely absent');
    ok(missing && eq(missing.laneFreight, { ftl: null, pmt: null, freightRate: null }), 'A3 _mapLoad yields all-null laneFreight when SP omits the fields');

    // string-coercion + garbage: SP has shipped economic fields as strings (ceilingPrice "90000.00");
    // a numeric string coerces, a non-numeric string / empty string -> null (never NaN).
    const coerce = a._mapLoad({ id: 'LF4', loadAvgLaneFreightFTL: '54935', loadAvgLaneFreightPMT: 'abc', freightRate: '', branchAuctionExtendTime: '00:00:00' });
    ok(eq(coerce.laneFreight, { ftl: 54935, pmt: null, freightRate: null }), 'A3 _mapLoad coerces a numeric string, nulls non-numeric/empty (no NaN leak)');

    // laneFreight is ALWAYS present on the mapped load (an object, never undefined) so the shape is stable.
    ok(missing.laneFreight && typeof missing.laneFreight === 'object', 'A3 laneFreight is always an object on the mapped load');
  }

  // ============================================================================================
  // A1 (logger) - socketRank persisted on the ourBids[] entry AND the jsonl bid_placed event;
  //               the existing null REST `rank` stays exactly as-is (byte-compat).
  // ============================================================================================
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle({ type: 'armed', auctionId: 'B1', ts: T0, lane: { origin: 'X', destination: 'Y' }, equipment: 'Trailer', units: 1, companyName: 'Syngenta', cost: 80000, ladder: [90080, 85040], floor: 85040 });
    // a real bid: REST rank null (as SP returns), socket rank 3 (the live rank when we fired).
    await logger.handle({ type: 'bid_placed', auctionId: 'B1', ts: T0 + 1000, price: 90080, rungIndex: 0, rank: null, socketRank: 3, latencyMs: 210 });

    const rec = await store.getDoc('closedBids', 'B1');
    const bid = rec.ourBids[0];
    ok(bid.socketRank === 3, 'A1 socketRank persisted on the ourBids[] entry');
    ok(bid.rank === null, 'A1 the existing REST rank stays null (untouched for byte-compat)');
    ok('rank' in bid && 'socketRank' in bid, 'A1 both rank and socketRank present (added alongside, not replacing)');

    // a bid with NO socketRank (mock/sim or a pre-A1 event) -> socketRank null, never undefined/throw.
    await logger.handle({ type: 'bid_placed', auctionId: 'B1', ts: T0 + 2000, price: 85040, rungIndex: 1, rank: null });
    const rec2 = await store.getDoc('closedBids', 'B1');
    ok(rec2.ourBids[1].socketRank === null, 'A1 socketRank defaults to null when the event omits it (null-safe)');

    const events = await store.readEvents('bids');
    const placed = events.find((e) => e.kind === 'bid_placed' && e.auctionId === 'B1' && e.price === 90080);
    ok(placed && placed.socketRank === 3, 'A1 socketRank carried on the append-only bids jsonl line too');
    ok(placed && placed.rank === null, 'A1 jsonl REST rank still null (byte-compat)');
  }

  // ============================================================================================
  // A2 (logger) - sampleRank appends a rank_sample to the bids jsonl with the right keys, is
  //               null-safe on missing fields, never touches the closedBids doc, and no-ops on
  //               bad input. Confirms it stays inside the legal wall (count + our rank, no amounts).
  // ============================================================================================
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });

    await logger.sampleRank({ auctionId: 'S1', myRank: 2, totalBidders: 5, closesInMs: 1234, ts: T0 });
    await logger.sampleRank({ auctionId: 'S2' }); // all trajectory fields absent -> null-safe
    await logger.sampleRank(null);                // bad input -> no-op, no throw
    await logger.sampleRank({});                  // no auctionId -> no-op, no throw

    const events = await store.readEvents('bids');
    const s1 = events.find((e) => e.kind === 'rank_sample' && e.auctionId === 'S1');
    ok(s1 && s1.myRank === 2 && s1.totalBidders === 5 && s1.closesInMs === 1234, 'A2 rank_sample carries myRank + totalBidders + closesInMs');
    ok(s1 && s1.ts === T0, 'A2 rank_sample preserves the tick timestamp (not overwritten by append-time)');
    // Kept as an EXACT key list on purpose - this is the legal-wall guard, and a loose assertion
    // would not notice a competitor field being added later. The three extension/budget keys are
    // additions to that closed list, and each is an OUR-SIDE fact the engine already computed for
    // its own decisions: how many extensions WE observed on this load, which close model WE resolved,
    // and OUR OWN remaining-revision belief. None reads, derives, or approximates any competitor's
    // bid amount - SuperProcure masks those from us entirely, so there is nothing to leak here.
    ok(s1 && eq(Object.keys(s1).sort(), ['auctionId', 'closeModel', 'closesInMs', 'engineRevisionsLeft', 'extendsObserved', 'kind', 'myRank', 'totalBidders', 'ts']), 'A2 rank_sample has exactly the expected keys (single-account: no competitor amounts, no ladder)');

    const s2 = events.find((e) => e.kind === 'rank_sample' && e.auctionId === 'S2');
    ok(s2 && s2.myRank === null && s2.totalBidders === null && s2.closesInMs === null, 'A2 rank_sample is null-safe when the trajectory fields are absent');
    ok(s2 && s2.extendsObserved === null && s2.closeModel === null && s2.engineRevisionsLeft === null,
      'A2 rank_sample extension/budget context is null-safe when absent (a pre-capture caller degrades, never throws)');

    ok(events.filter((e) => e.kind === 'rank_sample').length === 2, 'A2 bad input (null / missing auctionId) appends nothing');
    ok((await store.getDoc('closedBids', 'S1')) === null, 'A2 a rank_sample never creates/touches a closedBids doc');
    // legal wall: a sample carries a bidder COUNT and OUR rank, never any competitor bid amount.
    ok(!events.some((e) => e.kind === 'rank_sample' && ('bids' in e || 'amount' in e || 'ladderFrame' in e || 'competitors' in e)), 'A2 rank_sample carries no competitor amounts/ladder (inside the legal wall)');
  }

  // ============================================================================================
  // A2 (non-blocking sink, PR #59 S1) - the per-tick rank_sample MUST route through the store's
  // async, off-thread append (appendEventAsync / fs.promises.appendFile), never the synchronous
  // appendEvent the per-EVENT writes use, so no blocking disk write ever lands on the bid-fire tick.
  // Deterministic: a fake store records which sink was used and holds the append open on a gate,
  // proving the caller hands control back before the write completes (and still settles cleanly).
  // ============================================================================================
  {
    const calls = { sync: 0, async: 0 };
    let appendDone = false;
    let releaseAppend;
    const gate = new Promise((res) => { releaseAppend = res; });
    const fakeStore = {
      // the SYNCHRONOUS sink the per-event writes use - a per-tick sample must NOT touch this.
      async appendEvent(stream, record) { calls.sync++; return Object.assign({ ts: Date.now() }, record); },
      // the NON-BLOCKING sink the sample must use; completion is held on the gate so we can prove
      // the fire path is not blocked waiting on the disk write.
      async appendEventAsync(stream, record) { calls.async++; await gate; appendDone = true; return Object.assign({ ts: Date.now() }, record); },
    };
    const logger = new BidLogger({ store: fakeStore });

    const p = logger.sampleRank({ auctionId: 'NB1', myRank: 1, totalBidders: 3, closesInMs: 500, ts: T0 });
    // let the deferred .then dispatch the append (one microtask), while the gate is still closed.
    await Promise.resolve();
    await Promise.resolve();
    ok(calls.async === 1, 'A2 rank_sample routes through the async non-blocking sink (appendEventAsync)');
    ok(calls.sync === 0, 'A2 rank_sample never uses the synchronous appendEvent sink');
    ok(appendDone === false, 'A2 the append is still in flight - the fire path did not block on the disk write');
    releaseAppend();
    await p; // the fire-and-forget promise still settles cleanly (internal catch, no unhandled rejection)
    ok(appendDone === true, 'A2 the async append completes after the fire path returns, off the tick');
  }

  // ============================================================================================
  // A1 + A2 (engine) - the REAL data flow: drive a live bid loop with a mock adapter whose SOCKET
  // rank is 4 (getAuctionState) but whose REST placeBid rank is null (as SP returns). Assert the
  // engine's bid_placed emit stamps socketRank = state.myRank (4) while rank stays the null REST
  // value, and that onSample fires per tick with the live rank/count/countdown.
  // ============================================================================================
  {
    const intents = tmp('eng');
    const closesAt = Date.now() + 5000;
    const SOCK_RANK = 4, BIDDERS = 6;
    const adapter = {
      placed: [],
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        return {
          ok: true, status: Date.now() >= closesAt ? 'closed' : 'live',
          myRank: SOCK_RANK, totalBidders: BIDDERS, standingL1Price: null,
          closesInMs: Math.max(0, closesAt - Date.now()),
          revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50,
        };
      },
      async placeBid(id, price) {
        this.placed.push(price);
        // SP's createV2 REST response returns rank null - the exact condition A1 works around.
        return { accepted: true, myRank: null, revisionsLeft: 2, latencyMs: 60 };
      },
    };
    const scheduler = new DurableScheduler(intents);
    const bids = [];
    const samples = [];
    const engine = new BidEngine(adapter, scheduler, {
      config: { openAtMs: 15000, floorWindowMs: 2500 },
      onEvent: (e) => { if (e.type === 'bid_placed') bids.push(e); },
      onSample: (s) => samples.push(s),
    });
    engine.arm(
      { id: 'E1', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt },
      { cost: 50000, marginsPct: [12.6, 7.2, 6.3] },
    );
    await new Promise((r) => setTimeout(r, 6000));
    try { fs.unlinkSync(intents); } catch (_) {}

    // A1 engine: at least one bid fired, and every bid_placed stamps the live socket rank (4) as
    // socketRank while `rank` keeps the null REST value.
    ok(bids.length >= 1, `A1 engine placed at least one bid (got ${bids.length})`);
    ok(bids.every((b) => b.socketRank === SOCK_RANK), 'A1 engine stamps socketRank = the live socket rank (state.myRank) on bid_placed');
    ok(bids.every((b) => b.rank === null), 'A1 engine leaves rank = the null REST rank (res.myRank) unchanged');

    // A2 engine: onSample fired per tick with the right shape + live values.
    ok(samples.length >= 1, `A2 engine emitted per-tick rank samples (got ${samples.length})`);
    ok(samples.every((s) => s.auctionId === 'E1'), 'A2 engine samples carry the auctionId');
    ok(samples.every((s) => s.myRank === SOCK_RANK && s.totalBidders === BIDDERS), 'A2 engine samples carry the live socket rank + bidder count');
    ok(samples.every((s) => typeof s.closesInMs === 'number' && typeof s.ts === 'number'), 'A2 engine samples carry a numeric countdown + timestamp');
    // trajectory: the countdown is non-increasing across the run (it is a real time-series).
    const desc = samples.every((s, i) => i === 0 || s.closesInMs <= samples[i - 1].closesInMs);
    ok(desc, 'A2 engine samples form a non-increasing countdown trajectory over the auction life');
  }

  // ============================================================================================
  // A3 (engine + logger) - the real flow meta.laneFreight -> armed event -> closedBids doc, plus
  // the intent round-trip (so a scheduled-wake / post-restart arm still lands it) and the
  // rehydrate carry-forward.
  // ============================================================================================
  {
    const intents = tmp('a3');
    const anchor = { ftl: 10100, pmt: 8416.67, freightRate: 6250 };
    const far = Date.now() + 3_600_000;
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const pending = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async () => ({ accepted: true, myRank: null, revisionsLeft: 2, latencyMs: 60 }),
    };
    const scheduler = new DurableScheduler(intents);
    const engine = new BidEngine(adapter, scheduler, { onEvent: (e) => pending.push(logger.handle(e)) });

    // arm with a mapped-load meta that carries the anchor; stop the timer at once (we only care
    // about the synchronous 'armed' emit, not the bid loop).
    engine.arm(
      { id: 'A3', lane: { origin: 'X', destination: 'Y' }, equipment: '32ft', units: 1, closesAt: far, laneFreight: anchor },
      { cost: 50000, marginsPct: [12.6, 7.2, 6.3] },
    );
    engine.stop('A3');
    await Promise.all(pending);

    const rec = await store.getDoc('closedBids', 'A3');
    ok(rec && eq(rec.laneFreight, anchor), 'A3 anchor flows meta -> armed event -> closedBids doc');

    // intent round-trip: the durable intent carries the anchor, and _intentToArm restores it so a
    // rehydrate/scheduled-wake arm re-emits it (same discipline as rules/points/quoteType).
    const it = scheduler.get('A3');
    ok(it && eq(it.laneFreight, anchor), 'A3 anchor persisted on the durable intent (survives restart)');
    const reMeta = engine._intentToArm(it).meta;
    ok(reMeta && eq(reMeta.laneFreight, anchor), 'A3 _intentToArm restores the anchor onto the reconstructed meta');
    try { fs.unlinkSync(intents); } catch (_) {}

    // carry-forward: a re-arm whose armed event LACKS the anchor (a rehydrate that lost it) must not
    // wipe a previously captured anchor on the open doc.
    const s2 = createStore({ backend: 'memory' });
    const l2 = new BidLogger({ store: s2 });
    const base = { type: 'armed', auctionId: 'CF', ts: T0, lane: { origin: 'X', destination: 'Y' }, equipment: '32ft', units: 1, companyName: 'Havells', cost: 50000, ladder: [56300, 53150], floor: 53150 };
    await l2.handle(Object.assign({}, base, { laneFreight: anchor }));
    await l2.handle(Object.assign({}, base));      // re-arm WITHOUT laneFreight
    const cf = await s2.getDoc('closedBids', 'CF');
    ok(cf && eq(cf.laneFreight, anchor), 'A3 a re-arm without the anchor preserves the previously captured one (carry-forward)');
    // and a brand-new auction that never had an anchor records null (additive, byte-safe for legacy).
    await l2.handle(Object.assign({}, base, { auctionId: 'CF2' }));
    const cf2 = await s2.getDoc('closedBids', 'CF2');
    ok(cf2 && cf2.laneFreight === null, 'A3 an auction with no anchor records laneFreight: null (additive)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
