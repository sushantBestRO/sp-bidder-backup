'use strict';
/**
 * GoComet auctions must survive a restart the way SuperProcure's already do.
 *
 * THE DEFECT. attachGoCometStack built the stack and never called engine.rehydrate(), a choice
 * recorded while GC_BID was off and never revisited after bidding went live. Every pm2 restart
 * therefore orphaned every in-flight GoComet monitor: the durable intent stayed at status 'bidding'
 * forever, nothing re-armed it, and nothing retired it. 52 such records were sitting on the box.
 * Worse than the lost bidding is what the orphans READ as - a record carrying landed bids and no
 * final rank classifies as a LOSS on every reporting surface, so the win rate was being charged for
 * auctions nobody ever saw the end of.
 *
 *   A. boot with GoComet on and two live intents on disk (REAL path, server.js's own wiring - not a
 *      hand-called engine.rehydrate()). One is 30 MINUTES past its close, past rehydrateGraceMs: it
 *      retires closedWhileDown with won/finalRank left unknown, and is NOT re-armed. One is 30
 *      SECONDS past its close, inside the grace: it re-arms live, and finalizes off the first read
 *      that reports the auction closed. This is also the sweep that retires the 52 existing orphans
 *      - the stale intent here carries their exact shape (status 'bidding', landed bids, no won).
 *   B. the restart is ANNOUNCED. rehydrate emits restart_with_live_auctions, and the GoComet engine
 *      must reach the same desk-visible channel SuperProcure's does, tagged to the gocomet account.
 *      Silence on resume is what the price-page gate forbids.
 *   C. SuperProcure's own rehydrate is untouched by all of it.
 *
 *   node scripts/test-gocomet-restart-rehydrate.js
 */
const fs = require('fs'); // allowed: test harness (temp dirs + subprocess), not app state
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');

// Every check across all child processes. The runner grades by EXIT CODE, so a child that returned
// early would otherwise be a silent green zero-assertion run.
const EXPECTED_CHECKS = 48;
const SCENARIOS = ['real-rehydrate', 'restart-notice', 'writes-off', 'retire-partial', 'retire-crashed', 'rehydrate-crashed'];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The dedupe-suffix hash server.js derives, so a key assertion states the rule rather than a literal. */
const sha12 = (v) => require('crypto').createHash('sha1').update(String(v)).digest('hex').slice(0, 12);

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

/**
 * A durable intent in the shape the box's orphans actually carry: armed, bid, and left at 'bidding'
 * because the process died before anything could close it. `won` is ABSENT rather than null - that
 * is what an intent written by arm() and never finalized looks like, and it is the distinction the
 * retire branch reads.
 */
function liveIntent(id, closesAt) {
  return {
    auctionId: id,
    lane: { origin: 'Bhiwandi', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1,
    companyName: 'Waaree Energies',
    cost: 50_000, marginsPct: [12.6, 7.2, 6.3],
    status: 'bidding',
    firedRungs: [0], landedBids: 1, everBid: true,
    revisionsLeft: 2,
    closesAt,
    createdAt: Date.now() - 3_600_000,
  };
}

/**
 * Seed the GoComet scheduler's durable file directly - the state a restart finds on disk. The
 * envelope is DurableScheduler's own ({savedAt, intents: [...]}), so this is the same bytes the
 * engine would have written before the process died, not a shape only this test can produce.
 */
function seedIntents(dir, intents) {
  fs.writeFileSync(path.join(dir, 'intents.gocomet.json'),
    JSON.stringify({ savedAt: Date.now(), intents }, null, 2));
}

/**
 * The OTHER half of an orphan: its closed-bids record, in bidLogger's own _onArmed shape with a
 * landed bid and nothing settled. The intents file alone was never the whole state on the box.
 *
 * Seeded separately, and that separation is the point of asserting it. No 'armed' event fires for a
 * load the sweep retires, so this record can only be corrected by an event the retirement raises on
 * its own account - and until one existed, the flag landed on the intents file (which no reporting
 * surface reads) while THIS document, the one exportModel joins against, kept a shape
 * indistinguishable from a fought loss. That is the reporting half of the 52-orphan bug, and pinning
 * only the intent would leave it uncovered.
 */
function orphanLedgerRecord(id, closesAt) {
  return {
    auctionId: id, account: null, platformKey: 'gocomet',
    lane: { origin: 'Bhiwandi', destination: 'Hosur' }, points: null,
    equipment: '32ft SXL', units: 1, shipper: 'Waaree Energies',
    cost: 50_000, costFloor: null, floor: 53_150, ladder: [56_300, 53_600, 53_150],
    laneFreight: null, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
    armedAt: closesAt - 3_600_000,
    ourBids: [{ price: 56_300, rungIndex: 0, rank: null, socketRank: null, ts: closesAt - 60_000 }],
    lastBidPrice: 56_300,
    finalRank: null, won: null, closeModel: null, closedAt: null, status: 'open',
  };
}

/** boot() hands back the server before it is listening; address() is null until then. */
function listening(server) {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * Silence both adapters' network. `gcState` decides what every GoComet read answers - the grace
 * intent's finalize hangs off it, so it is the whole of the "first live read settles it" property.
 */
function patchAdapters(gcState) {
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  RealSuperProcureAdapter.prototype.login = async function () { this.account = FAKE_SP_IDENTITY(); return this.account; };
  RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };
  RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };
  const { GoCometAdapter } = require('../src/platform/gocometAdapter');
  GoCometAdapter.prototype.listAuctions = async function () { return []; };
  // A CLOSED GoComet enquiry answers HTTP 200 with bid_closing_in null for days (gocometAdapter's
  // own mapping note), which the adapter maps to a live-and-ok state with a zero countdown. extendMs
  // 0 so the soft-close debounce is the engine's base window and the test does not idle for the
  // unpublished-extension bound.
  GoCometAdapter.prototype.getAuctionState = async function () { return gcState(); };
  GoCometAdapter.prototype.placeBid = async function () {
    throw new Error('placeBid must never be reached: every read in this test reports the auction closed');
  };
}

/** Env every child shares: real mode (the path the box runs), offline, ephemeral. */
function childEnv(dir, extra) {
  const env = Object.assign({}, process.env, {
    PLATFORM: 'real', STORE_BACKEND: 'memory', PORT: '0',
    SP_ADMIN_PASS_HASH: 'test-hash', SP_SESSION_SECRET: 'test-session-secret',
    SP_DATA_DIR: dir, SP_TOKEN: 'good-token-primary',
    SP_WHATSAPP_ENABLED: '0',
    GC_TOKEN: gcToken(), GC_ENABLE: '1', GC_BID: '1',
  }, extra);
  delete env.SP_DEMO_SEED; delete env.SP_TOKEN_2; delete env.SP_TOKEN_3;
  return env;
}

const STALE = 'GC-STALE-30MIN';
const GRACE = 'GC-GRACE-30SEC';

// ---- scenario A: the REAL boot path re-arms and retires ------------------------------------------

async function scenarioRealRehydrate() {
  const dir = process.env.SP_DATA_DIR;
  const now = Date.now();
  const staleClosesAt = now - 30 * 60_000;
  seedIntents(dir, [
    liveIntent(STALE, staleClosesAt),  // past rehydrateGraceMs (600s) -> terminal
    liveIntent(GRACE, now - 30_000),   // inside the grace -> re-arm, settle off a live read
  ]);
  patchAdapters(() => ({
    ok: true, status: 'live', myRank: null, totalBidders: 2, standingL1Price: null,
    closesInMs: 0, closeModel: 'soft', extendMs: 0, revisionsLeft: 2, measuredRttMs: 20,
  }));

  const srv = require('../src/web/server');
  // The ledger half of the orphan, in place before boot - the store is module-scope, built at
  // require() time, so this is the record the restart finds.
  await srv.store.putDoc('closedBids', STALE, orphanLedgerRecord(STALE, staleClosesAt));
  await srv.boot();

  const gc = srv.gocometStack;
  ok(!!gc, 'A: the GoComet stack is built');
  if (!gc) throw new Error('no GoComet stack - the rest of A cannot be asserted');

  // ---- the stale intent: retired, not re-armed, and NOT booked as a loss ----
  const stale = gc.scheduler.get(STALE);
  ok(!!stale, 'A: the stale intent survived the boot read');
  ok(stale && stale.status === 'closed',
    `A: boot retired the 30-minutes-past-close intent (got status '${stale && stale.status}') - on main rehydrate is never called and it stays 'bidding' forever`);
  ok(stale && stale.closedWhileDown === true,
    'A: it is stamped closedWhileDown - the flag that stops it reading as a settled result');
  ok(stale && stale.won !== false,
    'A: won is NOT false - an auction nobody saw the end of must never be booked as a phantom loss');
  ok(stale && stale.finalRank == null, 'A: and no final rank was invented for it');
  ok(!gc.engine.monitors.has(STALE), 'A: nothing was re-armed for it - the auction is long over');

  // ---- the same orphan's CLOSED-BIDS record: the store the reporting surfaces actually read ----
  // The engine hands the flag off through onEvent -> bidLogger, which is a chained promise off the
  // emit, so the write lands after rehydrate returns. Poll for it rather than sleeping a guess.
  const ledgerDeadline = Date.now() + 10_000;
  let ledger = await srv.store.getDoc('closedBids', STALE);
  while (Date.now() < ledgerDeadline && !(ledger && ledger.status === 'closed')) {
    await sleep(100);
    ledger = await srv.store.getDoc('closedBids', STALE);
  }
  ok(!!ledger, 'A: the orphan\'s closed-bids record survived the boot');
  ok(ledger && ledger.status === 'closed',
    `A: the sweep reached the CLOSED-BIDS store too, not just the intents file (got status '${ledger && ledger.status}') - the intents file is not read by any reporting surface, so a scheduler-only write leaves the 52 orphans reading as losses exactly as before`);
  ok(ledger && ledger.closedWhileDown === true,
    'A: ...stamping the flag on the document exportModel joins against, which is what makes deriveStatus answer unknown instead of lost');
  ok(ledger && ledger.won === null,
    `A: won on the ledger record is null, not a coerced false (got ${JSON.stringify(ledger && ledger.won)})`);
  ok(ledger && ledger.finalRank == null, 'A: and the ledger record invents no final rank either');
  ok(ledger && ledger.closedAt === staleClosesAt,
    `A: its closedAt is the auction's own close (${staleClosesAt}), not the restart instant - downstream that field IS auctionCloseAt, so every orphan would otherwise be dated to deploy day (got ${ledger && ledger.closedAt})`);
  ok(ledger && Array.isArray(ledger.ourBids) && ledger.ourBids.length === 1,
    'A: the landed bid is still on the record - the sweep records doubt, it does not erase evidence');

  // ---- the grace intent: re-armed live, then settled by the platform rather than the clock ----
  // A recorded close that has only just passed is not proof the auction ended: a soft GoComet
  // enquiry outlives every close it publishes. The engine re-arms and lets the first read decide.
  const graceArmed = gc.engine.monitors.has(GRACE);
  ok(graceArmed,
    'A: the 30-seconds-past-close intent was RE-ARMED rather than retired on the strength of a stale timestamp');

  // The stubbed read reports a closed auction on every tick, so the soft-close sustained-zero
  // debounce settles it. Poll for the terminal state instead of sleeping a fixed guess.
  const deadline = Date.now() + 20_000;
  const graceStatus = () => { const i = gc.scheduler.get(GRACE); return i && i.status; };
  while (Date.now() < deadline && graceStatus() !== 'closed') await sleep(200);
  const grace = gc.scheduler.get(GRACE) || {};
  ok(grace.status === 'closed',
    `A: ...and the first live read reporting the enquiry closed finalized it (got '${grace.status}')`);
  ok(grace.closedWhileDown !== true,
    'A: a load finalized by a real read is NOT closedWhileDown - it was settled by the platform, not by the restart');

  // ---- SuperProcure is untouched ----
  const sp = srv.stacks.find((s) => s.account.accountId === 'primary');
  ok(!!sp && sp.engine !== gc.engine, 'C: the SuperProcure stack still has its own engine');
  ok(!!sp && sp.scheduler.filePath !== gc.scheduler.filePath,
    'C: ...reading its own intents file, which this change never touches');
  ok(fs.existsSync(path.join(dir, 'intents.gocomet.json')),
    'C: the GoComet intents file is the only one that was seeded, and it is still the GoComet stack that owns it');

  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
  try { gc.engine.kill(); } catch (_) {}
}

// ---- scenario B: the resume is announced -------------------------------------------------------

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function scenarioRestartNotice() {
  const dir = process.env.SP_DATA_DIR;
  seedIntents(dir, [liveIntent(GRACE, Date.now() - 30_000)]);
  patchAdapters(() => ({
    ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
    closesInMs: 120_000, closeModel: 'soft', extendMs: 0, revisionsLeft: 2, measuredRttMs: 20,
  }));

  const srv = require('../src/web/server');
  const server = await listening(await srv.boot());
  const port = server.address().port;

  const state = await getJson(port, '/api/state');
  const events = Array.isArray(state.events) ? state.events : [];
  const notice = events.find((e) => e.kind === 'restart_with_live_auctions'
    && e.account && e.account.accountId === 'gocomet');
  ok(!!notice,
    'B: rehydrating GoComet emits restart_with_live_auctions on the same channel SuperProcure uses - resuming live bidding in silence is what the price-page gate forbids');
  ok(!!notice && notice.count === 1, `B: ...naming how many auctions came back (got ${notice && notice.count})`);
  ok(!!notice && notice.source === 'engine', 'B: ...as an engine event, so it reaches the console feed');
  ok(!!notice && typeof notice.message === 'string' && /resumed/.test(notice.message),
    'B: ...with the same plain-language message SuperProcure sends');

  // The parity claim stated as the thing that would break it: the notice must come from the SAME
  // emit SuperProcure's does, so it can never drift into a GoComet-only copy of the wording.
  const { BidEngine } = require('../src/engine/bidEngine');
  ok(typeof BidEngine.prototype.rehydrate === 'function',
    'B: it is BidEngine.rehydrate that both portals call - one implementation, no GoComet fork');

  const gc = srv.gocometStack;
  ok(!!gc && gc.engine.monitors.has(GRACE), 'B: and the auction really is armed again, not merely announced');

  server.close();
  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
  try { gc.engine.kill(); } catch (_) {}
}

// ---- scenario C: a portal that cannot bid must not be re-armed -----------------------------------

/**
 * arm() carries no biddingEnabled check - the intake path refuses the arm instead - so rehydrate,
 * which calls arm() directly, is a second door into the state that refusal exists to prevent: a
 * monitor walking its whole ladder while every rung throws at the write gate, one desk alert per
 * rung per load, nothing ever bid. This is the guarantee the old "its scheduler is NOT rehydrated"
 * note used to provide by doing nothing at all.
 */
async function scenarioWritesOff() {
  const dir = process.env.SP_DATA_DIR;
  const staleClosesAt = Date.now() - 30 * 60_000;
  seedIntents(dir, [
    liveIntent(GRACE, Date.now() + 10 * 60_000), // comfortably still live
    liveIntent(STALE, staleClosesAt),            // long past its close - dead, whatever the write flag says
  ]);
  patchAdapters(() => ({
    ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
    closesInMs: 600_000, closeModel: 'soft', extendMs: 0, revisionsLeft: 2, measuredRttMs: 20,
  }));

  const srv = require('../src/web/server');
  // Capture what the desk is actually told. The alert is the whole point of this branch, and the
  // module-scope notifier this method hangs off is the same object rehydrateGoCometStack calls.
  const alerts = [];
  const realAlert = srv.notifier.alert.bind(srv.notifier);
  srv.notifier.alert = (kind, payload, opts) => {
    alerts.push({ kind, payload, opts });
    return realAlert(kind, payload, opts);
  };
  await srv.boot();

  const gc = srv.gocometStack;
  ok(!!gc, 'C: the stack is still built with GC_BID off - the gate is on re-arming, not on existing');
  if (!gc) throw new Error('no GoComet stack - the rest of C cannot be asserted');
  ok(!gc.engine.monitors.has(GRACE),
    'C: GC_BID off -> the live intent is NOT re-armed, so no ladder walks against a closed write gate');
  const it = gc.scheduler.get(GRACE);
  ok(!!it && it.status === 'bidding',
    'C: and the intent is left alone rather than retired - the auction may still be running, and an operator can turn writes back on');

  // ---- the retirement half runs anyway: it writes no bid, so the write gate has no claim on it ----
  // Without this the branch counted raw activeIntents(), which applies NO close-time test, and told
  // the desk to hand-quote every one of them. On the box that is 52 auctions, most closed weeks ago.
  const stale = gc.scheduler.get(STALE);
  ok(!!stale && stale.status === 'closed',
    `C: a long-past-close intent is RETIRED even with writes off - retiring places no bid (got status '${stale && stale.status}')`);
  ok(stale && stale.closedWhileDown === true && stale.won !== false,
    'C: into the same unknown shape, never a phantom loss');
  ok(!gc.engine.monitors.has(STALE), 'C: and it is certainly not re-armed');

  const handQuote = alerts.filter((a) => a.opts && /^gocomet_rehydrate_writes_off_/.test(a.opts.dedupeKey));
  ok(handQuote.length === 1, `C: the desk gets exactly one hand-quote instruction (got ${handQuote.length})`);
  const detail = handQuote.length ? String(handQuote[0].payload.detail) : '';
  ok(/^1 GoComet auction\(s\) /.test(detail),
    `C: naming ONLY the auction that survived the sweep, not the retired one (got "${detail}")`);
  ok(!new RegExp(STALE).test(detail) && !/2 GoComet/.test(detail),
    'C: the dead auction is not in the count the desk is asked to quote by hand');

  // Dedupable ACROSS RESTARTS: the key was Date.now(), so the notifier's persistent dedupe could
  // never collapse the same stranded population and the same wrong instruction returned every boot.
  const expected = require('crypto').createHash('sha1').update(GRACE).digest('hex').slice(0, 12);
  ok(handQuote.length && handQuote[0].opts.dedupeKey === `gocomet_rehydrate_writes_off_${expected}`,
    `C: and its dedupe key is derived from the still-open population, not the clock (got "${handQuote.length && handQuote[0].opts.dedupeKey}")`);
}

// ---- scenarios D/E: a sweep that fails must not swallow the hand-quote instruction ---------------

/** Boot with GC_BID off and a captured notifier, the shape both failure scenarios need. */
async function bootWritesOffCapturing() {
  patchAdapters(() => ({
    ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
    closesInMs: 600_000, closeModel: 'soft', extendMs: 0, revisionsLeft: 2, measuredRttMs: 20,
  }));
  const srv = require('../src/web/server');
  const alerts = [];
  const realAlert = srv.notifier.alert.bind(srv.notifier);
  srv.notifier.alert = (kind, payload, opts) => {
    alerts.push({ kind, payload, opts });
    return realAlert(kind, payload, opts);
  };
  await srv.boot();
  return { srv, alerts };
}

/**
 * D. ONE intent's durable write fails. The sweep must keep going: the surviving auction is still
 * reported as open (that instruction is the only one the desk can act on), and the load whose write
 * did not land is named on its own rather than folded into either answer.
 */
async function scenarioRetirePartial() {
  seedIntents(process.env.SP_DATA_DIR, [
    liveIntent(GRACE, Date.now() + 10 * 60_000),
    liveIntent(STALE, Date.now() - 30 * 60_000),
  ]);
  const { BidEngine } = require('../src/engine/bidEngine');
  const realRetire = BidEngine.prototype._retireIfPastClose;
  BidEngine.prototype._retireIfPastClose = function (it) {
    if (it && it.auctionId === STALE) throw new Error('ENOSPC: no space left on device');
    return realRetire.call(this, it);
  };

  const { srv, alerts } = await bootWritesOffCapturing();
  const partial = alerts.filter((a) => a.opts && /^gocomet_retire_partial_/.test(a.opts.dedupeKey));
  ok(partial.length === 1, `D: the load whose retirement could not be written earns its own message (got ${partial.length})`);
  ok(partial.length && /1 GoComet auction\(s\)/.test(String(partial[0].payload.detail)),
    `D: ...naming how many (got "${partial.length && partial[0].payload.detail}")`);

  const handQuote = alerts.filter((a) => a.opts && /^gocomet_rehydrate_writes_off_/.test(a.opts.dedupeKey));
  ok(handQuote.length === 1,
    `D: and the still-open instruction SURVIVES the failure - an aborted sweep used to leave it empty and unsent (got ${handQuote.length})`);
  ok(handQuote.length && /^1 GoComet auction\(s\) /.test(String(handQuote[0].payload.detail)),
    'D: ...still naming only the auction that is genuinely open');

  BidEngine.prototype._retireIfPastClose = realRetire;
  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
}

/**
 * E. The sweep dies wholesale, so nothing can be enumerated. The desk must still be told to
 * hand-quote: this catch used to speak only about closed-auction reporting, and the auctions left
 * open and unresumed went unmentioned.
 */
async function scenarioRetireCrashed() {
  seedIntents(process.env.SP_DATA_DIR, [liveIntent(GRACE, Date.now() + 10 * 60_000)]);
  const { BidEngine } = require('../src/engine/bidEngine');
  const realSweep = BidEngine.prototype.retirePastClose;
  BidEngine.prototype.retirePastClose = function () { throw new Error('intents file unreadable'); };

  const { srv, alerts } = await bootWritesOffCapturing();
  const failedAlerts = alerts.filter((a) => a.opts && /^gocomet_retire_failed/.test(a.opts.dedupeKey));
  ok(failedAlerts.length === 1, `E: the desk is told the sweep failed (got ${failedAlerts.length})`);
  const detail = failedAlerts.length ? String(failedAlerts[0].payload.detail) : '';
  ok(/quote any open GoComet load by hand/.test(detail),
    `E: and the message carries the HAND-QUOTE instruction, not only the reporting caveat (got "${detail}")`);
  ok(/reporting/.test(detail), 'E: ...without dropping the reporting caveat it already carried');
  ok(!alerts.some((a) => a.opts && /^gocomet_rehydrate_writes_off_/.test(a.opts.dedupeKey)),
    'E: nothing claims to know WHICH auctions are open - the enumeration is what failed');
  // Keyed on the FAULT, never on Date.now(), for the same reason its sibling one block up is keyed
  // on the population: the notifier's dedupe is persistent and cross-restart, and a poisoned intents
  // file survives every restart - so a clock-suffixed key made one un-collapsible message per boot on
  // the channel the client's Director reads. A genuinely different fault still earns its own message.
  ok(failedAlerts.length && failedAlerts[0].opts.dedupeKey === `gocomet_retire_failed_${sha12('intents file unreadable')}`,
    `E: and its dedupe key is derived from the fault, not the clock (got "${failedAlerts.length && failedAlerts[0].opts.dedupeKey}")`);

  BidEngine.prototype.retirePastClose = realSweep;
  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
}

/**
 * F. The same rule on the write-enabled path. rehydrate() throwing describes a condition that
 * survives a restart (a durable intent arm() cannot rebuild), so a clock-suffixed key produced one
 * fresh message on every boot for as long as the fault lived.
 */
async function scenarioRehydrateCrashed() {
  seedIntents(process.env.SP_DATA_DIR, [liveIntent(GRACE, Date.now() + 10 * 60_000)]);
  const { BidEngine } = require('../src/engine/bidEngine');
  const realRehydrate = BidEngine.prototype.rehydrate;
  BidEngine.prototype.rehydrate = async function () {
    // GoComet only - SuperProcure's own rehydrate must be untouched, or boot fails for the wrong reason.
    if (String(this.scheduler.filePath || '').includes('gocomet')) throw new Error('intents file unreadable');
    return realRehydrate.call(this);
  };

  const { srv, alerts } = await bootWritesOffCapturing();
  const failedAlerts = alerts.filter((a) => a.opts && /^gocomet_rehydrate_failed/.test(a.opts.dedupeKey));
  ok(failedAlerts.length === 1, `F: the desk is told the re-arm failed (got ${failedAlerts.length})`);
  ok(failedAlerts.length && failedAlerts[0].opts.dedupeKey === `gocomet_rehydrate_failed_${sha12('intents file unreadable')}`,
    `F: keyed on the fault so the notifier's persistent dedupe can collapse a restart loop (got "${failedAlerts.length && failedAlerts[0].opts.dedupeKey}")`);
  ok(failedAlerts.length && /quote any open GoComet load by hand/.test(String(failedAlerts[0].payload.detail)),
    'F: and it still carries the hand-quote instruction');

  BidEngine.prototype.rehydrate = realRehydrate;
  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
}

const SCENARIO_FNS = {
  'real-rehydrate': scenarioRealRehydrate,
  'restart-notice': scenarioRestartNotice,
  'writes-off': scenarioWritesOff,
  'retire-partial': scenarioRetirePartial,
  'retire-crashed': scenarioRetireCrashed,
  'rehydrate-crashed': scenarioRehydrateCrashed,
};

if (SCENARIO_FNS[process.argv[2]]) {
  SCENARIO_FNS[process.argv[2]]()
    .then(() => { console.log(`SCENARIO_RESULT ${pass} ${fail}`); process.exit(fail ? 1 : 0); })
    .catch((e) => {
      console.error('  scenario crashed:', e && e.stack || e);
      console.log(`SCENARIO_RESULT ${pass} ${fail + 1}`);
      process.exit(1);
    });
} else {
  // A runs the REAL boot path (the one the box takes). B runs the MOCK path, which is both the
  // second attachGoCometStack call site and the only mode where /api/state is readable without an
  // operator session - and the event ring is the only surface the restart notice lands on.
  const envFor = {
    'real-rehydrate': (dir) => childEnv(dir),
    'restart-notice': (dir) => {
      const env = childEnv(dir, { PLATFORM: 'mock' });
      delete env.SP_ADMIN_PASS_HASH; delete env.SP_SESSION_SECRET;
      return env;
    },
    // GC_BID deliberately absent - the adapter's stated default, and the posture an operator falls
    // back to when GoComet bidding is switched off.
    'writes-off': (dir) => { const env = childEnv(dir); delete env.GC_BID; return env; },
    'retire-partial': (dir) => { const env = childEnv(dir); delete env.GC_BID; return env; },
    'retire-crashed': (dir) => { const env = childEnv(dir); delete env.GC_BID; return env; },
    // GC_BID ON: this is the write-enabled path, the one the box actually runs.
    'rehydrate-crashed': (dir) => childEnv(dir),
  };
  for (const name of SCENARIOS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gcrehy-${name}-`));
    const r = spawnSync(process.execPath, [__filename, name],
      { env: envFor[name](dir), encoding: 'utf8', timeout: 90_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/SCENARIO_RESULT (\d+) (\d+)/);
    process.stdout.write(`\n--- scenario ${name} ---\n`);
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

  assert.strictEqual(fail, 0, `${fail} GoComet restart-rehydrate checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a scenario exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}
