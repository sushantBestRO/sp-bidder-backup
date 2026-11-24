'use strict';
/**
 * Red pin: the desk scorecard (CW-240, ruling 46 - "rides PR-2 as a recorded free concession").
 * `directorEod.js` sends a participation DM with no per-group asked/priced/bid breakdown, no
 * "nobody priced" flag and no unrouted count - `collectScorecard` does not exist yet.
 *
 * Exercises, per the audit's own "Tests" list plus rider 2's warranty count:
 *   1. a branch-scoped group's load counts ONCE, under the branch group (applyBranchPrecedence),
 *      never doubled into the customer's general group too.
 *   2. an unrouted load (matches a customer's alias, no group's own scope covers it) counts under
 *      "not sent", never under any customer's row.
 *   3. a zero-priced group is named on a "Nobody priced" line, with "(no owner set)" only for a
 *      group with no enabled owner assignment.
 *   4. no rendered line contains "won" or "win", even though the underlying day DID have a win -
 *      ruling 46's "no win count, no win rate, no won value anywhere".
 *   5. the no-schedule per-shipper count (ruling 46's Cords/no-schedule warranty line, discovery.js's
 *      durable noScheduleLoads collection) reaches this same EOD, one line per shipper that has any,
 *      no line at all when there are none.
 *
 *   node scripts/test-desk-scorecard-per-group-counts-and-not-sent.js
 */
const {
  collectDirectorDay, renderDirectorEod, collectScorecard,
} = require('../src/notify/directorEod');
const { resolveGroups } = require('../src/notify/eodReport');
const { NO_SCHEDULE_COLLECTION } = require('../src/discovery/discovery');
const { MemoryStore } = require('../src/store');
const { istMidnight } = require('../src/notify/dailyTask');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const MIN = 60000;
const NOW = Date.UTC(2026, 6, 16, 14, 40); // 20:10 IST, Thu 16 Jul 2026
const DAY_START = istMidnight(NOW);

const modelStores = ({ people = [], customers = [], assignments = [] }) => ({
  personStore: { list: async () => people },
  customerStore: { list: async () => customers },
  assignmentStore: { list: async () => assignments },
});

function fakeRequests(docs) { return { listAll: async () => docs }; }

async function scenario() {
  const store = new MemoryStore();

  const people = [
    { personId: 'g1', name: 'Havells BRL group', phone: '111@g.us', enabled: true },
    { personId: 'g2', name: 'Havells Alwar BRL group', phone: '222@g.us', enabled: true, branchScope: ['1350'] },
    { personId: 'g3', name: 'KEI BRL group', phone: '333@g.us', enabled: true, originScope: ['Pune'] },
  ];
  const customers = [
    { customerId: 'havells', label: 'Havells', aliases: ['Havells'], enabled: true },
    { customerId: 'kei', label: 'KEI', aliases: ['KEI'], enabled: true },
  ];
  const assignments = [
    { assignmentId: 'g1::havells', personId: 'g1', customerId: 'havells', enabled: true, owner: true },
    { assignmentId: 'g2::havells', personId: 'g2', customerId: 'havells', enabled: true },
    { assignmentId: 'g3::kei', personId: 'g3', customerId: 'kei', enabled: true },
  ];
  const groups = await resolveGroups(modelStores({ people, customers, assignments }));

  const reqs = [
    // H1: Havells, no branch -> g1 (general) only. Priced + bid + WON (proves "no win" language
    // still holds even when the underlying day genuinely has a win).
    { loadId: 'H1', createdAt: DAY_START + 1 * MIN, capturedAt: DAY_START + 2 * MIN, status: 'closed', load: { companyName: 'Havells', closesAt: NOW - 3600000 } },
    // H2: Havells, Alwar branch -> matches BOTH g1 and g2; precedence must drop g1, count ONCE
    // under g2 (Alwar), never under g1 too.
    { loadId: 'H2', createdAt: DAY_START + 3 * MIN, capturedAt: DAY_START + 4 * MIN, status: 'closed', load: { companyName: 'Havells', branchName: 'Alwar Cable (1350)', closesAt: NOW - 3000000 } },
    // K1: KEI, Pune origin -> matches g3 (its own scope). Never priced -> feeds "Nobody priced",
    // and g3 has no owner assignment -> "(no owner set for KEI)".
    { loadId: 'K1', createdAt: DAY_START + 5 * MIN, capturedAt: null, status: 'awaiting_price', load: { companyName: 'KEI', lane: { origin: 'Pune' }, closesAt: NOW + 3600000 } },
    // K2: KEI, Chennai origin -> matches the CUSTOMER (KEI) but no group's own scope (g3 is
    // Pune-only) -> unrouted, must land under "not sent", never under KEI's row.
    { loadId: 'K2', createdAt: DAY_START + 6 * MIN, capturedAt: null, status: 'awaiting_price', load: { companyName: 'KEI', lane: { origin: 'Chennai' }, closesAt: NOW + 3600000 } },
  ];
  await store.putDoc('closedBids', 'H1', {
    auctionId: 'H1', status: 'closed', won: true, cost: 10000, lastBidPrice: 11000,
    ourBids: [{ price: 11000, ts: DAY_START + 10 * MIN }],
  });
  await store.putDoc('closedBids', 'H2', {
    auctionId: 'H2', status: 'closed', won: false, cost: 10000, lastBidPrice: 10500,
    ourBids: [{ price: 10500, ts: DAY_START + 10 * MIN }],
  });

  return { store, reqs, customers, groups };
}

(async () => {
  const { store, reqs, customers, groups } = await scenario();
  const day = await collectDirectorDay({ requests: fakeRequests(reqs), store, customers, now: NOW });
  ok(day.won === 1, 'setup sanity: the day genuinely has a win (H1)');

  const sc = await collectScorecard({ requests: fakeRequests(reqs), store, groups, now: NOW });

  const havellsGeneral = sc.rows.find((r) => r.personId === 'g1');
  const havellsAlwar = sc.rows.find((r) => r.personId === 'g2');
  ok(havellsGeneral && havellsGeneral.asks === 1, `H1 counts once under the general Havells group (${JSON.stringify(havellsGeneral)})`);
  ok(havellsAlwar && havellsAlwar.asks === 1, `H2 counts once under Alwar - branch precedence wins (${JSON.stringify(havellsAlwar)})`);

  const kei = sc.rows.find((r) => r.personId === 'g3');
  ok(kei && kei.asks === 1 && kei.priced === 0, `K1 counts under KEI's own (Pune-scoped) group, unpriced (${JSON.stringify(kei)})`);
  ok(kei && kei.asks === 1, "K2 (Chennai) is NOT folded into KEI's row - only K1 counts there");

  ok(sc.notSent.length === 1 && sc.notSent[0].loadId === 'K2',
    `K2 lands under "not sent" (matches the customer, no group's own scope covers it) - got ${JSON.stringify(sc.notSent)}`);

  day.scorecard = sc;
  const msg = renderDirectorEod(day, NOW);

  ok(msg.includes('Havells: 1 / 1 / 1'), `the general Havells row renders asked/priced/bid (message:\n${msg}\n)`);
  ok(msg.includes('Havells (1350): 1 / 1 / 1'), 'the branch-scoped Alwar row renders separately from the general Havells row');
  ok(msg.includes('Nobody priced'), 'a zero-priced group is named on the Nobody-priced line');
  ok(/KEI 1/.test(msg) && msg.includes('no owner set for KEI'),
    `KEI is named with its count and flagged ownerless (message:\n${msg}\n)`);
  ok(msg.includes('Not sent to any group: 1 load'), 'the unrouted K2 is counted under "not sent", never under KEI');
  ok(!/\bwon\b/i.test(msg) && !/\bwin\b/i.test(msg),
    `no rendered line contains "won" or "win" even though the day has a real win (ruling 46) - message:\n${msg}`);

  // No-schedule per-shipper count (rider 2) reaches this same EOD.
  await store.putDoc(NO_SCHEDULE_COLLECTION, 'C1', { loadId: 'C1', shipper: 'Cords Cable Industries Ltd', firstSeenAt: NOW });
  await store.putDoc(NO_SCHEDULE_COLLECTION, 'C2', { loadId: 'C2', shipper: 'Cords Cable Industries Ltd', firstSeenAt: NOW });
  const scWithSchedule = await collectScorecard({ requests: fakeRequests(reqs), store, groups, now: NOW });
  day.scorecard = scWithSchedule;
  const msgWithSchedule = renderDirectorEod(day, NOW);
  ok(/Cords Cable Industries Ltd 2/.test(msgWithSchedule),
    `the no-schedule count reaches the desk EOD, one line per shipper that has any (message:\n${msgWithSchedule}\n)`);

  // And no line at all when there are none.
  ok(!msg.includes('No fixed close time'), 'no no-schedule line at all when nothing was noticed');

  console.log(`\ntest-desk-scorecard-per-group-counts-and-not-sent: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test-desk-scorecard-per-group-counts-and-not-sent: FATAL', e);
  process.exit(1);
});
