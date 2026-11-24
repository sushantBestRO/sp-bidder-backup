'use strict';
/**
 * THE DISCARDED STACK THAT KEEPS A TIMER - a pre-start wake surviving teardownStack().
 *
 * Regression target: T7 E10 / BH-RESOURCE-3, upheld_confirmed 2026-09-19
 * (docs/bug-hunts/2026-09-16_bidcmd-T7-verify-resource3.md; disposition row E10 in
 * docs/bug-hunts/2026-09-16_bidcmd-T7-dispositions.md, moved to BLOCKING by its ADDENDUM).
 *
 * teardownStack's own docstring is the contract: "Quiesce a stack we are discarding: stop discovery,
 * halt every monitor timer, close the socket, clear the expiry + scope-refresh timers." Its only
 * engine-facing statement is `for (const m of stack.engine.snapshot()) stack.engine.stop(m.auctionId)`.
 * snapshot() maps this.monitors, and a load that has been priced but whose window has not opened has
 * NO monitor - it exists only as an entry in the engine's scheduledTimers Map. The engine's own
 * docstring above scheduledSnapshot() states both halves in one paragraph: schedule() "deliberately
 * creates no monitor ... so snapshot() - which maps this.monitors - structurally cannot show them",
 * and snapshot() "is not merely presentational. It drives teardownStack()'s ... stop-all loops".
 *
 * So the wake outlives the discard. It then fires through the discarded adapter - whose own teardown
 * comment calls it a "discard chokepoint" precisely so nothing can call back into it - arms a monitor
 * on an engine nobody holds a reference to, and starts a self-re-arming tick chain. The replacement
 * stack rehydrates the SAME durable intent and plans the SAME wake, so at the fire moment two engines
 * on two adapters watch one load on one shared vendor account, and every per-load write guard
 * (bidInProgress, bidTimes, firedRungs) is per-MONITOR, so neither chain can see the other's writes.
 * teardownStack is the account-reconnect path and the box's reconnect ledger shows it running daily.
 *
 * THE FUNCTION UNDER TEST IS THE REAL ONE. server.js is the composition root and starts a server when
 * required, so this file reads it as TEXT, brace-matches the teardownStack body out of it and calls
 * that. The hunter's own reproducer inlined the stop-all loop and patched its own copy, which proves
 * nothing about the implementation; a fix has to land in src/web/server.js to turn this file green.
 *
 * WHAT MUST NOT MOVE:
 *   - an ARMED monitor is still finalized and removed by the teardown (check 6). The fix ADDS a
 *     release; weakening the existing one would trade this defect for a worse one.
 *   - discarding a stack raises NO error-level alert (check 7). kill() would release the wake and
 *     satisfy checks 1-6, but it emits kind 'killed', which is a member of ERROR_KINDS in
 *     src/notify/engineAlerts.js - the channel that reaches the client's Director. teardownStack is
 *     the daily account-reconnect path, so that repair would page him on every reconnect. A quiesce
 *     is routine; it is not an incident.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, rand: () => 0, no network, no sleeps.
 * The real wake delay is ten minutes and is never waited on - handles are counted by a ledger over
 * global setTimeout/clearTimeout and fired directly.
 *
 *   node scripts/test-teardown-cancels-scheduled-wakes.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files + reading server.js as text)
const path = require('path');
const assert = require('assert');

// ------------------------------------------------- live-handle ledger, installed before the engine
const SRC_DIR = path.join(__dirname, '..', 'src').toLowerCase();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const live = new Map();

// Any frame under src/ counts as implementation-owned, not just bidEngine.js: a repair that moved
// the wake's setTimeout into a new module would otherwise be filtered out as 'other' and pass.
function siteOf() {
  for (const l of (new Error().stack || '').split('\n')) {
    if (!l.toLowerCase().includes(SRC_DIR)) continue;
    const m = l.match(/([\w.-]+\.js):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return 'other';
}

global.setTimeout = function (fn, ms, ...rest) {
  const site = siteOf();
  let handle;
  const wrapped = function (...a) { live.delete(handle); return fn.apply(this, a); };
  handle = realSetTimeout(wrapped, ms, ...rest);
  live.set(handle, { delayMs: ms, site, fn: wrapped });
  return handle;
};
global.clearTimeout = function (h) { live.delete(h); return realClearTimeout(h); };

const implHandles = () => [...live.values()].filter((v) => v.site !== 'other');
const implSites = () => implHandles().map((v) => `${v.site}(+${v.delayMs}ms)`).sort();
const fireAll = () => {
  for (const [h, v] of [...live.entries()]) { realClearTimeout(h); live.delete(h); v.fn(); }
};
const clearLedger = () => { for (const h of [...live.keys()]) { realClearTimeout(h); live.delete(h); } };
const restoreTimers = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `teardown-wakes-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// Drain on the SAVED originals so the harness never pollutes its own ledger.
async function drain(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

// ------------------------------------------------- extract the REAL teardownStack out of server.js
const SERVER_PATH = path.join(__dirname, '..', 'src', 'web', 'server.js');

// Brace-match the declaration body, skipping comments and string literals so a brace inside either
// cannot end the function early.
function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  let mode = null; // 'line' | 'block' | quote char
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') { if (c === '\n') mode = null; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (mode) {
      if (c === '\\') { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// Existence only. The body's CONTENT is pinned behaviourally by checks 1-7, so a legitimate refactor
// that moves the quiesce behind an engine method stays free to land.
const TEARDOWN_SRC = extractFunction(fs.readFileSync(SERVER_PATH, 'utf8'), 'function teardownStack(stack) {');
assert.ok(TEARDOWN_SRC, 'setup: could not find function teardownStack(stack) in src/web/server.js - '
  + 'it was renamed or moved, and this file would otherwise assert nothing');
// eslint-disable-next-line no-new-func
const teardownStack = new Function(`return (${TEARDOWN_SRC});`)();
assert.strictEqual(typeof teardownStack, 'function', 'setup: the extracted source must evaluate to a function');

// ------------------------------------------------- engine + stack fixtures
function mkStack() {
  const counts = { reads: 0 };
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      counts.reads += 1;
      return { ok: true, status: 'open', myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: 900_000, closesAtMs: Date.now() + 900_000, revisionLimit: 30, revisionsLeft: 30,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 40, triggerWindowMs: null };
    },
    placeBid: async () => ({ ok: true, accepted: true, myRank: 1 }),
  };
  const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: {
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000, minInterFireMs: 0, startGraceMs: 0,
    },
    rand: () => 0,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: (e) => events.push(e),
  });
  // The shape teardownStack reads. No adapter, so its discard / noteAuthDeadMark branch is skipped
  // and the extracted body needs nothing from the server module's scope.
  const stack = { engine, discovery: null, adapter: null,
    account: { accountId: 'acct-test', label: 'Test Account' },
    tokenExpiryTimer: null, scopeRefresher: null };
  return { stack, engine, counts, events };
}

const meta = (id, o = {}) => Object.assign({
  id: String(id), lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
  units: 1, companyName: 'ACME', branchName: 'Bhiwandi',
  startsAt: Date.now() - 1000, closesAt: Date.now() + 900_000,
}, o);
const preStart = (id) => meta(id, { startsAt: Date.now() + 600_000, closesAt: Date.now() + 1_800_000 });
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

(async () => {
  // ------------------------------------------------------- 1. THE DEFECT: the wake outlives the discard
  {
    const { stack, engine } = mkStack();
    engine.arm(meta(25_466_599), INPUTS);
    engine.schedule(preStart(25_475_937), INPUTS);
    await drain(2);
    assert.strictEqual(engine.scheduledTimers.size, 1, 'setup: the pre-start load must hold a wake timer');
    assert.ok(!engine.snapshot().some((m) => String(m.auctionId) === '25475937'),
      'setup: the pre-start load must be invisible to snapshot() - that is the whole mechanism');

    teardownStack(stack);
    await drain(2);

    const survivors = implHandles().length;
    assert.strictEqual(survivors, 0,
      `teardownStack must leave the discarded engine holding no timer; ${survivors} survived it `
      + `(${implSites().join(', ') || 'none'}) - the pre-start wake held in scheduledTimers, which `
      + 'snapshot() structurally cannot see, so stop() is never called for it and teardown does not call kill()');
    assert.strictEqual(engine.scheduledTimers.size, 0,
      'and the engine\'s own scheduledTimers Map must be empty after the stack is discarded');

    engine.kill('test done');
    clearLedger();
    ok('teardown releases the pre-start wake on a discarded stack (n=1)');
  }

  // ------------------------------------------------------- 2. the release is general, not one id
  {
    const { stack, engine } = mkStack();
    for (let i = 0; i < 5; i++) engine.schedule(preStart(25_480_000 + i), INPUTS);
    await drain(2);
    assert.strictEqual(engine.scheduledTimers.size, 5, 'setup: five pre-start wakes must be armed');

    teardownStack(stack);
    await drain(2);

    const survivors = implHandles().length;
    assert.strictEqual(survivors, 0,
      `teardownStack must release every pre-start wake, not one; ${survivors} of 5 survived it `
      + `(${implSites().join(', ') || 'none'})`);
    assert.strictEqual(engine.scheduledTimers.size, 0, 'and scheduledTimers is empty for all five');

    engine.kill('test done');
    clearLedger();
    ok('the release scales to five pre-start loads (not a special case of one auction id)');
  }

  // ------------------------------------- 3-5. what the survivor does on the stack nobody holds
  {
    const { stack, engine, counts } = mkStack();
    engine.arm(meta(25_466_600), INPUTS);
    engine.schedule(preStart(25_475_938), INPUTS);
    await drain(2);

    teardownStack(stack);
    await drain(2);

    const readsAtDiscard = counts.reads;
    fireAll();
    await drain(6);

    assert.strictEqual(engine.monitors.size, 0,
      `firing what survived the teardown re-armed ${engine.monitors.size} monitor(s) on the DISCARDED `
      + `engine (${[...engine.monitors.keys()].join(', ')}) - the replacement stack rehydrates the same `
      + 'durable intent, so two engines end up watching one load on one shared vendor account');
    ok('no monitor is re-armed on the discarded engine');

    const orphanReads = counts.reads - readsAtDiscard;
    assert.strictEqual(orphanReads, 0,
      `${orphanReads} platform read(s) reached the DISCARDED adapter after teardownStack - the discard `
      + 'chokepoint exists precisely so nothing can call back into it');
    ok('no read reaches the discarded adapter after the teardown');

    const chain = implHandles().length;
    assert.strictEqual(chain, 0,
      `the discarded engine was left with ${chain} new handle(s) (${implSites().join(', ') || 'none'}) - `
      + 'a self-re-arming tick chain on a stack nobody holds a reference to');
    ok('no new tick chain is left behind on the discarded engine');

    engine.kill('test done');
    clearLedger();
  }

  // ------------------------------------------------------- 6. CONTROL: armed monitors still stop
  {
    const { stack, engine } = mkStack();
    const monitor = engine.arm(meta(25_466_601), INPUTS);
    await drain(2);
    assert.strictEqual(engine.monitors.size, 1, 'setup: the armed load must have a monitor');

    teardownStack(stack);
    await drain(2);

    assert.strictEqual(monitor.finalized, true, 'an armed monitor must still be finalized by the teardown');
    assert.strictEqual(engine.monitors.size, 0, 'and removed from engine.monitors');
    assert.strictEqual(engine.snapshot().length, 0, 'and gone from snapshot()');

    engine.kill('test done');
    clearLedger();
    ok('CONTROL - an armed monitor is still finalized and removed (the existing release is not weakened)');
  }

  // ---------------------------------------- 7. CONTROL: a discard is not an incident (no error alert)
  {
    const { stack, engine, events } = mkStack();
    engine.arm(meta(25_466_602), INPUTS);
    engine.schedule(preStart(25_475_939), INPUTS);
    await drain(2);

    events.length = 0; // only what the teardown itself emits
    teardownStack(stack);
    await drain(2);

    const errs = events.filter((e) => e && e.type === 'alert' && e.level === 'error');
    assert.deepStrictEqual(errs.map((e) => e.kind), [],
      `discarding a stack must raise no error-level alert; it raised ${errs.length} `
      + `(${errs.map((e) => e.kind).join(', ')}). ERROR_KINDS routes to the client Director's channel `
      + 'and teardownStack is the daily reconnect path - releasing the wake via kill() would satisfy '
      + 'checks 1-6 and page him on every reconnect');
    assert.ok(!events.some((e) => e && e.kind === 'killed'),
      'and specifically not kind \'killed\' - a quiesce is routine, not a kill-switch event');

    engine.kill('test done');
    clearLedger();
    ok('CONTROL - discarding a stack raises no error-level alert (no killed on the reconnect path)');
  }

  cleanup();
  clearLedger();
  restoreTimers();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns early
  // exits 0 and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 7;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  clearLedger();
  restoreTimers();
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
