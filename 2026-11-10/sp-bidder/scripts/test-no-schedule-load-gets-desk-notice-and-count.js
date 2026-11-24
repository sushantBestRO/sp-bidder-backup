'use strict';
/**
 * CORDS / NO-SCHEDULE LOADS GET A DESK NOTICE AND A DURABLE COUNT (RULING 46).
 *
 * discovery.js's `if (load.closesAt == null) continue;` was a bare, silent skip: SuperProcure
 * biddingOn permanently 0 for some accounts/shippers (Ashirvad, Tata Consumer, Shriji Polymers,
 * Cords-type) means these loads structurally can never be armed - a different bid mechanic, not a
 * pending-schedule race. Bidding them is explicitly OUT (ruling 46), but the desk that never hears
 * about them cannot bid them by hand either.
 *
 *   1. a no-schedule load for an allowlisted shipper raises one desk_notice naming the shipper/lane
 *   2. repeated ticks on the SAME poller never raise it twice (once ever per load)
 *   3. the count survives a restart: a FRESH poller over the SAME store sees the durable row and
 *      does not re-notify or double-count it
 *   4. a no-schedule load for a shipper NOT in the allowlist raises nothing - this desk's own
 *      customers only
 *   5. a normal (scheduled, in-scope) load is unaffected: still creates a price request, and is
 *      never rowed into the no-schedule collection
 *   6. per-shipper aggregation: two shippers' no-schedule loads count separately
 *   7. the rendered WhatsApp text is plain, names the shipper, and tells the desk to bid by hand
 *
 * Offline and deterministic: real DiscoveryPoller + PriceRequestStore + FileStore on a temp dir
 * under os.tmpdir(), removed at the end; fake portal; a notifier fake that records alert() calls.
 * No network, no RNG, no sleeps.
 *
 *   node scripts/test-no-schedule-load-gets-desk-notice-and-count.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dataDir), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller, NO_SCHEDULE_COLLECTION, noScheduleCounts } = require('../src/discovery/discovery');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${pass + fail}. ${m}`); } else { fail++; console.error(`  FAIL ${pass + fail}. ${m}`); } };

const HOUR = 3_600_000;
const SHIPPER = 'Cords Cable Industries Ltd';
const OTHER_SHIPPER = 'Ashirvad Pipes Ltd';
const NOT_ALLOWED = 'Some Other Shipper Pvt Ltd';
const DIRS = [];
const cleanup = () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };

function noScheduleLoad(id, companyName) {
  return {
    id, lane: { origin: 'Bhiwandi, Maharashtra', destination: 'Silvassa, DNH' }, equipment: '20 ft SXL',
    units: 1, companyName, shipmentType: 'FTL', closesAt: null, startsAt: null,
    status: 'live', softClose: false, closeModelKnown: false,
  };
}
function scheduledLoad(id, companyName, closesAt) {
  return {
    id, lane: { origin: 'Bhiwandi, Maharashtra', destination: 'Silvassa, DNH' }, equipment: '20 ft SXL',
    units: 1, companyName, shipmentType: 'FTL', closesAt, startsAt: closesAt - 2 * HOUR,
    status: 'live', softClose: false, closeModelKnown: true, closeModel: 'hard',
  };
}

function setup({ shippers = [SHIPPER, OTHER_SHIPPER] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-schedule-notice-'));
  DIRS.push(dir);
  const h = { dir, listing: [], alerts: [] };
  h.store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
  h.requests = new PriceRequestStore({ store: h.store, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'sp' });
  h.notifier = {
    requestPrice: async () => ({ delivered: true }),
    alert: async (kind, data, opts) => { h.alerts.push({ kind, data, opts }); return true; },
  };
  h.portal = { listAuctions: async () => h.listing };
  h.makePoller = () => new DiscoveryPoller({
    adapter: h.portal, requests: h.requests, notifier: h.notifier, platformKey: 'sp',
    config: { allowlist: { shippers } },
  });
  h.poller = h.makePoller();
  return h;
}

(async () => {
  console.log('\n-- one notice per no-schedule load, naming the shipper/lane');
  {
    const h = setup();
    h.listing = [noScheduleLoad('SP900001', SHIPPER)];
    const r = await h.poller.tick();
    ok(r.created === 0, '1. a no-schedule load creates no price request');
    ok(h.alerts.length === 1, `2. exactly one alert is raised (got ${h.alerts.length})`);
    const a = h.alerts[0] || { data: {} };
    ok(a.kind === 'desk_notice', `3. the alert is a desk_notice (got ${a.kind})`);
    ok(a.data.reason === 'no_schedule', `4. the alert carries reason:no_schedule (got ${a.data.reason})`);
    ok(a.data.shipper === SHIPPER, `5. the alert names the shipper (got ${a.data.shipper})`);
    ok(a.data.auctionId === 'SP900001', `6. the alert names the load (got ${a.data.auctionId})`);
    ok(!!a.opts && !!a.opts.dedupeKey, '7. the alert carries a dedupe key');

    console.log('\n-- repeated ticks never raise it twice');
    await h.poller.tick();
    await h.poller.tick();
    ok(h.alerts.length === 1, `8. three ticks on the same load raise exactly one alert (got ${h.alerts.length})`);

    console.log('\n-- the count is durable: a FRESH poller over the same store does not re-notify');
    const h2 = { ...h, poller: h.makePoller() };
    await h2.poller.tick();
    ok(h.alerts.length === 1, `9. a fresh poller instance over the same store does not re-raise the notice (got ${h.alerts.length})`);
    const counts = await noScheduleCounts(h.store);
    ok(counts[SHIPPER] === 1, `10. the durable count reads 1 for ${SHIPPER} (got ${JSON.stringify(counts)})`);
    const rows = await h.store.listDocs(NO_SCHEDULE_COLLECTION);
    ok(rows.length === 1, `11. exactly one durable row exists for one load across three ticks and a fresh poller (got ${rows.length})`);
  }

  console.log('\n-- scope: a shipper outside our own allowlist raises nothing');
  {
    const h = setup();
    h.listing = [noScheduleLoad('SP900002', NOT_ALLOWED)];
    await h.poller.tick();
    ok(h.alerts.length === 0, `12. a no-schedule load for a non-allowlisted shipper raises no notice (got ${h.alerts.length})`);
    const rows = await h.store.listDocs(NO_SCHEDULE_COLLECTION);
    ok(rows.length === 0, `13. no durable row is written for an out-of-scope shipper (got ${rows.length})`);
  }

  console.log('\n-- a normal, scheduled load is unaffected');
  {
    const h = setup();
    const closesAt = Date.now() + 3 * HOUR;
    h.listing = [scheduledLoad('SP900003', SHIPPER, closesAt)];
    const r = await h.poller.tick();
    ok(r.created === 1, `14. a scheduled load still creates a price request (got ${JSON.stringify(r)})`);
    ok(h.alerts.filter((a) => a.data.reason === 'no_schedule').length === 0, '15. no no_schedule notice is raised for a scheduled load');
    const rows = await h.store.listDocs(NO_SCHEDULE_COLLECTION);
    ok(rows.length === 0, `16. a scheduled load is never rowed into the no-schedule collection (got ${rows.length})`);
  }

  console.log('\n-- per-shipper aggregation');
  {
    const h = setup();
    h.listing = [
      noScheduleLoad('SP900004', SHIPPER),
      noScheduleLoad('SP900005', SHIPPER),
      noScheduleLoad('SP900006', OTHER_SHIPPER),
    ];
    await h.poller.tick();
    const counts = await noScheduleCounts(h.store);
    ok(counts[SHIPPER] === 2, `17. ${SHIPPER} counts 2 (got ${JSON.stringify(counts)})`);
    ok(counts[OTHER_SHIPPER] === 1, `18. ${OTHER_SHIPPER} counts 1 (got ${JSON.stringify(counts)})`);
  }

  console.log('\n-- LIVE DEFECT (26 Sep, SP 25834194 Durian, sameer-other): a listing at/after close');
  console.log('   that drops times must never fire a false no-schedule notice on an already-scheduled load');
  {
    // The exact shape: a hard-close load, listed scheduled (creates a price request), never priced,
    // then listed AGAIN - at/after its own close - with closesAt/startsAt both null. That is the
    // realAdapter mapping at close: biddingOn 0 with past times reads as "unscheduled". The bug was
    // ordering: discovery.js checked `load.closesAt == null` BEFORE checking for an existing request,
    // so an already-scheduled, already-priced-request-bearing load took the no-schedule branch on
    // its very last tick and fired a false "no bidding schedule yet" notice.
    const h = setup();
    const closesAt = Date.now() + HOUR;
    h.listing = [scheduledLoad('SP25834194', SHIPPER, closesAt)];
    const r1 = await h.poller.tick();
    ok(r1.created === 1, '22. fixture: the load is scheduled on first sight and gets a price request');
    const before = (await h.requests.listAll()).find((x) => x.loadId === 'SP25834194');
    ok(!!before && before.load.closesAt === closesAt, '23. fixture: the stored request carries the real closesAt');

    // Second tick: the SAME load, closesAt/startsAt now null (the at-close mapping).
    h.listing = [{ id: 'SP25834194', lane: { origin: 'Bhiwandi, Maharashtra', destination: 'Silvassa, DNH' },
      equipment: '20 ft SXL', units: 1, companyName: SHIPPER, shipmentType: 'FTL',
      closesAt: null, startsAt: null, status: 'live', softClose: false, closeModelKnown: false }];
    await h.poller.tick();
    ok(!h.alerts.some((a) => a.data && a.data.reason === 'no_schedule'),
      `24. no false no-schedule notice fires for a load that already had a price request: alerts=${JSON.stringify(h.alerts.map((a) => a.data && a.data.reason))}`);
    const noScheduleRows = await h.store.listDocs(NO_SCHEDULE_COLLECTION);
    ok(noScheduleRows.length === 0, `25. the load is never rowed into the no-schedule collection either (got ${noScheduleRows.length})`);

    // Item 2: the mapping must not overwrite the known schedule on the stored request.
    const after = (await h.requests.listAll()).find((x) => x.loadId === 'SP25834194');
    ok(!!after && after.load.closesAt === closesAt,
      `26. the stored request's closesAt survives a null-times listing untouched, got ${after && after.load.closesAt}`);
    ok(after.status === 'awaiting_price', `27. the request stays awaiting_price - the null listing does not silently retire it either, got ${after.status}`);

    // "the existing price-expired path handles it" - once the ORIGINAL deadline passes, the normal
    // sweep still fires off the schedule that was never overwritten.
    const past = closesAt + 60_000;
    const expired = await h.requests.expireOverdue(past, { platformKey: 'sp' });
    ok(expired.some((x) => x.loadId === 'SP25834194'),
      `28. once the real deadline passes, expireOverdue still catches it off the preserved schedule, got ${JSON.stringify(expired.map((x) => x.loadId))}`);
  }

  console.log('\n-- VERIFICATION FINDING (26 Sep): a FIRST SIGHTING at/after the load\'s own raw close');
  console.log('   must not fire a false no-schedule notice either (restart, outage across the window, newly scoped shipper)');
  {
    // No prior price request exists at all here - this is the shape a restart or a listing outage
    // across the whole bidding window produces: discovery never saw the load while it was open, and
    // the FIRST time it's ever listed is already at/after its own close. closesAt/startsAt are both
    // null (realAdapter's mapping for biddingOn:0 with a time outside the future-window bound), but
    // biddingCloseTime - the raw, unmapped portal value - still carries the real (past) close time.
    const h = setup();
    const rawCloseIso = new Date(Date.now() - 60_000).toISOString();
    h.listing = [{
      id: 'SP25834194', companyName: SHIPPER, lane: { origin: 'Bhiwandi, Maharashtra', destination: 'Silvassa, DNH' },
      equipment: '20 ft SXL', units: 1, shipmentType: 'FTL',
      closesAt: null, startsAt: null, biddingCloseTime: rawCloseIso, biddingStartTime: new Date(Date.now() - 3600_000).toISOString(),
      biddingOn: false, status: 'unscheduled', softClose: false, closeModelKnown: true,
    }];
    await h.poller.tick();
    ok(!h.alerts.some((a) => a.data && a.data.reason === 'no_schedule'),
      `29. no false no-schedule notice on a first sighting whose RAW close time is already past: alerts=${JSON.stringify(h.alerts.map((a) => a.data && a.data.reason))}`);
    const noScheduleRows = await h.store.listDocs(NO_SCHEDULE_COLLECTION);
    ok(noScheduleRows.length === 0, `30. the load is never rowed into the no-schedule collection either (got ${noScheduleRows.length})`);
  }

  console.log('\n-- control: a first sighting with NO raw close time at all is still a genuine no-schedule load');
  {
    const h = setup();
    h.listing = [noScheduleLoad('SP900007', SHIPPER)]; // no biddingCloseTime field at all
    await h.poller.tick();
    ok(h.alerts.some((a) => a.data && a.data.reason === 'no_schedule'),
      `31. a load with no raw close time at all still gets the genuine no-schedule notice: alerts=${JSON.stringify(h.alerts.map((a) => a.data && a.data.reason))}`);
  }

  console.log('\n-- rendered text: plain, names the shipper, says bid by hand');
  {
    const data = {
      shipper: SHIPPER, origin: 'Bhiwandi, Maharashtra', dest: 'Silvassa, DNH',
      lane: 'Bhiwandi, Maharashtra -> Silvassa, DNH', auctionId: 'SP900001', oaNo: 'SP900001', reason: 'no_schedule',
    };
    const body = renderMessage(templateFor('desk_notice', data), data);
    ok(body.includes(SHIPPER), '19. the rendered notice names the shipper');
    ok(/bid it by hand/i.test(body), '20. the rendered notice tells the desk to bid by hand');
    ok(!/win rate|reserve|floor|band/i.test(body), '21. the rendered notice carries no internal pricing jargon');
  }

  console.log('\n-- owner-approved shortened copy (26 Sep, "copy too long")');
  {
    const data = {
      shipper: SHIPPER, origin: 'Bhiwandi, Maharashtra', dest: 'Silvassa, DNH',
      lane: 'Bhiwandi, Maharashtra -> Silvassa, DNH', auctionId: 'SP900001', oaNo: 'SP900001', reason: 'no_schedule',
    };
    const body = renderMessage(templateFor('desk_notice', data), data);
    const lines = body.split('\n');
    ok(lines[0] === `📌 *Not bidding - ${SHIPPER}: no close time on the portal yet*`,
      `29. the headline is the owner-approved short form, got: ${JSON.stringify(lines[0])}`);
    ok(!/we cannot bid it automatically/i.test(body) && !/we will not send a result/i.test(body),
      `30. the dropped middle/closing sentences are gone: ${body}`);
    ok(/^Bid it by hand on SuperProcure if you want it\.$/m.test(body.replace(/^_|_$/gm, '')),
      `31. the closing action line is exactly the approved short form, got: ${JSON.stringify(body)}`);
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { cleanup(); console.error('FAIL (setup):', e && e.stack); process.exit(1); });
