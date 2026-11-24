'use strict';
/**
 * THE LOSS RECEIPT THE GROUP ACTUALLY READS (Director, 2026-08-19).
 *
 * He pasted back a live loss on a Waaree GoComet load. Its first line interpolated both RAW postal
 * addresses - roughly 400 characters of "Survey No. 1934, NH-48, Near Darshan Hotel, Village #
 * Degam ..." - and the rest of the message was two lines: our rank and our bid. Verbatim: "you
 * don't need to add the whole address ... just add chikli, destination location, vehicle type, OA
 * number, our ranking", and "of course, the market rate and what was the margin added".
 *
 * That message is the lost_short variant (the short reply threaded under the group ask), not the
 * full lost receipt a DM subscriber gets - so the fix has to land on lost_short specifically, and
 * the header it shares with the no_bid variants.
 *
 * What this pins:
 *   A. lost_short renders his six facts and NOT the raw postal address
 *   B. the header's route is the short city+pin pair on BOTH portals, and the raw lane strings stay
 *      the fallback for a payload built before laneFrom/laneTo were threaded
 *   C. notifyEngineEvent is what threads those cells, and it needs the PORTAL to do it - an
 *      un-tagged GoComet event cannot parse its own address and must degrade, not render a city
 *      that is wrong
 *   D. the OA number (GoComet's enquiry.name) survives the engine carry path - capture -> intent ->
 *      auction_result -> payload - including a restart, and stays absent on SuperProcure
 *   E. lost_short claims no bid-attempt count. engineAlerts sets `attempts` off the LANDED-bids
 *      record, not the real attempt counter, so an attempted-and-refused bid reports 0 attempts;
 *      the short reply must not repeat that number until the source is fixed.
 *   F. the receipt's lane is the ask's lane, on SuperProcure - the #114 divergence, whose only
 *      source for that load's pin is the shipper note
 *   G. a half-known lane degrades to the end it knows, never a dangling separator
 *   H. the same on GoComet, where the pin comes from the portal's zip field and re-parsing the
 *      address text yields a DIFFERENT one
 *
 *   node scripts/test-lost-receipt-fields.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor, laneEnds } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A per-run directory, not a pid-named file in the shared tmpdir: Windows reuses pids, and an
// intent file left by an aborted run would be rehydrated into this one's engine.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-fields-'));
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
const tmp = (tag) => path.join(TMP_DIR, `${tag}.json`);

// The live lane off the load the Director pasted. Kept verbatim because the whole defect is what
// this string does to a message - a paraphrase would not reproduce it.
const GC_ORIGIN = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
const GC_DEST = 'Urdwa Solar Systems - D No 3-184/7 Plot No 239 APIIC C/o M/s Rama General Engineering works Plot No. Ground Floor Kakinada Main Road, APSP Camp Sub Post Ramanyyapeta, Kakinada,Andhra Pradesh, 533005     Kakinada IN     India           Region     37     Andhra Pradesh INDIA';
const OA = '3262511465-5601270693 (E.com)';   // a real captured SHAPE - compound, with a suffix
const BAND = [14.4, 10.8, 8.1];
const CFG = { armLeadMs: 300 };

// Real load 23674031, the shape lanePins.js:7-10 records as issue #114. The pickup address ends in
// a SEVEN-digit run, which the six-digit reader refuses rather than guess a trim of (2209304 could
// be 220930 or 209304), so the shipper's note is the only place the origin pin exists at all.
// Built at the point of use: closesAt is a real clock, and capture() refuses a load past it. Fixed
// at module load, the 8s runway was spent by the sections above before F and H ever captured.
const notePinLoad = () => ({
  id: '23674031',
  lane: { origin: 'KANPUR', destination: 'GORAKHPUR' },
  points: [
    { kind: 'pickup', address: 'Havells India Ltd., Kanpur, Uttar Pradesh, India, 2209304' },
    { kind: 'drop', address: 'Gorakhpur, Uttar Pradesh, India' },
  ],
  notes: 'Origin Address - 770, JUGRAJPUR ROAD, SACHENDI, NATIONAL HIGHWAY -2, KANPUR - 209304,'
    + 'KANPUR + Destination Address- 127-2/348,CHATUR BHUJ NIWAS,NEAR MANAS TALKIESALI NAGAR NORTH',
  equipment: '19 FT 7 MT', units: 1, weight: 7, weightUnit: 'MT',
  companyName: 'Havells India Ltd.', branchName: 'Kanpur',
  closesAt: Date.now() + 8_000, startsAt: Date.now() - 1000, status: 'live', softClose: false,
});

/** The lost_short payload as notifyEngineEvent builds it for a GoComet loss. */
const gcLossData = () => ({
  platformKey: 'gocomet',
  shipper: 'Waaree Energies Ltd.',
  origin: GC_ORIGIN, dest: GC_DEST, from: GC_ORIGIN, to: GC_DEST,
  laneFrom: 'Degam 396530', laneTo: 'Kakinada 533005',
  shipperRef: '3260109306', oaNo: '260818Z7SW',
  vehicleType: '1 x 20 ft ODC', finalRank: 5,
  marketRate: '1,50,000', marginRate: '1,62,150', marginPct: '8.10',
  attempts: 0, closeTime: '18-08-2026 11:59 PM', landedBids: 3,
});

const shortLoss = (d) => renderMessage(templateFor('lost', d, { short: true }), d);

/** rank-only adapter that can be flipped closed at a chosen rank. */
function flippableAdapter() {
  const a = {
    st: { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 8_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ...a.st }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 40 }),
    close: (rank) => { a.st = { ...a.st, status: 'closed', myRank: rank, closesInMs: 0 }; },
  };
  return a;
}

function rig(adapter, intentsFile) {
  const store = createStore({ backend: 'memory' });
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), { config: CFG, onEvent: (e) => { events.push(e); } });
  return { store, events, engine };
}

async function armed(engine, store, load, platformKey) {
  const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 5, platformKey });
  const created = await rq.createForLoad(load, { deadlineAt: Date.now() + 60_000, platformKey });
  return armFromRequest(engine, await rq.capture(created.id, { cost: 150_000 }));
}

// GoComet's half of the same divergence. parseGoCometPlace takes the portal's zip FIELD over any
// six-digit run in the address text, and gocometLane.js:152-160 records that the two "DO NOT ALWAYS
// AGREE". Discovery parses WITH the field and persists the result as laneParsed; anything
// re-parsing the bare lane strings later has no field to consult and lands on the address digits.
// So the two pins here are deliberately different: 396530/533005 is what the portal published,
// 396521/533003 is what the address text says.
const gcZipLoad = () => ({
  id: 'GC-ZIP-1',
  lane: {
    origin: 'Waaree Energies, Plot 12, GIDC Estate, Chikhli-396521, Gujarat',
    destination: 'Urdwa Solar Systems, Kakinada-533003, Andhra Pradesh',
  },
  laneParsed: {
    origin: { city: 'Chikhli', state: 'Gujarat', pincode: '396530', label: 'Chikhli, Gujarat' },
    destination: { city: 'Kakinada', state: 'Andhra Pradesh', pincode: '533005', label: 'Kakinada, Andhra Pradesh' },
  },
  equipment: '20 ft ODC', units: 1, companyName: 'Waaree Energies Ltd.',
  closesAt: Date.now() + 8_000, startsAt: Date.now() - 1000, status: 'live', softClose: false,
});

(async () => {
  // ---- A. the six facts he asked for, and the address he asked to lose ----------------------
  {
    const msg = shortLoss(gcLossData());
    assert.ok(!msg.includes('Survey No. 1934') && !msg.includes('APSP Camp'),
      'neither raw postal address survives anywhere in the reply');
    assert.ok(msg.length < 260, `the whole reply stays glanceable, got ${msg.length} chars`);
    ok('the raw pickup and drop addresses are gone from the loss reply');

    assert.ok(/^🔴 \*LOST - Waaree Energies Ltd\.\*\nDegam 396530 → Kakinada 533005\n/.test(msg),
      'first line is the customer alone; the short origin -> destination pair sits on its own second line (a bracketed lane wraps badly on a phone - Director, 2026-08-19)');
    assert.ok(/\n🔖 \*OA\* - 3260109306\n/.test(msg), 'the OA number, on its own line');
    assert.ok(/\n🚛 1 x 20 ft ODC\n/.test(msg), 'the vehicle type');
    assert.ok(/\n🏅 \*Our Final Ranking\* - 5\n/.test(msg), 'our ranking');
    assert.ok(/\n💰 \*Your Rate\* - ₹1,50,000\n/.test(msg), 'the market rate the desk entered');
    assert.ok(/\n🧮 \*Our Bid\* - ₹1,62,150 \(\+8\.10%\)/.test(msg), 'our bid and the margin added');
    assert.ok(!msg.includes('your rate 1,50,000'),
      'and the margin does not restate the rate the Your Rate line above already names (F-C)');
    ok('all six requested facts render: origin, destination, vehicle, OA, rank, rate + margin');

    // the loud outcome must still be the FIRST line - WhatsApp's chat-list preview shows only that
    assert.ok(msg.startsWith('🔴 *LOST'), 'the loss verdict leads, so the chat-list preview still reads it');
    ok('the outcome still leads the message, so the chat-list preview is unchanged in kind');
  }

  // ---- A2. the OA number renders VERBATIM - the shape varies and nothing may parse it --------
  {
    const msg = shortLoss({ ...gcLossData(), shipperRef: OA });
    assert.ok(msg.includes(`*OA* - ${OA}`), 'a compound OA reference is rendered whole, never split to digits');
    ok('the OA number is rendered verbatim, whatever shape the portal published');
  }

  // ---- B. the header's route, on both portals and on a pre-threading payload ------------------
  {
    // SuperProcure publishes a city, so laneFrom/laneTo and origin/dest agree and nothing moves.
    const sp = { shipper: 'Havells', origin: 'Alwar', dest: 'Guwahati', laneFrom: 'Alwar 301001',
      laneTo: 'Guwahati 781001', vehicleType: '1 x 32FT', finalRank: 3, marginRate: '58,000', landedBids: 1 };
    assert.ok(shortLoss(sp).startsWith('🔴 *LOST - Havells*\nAlwar 301001 → Guwahati 781001\n'),
      'a SuperProcure loss reads the same short pair, on its own line');
    assert.ok(!/\*OA\*/.test(shortLoss(sp)), 'and renders no OA line - SuperProcure publishes no such reference');
    assert.ok(!/Your Rate/.test(shortLoss(sp)), 'no entered cost -> no dangling rate line');
    ok('a SuperProcure loss renders the short pair, no OA line and no dangling money line');

    // A payload built before the cells were threaded (a persisted pre-fix event) must still read.
    const legacy = { ...gcLossData(), laneFrom: undefined, laneTo: undefined };
    const msg = shortLoss(legacy);
    assert.ok(msg.includes('Survey No. 1934'), 'the raw lane strings are the fallback, so nothing renders blank');
    ok('a payload with no short cells degrades to the raw lane rather than losing the route');

    // No lane at all (rate-model / point-less load) - customer alone, never empty parens.
    const bare = { shipper: 'Waaree Energies Ltd.', finalRank: 4, marginRate: '61,000', landedBids: 1 };
    assert.ok(shortLoss(bare).startsWith('🔴 *LOST - Waaree Energies Ltd.*'), 'no route -> customer alone');
    assert.ok(!/\(\)/.test(shortLoss(bare)), 'never empty parens');
    ok('a lane-less loss names the customer alone, with no dangling separator');

    // the no-bid twin shares the header, so it is fixed by the same change
    const nb = { ...gcLossData(), landedBids: 0 };
    const nbMsg = renderMessage(templateFor('lost', nb, { short: true }), nb);
    assert.strictEqual(templateFor('lost', nb, { short: true }), 'no_bid_short', 'zero landed bids still selects no_bid_short');
    assert.ok(!nbMsg.includes('Survey No. 1934'), 'and its header carries the short pair too');
    ok('the no-bid reply shares the shortened header');
  }

  // ---- C. notifyEngineEvent threads the cells, and needs the portal to do it ------------------
  {
    const sent = [];
    const notifier = { alert: async (kind, data) => { sent.push({ kind, data }); } };
    const evt = { type: 'auction_result', auctionId: 'GC-1', won: false, finalRank: 5, landedBids: 2,
      lane: { origin: GC_ORIGIN, destination: GC_DEST }, equipment: '20 ft ODC', companyName: 'Waaree Energies Ltd.',
      shipperRef: '3260109306', points: null };

    await notifyEngineEvent(notifier, evt, null, null, 'gocomet');
    assert.strictEqual(sent[0].data.laneFrom, 'Degam 396530', 'the portal-tagged event parses its own address');
    assert.strictEqual(sent[0].data.laneTo, 'Kakinada 533005', 'both ends');
    ok('notifyEngineEvent threads the short lane cells when the portal is known');

    // An un-tagged event reads as SuperProcure everywhere else in the product, so the GoComet parse
    // never runs and laneDisplay has only a postal address to work with. It BOUNDS that address
    // rather than guessing a city out of it - the truncation reads as one, and the full address is
    // still on the /price page. Production never reaches this branch (server.js passes the stack's
    // own portal on every engine event); it exists so a hand-rolled or persisted pre-fix event is
    // short and honest instead of a paragraph.
    await notifyEngineEvent(notifier, evt, null, null, null);
    assert.strictEqual(sent[1].data.laneFrom, 'Survey No. 1934, NH-48, Near...',
      'an un-tagged event bounds the address instead of inventing a city from it');
    const msg = shortLoss(sent[1].data);
    assert.ok(!msg.includes('Darshan Hotel') && !msg.includes('APSP Camp'), 'and the paragraph still never renders');
    ok('an un-tagged event bounds its address rather than rendering a guessed city or a paragraph');
  }

  // ---- D. the OA number survives the engine carry path, live and across a restart -------------
  const mkLoad = (id, shipperRef) => ({
    id, lane: { origin: GC_ORIGIN, destination: GC_DEST }, equipment: '20 ft ODC', units: 1,
    companyName: 'Waaree Energies Ltd.', shipperRef,
    closesAt: Date.now() + 8_000, startsAt: Date.now() - 1000, status: 'live', softClose: false,
  });
  {
    const f = tmp('live');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    await armed(engine, store, mkLoad('GCL1', '3260109306'), 'gocomet');

    assert.strictEqual(engine.scheduler.get('GCL1').shipperRef, '3260109306', 'the armed intent persists the OA number');
    await sleep(600);
    adapter.close(4);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.strictEqual(result && result.shipperRef, '3260109306', 'the auction_result event carries it');
    assert.strictEqual(toNotification(result).data.shipperRef, '3260109306', 'and so does the lost payload');
    ok('capture -> intent -> auction_result -> lost payload keeps the OA number');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }
  {
    // `sh scripts/deploy.sh` restarts pm2 mid-auction as a matter of routine, so a load fact that
    // does not ride the durable intent is one deploy away from vanishing from the receipt.
    const f = tmp('restart');
    const adapter = flippableAdapter();
    {
      const { store, engine } = rig(adapter, f);
      await armed(engine, store, mkLoad('GCL2', '3260109307'), 'gocomet');
      engine.kill('simulated crash');
    }
    const { events, engine: engine2 } = rig(adapter, f);
    await engine2.rehydrate();
    assert.ok(events.some((e) => e.type === 'armed'), 'rehydrate re-armed the load');
    adapter.close(6);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.strictEqual(result && result.shipperRef, '3260109307', 'the rehydrated load still names the OA number');
    ok('a mid-auction restart no longer strips the OA number off the loss receipt');
    engine2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }
  {
    const f = tmp('none');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    await armed(engine, store, mkLoad('SPL1', null));   // SuperProcure publishes no reference
    await sleep(600);
    adapter.close(3);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.strictEqual(result && result.shipperRef, null, 'an explicit null, never undefined-by-accident');
    assert.ok(!/\*OA\*/.test(shortLoss(toNotification(result).data)), 'and the reply renders no OA line');
    ok('a reference-less load stays null end to end and renders no stranded OA label');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- E. no attempt count, because the one available is wrong -------------------------------
  {
    // engineAlerts.outcomeEnrichment sets `attempts` from rec.ourBids - bids that LANDED - not from
    // monitor.ownBidAttempts. A load whose every attempt was refused therefore reports 0 attempts
    // while having tried repeatedly. The full lost receipt already carries that number; the short
    // reply must not start repeating it until the source is corrected.
    const msg = shortLoss({ ...gcLossData(), attempts: 0 });
    assert.ok(!/attempt/i.test(msg), 'the short reply states no attempt count');
    ok('lost_short does not inherit the landed-vs-attempted bid-count defect');
  }

  // ---- F. ask and receipt resolve the lane from the same inputs (issue #114, re-opened) -------
  {
    // #114 shipped two pin readers and they disagreed on this load. #130 reduced them to one
    // function - but a shared function still diverges when the two callers feed it different
    // inputs, which is what the receipt did by resolving from the bare engine event. Driven end to
    // end on BOTH sides rather than compared as derived values, because #114's own test asserted
    // the surfaces agreed "by construction" and they did not.
    const f = tmp('notepin');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 5, platformKey: 'sp' });
    const created = await rq.createForLoad(notePinLoad(), { deadlineAt: Date.now() + 60_000, platformKey: 'sp' });
    const captured = await rq.capture(created.id, { cost: 150_000 });

    // the ASK side, through the exact call notifier._priceNeededData makes
    const ask = laneEnds(captured.load, 'sp');
    assert.strictEqual(ask.from, 'Kanpur 209304', 'the ask recovers the origin pin from the note');

    // the RECEIPT side, through the real engine carry path
    armFromRequest(engine, captured);
    await sleep(600);
    adapter.close(4);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.ok(result, 'the load closed and emitted its outcome');
    const sent = [];
    await notifyEngineEvent({ alert: async (kind, data) => { sent.push({ kind, data }); } }, result, null, null, 'sp');

    assert.strictEqual(sent[0].data.laneFrom, ask.from, 'receipt and ask name the SAME origin, pin included');
    assert.strictEqual(sent[0].data.laneTo, ask.to, 'and the same destination, neither inventing a pin');
    assert.ok(/\n?Kanpur 209304 → Gorakhpur\n/.test(shortLoss(sent[0].data)),
      'and the rendered receipt carries the note-recovered pin, not a bare "Kanpur"');
    ok('the loss receipt resolves its lane from the same inputs as the ask - the note-recovered pin reaches both');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- G. a half-known lane degrades honestly instead of printing a dangling arrow ------------
  {
    // laneEnds yields a TRUTHY '?' for an end it cannot name, so the header's `from && to` branch
    // fired and rendered "Kanpur → ?" - contradicting outcomeParts' own "never a dangling
    // separator" contract, in the very formatting the Director asked to be cleaned up.
    const half = { ...gcLossData(), laneFrom: 'Kanpur 209304', laneTo: '?', origin: '', dest: '' };
    const msg = shortLoss(half);
    assert.ok(!msg.includes('→'), 'no dangling arrow when only one end is known');
    assert.ok(!msg.includes('?'), 'and the placeholder itself never reaches the group');
    assert.ok(msg.startsWith('🔴 *LOST - Waaree Energies Ltd.*\nKanpur 209304\n'), 'the known end stands alone');

    // the mirror case, so the fix is not one-sided
    const halfTo = { ...gcLossData(), laneFrom: '?', laneTo: 'Kakinada 533005', origin: '', dest: '' };
    assert.ok(shortLoss(halfTo).startsWith('🔴 *LOST - Waaree Energies Ltd.*\nKakinada 533005\n'),
      'and an unknown ORIGIN degrades the same way');

    // An unplaced end that still recovered a pin. laneEnds composes the city and the pin
    // separately, so an end it cannot place reads '? 209304' - a bare pin beside a question mark,
    // which looks MORE like a real location than '?' does while being just as unroutable. SP
    // reaches this whenever the loadingPoints blob fails to parse (parseLane falls back to '?')
    // while the shipper note still carries its pins.
    const pinned = { ...gcLossData(), laneFrom: '? 209304', laneTo: 'Gorakhpur', origin: '', dest: '' };
    const pinnedMsg = shortLoss(pinned);
    assert.ok(!pinnedMsg.includes('?') && !pinnedMsg.includes('209304'),
      'a pin welded to the placeholder is dropped too, not printed as a place');
    assert.strictEqual(pinnedMsg.split('\n')[1], 'Gorakhpur', 'leaving the end it can actually name');
    const bothPinned = { ...gcLossData(), laneFrom: '? 209304', laneTo: '? 302013', origin: '', dest: '' };
    assert.ok(!/^(\? |\d{6})/.test(shortLoss(bothPinned).split('\n')[1] || ''), 'neither end named -> no route line');
    ok('a half-known lane renders the end it knows, with no dangling separator and no "?"');
  }

  // ---- H. the GoComet half: the receipt never states a pin the ask did not ---------------------
  {
    // The SP fix alone did not cover this. GoComet's pin comes from laneParsed, which is
    // display-derived and deliberately kept off the durable intent, so the receipt had no way to
    // reproduce the ask's zip-hinted parse and re-derived a DIFFERENT pin from the address text.
    // Wrong-district territory - the exact thing lanePins refuses to risk.
    const f = tmp('gczip');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 5, platformKey: 'gocomet' });
    const created = await rq.createForLoad(gcZipLoad(), { deadlineAt: Date.now() + 60_000, platformKey: 'gocomet' });
    const captured = await rq.capture(created.id, { cost: 150_000 });

    const ask = laneEnds(captured.load, 'gocomet');
    assert.deepStrictEqual(ask, { from: 'Chikhli 396530', to: 'Kakinada 533005' },
      'the ask names the portal zip field, not the address digits');

    armFromRequest(engine, captured);
    await sleep(600);
    adapter.close(4);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    const sent = [];
    await notifyEngineEvent({ alert: async (kind, data) => { sent.push({ kind, data }); } }, result, null, null, 'gocomet');

    assert.strictEqual(sent[0].data.laneFrom, ask.from, 'receipt and ask name the SAME origin pin');
    assert.strictEqual(sent[0].data.laneTo, ask.to, 'and the same destination pin');
    const msg = shortLoss(sent[0].data);
    assert.ok(!msg.includes('396521') && !msg.includes('533003'),
      'the receipt never shows the address-text pin the ask did not show');
    assert.ok(!msg.includes('GIDC Estate'), 'and the raw address is still gone');
    ok('a GoComet loss receipt names the portal-published pin, identical to the ask');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // Completion sentinel: run-tests.js grades on exit status alone, so a section dropped in a later
  // edit would exit 0 and read green while asserting less than this file claims.
  assert.strictEqual(pass, 17, `expected all 17 checks to run, got ${pass}`);
  console.log(`\n${pass}/17 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
