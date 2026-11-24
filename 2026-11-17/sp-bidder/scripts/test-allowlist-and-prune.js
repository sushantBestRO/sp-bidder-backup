'use strict';
/**
 * Regression for three correctness bugs in delivered Module-1 discovery/pricing behaviour,
 * all confirmed live on 2026-07-14 (deterministic, offline: memory store + fake adapter, no
 * network, never bids):
 *
 *   Bug 1 - dropOutOfScope did not clean the worklist after an allowlist change. The reconcile
 *           calls matchesAllowlist; under the old empty-list=match-all default an out-of-scope
 *           awaiting request always "matched", so it was never dropped (had to be cleaned by
 *           hand). Shares a root cause with Bug 3.
 *   Bug 2 - expireOverdue could never reach an SP year-2100 placeholder deadline (biddingOn:0
 *           loads carry a shared far-future close time instead of null), so the row sat
 *           awaiting_price forever (39 hand-deleted). Needs a plausibility bound.
 *   Bug 3 - matchesAllowlist treated `shippers: []` as "no filter -> match every shipper",
 *           which flooded the pricing team with unbiddable loads. Must fail closed.
 *
 *   node scripts/test-allowlist-and-prune.js
 */
const { createStore } = require('../src/store');
const { PriceRequestStore, COLLECTION, MAX_PLAUSIBLE_DEADLINE_MS } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');
const { resolveTargets } = require('../src/model/resolve');
const { MAX_PLAUSIBLE_DEADLINE_MS: ADAPTER_MAX_PLAUSIBLE_DEADLINE_MS } = require('../src/platform/realAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const MIN = 5, MARGINS = [10];
const notifier = () => new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });

// Seed one awaiting_price request directly, for precise control over shipper/account/deadline.
const seedAwaiting = (store, id, companyName, { account = null, closesAt, deadlineAt } = {}) =>
  store.putDoc(COLLECTION, id, {
    id, loadId: id, status: 'awaiting_price', account,
    load: { companyName, lane: { origin: 'A', destination: 'B' }, softClose: false, closeModelKnown: true, closesAt },
    deadlineAt, price: null, capturedAt: null, createdAt: Date.now(),
  });

(async () => {
  const now = Date.now();
  const future = now + 10 * 60_000; // 10 min out

  // ============================ shared-constant pin (PR #34 r1 Finding 1) ====================
  // The Bug-2 guarantee below ("a legit ~30d-out deadline is kept") depends on priceRequests.js's
  // plausibility bound being the EXACT SAME window realAdapter's boundedParse uses at load-map
  // time - both now import src/platform/realAdapter.js's MAX_PLAUSIBLE_DEADLINE_MS rather than
  // each declaring their own literal, so this pins that the wiring didn't drift back apart.
  ok(MAX_PLAUSIBLE_DEADLINE_MS === ADAPTER_MAX_PLAUSIBLE_DEADLINE_MS,
    'priceRequests.js and realAdapter.js share the identical MAX_PLAUSIBLE_DEADLINE_MS constant (no hand-synced duplicate)');

  // ============================ Bug 3: matchesAllowlist fails closed on empty =================
  {
    const empty = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: { shippers: [] } } });
    ok(empty.matchesAllowlist({ companyName: 'Some Random Shipper Ltd', lane: {} }) === false,
      'empty shipper allowlist matches NOTHING (fail closed) - was match-all');
    const absent = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: {} } });
    ok(absent.matchesAllowlist({ companyName: 'Anything', lane: {} }) === false,
      'absent shipper key also matches NOTHING (fail closed)');

    const listed = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: { shippers: ['Syngenta'] } } });
    ok(listed.matchesAllowlist({ companyName: 'Syngenta India Pvt Ltd', lane: {} }) === true,
      'a listed shipper still matches (word-prefix)');
    ok(listed.matchesAllowlist({ companyName: 'Havells', lane: {} }) === false,
      'an unlisted shipper is excluded');

    const none = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: { shippers: ['__none__'] } } });
    ok(none.matchesAllowlist({ companyName: 'Havells', lane: {} }) === false,
      '["__none__"] sentinel (non-empty, no real match) = bid nothing, the explicit opt-out');

    // create-path: an empty allowlist must create ZERO price requests (the flood fix)
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const liveLoad = { id: 'F1', lane: { origin: 'A', destination: 'B' }, companyName: 'Random Co', closesAt: future, startsAt: now - 1000, status: 'live', softClose: false, closeModelKnown: true };
    const floodPoller = new DiscoveryPoller({ adapter: { listAuctions: async () => [liveLoad] }, requests: rq, notifier: notifier(), config: { allowlist: { shippers: [] }, priceDeadlineLeadMs: 90_000 } });
    const fr = await floodPoller.tick();
    ok(fr.created === 0, `empty allowlist creates 0 price requests (no flood), got ${fr.created}`);
    ok(!(await rq.getByLoad('F1')), 'the unbiddable load did NOT get a price request');
  }

  // ==== Bug 3 contract: resolveTargets (the PRODUCTION allowlist source) agrees with matchesAllowlist
  //      on an empty base. matchesAllowlist and resolveTargets both had "empty = match-all"; fixing
  //      only the matcher would make an account that scopes purely through the customer/assignment
  //      model silently bid NOTHING. They must agree: empty base + assignments = bid exactly the
  //      assigned customers; empty base + no assignments = bid nothing. ====
  {
    const customers = [{ customerId: 'havells', enabled: true, aliases: ['Havells India Ltd', 'Havells'] }];
    const people = [{ personId: 'p1', enabled: true, accountId: 'master' }];
    const assignments = [{ assignmentId: 'a1', enabled: true, personId: 'p1', customerId: 'havells' }];
    const targets = resolveTargets({ account: { accountId: 'master' }, customers, people, assignments, fallbackAllowlist: { shippers: [], lanes: [], hardCloseOnly: false } });
    const poller = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: targets } });
    ok(poller.matchesAllowlist({ companyName: 'Havells India Ltd', lane: {} }) === true,
      'empty base + assignment: the assigned customer IS bid (resolveTargets unions it; contract agrees)');
    ok(poller.matchesAllowlist({ companyName: 'Some Unassigned Shipper', lane: {} }) === false,
      'empty base + assignment: a non-assigned shipper is NOT bid (not match-all)');
    const empty = resolveTargets({ account: { accountId: 'lonely' }, customers: [], people: [], assignments: [], fallbackAllowlist: { shippers: [], lanes: [], hardCloseOnly: false } });
    const p2 = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {}, config: { allowlist: empty } });
    ok(p2.matchesAllowlist({ companyName: 'Anything', lane: {} }) === false,
      'empty base + no assignments: bids nothing (fail closed, no silent match-all)');
  }

  // ============================ Bug 1: dropOutOfScope cleans the worklist =====================
  {
    // (a) The incident: an account whose allowlist ended up [] had stale awaiting requests that
    //     the reconcile never dropped (match-all). With fail-closed matching, the tick drops it.
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const acct = { accountId: 'master', label: 'Master' };
    await seedAwaiting(s, 'stale', 'Havells', { account: acct, closesAt: future, deadlineAt: future - 90_000 });
    const poller = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq, notifier: notifier(), config: { allowlist: { shippers: [] }, priceDeadlineLeadMs: 90_000 }, account: acct });
    const r = await poller.tick();
    ok(r.dropped === 1, `empty-allowlist account: stale awaiting request is reconciled away, got dropped=${r.dropped}`);
    ok(!(await rq.getByToken('stale')), 'worklist cleaned: the out-of-scope awaiting request was removed');

    // (b) Narrowing a non-empty allowlist drops the now-excluded shipper, keeps the in-scope one.
    const s2 = createStore({ backend: 'memory' });
    const rq2 = new PriceRequestStore({ store: s2, marginsPct: MARGINS, minMarginPct: MIN });
    await seedAwaiting(s2, 'ren', 'Renewsys', { closesAt: future, deadlineAt: future - 90_000 });
    await seedAwaiting(s2, 'syn', 'Syngenta', { closesAt: future, deadlineAt: future - 90_000 });
    const cfg = { allowlist: { shippers: ['Syngenta', 'Renewsys'] }, priceDeadlineLeadMs: 90_000 };
    const disc = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq2, notifier: notifier(), config: cfg });
    cfg.allowlist.shippers = ['Syngenta']; // operator narrows: Renewsys removed
    const r2 = await disc.tick();
    ok(r2.dropped === 1, `narrowed allowlist drops the excluded shipper, got dropped=${r2.dropped}`);
    ok(!(await rq2.getByToken('ren')), 'Renewsys request (now out of scope) dropped');
    ok(!!(await rq2.getByToken('syn')), 'Syngenta request (still in scope) kept');

    // (c) Owner-scoped isolation is preserved: account B's reconcile never drops account A's ask.
    const s3 = createStore({ backend: 'memory' });
    const rq3 = new PriceRequestStore({ store: s3, marginsPct: MARGINS, minMarginPct: MIN });
    await seedAwaiting(s3, 'aReq', 'Havells', { account: { accountId: 'A', label: 'A' }, closesAt: future, deadlineAt: future - 90_000 });
    const pollerB = new DiscoveryPoller({ adapter: { listAuctions: async () => [] }, requests: rq3, notifier: notifier(), config: { allowlist: { shippers: ['Durian'] }, priceDeadlineLeadMs: 90_000 }, account: { accountId: 'B', label: 'B' } });
    const r3 = await pollerB.tick();
    ok(r3.dropped === 0 && !!(await rq3.getByToken('aReq')),
      "owner-scoped: account B's reconcile leaves account A's awaiting request alone");
  }

  // ============================ Bug 2: expireOverdue reaches placeholder deadlines ============
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    // The exact SuperProcure biddingOn:0 placeholder observed live (2026-07-11).
    const placeholder = Date.parse('2100-05-24T19:53:25.000Z');
    await seedAwaiting(s, 'ph', 'Ashirvad Pipes', { closesAt: placeholder, deadlineAt: placeholder - 90_000 });
    await seedAwaiting(s, 'overdue', 'Syngenta', { closesAt: now - 1_000, deadlineAt: now - 40_000 });
    await seedAwaiting(s, 'live', 'Renewsys', { closesAt: future, deadlineAt: future - 90_000 });

    const expired = await rq.expireOverdue(now);
    const ids = new Set(expired.map((r) => r.loadId));
    ok(ids.has('ph'), 'year-2100 placeholder deadline is now expirable (plausibility bound) - was eternal');
    ok(ids.has('overdue'), 'a genuinely-overdue deadline is still expired');
    ok(!ids.has('live'), 'a legit near-future deadline is NOT expired');
    ok((await rq.getByToken('ph')).status === 'skipped_no_price', 'placeholder request -> skipped_no_price');
    ok((await rq.getByToken('live')).status === 'awaiting_price', 'live request stays awaiting_price');

    // A deadline exactly at the 30d horizon is a plausible real auction -> must NOT be expired.
    const s2 = createStore({ backend: 'memory' });
    const rq2 = new PriceRequestStore({ store: s2, marginsPct: MARGINS, minMarginPct: MIN });
    await seedAwaiting(s2, 'edge', 'Syngenta', { closesAt: now + MAX_PLAUSIBLE_DEADLINE_MS, deadlineAt: now + MAX_PLAUSIBLE_DEADLINE_MS - 90_000 });
    const e2 = await rq2.expireOverdue(now);
    ok(e2.length === 0, `a ~30d-out deadline (within the listing horizon) is kept, got expired=${e2.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
