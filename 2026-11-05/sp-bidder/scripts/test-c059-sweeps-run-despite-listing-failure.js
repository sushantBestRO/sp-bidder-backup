'use strict';
/**
 * Pins C059 (fix/ops-alerting-divergences).
 *
 * DiscoveryPoller._tick returned immediately on a failed listAuctions(), which also skipped every
 * time-based sweep below it (dropOutOfScope, expireOverdue, finalizeClosed, pruneEnded) - none of
 * which need a fresh listing at all, all of which key off Date.now() and this poller's own
 * platformKey. A platform stuck failing its listing call (auth dead, a sustained 5xx) therefore
 * never expired an overdue price-ask, never retired a closed auction, and never dropped an
 * out-of-scope request for as long as the failure lasted - the worklist silently rotted.
 *
 * @requires-summary-line
 *   node scripts/test-c059-sweeps-run-despite-listing-failure.js
 */
const { createStore } = require('../src/store');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const now = Date.now();
const past = now - 60 * 60_000; // closed an hour ago

const seedAwaiting = (store, id, companyName, closesAt) =>
  store.putDoc(COLLECTION, id, {
    id, loadId: id, status: 'awaiting_price', account: null,
    load: { companyName, lane: { origin: 'A', destination: 'B' }, softClose: false, closeModelKnown: true, closesAt },
    deadlineAt: past, price: null, capturedAt: null, createdAt: now - 2 * 60 * 60_000,
  });

(async () => {
  const s = createStore({ backend: 'memory' });
  const rq = new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 });
  await seedAwaiting(s, 'STALE-1', 'Havells', past); // deadline long passed -> should expireOverdue

  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
  const poller = new DiscoveryPoller({
    adapter: { listAuctions: async () => { throw new Error('simulated: SuperProcure listing down'); } },
    requests: rq, notifier,
    config: { allowlist: { shippers: ['Havells'] }, priceDeadlineLeadMs: 90_000 },
  });

  const r = await poller.tick();
  ok(r.scanned === 0, 'a failed listing still reports 0 scanned (no fabricated loads)');

  const after = await s.getDoc(COLLECTION, 'STALE-1');
  ok(after.status === 'skipped_no_price',
    `C059: an overdue awaiting-price request is still expired even though listAuctions() failed, got status="${after.status}"`);

  // Review correction (26 Sep, reviewer repro repro-c059-provisional.js): running expireOverdue and
  // finalizeClosed off a STALE stored close on a platform with a live-close step (GoComet) files an
  // unpriced ask 'skipped_no_price' (with a price_expired alert blaming the desk) and an armed ask
  // terminally 'closed', when the true close may already have extended past both. refreshLiveClose
  // - the only thing that would have caught the extension - only ever runs off a fresh listing, so a
  // failed tick can neither see the extension nor rescue the record it just mis-filed; the next GOOD
  // tick finds the request already gone. SuperProcure (no live-close step) is unaffected and must keep
  // sweeping on a failed listing, per the fixture above.
  {
    const now2 = Date.now();
    const staleClose = now2 - 5_000;
    const extendedClose = now2 + 240_000;
    const s2 = createStore({ backend: 'memory' });
    const rq2 = new PriceRequestStore({ store: s2, marginsPct: [10], minMarginPct: 5 });
    for (const [id, status] of [['GC-AWAIT', 'awaiting_price'], ['GC-ARMED', 'armed']]) {
      await s2.putDoc(COLLECTION, id, {
        id, loadId: id, status, account: null, platformKey: 'gocomet',
        load: { companyName: 'Waaree', lane: { origin: 'A', destination: 'B' }, softClose: true, closeModelKnown: true, closesAt: staleClose, platformKey: 'gocomet' },
        deadlineAt: staleClose - 60_000, price: null, createdAt: now2 - 3 * 3600_000,
      });
    }
    let listingShouldFail = true;
    const gcAdapter = {
      capabilities: () => ({ closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: 299_000 }),
      listAuctions: async () => {
        if (listingShouldFail) throw new Error('simulated GoComet 429/5xx on this one tick');
        return ['GC-AWAIT', 'GC-ARMED'].map((id) => ({
          id, companyName: 'Waaree', lane: { origin: 'A', destination: 'B' },
          softClose: true, closeModelKnown: true, closesAt: extendedClose, status: 'open' }));
      },
    };
    const gcNotifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const gcAlerts = [];
    const origAlert = gcNotifier.alert.bind(gcNotifier);
    gcNotifier.alert = async (k, p, o) => { gcAlerts.push(k); return origAlert(k, p, o); };
    const gcPoller = new DiscoveryPoller({
      adapter: gcAdapter, requests: rq2, notifier: gcNotifier, platformKey: 'gocomet',
      config: { allowlist: { shippers: ['Waaree'] }, priceDeadlineLeadMs: 90_000 },
    });

    await gcPoller.tick();
    const awaitAfterFail = await s2.getDoc(COLLECTION, 'GC-AWAIT');
    const armedAfterFail = await s2.getDoc(COLLECTION, 'GC-ARMED');
    ok(awaitAfterFail.status === 'awaiting_price',
      `C059 GoComet: a failed listing must not expire an unpriced ask off a stale close, got status="${awaitAfterFail.status}"`);
    ok(armedAfterFail.status === 'armed',
      `C059 GoComet: a failed listing must not finalize an armed load off a stale close, got status="${armedAfterFail.status}"`);
    ok(!gcAlerts.includes('price_expired'),
      `C059 GoComet: no price_expired alert fires off a stale close on a failed listing, got alerts=${gcAlerts.join(',')}`);

    listingShouldFail = false;
    await gcPoller.tick();
    const awaitAfterRecover = await s2.getDoc(COLLECTION, 'GC-AWAIT');
    const armedAfterRecover = await s2.getDoc(COLLECTION, 'GC-ARMED');
    ok(awaitAfterRecover.status === 'awaiting_price' && awaitAfterRecover.load.liveClosesAt === extendedClose,
      `C059 GoComet: the recovery tick refreshes the extended close, got status="${awaitAfterRecover.status}" liveClosesAt=${awaitAfterRecover.load.liveClosesAt}`);
    ok(armedAfterRecover.status === 'armed' && armedAfterRecover.load.liveClosesAt === extendedClose,
      `C059 GoComet: the recovery tick refreshes the armed load's extended close too, got status="${armedAfterRecover.status}" liveClosesAt=${armedAfterRecover.load.liveClosesAt}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (!fail) console.log(`${pass}/${pass} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
