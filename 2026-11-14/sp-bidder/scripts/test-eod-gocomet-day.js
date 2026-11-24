'use strict';
/**
 * The 2026-08-12 EOD blackout, reconstructed end to end.
 *
 * That evening both EOD messages fired and both were wrong, from one cause. GoComet's first full
 * production day surfaced 88 Waaree loads inside the report window and the desk priced almost none
 * of them, but every EOD reader filtered its cohort to a single platformKey and production passed
 * config.platformKey, which is 'sp'. The group "BRL Bids . GC . Waaree" - a customer that exists
 * only on GoComet - was resolved, sent a message, and told "no loads today, all quiet". The
 * director DM the same evening put 74 surfaced loads outside the participation denominator, on the
 * one message whose stated job is to name the day's unpriced leak.
 *
 * The shape below is the harsh version of that day and the one that matters: GoComet loads
 * surfaced, ZERO costs entered, ZERO bids placed, SuperProcure busy alongside. A collector that
 * measures bids would still find nothing to say; the report has to carry the surfaced loads and the
 * missed cutoffs, because on a day like that those ARE the news.
 *
 * Driven through runEodReport / runDirectorEod, not just the collectors, because the defect lived
 * as much in what the callers passed as in what the collectors did with it. The notifier is a stub
 * that records - this file must never reach a real send path.
 *
 *   node scripts/test-eod-gocomet-day.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { COLLECTION: PRICE_REQ_COLLECTION } = require('../src/pricing/priceRequests');
const { COLLECTION: BIDLOG_COLLECTION } = require('../src/logging/bidLogger');
const { runEodReport } = require('../src/notify/eodReport');
const { runDirectorEod } = require('../src/notify/directorEod');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The runner grades by exit code alone, so a file that returns early scores a silent green.
const EXPECTED_CHECKS = 14;

// 20:00:01 IST, Wed 12 Aug 2026 - one second past the report slot, which is when the schedule
// fires. The rolling window is then [20:00 IST 11 Aug, 20:00 IST 12 Aug).
const NOW = Date.UTC(2026, 7, 12, 14, 30, 1);
const MIDDAY = Date.UTC(2026, 7, 12, 4, 30);   // 10:00 IST, inside both the rolling and IST-day windows

const GC_SURFACED = 8;
const GC_SKIPPED = 5;   // past cutoff, never priced - the leak
const SP_SURFACED = 6;
const SP_BID = 4;

async function seedDay(store) {
  const req = (id, over) => store.putDoc(PRICE_REQ_COLLECTION, id, Object.assign({
    id, marginsPct: [10], minMarginPct: 5, marginSource: 'default', price: null, capturedAt: null,
    createdAt: MIDDAY,
  }, over));
  const load = (companyName) => ({
    lane: { origin: 'A', destination: 'B' }, companyName, softClose: true, closesAt: MIDDAY + 3_600_000,
  });

  // GoComet: surfaced, never priced, never bid. Enquiry keys are alphanumeric on this portal.
  for (let i = 0; i < GC_SURFACED; i++) {
    await req(`gc-${i}`, {
      loadId: `2608${i}WAAR`, platformKey: 'gocomet',
      status: i < GC_SKIPPED ? 'skipped_no_price' : 'awaiting_price',
      load: load('Waaree Energies Ltd.'),
    });
  }

  // SuperProcure: a normal day - priced, bid, and settled.
  for (let i = 0; i < SP_SURFACED; i++) {
    const bid = i < SP_BID;
    await req(`sp-${i}`, {
      loadId: `${23900000 + i}`, platformKey: 'sp',
      status: bid ? 'closed' : 'skipped_no_price',
      capturedAt: bid ? MIDDAY + 600_000 : null,
      load: load('Havells India Ltd.'),
    });
    if (bid) {
      await store.putDoc(BIDLOG_COLLECTION, `${23900000 + i}`, {
        auctionId: `${23900000 + i}`, platformKey: 'sp', status: 'closed',
        won: i === 0, cost: 1000, lastBidPrice: 1120, finalRank: i === 0 ? 1 : 3,
        ourBids: [{ price: 1120, ts: MIDDAY + 900_000 }],
      });
    }
  }
}

function model() {
  const people = [
    { personId: 'g-waaree', name: 'BRL Bids . GC . Waaree', phone: '120363411977871374@g.us', enabled: true },
    { personId: 'g-havells', name: 'BRL Bids . Havells', phone: '120363431523383103@g.us', enabled: true },
  ];
  const customers = [
    { customerId: 'waaree', label: 'Waaree', aliases: ['Waaree', 'Waaree Energies Ltd.'], enabled: true },
    { customerId: 'havells', label: 'Havells', aliases: ['Havells', 'Havells India Ltd.'], enabled: true },
  ];
  const assignments = [
    { assignmentId: 'a1', personId: 'g-waaree', customerId: 'waaree', enabled: true },
    { assignmentId: 'a2', personId: 'g-havells', customerId: 'havells', enabled: true },
  ];
  const listStore = (a) => ({ list: async () => a });
  return {
    personStore: listStore(people), customerStore: listStore(customers), assignmentStore: listStore(assignments),
  };
}

function stubNotifier() {
  const sent = [];
  return { sent, sendDirect: async (to, message, meta) => { sent.push({ to, message, meta }); return { ok: true }; } };
}

// config.platformKey is present and is 'sp', exactly as production has it. The fix is that the EOD
// path no longer reads it - leaving it out of this fixture would hide a regression that starts
// reading it again.
const CONFIG = {
  platformKey: 'sp',
  eodReport: { enabled: true, timeIST: '20:00' },
  directorEod: { enabled: true, timeIST: '20:00', recipients: ['919000000001'] },
};

(async () => {
  const store = createStore({ backend: 'memory' });
  await seedDay(store);
  const requests = { listAll: async () => store.listDocs(PRICE_REQ_COLLECTION) };

  // ================================================================================
  // 1. The per-customer group EOD - the message that fired empty.
  // ================================================================================
  const notifier = stubNotifier();
  const res = await runEodReport(Object.assign({ store, requests, notifier, config: CONFIG, now: NOW }, model()));
  ok(res.sent === 2 && res.groups === 2, `both customer groups were reached, got ${res.sent}/${res.groups}`);

  const waaree = res.messages.find((m) => m.group === 'Waaree');
  const havells = res.messages.find((m) => m.group === 'Havells');
  ok(!!waaree && !!havells, 'both groups produced a message');

  ok(!/all quiet/.test(waaree.message),
    `THE DEFECT: the GoComet-only customer's report is not the quiet line -\n${waaree.message}`);
  ok(waaree.message.includes(`*Inquiries* - ${GC_SURFACED}`),
    `the Waaree report counts every surfaced GoComet load -\n${waaree.message}`);
  ok(waaree.message.includes(`*Missed cutoff* - ${GC_SKIPPED} of ${GC_SURFACED}`),
    `the missed-cutoff leak is named, which on a zero-bid day is the whole news -\n${waaree.message}`);
  ok(waaree.message.includes(`*Priced* - 0 of ${GC_SURFACED}`),
    `zero costs entered is reported as zero, never inflated -\n${waaree.message}`);

  // Zero bids must not fabricate an outcome. The outcomes and margin blocks are gated on
  // participation, so a surfaced-but-never-bid day says nothing about winning at all.
  ok(!/Won|still bidding|Margin/.test(waaree.message),
    `a day with no bids reports no outcomes and no margin -\n${waaree.message}`);

  // The SuperProcure group is the control: its numbers must not move because GoComet rows exist.
  ok(havells.message.includes(`*Inquiries* - ${SP_SURFACED}`)
    && havells.message.includes(`*Priced* - ${SP_BID} of ${SP_SURFACED}`),
  `the SuperProcure group's funnel is untouched by the GoComet rows -\n${havells.message}`);
  ok(havells.message.includes('*Won* - 1 of 4'),
    `the SuperProcure group's outcomes are untouched -\n${havells.message}`);
  ok(!/Waaree/.test(havells.message) && !/Havells/.test(waaree.message),
    'neither group can see the other customer - alias attribution still scopes the cohort');

  // ================================================================================
  // 2. The director DM - non-empty that evening, but short by a whole portal.
  // ================================================================================
  const dirNotifier = stubNotifier();
  const dirRes = await runDirectorEod(Object.assign(
    { store, requests, notifier: dirNotifier, config: CONFIG, now: NOW }, model(),
  ));
  ok(dirRes.sent === 1, `the director DM reached its recipient, got ${dirRes.sent}`);

  const dm = dirRes.message;
  ok(dm.includes(`${GC_SURFACED + SP_SURFACED} loads came in`),
    `participation counts every load we surfaced, both portals -\n${dm}`);
  ok(dm.includes(`we bid on ${SP_BID}`) && dm.includes(`*Participation: ${Math.round((SP_BID / (GC_SURFACED + SP_SURFACED)) * 100)}%*`),
    `the percentage divides by the real denominator - the pre-fix reading flattered it by dropping GoComet -\n${dm}`);
  // named re-pin: desk-scorecard-and-eod-labels, ruling 46 - the old "N loads went unpriced" leak
  // line this pinned is deleted outright by the scorecard build (see test-director-eod.js's locked-
  // skeleton reversal). The scorecard's OWN leak line - "Nobody priced" - carries the same fact this
  // pin cares about (the GoComet-only customer is the offender), now cross-portal AND named per
  // group rather than folded into one shipper-name heuristic.
  ok(dm.includes('Nobody priced: Waaree 8') && dm.includes('no owner set for Waaree'),
    `the scorecard's Nobody-priced line names the GoComet-only customer as the offender -\n${dm}`);

  assert.strictEqual(fail, 0, `${fail} checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
