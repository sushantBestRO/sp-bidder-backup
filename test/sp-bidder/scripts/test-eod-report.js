'use strict';
/**
 * Per-customer end-of-day report (src/notify/eodReport.js), offline. Exercises the
 * 8pm-to-8pm window math, dynamic group resolution from the model (group people +
 * assignments + customers - no hardcoded lists), per-customer attribution through
 * the notifier's own scopeMatches predicate (attribution == routing, always), the
 * client's six-line spine (participation/winning rates on the honest denominators,
 * '-' never a fake 0%), the WEIGHTED margin math (weighted by load value, final
 * bid only - pinned with the big-low + tiny-high case), the quiet-day one-liner,
 * the never-cheerful degraded variant, per-group isolation in a run, and the
 * catch-up dedupe on the shared daily rail.
 */

const {
  COLLECTION, STATE_KEY, MSG_EMOJI,
  windowEndAt, fmtSlot, median, fmtRsCompact, resolveGroups, unclaimedLoads, collectCustomerDay,
  scopeLabel, renderEodReport, renderDegraded, runEodReport, startDailyEodReport, isTruckBasis,
} = require('../src/notify/eodReport');
const { MemoryStore } = require('../src/store');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86400000;
// Fixed reference instant: 20:00 IST on Thu 16 Jul 2026 (14:30 UTC) - the send slot.
const NOW = Date.UTC(2026, 6, 16, 14, 30);
const SLOT = { h: 20, m: 0 };
const WIN_END = NOW;             // window end = the 20:00 slot itself
const WIN_START = NOW - DAY;     // 20:00 IST yesterday

// A rendered message may carry ONLY the deliberate emoji-leader set (MSG_EMOJI, the
// module's own source of truth) - every other character stays ASCII, so no stray
// non-ASCII ever slips into a WhatsApp body.
const EMOJI = MSG_EMOJI;
const stripEmoji = (s) => EMOJI.reduce((x, e) => x.split(e).join(''), s);
const asciiButEmoji = (s) => /^[\x20-\x7E\n]*$/.test(stripEmoji(s));
const emojiCount = (s) => EMOJI.reduce((n, e) => n + s.split(e).length - 1, 0);

function fakeRequests(docs) { return { listAll: async () => docs }; }
function fakeNotifier() {
  const sends = [];
  return {
    sends,
    sendDirect: async (phone, message, opts) => { sends.push({ phone, message, opts }); return { ok: true }; },
  };
}
// Model stores shaped like PersonStore/CustomerStore/AssignmentStore .list().
const modelStores = ({ people = [], customers = [], assignments = [] }) => ({
  personStore: { list: async () => people },
  customerStore: { list: async () => customers },
  assignmentStore: { list: async () => assignments },
});

(async () => {
  // ---- window math: most recent slot at-or-before now ----
  {
    ok(windowEndAt(NOW, SLOT) === NOW, 'at the slot exactly -> the slot is the window end');
    ok(windowEndAt(NOW + 40 * 60000, SLOT) === NOW, '20:40 (catch-up territory) -> still today 20:00');
    ok(windowEndAt(NOW - 60000, SLOT) === NOW - DAY, '19:59 -> yesterday 20:00');
    ok(fmtSlot({ h: 20, m: 0 }) === '8 pm', 'slot renders as the client says it (8 pm)');
    ok(fmtSlot({ h: 7, m: 30 }) === '7:30 am', 'non-whole-hour slot keeps its minutes');
  }

  // ---- Indian-compact rupees + median (the two new metric helpers, pinned) ----
  {
    ok(fmtRsCompact(140000) === 'Rs 1.4L', '140000 -> Rs 1.4L (the coordinator-pinned case)');
    ok(fmtRsCompact(200000) === 'Rs 2L', 'a whole-lakh value drops the trailing .0');
    ok(fmtRsCompact(100000) === 'Rs 1L', 'the 1L threshold itself compacts');
    ok(fmtRsCompact(99999) === 'Rs 99,999', 'below a lakh stays plain Indian-grouped rupees');
    ok(fmtRsCompact(45000) === 'Rs 45,000', 'plain rupees use the shared fmtNum grouping');
    ok(fmtRsCompact(25000000) === 'Rs 2.5Cr', 'crore values compact to Cr');
    ok(fmtRsCompact(null) === 'Rs -', 'no value degrades, never NaN');

    ok(median([4, 8]) === 6, 'even count -> mean of the two middles (pinned)');
    ok(median([2, 4, 8, 100]) === 6, 'even count is outlier-resistant (100 does not drag it)');
    ok(median([1, 5, 9]) === 5, 'odd count -> the middle');
    ok(median([]) === null, 'empty -> null, never NaN');
  }

  // ---- group resolution: dynamic, model-driven, fail-closed on unscoped groups ----
  {
    const people = [
      { personId: 'g1', name: 'Syngenta BRL group', phone: '123450001@g.us', enabled: true },
      { personId: 'g2', name: 'Renewsys BRL group', phone: '123450002@g.us', enabled: true },
      { personId: 'g3', name: 'Orphan group', phone: '123450003@g.us', enabled: true },      // no assignment
      { personId: 'g4', name: 'Disabled group', phone: '123450004@g.us', enabled: false },   // disabled person
      { personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true },      // individual - never a report target
    ];
    const customers = [
      { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta', 'Syngenta India'], enabled: true },
      { customerId: 'renewsys', label: 'Renewsys', aliases: ['Renewsys'], enabled: true },
      { customerId: 'ghost', label: 'Ghost', aliases: ['Ghost Freight'], enabled: false },   // disabled customer
    ];
    const assignments = [
      { assignmentId: 'g1::syngenta', personId: 'g1', customerId: 'syngenta', enabled: true },
      { assignmentId: 'g2::renewsys', personId: 'g2', customerId: 'renewsys', enabled: true },
      { assignmentId: 'g2::ghost', personId: 'g2', customerId: 'ghost', enabled: true },     // resolves to nothing (customer disabled)
      { assignmentId: 'p1::syngenta', personId: 'p1', customerId: 'syngenta', enabled: true },
    ];
    const groups = await resolveGroups(modelStores({ people, customers, assignments }));
    ok(groups.length === 2, `only assigned, enabled group JIDs qualify (got ${groups.length})`);
    const syn = groups.find((g) => g.personId === 'g1');
    ok(syn && syn.jid === '123450001@g.us' && syn.label === 'Syngenta', 'group carries its JID + customer label');
    ok(syn && syn.aliases.length === 2, 'aliases are the assigned customer\'s alias list');
    ok(!groups.find((g) => g.personId === 'g3'), 'a group without a customer assignment is skipped (no firehose)');
    ok(!groups.find((g) => g.personId === 'p1'), 'an individual person is never an EOD target');
  }

  // ---- per-customer day: attribution via scopeMatches, window cohort, outcomes ----
  {
    const reqs = [
      // Syngenta cohort (created in window): won, lost, still-live, missed-cutoff, never-bid
      { loadId: 'L1', createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta India Ltd', closesAt: NOW - 3600000 } },
      { loadId: 'L2', createdAt: WIN_START + 3, capturedAt: WIN_START + 4, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 3000000 } },
      { loadId: 'L3', createdAt: WIN_START + 5, capturedAt: WIN_START + 6, status: 'armed', load: { companyName: 'SYNGENTA INDIA', closesAt: NOW + 7200000 } },
      { loadId: 'L4', createdAt: WIN_START + 7, capturedAt: null, status: 'skipped_no_price', load: { companyName: 'Syngenta', closesAt: NOW - 100 } },
      { loadId: 'L5', createdAt: WIN_START + 9, capturedAt: null, status: 'awaiting_price', load: { companyName: 'Syngenta', closesAt: NOW + 3600000 } },
      // boundary + other-customer guards
      { loadId: 'L6', createdAt: WIN_START - 1, capturedAt: WIN_START, status: 'closed', load: { companyName: 'Syngenta', closesAt: WIN_START + 50 } },  // previous window
      { loadId: 'L7', createdAt: WIN_START + 11, capturedAt: null, status: 'awaiting_price', load: { companyName: 'Renewsys India', closesAt: NOW + 60000 } }, // not Syngenta's
    ];
    const store = new MemoryStore();
    // L1 won (cost 100000, final bid 105000 -> 5% margin on a BIG load)
    await store.putDoc('closedBids', 'L1', { auctionId: 'L1', status: 'closed', won: true, cost: 100000, lastBidPrice: 105000, ourBids: [{ price: 110000, ts: WIN_START + 10 }, { price: 105000, ts: WIN_START + 20 }] });
    // L2 lost at rank 2 (tiny load, cost 1000, final bid 1500 -> 50% margin)
    await store.putDoc('closedBids', 'L2', { auctionId: 'L2', status: 'closed', won: false, finalRank: 2, cost: 1000, lastBidPrice: 1500, ourBids: [{ price: 1500, ts: WIN_START + 30 }] });
    // L3 still open with a bid in
    await store.putDoc('closedBids', 'L3', { auctionId: 'L3', status: 'open', won: null, cost: 50000, lastBidPrice: 56000, ourBids: [{ price: 56000, ts: WIN_START + 40 }] });
    const day = await collectCustomerDay({
      requests: fakeRequests(reqs), store,
      aliases: ['Syngenta', 'Syngenta India'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok(day.inquiries === 5, `cohort = Syngenta requests created in the window (got ${day.inquiries})`);
    ok(day.participated === 3, `participated = cohort loads with at least one bid (got ${day.participated})`);
    ok(day.won === 1 && day.lostDecided === 1 && day.decided === 2, 'won/lost split from DECIDED auctions only');
    ok(day.stillLive === 1, 'an open participated auction is still-live, never a loss');
    ok(day.missedCutoff === 1, 'missed-the-cutoff counted from the cohort');
    ok(day.awaiting === 1 && day.armedTonight === 1, 'right-now lines: awaiting price + armed for tonight');
    // WEIGHTED margin pin: (5000 + 500 + 6000) / (100000 + 1000 + 50000) = 11500/151000 = 7.6%
    ok(Math.abs(day.weightedMarginPct - (11500 / 151000) * 100) < 1e-9, 'weighted margin = total margin amount / total cost across bid loads');
    ok(day.wonValue === 105000, `won value = sum of final accepted bids on WON loads only (got ${day.wonValue})`);
    ok(JSON.stringify(day.lostRanks) === JSON.stringify([2]), 'lost ranks collected from lost loads that carry finalRank (rank only, never amounts)');
    ok(day.medianResponseMs === 1, `median response over the cohort's priced loads (3 x 1ms -> 1, got ${day.medianResponseMs})`);
  }

  // ---- median response: even-count math from real requests, and the <2-sample gate ----
  {
    const mk = (id, createdAt, capturedAt) => ({ loadId: id, createdAt, capturedAt, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 10 } });
    const store = new MemoryStore();
    // two priced loads, responses 4 min and 8 min -> median 6 min (even count, pinned)
    const day = await collectCustomerDay({
      requests: fakeRequests([mk('M1', WIN_START + 1, WIN_START + 1 + 4 * 60000), mk('M2', WIN_START + 2, WIN_START + 2 + 8 * 60000)]),
      store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok(day.medianResponseMs === 6 * 60000, `even-count median from request timestamps (got ${day.medianResponseMs})`);
    // a single priced load is NOT a median - gate to null
    const one = await collectCustomerDay({
      requests: fakeRequests([mk('M3', WIN_START + 1, WIN_START + 1 + 9 * 60000)]),
      store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok(one.medianResponseMs === null, 'fewer than 2 priced loads -> no median (a single sample overstates)');
  }

  // ---- the weighting pin the client cares about: big-low + tiny-high stays near the big load ----
  {
    const reqs = [
      { loadId: 'B1', createdAt: WIN_START + 1, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 500 } },
      { loadId: 'B2', createdAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 400 } },
    ];
    const store = new MemoryStore();
    await store.putDoc('closedBids', 'B1', { auctionId: 'B1', status: 'closed', won: true, cost: 100000, lastBidPrice: 105000, ourBids: [{ price: 105000, ts: WIN_START + 5 }] }); // 5% on 1L
    await store.putDoc('closedBids', 'B2', { auctionId: 'B2', status: 'closed', won: false, cost: 1000, lastBidPrice: 1500, ourBids: [{ price: 1500, ts: WIN_START + 6 }] });      // 50% on 1k
    const day = await collectCustomerDay({ requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW });
    // simple average would say 27.5%; weighted = 5500/101000 = 5.45% - the tiny load can't skew it
    ok(day.weightedMarginPct > 5 && day.weightedMarginPct < 6, `one big low-margin + one tiny high-margin lands near the big load's margin (got ${day.weightedMarginPct.toFixed(2)}%)`);
    const msg = renderEodReport({ label: 'Syngenta', day, slot: '8 pm' }, NOW);
    ok(msg.includes('*Margin* - 5.4%\n_weighted by load value_'), 'margin renders to 1dp with the "weighted by load value" qualifier on its own sub-line');
  }

  // ---- G-CC11: the EOD margin anchors on BID-TIME cost, same as the won/lost receipt ----
  // Before this fix the EOD summed doc.cost (last-writer-wins after a re-price) while the receipt
  // (engineAlerts.outcomeEnrichment via bidTimeBand) summed the cost stamped on the bid itself, so
  // one load could read +9% on its receipt and -16.82% here. This proves the two surfaces now
  // resolve to the SAME cost anchor, off the exact anchor-load shape from the forensic record
  // (260908LD2Z): bid-time cost 29,000, doc.cost corrected to 38,000 after the bid landed, won at
  // 31,610.
  {
    const reqs = [
      { loadId: 'CORR1', createdAt: WIN_START + 1, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 500 } },
    ];
    const store = new MemoryStore();
    const rec = {
      auctionId: 'CORR1', status: 'closed', won: true, finalRank: 1,
      cost: 38000, lastBidPrice: 31610,
      ourBids: [{ price: 31610, rungIndex: 0, bidTimeCost: 29000, bidTimeMinMarginPct: 1 }],
    };
    await store.putDoc('closedBids', 'CORR1', rec);
    const day = await collectCustomerDay({ requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW });
    const receiptMarginPct = Number(outcomeEnrichment(rec).marginPct);
    ok(Math.abs(day.weightedMarginPct - receiptMarginPct) < 0.01,
      `EOD margin (${day.weightedMarginPct}) matches the receipt's bid-time margin (${receiptMarginPct}), not the doc-cost -16.82% the corrected-cost anchor gave`);
    ok(Math.abs(day.weightedMarginPct - 9) < 0.01, `both anchor on 29,000, not the corrected 38,000 (got ${day.weightedMarginPct})`);
  }

  // ---- G-CC11 fallback: a legacy row with no bid-time snapshot still computes, off doc.cost ----
  // ~3,136 records predate the snapshot - ourBids entries with no bidTimeCost key at all. The
  // fallback order must match the receipt's exactly: fall back to the doc-level cost rather than
  // going null or inventing a new rule.
  {
    const reqs = [
      { loadId: 'LEG1', createdAt: WIN_START + 1, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 500 } },
    ];
    const store = new MemoryStore();
    const legacy = {
      auctionId: 'LEG1', status: 'closed', won: false, finalRank: 6,
      cost: 75000, lastBidPrice: 77700,
      ourBids: [{ price: 79350, rungIndex: 0 }, { price: 77700, rungIndex: 1 }], // no bidTimeCost key
    };
    await store.putDoc('closedBids', 'LEG1', legacy);
    const day = await collectCustomerDay({ requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW });
    // (77700 - 75000) / 75000 * 100 = 3.6%, same as outcomeEnrichment's B-case pin for this record.
    ok(Math.abs(day.weightedMarginPct - 3.6) < 0.01, `a legacy row with no snapshot falls back to doc.cost, same as the receipt (got ${day.weightedMarginPct})`);
  }

  // ---- renderer: mobile-first blocks, unified vocabulary, emoji leaders ----
  {
    const day = {
      // pricedCount is what the rendered "Priced" line reads since D073; equal to participated
      // here on purpose - this fixture is about the RENDERER's label plumbing, not the split
      // between the two counts (see test-d073-eod-priced-line-counts-actual-price-captures.js).
      ok: true, inquiries: 5, participated: 3, pricedCount: 3, won: 1, lostDecided: 1, decided: 2, stillLive: 1,
      missedCutoff: 1, awaiting: 1, armedTonight: 1, weightedMarginPct: 7.6158, marginBase: 3,
      wonValue: 140000, lostRanks: [2], medianResponseMs: 6 * 60000,
    };
    const msg = renderEodReport({ label: 'Syngenta', day, slot: '8 pm' }, NOW);
    // Verdict line: one clean glance (no longer two denominators), emoji-led, dated.
    ok(msg.split('\n')[0] === '\u{2705} *Syngenta - end of day: won 1 of 2* (Thu 16 Jul)', 'verdict-first line: one clean win glance + the date');
    // Block 1 - funnel in, one fact per emoji-led line; "priced" not "participated".
    ok(msg.includes('\u{1F4E9} *Inquiries* - 5'), 'inquiries line, emoji-led');
    ok(msg.includes('\u{1F4B0} *Priced* - 3 of 5 (60%)'), 'priced (was "participated") carries its share of inquiries');
    ok(msg.includes('\u{23F3} *Missed cutoff* - 1 of 5'), 'missed cutoff surfaced as the funnel complement, of inquiries');
    // Block 2 - outcomes; the unfinished state is the only thing announced, one rank per line.
    ok(msg.includes('\u{1F504} *1 still bidding* - not final yet'), 'still-bidding line names the unfinished count');
    ok(msg.includes('\u{1F3C6} *Won* - 1 of 2 so far (50%)'), 'won rate divides by closed only, flagged "so far" while auctions run');
    ok(msg.includes('\u{1F4C9} *Lost* - 1\n\u{1F3C5} rank 2 - 1'), 'lost total then one rank per line (never a wrapping comma list)');
    // Block 3 - quality, two visual groups. Won value + its caveat, ONE blank line,
    // then Margin/Desk - each trailing qualifier now a wrap-proof italic sub-line
    // (no parentheses).
    ok(msg.includes('\u{1F4B5} *Won value* - Rs 1.4L\n_rank 1 at close, award not confirmed yet_'), 'won value Indian-compact, unconfirmed-award caveat on its own italic line');
    ok(!msg.includes('allotment not tracked yet'), 'the internal "allotment not tracked" jargon is gone');
    ok(msg.includes('_rank 1 at close, award not confirmed yet_\n\n\u{1F4CA} *Margin*'), 'a blank line separates the won-value group from the margin/desk group');
    ok(msg.includes('\u{1F4CA} *Margin* - 7.6%\n_weighted by load value_'), 'margin qualifier moved to its own italic sub-line, no parentheses');
    ok(!msg.includes('(weighted by load value)'), 'the wrapping parenthetical qualifier is gone');
    ok(msg.includes('_Margins measured at the cost when each bid was placed._'), 'G-CC11: the anchor label states plainly which cost the margin is measured at');
    // the label rides with the number - a day with no captured cost has no margin to anchor, so no label either
    const noCostDay = Object.assign({}, day, { marginBase: 0, weightedMarginPct: null });
    const noCostMsg = renderEodReport({ label: 'Syngenta', day: noCostDay, slot: '8 pm' }, NOW);
    ok(noCostMsg.includes('*Margin* - not available today'), 'no captured cost -> the existing "not available today" line');
    ok(!noCostMsg.includes('Margins measured at'), 'and no anchor label on a day with no margin number to anchor');
    ok(msg.includes('\u{23F1}\u{FE0F} *Desk response* - ~6 min\n_median_'), 'desk response value on one line, "median" as its own italic sub-line');
    ok(!msg.includes('~6 min (median)'), 'the wrapping "(median)" parenthetical is gone');
    // Right-now snapshot + the plain rolling-24h footer.
    ok(msg.includes('\u{1F4CC} *Right now* - 1 armed for tonight, 1 awaiting price'), 'right-now line aggregated, terse, emoji-led');
    ok(msg.includes('_Automated report for Syngenta loads._\n_Last 24h._'), 'footer is two short italic lines: what it is, then just "Last 24h"');
    ok(!msg.includes('yesterday 8 pm to today 8 pm'), 'the redundant window parenthetical is dropped from the footer');
    // Emoji discipline: leaders throughout, but ASCII outside the deliberate set, and
    // the footer stays emoji-free so it reads as the serious note it is.
    ok(asciiButEmoji(msg), 'rendered message is ASCII outside the deliberate emoji-leader set');
    ok(msg.split('\n')[0].startsWith('\u{2705}'), 'verdict line leads with the check glyph');
    ok(emojiCount(msg.split('\n').pop()) === 0, 'footer line carries no emoji');
    ok(emojiCount(msg) >= 8, `emoji act as per-line leaders now, not a single verdict glyph (got ${emojiCount(msg)})`);
  }
  {
    // nothing closed yet -> say so in words, never a fake 0% win rate
    const day = { ok: true, inquiries: 2, participated: 2, won: 0, lostDecided: 0, decided: 0, stillLive: 2, missedCutoff: 0, awaiting: 0, armedTonight: 2, weightedMarginPct: 8.2, marginBase: 2 };
    const msg = renderEodReport({ label: 'Renewsys', day, slot: '8 pm' }, NOW);
    ok(msg.includes('\u{1F504} *2 still bidding* - not final yet'), 'nothing closed -> only the still-bidding line, never a fake 0%');
    ok(msg.includes('2 loads in'), 'verdict glance falls back to loads-in before anything closes');
    ok(!msg.includes('won 0 of 0'), 'glance line never says won 0 of 0');
    // CONDITIONAL rendering: no line appears without its data
    ok(!msg.includes('Won value'), 'no won value -> no value line');
    ok(!msg.includes('award not confirmed'), 'no value -> no caveat line');
    ok(!msg.includes('*Lost*'), 'no lost loads -> no Lost line');
    ok(!msg.includes('Desk response'), 'no median -> no response line');
    // margin is never dropped on a day we bid on something; qualifier is a sub-line
    ok(msg.includes('\u{1F4CA} *Margin* - 8.2%\n_weighted by load value_'), 'margin still renders on a still-live day (participated > 0), qualifier as a sub-line');
  }

  // ---- the unfinished-state line: the director's "Closed - 12 of 12 priced" fix ----
  // Three cases, because the whole point is that the line only exists when it carries
  // information: everything finished (say nothing), some still running (say THAT), and
  // nothing finished yet (say only that, never a win rate over zero finished).
  //
  // "closed" is banned from the WHOLE message, verdict headline included - it was the
  // one word the client's director misread, and leaving it in the one line the chat
  // list previews would have reintroduced it in the most visible place of all. The
  // no-closed assertions below therefore test the entire rendered string, case-blind.
  const noClosedAnywhere = (s) => !/closed/i.test(s);
  {
    // (a) every priced load has finished -> no finished-count line, no still-bidding line
    const day = { ok: true, inquiries: 14, participated: 12, won: 4, lostDecided: 8, decided: 12, stillLive: 0, missedCutoff: 2, awaiting: 0, armedTonight: 0, weightedMarginPct: 7.1, marginBase: 12, wonValue: 480000, lostRanks: [3], medianResponseMs: null };
    const msg = renderEodReport({ label: 'Havells', day, slot: '8 pm' }, NOW);
    ok(noClosedAnywhere(msg), 'all finished -> the word "closed" appears nowhere, verdict headline included');
    ok(msg.split('\n')[0] === '\u{2705} *Havells - end of day: won 4 of 12* (Thu 16 Jul)', 'headline is the bare real ratio - no trailing noun, never an N-of-N');
    ok(!msg.includes('of 12 priced'), 'all finished -> the zero-information "12 of 12 priced" line is gone');
    ok(!msg.includes('still bidding'), 'all finished -> no still-bidding line either');
    ok(!msg.includes('\u{1F3C1}'), 'the chequered-flag leader is retired from the rendered message');
    ok(msg.includes('\u{1F3C6} *Won* - 4 of 12 (33%)'), 'all finished -> the Won line is final, no "so far"');
    ok(!msg.includes('so far'), 'all finished -> nothing is provisional, so nothing says "so far"');
    ok(msg.includes('\u{1F4C9} *Lost* - 8'), 'the results block is just Won / Lost / ranks');
  }
  {
    // (b) auctions still running -> the unfinished count is the visible thing, Won is provisional
    const day = { ok: true, inquiries: 15, participated: 12, won: 1, lostDecided: 8, decided: 9, stillLive: 3, missedCutoff: 3, awaiting: 0, armedTonight: 3, weightedMarginPct: 6.4, marginBase: 12, wonValue: 90000, lostRanks: [2, 2, 5], medianResponseMs: null };
    const msg = renderEodReport({ label: 'Havells', day, slot: '8 pm' }, NOW);
    ok(msg.includes('\u{1F504} *3 still bidding* - not final yet'), 'still-bidding line carries the live count and says it is not final');
    ok(msg.includes('\u{1F3C6} *Won* - 1 of 9 so far (11%)'), 'Won stays on the decided denominator and is marked provisional');
    ok(noClosedAnywhere(msg), 'no "closed" wording survives anywhere, verdict headline included');
    ok(msg.split('\n')[0] === '\u{2705} *Havells - end of day: won 1 of 9* (Thu 16 Jul)', 'headline is the bare ratio; the still-bidding + "so far" lines carry the provisional state');
    ok(!msg.includes('still live'), 'the old "(N still live)" parenthetical is gone');
    // the still-bidding line leads the results block, before Won
    const body = msg.split('\n');
    const iLive = body.findIndex((l) => l.includes('still bidding'));
    const iWon = body.findIndex((l) => l.includes('*Won*'));
    ok(iLive > -1 && iWon > iLive, 'the unfinished state is announced before the (provisional) win count');
    ok(asciiButEmoji(msg), 'the reworded block stays ASCII outside the deliberate emoji set');
  }
  {
    // (c) nothing decided yet, auctions still running -> still-bidding line only, NO win rate
    const day = { ok: true, inquiries: 6, participated: 4, won: 0, lostDecided: 0, decided: 0, stillLive: 4, missedCutoff: 2, awaiting: 0, armedTonight: 4, weightedMarginPct: 9.0, marginBase: 4, wonValue: 0, lostRanks: [], medianResponseMs: null };
    const msg = renderEodReport({ label: 'KEI', day, slot: '8 pm' }, NOW);
    ok(msg.includes('\u{1F504} *4 still bidding* - not final yet'), 'zero decided -> the still-bidding line still appears with the right count');
    ok(!msg.includes('*Won*'), 'zero decided -> no Won line at all, so no denominator of zero');
    ok(!msg.includes('(0%)'), 'zero decided -> never a fake 0% winning rate');
    ok(!msg.includes('none yet'), 'zero decided -> the old "Closed - none yet" phrasing is gone');
    ok(noClosedAnywhere(msg), 'zero decided -> no "closed" wording anywhere (headline falls back to loads-in)');
  }
  {
    // (d) an unseen close is RENDERED. collectCustomerDay has counted closedUnknown since the class
    // existed and renderEodReport never read it, so those rows vanished from the customer's message
    // entirely: Won and Lost both understate, and the blocks stop reconciling with Priced.
    const day = { ok: true, inquiries: 10, participated: 8, won: 2, lostDecided: 3, closedUnknown: 3, decided: 5, stillLive: 0, missedCutoff: 2, awaiting: 0, armedTonight: 0, weightedMarginPct: 7.1, marginBase: 8, wonValue: 90000, lostRanks: [2, 3, 4], medianResponseMs: null };
    const msg = renderEodReport({ label: 'Waaree', day, slot: '8 pm' }, NOW);
    ok(msg.includes('\u{2753} *Result not seen* - 3'), 'the unseen closes get their own line and their own glyph');
    ok(msg.includes('_we could not see how these ended_'), 'with the plain-English reason on a sub-line');
    ok(msg.includes('\u{1F3C6} *Won* - 2 of 5 (40%)'), 'Won still divides by DECIDED only - an unseen close is not in that denominator');
    ok(msg.includes('\u{1F4C9} *Lost* - 3'), 'and Lost is unchanged - the class is absorbed by neither');
    ok(day.won + day.lostDecided + day.closedUnknown === day.participated,
      'the outcome lines now account for every load we bid on');
    ok(asciiButEmoji(msg), 'the added lines keep the message ASCII outside the deliberate emoji-leader set');

    // A day whose ONLY closes were unseen used to render "Won - none yet", which reads as still
    // pending on an evening when the auctions did in fact close.
    const unknownOnly = { ok: true, inquiries: 4, participated: 2, won: 0, lostDecided: 0, closedUnknown: 2, decided: 0, stillLive: 0, missedCutoff: 0, awaiting: 0, armedTonight: 0, weightedMarginPct: null, marginBase: 0, wonValue: 0, lostRanks: [], medianResponseMs: null };
    const msg2 = renderEodReport({ label: 'Waaree', day: unknownOnly, slot: '8 pm' }, NOW);
    ok(!msg2.includes('none yet'), 'unknown-only day does not report the outcomes as not in yet');
    ok(msg2.includes('\u{2753} *Result not seen* - 2'), 'it states what actually happened instead');
  }
  {
    // lost loads WITHOUT rank data: the Lost line is omitted entirely (never an empty medal)
    const day = { ok: true, inquiries: 3, participated: 2, won: 1, lostDecided: 1, decided: 2, stillLive: 0, missedCutoff: 0, awaiting: 0, armedTonight: 0, weightedMarginPct: 6.3, marginBase: 2, wonValue: 45000, lostRanks: [], medianResponseMs: null };
    const msg = renderEodReport({ label: 'Syngenta', day, slot: '8 pm' }, NOW);
    ok(!msg.includes('*Lost*'), 'lost loads with no rank data -> Lost line omitted entirely');
    ok(msg.includes('\u{1F3C6} *Won* - 1 of 2 (50%)'), 'won line renders even when the lost line is suppressed');
    ok(msg.includes('\u{1F4B5} *Won value* - Rs 45,000'), 'sub-lakh won value stays plain Indian-grouped rupees');
  }
  {
    // quiet day: ONE short line, no skeleton, no emoji, no footer
    const day = { ok: true, inquiries: 0, participated: 0, won: 0, lostDecided: 0, decided: 0, stillLive: 0, missedCutoff: 0, awaiting: 0, armedTonight: 0, weightedMarginPct: null, marginBase: 0 };
    const msg = renderEodReport({ label: 'Syngenta', day, slot: '8 pm' }, NOW);
    ok(msg === '*Syngenta* - no loads today, all quiet (Thu 16 Jul)', 'quiet day is one line, nothing else');
    ok(emojiCount(msg) === 0, 'quiet day carries no emoji');
  }
  {
    const msg = renderDegraded('Syngenta', NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F} *Syngenta* - the end-of-day report could not read today\'s records'), 'degraded variant is warning-signed, never cheerful');
    ok(!msg.includes('\u{2705}'), 'no green check on a degraded report');
  }

  // ---- runEodReport: per-group isolation, own data per group, state ----
  {
    const people = [
      { personId: 'g1', name: 'Syngenta BRL group', phone: '123450001@g.us', enabled: true },
      { personId: 'g2', name: 'Renewsys BRL group', phone: '123450002@g.us', enabled: true },
    ];
    const customers = [
      { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'], enabled: true },
      { customerId: 'renewsys', label: 'Renewsys', aliases: ['Renewsys'], enabled: true },
    ];
    const assignments = [
      { assignmentId: 'g1::syngenta', personId: 'g1', customerId: 'syngenta', enabled: true },
      { assignmentId: 'g2::renewsys', personId: 'g2', customerId: 'renewsys', enabled: true },
    ];
    const reqs = [
      { loadId: 'S1', createdAt: WIN_START + 1, status: 'closed', load: { companyName: 'Syngenta India', closesAt: NOW - 500 } },
    ];
    const store = new MemoryStore();
    await store.putDoc('closedBids', 'S1', { auctionId: 'S1', status: 'closed', won: true, cost: 40000, lastBidPrice: 43000, ourBids: [{ price: 43000, ts: WIN_START + 5 }] });
    const n = fakeNotifier();
    const deps = Object.assign(modelStores({ people, customers, assignments }), {
      store, requests: fakeRequests(reqs), notifier: n,
      config: { eodReport: { enabled: true, timeIST: '20:00' } }, now: NOW,
    });
    const res = await runEodReport(deps);
    ok(res.sent === 2 && n.sends.length === 2, 'every resolved group got its message');
    const syn = n.sends.find((s) => s.phone === '123450001@g.us');
    const ren = n.sends.find((s) => s.phone === '123450002@g.us');
    ok(syn && syn.message.includes('*Inquiries* - 1') && syn.message.includes('end of day: won 1 of 1*'), 'Syngenta group sees Syngenta\'s day');
    ok(syn && syn.message.includes('*Won value* - Rs 43,000'), 'won value flows end-to-end from the closed-bids doc');
    ok(ren && ren.message.includes('no loads today, all quiet'), 'Renewsys group sees ITS quiet day, not Syngenta\'s numbers');
    ok(syn.opts.kind === 'eod_report', 'sends tagged kind=eod_report for log correlation');
    const state = await store.getDoc(COLLECTION, STATE_KEY);
    ok(state && state.sentDate === '2026-07-16', 'a successful run records sentDate (the catch-up dedupe)');
  }
  {
    // one group's broken data degrades ONE message; the other group is untouched
    const people = [
      { personId: 'g1', name: 'Syngenta BRL group', phone: '123450001@g.us', enabled: true },
      { personId: 'g2', name: 'Renewsys BRL group', phone: '123450002@g.us', enabled: true },
    ];
    const customers = [
      { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'], enabled: true },
      { customerId: 'renewsys', label: 'Renewsys', aliases: ['Renewsys'], enabled: true },
    ];
    const assignments = [
      { assignmentId: 'g1::syngenta', personId: 'g1', customerId: 'syngenta', enabled: true },
      { assignmentId: 'g2::renewsys', personId: 'g2', customerId: 'renewsys', enabled: true },
    ];
    // listAll throws on the SECOND call (Syngenta gathers fine, Renewsys's gather dies)
    let calls = 0;
    const flaky = { listAll: async () => { calls += 1; if (calls >= 2) throw new Error('store exploded'); return []; } };
    const n = fakeNotifier();
    const deps = Object.assign(modelStores({ people, customers, assignments }), {
      store: new MemoryStore(), requests: flaky, notifier: n,
      config: { eodReport: { enabled: true, timeIST: '20:00' } }, now: NOW,
    });
    const res = await runEodReport(deps);
    ok(res.sent === 2 && n.sends.length === 2, 'a broken gather still sends BOTH groups something');
    ok(n.sends[0].message.includes('all quiet'), 'the healthy group\'s message is unaffected');
    ok(n.sends[1].message.includes('could not read today\'s records'), 'the broken group gets the degraded message, not silence');
  }

  // ---- startDailyEodReport: gate + catch-up dedupe on the shared rail ----
  {
    ok(startDailyEodReport({ config: { eodReport: { enabled: false } } }) === null, 'disabled config starts nothing');
    const realNow = Date.now;
    Date.now = () => NOW + 10 * 60000; // 20:10 IST - inside the catch-up window
    try {
      const people = [{ personId: 'g1', name: 'Syngenta BRL group', phone: '123450001@g.us', enabled: true }];
      const customers = [{ customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'], enabled: true }];
      const assignments = [{ assignmentId: 'g1::syngenta', personId: 'g1', customerId: 'syngenta', enabled: true }];
      const store = new MemoryStore();
      const n = fakeNotifier();
      const deps = Object.assign(modelStores({ people, customers, assignments }), {
        store, requests: fakeRequests([]), notifier: n,
        config: { eodReport: { enabled: true, timeIST: '20:00' } },
      });
      const handle = startDailyEodReport(deps);
      ok(handle && typeof handle.stop === 'function', 'enabled start returns a stoppable handle');
      await new Promise((r) => setTimeout(r, 50));
      ok(n.sends.length === 1, `boot inside the catch-up window with no sentDate sends the missed report (got ${n.sends.length})`);
      handle.stop();
      const n2 = fakeNotifier();
      const handle2 = startDailyEodReport(Object.assign({}, deps, { notifier: n2 }));
      await new Promise((r) => setTimeout(r, 50));
      ok(n2.sends.length === 0, 'catch-up dedupes on sentDate - a post-send restart is silent');
      handle2.stop();
    } finally {
      Date.now = realNow;
    }
  }

  // ---- SPLIT CUSTOMER: one customer, three plant groups, one report each ----
  // Waaree on GoComet - the case this scoping exists for. Origins are the verbatim postal
  // addresses the portal publishes as lane.origin, because that is the string routing matched
  // all day and a shortened stand-in would prove nothing about the tokens actually in use.
  {
    const CHIKHLI = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
    const KUTCH = 'Survey No.644, Orpat Industrial Estate, Near Surajbar Bridge, Orpat Nagar, 8-A National Highway, Vandhia, Samakhiyali, Bhachau, Kutch - 370150';
    const NOIDA = '3C/1, Ecotech 2, Udyog Vihar Road, Gautam Buddha Nagar, Udyog Vihar, Greater Noida-201306, Uttar Pradesh';
    const CUDDALORE = 'WRTL - Villagangatur, Mannampadi, Survey no 219/3, Sathiyam to sirimangalam road, Cuddalore - 606302';

    const people = [
      { personId: 'gchk', name: 'Waaree Chikhli', phone: '120363411977871374@g.us', enabled: true, originScope: ['chikhli', 'valsad'] },
      { personId: 'gkut', name: 'Waaree Samakhiyali', phone: '120363427997567727@g.us', enabled: true, originScope: ['samakhiyali'] },
      { personId: 'gnoi', name: 'Waaree Noida', phone: '120363410009206011@g.us', enabled: true, originScope: ['ecotech', 'dadri'] },
    ];
    const customers = [{ customerId: 'waaree', label: 'Waaree', aliases: ['Waaree Energies Ltd.'], enabled: true }];
    const assignments = people.map((p) => ({ assignmentId: `${p.personId}::waaree`, personId: p.personId, customerId: 'waaree', enabled: true }));
    const groups = await resolveGroups(modelStores({ people, customers, assignments }));
    const byId = new Map(groups.map((g) => [g.personId, g]));
    ok(groups.length === 3, `one customer can resolve to several plant groups (got ${groups.length})`);
    ok(byId.get('gchk').origins.join(',') === 'chikhli,valsad', 'the group record originScope rides onto the resolved group');
    ok(Array.isArray(byId.get('gchk').branches) && !byId.get('gchk').branches.length, 'a group with no branchScope resolves to an empty branch list');

    const req = (id, origin) => ({
      loadId: id, createdAt: WIN_START + 1, capturedAt: WIN_START + 2, status: 'closed',
      load: { companyName: 'Waaree Energies Ltd.', lane: { origin, destination: 'Pune 410501' }, closesAt: NOW - 3600000 },
    });
    const reqs = [req('W1', CHIKHLI), req('W2', KUTCH), req('W3', NOIDA), req('W4', CUDDALORE)];
    const store = new MemoryStore();
    // Distinct won values so a leak is visible as a rupee figure in the wrong group's message.
    await store.putDoc('closedBids', 'W1', { auctionId: 'W1', status: 'closed', won: true, cost: 200000, lastBidPrice: 300000, ourBids: [{ price: 300000 }] });
    await store.putDoc('closedBids', 'W2', { auctionId: 'W2', status: 'closed', won: true, cost: 30000, lastBidPrice: 45000, ourBids: [{ price: 45000 }] });

    const dayFor = (g, over = {}) => collectCustomerDay(Object.assign({
      requests: fakeRequests(reqs), store, aliases: g.aliases, origins: g.origins, branches: g.branches,
      windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    }, over));

    const chk = await dayFor(byId.get('gchk'));
    const kut = await dayFor(byId.get('gkut'));
    const noi = await dayFor(byId.get('gnoi'));
    ok(chk.inquiries === 1 && kut.inquiries === 1 && noi.inquiries === 1, `each plant group sees only its own plant (got ${chk.inquiries}/${kut.inquiries}/${noi.inquiries})`);
    ok(chk.wonValue === 300000, 'the Chikhli group reports its own won value');
    ok(kut.wonValue === 45000, "the Kutch group's won value excludes Chikhli's win");
    ok(noi.wonValue === 0 && noi.participated === 0, 'a plant with no bids reports none of another plant\'s');
    // The leak this fix closes: before origin scoping every group saw all four.
    const wide = await dayFor(byId.get('gkut'), { origins: [] });
    ok(wide.inquiries === 4, 'an un-narrowed group still sees the whole customer - narrowing is per group, not a global change');

    // The gap narrowing itself opens: Cuddalore matches no group's tokens.
    const gap = await unclaimedLoads({ requests: fakeRequests(reqs), groups, windowStart: WIN_START, windowEnd: WIN_END });
    ok(gap.length === 1 && gap[0].loadId === 'W4', `a load matching no group's scope is reported, not swallowed (got ${JSON.stringify(gap.map((u) => u.loadId))})`);
    const openScopes = groups.map((g) => Object.assign({}, g, { origins: [] }));
    ok((await unclaimedLoads({ requests: fakeRequests(reqs), groups: openScopes, windowStart: WIN_START, windowEnd: WIN_END })).length === 0,
      'with every scope open nothing is unclaimed');
    ok((await unclaimedLoads({ requests: fakeRequests(reqs), groups: [], windowStart: WIN_START, windowEnd: WIN_END })).length === 0,
      'no reporting groups at all means no customer is being reported on - nothing to claim');

    // End to end: runEodReport must PASS the scope through, not just accept it.
    const n = fakeNotifier();
    const res = await runEodReport(Object.assign(modelStores({ people, customers, assignments }), {
      store, requests: fakeRequests(reqs), notifier: n, now: NOW,
      config: { eodReport: { enabled: true, timeIST: '20:00' } },
    }));
    ok(res.sent === 3, `every plant group still gets its own message (got ${res.sent})`);
    const msgOf = (jid) => (res.messages.find((m) => m.jid === jid) || {}).message || '';
    const chkMsg = msgOf('120363411977871374@g.us');
    const kutMsg = msgOf('120363427997567727@g.us');
    ok(chkMsg.includes('Rs 3L') && !chkMsg.includes('Rs 45,000'), 'the Chikhli message carries its own money and not Kutch\'s');
    ok(kutMsg.includes('Rs 45,000') && !kutMsg.includes('Rs 3L'), 'the Kutch message carries its own money and not Chikhli\'s');
    ok(msgOf('120363410009206011@g.us').includes('Inquiries* - 1'), 'the Noida message counts one inquiry, not the customer\'s four');
  }

  // ---- branchScope narrows the same way originScope does ----
  {
    const people = [
      { personId: 'gall', name: 'Havells group', phone: '123460001@g.us', enabled: true },
      { personId: 'galw', name: 'Havells Alwar group', phone: '123460002@g.us', enabled: true, branchScope: ['Alwar (1350)'] },
    ];
    const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells India'], enabled: true }];
    const assignments = people.map((p) => ({ assignmentId: `${p.personId}::havells`, personId: p.personId, customerId: 'havells', enabled: true }));
    const groups = await resolveGroups(modelStores({ people, customers, assignments }));
    const alw = groups.find((g) => g.personId === 'galw');
    ok(alw.branches.join(',') === 'Alwar (1350)', 'the group record branchScope rides onto the resolved group');
    const reqs = [
      { loadId: 'H1', createdAt: WIN_START + 1, status: 'awaiting_price', load: { companyName: 'Havells India', branchName: 'Alwar (1350)', lane: { origin: 'Alwar', destination: 'Pune' }, closesAt: NOW + 60000 } },
      { loadId: 'H2', createdAt: WIN_START + 2, status: 'awaiting_price', load: { companyName: 'Havells India', branchName: 'Neemrana (1420)', lane: { origin: 'Neemrana', destination: 'Pune' }, closesAt: NOW + 60000 } },
    ];
    const store = new MemoryStore();
    const day = (g) => collectCustomerDay({
      requests: fakeRequests(reqs), store, aliases: g.aliases, origins: g.origins, branches: g.branches,
      windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok((await day(alw)).inquiries === 1, 'a branch-scoped group reports only its own branch');
    // Deliberately NOT applyBranchPrecedence: the general group stays a superset, see the module header.
    ok((await day(groups.find((g) => g.personId === 'gall'))).inquiries === 2, 'the general group still reports the whole customer');
  }

  // ---- the scope LINE: what makes three sibling desks' reports tell themselves apart ----
  // #208 split the numbers; every group still opened "Waaree - end of day" over a different set
  // of them, and BRL's director read three identical-looking messages as one un-split total.
  {
    ok(scopeLabel([], []) === null, 'an un-narrowed group gets no scope label at all');
    ok(scopeLabel(undefined, undefined) === null, 'absent scope arrays are the un-narrowed case');
    const one = scopeLabel(['samakhiyali'], []);
    ok(one.line === 'Samakhiyali', 'a lowercase origin token title-cases');
    ok(one.covers === 'this plant', 'a single origin reads singular, determiner included');
    const three = scopeLabel(['ecotech', 'dadri', 'guddhi'], []);
    ok(three.line === 'Ecotech, Dadri, Guddhi', 'up to three tokens are named in full');
    ok(three.covers === 'these plants', 'several origins read plural');
    // The live Chikhli group holds nine; a full list wraps past the point anyone reads it.
    const nine = scopeLabel(['chikhli', 'valsad', 'nandigram', 'umbergaon', 'yelahanka', 'jio world',
      'ahmedabad international airport', 'cuddalore', 'neelmangala'], []);
    ok(nine.line === 'Chikhli, Valsad, Nandigram +6 more', `nine tokens collapse to three plus a count (got ${nine.line})`);
    ok(scopeLabel(['jio world'], []).line === 'Jio World', 'every word in a multi-word token title-cases');
    // Branch tokens arrive already cased and must survive intact - only the first letter is touched.
    const br = scopeLabel([], ['Alwar Cable (1350)', 'Alwar Wire (1351)']);
    ok(br.line === 'Alwar Cable (1350), Alwar Wire (1351)', `an already-cased branch token is not re-cased (got ${br.line})`);
    ok(br.covers === 'these branches', 'a branch-only group is described as branches, never plants');
    ok(scopeLabel([], ['Alwar Cable (1350)']).covers === 'this branch', 'a single branch reads singular');
  }

  // ---- the scope line in the rendered message, on every path a narrowed group can take ----
  {
    const scopedDay = {
      inquiries: 78, participated: 2, missedCutoff: 60, decided: 2, won: 0, lostDecided: 2,
      stillLive: 0, awaiting: 16, armedTonight: 0, lostRanks: [5, 5], wonValue: 0,
      weightedMarginPct: 8.1, medianResponseMs: 112 * 60000,
    };
    const scoped = { label: 'Waaree', day: scopedDay, slot: '8 pm', origins: ['chikhli', 'valsad', 'nandigram', 'umbergaon'], branches: [] };
    const msg = renderEodReport(scoped, NOW);
    ok(msg.includes('Chikhli, Valsad, Nandigram +1 more'), 'the active-day message names the plants it covers');
    ok(msg.includes('from these plants'), 'the footer says the report is plant-scoped');
    ok(msg.indexOf('Chikhli') > 0 && msg.indexOf('Chikhli') < msg.indexOf('Inquiries'),
      'the scope line sits under the headline, above the numbers');

    // Two sibling desks must not be able to produce the same message.
    const sib = renderEodReport({ ...scoped, origins: ['samakhiyali'] }, NOW);
    // Compared as whole messages this passed on the FOOTER alone, and survived deleting the scope
    // line outright - so it compares the scope lines themselves.
    const scopeLineOf = (m) => m.split('\n').find((l) => l.startsWith('\u{1F4CD}')) || null;
    ok(scopeLineOf(msg) && scopeLineOf(sib) && scopeLineOf(msg) !== scopeLineOf(sib),
      'two groups of the same customer carry different scope lines on identical numbers');
    ok(sib !== msg, 'two groups of the same customer render differently even on identical numbers');
    ok(sib.includes('from this plant'), 'a one-plant group reads singular in the footer too');

    // An un-narrowed group is what it was before this line existed.
    const plain = renderEodReport({ label: 'Syngenta', day: scopedDay, slot: '8 pm' }, NOW);
    ok(!plain.includes('\u{1F4CD}'), 'an un-narrowed group gets no scope line');
    ok(plain.includes('_Automated report for Syngenta loads._'), 'an un-narrowed footer is unchanged');

    // The quiet day is the message siblings are most likely to compare - it has no numbers to
    // tell them apart, so it carries the scope too.
    const empty = { inquiries: 0, participated: 0, decided: 0, stillLive: 0, awaiting: 0, armedTonight: 0,
      missedCutoff: 0, lostRanks: [], wonValue: 0, weightedMarginPct: null, medianResponseMs: null, won: 0, lostDecided: 0 };
    const q1 = renderEodReport({ label: 'Waaree', day: empty, slot: '8 pm', origins: ['chikhli'] }, NOW);
    const q2 = renderEodReport({ label: 'Waaree', day: empty, slot: '8 pm', origins: ['samakhiyali'] }, NOW);
    ok(q1.includes('Chikhli') && q2.includes('Samakhiyali') && q1 !== q2, 'two quiet-day messages still differ');
    ok(!renderEodReport({ label: 'Syngenta', day: empty, slot: '8 pm' }, NOW).includes('('.concat(')')),
      'the un-narrowed quiet line gains no scope parenthetical');

    // Degraded is the third path, and a desk told "could not read your records" needs to know
    // WHOSE records - otherwise three warnings arrive and nobody knows if one desk or all three.
    const d1 = renderDegraded('Waaree', NOW, ['chikhli'], []);
    ok(d1.includes('Chikhli'), 'the degraded message names the scope');
    ok(d1 !== renderDegraded('Waaree', NOW, ['samakhiyali'], []), 'two degraded messages differ');
    ok(renderDegraded('Syngenta', NOW) === renderDegraded('Syngenta', NOW, [], []), 'an un-narrowed degraded message is unchanged');
  }


  // ---- T18: units-scaled won value + a second, separately-labelled bid-value total ----
  {
    // isTruckBasis guard, pinned directly (mirrors directorEod.js's own definition):
    // a recorded truck-count basis scales, PMT never scales, and an unrecorded basis
    // (null/absent quoteType) fails closed to "do not scale" rather than assuming FTL.
    ok(isTruckBasis({ quoteType: 'FTL' }) === true, 'a recorded truck-count basis is scalable');
    ok(isTruckBasis({ quoteType: 'PMT' }) === false, 'PMT (tonnage) never scales - units is not a truck count');
    ok(isTruckBasis({ quoteType: null }) === false, 'no recorded basis fails closed to "do not scale"');
    ok(isTruckBasis({}) === false, 'a load object with no quoteType field at all fails closed the same way');

    // The guard behaviour end-to-end through collectCustomerDay: a WON truck-basis load
    // with a unit count scales its contribution to wonValue AND to totalBidValue; a WON
    // PMT load with the same unit count does NOT scale, proving the guard - not just the
    // multiplication - is what gates it.
    const reqs = [
      { loadId: 'U1', createdAt: WIN_START + 1, status: 'closed', load: { companyName: 'Syngenta', quoteType: 'FTL', closesAt: NOW - 500 } },
      { loadId: 'U2', createdAt: WIN_START + 2, status: 'closed', load: { companyName: 'Syngenta', quoteType: 'PMT', closesAt: NOW - 400 } },
      { loadId: 'U3', createdAt: WIN_START + 3, status: 'closed', load: { companyName: 'Syngenta', closesAt: NOW - 300 } }, // lost - feeds totalBidValue only
    ];
    const store = new MemoryStore();
    // U1: truck basis, 3 units at Rs 10,000/unit -> wonValue contribution Rs 30,000 (not Rs 10,000).
    await store.putDoc('closedBids', 'U1', { auctionId: 'U1', status: 'closed', won: true, cost: 24000, lastBidPrice: 10000, units: 3, ourBids: [{ price: 10000 }] });
    // U2: PMT, 3 units at Rs 20,000 -> stays Rs 20,000 (never x3 -> Rs 60,000, the 1000x-class overstatement isTruckBasis exists to prevent).
    await store.putDoc('closedBids', 'U2', { auctionId: 'U2', status: 'closed', won: true, cost: 15000, lastBidPrice: 20000, units: 3, ourBids: [{ price: 20000 }] });
    // U3: lost, no units field at all - contributes its bid price alone to totalBidValue, nothing to wonValue.
    await store.putDoc('closedBids', 'U3', { auctionId: 'U3', status: 'closed', won: false, finalRank: 4, cost: 4000, lastBidPrice: 5000, ourBids: [{ price: 5000 }] });

    const day = await collectCustomerDay({
      requests: fakeRequests(reqs), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok(day.wonValue === 50000, `truck-basis load scales (10000*3), PMT load does not (20000*1): 30000+20000=50000 (got ${day.wonValue})`);
    ok(day.totalBidValue === 55000, `totalBidValue additionally carries the lost load's bid price unscaled: 50000+5000 (got ${day.totalBidValue})`);
    ok(day.totalBidValue > day.wonValue, 'total value bid (all bid-on) is strictly greater than won value whenever a non-won load contributed');

    // Rendered message: two distinct, plainly-labelled money lines, never a single
    // unlabelled figure and never the word "handled" anywhere in the message. The
    // rupee figures themselves carry a PMT-uncertainty band on production data (see
    // the T18 triage), so this asserts presence and labels only, never an exact amount.
    const msg = renderEodReport({ label: 'Syngenta', day, slot: '8 pm' }, NOW);
    ok(/\*Won value\*\s*-\s*Rs/.test(msg), 'a plainly-labelled won-loads money line is present');
    ok(/\*Total value bid\*\s*-\s*Rs/.test(msg), 'a second, separately-labelled all-bid-on money line is present');
    ok(!/handled/i.test(msg), 'the word "handled" never appears - a lost bid never became freight moved');
    const wonLine = msg.split('\n').find((l) => l.includes('*Won value*'));
    const totalLine = msg.split('\n').find((l) => l.includes('*Total value bid*'));
    ok(wonLine !== totalLine, 'the two totals render as two distinct lines, never merged into one');

    // A day with nothing won still shows the all-bid-on total distinctly (the two
    // figures are allowed to diverge, and neither line depends on the other's guard).
    const lostOnlyDay = await collectCustomerDay({
      requests: fakeRequests([reqs[2]]), store, aliases: ['Syngenta'], windowStart: WIN_START, windowEnd: WIN_END, now: NOW,
    });
    ok(lostOnlyDay.wonValue === 0 && lostOnlyDay.totalBidValue === 5000, 'an all-lost day has zero won value but a positive total-bid value');
    const lostMsg = renderEodReport({ label: 'Syngenta', day: lostOnlyDay, slot: '8 pm' }, NOW);
    ok(!lostMsg.includes('*Won value*'), 'no won value -> the won-loads line is omitted, never rendered as Rs 0');
    ok(/\*Total value bid\*\s*-\s*Rs/.test(lostMsg), 'the all-bid-on total still renders on a day nothing was won');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
