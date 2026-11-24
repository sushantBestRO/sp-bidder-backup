'use strict';
/**
 * Price-request loop test (deterministic, offline): discovery -> request -> capture
 * -> arm, plus allowlist filtering, idempotency, the no-price deadline skip, and
 * capture validation. Uses the memory store + a fake adapter + a stub engine, so it
 * never touches the network and never bids.
 */
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest, COLLECTION } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');
const { DiscoveryPoller } = require('../src/discovery/discovery');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const now = Date.now();
  const MARGINS = [12.6, 7.2, 6.3];
  const MIN = 6.3;
  const loads = [
    { id: 'L1', lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1, weight: 12, companyName: 'Syngenta', shipmentType: 'FTL', closesAt: now + 10 * 60000, startsAt: now - 60000, ceiling: 100000, revisionLimit: 3, softClose: false, status: 'live' },
    { id: 'L2', lane: { origin: 'A', destination: 'B' }, equipment: 'Open', units: 1, companyName: 'Syngenta', shipmentType: 'FTL', closesAt: now + 15 * 60000, startsAt: now + 5 * 60000, ceiling: 90000, revisionLimit: 3, softClose: false, status: 'scheduled' },
    { id: 'L3', lane: { origin: 'C', destination: 'D' }, companyName: 'Syngenta', closesAt: now - 1000, status: 'closed' },
    { id: 'L4', lane: { origin: 'E', destination: 'F' }, companyName: 'Other Shipper', closesAt: now + 10 * 60000, startsAt: now - 1000, status: 'live' },
    { id: 'L5', lane: { origin: 'G', destination: 'H' }, companyName: 'Syngenta', closesAt: now + 30000, startsAt: now - 1000, status: 'live' }, // too close (< 90s lead)
    // no scheduled bidding window yet (real-world: SuperProcure biddingOn:0, closesAt
    // already nulled out by _mapLoad) - must be skipped, not priced against a fake deadline.
    { id: 'L6', lane: { origin: 'I', destination: 'J' }, companyName: 'Syngenta', closesAt: null, startsAt: null, status: 'unscheduled' },
  ];
  const adapter = { listAuctions: async () => loads };
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: MARGINS, minMarginPct: MIN });
  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
  const config = { allowlist: { shippers: ['syngenta'] }, priceDeadlineLeadMs: 90_000 };
  const discovery = new DiscoveryPoller({ adapter, requests, notifier, config });

  // ---- discovery: only in-scope, in-time loads become requests ----
  const r1 = await discovery.tick();
  ok(r1.created === 3, `discovery created 3 (L1 live + L2 scheduled + L5 danger-zone), got ${r1.created}`);
  ok((await requests.getByLoad('L1')), 'L1 (live Syngenta) -> request created');
  ok((await requests.getByLoad('L2')), 'L2 (scheduled Syngenta) -> request created');
  ok(!(await requests.getByLoad('L3')), 'L3 (closed) -> no request');
  ok(!(await requests.getByLoad('L4')), 'L4 (non-allowlist shipper) -> no request');
  ok((await requests.getByLoad('L5')), 'L5 (danger zone, auction still open) -> request created (accepted best-effort, not skipped)');
  ok(!(await requests.getByLoad('L6')), 'L6 (no scheduled bidding window, closesAt null) -> no request, not priced against a fake deadline');

  // ---- load weight is persisted onto the snapshot (null when absent) ----
  ok((await requests.getByLoad('L1')).load.weight === 12, 'declared weight carried onto the request snapshot');
  ok((await requests.getByLoad('L2')).load.weight === null, 'no weight on the load -> snapshot weight is null');

  // ---- idempotency: a second tick creates nothing new ----
  const r2 = await discovery.tick();
  ok(r2.created === 0, `second tick creates 0, got ${r2.created}`);
  ok((await requests.listAll()).length === 3, 'still exactly 3 requests after a re-tick (L1 + L2 + L5, no duplicates)');

  // ---- capture: cost saved, status armed ----
  const reqL1 = await requests.getByLoad('L1');
  const capt = await requests.capture(reqL1.id, { cost: 80000 });
  ok(capt.status === 'armed', 'capture -> status armed');
  ok(capt.price && capt.price.cost === 80000, 'capture -> cost stored');
  ok(JSON.stringify(capt.price.marginsPct) === JSON.stringify(MARGINS), 'capture -> margin band carried onto the price');
  ok(capt.price.minMarginPct === MIN, 'capture -> explicit minMarginPct carried onto the price');

  // ---- armFromRequest: live -> arm, scheduled -> schedule ----
  const calls = [];
  const stubEngine = {
    arm: (meta, inputs) => { calls.push({ fn: 'arm', id: meta.id, inputs }); return { ladder: [90080, 85760, 85040], floor: 85040 }; },
    schedule: (meta, inputs) => { calls.push({ fn: 'schedule', id: meta.id, inputs }); return { ladder: [90080, 85040] }; },
  };
  const armedL1 = armFromRequest(stubEngine, capt);
  ok(calls.length === 1 && calls[0].fn === 'arm' && calls[0].id === 'L1', 'live load -> engine.arm()');
  ok(calls[0].inputs.cost === 80000 && JSON.stringify(calls[0].inputs.marginsPct) === JSON.stringify(MARGINS) && calls[0].inputs.minMarginPct === MIN, 'arm got {cost, marginsPct, minMarginPct}');
  ok(armedL1 && Array.isArray(armedL1.ladder), 'armFromRequest returns the monitor/ladder');

  const reqL2 = await requests.getByLoad('L2');
  const captL2 = await requests.capture(reqL2.id, { cost: 70000 });
  armFromRequest(stubEngine, captL2);
  ok(calls.length === 2 && calls[1].fn === 'schedule' && calls[1].id === 'L2', 'scheduled load -> engine.schedule()');

  // ---- auction closed with no cost: awaiting-price whose CLOSE has passed -> skipped ----
  const overdue = await requests.createForLoad(
    { id: 'L9', lane: { origin: 'X', destination: 'Y' }, companyName: 'Syngenta', closesAt: now - 1000, status: 'live' },
    { deadlineAt: now - 40000 },
  );
  ok(overdue.status === 'awaiting_price', 'overdue request starts awaiting_price');
  const expired = await requests.expireOverdue(now);
  ok(expired.length === 1 && expired[0].loadId === 'L9', 'expireOverdue returns the overdue one');
  ok((await requests.getByToken(overdue.id)).status === 'skipped_no_price', 'overdue -> skipped_no_price (never bids blind)');

  // ---- capture validation ----
  let threw = null;
  try { await requests.capture(reqL1.id, { cost: 90000 }); } catch (e) { threw = e.code; }
  // Named reversal, A009: a capture that finds the request no longer open is CAPTURE_LOST, so the
  // price route shows it as an error rather than rendering the load's page.
  ok(threw === 'CAPTURE_LOST', 're-capturing an armed request is rejected (CAPTURE_LOST)');
  threw = null;
  try { await requests.capture('nope', { cost: 100 }); } catch (e) { threw = e.code; }
  ok(threw === 'NOT_FOUND', 'unknown token rejected (NOT_FOUND)');
  threw = null;
  const fresh = await requests.createForLoad({ id: 'L10', lane: { origin: 'P', destination: 'Q' }, companyName: 'Syngenta', closesAt: now + 600000, status: 'live' }, { deadlineAt: now + 500000 });
  try { await requests.capture(fresh.id, { cost: 0 }); } catch (e) { threw = e.code; }
  ok(threw === 'BAD_INPUT', 'cost <= 0 rejected (BAD_INPUT)');

  // ---- target removal: drop out-of-scope AWAITING requests, keep ARMED, re-create on re-add ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const cfg = { allowlist: { shippers: ['syngenta', 'renewsys'] }, priceDeadlineLeadMs: 90_000 };
    const base = { closesAt: now + 10 * 60000, startsAt: now - 1000, status: 'live', softClose: false };
    const lds = [
      { id: 'S1', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', ...base },
      { id: 'R1', lane: { origin: 'C', destination: 'D' }, companyName: 'Renewsys India', ...base },
      { id: 'R2', lane: { origin: 'E', destination: 'F' }, companyName: 'Renewsys India', ...base },
    ];
    const disc = new DiscoveryPoller({ adapter: { listAuctions: async () => lds }, requests: rq, notifier, config: cfg });
    await disc.tick();
    ok((await rq.listAll()).length === 3, 'reconcile setup: 3 in-scope requests (S1, R1, R2)');
    // a human prices R1 -> committed
    await rq.capture((await rq.getByLoad('R1')).id, { cost: 50000 });
    // operator removes Renewsys from targets, then a tick reconciles
    cfg.allowlist.shippers = ['syngenta'];
    const t = await disc.tick();
    ok(t.dropped === 1, `only the awaiting out-of-scope request dropped (R2), got ${t.dropped}`);
    ok(!(await rq.getByLoad('R2')), 'R2 (awaiting, now out of scope) -> dropped');
    ok((await rq.getByLoad('R1')).status === 'armed', 'R1 (armed, out of scope) -> KEPT (a commitment, not intake)');
    ok(!!(await rq.getByLoad('S1')), 'S1 (still in scope) -> kept');
    // re-adding the target re-creates the dropped request on the next tick (reversible)
    cfg.allowlist.shippers = ['syngenta', 'renewsys'];
    const t2 = await disc.tick();
    ok(t2.created === 1 && !!(await rq.getByLoad('R2')), 're-adding the target re-creates the dropped request');
  }

  // ---- dismiss: sticky 'dismissed', not re-created by discovery, not touched by reconcile ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const cfg = { allowlist: { shippers: ['syngenta'] }, priceDeadlineLeadMs: 90_000 };
    const one = [{ id: 'D1', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: now + 10 * 60000, startsAt: now - 1000, status: 'live', softClose: false }];
    const disc = new DiscoveryPoller({ adapter: { listAuctions: async () => one }, requests: rq, notifier, config: cfg });
    await disc.tick();
    const d1 = await rq.getByLoad('D1');
    ok(d1 && d1.status === 'awaiting_price', 'dismiss setup: D1 awaiting');
    ok((await rq.dismiss(d1.id)).status === 'dismissed', 'dismiss -> status dismissed');
    const t = await disc.tick();
    ok(t.created === 0, 'discovery does NOT re-create a dismissed load (still in scope)');
    ok(t.dropped === 0, 'reconcile does NOT touch a dismissed request');
    ok((await rq.getByLoad('D1')).status === 'dismissed', 'D1 stays dismissed after a tick');
    let threw = null;
    try { await rq.dismiss(d1.id); } catch (e) { threw = e.code; }
    ok(threw === 'NOT_OPEN', 're-dismissing a non-awaiting request is rejected (NOT_OPEN)');
    // restore is reversible: dismissed -> awaiting_price again
    ok((await rq.restore(d1.id)).status === 'awaiting_price', 'restore -> back to awaiting_price');
    let threw2 = null;
    try { await rq.restore(d1.id); } catch (e) { threw2 = e.code; }
    ok(threw2 === 'NOT_OPEN', 'restoring a non-dismissed request is rejected (NOT_OPEN)');
    // restore is blocked once the auction has closed (would only bounce to skipped)
    const past = await rq.createForLoad({ id: 'D2', lane: { origin: 'X', destination: 'Y' }, companyName: 'Syngenta', closesAt: now - 1000, status: 'live' }, { deadlineAt: now - 2000 });
    await rq.dismiss(past.id);
    let threw3 = null;
    try { await rq.restore(past.id); } catch (e) { threw3 = e.code; }
    ok(threw3 === 'GONE', 'restore blocked once the auction has closed (GONE)');
    // finalizeClosed: an armed request whose auction has closed -> terminal 'closed'. capture() now
    // refuses a past-close load, so arm the fixture while it is OPEN, then run finalizeClosed against
    // a later "now" past its close. Only finalizeClosed's past-close handling is under test here.
    const ac = await rq.createForLoad({ id: 'AC1', lane: { origin: 'M', destination: 'N' }, companyName: 'Syngenta', closesAt: now + 60_000, status: 'live' }, { deadlineAt: now + 30_000 });
    await rq.capture(ac.id, { cost: 40000 });
    ok(await rq.finalizeClosed(now + 120_000) >= 1 && (await rq.getByLoad('AC1')).status === 'closed', 'finalizeClosed: armed load whose auction later closed -> closed');
  }

  // ---- year-2100 placeholder-close cleanup: finalizeClosed self-heal + rearm guard ----
  // SuperProcure ships biddingOn:0 loads (Ashirvad's open-board type) with a shared far-future
  // placeholder close. Such a request can never satisfy `now >= closesAt`, so before this guard it
  // sat on the worklist forever and its Re-arm button could resurrect a monitor that never fires
  // (docs/diagnoses/2026-07-13_zero-bid-silent-miss-and-placeholder-cleanup.md).
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const PLACEHOLDER = 4114871605000; // SP's real shared placeholder: 2100-05-24T19:53:25Z

    // a STOPPED request carrying the placeholder close - the exact worklist-clutter state
    const ph = await rq.createForLoad(
      { id: 'PH1', lane: { origin: 'A', destination: 'B' }, companyName: 'Ashirvad Pipes', closesAt: PLACEHOLDER, status: 'live' },
      { deadlineAt: now + 60_000 },
    );
    await s.patchDoc(COLLECTION, ph.id, { status: 'stopped' });
    ok((await rq.getByLoad('PH1')).load.closesAt === PLACEHOLDER, 'setup: stopped request with year-2100 placeholder close');

    ok(await rq.finalizeClosed(now) >= 1, 'finalizeClosed sweeps a placeholder-close request');
    const swept = await rq.getByLoad('PH1');
    ok(swept.status === 'closed', 'finalizeClosed: stopped placeholder-close -> terminal closed');
    ok(swept.load.closesAt <= now && swept.load.closesAt > now - 5 * 60_000,
      'finalizeClosed normalizes the placeholder closesAt to ~now (so the worklist filter hides it and pruneEnded ages it out)');

    // a genuine past close is retired WITHOUT rewriting its (already valid) closesAt
    const pastClose = now - 1000;
    const pc = await rq.createForLoad(
      { id: 'PC1', lane: { origin: 'C', destination: 'D' }, companyName: 'Syngenta', closesAt: pastClose, status: 'live' },
      { deadlineAt: now + 60_000 },
    );
    await s.patchDoc(COLLECTION, pc.id, { status: 'stopped' });
    await rq.finalizeClosed(now);
    ok((await rq.getByLoad('PC1')).load.closesAt === pastClose, 'finalizeClosed leaves a genuine past close untouched (only the placeholder is normalized)');

    // rearm must refuse a placeholder-close load -> never resurrect the forever-armed monitor
    const ph2 = await rq.createForLoad(
      { id: 'PH2', lane: { origin: 'E', destination: 'F' }, companyName: 'Ashirvad Pipes', closesAt: PLACEHOLDER, status: 'live' },
      { deadlineAt: now + 60_000 },
    );
    await s.patchDoc(COLLECTION, ph2.id, { status: 'stopped' });
    let threw = null;
    try { await rq.rearm(ph2.id); } catch (e) { threw = e.code; }
    ok(threw === 'NO_VALID_CLOSE', 'rearm refuses a placeholder-close load (defuses the forever-armed Re-arm trap)');
  }

  // ---- approaching-deadline reminder: dueForReminder / markReminded (Workstream B) ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: MARGINS, minMarginPct: MIN });
    const BASE = now + 10_000_000; // isolated synthetic timeline, well clear of any other block's values
    // A 5-minute lead, production-shaped: the real default (config.reminderLeadMs) is 300_000, and
    // the MIN_GAP clamp below only behaves the way production does when LEAD is above the 60s gap.
    const LEAD = 300_000;
    const MIN_GAP = 60_000; // priceRequests' REMINDER_MIN_GAP_MS - the ask -> reminder separation floor
    // createForLoad always stamps the REAL Date.now() as createdAt - backdate it to BASE right
    // after creation so every dueForReminder(nowMs, LEAD) call below can reason purely in
    // BASE-relative offsets, with no real-wall-clock skew to account for.
    const atBase = async (req) => { await s.patchDoc(COLLECTION, req.id, { createdAt: BASE }); return req; };

    // A normal-window request: created at BASE, deadline 13 min out (the MEASURED MEDIAN ask ->
    // cutoff window across 504 real requests). The reminder point (deadlineAt - LEAD) sits 8 min
    // after creation, well clear of both the ask and the deadline - the 99%+ production case, and
    // the one where the nominal lead (not the clamp) governs.
    const normal = await atBase(await rq.createForLoad(
      { id: 'RM1', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: BASE + 815_000, status: 'live' },
      { deadlineAt: BASE + 780_000 }, // 13 min; reminderAt = BASE + 480_000 (8 min in)
    ));
    ok(!(await rq.dueForReminder(BASE + 5_000, LEAD)).length, 'not yet due: before the reminder point');
    ok(!(await rq.dueForReminder(BASE + 479_000, LEAD)).length, 'still not due one second before the reminder point');
    const due1 = await rq.dueForReminder(BASE + 480_000, LEAD);
    ok(due1.length === 1 && due1[0].id === normal.id, 'due once the reminder point is crossed, still before the deadline');
    ok((await rq.dueForReminder(BASE + 480_000, LEAD))[0].deadlineAt - (BASE + 480_000) === LEAD,
      'on a normal window the reminder lands exactly LEAD ahead of the cutoff - the clamp does not move it');
    const due2 = await rq.dueForReminder(BASE + 779_000, LEAD);
    ok(due2.length === 1 && due2[0].id === normal.id, 'still due right up to the deadline (only expireOverdue owns the past-deadline case)');
    await rq.markReminded(normal.id);
    ok((await rq.getByToken(normal.id)).reminderSentAt != null, 'markReminded stamps reminderSentAt');
    ok(!(await rq.dueForReminder(BASE + 500_000, LEAD)).length, 'never due again once reminded (idempotent)');
    ok(!(await rq.dueForReminder(BASE + 900_000, LEAD)).length, 'still not due again well past the deadline either');

    // ---- SHORT-FUSE (window shorter than the lead). Measured: 0.8% of real ask -> cutoff windows
    // are under 5 minutes. The nominal reminder point (deadlineAt - LEAD) falls BEFORE the original
    // ask on these, so before 2026-07-25 they were dropped outright and got NO reminder at all -
    // harmless at the old 60s lead (almost nothing was shorter than that), a real coverage hole at
    // 5 minutes. They must now get EXACTLY ONE reminder: not zero, not two, and not stacked on top
    // of the ask - clamped to MIN_GAP after the notice. ----
    const shortFuse = await atBase(await rq.createForLoad(
      { id: 'RM2', lane: { origin: 'C', destination: 'D' }, companyName: 'Syngenta', closesAt: BASE + 215_000, status: 'live' },
      { deadlineAt: BASE + 180_000 }, // 3 min window; nominal reminderAt = BASE - 120_000 (before the ask) -> clamped to BASE + MIN_GAP
    ));
    const sf = (at) => rq.dueForReminder(at, LEAD).then((d) => d.filter((r) => r.id === shortFuse.id));
    ok((await sf(BASE + 1_000)).length === 0, 'short-fuse: NOT fired immediately on top of the ask, even though the nominal reminder point is already past');
    ok((await sf(BASE + MIN_GAP - 1_000)).length === 0, 'short-fuse: still silent just before the minimum ask -> reminder gap elapses');
    ok((await sf(BASE + MIN_GAP)).length === 1, 'short-fuse: DOES get its reminder, clamped to the minimum gap after the ask (not skipped as it was before)');
    ok((await sf(BASE + 179_000)).length === 1, 'short-fuse: stays due right up to its cutoff if no tick collected it earlier');
    await rq.markReminded(shortFuse.id);
    ok((await sf(BASE + 120_000)).length === 0, 'short-fuse: EXACTLY ONE reminder - never returned again after markReminded');

    // Degenerate fuse: the whole window is shorter than the minimum gap, so there is no room for a
    // second distinct message at all. Still skipped - the original ask already carries the cutoff.
    const noRoom = await atBase(await rq.createForLoad(
      { id: 'RM2b', lane: { origin: 'C', destination: 'D' }, companyName: 'Syngenta', closesAt: BASE + 65_000, status: 'live' },
      { deadlineAt: BASE + 30_000 }, // 30s window, under MIN_GAP
    ));
    ok(!(await rq.dueForReminder(BASE + 10_000, LEAD)).some((r) => r.id === noRoom.id),
      'a window shorter than the minimum gap gets no reminder - no room for a distinct second message');
    ok(!(await rq.dueForReminder(BASE + 29_000, LEAD)).some((r) => r.id === noRoom.id),
      'and it is never released later in that window either');

    // The clamp must never OVERRULE a deliberately short operator lead: with a lead below the gap,
    // the gap caps to the lead, so a tight configuration still reminds instead of going silent.
    const TIGHT = 20_000;
    const tightCfg = await atBase(await rq.createForLoad(
      { id: 'RM2c', lane: { origin: 'C', destination: 'D' }, companyName: 'Syngenta', closesAt: BASE + 75_000, status: 'live' },
      { deadlineAt: BASE + 40_000 },
    ));
    ok((await rq.dueForReminder(BASE + 20_000, TIGHT)).some((r) => r.id === tightCfg.id),
      'a lead shorter than the minimum gap is honoured, not clamped past its own deadline into silence');

    // A request already past its deadline is expireOverdue's job, not a reminder candidate.
    const overdueForReminder = await atBase(await rq.createForLoad(
      { id: 'RM3', lane: { origin: 'E', destination: 'F' }, companyName: 'Syngenta', closesAt: BASE + 5_000, status: 'live' },
      { deadlineAt: BASE - 1_000 },
    ));
    ok(!(await rq.dueForReminder(BASE + 1_000, LEAD)).some((r) => r.id === overdueForReminder.id),
      'a request already past its deadline is never returned as due-for-reminder');

    // ---- end to end through discovery._tick(): backdate notifiedAt/deadlineAt so the reminder
    // point is already behind REAL Date.now(), then confirm the notifier fires and reminderSentAt
    // gets stamped only after a delivered send (mirrors the notified/markNotified pattern). ----
    const rq2 = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: MARGINS, minMarginPct: MIN });
    const notifier2 = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' }); // dashboard mode -> delivered always true
    const e2eDeadline = Date.now() + 5_000; // safely still open
    const e2e = await rq2.createForLoad(
      { id: 'RM4', lane: { origin: 'G', destination: 'H' }, companyName: 'Syngenta', closesAt: Date.now() + 35_000, status: 'live' },
      { deadlineAt: e2eDeadline },
    );
    await rq2.markNotified(e2e.id);
    // Backdate createdAt/notifiedAt well past BOTH gates - the nominal (deadlineAt - LIVE_LEAD) point
    // AND the MIN_GAP-after-the-ask clamp - so the reminder is unambiguously due without waiting on
    // real wall-clock time. Sized off LIVE_LEAD rather than a literal so raising the shipped lead
    // can never quietly turn this into a no-op tick that still asserts reminded === 1.
    const LIVE_LEAD = require('../src/config').reminderLeadMs;
    await rq2.store.patchDoc(COLLECTION, e2e.id, { createdAt: Date.now() - LIVE_LEAD - 120_000, notifiedAt: Date.now() - LIVE_LEAD - 120_000 });
    const discovery2 = new DiscoveryPoller({
      adapter: { listAuctions: async () => [] }, // nothing new to discover this tick - only the reminder path is under test
      requests: rq2, notifier: notifier2,
      // RM4 (Syngenta) must be genuinely in scope for the reminder to fire: an empty allowlist is
      // fail-closed (matches nothing), so name the shipper explicitly.
      config: { allowlist: { shippers: ['syngenta'] }, priceDeadlineLeadMs: 35_000, reminderLeadMs: LIVE_LEAD },
    });
    const tickResult = await discovery2.tick();
    ok(tickResult.reminded === 1, `discovery tick reminded exactly 1 request, got ${tickResult.reminded}`);
    ok((await rq2.getByToken(e2e.id)).reminderSentAt != null, 'reminderSentAt stamped after the delivered reminder send');
    const tickResult2 = await discovery2.tick();
    ok(tickResult2.reminded === 0, 'a second tick does not re-remind the same request');
  }

  // ---- pricing-lead fallback sources config.js's default; `??` honors an explicit 0 (F1) ----
  // The two live fallbacks used to hardcode `|| 90_000`. They now source config.priceDeadlineLeadMs
  // (the single source of truth): discovery with `??` (honors a deliberate 0), priceRequests'
  // recompute with `||` (deadlineAt is an absolute timestamp, so any falsy value must recompute).
  {
    const cfgDefaultLead = require('../src/config').priceDeadlineLeadMs;
    const CLOSE = now + 10 * 60000;
    const far = { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: CLOSE, startsAt: now - 1000, status: 'live', softClose: false };

    // (a) config omits priceDeadlineLeadMs -> discovery falls back to config.js's default lead,
    //     NOT the retired hardcoded 90s.
    const rqDef = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: MARGINS, minMarginPct: MIN });
    const discDef = new DiscoveryPoller({ adapter: { listAuctions: async () => [{ id: 'LEAD_DEF', ...far }] }, requests: rqDef, notifier, config: { allowlist: { shippers: ['syngenta'] } } });
    await discDef.tick();
    ok((await rqDef.getByLoad('LEAD_DEF')).deadlineAt === CLOSE - cfgDefaultLead,
      'lead absent from config -> deadlineAt uses config.js default lead (single source of truth), not a hardcoded 90s');

    // (b) explicit priceDeadlineLeadMs:0 -> honored via `??` (deadline == close), not bumped to a lead.
    const rqZero = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: MARGINS, minMarginPct: MIN });
    const discZero = new DiscoveryPoller({ adapter: { listAuctions: async () => [{ id: 'LEAD_ZERO', ...far }] }, requests: rqZero, notifier, config: { allowlist: { shippers: ['syngenta'] }, priceDeadlineLeadMs: 0 } });
    await discZero.tick();
    ok((await rqZero.getByLoad('LEAD_ZERO')).deadlineAt === CLOSE,
      'explicit priceDeadlineLeadMs:0 honored (`??`, not `||`): deadline == close, no phantom lead');

    // (c) createForLoad with NO deadlineAt (e.g. the demo-seed path) recomputes closesAt minus
    //     config.js's default lead, not the retired hardcoded 90s (priceRequests fallback).
    const rqRc = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: MARGINS, minMarginPct: MIN });
    const made = await rqRc.createForLoad({ id: 'LEAD_RC', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: CLOSE, status: 'live' });
    ok(made.deadlineAt === CLOSE - cfgDefaultLead,
      'createForLoad without a deadlineAt recomputes closesAt - config.js default lead (not a hardcoded 90s)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
