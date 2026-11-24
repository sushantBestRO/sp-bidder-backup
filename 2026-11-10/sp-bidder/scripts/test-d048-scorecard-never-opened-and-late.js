'use strict';
/**
 * D048/D026: the desk scorecard must distinguish an unpriced ask that was NEVER OPENED (the
 * price-capture link was never clicked - a desk capacity/coverage question) from one that was
 * OPENED LATE (past the pricing deadline - a genuinely slow desk) - merging both into one
 * "unpriced" bucket points whoever reads it at the wrong fix, per the 2026-09-24 audit (930 of
 * 1,214 unpriced asks split mostly never-opened, only 2% genuinely late).
 *
 * Regression target: D048. collectScorecard's rows carried only asks/priced/bid, with no
 * never-opened or opened-late category, at the time this was written.
 *
 * BLOCKING fix (coordinator review of 99c4bd0): the first cut's "never opened" was just
 * `r.openedAt == null`, which wrongly counted (a) a PRICED ask (engaged with regardless of the
 * open signal), (b) an ask still BEFORE its own deadline (nothing to report yet), and (c) an ask
 * created BEFORE page-open tracking (D026) went live, whose missing openedAt is a structural gap,
 * not a desk failure. All three exclusions are pinned below, plus the go-live marker's own
 * persistence (it must survive a restart, not re-derive "now" on every call).
 *
 * @requires-summary-line
 *   node scripts/test-d048-scorecard-never-opened-and-late.js
 */
const assert = require('assert');
const { renderDirectorEod, collectScorecard, ensureOpenTrackingGoLive, OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY } = require('../src/notify/directorEod');
const { resolveGroups } = require('../src/notify/eodReport');
const { istMidnight } = require('../src/notify/dailyTask');
const { MemoryStore } = require('../src/store');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

const MIN = 60000;
const NOW = Date.UTC(2026, 6, 16, 14, 40); // 20:10 IST, Thu 16 Jul 2026
const DAY_START = istMidnight(NOW);

const modelStores = ({ people = [], customers = [], assignments = [] }) => ({
  personStore: { list: async () => people },
  customerStore: { list: async () => customers },
  assignmentStore: { list: async () => assignments },
});
function fakeRequests(docs) { return { listAll: async () => docs }; }

(async () => {
  const people = [{ personId: 'g1', name: 'Havells BRL group', phone: '111@g.us', enabled: true }];
  const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'], enabled: true }];
  const assignments = [{ assignmentId: 'g1::havells', personId: 'g1', customerId: 'havells', enabled: true, owner: true }];
  const groups = await resolveGroups(modelStores({ people, customers, assignments }));

  // --- ensureOpenTrackingGoLive: persists on first call, survives a "restart" (a fresh call with
  // a different `now` must still return the FIRST-recorded moment, never re-derive it).
  {
    const store = new MemoryStore();
    const first = await ensureOpenTrackingGoLive(store, DAY_START + 3 * MIN);
    ok(first === DAY_START + 3 * MIN, `the first call records the go-live moment (got ${first})`);
    const second = await ensureOpenTrackingGoLive(store, DAY_START + 999 * MIN);
    ok(second === first, `a later call (simulating a restart) returns the SAME persisted moment, not a fresh now (got ${second})`);
    const raw = await store.getDoc(OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY);
    ok(raw && raw.at === first, `the marker is durably persisted under ${OPEN_TRACKING_COLLECTION}/${OPEN_TRACKING_KEY} (got ${JSON.stringify(raw)})`);
  }

  // --- the three exclusions, in one scorecard pass.
  const GOLIVE = DAY_START + 3 * MIN;
  const store = new MemoryStore();
  await store.putDoc(OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY, { at: GOLIVE });
  const PAST_DEADLINE = DAY_START + 10 * MIN; // well before NOW (DAY_START + 40 MIN)
  const reqs = [
    // H1: never opened, unpriced, past deadline, created AFTER go-live - the one genuine case.
    { loadId: 'H1', createdAt: DAY_START + 4 * MIN, capturedAt: null, openedAt: null, deadlineAt: PAST_DEADLINE,
      status: 'awaiting_price', load: { companyName: 'Havells', closesAt: NOW + 3600000 } },
    // H2: PRICED, but openedAt is still null (e.g. a capture path that never hit the GET route) -
    // must NOT count as never-opened; it was engaged with.
    { loadId: 'H2', createdAt: DAY_START + 5 * MIN, capturedAt: DAY_START + 6 * MIN, openedAt: null, deadlineAt: PAST_DEADLINE,
      status: 'closed', load: { companyName: 'Havells', closesAt: NOW - 3600000 } },
    // H3: opened AFTER its deadline - genuinely late (unaffected pin, kept from the first cut).
    { loadId: 'H3', createdAt: DAY_START + 6 * MIN, capturedAt: null, openedAt: PAST_DEADLINE + 5 * MIN, deadlineAt: PAST_DEADLINE,
      status: 'awaiting_price', load: { companyName: 'Havells', closesAt: NOW + 3600000 } },
    // H4: never opened, unpriced, but its OWN deadline has not passed yet - must NOT count.
    { loadId: 'H4', createdAt: DAY_START + 7 * MIN, capturedAt: null, openedAt: null, deadlineAt: NOW + 60 * MIN,
      status: 'awaiting_price', load: { companyName: 'Havells', closesAt: NOW + 3600000 } },
    // H5: never opened, unpriced, past deadline - but created BEFORE go-live (pre-deploy ask).
    // The missing openedAt is structural (the feature did not exist), not a desk failure.
    { loadId: 'H5', createdAt: DAY_START + 1 * MIN, capturedAt: null, openedAt: null, deadlineAt: PAST_DEADLINE,
      status: 'awaiting_price', load: { companyName: 'Havells', closesAt: NOW + 3600000 } },
  ];

  const sc = await collectScorecard({ requests: fakeRequests(reqs), store, groups, now: NOW });
  const row = sc.rows.find((r) => r.personId === 'g1');
  ok(row && row.asks === 5, `setup sanity: all five loads land under the Havells group (${JSON.stringify(row)})`);
  ok(row.neverOpened === 1, `exactly one load (H1) counts as never-opened - H2 (priced), H4 (before deadline) and H5 (pre-deploy) are all excluded (got ${row.neverOpened})`);
  ok(row.openedLate === 1, `exactly one load (H3) was opened past its deadline (got ${row.openedLate})`);

  const day = { surfaced: 5, priced: 1, bid: 0, scorecard: sc };
  const msg = renderDirectorEod(day, NOW);
  ok(/Never opened: Havells 1/.test(msg), `the message names the never-opened count (message:\n${msg}\n)`);
  ok(/Opened late: Havells 1/.test(msg), `the message names the opened-late count (message:\n${msg}\n)`);

  // Control: a quiet scorecard (nothing never-opened or late) renders neither line.
  const quietStore = new MemoryStore();
  await quietStore.putDoc(OPEN_TRACKING_COLLECTION, OPEN_TRACKING_KEY, { at: GOLIVE });
  const quietReqs = [
    { loadId: 'Q1', createdAt: DAY_START + 4 * MIN, capturedAt: DAY_START + 5 * MIN, openedAt: DAY_START + 5 * MIN, deadlineAt: PAST_DEADLINE,
      status: 'awaiting_price', load: { companyName: 'Havells', closesAt: NOW + 3600000 } },
  ];
  const quietSc = await collectScorecard({ requests: fakeRequests(quietReqs), store: quietStore, groups, now: NOW });
  const quietMsg = renderDirectorEod({ surfaced: 1, priced: 1, bid: 0, scorecard: quietSc }, NOW);
  ok(!quietMsg.includes('Never opened') && !quietMsg.includes('Opened late'), 'control: a clean day renders neither new line');

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
