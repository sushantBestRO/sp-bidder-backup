'use strict';
/**
 * A POLLER MAY ONLY RETIRE ITS OWN PORTAL'S RECORDS.
 *
 * One PriceRequestStore is shared by every poller (server.js builds it once and hands it to each
 * SuperProcure stack and to the GoComet stack), but only a load's OWN poller advances its close -
 * refreshLiveClose runs off that portal's listing. So a sweep that walks the whole store is judging
 * the other portal's records against a snapshot it has no way to refresh, and both close-keyed
 * sweeps are terminal:
 *   finalizeClosed -> 'closed'            (refreshLiveClose refuses a terminal record; nothing reopens it)
 *   expireOverdue  -> 'skipped_no_price'  (plus a 'price_expired' / "no number entered" alert, and
 *                                          capture() then throws NOT_OPEN on the desk's real cost)
 * dropOutOfScope is the third: its filter is the CALLER'S allowlist, and it hard-DELETES.
 *
 * The auctions in this file are all demonstrably still running when the foreign poller ticks, so
 * every retirement asserted against is a live auction being thrown away.
 *
 * Ordering is not luck. Both pollers run on config.discoveryIntervalMs, so their relative phase is
 * fixed at boot for the process lifetime; a SuperProcure poller landing in the window between a
 * posted close and GoComet's next listing read is a constant per deploy, not a rare race.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createStore } = require('../src/store');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const EXPECTED_CHECKS = 19;

const STEP_MS = 300_000;                                    // GoComet's declared extension increment
const GC_CAPS = { closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: STEP_MS };
const SP_CAPS = { closeModel: 'unknown', biddingEnabled: true };

function gcLoad(closesAt) {
  return {
    id: 'GC1', companyName: 'Waaree Energies', lane: { origin: 'Surat', destination: 'Pune' },
    units: 1, status: 'open', closesAt, softClose: true, closeModelKnown: true,
  };
}

function makeNotifier(alerts) {
  return {
    requestPrice: async () => ({ delivered: false }),
    remindApproaching: async () => ({ delivered: false }),
    alert: async (kind, payload) => { alerts.push({ kind, payload }); },
  };
}

// Two pollers over ONE store, exactly how server.js composes them. The SuperProcure one lists
// nothing (its own board is quiet) and therefore only ever sweeps.
function pollers({ requests, notifier, gcListing }) {
  const spCfg = { allowlist: { shippers: ['Waaree'], hardCloseOnly: true }, priceDeadlineLeadMs: 60_000 };
  const gcCfg = { allowlist: { shippers: ['Waaree'], hardCloseOnly: false }, priceDeadlineLeadMs: 60_000 };
  return {
    sp: new DiscoveryPoller({
      adapter: { capabilities: () => SP_CAPS, listAuctions: async () => [] },
      requests, notifier, config: spCfg, platformKey: 'sp',
    }),
    gc: new DiscoveryPoller({
      adapter: { capabilities: () => GC_CAPS, listAuctions: async () => gcListing() },
      requests, notifier, config: gcCfg, platformKey: 'gocomet',
    }),
  };
}

async function seed(store, doc) {
  await store.putDoc(COLLECTION, doc.id, doc);
}

(async () => {
  // ---- A. finalizeClosed: a live extending GoComet load survives a SuperProcure tick ----------
  {
    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, platformKey: 'sp' });
    const alerts = [];
    const now = Date.now();
    const postedClose = now - 5_000;              // the snapshot close passed five seconds ago
    const liveClose = postedClose + STEP_MS;      // ...and the portal extended by one round

    // 'stopped' with the cost kept is where every GoComet capture lands today (holdUnbiddable),
    // and it is the status whose whole promise is that Re-arm still works.
    await seed(store, {
      id: 'GC1', loadId: 'GC1', status: 'stopped', heldReason: 'platform_bidding_disabled',
      platformKey: 'gocomet', load: gcLoad(postedClose),
      marginsPct: [10], minMarginPct: 5, marginSource: 'default', marginOverride: null,
      price: { cost: 10_000, marginsPct: [10], minMarginPct: 5 },
      deadlineAt: postedClose - 60_000, capturedAt: now - 600_000, stoppedAt: now - 600_000,
      createdAt: now - 3_600_000, notified: true,
    });

    const { sp, gc } = pollers({ requests, notifier: makeNotifier(alerts), gcListing: () => [gcLoad(liveClose)] });
    await sp._tick();
    const afterSp = await requests.getByToken('GC1');
    await gc._tick();
    const afterGc = await requests.getByToken('GC1');

    ok(liveClose > Date.now(), 'A: fixture sanity - the GoComet auction is still running');
    ok(afterSp && afterSp.status === 'stopped',
      `A: the SuperProcure tick leaves a live GoComet record alone (got '${afterSp ? afterSp.status : 'DELETED'}')`);
    ok(afterGc && afterGc.load.liveClosesAt === liveClose,
      'A: GoComet\'s own tick then adopts the extended close (the rescue is not locked out)');
    let rearmErr = null;
    try { await requests.rearm('GC1'); } catch (e) { rearmErr = e.code || e.message; }
    ok(rearmErr === null, `A: the desk can still act on it - rearm() returned '${rearmErr}'`);
  }

  // ---- B. expireOverdue: an unpriced GoComet load stays priceable, and raises no false alert --
  {
    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, platformKey: 'sp' });
    const alerts = [];
    const now = Date.now();
    const postedClose = now - 5_000;
    const liveClose = postedClose + STEP_MS;

    await seed(store, {
      id: 'GC2', loadId: 'GC2', status: 'awaiting_price', platformKey: 'gocomet',
      load: Object.assign(gcLoad(postedClose), { id: 'GC2' }),
      marginsPct: [10], minMarginPct: 5, marginSource: 'default', marginOverride: null,
      deadlineAt: postedClose - 60_000, createdAt: now - 3_600_000, notified: true, notifiedAt: now - 3_600_000,
    });

    const { sp, gc } = pollers({
      requests, notifier: makeNotifier(alerts),
      gcListing: () => [Object.assign(gcLoad(liveClose), { id: 'GC2' })],
    });
    await sp._tick();
    const afterSp = await requests.getByToken('GC2');
    ok(afterSp && afterSp.status === 'awaiting_price',
      `B: the SuperProcure tick does not file it 'skipped_no_price' (got '${afterSp ? afterSp.status : 'DELETED'}')`);
    ok(!alerts.some((a) => a.kind === 'price_expired'),
      'B: and raises no "no number entered" alert about a desk that is still mid-keystroke');

    await gc._tick();
    // The desk finally submits. Pre-fix this threw NOT_OPEN on a live auction.
    let captureErr = null, captured = null;
    try { captured = await requests.capture('GC2', { cost: 12_000 }); } catch (e) { captureErr = e.code || e.message; }
    ok(captureErr === null, `B: the desk's cost is still accepted on a live auction (got '${captureErr}')`);
    ok(captured && captured.status === 'armed' && captured.price.cost === 12_000,
      'B: ...and it arms off the number they typed');
  }

  // ---- C. the scope did not switch the sweeps off - each poller still retires its OWN ---------
  {
    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, platformKey: 'sp' });
    const alerts = [];
    const now = Date.now();
    const endedClose = now - 10 * 60_000;         // genuinely over: an hour of extensions could not reach it

    await seed(store, {
      id: 'GC3', loadId: 'GC3', status: 'armed', platformKey: 'gocomet',
      load: Object.assign(gcLoad(endedClose), { id: 'GC3' }),
      marginsPct: [10], minMarginPct: 5, price: { cost: 10_000, marginsPct: [10], minMarginPct: 5 },
      capturedAt: now - 3_600_000, createdAt: now - 3_600_000, notified: true,
    });
    await seed(store, {
      id: 'SP3', loadId: 'SP3', status: 'awaiting_price', platformKey: 'sp',
      load: { id: 'SP3', companyName: 'Waaree Energies', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: endedClose, softClose: false, closeModelKnown: true },
      marginsPct: [10], minMarginPct: 5, deadlineAt: endedClose - 60_000,
      createdAt: now - 3_600_000, notified: true, notifiedAt: now - 3_600_000,
    });

    // GoComet's listing no longer carries GC3 - the auction is over, so there is nothing to refresh.
    const { sp, gc } = pollers({ requests, notifier: makeNotifier(alerts), gcListing: () => [] });
    await sp._tick();
    ok((await requests.getByToken('SP3')).status === 'skipped_no_price',
      'C: the SuperProcure poller still expires its OWN overdue unpriced record');
    ok((await requests.getByToken('GC3')).status === 'armed',
      'C: ...and still does not touch the GoComet one');
    await gc._tick();
    ok((await requests.getByToken('GC3')).status === 'closed',
      'C: the GoComet poller retires its own ended auction, so nothing is stranded on the worklist');
  }

  // ---- D. dropOutOfScope: the allowlist reconcile is the third sweep, and it DELETES ----------
  {
    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, platformKey: 'sp' });
    const alerts = [];
    const now = Date.now();
    const liveClose = now + STEP_MS;

    await seed(store, {
      id: 'GC4', loadId: 'GC4', status: 'awaiting_price', platformKey: 'gocomet',
      load: Object.assign(gcLoad(liveClose), { id: 'GC4' }),
      marginsPct: [10], minMarginPct: 5, deadlineAt: liveClose - 60_000,
      createdAt: now, notified: true, notifiedAt: now,
    });

    // No `account` on this poller - the single-account box, where the owner filter is absent and
    // nothing but the portal scope stands between an SP allowlist and a GoComet record.
    const { sp } = pollers({
      requests, notifier: makeNotifier(alerts),
      gcListing: () => [Object.assign(gcLoad(liveClose), { id: 'GC4' })],
    });
    ok(sp.account == null, 'D: fixture sanity - the SuperProcure poller carries no owner tag');
    ok(sp.matchesAllowlist(gcLoad(liveClose)) === false,
      'D: ...and its hard-close-only allowlist rejects the (soft-close) GoComet load, so unscoped it would drop it');
    await sp._tick();
    const survivor = await requests.getByToken('GC4');
    ok(survivor && survivor.status === 'awaiting_price',
      'D: the GoComet ask survives the SuperProcure reconcile (it is a DELETE, not a status change)');
  }

  // ---- E. the expiry alert is tagged, and SuperProcure's channel is unchanged -----------------
  {
    const n = new Notifier({ mode: 'whatsapp', platformModes: { gocomet: 'dashboard' } });
    ok(n.notifyModeFor('sp') === n.notifyModeFor(null),
      'E: tagging the SuperProcure poller\'s alert resolves exactly as the untagged payload did');
    ok(n.notifyModeFor('gocomet') === 'dashboard',
      'E: and a GoComet-tagged expiry alert routes off SuperProcure\'s channel');

    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [10], minMarginPct: 5, platformKey: 'sp' });
    const alerts = [];
    const now = Date.now();
    const endedClose = now - 10 * 60_000;
    await seed(store, {
      id: 'GC5', loadId: 'GC5', status: 'awaiting_price', platformKey: 'gocomet',
      load: Object.assign(gcLoad(endedClose), { id: 'GC5' }),
      marginsPct: [10], minMarginPct: 5, deadlineAt: endedClose - 60_000,
      createdAt: now - 3_600_000, notified: true, notifiedAt: now - 3_600_000,
    });
    const { gc } = pollers({ requests, notifier: makeNotifier(alerts), gcListing: () => [] });
    await gc._tick();
    const expiry = alerts.find((a) => a.kind === 'price_expired');
    ok(expiry && expiry.payload.platformKey === 'gocomet',
      'E: a genuine GoComet expiry carries its own portal, so it is not delivered as SuperProcure');
  }

  // ---- F. grep gate: every sweep call site on the tick passes the poller's key ----------------
  // The three calls sit within thirty lines of each other and a fourth sweep is a plausible future
  // addition, so pin the property rather than the three known lines.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'discovery', 'discovery.js'), 'utf8');
    const untagged = ['finalizeClosed', 'expireOverdue', 'dropOutOfScope'].filter((fn) => {
      const m = new RegExp(`requests\\.${fn}\\(([\\s\\S]{0,200}?)\\);`).exec(src);
      return !m || !/platformKey:\s*this\.platformKey/.test(m[1]);
    });
    ok(untagged.length === 0, `F: every store sweep on the tick is portal-scoped (unscoped: ${untagged.join(', ') || 'none'})`);
    ok(!/requests\.finalizeClosed\(Date\.now\(\)\)/.test(src),
      'F: negative control - the unscoped call shape is gone from the file');
  }

  assert.strictEqual(fail, 0, `${fail} platform-scoped sweep checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
