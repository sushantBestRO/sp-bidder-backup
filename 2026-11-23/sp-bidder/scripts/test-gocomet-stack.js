'use strict';
/**
 * The GoComet stack's four gates, its account record, and its boot isolation.
 *
 * THE REGRESSION THAT MATTERS MOST IS THE NEGATIVE ONE (scenario A). A previous attempt armed live
 * third-party polling on the mere presence of a READ token, outside the mode gate, with no way to
 * stop it short of editing .env and restarting. GC_ENABLE is deliberately a DIFFERENT variable from
 * GC_TOKEN, and with it unset a box holding a token must behave exactly as it did before this
 * stack existed: the adapter registers on the token-expiry rail and nothing else is constructed.
 *
 * THE SECOND (scenario B) is the account record. server.js's stackForRequest resolves a price
 * request's owning stack by portal AND account id, and the tag is what stamps the account onto
 * every request discovery creates - without it a GoComet capture would resolve to the wrong stack
 * of its own portal. So this asserts ENGINE IDENTITY, not merely that a lookup returned something.
 * The cross-PORTAL half of that resolution - a GoComet request never borrowing SuperProcure's
 * engine once its own stack is gone - is scripts/test-platform-scoped-arm.js.
 *
 * Each scenario needs its own env and its own boot(), and server.js boots once per process, so this
 * file re-execs itself once per scenario and aggregates. Deterministic and offline: both adapters'
 * network methods are monkey-patched on the shared prototype before anything is constructed.
 *
 *   A. GC_ENABLE unset, GC_TOKEN set -> adapter registers, NO stack, NO engine, NO scheduler file,
 *      and the single SuperProcure account stays untagged (byte-identical output).
 *   B. both set -> the stack is built, is in `stacks`, owns its own intents file and shipper scope,
 *      and a GoComet-tagged request resolves to the GoComet engine and not to stacks[0].
 *   C. the console toggle (gocometDiscovery) stops and starts discovery around the SAME stack and
 *      the SAME engine - it is a poller switch, not a teardown. Runs in B's process.
 *   D. a throw inside stack construction does not stop SuperProcure booting.
 *   E. /api/auctions labels every row with its portal, over real HTTP. The Live Bids page was
 *      otherwise inferring the portal by joining each row back to its price request - which reads
 *      as SuperProcure for any armed row whose request has gone.
 *
 *   node scripts/test-gocomet-stack.js
 */
const fs = require('fs'); // allowed: test harness (temp dirs + subprocess), not app state
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

// Every check across all three child processes. The runner grades by EXIT CODE, so a file (or a
// child) that returned early would otherwise be a silent green zero-assertion run.
const EXPECTED_CHECKS = 75;
const SCENARIOS = ['gate-off', 'stack-on', 'build-failure', 'auctions-portal'];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// ---- shared fixtures ---------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** A structurally-valid JWT; the signature is never checked on the offline adopt path. */
const gcToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(Date.now() / 1000) + 300 * 86400, user_id: 'gc-u1', client_id: 'gc-c1' })}.sig`;

const FAKE_SP_IDENTITY = () => ({
  carrierId: 9001, branchIds: [1, 2, 3], isCarrier: true, company: 'Test Co',
  user: 'Test User', userId: 'u1', tokenExp: Date.now() + 365 * 86400000, serverTimeOffsetMs: 0,
});

/** One raw GoComet spot enquiry on the default shipper scope, close time inside the adapter's bound. */
function rawEnquiry(over = {}) {
  return Object.assign({
    key: 'GC-STACK-1',
    bid_close_timestamp: new Date(Date.now() + 45 * 60_000).toISOString(),
    origin: 'Bhiwandi', destination: 'Hosur', mode: '32ft SXL',
    bidding_closed: false, name: 'Spot enquiry', client_company_name: 'Waaree Energies',
  }, over);
}

/** Env every child shares: real mode (the only path that builds stacks), offline, ephemeral. */
function childEnv(dir, extra) {
  const env = Object.assign({}, process.env, {
    PLATFORM: 'real', STORE_BACKEND: 'memory', PORT: '0',
    SP_ADMIN_PASS_HASH: 'test-hash', SP_SESSION_SECRET: 'test-session-secret',
    SP_DATA_DIR: dir, SP_TOKEN: 'good-token-primary',
    SP_WHATSAPP_ENABLED: '0',
  }, extra);
  delete env.SP_DEMO_SEED; delete env.SP_TOKEN_2; delete env.SP_TOKEN_3;
  return env;
}

/** Silence both adapters' network before anything is constructed. Returns the GoComet prototype. */
function patchAdapters({ enquiries = [] } = {}) {
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  RealSuperProcureAdapter.prototype.login = async function () { this.account = FAKE_SP_IDENTITY(); return this.account; };
  RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };
  RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };
  const { GoCometAdapter } = require('../src/platform/gocometAdapter');
  // login() is already offline (it adopts + parses the configured JWT). Only the LIST path reaches
  // the network, and discovery.start() fires a tick immediately.
  GoCometAdapter.prototype.listAuctions = async function () {
    return enquiries.map((e) => this._mapEnquiry(e)).filter(Boolean);
  };
  return GoCometAdapter;
}

// ---- scenario A: the gate is off -----------------------------------------------------------------

async function scenarioGateOff() {
  patchAdapters();
  const srv = require('../src/web/server');
  await srv.boot();

  ok(!!srv.gocometAdapter, 'A: GC_TOKEN alone still registers the adapter (the token-expiry rail keeps working)');
  ok(srv.gocometStack === null, 'A: GC_ENABLE unset -> NO stack is constructed (the gate is the token, not GC_TOKEN)');
  ok(srv.stacks.length === 1, `A: only the SuperProcure account is in stacks (got ${srv.stacks.length})`);
  ok(!srv.stacks.some((s) => s.account.accountId === 'gocomet'), 'A: nothing GoComet-shaped reached the stacks array');
  // The byte-identical claim, stated as the thing that would actually break: one SP account keeps a
  // null tag, so every event, stored record and message stays unlabelled exactly as before.
  ok(srv.stacks[0].tag === null, 'A: the single SuperProcure account stays UNTAGGED - output is byte-identical to today');
  // No scheduler means no durable-intent file. Checked on disk because that file is the one
  // artefact a stack leaves behind even if every in-memory trace were tidied away.
  const stray = fs.readdirSync(process.env.SP_DATA_DIR).filter((f) => /gocomet/i.test(f));
  ok(stray.length === 0, `A: no GoComet intents file was ever created (found ${JSON.stringify(stray)})`);

  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
}

// ---- scenarios B + C: the stack is on ------------------------------------------------------------

async function scenarioStackOn() {
  patchAdapters({ enquiries: [rawEnquiry()] });
  const srv = require('../src/web/server');
  const {
    INERT_MECHANISMS, capabilityGaps, surfaceCapabilityGaps, capabilityWarnings, buildGoCometStack,
    ENGINE_CAPABILITY_READS, SURFACE_CAPABILITY_READS,
  } = require('../src/platform/gocometStack');
  await srv.boot();

  const gc = srv.gocometStack;
  ok(!!gc, 'B: GC_ENABLE=1 + GC_TOKEN -> the stack is built');
  if (!gc) throw new Error('no GoComet stack - the rest of B/C cannot be asserted');

  ok(srv.stacks.includes(gc), 'B: the stack is IN `stacks` (not a side object stackForRequest cannot see)');
  ok(srv.stacks.length === 2, `B: alongside the one SuperProcure account (got ${srv.stacks.length})`);
  ok(srv.stacks[0].tag === null,
    'B: adding it does NOT start labelling the single SuperProcure account - it is not a second SP account');

  // ---- the account record, and what it buys ----
  const acct = gc.account;
  ok(acct.accountId === 'gocomet', 'B: the account record carries accountId "gocomet"');
  ok(acct.tokenEnv === 'GC_TOKEN', 'B: it references the token by ENV VAR NAME');
  ok(acct.token === undefined, 'B: and never carries the token itself (validateAccount refuses a secret)');
  ok(!!gc.tag && gc.tag.accountId === 'gocomet',
    'B: the tag is set unconditionally - it is what stamps the owner onto every request discovery creates');

  // THE ASSERTION THIS FILE EXISTS FOR. Engine identity, not "something came back".
  // The fixture carries platformKey because every record discovery creates does (createForLoad
  // stamps the poller's key); resolution reads the portal, and an untagged-but-gocomet-accounted
  // record is a shape the system cannot produce - platformOf defines absent as SuperProcure
  // precisely because nothing was writing the field before GoComet existed.
  const mine = srv.stackForRequest({ account: { accountId: 'gocomet' }, platformKey: 'gocomet' });
  ok(mine === gc, 'B: a GoComet-tagged request resolves to the GoComet stack');
  ok(mine.engine === gc.engine && mine.engine !== srv.stacks[0].engine,
    'B: ...to the GoComet ENGINE, not the SuperProcure one at stacks[0]');
  ok(srv.stackForRequest({ account: { accountId: 'primary' } }).engine === srv.stacks[0].engine,
    'B: and a SuperProcure request still resolves to its own engine');
  // An untagged request is a SuperProcure request by construction, so stacks[0] is the RIGHT
  // answer for it - and the only one. The portal, not the account record, is what now keeps a
  // GoComet request off this engine: see scripts/test-platform-scoped-arm.js for the case that
  // used to land here (a GoComet record resolving to stacks[0] once its own stack is gone).
  ok(srv.stackForRequest({}).engine === srv.stacks[0].engine,
    'B: an untagged request resolves to stacks[0] - the pre-GoComet records that default names');

  // ---- its own durable intents file, mirroring the multi-account pattern ----
  const config = require('../src/config');
  ok(gc.scheduler.filePath === config.intentsFileFor('gocomet')
    && gc.scheduler.filePath !== config.intentsFile,
  'B: the scheduler writes its OWN intents file, never the SuperProcure one');

  // ---- scoping: its own shipper allowlist, and NOT hard-close-only ----
  const al = acct.allowlist || {};
  ok(Array.isArray(al.shippers) && al.shippers.length > 0,
    'B: the account carries its own shipper scope (an empty one matches NOTHING - fail closed)');
  ok(al.hardCloseOnly === false,
    'B: it is NOT hard-close-only - every GoComet load is soft, so a hard-close-only scope surfaces zero of them');
  ok(gc.discovery.platformKey === 'gocomet', 'B: the poller feeds the gocomet portal namespace');
  // ...and the separate lever stays untouched: enrolling the shipper in softClose.shippers would
  // also flip bidEngine._resolveSoftStrategy for any SuperProcure shipper whose name token-matches.
  ok(!(config.softClose && (config.softClose.shippers || []).some((s) => /waaree/i.test(s))),
    'B: the GoComet scope did NOT get there by enrolling the shipper in softClose.shippers');

  // ---- invariant 8: what the engine will silently do without ----
  ok(capabilityGaps(gc.adapter.capabilities()).length === 0,
    'B: the adapter declares every capabilities() key the engine reads');
  // Keeps INERT_MECHANISMS honest: each declared-inert field must really be absent from the
  // adapter's state. When the adapter starts publishing one, this fails and the entry comes out.
  const state = await gc.adapter.getAuctionState('GC-STACK-1').catch(() => null);
  for (const m of INERT_MECHANISMS) {
    ok(!state || state[m.field] === undefined,
      `B: '${m.field}' is genuinely absent from the adapter's state - the inert-mechanism declaration is not stale`);
  }

  // ---- invariant 8, SURFACE half: what the desk PAGE will silently MISSTATE without ----
  //
  // The engine half above catches "a price may be wrong". This half catches "the desk is told
  // something the adapter never said", which nothing else anywhere would report: every one of these
  // omissions degrades to a render that looks entirely normal.
  ok(surfaceCapabilityGaps(gc.adapter.capabilities()).length === 0,
    'B: the adapter declares every capabilities() key the desk price page reads');
  ok(Array.isArray(gc.surfaceCapabilityGaps) && gc.surfaceCapabilityGaps.length === 0,
    'B: ...and the built stack settled that at CONSTRUCTION, not on the first render');
  ok(!capabilityWarnings(gc).some((w) => /desk price page/.test(w)),
    'B: a complete adapter produces no surface-capability boot warning');
  // The lists stay disjoint on purpose. A key in both is two places to remove it from, and the
  // second is the one that gets missed - revisionLimit is read by BOTH layers and has ONE entry.
  ok(!SURFACE_CAPABILITY_READS.some((k) => ENGINE_CAPABILITY_READS.includes(k)),
    'B: no capability sits in both read lists - one fact, one entry');
  ok(ENGINE_CAPABILITY_READS.includes('revisionLimit') && !SURFACE_CAPABILITY_READS.includes('revisionLimit'),
    'B: revisionLimit, read by the engine AND the page, is listed once');

  // THE REMOVAL DEMONSTRATION, built through the real buildGoCometStack so the assert under test is
  // the one that runs at boot. extensionCeiling is the dangerous omission: absent reads as "the cap
  // is unknown", so the close badge falls back to SuperProcure's BOUNDED "Soft - limited" wording
  // on an auction observed running 22 extension rounds - and the revision-budget note that would
  // have corrected it is gated on the same key, so one omission removes the warning and its
  // correction together.
  {
    const full = gc.adapter.capabilities();
    const short = Object.assign({}, full);
    delete short.extensionCeiling;
    // The fixture removes a key whose REAL declared value is null. That is the whole reason the
    // check tests presence rather than truthiness: a truthiness test cannot tell this deletion from
    // the honest declaration, and would call the most load-bearing value in the list a gap.
    ok(full.extensionCeiling === null && !Object.prototype.hasOwnProperty.call(short, 'extensionCeiling'),
      'B: the fixture deletes a key whose declared value is null - exactly what truthiness would misread');
    const gap = buildGoCometStack({
      adapter: { capabilities: () => short },
      gc: {
        accountId: 'gocomet-gap', accountLabel: 'GoComet gap fixture', tokenEnv: 'GC_TOKEN',
        allowlistShippers: ['waaree'], allowlistLanes: [], platformKey: 'gocomet',
      },
      makeEngine: () => ({}), makeScheduler: () => ({}), discoveryConfigFor: () => ({}),
      requests: null, notifier: null,
    });
    ok(gap.surfaceCapabilityGaps.join(',') === 'extensionCeiling',
      'B: a stack whose adapter omits extensionCeiling records the gap AT CONSTRUCTION');
    ok(gap.capabilityGaps.length === 0,
      'B: ...and it is attributed to the SURFACE list alone - the engine list is clean, because the engine is not what breaks');
    const warns = capabilityWarnings(gap);
    ok(warns.some((w) => w.includes("'extensionCeiling'") && /desk price page/.test(w)),
      'B: boot reports it, naming the page as the thing that will state something it cannot know');
    ok(!warns.some((w) => w.includes("'extensionCeiling'") && /the engine falls back/.test(w)),
      'B: ...and never through the engine sentence - the layer named IS the diagnosis at 2am');
  }

  // ---- discovery: the poller surfaces a load, tagged to the right portal AND the right account ----
  await gc.discovery.tick();
  const reqs = await srv.requests.listAll();
  const surfaced = reqs.find((r) => r.loadId === 'GC-STACK-1');
  ok(!!surfaced, 'B: the poller surfaced the enquiry as a price request');
  ok(!!surfaced && surfaced.platformKey === 'gocomet', 'B: tagged platformKey "gocomet" - the desk worklist can tell the portals apart');
  ok(!!surfaced && surfaced.account && surfaced.account.accountId === 'gocomet',
    'B: and tagged to the GoComet account, which is what routes a later capture to the right engine');
  ok(!!surfaced && srv.stackForRequest(surfaced).engine === gc.engine,
    'B: end to end - the request the poller actually created resolves to the GoComet engine');

  // The account record's SECOND consequence, and it is what makes the desk experience coherent:
  // POST /price's scope backstop resolves its effective allowlist through stackForRequest as well.
  // On the fallback (stacks[0], hard-close-only) this load would be refused OUT_OF_SCOPE - the desk
  // invited to price a load it is then blocked from pricing, the exact divergence softAdmitted was
  // extracted to close.
  const { isOutOfHardCloseScope } = require('../src/discovery/discovery');
  ok(!!surfaced && ((srv.stackForRequest(surfaced).account.allowlist || {}).hardCloseOnly) === false,
    'B: the capture backstop resolves the GoComet allowlist, so a GoComet capture is not refused OUT_OF_SCOPE');
  ok(!!surfaced && isOutOfHardCloseScope(surfaced.load) === true,
    'B: ...and the load genuinely IS out of hard-close scope, so the fallback stack would have refused it');

  // ---- the arm seam refuses, and the desk's number survives it ----
  // "Armed" means the load is being bid. On a portal whose write gate is shut it never will, so the
  // arm is refused rather than left to walk a ladder that throws on every rung. The refusal must
  // not cost the desk its work: the previous integration attempt's defect was a real cost typed
  // into a live page, discarded, and the load later reported unpriced.
  const captured = await srv.requests.capture(surfaced.id, { cost: 21000 });
  ok(captured.status === 'armed' && captured.price.cost === 21000,
    'B: capture() records the desk cost - the refusal is at the ARM seam, not the capture seam');

  let armErr = null;
  try { armFromRequestFor(gc.engine, captured); } catch (e) { armErr = e; }
  ok(!!armErr && armErr.code === 'PLATFORM_BIDDING_DISABLED',
    `B: arming on a portal that cannot bid is REFUSED with a specific code (got ${armErr && armErr.code})`);
  ok(gc.engine.snapshot().length === 0,
    'B: ...and no monitor exists - nothing walks a ladder every rung of which would throw');
  ok(gc.adapter.capabilities().biddingEnabled === false,
    'B: the refusal reads a declared CAPABILITY, not a platform name');
  ok(srv.stacks[0].adapter.capabilities().biddingEnabled === true,
    'B: SuperProcure declares it can bid, so the SP arm path is untouched');

  const held = await srv.requests.holdUnbiddable(surfaced.id, 'platform_bidding_disabled');
  ok(held.status === 'stopped', 'B: the refused request is parked, never left claiming "armed"');
  ok(held.price && held.price.cost === 21000,
    'B: the desk cost SURVIVES - reopen() would have nulled it and sent the row back to awaiting_price');
  ok(held.heldReason === 'platform_bidding_disabled',
    'B: and the record says the SYSTEM parked it, so it is not mistaken for an operator stop');

  // THE FALSE-UNPRICED CHECK. expireOverdue reads listOpen (awaiting_price only) and files what it
  // finds as 'skipped_no_price', which discovery reports as "no number entered". A request parked
  // on 'stopped' is outside that sweep, so the desk's own work can never be filed as their silence.
  const closesAt = (held.load && held.load.closesAt) || Date.now();
  const expired = await srv.requests.expireOverdue(closesAt + 60_000);
  ok(!expired.some((r) => r.id === surfaced.id),
    'B: expireOverdue does not sweep it even well past the close');
  const after = await srv.requests.getByToken(surfaced.id);
  ok(after.status !== 'skipped_no_price',
    'B: ...so it can never be logged as "no number entered" about a load the desk DID price');
  ok(after.price && after.price.cost === 21000, 'B: and the cost is still on the record afterwards');

  // ---- C. the console toggle ----
  ok(gc.discovery.timer === null, 'C: gocometDiscovery defaults OFF - the poller is not running after boot');

  const on = await srv.configStore.save({ gocometDiscovery: true });
  srv.applyConfigValues(on);
  ok(gc.discovery.timer !== null, 'C: saving gocometDiscovery:true starts the poller');
  ok(srv.gocometStack === gc && srv.stacks.includes(gc), 'C: ...without rebuilding the stack');
  ok(srv.stackForRequest(surfaced).engine === gc.engine, 'C: ...and without replacing the engine an armed load would be on');

  // Idempotent: DiscoveryPoller.start() overwrites its own handle, so a second start would orphan
  // the first interval and double the GET rate against a portal whose limiter is the reason the
  // adapter has a spacing gate at all.
  const handle = gc.discovery.timer;
  srv.applyConfigValues(await srv.configStore.save({ gocometDiscovery: true }));
  ok(gc.discovery.timer === handle, 'C: a repeat "on" is a no-op - it does not orphan the running interval');

  srv.applyConfigValues(await srv.configStore.save({ gocometDiscovery: false }));
  ok(gc.discovery.timer === null, 'C: saving gocometDiscovery:false stops the poller');
  ok(srv.stacks.includes(gc) && srv.gocometStack === gc, 'C: the stack stays built and inspectable while stopped');

  // A save of something else must not quietly re-arm it. This is the same predicate POST /api/config
  // now tests before restarting a poller on an interval change.
  srv.applyConfigValues(await srv.configStore.save({ minMarginPct: 6 }));
  ok(gc.discovery.timer === null, 'C: an unrelated Settings save leaves discovery OFF - the toggle does not undo itself');

  for (const s of srv.stacks) { try { if (s.discovery) s.discovery.stop(); } catch (_) {} }
}

// ---- scenario D: construction throws --------------------------------------------------------------

async function scenarioBuildFailure() {
  patchAdapters();
  // Patched BEFORE server.js is required, because server.js destructures the export at load time.
  const gcStackMod = require('../src/platform/gocometStack');
  gcStackMod.buildGoCometStack = () => { const e = new Error('gocomet stack blew up'); e.code = 'TEST'; throw e; };

  const srv = require('../src/web/server');
  const alerts = [];
  const original = srv.notifier.alert.bind(srv.notifier);
  srv.notifier.alert = async (kind, payload, opts) => { alerts.push({ kind, payload, opts }); return original(kind, payload, opts); };

  let bootError = null;
  try { await srv.boot(); } catch (e) { bootError = e; }

  ok(!bootError, `D: boot() resolves despite the GoComet stack throwing (threw: ${bootError && bootError.message})`);
  ok(srv.stacks.length === 1 && srv.stacks[0].account.accountId === 'primary',
    'D: the SuperProcure account is up and untouched');
  ok(!!srv.stacks[0].adapter.account, 'D: ...and actually logged in - SuperProcure booted through the failure');
  ok(srv.gocometStack === null, 'D: no half-built stack is left behind');
  ok(!srv.stacks.some((s) => s.account.accountId === 'gocomet'), 'D: and nothing GoComet-shaped is in `stacks`');
  const alert = alerts.find((a) => a.kind === 'error' && a.payload && a.payload.context === 'gocomet');
  ok(!!alert, 'D: the failure is not silent - an alert names GoComet as the failing component');
  ok(!!alert && /blew up/.test(alert.payload.detail || ''), 'D: ...and carries the real reason');

  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
}

// ---- scenario E: /api/auctions carries the portal ------------------------------------------------

/** Minimal JSON GET; the console-endpoints test uses the same shape. */
function httpGet(base, p) {
  const http = require('http');
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); r.end();
  });
}

/**
 * Mock mode, so the operator login gate is off (real mode refuses to boot without it) and the
 * SuperProcure side is the simulator - which is also the honest "untagged legacy row" case: a mock
 * stack carries no platformKey at all, so its rows must still read as SuperProcure.
 */
async function scenarioAuctionsPortal() {
  // GC_BID=1 in this child's env, so biddingEnabled is true and the load can actually arm - the
  // only way to get an armed GoComet row into /api/auctions, and the forward look at the day the
  // write gate opens.
  const GoCometAdapter = patchAdapters({ enquiries: [rawEnquiry({ key: 'GC-ARMED' })] });
  // Arming starts a monitor that polls state. Static, far-from-close, so nothing ever tries to bid.
  GoCometAdapter.prototype.getAuctionState = async function () {
    return { auctionId: 'GC-ARMED', status: 'live', closesInMs: 40 * 60_000, myRank: null, rttMs: 50 };
  };
  // Belt: no bid can reach the network even if the engine decides to fire during the test.
  GoCometAdapter.prototype.placeBid = async function () { return { ok: true, accepted: true, rttMs: 50 }; };
  const srv = require('../src/web/server');
  await srv.boot();

  const gc = srv.gocometStack;
  ok(!!gc, 'E: the stack is built in mock mode too (the gate is GC_ENABLE, not the SP adapter mode)');
  if (!gc) throw new Error('no GoComet stack - E cannot be asserted');

  await gc.discovery.tick();
  const req0 = (await srv.requests.listAll()).find((r) => r.loadId === 'GC-ARMED');
  ok(!!req0, 'E: the poller surfaced the enquiry');
  const captured = await srv.requests.capture(req0.id, { cost: 20000 });
  armFromRequestFor(gc.engine, captured);

  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await httpGet(base, '/api/auctions');
  server.close();

  ok(res.status === 200 && Array.isArray(res.json && res.json.auctions), '/api/auctions answers with rows');
  const rows = (res.json && res.json.auctions) || [];
  const armed = rows.find((a) => String(a.auctionId) === 'GC-ARMED');
  ok(!!armed, 'E: the armed GoComet auction appears in /api/auctions');
  ok(!!armed && armed.platformKey === 'gocomet',
    `E: ...carrying platformKey "gocomet" as a first-class tag, not a join back to its price request (got ${armed && armed.platformKey})`);
  ok(rows.every((a) => typeof a.platformKey === 'string' && a.platformKey),
    'E: EVERY row is labelled - a row that is neither scoped nor labelled is the one wrong answer');
  // The absent-means-SuperProcure rule, on a stack that genuinely has no platformKey field.
  const spRows = srv.stacks.filter((s) => s !== gc);
  ok(spRows.length > 0 && spRows.every((s) => s.platformKey === undefined),
    'E: the mock SuperProcure stack really does carry no platformKey - the fallback is under test, not bypassed');
  const { platformOf } = require('../src/pricing/priceRequests');
  ok(spRows.every((s) => platformOf(s) === 'sp'), 'E: an untagged legacy stack reads as SuperProcure');

  for (const s of srv.stacks) { try { if (s.discovery) s.discovery.stop(); } catch (_) {} }
  try { srv.stacks.forEach((s) => s.engine.snapshot().forEach((m) => s.engine.stop(m.auctionId))); } catch (_) {}
}

/** Late require: priceRequests must not load before the scenario's env is in place. */
function armFromRequestFor(engine, req) {
  return require('../src/pricing/priceRequests').armFromRequest(engine, req);
}

// ---- child entry --------------------------------------------------------------------------------

const SCENARIO_FNS = {
  'gate-off': scenarioGateOff,
  'stack-on': scenarioStackOn,
  'build-failure': scenarioBuildFailure,
  'auctions-portal': scenarioAuctionsPortal,
};

if (SCENARIO_FNS[process.argv[2]]) {
  SCENARIO_FNS[process.argv[2]]()
    .then(() => { console.log(`SCENARIO_RESULT ${pass} ${fail}`); process.exit(fail ? 1 : 0); })
    .catch((e) => {
      console.error('scenario crashed:', (e && e.stack) || e);
      console.log(`SCENARIO_RESULT ${pass} ${fail + 1}`);
      process.exit(1);
    });
} else {
  // ---- parent: one child per scenario, then the sentinel over the whole file ----
  const envFor = {
    'gate-off': (dir) => childEnv(dir, { GC_TOKEN: gcToken() }),                        // GC_ENABLE deliberately absent
    'stack-on': (dir) => childEnv(dir, { GC_TOKEN: gcToken(), GC_ENABLE: '1' }),
    'build-failure': (dir) => childEnv(dir, { GC_TOKEN: gcToken(), GC_ENABLE: '1' }),
    // mock mode: the operator login gate is off, so /api/auctions is reachable without a session
    'auctions-portal': (dir) => {
      const env = childEnv(dir, { GC_TOKEN: gcToken(), GC_ENABLE: '1', GC_BID: '1', PLATFORM: 'mock' });
      delete env.SP_ADMIN_PASS_HASH; delete env.SP_SESSION_SECRET;
      return env;
    },
  };
  for (const name of SCENARIOS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gcstack-${name}-`));
    const env = envFor[name](dir);
    if (name === 'gate-off') delete env.GC_ENABLE;
    const r = spawnSync(process.execPath, [__filename, name], { env, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/SCENARIO_RESULT (\d+) (\d+)/);
    process.stdout.write(`\n--- scenario ${name} ---\n`);
    // Only the child's own FAIL lines and its result are worth surfacing; the boot logs are noise.
    for (const line of out.split('\n')) if (/FAIL -|scenario crashed|SCENARIO_RESULT/.test(line)) console.log(line);
    if (!m) {
      fail += 1;
      console.error(`  FAIL - scenario ${name} produced no result line (exit ${r.status}) - it died before asserting`);
      console.error(out.split('\n').slice(-15).join('\n'));
    } else {
      pass += Number(m[1]);
      fail += Number(m[2]);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE. A child that exited early would report fewer checks than it
  // owes, and without this the file would still exit 0 on a green-but-empty run.
  assert.strictEqual(fail, 0, `${fail} GoComet stack checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a scenario exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}
