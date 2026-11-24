'use strict';
/**
 * Director-level cross-customer EOD participation DM (src/notify/directorEod.js), offline.
 * Exercises the SURFACED-denominator funnel (surfaced -> priced -> bid, participation =
 * bid/surfaced, NOT the armed subset), the canonical deriveStatus, the locked WhatsApp
 * skeleton (exact rendered text - counts line + bold participation line, wins with the
 * winning-bid value, best-win-rates min-3-decided gate, the named leak components, desk
 * speed via the reused median), the engine-health exception (only below 90%), the
 * fail-safe empty-recipients OFF, the IST day boundary on surfaced, missing-field
 * tolerance, and the catch-up dedupe on the shared daily rail.
 */

const {
  COLLECTION, STATE_KEY, ENGINE_CONV_ALERT_PCT,
  pctStr, istHour, isTruckBasis, deriveStatus, collectDirectorDay, renderDirectorEod, renderDegraded,
  resolveRecipients, runDirectorEod, startDailyDirectorEod,
} = require('../src/notify/directorEod');
const { MemoryStore } = require('../src/store');
const { istMidnight } = require('../src/notify/dailyTask');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86400000;
const MIN = 60000;
// Fixed reference instant: 20:10 IST on Thu 16 Jul 2026 (14:40 UTC) - the director-EOD slot.
const NOW = Date.UTC(2026, 6, 16, 14, 40);
const DAY_START = istMidnight(NOW);            // 00:00 IST, 16 Jul
const MORNING = DAY_START + 9 * 3600000;       // 09:00 IST
const AFTER_6PM = DAY_START + 18 * 3600000 + 30 * MIN; // 18:30 IST

// The rendered message may carry ONLY these glyphs (one per line), nothing else non-ASCII.
const TRUCK = '\u{1F69A}', BOX = '\u{1F4E6}', CHART = '\u{1F4CA}', TROPHY = '\u{1F3C6}';
const STAR = '\u{2B50}', WARN = '\u{26A0}\u{FE0F}', OK = '\u{2705}', CLOCK = '\u{23F1}\u{FE0F}', GEAR = '\u{2699}\u{FE0F}';
const EMOJI = [TRUCK, BOX, CHART, TROPHY, STAR, WARN, OK, CLOCK, GEAR];
const stripEmoji = (s) => EMOJI.reduce((x, e) => x.split(e).join(''), s);
const asciiButEmoji = (s) => /^[\x20-\x7E\n]*$/.test(stripEmoji(s));

function fakeRequests(docs) { return { listAll: async () => docs }; }
function fakeCustomerStore(customers) { return { list: async () => customers }; }
function fakeNotifier() {
  const sends = [];
  return { sends, sendDirect: async (phone, message, opts) => { sends.push({ phone, message, opts }); return { ok: true }; } };
}

// A price request + (optionally) its closed-bids doc, seeded into a MemoryStore.
// quoteType defaults to 'FTL' because the real adapter ALWAYS records a basis - a truck
// count is the normal case. Pass 'PMT' for a per-tonne load, or null for the
// basis-not-recorded case; both must refuse to scale the won value by `units`.
async function seedLoad(store, reqs, {
  id, company, createdAt, capturedMin = null, status = 'closed',
  docStatus, won = null, bids = 0, lastBidPrice = null, units = null, soft = false,
  quoteType = 'FTL', closedWhileDown = false, finalRank = null,
}) {
  reqs.push({
    loadId: id, createdAt,
    capturedAt: capturedMin == null ? null : createdAt + capturedMin * MIN,
    status,
    load: { companyName: company, closesAt: NOW - 30 * MIN, softClose: soft, quoteType },
  });
  if (docStatus) {
    const ourBids = [];
    for (let i = 0; i < bids; i++) ourBids.push({ price: lastBidPrice || 1000, ts: createdAt + (i + 1) * MIN });
    await store.putDoc('closedBids', id, {
      auctionId: id, status: docStatus, won, ourBids, closedWhileDown, finalRank,
      lastBidPrice, units, closedAt: docStatus === 'closed' ? NOW - 20 * MIN : null,
    });
  }
}

// The busy-day scenario the sample message is rendered from.
async function busyDay() {
  const store = new MemoryStore();
  const reqs = [];
  const H = 'Havells India Ltd.', K = 'KEI Industries Ltd.', A = 'Ashirvad Pipes Ltd.';
  // Havells: 3 won, 1 lost, 3 skipped (one after-6pm, one soft-close, one plain)
  await seedLoad(store, reqs, { id: 'H1', company: H, createdAt: MORNING + 1 * MIN, capturedMin: 2, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 50000, units: 2 });
  await seedLoad(store, reqs, { id: 'H2', company: H, createdAt: MORNING + 2 * MIN, capturedMin: 4, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 40000, units: 1 });
  await seedLoad(store, reqs, { id: 'H3', company: H, createdAt: MORNING + 3 * MIN, capturedMin: 4, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 60000, units: 1 });
  await seedLoad(store, reqs, { id: 'H4', company: H, createdAt: MORNING + 4 * MIN, capturedMin: 6, docStatus: 'closed', won: false, bids: 3, lastBidPrice: 55000, units: 1 });
  await seedLoad(store, reqs, { id: 'H5', company: H, createdAt: AFTER_6PM, status: 'skipped_no_price' });
  await seedLoad(store, reqs, { id: 'H6', company: H, createdAt: MORNING + 5 * MIN, status: 'skipped_no_price', soft: true });
  await seedLoad(store, reqs, { id: 'H7', company: H, createdAt: MORNING + 6 * MIN, status: 'skipped_no_price' });
  // KEI: 1 won, 2 lost, 2 skipped
  await seedLoad(store, reqs, { id: 'K1', company: K, createdAt: MORNING + 7 * MIN, capturedMin: 3, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 100000, units: 1 });
  await seedLoad(store, reqs, { id: 'K2', company: K, createdAt: MORNING + 8 * MIN, capturedMin: 5, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 90000, units: 1 });
  await seedLoad(store, reqs, { id: 'K3', company: K, createdAt: MORNING + 9 * MIN, capturedMin: 7, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 80000, units: 1 });
  await seedLoad(store, reqs, { id: 'K4', company: K, createdAt: MORNING + 10 * MIN, status: 'skipped_no_price' });
  await seedLoad(store, reqs, { id: 'K5', company: K, createdAt: MORNING + 11 * MIN, status: 'skipped_no_price' });
  // Ashirvad: 1 bid but still open (bid + participated, but not decided; 0 decided -> not in best rates)
  await seedLoad(store, reqs, { id: 'A1', company: A, createdAt: MORNING + 12 * MIN, capturedMin: 2, status: 'armed', docStatus: 'open', won: null, bids: 1, lastBidPrice: 30000, units: 1 });

  const customers = [
    { customerId: 'havells', label: 'Havells', aliases: ['Havells'], enabled: true },
    { customerId: 'kei', label: 'KEI', aliases: ['KEI'], enabled: true },
    { customerId: 'ashirvad', label: 'Ashirvad', aliases: ['Ashirvad'], enabled: true },
  ];
  return { store, reqs, customers };
}

(async () => {
  // ---- pure helpers ----
  {
    ok(pctStr(8, 13) === '62%', '8/13 rounds to 62%');
    ok(pctStr(0, 0) === '-', 'nothing to divide by -> dash, never a fake 0%');
    ok(isTruckBasis({ quoteType: 'FTL' }) === true, 'FTL is a truck basis - units are vehicles');
    ok(isTruckBasis({ quoteType: 'pmt' }) === false, 'PMT is NOT a truck basis (case-insensitive)');
    ok(isTruckBasis({ quoteType: null }) === false, 'an unrecorded basis is not assumed to be trucks');
    ok(isTruckBasis({}) === false && isTruckBasis(null) === false, 'missing load / missing field never reads as trucks');
    ok(istHour(AFTER_6PM) === 18, 'IST hour of an 18:30 IST instant is 18 (after-hours)');
    ok(istHour(MORNING) === 9, 'IST hour of a 09:00 IST instant is 9');
    ok(deriveStatus('armed', null) === 'armed', 'open (no closed doc) carries the request status');
    ok(deriveStatus('closed', { numBids: 0, won: false }) === 'no_bid', 'a closed doc with 0 bids is no_bid');
    ok(deriveStatus('armed', { numBids: 2, won: true }) === 'won', 'a closed won doc is won regardless of req status');
    ok(deriveStatus('skipped_no_price', null) === 'skipped_no_price', 'skipped surfaces as the leak status');
  }

  // ---- the surfaced funnel: denominator is SURFACED, not the armed subset ----
  {
    const { store, reqs, customers } = await busyDay();
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers, now: NOW });
    ok(m.surfaced === 13, `surfaced = every load discovered today (got ${m.surfaced})`);
    ok(m.priced === 8, `priced = cost captured (got ${m.priced})`);
    ok(m.bid === 8, `bid = >=1 bid placed, incl. the still-open A1 (got ${m.bid})`);
    ok(Math.round(m.participationPct) === 62, `participation = bid/surfaced = 8/13 = 62% (got ${Math.round(m.participationPct)})`);
    ok(m.won === 4 && m.lost === 3 && m.decided === 7, 'won/lost from CLOSED docs only; A1 open is not decided');
    ok(m.skipped === 5, `the leak = skipped_no_price count (got ${m.skipped})`);
    ok(m.winningBidValue === 300000, `winning value = sum(lastBidPrice x units) over won loads (got ${m.winningBidValue})`);
    ok(Math.round(m.engineConvPct) === 100, 'engine conversion = bid/priced = 8/8 = 100%');
    // best win rates, min 3 decided, best first
    ok(m.bestCustomers.length === 2, 'only customers with >=3 decided qualify (Ashirvad has 0 decided)');
    ok(m.bestCustomers[0].label === 'Havells' && m.bestCustomers[0].won === 3 && m.bestCustomers[0].decided === 4, 'Havells leads: 3 of 4');
    ok(m.bestCustomers[1].label === 'KEI' && m.bestCustomers[1].won === 1 && m.bestCustomers[1].decided === 3, 'KEI second: 1 of 3');
    // leak decomposed by CAUSE: soft-close, after-6pm, then the top skipped shipper (as-is)
    ok(m.skipSoft === 1, 'soft-close skip count (a Havells soft load)');
    ok(m.skipAfter6 === 1, 'after-6pm skip count (a load asked after 18:00 IST)');
    ok(m.skipTop && m.skipTop.name === 'Havells India Ltd.' && m.skipTop.count === 3, 'top skipped shipper named as-is, biggest count');
    ok(m.medianAskToPriceMs === 4 * MIN, `desk speed median over priced loads = 4 min (got ${m.medianAskToPriceMs / MIN})`);
  }

  // ---- the LOCKED skeleton: exact rendered text ----
  // named re-pin: desk-scorecard-and-eod-labels, ruling 46 - "the desk scorecard (CW-240) rides
  // PR-2 as a recorded free concession", whose own rules say "No win count, no win rate, no won
  // value anywhere" and call for deleting the won line, the result-unknown line and the
  // best-win-rates block outright. The skeleton below is proven red with that change reverted
  // (the OLD expected text, restored) and green at this tip in
  // scripts/test-desk-scorecard-per-group-counts-and-not-sent.js's flip proof.
  {
    const { store, reqs, customers } = await busyDay();
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers, now: NOW });
    const msg = renderDirectorEod(m, NOW);
    const expected = [
      `${TRUCK} *Bid Command EOD - Thu 16 Jul*`,
      `${BOX} 13 loads came in, desk priced 8, we bid on 8`,
      `${CHART} *Participation: 62%* of all loads got our bid`,
      '',
      `${CLOCK} Desk speed: 4 min median from ask to price`,
      '',
      '_Target: 100% participation._',
    ].join('\n');
    ok(msg === expected, 'busy-day message renders to the exact locked skeleton (no scorecard wired here -> the per-group blocks are empty)');
    ok(asciiButEmoji(msg), 'rendered message is ASCII outside the deliberate emoji set');
    ok(!/bot/i.test(msg), 'the word "bot" never appears in the rendered copy');
    ok(!/\bwon\b/i.test(msg) && !/\bwin\b/i.test(msg), 'ruling 46: no win count, no win rate, no won value anywhere');
    // one emoji per content line, blank lines carry none
    const contentLines = msg.split('\n').filter((l) => l !== '');
    ok(contentLines.every((l) => EMOJI.some((e) => l.includes(e)) || l.startsWith('_')), 'every content line has its anchor emoji (target line is italic text)');
  }

  // ---- an unseen close is counted and stated, never left out of a denominator it is inside ----
  // deriveStatus gained the third answer, but the row landed in no bucket at all - so m.decided
  // undercounted the day while the render still called it "the N that closed". On an evening when
  // 10 auctions closed and 5 were unknown, the Director read "Won 2 of the 5 that closed" with
  // nothing anywhere accounting for the other five.
  {
    const store = new MemoryStore();
    const reqs = [];
    const C = 'Waaree Energies Ltd.';
    await seedLoad(store, reqs, { id: 'K1', company: C, createdAt: MORNING + 1 * MIN, capturedMin: 2, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 50000, units: 1 });
    await seedLoad(store, reqs, { id: 'K2', company: C, createdAt: MORNING + 2 * MIN, capturedMin: 2, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 50000, units: 1, finalRank: 3 });
    for (const id of ['K3', 'K4', 'K5']) {
      await seedLoad(store, reqs, { id, company: C, createdAt: MORNING + 3 * MIN, capturedMin: 2, docStatus: 'closed', won: null, bids: 2, lastBidPrice: 50000, units: 1, closedWhileDown: true });
    }
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.closedUnknown === 3, `the unseen closes are counted, not dropped (got ${m.closedUnknown})`);
    ok(m.won === 1 && m.lost === 1 && m.decided === 2,
      `and they sit in neither bucket - decided stays the subset we could call (got ${m.won}/${m.lost}/${m.decided})`);
    ok(m.decided + m.closedUnknown === 5, 'so decided + unknown accounts for every close of the day');

    // named re-pin: desk-scorecard-and-eod-labels, ruling 46 - the won/result-unknown render lines
    // this block used to check are deleted outright by the scorecard build (see the locked-skeleton
    // block above). The DATA above (m.won/m.decided/m.closedUnknown) is what the collector still
    // needs to get right for other readers (e.g. test-shared-reader-platform-scope.js's portal-safe
    // join proof) - only the now-removed render assertions are dropped here.
    const msg = renderDirectorEod(m, NOW);
    ok(!/\bwon\b/i.test(msg) && !/\bwin\b/i.test(msg) && !msg.includes('result we could see'),
      'ruling 46: the won line and the result-unknown line are gone from the render entirely');
    ok(asciiButEmoji(msg), 'the message stays ASCII outside the deliberate emoji set');
    ok(!/\bbots?\b/i.test(msg), 'and carries no banned vocabulary');

    // A day whose ONLY closes were unseen: decided is 0. The old "Nothing has closed yet today"
    // falsehood-guard no longer applies (that line is gone with the rest of the won block) - what
    // matters now is that the data still says the day had unseen closes.
    const store2 = new MemoryStore();
    const reqs2 = [];
    for (const id of ['U1', 'U2'] ) {
      await seedLoad(store2, reqs2, { id, company: C, createdAt: MORNING + 1 * MIN, capturedMin: 2, docStatus: 'closed', won: null, bids: 2, lastBidPrice: 50000, units: 1, closedWhileDown: true });
    }
    const m2 = await collectDirectorDay({ requests: fakeRequests(reqs2), store: store2, customers: [], now: NOW });
    ok(m2.decided === 0 && m2.closedUnknown === 2, 'unknown-only day: nothing decided, two unseen');
  }

  // ---- engine-health exception: appears only below 90% on a real sample ----
  {
    const store = new MemoryStore();
    const reqs = [];
    const C = 'Deepak Nitrite Ltd.';
    // 5 priced, 4 bid (one priced-but-no-bid) -> 80% conversion, below the 90% flag
    await seedLoad(store, reqs, { id: 'E1', company: C, createdAt: MORNING + 1 * MIN, capturedMin: 2, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 40000, units: 1 });
    await seedLoad(store, reqs, { id: 'E2', company: C, createdAt: MORNING + 2 * MIN, capturedMin: 2, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 40000, units: 1 });
    await seedLoad(store, reqs, { id: 'E3', company: C, createdAt: MORNING + 3 * MIN, capturedMin: 2, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 40000, units: 1 });
    await seedLoad(store, reqs, { id: 'E4', company: C, createdAt: MORNING + 4 * MIN, capturedMin: 2, docStatus: 'closed', won: false, bids: 1, lastBidPrice: 40000, units: 1 });
    await seedLoad(store, reqs, { id: 'E5', company: C, createdAt: MORNING + 5 * MIN, capturedMin: 2, docStatus: 'closed', won: false, bids: 0 }); // priced, armed, 0 bids -> no_bid
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.priced === 5 && m.bid === 4, 'engine scenario: 5 priced, 4 bid');
    ok(Math.round(m.engineConvPct) === 80, 'engine conversion is 80%');
    const msg = renderDirectorEod(m, NOW);
    // The conversion line, in the wording that replaced "Engine flag: bid only 80% ..." on
    // 2026-07-27 (the Director asked what that meant, and "engine" is banned in anything a human
    // reads). Pinned by VALUE so a future edit cannot quietly walk it back.
    ok(msg.includes(`${WARN} Of the loads the desk priced that closed today, only 80% got a bid in - the rest closed with nothing from us`),
      'sub-90% conversion surfaces the conversion line in plain English');
    // The BASIS must stay visible in the sentence. This number is conversion on the ARMED subset;
    // participation is bids over loads SURFACED, and the two have been conflated before. A bare
    // percentage sitting under "_Target: 100% participation._" is exactly how that happens again.
    ok(/priced that closed today/.test(msg), 'the conversion line names its basis (priced AND closed), so it cannot be read as participation');
    ok(!/\bengine\b/i.test(msg) && !/\bbots?\b/i.test(msg), 'no banned vocabulary anywhere in the rendered director EOD');
    // above threshold: no conversion line
    const m2 = await collectDirectorDay({ requests: fakeRequests((await busyDay()).reqs), store: (await busyDay()).store, customers: (await busyDay()).customers, now: NOW });
    ok(!renderDirectorEod(m2, NOW).includes('got a bid in'), '100% conversion shows no conversion line');
  }

  // ---- zero-activity day: three-line short form, still sent ----
  {
    const m = await collectDirectorDay({ requests: fakeRequests([]), store: new MemoryStore(), customers: [], now: NOW });
    ok(m.surfaced === 0, 'nothing surfaced');
    const msg = renderDirectorEod(m, NOW);
    const expected = [
      `${TRUCK} *Bid Command EOD - Thu 16 Jul*`,
      'No auctions closed today.',
      '_Target: 100% participation._',
    ].join('\n');
    ok(msg === expected, 'zero-activity day is the exact three-line short form');
  }

  // ---- missing-field tolerance: no crash, no fabricated Rs 0, unknown name bucket ----
  {
    const store = new MemoryStore();
    const reqs = [];
    // a won load with NO lastBidPrice (won value must not become a fake Rs 0)
    await seedLoad(store, reqs, { id: 'M1', company: '', createdAt: MORNING + 1 * MIN, capturedMin: 1, docStatus: 'closed', won: true, bids: 1, lastBidPrice: null });
    // a skipped load with a missing company name -> Unknown bucket
    await seedLoad(store, reqs, { id: 'M2', company: undefined, createdAt: MORNING + 2 * MIN, status: 'skipped_no_price' });
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.won === 1 && m.winningBidValue === 0, 'a won load with no bid price adds nothing to winning value (never a fake Rs 0)');
    ok(m.skipTop && m.skipTop.name === 'Unknown' && m.skipTop.count === 1, 'a nameless skipped load buckets under Unknown, never crashes');
    const msg = renderDirectorEod(m, NOW);
    ok(!msg.includes('Rs 0') && !/NaN/.test(msg), 'no fabricated Rs 0 and no NaN in the message');
    ok(!msg.includes('in winning bids'), 'no winning-bid value clause when the value is zero');
  }

  // ---- IST day boundary on surfaced (createdAt), record spans all retained ----
  {
    const store = new MemoryStore();
    const reqs = [];
    await seedLoad(store, reqs, { id: 'T1', company: 'Havells India Ltd.', createdAt: DAY_START + 1, capturedMin: 2, docStatus: 'closed', won: true, bids: 1, lastBidPrice: 50000, units: 1 }); // today (00:00 IST +1ms)
    await seedLoad(store, reqs, { id: 'Y1', company: 'Havells India Ltd.', createdAt: DAY_START - 1, capturedMin: 2, docStatus: 'closed', won: true, bids: 1, lastBidPrice: 50000, units: 1 }); // yesterday
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.surfaced === 1, 'a load created 1ms before IST midnight is NOT surfaced today; the one at +1ms is');
    ok(m.record.surfaced === 2 && m.record.bid === 2, 'record-to-date spans every retained request, both days');
  }

  // ---- won-value NEVER scales a per-tonne rate by a tonnage (the 1000x KG trap) ----
  {
    const store = new MemoryStore();
    const reqs = [];
    // A won PMT load on a KG-configured branch: `units` is 25,000 KG, lastBidPrice is the
    // per-TONNE rate. The naive product is Rs 3Cr; the truthful contribution is the rate.
    await seedLoad(store, reqs, {
      id: 'P1', company: 'Ashirvad Pipes Ltd.', createdAt: MORNING + 1 * MIN, capturedMin: 2,
      docStatus: 'closed', won: true, bids: 2, lastBidPrice: 1200, units: 25000, quoteType: 'PMT',
    });
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.winningBidValue === 1200, `a PMT win contributes its per-tonne rate, not rate x tonnage (got ${m.winningBidValue})`);
    const msg = renderDirectorEod(m, NOW);
    ok(!msg.includes('Cr'), 'no crore-scale figure fabricated from a per-tonne rate x a KG quantity');

    // Basis never recorded -> same conservative treatment, never assumed to be trucks.
    const store2 = new MemoryStore();
    const reqs2 = [];
    await seedLoad(store2, reqs2, {
      id: 'U1', company: 'Tata Steel Ltd.', createdAt: MORNING + 1 * MIN, capturedMin: 2,
      docStatus: 'closed', won: true, bids: 1, lastBidPrice: 5000, units: 40, quoteType: null,
    });
    const m2 = await collectDirectorDay({ requests: fakeRequests(reqs2), store: store2, customers: [], now: NOW });
    ok(m2.winningBidValue === 5000, `an unrecorded basis does not scale by units (got ${m2.winningBidValue})`);

    // A genuine FTL truck count still scales - the guard must not flatten real multi-truck wins.
    const store3 = new MemoryStore();
    const reqs3 = [];
    await seedLoad(store3, reqs3, {
      id: 'F1', company: 'Havells India Ltd.', createdAt: MORNING + 1 * MIN, capturedMin: 2,
      docStatus: 'closed', won: true, bids: 1, lastBidPrice: 50000, units: 3, quoteType: 'FTL',
    });
    const m3 = await collectDirectorDay({ requests: fakeRequests(reqs3), store: store3, customers: [], now: NOW });
    ok(m3.winningBidValue === 150000, `an FTL win still scales by the truck count (got ${m3.winningBidValue})`);
  }

  // ---- the leak names the biggest CUSTOMER, aggregating branch-qualified name variants ----
  {
    const store = new MemoryStore();
    const reqs = [];
    // Havells emits two branch-qualified SP strings, 2 skips each = 4. A single-branch
    // shipper has 3. Keyed on the raw string, Havells would split 2/2 and LOSE to the 3.
    await seedLoad(store, reqs, { id: 'V1', company: 'Havells India Ltd.', createdAt: MORNING + 1 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'V2', company: 'Havells India Ltd.', createdAt: MORNING + 2 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'V3', company: 'Havells India Limited (Alwar)', createdAt: MORNING + 3 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'V4', company: 'Havells India Limited (Alwar)', createdAt: MORNING + 4 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'D1', company: 'Deepak Nitrite Ltd.', createdAt: MORNING + 5 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'D2', company: 'Deepak Nitrite Ltd.', createdAt: MORNING + 6 * MIN, status: 'skipped_no_price' });
    await seedLoad(store, reqs, { id: 'D3', company: 'Deepak Nitrite Ltd.', createdAt: MORNING + 7 * MIN, status: 'skipped_no_price' });
    const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'], enabled: true }];
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers, now: NOW });
    ok(m.skipped === 7, 'all seven skips counted');
    ok(m.skipTop && m.skipTop.count === 4, `branch variants aggregate into one offender (got ${m.skipTop && m.skipTop.count})`);
    ok(m.skipTop && m.skipTop.label === 'Havells', 'the offender is the matched customer, not a raw string');
    ok(m.skipTop && /^Havells/.test(m.skipTop.name), 'the RENDERED name is still a verbatim SP legal name');
  }

  // ---- carry-over loads must not fire the engine flag at a healthy engine ----
  {
    const store = new MemoryStore();
    const reqs = [];
    const C = 'Havells India Ltd.';
    // 6 priced+closed, all bid. Plus 2 priced loads that close TOMORROW (no closed doc, no
    // bid yet). Measured over all priced loads that is 6/8 = 75% and would fire the flag.
    for (let i = 1; i <= 6; i++) {
      await seedLoad(store, reqs, { id: `CC${i}`, company: C, createdAt: MORNING + i * MIN, capturedMin: 2, docStatus: 'closed', won: i === 1, bids: 2, lastBidPrice: 40000, units: 1 });
    }
    await seedLoad(store, reqs, { id: 'CO1', company: C, createdAt: MORNING + 7 * MIN, capturedMin: 2, status: 'armed', docStatus: 'open', bids: 0 });
    await seedLoad(store, reqs, { id: 'CO2', company: C, createdAt: MORNING + 8 * MIN, capturedMin: 2, status: 'armed', docStatus: 'open', bids: 0 });
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.priced === 8 && m.bid === 6, 'eight priced, six bid (two still open)');
    ok(m.pricedClosed === 6 && m.bidClosed === 6, 'engine conversion is measured over CLOSED priced loads only');
    ok(Math.round(m.engineConvPct) === 100, `healthy engine reads 100%, not 75% (got ${Math.round(m.engineConvPct)})`);
    ok(!renderDirectorEod(m, NOW).includes('got a bid in'), 'no false conversion line on a day with carry-over loads');
    ok(m.open === 2, 'the still-open loads are tracked');
  }

  // ---- an unpriced-but-not-yet-overdue load: the data still separates "unpriced" from "skipped" ----
  // named re-pin: desk-scorecard-and-eod-labels, ruling 46 - the old leak/clean-day-check render
  // block this test pinned ("Every surfaced load was priced" / the green check / "still waiting on
  // a price") is exactly the "unpriced breakdown" the audit spec instructs replacing with the
  // per-group scorecard blocks. No scorecard is wired in this test, so nothing here renders any
  // per-group content either - the data-level distinction (priced vs skipped) is what still matters.
  {
    const store = new MemoryStore();
    const reqs = [];
    const C = 'KEI Industries Ltd.';
    await seedLoad(store, reqs, { id: 'W1', company: C, createdAt: MORNING + 1 * MIN, capturedMin: 2, docStatus: 'closed', won: true, bids: 2, lastBidPrice: 40000, units: 1 });
    await seedLoad(store, reqs, { id: 'W2', company: C, createdAt: MORNING + 2 * MIN, capturedMin: 3, docStatus: 'closed', won: false, bids: 2, lastBidPrice: 40000, units: 1 });
    // Surfaced, still awaiting a price, deadline later tonight -> NOT swept as skipped.
    await seedLoad(store, reqs, { id: 'W3', company: C, createdAt: MORNING + 3 * MIN, status: 'awaiting_price', soft: true });
    const m = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers: [], now: NOW });
    ok(m.surfaced === 3 && m.priced === 2 && m.skipped === 0, 'one load is unpriced but not yet skipped');
    const msg = renderDirectorEod(m, NOW);
    ok(!/✅/.test(msg), 'the clean-day check emoji never appears (that render branch is gone with the leak block)');
  }

  // ---- resolveRecipients + the fail-safe OFF default ----
  {
    ok(resolveRecipients({ directorEod: { recipients: [] } }).length === 0, 'empty recipients -> nobody (feature off)');
    ok(resolveRecipients({}).length === 0, 'no directorEod config -> nobody');
    const r = resolveRecipients({ directorEod: { recipients: ['919594937777', ' 919999689877 '] } });
    ok(r.length === 2 && r[1] === '919999689877', 'raw numbers are trimmed and passed through');
    ok(startDailyDirectorEod({ config: { directorEod: { enabled: false } } }) === null, 'disabled (no recipients) starts nothing');
  }

  // ---- runDirectorEod: no recipients = no send, no state; configured = send + kind + sentDate ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const off = await runDirectorEod({
      requests: fakeRequests([]), store, customerStore: fakeCustomerStore([]), notifier: n,
      config: { directorEod: { recipients: [] } }, now: NOW,
    });
    ok(off.sent === 0 && n.sends.length === 0, 'empty recipients: nothing sent (fail-safe)');
    ok((await store.getDoc(COLLECTION, STATE_KEY)) == null, 'no state doc written when the feature is off');

    const { store: s2, reqs, customers } = await busyDay();
    const n2 = fakeNotifier();
    const res = await runDirectorEod({
      requests: fakeRequests(reqs), store: s2, customerStore: fakeCustomerStore(customers), notifier: n2,
      config: { directorEod: { recipients: ['919594937777', '919999689877'] } }, now: NOW,
    });
    ok(res.sent === 2 && n2.sends.length === 2, 'both configured directors get the DM');
    ok(n2.sends[0].opts.kind === 'director_eod', 'send tagged kind=director_eod for log correlation');
    ok(n2.sends[0].message.includes('*Participation: 62%*'), 'the sent message carries the participation headline');
    const state = await s2.getDoc(COLLECTION, STATE_KEY);
    ok(state && state.sentDate === '2026-07-16', 'a successful send records sentDate (the catch-up dedupe)');
  }

  // ---- degraded gather still sends a never-cheerful message ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const res = await runDirectorEod({
      requests: fakeRequests([]), store, customerStore: fakeCustomerStore([]), notifier: n,
      config: { directorEod: { recipients: ['919594937777'] } }, now: NOW,
    }, { collect: async () => { throw new Error('store exploded'); } });
    ok(res.sent === 1, 'a total gather failure STILL sends');
    ok(n.sends[0].message.includes('could not be read') && n.sends[0].message.includes(WARN), 'degraded message is warning-signed and honest');
    ok(!/bot/i.test(n.sends[0].message), 'degraded copy never says "bot"');
    ok(renderDegraded(NOW).includes('please check Bid Command'), 'degraded fallback points at Bid Command, not a bot');
  }

  // ---- startDailyDirectorEod: catch-up dedupe on the shared daily rail ----
  {
    const realNow = Date.now;
    Date.now = () => NOW + 5 * MIN; // 20:15 IST - inside the catch-up window after the 20:10 slot
    try {
      const store = new MemoryStore();
      const n = fakeNotifier();
      const deps = {
        store, requests: fakeRequests([]), customerStore: fakeCustomerStore([]), notifier: n,
        config: { directorEod: { enabled: true, timeIST: '20:10', recipients: ['919594937777'] } },
      };
      const handle = startDailyDirectorEod(deps);
      ok(handle && typeof handle.stop === 'function', 'enabled start returns a stoppable handle');
      await new Promise((r) => setTimeout(r, 50));
      ok(n.sends.length === 1, `boot inside the catch-up window with no sentDate sends the missed DM (got ${n.sends.length})`);
      handle.stop();
      const n2 = fakeNotifier();
      const handle2 = startDailyDirectorEod(Object.assign({}, deps, { notifier: n2 }));
      await new Promise((r) => setTimeout(r, 50));
      ok(n2.sends.length === 0, 'catch-up dedupes on sentDate - a post-send restart is silent');
      handle2.stop();
    } finally {
      Date.now = realNow;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
