'use strict';
/**
 * The morning-after heartbeat for 2026-08-12, reconstructed end to end.
 *
 * 12 Aug was GoComet's first full production day. The evening's two EOD reports were wrong by a
 * whole portal and were fixed the same night (#200); the heartbeat that reports that day had not
 * fired yet - it goes at 08:00 IST on 13 Aug - and it carried the identical defect from the
 * identical cause: collectFunnel and collectToday filtered their cohort to a single platformKey and
 * collectHeartbeat passed config.platformKey, which is 'sp' and is set nowhere.
 *
 * The counts below are the real ones, read off a read-only snapshot of the production store taken
 * that evening, so this file is the day rather than a shape resembling it. Left scoped, the
 * director's 13 Aug message would have opened "New loads found - 201" on a day the desk was shown
 * 275, and "Missed the pricing cutoff - 118" when 175 loads went unpriced.
 *
 * The ACCOUNTS section is the deliberate counter-case and is pinned here too: it stays
 * SuperProcure-scoped, because it compares live stacks against an SP-only roster and says
 * "SuperProcure account" in the rendered text. server.js hands the heartbeat the whole `stacks`
 * array, GoComet's stack included, so a well-meaning "make it consistent" edit would put a second
 * portal's branch count into an SP total and its token date in front of the director as an SP login
 * about to lapse. Sections 3 and 4 fail if that happens.
 *
 * Driven through runHeartbeat, not just the collectors, because the defect lived as much in what
 * the caller passed as in what the collectors did with it. The notifier is a stub that records -
 * this file must never reach a real send path, and the heartbeat goes to real people.
 *
 *   node scripts/test-heartbeat-gocomet-day.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { COLLECTION: PRICE_REQ_COLLECTION } = require('../src/pricing/priceRequests');
const { COLLECTION: BIDLOG_COLLECTION } = require('../src/logging/bidLogger');
const { runHeartbeat, istDisplayDate } = require('../src/notify/heartbeat');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The runner grades by exit code alone, so a file that returns early scores a silent green.
const EXPECTED_CHECKS = 16;

const DAY_MS = 86_400_000;
// 08:00 IST, Thu 13 Aug 2026 - the heartbeat slot. Its funnel window is the IST day just ended,
// [00:00 IST 12 Aug, 00:00 IST 13 Aug).
const NOW = Date.UTC(2026, 7, 13, 2, 30);
const YEST_MID = Date.UTC(2026, 7, 11, 18, 30);   // 00:00 IST, 12 Aug
const MIDDAY = YEST_MID + 10 * 3_600_000;         // 10:00 IST, 12 Aug - inside the window
const TODAY_EARLY = Date.UTC(2026, 7, 12, 20, 30); // 02:00 IST, 13 Aug - AFTER the window closed

// --- the real 12 Aug figures, per portal (production snapshot, IST calendar day) ---
const SP_SURFACED = 201, SP_PRICED = 78, SP_MISSED = 118, SP_AWAITING = 5;
const SP_BIDS = 276, SP_LOADS_BID = 78, SP_REJECTED = 509, SP_WON = 15, SP_LOST = 62;
const GC_SURFACED = 74, GC_PRICED = 4, GC_MISSED = 57, GC_AWAITING = 13;
const GC_BIDS = 4, GC_LOADS_BID = 4;

const ALL_SURFACED = SP_SURFACED + GC_SURFACED;   // 275
const ALL_PRICED = SP_PRICED + GC_PRICED;         // 82
const ALL_MISSED = SP_MISSED + GC_MISSED;         // 175
const ALL_BIDS = SP_BIDS + GC_BIDS;               // 280
const ALL_LOADS_BID = SP_LOADS_BID + GC_LOADS_BID; // 82
const ALL_AWAITING = SP_AWAITING + GC_AWAITING;   // 18
const ARMED_TODAY = 5;                            // 3 SP + 2 GoComet, armed overnight for today

// A run of `n` bid timestamps inside the window, so bidsPlaced counts events and loadsBid counts
// records - the two numbers the rendered line reports separately.
const bids = (n, base) => Array.from({ length: n }, (_, i) => ({ price: 1000 + i, ts: base + i * 1000 }));

async function seedDay(store) {
  const req = (id, over) => store.putDoc(PRICE_REQ_COLLECTION, id, Object.assign({
    id, marginsPct: [10], minMarginPct: 5, marginSource: 'default', price: null, capturedAt: null,
    createdAt: MIDDAY,
  }, over));
  const load = (companyName, closesAt) => ({
    lane: { origin: 'A', destination: 'B' }, companyName, closesAt,
  });

  // ---- SuperProcure: a normal heavy day ----
  for (let i = 0; i < SP_SURFACED; i++) {
    const priced = i < SP_PRICED;
    const missed = !priced && i < SP_PRICED + SP_MISSED;
    await req(`sp-${i}`, {
      loadId: `${23900000 + i}`, platformKey: 'sp',
      status: priced ? 'closed' : (missed ? 'skipped_no_price' : 'awaiting_price'),
      capturedAt: priced ? MIDDAY + 600_000 : null,
      load: load('Havells India Ltd.', MIDDAY + 3_600_000),
    });
  }
  // 276 bids over 78 loads, 509 rejections, and 77 of the 78 settled inside the window.
  for (let i = 0; i < SP_LOADS_BID; i++) {
    const nBids = i < (SP_BIDS - SP_LOADS_BID * 3) ? 4 : 3;
    const nRej = i < (SP_REJECTED - SP_LOADS_BID * 6) ? 7 : 6;
    const settled = i < SP_WON + SP_LOST;
    await store.putDoc(BIDLOG_COLLECTION, `${23900000 + i}`, {
      auctionId: `${23900000 + i}`, platformKey: 'sp',
      status: settled ? 'closed' : 'live',
      closedAt: settled ? MIDDAY + 2_400_000 : null,
      won: settled ? i < SP_WON : null,
      cost: 1000, lastBidPrice: 1120, finalRank: 3,
      ourBids: bids(nBids, MIDDAY + 900_000),
      rejectedBids: bids(nRej, MIDDAY + 800_000),
    });
  }

  // ---- GoComet: surfaced heavily, priced almost nothing, four bids, nothing settled ----
  for (let i = 0; i < GC_SURFACED; i++) {
    const priced = i < GC_PRICED;
    const missed = !priced && i < GC_PRICED + GC_MISSED;
    await req(`gc-${i}`, {
      loadId: `2608${i}WAAR`, platformKey: 'gocomet',
      status: priced ? 'armed' : (missed ? 'skipped_no_price' : 'awaiting_price'),
      capturedAt: priced ? MIDDAY + 700_000 : null,
      load: load('Waaree Energies Ltd.', MIDDAY + 3_600_000),
    });
  }
  for (let i = 0; i < GC_LOADS_BID; i++) {
    await store.putDoc(BIDLOG_COLLECTION, `2608${i}WAAR`, {
      auctionId: `2608${i}WAAR`, platformKey: 'gocomet', status: 'live', closedAt: null, won: null,
      cost: 4000, lastBidPrice: 4400, finalRank: null,
      ourBids: bids(1, MIDDAY + 1_000_000), rejectedBids: [],
    });
  }

  // ---- armed overnight, AFTER the funnel window closed: the Today section's material ----
  for (let i = 0; i < ARMED_TODAY; i++) {
    await req(`armed-${i}`, {
      loadId: `armed-${i}`, platformKey: i < 3 ? 'sp' : 'gocomet', status: 'armed',
      createdAt: TODAY_EARLY, capturedAt: TODAY_EARLY + 60_000,
      load: load(i < 3 ? 'Havells India Ltd.' : 'Waaree Energies Ltd.', NOW + 6 * 3_600_000),
    });
  }
}

// Two live stacks in ONE array, exactly as server.js holds them: the SuperProcure account and the
// GoComet stack pushed alongside it. The GoComet token is the near one deliberately - if the
// accounts section ever stops scoping, it becomes an "SP login expires in 5 days" line.
const SP_BRANCHES = 12;
const stacks = () => [
  {
    account: { accountId: 'master', label: 'Best Roadways (Master)' },
    adapter: { account: { branchIds: Array.from({ length: SP_BRANCHES }, (_, i) => i + 1), tokenExp: NOW + 200 * DAY_MS } },
  },
  {
    platformKey: 'gocomet',
    account: { accountId: 'gocomet', label: 'GoComet' },
    adapter: { account: { branchIds: [901, 902, 903], tokenExp: NOW + 5 * DAY_MS } },
  },
];

function stubNotifier() {
  const sent = [];
  return { sent, sendDirect: async (to, message, meta) => { sent.push({ to, message, meta }); return { ok: true }; } };
}

// config.platformKey is present and is 'sp', exactly as production has it. The fix is that the
// funnel and today sections no longer read it - leaving it out of this fixture would hide a
// regression that starts reading it again.
const CONFIG = {
  platformKey: 'sp',
  notifyMode: 'whatsapp',
  heartbeat: { enabled: true, timeIST: '08:00', recipients: ['919000000001'] },
};

(async () => {
  const store = createStore({ backend: 'memory' });
  await seedDay(store);
  const requests = { listAll: async () => store.listDocs(PRICE_REQ_COLLECTION) };
  const notifier = stubNotifier();

  const res = await runHeartbeat({
    stacks: stacks(), store, requests, notifier, config: CONFIG, now: NOW,
    personStore: { get: async () => null, list: async () => [] },
  });
  const msg = res.message;

  // ================================================================================
  // 1. It was sent, once, through the stub - never a live path.
  // ================================================================================
  ok(res.sent === 1 && res.recipients === 1, `the heartbeat reached its one recipient, got ${res.sent}/${res.recipients}`);
  ok(notifier.sent.length === 1 && notifier.sent[0].meta.kind === 'heartbeat',
    'exactly one heartbeat DM was handed to the notifier');

  // ================================================================================
  // 2. Yesterday's funnel counts BOTH portals - the defect, line by line.
  // ================================================================================
  ok(msg.includes(`*Yesterday (${istDisplayDate(NOW - DAY_MS)})*`),
    `the funnel is reported against 12 Aug -\n${msg}`);
  ok(msg.includes(`- New loads found - ${ALL_SURFACED}`),
    `THE DEFECT: every surfaced load is counted, not just SuperProcure's ${SP_SURFACED} -\n${msg}`);
  ok(msg.includes(`- Priced in time - ${ALL_PRICED}`),
    `the priced count includes the ${GC_PRICED} GoComet loads the desk did price -\n${msg}`);
  ok(msg.includes(`- Missed the pricing cutoff - ${ALL_MISSED}`),
    `the missed-cutoff leak is the whole news on a day like this, and ${GC_MISSED} of it was GoComet's -\n${msg}`);
  ok(msg.includes(`- Bids placed - ${ALL_BIDS} (on ${ALL_LOADS_BID} loads)`),
    `the closedBids side is all-portal too - it iterates records, so a cohort-only fix would miss it -\n${msg}`);
  ok(msg.includes(`- Rejected by the portal - ${SP_REJECTED} (being looked into)`),
    `rejections are summed across portals (GoComet had none on 12 Aug) -\n${msg}`);
  ok(msg.includes(`- Won ${SP_WON}, lost ${SP_LOST}`),
    `outcomes are all-portal; GoComet settled nothing that day, so the totals are SP's -\n${msg}`);

  // ================================================================================
  // 3. Today counts both portals - the "still waiting for a price" line is the one the
  //    reader acts on, and a scoped read tells the desk its worklist is empty while a
  //    GoComet price link sits open.
  // ================================================================================
  ok(msg.includes(`${ARMED_TODAY} auctions armed and ready`),
    `both portals' armed loads are counted -\n${msg}`);
  ok(msg.includes(`${ALL_AWAITING} loads still waiting for a price`),
    `the actionable waiting count spans portals (${GC_AWAITING} of them GoComet's) -\n${msg}`);

  // ================================================================================
  // 4. ACCOUNTS stays SuperProcure-scoped - the deliberate counter-case.
  // ================================================================================
  ok(msg.includes(`*Accounts* - connected, ${SP_BRANCHES} branches`),
    `the branch total is SuperProcure's ${SP_BRANCHES}, not ${SP_BRANCHES + 3} with GoComet's folded in -\n${msg}`);
  ok(!/expires in \d+ days?/.test(msg),
    `GoComet's 5-day token is not reported as a SuperProcure login about to lapse -\n${msg}`);
  ok(!/could not log in/.test(msg),
    `the GoComet stack is not counted against the SuperProcure expected-vs-live check -\n${msg}`);

  // ================================================================================
  // 5. The verdict line. Nothing here is an incident, so a day with a whole portal's
  //    worth of missed cutoffs must still read normal - the funnel reports it, the
  //    verdict does not invent an alarm out of it.
  // ================================================================================
  ok(/^\S+ \*Bid Command: all systems normal\*/.test(msg.split('\n')[0]),
    `the verdict is the all-normal line - the funnel numbers are reporting, not alarming -\n${msg}`);
  ok(!/Waaree|Havells|gocomet|SuperProcure account/.test(msg.split('*Yesterday')[1] || ''),
    'the funnel section names no portal and no customer - it is one desk-wide count');

  assert.strictEqual(fail, 0, `${fail} checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
