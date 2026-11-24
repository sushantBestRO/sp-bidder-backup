'use strict';
/**
 * THE WAKE ALREADY IN FLIGHT - a pre-start wake parked on its platform read survives teardownStack().
 *
 * Regression target: T7 E10 / BH-RESOURCE-3, the remaining half after the scheduledTimers release.
 *
 * _planWake's wake() deletes its own scheduledTimers entry as its FIRST statement, before it awaits
 * adapter.getAuctionState(id). From that moment the load has no timer and no monitor, so neither
 * snapshot() nor any stop() in teardownStack can reach it, and teardown deliberately never calls
 * kill() (kind 'killed' pages the client's Director on every reconnect). When the read resolves,
 * every post-await guard (killed, monitors.has(id), intent still 'scheduled') passes on the
 * DISCARDED engine: it arms a monitor there, plants a tick chain on the discarded adapter, and its
 * DurableScheduler - on the same intents file the replacement stack now owns - writes its stale
 * in-memory map over that file.
 *
 * THE FUNCTION UNDER TEST IS THE REAL ONE: teardownStack is brace-matched out of src/web/server.js as
 * text and called on a stack holding a real BidEngine with a real DurableScheduler on a temp file.
 *
 * Offline and deterministic: fake adapter whose read is resolved by hand, temp-file scheduler,
 * rand: () => 0. setTimeout/clearTimeout are replaced by a ledger that never schedules anything real;
 * a handle only runs when this file fires it.
 *
 *   node scripts/test-teardown-inflight-wake.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files + reading server.js as text)
const path = require('path');
const assert = require('assert');

const SRC_DIR = path.join(__dirname, '..', 'src').toLowerCase();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const ledger = new Map();

function siteOf() {
  for (const l of (new Error().stack || '').split('\n')) {
    if (!l.toLowerCase().includes(SRC_DIR)) continue;
    const m = l.match(/([\w.-]+\.js):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return 'other';
}

global.setTimeout = function (fn, ms, ...rest) {
  const handle = { unref() { return handle; }, ref() { return handle; }, hasRef: () => false };
  ledger.set(handle, { delayMs: ms, site: siteOf(), fn: () => fn(...rest) });
  return handle;
};
global.clearTimeout = function (h) { ledger.delete(h); };

const implHandles = () => [...ledger.entries()].filter(([, v]) => v.site !== 'other');
const implSites = () => implHandles().map(([, v]) => `${v.site}(+${v.delayMs}ms)`).sort();
const fire = (h) => { const v = ledger.get(h); ledger.delete(h); v.fn(); };
const fireImpl = () => { for (const [h] of implHandles()) fire(h); };
const restoreTimers = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `teardown-inflight-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

async function drain(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

const SERVER_PATH = path.join(__dirname, '..', 'src', 'web', 'server.js');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  let mode = null;
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

const TEARDOWN_SRC = extractFunction(fs.readFileSync(SERVER_PATH, 'utf8'), 'function teardownStack(stack) {');
assert.ok(TEARDOWN_SRC, 'setup: could not find function teardownStack(stack) in src/web/server.js');
// eslint-disable-next-line no-new-func
const teardownStack = new Function(`return (${TEARDOWN_SRC});`)();
assert.strictEqual(typeof teardownStack, 'function', 'setup: the extracted source must evaluate to a function');

const LIVE_STATE = () => ({ ok: true, status: 'open', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 1_200_000, closesAtMs: Date.now() + 1_200_000, revisionLimit: 30, revisionsLeft: 30,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 40, triggerWindowMs: null });

function mkStack() {
  const counts = { reads: 0 };
  const events = [];
  const parked = [];
  const intentsFile = tmp();
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: () => {
      counts.reads += 1;
      return new Promise((resolve) => parked.push(resolve));
    },
    placeBid: async () => ({ ok: true, accepted: true, myRank: 1 }),
  };
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), {
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
  const stack = { engine, discovery: null, adapter: null,
    account: { accountId: 'acct-test', label: 'Test Account' },
    tokenExpiryTimer: null, scopeRefresher: null };
  return { stack, engine, counts, events, parked, intentsFile };
}

const preStart = (id) => ({
  id: String(id), lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
  units: 1, companyName: 'ACME', branchName: 'Bhiwandi',
  startsAt: Date.now() + 600_000, closesAt: Date.now() + 1_800_000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

// Fires the load's pre-start wake and leaves it parked on its platform read.
async function parkWake(engine, parked, id) {
  engine.schedule(preStart(id), INPUTS);
  await drain(2);
  const h = engine.scheduledTimers.get(String(id));
  assert.ok(h && ledger.has(h), 'setup: the pre-start load must hold a wake timer');
  fire(h);
  await drain(2);
  assert.strictEqual(parked.length, 1, 'setup: the wake must be parked on its platform read');
  assert.strictEqual(engine.scheduledTimers.has(String(id)), false,
    'setup: a parked wake has already removed its own scheduledTimers entry');
  assert.strictEqual(engine.monitors.size, 0, 'setup: nothing is armed while the read is parked');
}

(async () => {
  {
    const ID = 25_475_940;
    const { stack, engine, counts, events, parked, intentsFile } = mkStack();
    await parkWake(engine, parked, ID);

    events.length = 0;
    teardownStack(stack);
    await drain(2);
    // The replacement stack owns this file from here on and has already written its own state to it.
    const replacement = new DurableScheduler(intentsFile);
    replacement.update(String(ID), { status: 'armed' });
    replacement.upsert({ auctionId: '25490001', status: 'scheduled', lane: { origin: 'PUNE', destination: 'SURAT' } });
    const fileAfterReplacement = fs.readFileSync(intentsFile, 'utf8');
    const readsAtDiscard = counts.reads;

    parked[0](LIVE_STATE());
    await drain();

    // ---- 1. no monitor, no tick timer, no further read on the discarded engine
    assert.strictEqual(engine.monitors.size, 0,
      `the wake parked on its read when teardownStack ran went on to arm ${engine.monitors.size} monitor(s) `
      + `(${[...engine.monitors.keys()].join(', ')}) on the DISCARDED engine - wake() deleted its own `
      + 'scheduledTimers entry before the await, so no stop() could reach it, and the post-await guards '
      + '(killed, monitors.has, intent still scheduled) all pass on an engine nobody holds');
    assert.strictEqual(implHandles().length, 0,
      `the discarded engine planted ${implHandles().length} timer(s) after the read resolved `
      + `(${implSites().join(', ')}) - a tick chain on a stack nobody holds`);
    fireImpl();
    await drain();
    assert.strictEqual(counts.reads - readsAtDiscard, 0,
      `${counts.reads - readsAtDiscard} platform read(s) reached the DISCARDED adapter after the parked read resolved`);
    ok('an in-flight wake resolved after teardown arms nothing, plants no tick, reads nothing more');

    // ---- 2. the shared intents file is left to the replacement stack
    const fileNow = fs.readFileSync(intentsFile, 'utf8');
    const survived = fileNow.includes('25490001');
    assert.strictEqual(fileNow, fileAfterReplacement,
      'the DISCARDED engine\'s DurableScheduler wrote the shared intents file after teardownStack - its '
      + `stale in-memory map replaced the replacement stack's state (the replacement's own intent ${survived
        ? 'survived, but the file changed under it' : '25490001 is GONE from disk'})`);
    ok('the discarded engine never writes the intents file the replacement stack owns');

    // ---- 3. no alert
    const errs = events.filter((e) => e && e.type === 'alert' && e.level === 'error');
    assert.deepStrictEqual(errs.map((e) => e.kind), [],
      `teardown and the resolved wake must raise no error-level alert; raised ${errs.map((e) => e.kind).join(', ')}`);
    assert.ok(!events.some((e) => e && e.kind === 'killed'), 'and specifically not kind \'killed\'');
    ok('discarding the stack raises no error-level alert (no killed)');

    ledger.clear();
  }

  // ---- 4. CONTROL: the same flow without teardown reaches arm()
  {
    const ID = 25_475_941;
    const { engine, parked } = mkStack();
    await parkWake(engine, parked, ID);

    parked[0](LIVE_STATE());
    await drain();

    assert.strictEqual(engine.monitors.size, 1,
      `CONTROL: without a teardown the resolved wake must arm exactly one monitor, got ${engine.monitors.size} - `
      + 'the harness does not reach arm(), so checks 1-3 would pass vacuously');
    assert.ok(engine.monitors.has(String(ID)), 'CONTROL: and it is the scheduled load');
    ledger.clear();
    ok('CONTROL - without teardown the parked wake arms exactly one monitor');
  }

  cleanup();
  ledger.clear();
  restoreTimers();
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  ledger.clear();
  restoreTimers();
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
