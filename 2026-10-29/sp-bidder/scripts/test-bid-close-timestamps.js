'use strict';
/**
 * WHEN OUR BID LANDED, AND WHEN THE AUCTION ACTUALLY CLOSED (desk review, 8 Sep 2026).
 *
 * The desk used to read both off their previous spot-bids portal and judge a snipe by the gap:
 * "our last bid's timestamp used to come, then at the time of bid close we had to see the gap ...
 * normally it was only for one or two seconds", four to five minutes meaning the attempt never
 * really fired. Bid command recorded neither in a form that gap can be taken from - the engine
 * emitted the fire-time countdown and the bid record dropped it, and the receipt's "Bid Close Time"
 * was the instant this process finalized rather than the deadline the portal published.
 *
 * What this pins:
 *   A. every placed bid stores the platform countdown it fired against, on the record and on the
 *      un-backfillable daily stream, and that stream line carries the bid's own time not the append
 *      time
 *   B. a closed record carries the portal's own close (finalCloseAt) as a field DISTINCT from
 *      closedAt, carried forward, and null on a record whose result predates the capture
 *   C. the engine end-to-end: the close published at arm reaches auction_result and the record
 *   D. the receipt reads the portal's close, not our finalize instant, and names our last bid
 *   E. won / lost / no-bid render it, and degrade to the bare close time when a fact is missing
 *   F. the lead is the countdown the ADAPTER published, not close-minus-bid-ts - driven through a
 *      real engine + adapter run so the assertion constrains provenance and not just a fixture
 *   G. the two ways that pairing can lie, both of which reached a client-facing receipt in review:
 *      a close that moved after our last bid (the stored countdown no longer describes the reported
 *      close), and a close the engine knows is stale (earlier than our own last bid)
 *   H. an implausible close never reaches the receipt as a date
 *   I. the SHORT group replies carry the timing too - they are what the desk actually reads on a
 *      group-scoped loss, which is the case the request was about
 *
 *   node scripts/test-bid-close-timestamps.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, fmtDMY, fmtClock } = require('../src/notify/waTemplates');
const { reportedCloseAt } = require('../src/util/reportedClose');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `gc-stamps-${tag}-${process.pid}.json`);
const rm = (p) => { try { fs.unlinkSync(p); } catch (_) {} };

/** A rank-only adapter that can be flipped closed, publishing a countdown we control. */
function stubAdapter(closesInMs) {
  const a = {
    st: { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ...a.st }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 40 }),
    close: (rank) => { a.st = { ...a.st, status: 'closed', myRank: rank, closesInMs: 0 }; },
  };
  return a;
}

/** Arm one load through the real capture -> intent -> arm path and run it to close. */
async function runToClose(adapter, intentsFile, { closesAt, cost = 150_000 }) {
  const store = createStore({ backend: 'memory' });
  const events = [];
  const logger = new BidLogger({ store });
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), {
    config: { armLeadMs: 300 },
    onEvent: (e) => { events.push(e); logger.handle(e); },
  });
  const rq = new PriceRequestStore({ store, marginsPct: [14.4, 10.8, 8.1], minMarginPct: 5, platformKey: 'gocomet' });
  const created = await rq.createForLoad({
    id: 'GCE1', lane: { origin: 'Chikhli', destination: 'Kakinada' }, equipment: '20 ft ODC', units: 1,
    companyName: 'Waaree Energies Ltd.', closesAt, startsAt: Date.now() - 1_000, status: 'live', softClose: false,
  }, { deadlineAt: Date.now() + 60_000, platformKey: 'gocomet' });
  await armFromRequest(engine, await rq.capture(created.id, { cost }));
  return { store, events, engine, logger };
}

(async () => {
  // ---- A. the fire-time countdown reaches the record and the stream -------------------------
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const t0 = Date.now();
    const close = t0 + 300_000;

    await logger.handle({ type: 'armed', auctionId: 'GC1', ts: t0, platformKey: 'gocomet',
      companyName: 'Waaree Energies Ltd.', cost: 150_000 });
    // Two bids: an establishing one five minutes out, and the snipe two seconds before close.
    await logger.handle({ type: 'bid_placed', auctionId: 'GC1', ts: t0 + 1_000, price: 162_150,
      rungIndex: 0, closesInMs: 299_000, believedCloseAt: close });
    await logger.handle({ type: 'bid_placed', auctionId: 'GC1', ts: t0 + 298_000, price: 157_500,
      rungIndex: 2, closesInMs: 2_000, believedCloseAt: close });

    const rec = await store.getDoc('closedBids', 'GC1');
    assert.strictEqual(rec.ourBids[0].closesInMs, 299_000, 'the establishing bid keeps its countdown');
    assert.strictEqual(rec.ourBids[1].closesInMs, 2_000, 'the snipe keeps its own - 2s, not the first bid s');
    ok('each placed bid stores the platform countdown it actually fired against');

    // believedCloseAt already rode budgetContext; it is the close as KNOWN at that bid, and on a
    // load that extends between two bids the two entries legitimately differ. It is also what makes
    // the close/lead agreement check in section G possible, so it must stay per-bid.
    assert.strictEqual(rec.ourBids[0].believedCloseAt, close, 'and the close it believed at the time');
    ok('the per-bid believed close is still stored alongside it');

    const lines = (await store.readEvents('bids')).filter((e) => e.kind === 'bid_placed');
    assert.strictEqual(lines.length, 2, 'both bids on the daily stream');
    assert.strictEqual(lines[1].closesInMs, 2_000, 'the stream line carries the countdown too');
    // The stream is the half that cannot be backfilled, so a line stamped at append time rather
    // than fire time silently loses the only ordering fact a later reader has.
    assert.strictEqual(lines[1].ts, t0 + 298_000, 'and the bid own time, not the append time');
    ok('the un-backfillable stream carries the countdown and the fire time');

    // A bid from an adapter or harness that publishes no countdown must store null, not 0 - a zero
    // here would read as "fired at the close", which is the exact failure the desk reported.
    await logger.handle({ type: 'bid_placed', auctionId: 'GC1', ts: t0 + 298_500, price: 157_000, rungIndex: 3 });
    const rec2 = await store.getDoc('closedBids', 'GC1');
    assert.strictEqual(rec2.ourBids[2].closesInMs, null, 'an absent countdown stores null, never 0');
    ok('a bid with no published countdown stores null rather than a false on-the-buzzer zero');
  }

  // ---- B. the portal close on the closed record, distinct from our finalize instant ----------
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const t0 = Date.now();
    const portalClose = t0 + 300_000;
    // We finalize AFTER the real close - the sustained-zero debounce is seconds wide on a soft
    // close, so these two are never the same number and the receipt has to name the first.
    const finalizedAt = portalClose + 8_000;

    await logger.handle({ type: 'armed', auctionId: 'GC2', ts: t0, platformKey: 'gocomet' });
    await logger.handle({ type: 'auction_result', auctionId: 'GC2', ts: finalizedAt, won: false,
      finalRank: 3, finalCloseAt: portalClose });
    let rec = await store.getDoc('closedBids', 'GC2');
    assert.strictEqual(rec.finalCloseAt, portalClose, 'the record carries the close the portal published');
    assert.strictEqual(rec.closedAt, finalizedAt, 'and closedAt still answers when we finalized');
    assert.notStrictEqual(rec.finalCloseAt, rec.closedAt, 'two facts, two fields');
    ok('a closed record separates the portal close from our finalize instant');

    // A record closed before this capture existed has no portal close and must say so, not borrow
    // closedAt - a wrong close time is worse here than an absent one.
    await logger.handle({ type: 'armed', auctionId: 'GC3', ts: t0, platformKey: 'gocomet' });
    await logger.handle({ type: 'auction_result', auctionId: 'GC3', ts: finalizedAt, won: false, finalRank: 4 });
    rec = await store.getDoc('closedBids', 'GC3');
    assert.strictEqual(rec.finalCloseAt, null, 'a result with no portal close stores null');
    ok('a result carrying no portal close leaves the field null rather than borrowing closedAt');

    // A second result on the same auction (a rate-model or replayed close) must not blank one that
    // was already established.
    await logger.handle({ type: 'auction_result', auctionId: 'GC2', ts: finalizedAt + 1_000, won: false, finalRank: 3 });
    rec = await store.getDoc('closedBids', 'GC2');
    assert.strictEqual(rec.finalCloseAt, portalClose, 'an established portal close survives a later bare result');
    ok('the portal close is carried forward, never blanked by a later result');
  }

  // ---- C. end to end: the close published at arm reaches the record --------------------------
  {
    const intents = tmp('e2e');
    const adapter = stubAdapter(8_000);
    const closesAt = Date.now() + 8_000;
    const { store, events, engine, logger } = await runToClose(adapter, intents, { closesAt });

    await sleep(600);
    adapter.close(3);
    await sleep(900);

    const result = events.find((e) => e.type === 'auction_result');
    assert.ok(result, 'the auction closed');
    assert.strictEqual(result.finalCloseAt, closesAt, 'auction_result carries the close the load published');
    await logger.handle({ type: 'noop' }); // drain the logger tail before reading the record
    const rec = await store.getDoc('closedBids', 'GCE1');
    assert.strictEqual(rec.finalCloseAt, closesAt, 'and it lands on the closed record');
    const placed = events.filter((e) => e.type === 'bid_placed');
    assert.ok(placed.length > 0 && placed[0].closesInMs != null, 'the engine publishes a countdown on each bid');
    assert.strictEqual(rec.ourBids[0].closesInMs, placed[0].closesInMs, 'which the record stores unchanged');
    ok('arm -> bid -> close carries both stamps through the real engine onto the record');

    engine.kill('test done');
    rm(intents);
  }

  // ---- D. the receipt reads the portal close and names our last bid --------------------------
  {
    const portalClose = Date.UTC(2026, 8, 8, 12, 29, 0);  // rendered in server-local time by fmtDMY
    const rec = {
      cost: 150_000, lastBidPrice: 157_500, finalRank: 3,
      // On GoComet the sustained-zero finalize debounce is sized off the 299s extension increment,
      // so a soft close is genuinely declared minutes after the deadline the portal published.
      closedAt: portalClose + 302_000, finalCloseAt: portalClose,
      ourBids: [
        { price: 162_150, ts: portalClose - 299_000, closesInMs: 299_000, believedCloseAt: portalClose },
        { price: 157_500, ts: portalClose - 2_000, closesInMs: 2_000, believedCloseAt: portalClose },
      ],
    };
    const d = outcomeEnrichment(rec);
    assert.strictEqual(d.closeTime, fmtDMY(portalClose), 'closeTime is the portal close');
    assert.notStrictEqual(d.closeTime, fmtDMY(rec.closedAt), 'not our finalize instant');
    assert.strictEqual(d.lastBidTime, fmtClock(portalClose - 2_000), 'the LAST bid clock, not the first');
    assert.strictEqual(d.lastBidLeadMs, 2_000, 'and its stored lead');
    ok('the outcome payload carries the portal close plus our last bid time and lead');

    // Records written before finalCloseAt existed keep rendering exactly what they always did.
    const legacy = { ...rec, finalCloseAt: undefined, ourBids: [] };
    const dl = outcomeEnrichment(legacy);
    assert.strictEqual(dl.closeTime, fmtDMY(rec.closedAt), 'a pre-capture record falls back to closedAt');
    assert.strictEqual(dl.lastBidTime, undefined, 'and claims no bid time it does not have');
    assert.strictEqual(dl.lastBidLeadMs, undefined, 'nor a lead');
    ok('a record predating the capture renders as it always did');
  }

  // ---- E. what the group actually reads ------------------------------------------------------
  {
    const base = { oaNo: '260908LD2Z', from: 'Chikhli 396530', to: 'Kakinada 533005',
      vehicleType: '1 x 20 ft ODC', finalRank: 3, attempts: 2, marketRate: '1,50,000',
      marginRate: '1,57,500', closeTime: '08-09-2026 05:59 PM',
      lastBidTime: '05:58 pm', lastBidLeadMs: 2_000 };

    // TWO LINES, not one (F-D, 2026-09-11): the single line ran past a phone's width and wrapped
    // mid-parenthesis, which buried the gap - the fact the desk reads this line for. The close
    // keeps its own line and the bid timing takes the next.
    for (const kind of ['won', 'lost']) {
      const msg = renderMessage(kind, base);
      assert.ok(msg.includes('*Bid Close Time* - 08-09-2026 05:59 PM\n⏱ *Our last bid* - 05:58 pm (2s before close)'),
        `${kind} puts the close on its line and our last bid on the next`);
      const closeLine = msg.split('\n').find((l) => l.includes('Bid Close Time'));
      assert.ok(!/[()]/.test(closeLine) && !closeLine.includes('our last bid'),
        `${kind} leaves nothing of the bid timing on the close line`);
    }
    ok('the won and lost receipts split the close and our last bid onto two lines');

    // A four-minute gap is the shape the desk reported as "the attempt never fired" - it has to be
    // legible as minutes rather than 240s.
    const late = renderMessage('lost', { ...base, lastBidLeadMs: 245_000 });
    assert.ok(late.includes('⏱ *Our last bid* - 05:58 pm (4 min before close)'), 'a minutes-wide gap reads in minutes');
    ok('a minutes-wide gap reads in minutes, which is how the desk described the failure');

    // No bid at all -> the bare close time, no dangling parenthesis.
    const nb = renderMessage('no_bid', { ...base, lastBidTime: undefined, lastBidLeadMs: undefined });
    // Scoped to the close-time LINE: the no-bid reason underneath legitimately says "before close".
    const nbLine = nb.split('\n').find((l) => l.includes('Bid Close Time'));
    assert.ok(!/[()]/.test(nbLine) && !nbLine.includes('before close'), 'and no empty or half-built parenthesis');
    assert.ok(!nb.includes('Our last bid'), 'and no second line with nothing to put on it');
    ok('a no-bid receipt renders the close time alone');

    // A bid the portal timed at or past the close cannot be described as "0s before close".
    const atBuzzer = renderMessage('lost', { ...base, lastBidLeadMs: 0 });
    assert.ok(atBuzzer.includes('⏱ *Our last bid* - 05:58 pm\n'), 'a zero lead still names the bid time');
    assert.ok(!atBuzzer.includes('before close'), 'but claims no lead it cannot stand behind');
    ok('a zero or past-close lead names the bid time without inventing a gap');
  }

  // ---- F. the lead is the countdown the ADAPTER published, not close-minus-bid-ts -------------
  {
    // Driven through a real engine + adapter run rather than a hand-written record, so the
    // assertion constrains where the number CAME FROM. The adapter publishes a 4s countdown while
    // the load's own close is 9s out, so close-minus-bid-ts is several seconds larger than the
    // published countdown and the two answers are distinguishable. A hand-written fixture cannot
    // make that distinction - it would pass against an implementation that did the subtraction.
    const intents = tmp('provenance');
    const adapter = stubAdapter(4_000);
    const closesAt = Date.now() + 9_000;
    const { store, engine, logger } = await runToClose(adapter, intents, { closesAt });

    await sleep(600);
    adapter.close(3);
    await sleep(900);
    await logger.handle({ type: 'noop' });

    const rec = await store.getDoc('closedBids', 'GCE1');
    assert.ok(rec && rec.ourBids.length > 0, 'the run produced a bid record');
    const d = outcomeEnrichment(rec);
    assert.strictEqual(d.lastBidLeadMs, 4_000,
      `the lead is the adapter published countdown (got ${d.lastBidLeadMs})`);

    const lastBid = rec.ourBids[rec.ourBids.length - 1];
    const subtraction = rec.finalCloseAt - lastBid.ts;
    assert.ok(subtraction > 6_000,
      `the subtraction answer is materially different here (got ${subtraction}ms)`);
    assert.notStrictEqual(d.lastBidLeadMs, subtraction,
      'and the render did not take it - close-minus-bid-ts is never the reported gap');
    ok('the reported gap comes from the adapter countdown, not from subtracting two clocks');

    engine.kill('test done');
    rm(intents);
  }

  // ---- G. the two ways the close/lead pairing can lie -----------------------------------------
  {
    const portalClose = Date.UTC(2026, 8, 8, 12, 29, 0);

    // G1: the auction EXTENDED after our last bid. The stored 2s was measured against the close in
    // force then, not against the close finally reported - printing it as the gap to the later
    // close says "clean snipe" on a load where nothing of ours fired in the final round.
    const extended = outcomeEnrichment({
      cost: 150_000, lastBidPrice: 157_500, finalRank: 3,
      closedAt: portalClose + 8_000, finalCloseAt: portalClose,
      ourBids: [{ price: 157_500, ts: portalClose - 182_000, closesInMs: 2_000,
        believedCloseAt: portalClose - 180_000 }],
    });
    assert.strictEqual(extended.closeTime, fmtDMY(portalClose), 'the reported close is still the final one');
    assert.strictEqual(extended.lastBidTime, fmtClock(portalClose - 182_000), 'our last bid time is still named');
    assert.strictEqual(extended.lastBidLeadMs, undefined,
      'but the stale countdown is NOT offered as the gap to a close it never measured');
    const msg = renderMessage('lost', { oaNo: 'x', ...extended });
    assert.ok(!msg.includes('before close'), 'and the receipt claims no gap');
    assert.ok(msg.includes('⏱ *Our last bid* - '), 'while still naming when we last bid');
    ok('a close that moved after our last bid suppresses the gap instead of misreporting it');

    // G2: the engine's believed close is STALE (the inferred-extension branch never advanced it),
    // so the portal number predates our own last bid. Reporting it would tell the desk we bid after
    // the auction closed. closedAt was late but never early - that is the safe number here.
    const stale = outcomeEnrichment({
      cost: 150_000, lastBidPrice: 157_500, finalRank: 3,
      closedAt: portalClose + 190_000, finalCloseAt: portalClose,
      ourBids: [{ price: 157_500, ts: portalClose + 120_000, closesInMs: 500, believedCloseAt: portalClose }],
    });
    assert.strictEqual(stale.closeTime, fmtDMY(portalClose + 190_000),
      'a portal close earlier than our own last bid falls back to the finalize instant');
    assert.strictEqual(stale.lastBidLeadMs, undefined, 'and offers no gap against a close it rejected');
    ok('a stale portal close earlier than our last bid is not reported as the close');
  }

  // ---- H. an implausible close never reaches the receipt as a date ----------------------------
  {
    // Both sentinels the engine's own plausibleCloseAt exists for: a finite 0 that reads as 1 Jan
    // 1970, and SuperProcure's year-2100 placeholder. The guard runs at the emit site, so drive the
    // engine and mutate the live monitor the way a bad platform read would have.
    for (const [label, sentinel] of [['epoch zero', 0], ['year-2100 placeholder', Date.UTC(2100, 4, 24)]]) {
      const intents = tmp(`sentinel-${sentinel}`);
      const adapter = stubAdapter(6_000);
      const { store, events, engine, logger } = await runToClose(adapter, intents, { closesAt: Date.now() + 6_000 });
      await sleep(500);
      const monitor = engine.monitors.get('GCE1');
      assert.ok(monitor, 'the load armed');
      monitor.believedCloseAt = sentinel;
      adapter.close(3);
      await sleep(900);
      await logger.handle({ type: 'noop' });

      const result = events.find((e) => e.type === 'auction_result');
      assert.strictEqual(result.finalCloseAt, null, `${label} is refused at the emit site`);
      const rec = await store.getDoc('closedBids', 'GCE1');
      assert.strictEqual(rec.finalCloseAt, null, `${label} never reaches the record`);
      const d = outcomeEnrichment(rec);
      assert.strictEqual(d.closeTime, fmtDMY(rec.closedAt), `${label} degrades to the finalize instant`);
      assert.ok(!d.closeTime.includes('1970') && !d.closeTime.includes('2100'),
        `${label} never renders as a date on the receipt`);

      engine.kill('test done');
      rm(intents);
    }
    ok('an epoch-zero or far-future close is refused at the emit site and never renders');
  }

  // ---- I. the SHORT group replies carry the timing too ----------------------------------------
  {
    // notifier._deliverGroup renders the SHORT body whenever an ask thread exists, which is the
    // normal shape for a group-scoped customer. A loss is the case the desk described, so the
    // signal has to survive here or it lands nowhere for most losses.
    const base = { shipper: 'Waaree Energies Ltd.', origin: 'Chikhli', dest: 'Kakinada',
      laneFrom: 'Chikhli 396530', laneTo: 'Kakinada 533005', shipperRef: '3260109306',
      vehicleType: '1 x 20 ft ODC', finalRank: 3, marketRate: '1,50,000', marginRate: '1,57,500',
      lastBidTime: '05:58 pm', lastBidLeadMs: 2_000 };

    const lost = renderMessage('lost_short', base);
    assert.ok(lost.includes('*Last bid* - 05:58 pm, 2s before close'),
      'the short loss reply names our last bid and the gap');
    assert.ok(!lost.includes('08-09-2026'), 'without repeating the full close the ask above already carries');
    ok('the short loss reply carries the bid time and the gap');

    const nb = renderMessage('no_bid_short', base);
    assert.ok(nb.includes('*Last bid* - 05:58 pm, 2s before close'), 'and so does the short no-bid reply');
    ok('the short no-bid reply carries it too');

    // A gap-less record must leave both short bodies byte-identical to what they rendered before.
    const bare = { ...base, lastBidTime: undefined, lastBidLeadMs: undefined };
    assert.ok(!renderMessage('lost_short', bare).includes('Last bid'), 'no timing known -> no line');
    assert.ok(!renderMessage('no_bid_short', bare).includes('Last bid'), 'on both short bodies');
    assert.ok(!renderMessage('lost_short', bare).includes('⏱'), 'and no orphaned icon');
    ok('a record with no timing leaves the short replies exactly as they were');
  }

  // ---- J. the receipt and the export state ONE close for one load ----------------------------
  {
    // Two client-facing surfaces, one fact. They diverged once already: the export took the portal
    // close unconditionally while the receipt took it through the staleness fallback, so on a stale
    // record the sheet showed a close 190s earlier than the message - and earlier than the bid time
    // the sheet itself listed. Pin agreement on both record shapes rather than the rule twice.
    const portalClose = Date.UTC(2026, 8, 8, 12, 29, 0);
    const shapes = [
      ['an ordinary soft close', {
        closedAt: portalClose + 302_000, finalCloseAt: portalClose,
        ourBids: [{ price: 157_500, ts: portalClose - 2_000, closesInMs: 2_000, believedCloseAt: portalClose }],
      }],
      ['a stale portal close, later than our own last bid', {
        closedAt: portalClose + 190_000, finalCloseAt: portalClose,
        ourBids: [{ price: 157_500, ts: portalClose + 120_000, closesInMs: 500, believedCloseAt: portalClose }],
      }],
      ['a record with no portal close at all', {
        closedAt: portalClose + 8_000, finalCloseAt: null,
        ourBids: [{ price: 157_500, ts: portalClose - 2_000, closesInMs: 2_000 }],
      }],
    ];
    for (const [label, rec] of shapes) {
      const onReceipt = outcomeEnrichment({ cost: 150_000, lastBidPrice: 157_500, finalRank: 3, ...rec }).closeTime;
      const onExport = fmtDMY(reportedCloseAt(rec));
      assert.strictEqual(onReceipt, onExport, `${label}: receipt and export must state the same close`);
    }
    ok('the receipt and the export resolve the close through one shared rule, on every record shape');

    // And the export never prints an auction close before the bid time it lists for the same load.
    const stale = { closedAt: portalClose + 190_000, finalCloseAt: portalClose,
      ourBids: [{ price: 157_500, ts: portalClose + 120_000, closesInMs: 500, believedCloseAt: portalClose }] };
    assert.ok(reportedCloseAt(stale) >= stale.ourBids[0].ts,
      'the exported auction close is never earlier than our own recorded bid');
    ok('the exported auction close is never earlier than the bid time on the same load');

    // Shapes that come back from persisted JSON rather than a fixture must not throw.
    for (const [label, rec] of [
      ['a string timestamp', { closedAt: String(portalClose), finalCloseAt: String(portalClose) }],
      ['no ourBids at all', { closedAt: portalClose, finalCloseAt: portalClose }],
      ['a null entry in ourBids', { closedAt: portalClose, finalCloseAt: portalClose, ourBids: [null] }],
      ['an unparseable close', { closedAt: portalClose, finalCloseAt: 'soon' }],
      ['nothing known', {}],
    ]) {
      assert.doesNotThrow(() => reportedCloseAt(rec), `${label} must not throw`);
    }
    assert.strictEqual(reportedCloseAt({ closedAt: portalClose, finalCloseAt: 'soon' }), portalClose,
      'an unparseable portal close degrades to the finalize instant');
    assert.strictEqual(reportedCloseAt({}), null, 'a record carrying neither fact resolves to null');
    ok('the shared resolver survives every record shape persisted JSON can hand it');
  }

  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
