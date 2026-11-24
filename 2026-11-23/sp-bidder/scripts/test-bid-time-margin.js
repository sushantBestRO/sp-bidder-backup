'use strict';
/**
 * F-C - the WON/LOST receipt's margin is measured against the cost that priced the bid (the
 * bid-time cost), not whatever the desk has since corrected it to.
 *
 * The forensic record this file was originally built on (load 260908LD2Z, verbatim from production):
 *
 *   {"auctionId":"260908LD2Z", "cost":38000, "floor":38684, "ladder":[41420,40736,38684],
 *    "ourBids":[{"price":31610,"rungIndex":0}], "lastBidPrice":31610, "won":true}
 *
 * The desk entered 29,000, the engine bid 31,610 (+9%), the desk corrected the cost to 38,000 two
 * minutes later. CW-212 anchored the margin on 29,000 - the cost that priced the bid - so the
 * receipt read +9.00%. A later change (7e6f9d6) flipped the anchor onto the corrected cost, which
 * could and did print a negative margin (-16.82%) on a bid that was correct when it was placed.
 * The owner reversed that on 2026-09-11 (final): the margin is measured against the bid-time cost
 * and can never be negative for a bid that carries a real snapshot, because the floor invariant
 * (assertAboveFloor) never lets a placed price fall below it.
 *
 * The bid-time cost does not blot out what happened after: an informational "Rate changed" line
 * still states the correction (kept from 7e6f9d6, no warning glyph, rendered directly under the
 * margin line), and a win that now sits below a corrected-up cost still gets a factual rupee
 * consequence line - restored from the original design, rupee gap only, never a second (negative)
 * percentage.
 *
 * What this pins:
 *   E. the whole chain on the REAL engine: bid_placed carries the ladder's cost, and the logger
 *      stamps it onto the ourBids[] entry - the trail's "from" figure has to come from somewhere.
 *   A. the anchor load renders +9.00% against 29,000, with the rate-change trail and the
 *      below-cost consequence line both present.
 *   B. a row carrying no bid-time snapshot renders exactly as it always has, off the doc cost.
 *   C. a re-price the engine ANSWERED shows no trail at all - the two costs agree; one it did NOT
 *      answer reports the bid-time truth, with the trail showing where the cost has since moved.
 *   D. a degenerate snapshot falls back rather than printing NaN.
 *   F. the floor is judged in the same epoch as the margin - the bid-time one.
 *   G. the trail: when it fires, what it says, and that it sits adjacent to the margin.
 *   H. the advice on a below-cost win, on both the snapshot-bearing and the snapshot-less shape.
 *
 *   node scripts/test-bid-time-margin.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const T0 = 1788869161610; // the anchor load's own price-request createdAt
const tmp = (tag) => path.join(os.tmpdir(), `btm-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

// Waaree's band as it stood on the anchor load, and the first capture's inherited customer floor.
const BAND = [9, 7.2, 1.8];

(async () => {
  // ============================================================================================
  // E - the real engine emits the ladder's cost on bid_placed, and the real logger persists it.
  // ============================================================================================
  {
    const intents = tmp('eng');
    const closesAt = Date.now() + 5000;
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({
        ok: true, status: Date.now() >= closesAt ? 'closed' : 'live',
        myRank: 2, totalBidders: 5, standingL1Price: null,
        closesInMs: Math.max(0, closesAt - Date.now()),
        revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50,
      }),
      placeBid: async () => ({ accepted: true, myRank: null, revisionsLeft: 2, latencyMs: 60 }),
    };
    const scheduler = new DurableScheduler(intents);
    const pending = [];
    const engine = new BidEngine(adapter, scheduler, {
      config: { openAtMs: 15000, floorWindowMs: 2500 },
      onEvent: (e) => pending.push(logger.handle(e)),
    });
    engine.arm(
      { id: 'E1', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt },
      { cost: 29000, marginsPct: BAND, minMarginPct: 1 },
    );
    await new Promise((r) => setTimeout(r, 6000));
    await Promise.all(pending);
    try { fs.unlinkSync(intents); } catch (_) {}

    const rec = await store.getDoc('closedBids', 'E1');
    ok(rec && Array.isArray(rec.ourBids) && rec.ourBids.length >= 1, `E engine placed and logged at least one bid (got ${rec && rec.ourBids ? rec.ourBids.length : 'none'})`);
    ok(rec.ourBids.every((b) => b.bidTimeCost === 29000), 'E every logged bid carries the cost its ladder was built from');
    ok(rec.ourBids.every((b) => b.bidTimeMinMarginPct === 1), 'E and the operating floor that authorised that price, from the same intent');
    const stream = await store.readEvents('bids');
    const placed = stream.filter((e) => e.kind === 'bid_placed' && e.auctionId === 'E1');
    ok(placed.length >= 1 && placed.every((e) => e.bidTimeCost === 29000), 'E the un-backfillable bids jsonl carries the bid-time cost too');
    ok(placed.every((e) => e.bidTimeMinMarginPct === 1), 'E and the bid-time floor on the jsonl too');
    // The opening rung is the band's top margin off that cost.
    ok(rec.ourBids[0].price === 31610, `E the opening bid is cost x 1.09 (got ${rec.ourBids[0].price})`);
  }

  // ============================================================================================
  // A - the anchor. Reproduce the production splice through the real logger (arm at 29,000, bid,
  //     re-arm at 38,000 - which is what overwrites the doc-level cost while ourBids carries
  //     forward) and assert the receipt reports the BID-TIME margin plus both the info trail and
  //     the factual below-cost consequence.
  // ============================================================================================
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const armed = {
      type: 'armed', auctionId: '260908LD2Z', lane: { origin: 'Degam', destination: 'Kakinada' },
      equipment: '32ft', units: 1, companyName: 'Waaree Energies Ltd.', platformKey: 'gocomet',
      marginsPct: BAND, minMarginPct: 1,
    };
    await logger.handle(Object.assign({}, armed, { ts: T0, cost: 29000, ladder: [31610, 31088, 29290], floor: 29290 }));
    await logger.handle({ type: 'bid_placed', auctionId: '260908LD2Z', ts: T0 + 52000, price: 31610, rungIndex: 0, rank: null, socketRank: 1, cost: 29000, minMarginPct: 1 });
    // The desk corrects the cost. reArmWithNewBand = stop + armFromRequest, so this arrives as a
    // second 'armed' with the new band - and its minMarginPct is 1.8, the override the desk set.
    await logger.handle(Object.assign({}, armed, { ts: T0 + 163000, cost: 38000, ladder: [41420, 40736, 38684], floor: 38684, minMarginPct: 1.8 }));
    await logger.handle({ type: 'auction_result', auctionId: '260908LD2Z', ts: T0 + 7933000, won: true, finalRank: 1, closeModel: 'soft' });

    const rec = await store.getDoc('closedBids', '260908LD2Z');
    // First prove the fixture IS the production shape - a winning bid inside a row whose own lowest
    // ladder rung is above it. Without this the rest of the section could pass on a benign record.
    ok(rec.cost === 38000 && rec.lastBidPrice === 31610 && rec.ladder[2] === 38684,
      'A the splice is reproduced: doc cost 38,000, ladder floor 38,684, landed bid 31,610');
    ok(rec.ourBids.length === 1 && rec.ourBids[0].bidTimeCost === 29000,
      'A the re-arm carries the bid forward WITH its cost snapshot (the trail needs that figure)');

    const e = outcomeEnrichment(rec);
    ok(e.marginPct === '9.00', `A the won receipt reports the bid-time margin, +9.00% (got ${e.marginPct})`);
    ok(e.marketRate === '29,000', `A "Your Rate" is the cost that priced the bid (got ${e.marketRate})`);
    ok(e.wonRate === '31,610', 'A "Won Rate" is unchanged - our own placed bid');
    ok(e.minMarginPct === 1, `A the floor comes from the same epoch as the cost - the bid-time 1, not the doc's 1.8 (got ${e.minMarginPct})`);
    ok(e.rateChangedFrom === '29,000' && e.rateChangedTo === '38,000',
      `A and the rate change rides through as an informational pair (got ${e.rateChangedFrom} -> ${e.rateChangedTo})`);
    ok(e.costCorrectedTo === '38,000' && e.belowCostBy === '6,390',
      `A and the win's factual position against that corrected cost is stated in rupees (got costCorrectedTo=${e.costCorrectedTo}, belowCostBy=${e.belowCostBy})`);

    // The client-visible lines, not just the fields.
    const data = Object.assign({ oaNo: '260908LD2Z', finalRank: 1, landedBids: 1 }, e);
    const body = renderMessage(templateFor('won', data), data);
    ok(body.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'),
      `A the margin is inline on the Won Rate line, positive (got: ${(body.match(/Won Rate[^\n]*/) || ['<no won-rate line>'])[0]})`);
    ok(body.includes('ℹ️ *Rate changed* - ₹29,000 -> ₹38,000'),
      `A and the correction is stated as info, directly under the margin (got: ${(body.match(/Rate changed[^\n]*/) || ['<no trail line>'])[0]})`);
    ok(body.split('\n')[1] === '⚠️ *Cost increased to* ₹38,000 - ₹6,390 above the won amount. Please check on portal.',
      `A and the win's rupee position is line 2 of the receipt, not a field in the body (got: ${body.split('\n')[1]})`);
    ok(!body.includes('⚠️ *Rate changed'), 'A the rate-change trail itself carries no warning glyph - it is information, not an alarm');
    ok(!/your rate [0-9]/.test(body), 'A and no line restates the rate the Your Rate line already carries');
    ok(!body.includes('place at a lower rate'), 'A and the ordinary thin-margin nag is suppressed - the below-cost line already said where this stands');
  }

  // ============================================================================================
  // B - back-compat. Every one of the 3,136 rows written before the snapshot existed has ourBids
  //     entries with no bidTimeCost key at all. They must render exactly as they do today.
  // ============================================================================================
  {
    const legacy = {
      auctionId: '24689515', cost: 75000, lastBidPrice: 77700, won: false, finalRank: 6,
      status: 'closed', closedAt: T0,
      // verbatim pre-change shape - no bidTimeCost key on either entry
      ourBids: [{ price: 79350, rungIndex: 0, rank: null, ts: T0 }, { price: 77700, rungIndex: 1, rank: null, ts: T0 + 1000 }],
    };
    const e = outcomeEnrichment(legacy);
    ok(e.marketRate === '75,000', `B a pre-change row anchors on the doc-level cost (got ${e.marketRate})`);
    ok(e.marginPct === '3.60', `B a pre-change row renders the same margin it does today (got ${e.marginPct})`);
    ok(e.attempts === 2 && e.marginRate === '77,700', 'B the rest of the pre-change enrichment is untouched');
    ok(e.rateChangedFrom === undefined && e.rateChangedTo === undefined,
      'B and it claims no rate change - with no snapshot there is nothing to compare against');

    // A no-bid close: no ourBids at all, so no snapshot can exist. The desk's entered rate is still
    // what the receipt must name, and no margin can be computed from one bid that never happened.
    const noBid = { auctionId: '25084674', cost: 53000, lastBidPrice: null, won: false, ourBids: [], status: 'closed' };
    const n = outcomeEnrichment(noBid);
    ok(n.marketRate === '53,000' && n.marginPct === undefined, 'B a zero-bid close still names the entered rate and claims no margin');
  }

  // ============================================================================================
  // C - the two costs AGREE on most loads, and there the receipt must not move at all.
  // ============================================================================================
  {
    // C1 - load 260908A2W4: the desk re-priced 120,000 -> 90,000 and the engine DID answer it, so
    // the last bid was already priced off the current cost. This is the guard against a "fix" that
    // puts a trail line on every receipt in the system.
    const answered = {
      auctionId: '260908A2W4', cost: 90000, lastBidPrice: 96480, won: false, finalRank: 2, status: 'closed',
      ourBids: [
        { price: 130800, rungIndex: 0, ts: T0, bidTimeCost: 120000 },
        { price: 98100, rungIndex: 0, ts: T0 + 5900000, bidTimeCost: 90000 },
        { price: 96480, rungIndex: 1, ts: T0 + 5934000, bidTimeCost: 90000 },
      ],
    };
    const a = outcomeEnrichment(answered);
    ok(a.marginPct === '7.20', `C1 a re-price the engine answered reports its LAST bid's margin, +7.20% (got ${a.marginPct})`);
    ok(a.marketRate === '90,000', 'C1 anchored on the cost that is also the last bid-time cost');
    ok(a.rateChangedFrom === undefined,
      'C1 and carries NO trail line - the last bid was priced off the cost the margin uses');

    // C2 - the down-revision drift (the 260818DVL8 shape): bid at +8.10% off 95,000, cost later
    // corrected DOWN to 77,000 with no further bid landing. The bid-time margin (+8.10%) is what
    // was actually earned; the trail says the cost has since moved, without touching the margin.
    const drifted = {
      auctionId: '260818DVL8', cost: 77000, lastBidPrice: 102695, won: true, finalRank: 1, status: 'closed',
      ourBids: [{ price: 102695, rungIndex: 0, ts: T0, bidTimeCost: 95000 }],
    };
    const d = outcomeEnrichment(drifted);
    ok(d.marginPct === '8.10', `C2 a downward correction still reports the bid-time margin (got ${d.marginPct})`);
    ok(d.marketRate === '95,000', `C2 and names the cost that actually priced the bid (got ${d.marketRate})`);
    ok(d.rateChangedFrom === '95,000' && d.rateChangedTo === '77,000', 'C2 with the trail naming both figures');
    ok(d.costCorrectedTo === undefined,
      'C2 and no below-cost line - the win sits comfortably above the corrected cost, nothing to warn about');
  }

  // ============================================================================================
  // D - a degenerate snapshot must fall back to the doc-level cost, never reach the message.
  // ============================================================================================
  {
    const base = { auctionId: 'D1', cost: 50000, lastBidPrice: 55000, won: false, status: 'closed' };
    const cases = [
      [null, 'null (a rate-model or mock arm carries no cost)'],
      [0, 'zero (nothing can be a margin against it)'],
      ['not-a-number', 'a non-numeric value'],
    ];
    for (const [snapshot, label] of cases) {
      const e = outcomeEnrichment(Object.assign({}, base, { ourBids: [{ price: 55000, rungIndex: 0, ts: T0, bidTimeCost: snapshot }] }));
      ok(e.marketRate === '50,000' && e.marginPct === '10.00', `D a bidTimeCost of ${label} renders off the doc cost`);
      ok(e.rateChangedFrom === undefined, `D a bidTimeCost of ${label} claims no change it cannot evidence`);
    }
    // A record with no doc cost falls the OTHER way - onto the snapshot - rather than losing the
    // money block entirely. The margin still has a real cost behind it; there is just no change.
    const docless = outcomeEnrichment({ auctionId: 'D3', lastBidPrice: 55000, status: 'closed',
      ourBids: [{ price: 55000, rungIndex: 0, ts: T0, bidTimeCost: 50000 }] });
    ok(docless.marketRate === '50,000' && docless.marginPct === '10.00', 'D a doc with no cost falls back to the snapshot');
    ok(docless.rateChangedFrom === undefined, 'D and reports no change - there is no doc cost to compare against');

    // and the same record with no cost anywhere claims neither field rather than rendering NaN.
    const blind = outcomeEnrichment({ auctionId: 'D2', lastBidPrice: 55000, ourBids: [{ price: 55000, bidTimeCost: null }], status: 'closed' });
    ok(blind.marketRate === undefined && blind.marginPct === undefined, 'D with no cost on either side the receipt omits both rather than printing NaN');
  }

  // ============================================================================================
  // F - the floor is judged in the same epoch as the margin. marginPct feeds waTemplates.wonWarning,
  //     which compares it against minMarginPct; taking one from the bid and the other from the doc
  //     is the same cross-epoch error one level down.
  // ============================================================================================
  {
    // Bid authorised at cost 100,000 against an 8% floor; placed at 105,000 (+5.00% - under that
    // floor). The desk then corrected the cost DOWN to 96,000 and set a 2% floor on the doc. The
    // margin and the floor it is judged against both stay on the bid-time epoch, so the nag still
    // fires - the bid landed under the floor that actually authorised it.
    const rec = {
      auctionId: 'F1', cost: 96000, minMarginPct: 2, won: true, finalRank: 1, status: 'closed', closedAt: T0,
      ourBids: [{ price: 105000, rungIndex: 0, ts: T0, bidTimeCost: 100000, bidTimeMinMarginPct: 8 }],
      lastBidPrice: 105000,
    };
    const e = outcomeEnrichment(rec);
    ok(e.marginPct === '5.00', `F the margin is measured on the bid-time cost (got ${e.marginPct})`);
    ok(e.minMarginPct === 8, `F and the floor it is judged against comes from the same epoch, not the doc's 2 (got ${e.minMarginPct})`);
    ok(e.rateChangedFrom === '1,00,000' && e.rateChangedTo === '96,000', 'F and the trail states the correction, unrelated to the margin epoch');
    const data = Object.assign({ oaNo: 'F1', finalRank: 1, landedBids: 1 }, e);
    ok(renderMessage(templateFor('won', data), data).includes('Margin low - only 5.00%'),
      'F a bid that landed under its OWN floor still nags, judged against that floor');

    // A doc with no floor of its own falls back to the bid's, rather than to the 5% default that
    // governs nothing on this load. And with no floor field on the bid either, the pair is omitted
    // entirely rather than mixed from two epochs.
    const noFloor = outcomeEnrichment({
      auctionId: 'F2', cost: 96000, minMarginPct: 2, won: true, status: 'closed',
      ourBids: [{ price: 105000, rungIndex: 0, ts: T0, bidTimeCost: 100000 }], lastBidPrice: 105000,
    });
    ok(noFloor.marginPct === '5.00' && noFloor.minMarginPct === undefined,
      `F a bid-time cost with no bid-time floor omits the floor rather than pairing it with the doc's 2 (got ${noFloor.minMarginPct})`);

    // A legacy row anchors both on the doc, exactly as before.
    const legacy = outcomeEnrichment({
      auctionId: 'F3', cost: 100000, minMarginPct: 2, won: true, status: 'closed',
      ourBids: [{ price: 105000, rungIndex: 0, ts: T0 }], lastBidPrice: 105000,
    });
    ok(legacy.marginPct === '5.00' && legacy.minMarginPct === 2,
      'F a pre-change row keeps the doc-level pair it has always rendered');
  }

  // ============================================================================================
  // G - the trail. The margin says whether the bid was priced right when it went out; the trail
  //     says how the rate got to where it stands now. Rendered text is what the human approves.
  // ============================================================================================
  {
    const render = (rec, kind) => {
      const d = Object.assign({ oaNo: rec.auctionId, finalRank: rec.finalRank, landedBids: 1 }, outcomeEnrichment(rec));
      return renderMessage(templateFor(kind || 'won', d), d);
    };
    const base = { finalRank: 1, won: true, status: 'closed', closedAt: T0, units: 1 };

    // G1 - costs agree (the ordinary win). Nothing changed, so no trail.
    const agree = Object.assign({ auctionId: 'G1', cost: 29000, minMarginPct: 1, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0, bidTimeCost: 29000, bidTimeMinMarginPct: 1 }] }, base);
    const g1 = render(agree);
    ok(!g1.includes('Rate changed'), 'G1 costs agree -> no trail line');
    ok(g1.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'), 'G1 and the bid-time margin renders inline, positive');

    // G2 - the anchor. Corrected UP after the bid; the win stands under the rate that now governs.
    // THE ADJACENCY REQUIREMENT: the trail sits on the line directly under the margin it explains.
    // The consequence of that correction is NOT here - it is line 2 of the receipt (section I).
    const belowRec = Object.assign({ auctionId: '260908LD2Z', cost: 38000, minMarginPct: 1.8, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0, bidTimeCost: 29000, bidTimeMinMarginPct: 1 }] }, base);
    const g2 = render(belowRec);
    ok(/🏆 \*Won Rate\* - ₹31,610 \(\+9\.00%\)\nℹ️ \*Rate changed\* - ₹29,000 -> ₹38,000\n/.test(g2),
      'G2 the margin and the trail that explains it sit on consecutive lines');
    ok(!g2.includes('Squeeze the vendor and place at a lower rate'),
      'G2 the bid-lower nag stays suppressed on a below-cost win');

    // G2b - corrected up, but the win still clears it. Only the informational trail fires; there is
    // no rupee gap to report and the bid-time margin (comfortably above its own floor) does not nag.
    const thin = Object.assign({ auctionId: 'G2b', cost: 31000, minMarginPct: 6.3, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0, bidTimeCost: 29000, bidTimeMinMarginPct: 6.3 }] }, base);
    const g2b = render(thin);
    ok(g2b.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'), 'G2b the bid-time margin is unaffected by the correction');
    ok(g2b.includes('ℹ️ *Rate changed* - ₹29,000 -> ₹31,000'), 'G2b and the trail still states that the cost moved');
    ok(!g2b.includes('⚠️'), 'G2b a win that still clears the corrected cost carries no warning of either kind');

    // G3 - the re-price moved the other way. The bid-time margin is unaffected either direction,
    // and the trail says the rate came down - which is exactly the case the old design could not
    // report at all.
    const above = Object.assign({ auctionId: 'G3', cost: 90000, minMarginPct: 1.8, lastBidPrice: 130800,
      ourBids: [{ price: 130800, rungIndex: 0, ts: T0, bidTimeCost: 120000, bidTimeMinMarginPct: 1 }] }, base);
    const g3 = render(above);
    ok(g3.includes('🏆 *Won Rate* - ₹1,30,800 (+9.00%)'), 'G3 en-IN grouping, and the bid-time margin regardless of direction');
    ok(g3.includes('ℹ️ *Rate changed* - ₹1,20,000 -> ₹90,000'), 'G3 and the trail says the rate came DOWN');
    ok(!g3.includes('⚠️'), 'G3 a win above the corrected cost carries no warning');

    // G4 - a LOSS. Nothing was committed, but the rate still moved for the same reason, so the
    // trail rides there too: an unexplained figure is no better on a loss than on a win. The
    // below-cost consequence line, however, is win-only - a loss has no position to report.
    const lostRec = { auctionId: 'G4', cost: 38000, minMarginPct: 1.8, lastBidPrice: 31610, won: false,
      finalRank: 4, status: 'closed', closedAt: T0,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0, bidTimeCost: 29000, bidTimeMinMarginPct: 1 }] };
    const g4 = render(lostRec, 'lost');
    ok(/🧮 \*Our Bid\* - ₹31,610 \(\+9\.00%\)\nℹ️ \*Rate changed\* - ₹29,000 -> ₹38,000/.test(g4),
      'G4 the loss note carries the bid-time margin and the trail, in the same order');
    const g4e = outcomeEnrichment(lostRec);
    ok(g4e.belowRateBy === undefined && g4e.costCorrectedTo === undefined,
      'G4 but no rupee-shortfall or correction fields - a loss commits nothing, so there is no position');

    // G5 - a pre-change row cannot know whether its cost was ever corrected, so it never claims one.
    const legacy = outcomeEnrichment(Object.assign({ auctionId: 'G5', cost: 38000, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0 }] }, base));
    ok(legacy.rateChangedFrom === undefined, 'G5 a pre-change row never claims a change it cannot see');
  }

  // ============================================================================================
  // H - the advice on a below-cost win. A snapshot-bearing row and a snapshot-less row reach it by
  //     two different routes and say two different things, because only the snapshot-bearing row
  //     can name what the cost was corrected TO and FROM.
  //     The instruction either route used to produce - "Squeeze the vendor and place at a lower
  //     rate" on a load already won at rank 1 - is impossible (the auction is closed) as well as
  //     self-harming, and it fired on three real below-cost wins.
  // ============================================================================================
  {
    const render = (rec) => {
      const d = Object.assign({ oaNo: rec.auctionId, finalRank: 1, landedBids: 1 }, outcomeEnrichment(rec));
      return renderMessage(templateFor('won', d), d);
    };
    const base = { finalRank: 1, won: true, status: 'closed', closedAt: T0, units: 1 };

    // H1 - the anchor load's own shape as a pre-snapshot row: doc cost 38,000, won at 31,610, no
    // bid-time snapshot to compare against. The margin itself goes negative here (there is no
    // bid-time figure to anchor on, only the doc's), and the sign is the one signal this row can
    // carry - so it takes the plain "stands below your rate" line, not the "cost corrected" one.
    const legacyBelow = Object.assign({ auctionId: 'H1', cost: 38000, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0 }] }, base);
    const h1 = render(legacyBelow);
    ok(!h1.includes('place at a lower rate'),
      'H1 a below-cost win is not told to place at a lower rate');
    ok(!h1.includes('Margin low'), 'H1 and is not called a thin margin either - it is a loss');
    ok(h1.includes('⚠️ _This load stands ₹6,390 below your rate of ₹38,000. The auction is closed, so squeeze the vendor before allotment._'),
      `H1 it states the rupee position and an action that is possible after close (got: ${(h1.match(/⚠️[^\n]*/) || ['<no warning line>'])[0]})`);
    // 38,000 - 31,610 = 6,390, both operands already printed in the body above the line.
    ok(h1.includes('*Your Rate* - ₹38,000') && h1.includes('*Won Rate* - ₹31,610'),
      'H1 and both operands of that subtraction are on the receipt, so the desk can check it');

    // H2 - a healthy win still says nothing at all.
    const healthy = Object.assign({ auctionId: 'H2', cost: 30000, minMarginPct: 5, lastBidPrice: 37500,
      ourBids: [{ price: 37500, rungIndex: 0, ts: T0 }] }, base);
    ok(!render(healthy).includes('⚠️'), 'H2 a healthy win carries no warning of either kind');

    // H3 - thin BUT PROFITABLE: the load still earns, so "squeeze the vendor and place at a lower
    // rate" is still the right advice and must render exactly as before.
    const thin = Object.assign({ auctionId: 'H3', cost: 30000, minMarginPct: 8, lastBidPrice: 31500,
      ourBids: [{ price: 31500, rungIndex: 0, ts: T0 }] }, base);
    const h3 = render(thin);
    ok(h3.includes('⚠️ _Margin low - only 5.00%. Squeeze the vendor and place at a lower rate; we can do better._'),
      `H3 a thin but profitable win keeps the original nag verbatim (got: ${(h3.match(/⚠️[^\n]*/) || ['<no warning line>'])[0]})`);
    ok(!h3.includes('below your rate'), 'H3 and never claims a shortfall on a load that is in profit');

    // H4 - break-even is not below cost. Nothing to squeeze back, and no negative to report.
    const evenRec = Object.assign({ auctionId: 'H4', cost: 31610, minMarginPct: 5, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0 }] }, base);
    const h4 = render(evenRec);
    ok(!h4.includes('below your rate'), 'H4 break-even claims no rupee shortfall');
    ok(h4.includes('Margin low - only 0.00%'), 'H4 but is still under the floor, so the thin-margin nag stands');

    // H5 - a LOSS carries no shortfall field: nothing was committed, so there is no position.
    const lost = { auctionId: 'H5', cost: 38000, lastBidPrice: 31610, won: false, finalRank: 4,
      status: 'closed', closedAt: T0, ourBids: [{ price: 31610, rungIndex: 0, ts: T0 }] };
    ok(outcomeEnrichment(lost).belowRateBy === undefined,
      'H5 a loss carries no rupee-shortfall field');

    // H6 - a snapshot-bearing row below the corrected cost. It has a real bid-time cost (29,000),
    // so its margin is POSITIVE (+9.00%) and it takes the "cost corrected" line instead - the two
    // rows diverge here on purpose: only this one can name what the cost moved from and to.
    const bandBelow = Object.assign({ auctionId: 'H6', cost: 38000, minMarginPct: 1.8, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0, bidTimeCost: 29000, bidTimeMinMarginPct: 1 }] }, base);
    const h6 = render(bandBelow);
    ok(h6.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'), 'H6 a snapshot-bearing row reports a POSITIVE bid-time margin, unlike H1');
    ok(h6.includes('⚠️ *Cost increased to* ₹38,000 - ₹6,390 above the won amount. Please check on portal.'),
      'H6 and its below-cost position names the correction, which H1 cannot');
    ok(!h6.includes('below your rate'), 'H6 and does not also render H1-style wording - one position, stated once');
    ok((h6.match(/⚠️/g) || []).length === 1, 'H6 and states it exactly once');
    ok(!h6.includes('place at a lower rate'), 'H6 and still suppresses the nag');

    // H7 - no cost anywhere: no margin, so no warning of any kind rather than a bare "₹".
    const blind = Object.assign({ auctionId: 'H7', lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, ts: T0 }] }, base);
    ok(!render(blind).includes('⚠️'), 'H7 a record with no cost at all warns about nothing');

    // H8 - below cost by so little that the printed percent rounds to "-0.00". Number('-0.00') is
    // -0 and -0 < 0 is false, so a sign test on the rendered percent let this row past the
    // below-cost escape and into "place at a lower rate" on a closed auction - the same impossible
    // instruction H1 exists to prevent, reached through the rounding instead of the anchor.
    const negZero = Object.assign({ auctionId: 'H8', cost: 500000, minMarginPct: 5, lastBidPrice: 499980,
      ourBids: [{ price: 499980, rungIndex: 0, ts: T0 }] }, base);
    const h8 = render(negZero);
    ok(outcomeEnrichment(negZero).marginPct === '-0.00',
      `H8 the fixture really does render the negative-zero percent (got ${outcomeEnrichment(negZero).marginPct})`);
    ok(!h8.includes('place at a lower rate'),
      `H8 and a below-cost win is still not told to place at a lower rate (got: ${(h8.match(/⚠️[^\n]*/) || ['<no warning line>'])[0]})`);
    ok(h8.includes('⚠️ _This load stands ₹20 below your rate of ₹5,00,000. The auction is closed, so squeeze the vendor before allotment._'),
      'H8 it takes the rupee-position line, which is computed off the unrounded comparison');
  }

  // ============================================================================================
  // I - the two severity tiers of a post-bid cost correction. Owner's ruling, 2026-09-16, verbatim:
  //     "Cost increased to x and is y above won amount, please check on portal - this is high
  //     priority part can't be hidden inside a message. maybe different message format for it
  //     entirely. think about it, maybe a tweak in the top part of the message?"
  //
  //     Tier (a) - corrected, and the won rate still covers it: no change, the ℹ️ trail in the money
  //     block is the whole of it.
  //     Tier (b) - corrected ABOVE the won rate, i.e. the load is a loss on the books: the fact
  //     leaves the money block entirely and becomes line 2 of the receipt, inside the headline
  //     block, ahead of the eleven fields the owner objected to finding it among.
  //
  //     Figures are the owner's own: corrected to 1,31,000, standing 6,575 above the won amount.
  // ============================================================================================
  {
    const render = (rec) => {
      const d = Object.assign({ oaNo: rec.auctionId, finalRank: 1, landedBids: 1 }, outcomeEnrichment(rec));
      return renderMessage(templateFor('won', d), d);
    };
    const base = { finalRank: 1, won: true, status: 'closed', closedAt: T0, units: 1 };

    // I-a - corrected UP, but the won rate still clears the new cost. Quiet: the trail says the
    // rate moved and nothing else does, because there is nothing to act on.
    const covered = Object.assign({ auctionId: 'Ia', cost: 124000, minMarginPct: 1.8, lastBidPrice: 131000,
      ourBids: [{ price: 131000, rungIndex: 0, ts: T0, bidTimeCost: 120000, bidTimeMinMarginPct: 1 }] }, base);
    const ia = render(covered);
    ok(ia.includes('ℹ️ *Rate changed* - ₹1,20,000 -> ₹1,24,000'),
      'Ia the covered tier keeps the quiet trail in the money block');
    ok(!ia.includes('⚠️'), 'Ia and escalates nothing - the won rate still covers the corrected cost');
    ok(ia.split('\n')[1] === '', 'Ia the headline block is untouched: header, then the blank line, as on any win');

    // I-b - corrected ABOVE the won rate. The owner's load: won at 1,24,425, cost corrected to
    // 1,31,000, so the company is committed 6,575 under its own cost.
    const exposed = Object.assign({ auctionId: 'Ib', cost: 131000, minMarginPct: 1.8, lastBidPrice: 124425,
      ourBids: [{ price: 124425, rungIndex: 0, ts: T0, bidTimeCost: 120000, bidTimeMinMarginPct: 1 }] }, base);
    const ib = render(exposed);
    const ALERT = '⚠️ *Cost increased to* ₹1,31,000 - ₹6,575 above the won amount. Please check on portal.';

    const lines = ib.split('\n');
    ok(lines[0].startsWith('🎉 '), 'Ib the win still opens on its own header - the chat-list preview is unchanged');
    ok(lines[1] === ALERT, `Ib and the alert is line 2, inside the headline block (got: ${lines[1]})`);
    // The first field line is the OA No cell now: feat/gc-bid-timestamps' skeleton cut dropped the
    // "We have won the order against" preamble. The alert's position is unchanged and still line 2.
    ok(lines[2] === '' && lines[3].startsWith('🆔 *OA No*'),
      'Ib with the receipt body starting only after it - the alert is above the field list, not in it');
    ok((ib.match(/Cost increased to/g) || []).length === 1, 'Ib stated exactly once');
    ok(!ib.includes('Cost corrected to'),
      'Ib and the money block no longer carries its own copy - one owner for this fact, at the top');

    // CW-212 is untouched: the headline margin is still measured on the bid-time cost, so it reads
    // positive on the very load the correction has put underwater.
    ok(ib.includes('🏆 *Won Rate* - ₹1,24,425 (+3.69%)'),
      `Ib the margin stays on the bid-time cost and stays positive (got: ${(ib.match(/Won Rate[^\n]*/) || ['<none>'])[0]})`);
    ok(ib.includes('ℹ️ *Rate changed* - ₹1,20,000 -> ₹1,31,000'),
      'Ib the trail still explains that margin where the margin is - provenance below, consequence on top');
    ok(!ib.includes('place at a lower rate'), 'Ib and the bid-lower nag stays suppressed');
    ok(!/band|floor|lowest price/i.test(ALERT), 'Ib the alert carries none of the words the desk does not use');
    ok(!/[—–]/.test(ALERT), 'Ib and no dashes WhatsApp renders as em/en dashes');

    // I-c - a LOSS commits nothing, so no tier applies however far the cost moved.
    const lost = { auctionId: 'Ic', cost: 131000, minMarginPct: 1.8, lastBidPrice: 124425, won: false,
      finalRank: 4, status: 'closed', closedAt: T0,
      ourBids: [{ price: 124425, rungIndex: 0, ts: T0, bidTimeCost: 120000, bidTimeMinMarginPct: 1 }] };
    const d = Object.assign({ oaNo: 'Ic', finalRank: 4, landedBids: 1 }, outcomeEnrichment(lost));
    ok(!renderMessage(templateFor('lost', d), d).includes('Cost increased to'),
      'Ic a loss escalates nothing - there is no position to check on the portal');

    // I-d - a pre-snapshot row cannot name what the cost was corrected to, so it cannot escalate.
    // It keeps the rupee-position line it already had, in the body, where wonWarning puts it.
    const legacy = Object.assign({ auctionId: 'Id', cost: 131000, lastBidPrice: 124425,
      ourBids: [{ price: 124425, rungIndex: 0, ts: T0 }] }, base);
    const id = render(legacy);
    ok(!id.includes('Cost increased to'), 'Id a row with no bid-time snapshot claims no correction it cannot evidence');
    ok(id.includes('⚠️ _This load stands ₹6,575 below your rate of ₹1,31,000.'),
      'Id and still reports its position the only way it can, off the margin sign');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
