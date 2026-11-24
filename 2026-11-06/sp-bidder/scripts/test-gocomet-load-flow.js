'use strict';
/**
 * THE LOAD PATH, end to end and offline: does a Waaree load as the LIVE PORTAL returns it reach the
 * operator's board as a persisted price request?
 *
 * This is the question the client deadline turns on, and until now nothing answered it executably.
 * The pieces were each covered alone - scripts/test-gocomet-adapter.js maps synthetic enquiries,
 * scripts/test-gocomet-live-fixture-flow.js pins the captured wire shape and calls
 * matchesAllowlist as a PREDICATE, scripts/test-shared-reader-platform-scope.js reads records that
 * were hand-seeded into the store, scripts/test-notify-platform-gating.js gates a hand-built load.
 * None of them runs the CHAIN. This file wires the real components together and turns one crank:
 *
 *   captured portal JSON -> GoCometAdapter.listAuctions -> DiscoveryPoller._tick
 *     -> PriceRequestStore.createForLoad -> the persisted record -> the board's readers
 *
 * Everything on that line is production code. The GoComet stack is composed by the real
 * buildGoCometStack out of the real src/config.js `gocomet` block, so the allowlist, the
 * `hardCloseOnly:false` pin and the account tag under test are the ones the box ships - not a
 * hand-written config that happens to agree with it today.
 *
 * TEST DOUBLES, and why each is at a true boundary:
 *   fetchImpl   - GoComet's HTTP API. Third-party network. Serves scripts/fixtures/gocomet/,
 *                 captured read-only from the live portal (see the README there).
 *   wa          - the Maytapi WhatsApp client. Third-party network, and the assertion target for
 *                 the commercial negative in S6.
 *   makeEngine / makeScheduler - NOT the seam. Arming happens after a human captures a cost, which
 *                 is a different question from this file's; buildGoCometStack requires them to
 *                 construct, so they are stubbed to keep the arm-side machinery out of the intake
 *                 test rather than to isolate anything from it.
 * The store, the PriceRequestStore, the Notifier, the adapter, the poller and the stack are all
 * real, and they talk to each other for real.
 *
 * THE ONE FIELD REBASED OFF THE FIXTURE, and why. `bid_close_timestamp` is moved to now + 45 min.
 * DiscoveryPoller reads the wall clock directly (discovery.js:368, expireOverdue, dueForReminder)
 * and takes no injectable now, so against the captured absolute close (2026-08-11 11:30 IST) this
 * file would have started reporting "load skipped, auction already closed" within the hour and gone
 * on passing nothing forever after. Every other byte is the portal's own. The absolute captured
 * value is pinned separately, under a frozen clock, by test-gocomet-live-fixture-flow.js - so the
 * two files together cover both the real instant and the real flow.
 *
 *   node scripts/test-gocomet-load-flow.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { buildGoCometStack, gocometAccount } = require('../src/platform/gocometStack');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { PriceRequestStore, isPlaceholderClose } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { resolveTargets } = require('../src/model/resolve');
const appConfig = require('../src/config');

const EXPECTED_CHECKS = 49;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const FIX = path.join(__dirname, 'fixtures', 'gocomet');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LIST = readFix('spot-enquiries.list.json');
const DETAIL = readFix('enquiry-detail.json');
const BIDDING = readFix('bidding-data.json');

const KEY = '2608115VVB';
const GC = 'gocomet';
const SP = appConfig.platformKey;

// The portal's own wire format for a close: ISO with millis at IST offset, exactly as captured
// ("2026-08-11T11:30:00.000+05:30"). Round-trips through Date.parse to the same instant.
const istWire = (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30');
const OPEN_MS = Math.floor((Date.now() + 45 * 60_000) / 1000) * 1000;

/** The captured list with `bid_close_timestamp` rebased, plus any per-case overrides. */
function listWith(over = {}, closeMs = OPEN_MS) {
  const l = JSON.parse(JSON.stringify(LIST));
  l.enquiries[0] = Object.assign(l.enquiries[0], { bid_close_timestamp: istWire(closeMs) }, over);
  return l;
}

const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

/** Routes the three captured endpoints. Anything else 404s, so an unexpected call is visible. */
function fixtureFetch(list) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init && init.method });
      const u = String(url);
      if (u.includes(`/enquiries/${KEY}/bidding-data`)) return resp(200, BIDDING);
      if (u.includes(`/enquiries/${KEY}`)) return resp(200, DETAIL);
      if (u.includes('/enquiries/spot')) return resp(200, list);
      return resp(404, { error: 'no_route' });
    },
  };
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86_400, user_id: 'u1', client_id: 'c1' })}.sig`;

/** Records every wire call and never touches the network. S6 asserts on THIS, not on a return value. */
function fakeWa() {
  const calls = [];
  return {
    calls,
    phoneId: '128023',
    enabled: () => true,
    sessionHealthy: async () => true,
    sendText: async (to, message, opts) => { calls.push({ fn: 'sendText', to, kind: opts && opts.kind }); return { ok: true, messageId: `m${calls.length}` }; },
    replyText: async (to, id, message, opts) => { calls.push({ fn: 'replyText', to, kind: opts && opts.kind }); return { ok: true, messageId: `m${calls.length}` }; },
    editText: async () => ({ ok: true }),
  };
}

// One unscoped subscriber to every kind, so a zero in S6 can only be the platform gate - never an
// unsubscribed kind or a scope miss.
const RECIPIENTS = [{
  name: 'Pricing Desk', phone: '+919000000001',
  alerts: ['price_needed', 'price_submitted', 'bid_live', 'outbid', 'won', 'lost', 'error', 'desk_notice'],
}];

/**
 * server.js's discoveryConfigFor, reproduced over the SAME production pieces it composes: the
 * account's own allowlist through the real resolveTargets, and the real config's lead/softClose
 * blocks. The box runs GoComet with no customers, people or assignments, so those are empty.
 */
function discoveryConfigFor(account) {
  return {
    allowlist: resolveTargets({
      account, fallbackAllowlist: account.allowlist, customers: [], people: [], assignments: [],
    }),
    priceDeadlineLeadMs: appConfig.priceDeadlineLeadMs,
    reminderLeadMs: appConfig.reminderLeadMs,
    softClose: appConfig.softClose,
  };
}

/** The whole GoComet intake chain, real components, one injected HTTP boundary. */
function harness(list) {
  const f = fixtureFetch(list);
  const store = new MemoryStore();
  const wa = fakeWa();
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 4, platformKey: SP });
  const notifier = new Notifier({
    mode: 'whatsapp',                                  // SuperProcure stays live; GoComet is gated per record
    platformModes: { [GC]: appConfig.gocomet.notifyMode },
    baseUrl: 'http://box', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => RECIPIENTS,
  });
  const adapter = new GoCometAdapter({
    token: token(), fetchImpl: f.fetchImpl, sleep: async () => {}, log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  });
  const stack = buildGoCometStack({
    adapter, gc: appConfig.gocomet, requests, notifier, discoveryConfigFor,
    makeEngine: () => ({}), makeScheduler: () => ({}), log: () => {},
  });
  return { f, store, wa, requests, notifier, adapter, stack };
}

(async () => {
  // ================================================================================
  // S0. The scope under test is the SHIPPED one, derived from src/config.js.
  // A test that hand-wrote { shippers: ['Waaree'], hardCloseOnly: false } would pass
  // just as green on a box configured to surface nothing.
  // ================================================================================
  {
    const account = gocometAccount(appConfig.gocomet);
    const al = discoveryConfigFor(account).allowlist;
    ok(al.shippers.includes('Waaree'),
      `S0: the shipped GoComet allowlist carries Waaree - got ${JSON.stringify(al.shippers)}`);
    // catches: hardCloseOnly flipped to true in gocometStack - every GoComet load is softClose:true,
    // so the poller would surface ZERO loads with no error anywhere (auditor F1/F5 signature).
    ok(al.hardCloseOnly === false,
      'S0: hardCloseOnly is FALSE on the GoComet account - the pin the whole load path rests on');
    ok(appConfig.gocomet.platformKey === GC && account.accountId === GC,
      'S0: the portal key and account id are both \'gocomet\'');
  }

  // ================================================================================
  // S1. ONE TICK: the live-shaped Waaree load becomes a persisted price request.
  // This is the answer to "will GoComet loads reach the desk".
  // ================================================================================
  const H = harness(listWith());
  {
    const res = await H.stack.discovery.tick();
    // catches: adapter returns [] silently (auditor F5 close-time source, F18 status-0 transport
    // collapse, F19 cooldown) - all three look identical to an empty board without this pair.
    ok(res.scanned === 1, `S1: the tick SCANNED the one real enquiry - got ${res.scanned}`);
    ok(res.created === 1, `S1: the tick CREATED one price request - got ${res.created}`);

    const all = await H.requests.listAll();
    ok(all.length === 1, `S1: exactly one record persisted - got ${all.length}`);
    const req = all[0];

    // catches: platformKey dropped on the create path - the record would read as SuperProcure's
    // (platformOf's absent-means-sp fallback) and fold into the client-facing participation figure.
    ok(req.platformKey === GC, `S1: the record is tagged 'gocomet' - got ${JSON.stringify(req.platformKey)}`);
    ok(req.loadId === KEY, `S1: loadId is the portal's enquiry key - got ${req.loadId}`);
    // catches: the stack's `tag` dropped. stackForRequest falls back to stacks[0] - a SuperProcure
    // stack - on an untagged request, which arms the SP engine against a GoComet enquiry key and
    // refuses the desk's cost OUT_OF_SCOPE at capture (auditor F4/F14).
    ok(req.account && req.account.accountId === GC,
      `S1: the record carries the GoComet account tag - got ${JSON.stringify(req.account)}`);
    ok(req.status === 'awaiting_price', `S1: status awaiting_price - got ${req.status}`);

    // The snapshot the desk page and every downstream gate read. Values are the PORTAL'S, so a stub
    // returning a correctly-shaped empty load fails every line here.
    const L = req.load;
    ok(L.companyName === 'Waaree Energies Ltd.',
      `S1: companyName is the shipper off client_company_name - got ${JSON.stringify(L.companyName)}`);
    ok(L.units === 1, `S1: units 1, from the detail enrichment (cargo_quantity) - got ${L.units}`);
    ok(L.quoteType === 'FTL', `S1: quoteType FTL, from cargo_unit TRUCK - got ${JSON.stringify(L.quoteType)}`);
    ok(L.cargoLines === 1, `S1: one cargo line, so the multi-cargo refusal does not fire - got ${L.cargoLines}`);
    ok(L.closesAt === OPEN_MS, `S1: closesAt is the portal's own close - got ${L.closesAt}, expected ${OPEN_MS}`);
    // catches: softClose/closeModelKnown dropped from the snapshot - the capture-time scope backstop
    // in server.js reads them off the PERSISTED load, not off the adapter.
    ok(L.softClose === true && L.closeModelKnown === true,
      `S1: the close-model boolean pair survives the snapshot - got ${L.softClose}/${L.closeModelKnown}`);
    // catches: per-enquiry slab_rate replaced by the coarse capabilities() fallback - the ladder
    // step would be wrong on every rung of every bid.
    ok(L.rules && L.rules.minDecrement === 300,
      `S1: the per-enquiry minDecrement (slab_rate 300) is snapshotted - got ${JSON.stringify(L.rules)}`);
    ok(L.lane && /Degam/.test(L.lane.origin) && /Kottayam/.test(L.lane.destination),
      `S1: the lane is the portal's real origin/destination - got ${JSON.stringify(L.lane)}`);

    // catches: off-by-one / wrong source on the pricing cutoff.
    ok(req.deadlineAt === OPEN_MS - appConfig.priceDeadlineLeadMs,
      `S1: deadlineAt is closesAt minus the configured lead - got ${req.deadlineAt}`);
    // catches: the margin band not resolved at create - the desk page would price against nothing.
    assert.deepStrictEqual(req.marginsPct, [12, 8, 5]);
    ok(req.minMarginPct === 4 && req.marginSource === 'default',
      `S1: the band snapshot resolved to the store's defaults - got ${req.minMarginPct}/${req.marginSource}`);
    // catches: markNotified skipped on the dashboard channel - discovery would re-fire the ask on
    // every tick forever (the notified===false re-notify branch).
    ok(req.notified === true, 'S1: the request is marked notified, so discovery never re-fires the ask');

    // The enrichment really cost a detail GET; units/minDecrement are not the unenriched
    // degradation path wearing the same shape.
    ok(H.f.calls.some((c) => c.url.includes(`/enquiries/${KEY}`) && !c.url.includes('bidding-data')),
      'S1: the enquiry detail was really fetched');
  }

  // ================================================================================
  // S2. The readers the operator's board is built from. The recent platform-scoped
  // readers must not SWALLOW the row from the surfaces one desk actually works.
  // ================================================================================
  {
    const open = await H.requests.listOpen();
    ok(open.length === 1 && open[0].loadId === KEY,
      `S2: the request is on the awaiting-price worklist - got ${open.length} row(s)`);
    const all = await H.requests.listAll();
    // catches: an over-eager scope filter on the all-portal operator reads (/api/state,
    // /api/price-requests) - the desk that must price this load would never see it.
    ok(all.some((r) => r.loadId === KEY),
      'S2: the ALL-PORTAL operator read still returns it - one desk works both portals');
    const gcRows = await H.requests.listFor(GC);
    ok(gcRows.length === 1 && gcRows[0].loadId === KEY,
      `S2: listFor('gocomet') returns it - got ${gcRows.length}`);
    const spRows = await H.requests.listFor(SP);
    // catches: platform scope dropped - a GoComet row folded into SuperProcure's client-facing
    // participation percentage, invisibly.
    ok(spRows.length === 0, `S2: listFor('sp') does NOT return it - got ${spRows.length}`);
    ok((await H.requests.getByLoad(KEY, GC)) !== null, 'S2: getByLoad scoped to gocomet finds it');
    ok((await H.requests.getByLoad(KEY, SP)) === null, 'S2: getByLoad scoped to sp does not');
  }

  // ================================================================================
  // S3. IDEMPOTENCY. Discovery re-lists the same open enquiry every ~50s for the whole
  // auction. A second tick must find the existing record, not mint a second one.
  // ================================================================================
  {
    const firstId = (await H.requests.listAll())[0].id;
    const waBefore = H.wa.calls.length;
    const res2 = await H.stack.discovery.tick();
    // catches: the getByLoad existence check dropped or scoped wrong - a duplicate row per tick,
    // each with its own capture link, and the desk pricing whichever it happened to open.
    ok(res2.created === 0, `S3: a second tick over the same board creates NOTHING - got ${res2.created}`);
    const all = await H.requests.listAll();
    ok(all.length === 1 && all[0].id === firstId,
      `S3: still exactly one record, same token - got ${all.length}`);
    // catches: refreshLiveClose rewriting the snapshot. The desk was told closesAt; that is what
    // must stay legible beside whatever the platform later does (liveClosesAt is the other field).
    ok(all[0].load.closesAt === OPEN_MS,
      `S3: the write-once close snapshot is unchanged by the re-list - got ${all[0].load.closesAt}`);
    ok(H.wa.calls.length === waBefore, 'S3: and no second notification attempt was made');
  }

  // ================================================================================
  // S4. THE CROSS-PORTAL RECONCILE - runs on its OWN store, because case B is
  // destructive and must not be what the later sections observe.
  //
  // Every discovery tick ends in requests.dropOutOfScope(matchFn, {owner}), and
  // dropOutOfScope is deliberately CROSS-PLATFORM (priceRequests.js:829): with a null
  // owner it evaluates EVERY awaiting record - including this GoComet one - against the
  // CALLING poller's allowlist. A SuperProcure allowlist is hardCloseOnly:true and does
  // not carry Waaree, while the GoComet snapshot is softClose:true, so matchesAllowlist
  // returns false for it. Whether the record survives rests entirely on the owner tag.
  // ================================================================================
  {
    const H4 = harness(listWith());
    await H4.stack.discovery.tick();
    ok((await H4.requests.listFor(GC)).length === 1, 'S4: the probe store starts with one GoComet request');

    const spConfig = {
      allowlist: { shippers: ['Havells', 'KEI'], lanes: [], hardCloseOnly: true },
      priceDeadlineLeadMs: appConfig.priceDeadlineLeadMs,
      softClose: appConfig.softClose,
    };
    // An SP portal listing nothing this tick. It is a PORTAL (the far boundary), not an internal
    // collaborator - the question is what the SP poller's reconcile does to another portal's rows.
    const emptySp = { listAuctions: async () => [] };

    // A. THE DEPLOYED SHAPE. server.js:5244 tags a stack `multi ? {accountId,label} : null` and
    // multi is accounts.length > 1 (:5220); the box runs six enabled SuperProcure accounts, so
    // every SP poller carries a tag and the reconcile is owner-scoped.
    const tagged = new DiscoveryPoller({
      adapter: emptySp, requests: H4.requests, notifier: H4.notifier, config: spConfig,
      account: { accountId: 'primary', label: 'Primary' }, platformKey: SP,
    });
    const taggedRes = await tagged.tick();
    // catches: the owner guard at priceRequests.js:838 removed - the SP poller would hard-delete
    // every GoComet request each tick, the desk's capture link would 404, the token would churn,
    // and the only trace is an aggregate "dropped N ... no longer in scope" naming no portal.
    ok((await H4.requests.listFor(GC)).length === 1 && taggedRes.dropped === 0,
      `S4A: an owner-TAGGED SuperProcure poller leaves the GoComet request alone - dropped ${taggedRes.dropped}`);

    // B. The same protection WITHOUT an owner tag, which is where it used to fail.
    //
    // The owner tag is null whenever only one SuperProcure account is enabled, so a guard that
    // rests on owner alone protects nothing on that box. Portal scoping is what holds here: the
    // reconcile only ever retires records of the portal whose poller is running, so a foreign
    // record survives a poller carrying no tag at all.
    //
    // This is the harder half of S4A and must stay independent of it. `dropOutOfScope` is the
    // one sweep that hard-deletes rather than marking a status, so a regression here is silent
    // at the pricing layer: the record is gone, not flagged, and nothing downstream can tell it
    // from a load that was never discovered.
    const untagged = new DiscoveryPoller({
      adapter: emptySp, requests: H4.requests, notifier: H4.notifier, config: spConfig,
      account: null, platformKey: SP,
    });
    const spRes = await untagged.tick();
    ok((await H4.requests.listFor(GC)).length === 1 && spRes.dropped === 0,
      `S4B: an UNTAGGED SuperProcure poller also leaves the GoComet request alone - dropped ${spRes.dropped}`);
    ok((await H4.requests.getByLoad(KEY, GC)) !== null,
      'S4B: and the record is still retrievable by load - the desk capture link survives the sweep');
  }

  // ================================================================================
  // S5. The admission is REAL, not unconditional. Each case is the SAME captured
  // enquiry with ONE field changed, so nothing but that field can explain the result.
  // ================================================================================
  {
    // catches: the shipper allowlist comparison inverted or dropped - the board would flood with
    // every shipper's loads (the 2026-07-14 match-all incident, on a second portal).
    const wrong = harness(listWith({ client_company_name: 'Some Other Shipper Ltd.' }));
    const r1 = await wrong.stack.discovery.tick();
    ok(r1.scanned === 1 && r1.created === 0,
      `S5: a non-allowlisted shipper is REFUSED (scanned ${r1.scanned}, created ${r1.created})`);
    ok((await wrong.requests.listAll()).length === 0, 'S5: and nothing was persisted for it');

    // catches: the already-closed skip removed - a price request, an ask and a capture link for an
    // auction that stopped accepting bids, then filed 'skipped_no_price' against the desk.
    const pastMs = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;
    const past = harness(listWith({}, pastMs));
    const r2 = await past.stack.discovery.tick();
    ok(r2.scanned === 1, `S5: the already-closed enquiry still MAPS (scanned ${r2.scanned}) - it is discovery that skips it`);
    ok(r2.created === 0 && (await past.requests.listAll()).length === 0,
      'S5: a load whose close has already passed creates no price request');

    // catches: the adapter's close-time plausibility bound removed. A far-future placeholder parses
    // as a valid date, so nothing throws - it becomes a forever-armed load whose countdown never
    // reaches zero (the ~74-year record this codebase has already shipped once).
    const farMs = Date.parse('2100-01-01T00:00:00.000+05:30');
    const far = harness(listWith({}, farMs));
    const r3 = await far.stack.discovery.tick();
    ok(r3.scanned === 0,
      `S5: the absurd far-future close is EXCLUDED by the adapter, never mapped - scanned ${r3.scanned}`);
    ok(r3.created === 0 && (await far.requests.listAll()).length === 0,
      'S5: and no price request exists for it');
    // Names WHY it was excluded, so a bound that merely moved is distinguishable from one removed.
    ok(isPlaceholderClose(farMs) === true,
      'S5: that close is a placeholder by the pricing layer\'s own predicate too (second line of defence)');
  }

  // ================================================================================
  // S6. THE COMMERCIAL NEGATIVE. GoComet is console-only (GC_NOTIFY_MODE defaults to
  // 'dashboard'): a load must surface on every internal surface and send no WhatsApp.
  // Asserted on the injected client's call log - a return value of true is also what a
  // successful send gives back.
  // ================================================================================
  {
    ok(appConfig.gocomet.notifyMode === 'dashboard',
      `S6: the shipped GoComet channel is dashboard-only - got ${appConfig.gocomet.notifyMode}`);
    // catches: the per-record notify gate removed or inverted - every Waaree load would message the
    // customer group from a portal the desk has not signed off on.
    ok(H.wa.calls.length === 0,
      `S6: the whole GoComet load path put ZERO calls on the WhatsApp client - got ${H.wa.calls.length}`);

    // The zero above must be the GATE, not a broken fake or an unsubscribed kind. Same notifier,
    // same client: an SP-tagged request on it DOES reach the wire.
    const spReq = await H.requests.createForLoad(
      { id: '23400777', companyName: 'Havells', lane: { origin: 'Chikhli', destination: 'Bawal' }, units: 1, quoteType: 'FTL', closesAt: OPEN_MS },
      { platformKey: SP },
    );
    const out = await H.notifier.requestPrice(spReq);
    ok(H.wa.calls.length === 1 && out.channel === 'whatsapp',
      `S6: an SP request on the SAME notifier and client DOES send - ${H.wa.calls.length} call(s), channel ${out.channel}`);

    // ...and the GoComet load still got everything a dashboard-only load is supposed to get.
    const gcReq = (await H.requests.listFor(GC))[0];
    const gcOut = await H.notifier.requestPrice(gcReq);
    ok(gcOut.channel === 'dashboard' && gcOut.delivered === true,
      `S6: the GoComet ask resolves the dashboard channel and reports delivered - ${JSON.stringify({ channel: gcOut.channel, delivered: gcOut.delivered })}`);
    ok(typeof gcOut.link === 'string' && gcOut.link.endsWith(gcReq.id),
      'S6: and still yields the public capture link carrying the request token');
    ok(H.wa.calls.length === 1, 'S6: that GoComet ask added no wire call');
  }

  // ---- completion sentinel ----
  // scripts/run-tests.js grades by EXIT CODE alone, so an early return or a swallowed throw would
  // otherwise exit 0 as a green zero-assertion run. Pin the count that actually executed.
  assert.strictEqual(fail, 0, `${fail} GoComet load-path checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
